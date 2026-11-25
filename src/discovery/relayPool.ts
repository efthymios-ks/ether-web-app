import { createEmitter } from '../core/events.js';
import type { Emitter, Unsubscribe } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { hasValidId, hasValidSignature, parseNostrEvent } from './nostrEvent.js';
import type { EventLimits, NostrEvent } from './nostrEvent.js';
import { createRateLimiter } from './rateLimiter.js';
import type { RateLimiter } from './rateLimiter.js';
import { createRelayConnection } from './relayConnection.js';
import type { RelayClock, RelayConnection, RelayFilter, RelaySocketFactory } from './relayConnection.js';
import relayList from './relays.json';

// Every relay in the pool gets every event and the same subscription; the first copy of an event wins.
// Relays are not trusted: each event's id and BIP-340 signature are checked here, whichever relay sent it.

// relays.json is the one list: scripts/build.mjs reads it too, for the page's connect-src.
// Ether's own relays come first, the public ones after them are backups; within each, first is preferred.
export const OWN_RELAY_URLS: readonly string[] = Object.freeze(relayList.own.filter(isRelayUrl));
export const PUBLIC_RELAY_URLS: readonly string[] = Object.freeze(relayList.public.filter(isRelayUrl));
export const RELAY_URLS: readonly string[] = Object.freeze([...OWN_RELAY_URLS, ...PUBLIC_RELAY_URLS]);

export interface RelaySubscription {
    readonly filter: () => RelayFilter;
    // The same test on this side: a relay may send anything.
    readonly matches: (event: NostrEvent) => boolean;
}

export interface RelayPoolEvents {
    event(event: NostrEvent): void;
    // A relay connected, disconnected or started retrying.
    change(): void;
    'relay-opened'(url: string): void;
    // The relay's socket failed to open or was closed by the relay or the network.
    'relay-failed'(url: string): void;
}

export interface RelayPoolOptions {
    readonly urls: readonly string[];
    readonly createSocket: RelaySocketFactory;
    readonly clock: RelayClock;
    readonly logger: Logger;
}

export interface RelayPool {
    readonly openCount: number;
    // Every relay failed at least once and none is open.
    readonly isUnreachable: boolean;
    on<Name extends keyof RelayPoolEvents>(name: Name, handler: RelayPoolEvents[Name]): Unsubscribe;
    start(): void;
    stop(): void;
    setSubscription(subscription: RelaySubscription | undefined): void;
    // True once a relay accepted the event (OK true), or it went out and no relay refused it in time.
    publishAsync(event: NostrEvent): Promise<boolean>;
    // Sends where a socket is open, without waiting; for the goodbye just before the sockets close.
    publishNow(event: NostrEvent): void;
    reconnectNow(): void;
    disconnectAll(): void;
    isOpen(url: string): boolean;
    pause(url: string): void;
    resume(url: string): void;
}

export const EVENT_LIMITS: EventLimits = Object.freeze({
    maxContentLength: 16 * 1024,
    maxTags: 8,
    maxTagValues: 4,
    maxTagValueLength: 128,
});
const MAX_OUTGOING_CHARS = 16 * 1024;
const PUBLISH_TIMEOUT_MS = 5000;
const MAX_SEEN_IDS = 4096;
// Signature checks cost a few milliseconds each, so a flood of fresh keys gets a budget too.
const AUTHOR_BURST = 20;
const AUTHOR_REFILL_MS = 2000;
const MAX_TRACKED_AUTHORS = 256;
const VERIFY_BURST = 60;
const VERIFY_REFILL_MS = 100;
const DROP_LOG_MS = 30_000;

interface PendingPublish {
    readonly targets: Set<string>;
    readonly wasSent: boolean;
    readonly timer: unknown;
    readonly resolve: (isDelivered: boolean) => void;
}

export function createRelayPool(options: RelayPoolOptions): RelayPool {
    return new NostrRelayPool(options);
}

class NostrRelayPool implements RelayPool {
    private readonly options: RelayPoolOptions;
    private readonly logger: Logger;
    private readonly emitter: Emitter<RelayPoolEvents>;
    private readonly seenIds = new Map<string, number>();
    private readonly pending = new Map<string, PendingPublish>();
    private readonly authorLimiter: RateLimiter;
    private readonly verifyLimiter: RateLimiter;
    private connections: RelayConnection[] = [];
    private subscription?: RelaySubscription;
    private dropCounts = new Map<string, number>();

    constructor(options: RelayPoolOptions) {
        this.options = options;
        this.logger = options.logger;
        this.emitter = createEmitter<RelayPoolEvents>((error, name) => {
            this.logger.error('nearby', `a relay pool ${String(name)} listener threw`, { error });
        });
        const now = (): number => options.clock.now();
        this.authorLimiter = createRateLimiter({
            burst: AUTHOR_BURST,
            refillMs: AUTHOR_REFILL_MS,
            maxKeys: MAX_TRACKED_AUTHORS,
            now,
        });
        this.verifyLimiter = createRateLimiter({ burst: VERIFY_BURST, refillMs: VERIFY_REFILL_MS, maxKeys: 1, now });
    }

    get openCount(): number {
        return this.connections.filter(connection => connection.state === 'open').length;
    }

    get isUnreachable(): boolean {
        return this.connections.length > 0
            && this.connections.every(connection => connection.state !== 'open' && connection.hasFailed);
    }

    on<Name extends keyof RelayPoolEvents>(name: Name, handler: RelayPoolEvents[Name]): Unsubscribe {
        return this.emitter.on(name, handler);
    }

    start(): void {
        if (this.connections.length > 0) {
            return;
        }

        this.connections = this.options.urls.map(url => createRelayConnection({
            url,
            createSocket: this.options.createSocket,
            clock: this.options.clock,
            logger: this.logger,
            onEvent: event => this.receive(event),
            onPublishResult: (eventId, isAccepted) => this.onPublishResult(url, eventId, isAccepted),
            onStateChange: () => this.emitter.emit('change'),
            onOpened: () => this.emitter.emit('relay-opened', url),
            onFailed: () => this.emitter.emit('relay-failed', url),
        }));
        for (const connection of this.connections) {
            connection.setFilter(this.subscription?.filter);
            connection.connect();
        }
    }

    stop(): void {
        const connections = this.connections;
        this.connections = [];
        for (const connection of connections) {
            connection.stop();
        }

        for (const [eventId, publish] of this.pending) {
            this.finishPublish(eventId, publish, false);
        }

        this.seenIds.clear();
        this.authorLimiter.clear();
        if (connections.length > 0) {
            this.emitter.emit('change');
        }
    }

    setSubscription(subscription: RelaySubscription | undefined): void {
        this.subscription = subscription;
        for (const connection of this.connections) {
            connection.setFilter(subscription?.filter);
        }
    }

    async publishAsync(event: NostrEvent): Promise<boolean> {
        const json = this.serialize(event);
        if (json == null) {
            return false;
        }

        const expiresAt = this.options.clock.now() + PUBLISH_TIMEOUT_MS;
        const wasSent = this.connections.some(connection => connection.state === 'open');
        const targets = new Set(this.connections
            .filter(connection => connection.publish(json, expiresAt))
            .map(connection => connection.url));
        if (targets.size === 0) {
            return false;
        }

        return new Promise(resolve => {
            const timer = this.options.clock.setTimeout(() => {
                const publish = this.pending.get(event.id);
                if (publish != null) {
                    this.finishPublish(event.id, publish, publish.wasSent);
                }
            }, PUBLISH_TIMEOUT_MS);
            this.pending.set(event.id, { targets, wasSent, timer, resolve });
        });
    }

    publishNow(event: NostrEvent): void {
        const json = this.serialize(event);
        if (json == null) {
            return;
        }

        for (const connection of this.connections) {
            if (connection.state === 'open') {
                connection.publish(json, 0);
            }
        }
    }

    reconnectNow(): void {
        for (const connection of this.connections) {
            connection.reconnectNow();
        }
    }

    disconnectAll(): void {
        for (const connection of this.connections) {
            connection.disconnect();
        }
    }

    isOpen(url: string): boolean {
        return this.find(url)?.state === 'open';
    }

    pause(url: string): void {
        this.find(url)?.pause();
    }

    resume(url: string): void {
        this.find(url)?.resume();
    }

    private find(url: string): RelayConnection | undefined {
        return this.connections.find(connection => connection.url === url);
    }

    // Marks the event as seen, so the relays' copies of it come back as duplicates.
    private serialize(event: NostrEvent): string | undefined {
        const json = JSON.stringify(event);
        if (json.length > MAX_OUTGOING_CHARS) {
            this.logger.warn('nearby', `not sent: a ${json.length}-character event is over the limit`);

            return undefined;
        }

        this.markSeen(event.id);

        return json;
    }

    private onPublishResult(url: string, eventId: string, isAccepted: boolean): void {
        const publish = this.pending.get(eventId);
        if (publish == null) {
            return;
        }

        if (isAccepted) {
            this.finishPublish(eventId, publish, true);
            return;
        }

        publish.targets.delete(url);
        if (publish.targets.size === 0) {
            this.finishPublish(eventId, publish, false);
        }
    }

    private finishPublish(eventId: string, publish: PendingPublish, isDelivered: boolean): void {
        this.pending.delete(eventId);
        this.options.clock.clearTimeout(publish.timer);
        publish.resolve(isDelivered);
    }

    // Cheap checks first; the signature, the costly one, only for a new, well-formed event from a quiet author.
    private receive(value: unknown): void {
        const event = parseNostrEvent(value, EVENT_LIMITS);
        if (event == null) {
            this.drop('malformed');
            return;
        }

        if (this.seenIds.has(event.id)) {
            return;
        }

        if (this.subscription?.matches(event) !== true) {
            this.drop('not for this room');
            return;
        }

        if (!hasValidId(event)) {
            this.drop('wrong id');
            return;
        }

        if (!this.authorLimiter.take(event.pubkey)) {
            this.drop('flood from one key');
            return;
        }

        if (!this.verifyLimiter.take('all')) {
            this.drop('too many to check');
            return;
        }

        if (!hasValidSignature(event)) {
            this.drop('bad signature');
            return;
        }

        this.markSeen(event.id);
        this.emitter.emit('event', event);
    }

    private markSeen(eventId: string): void {
        this.seenIds.delete(eventId);
        this.seenIds.set(eventId, this.options.clock.now());
        while (this.seenIds.size > MAX_SEEN_IDS) {
            const oldest = this.seenIds.keys().next().value;
            if (oldest == null) {
                break;
            }

            this.seenIds.delete(oldest);
        }
    }

    private drop(reason: string): void {
        this.dropCounts.set(reason, (this.dropCounts.get(reason) ?? 0) + 1);
        if (!this.logger.every('nearby.pool.drop', DROP_LOG_MS)) {
            return;
        }

        const counts = Object.fromEntries(this.dropCounts);
        this.dropCounts = new Map();
        this.logger.warn('nearby', `dropped relay events: ${Object.keys(counts).join(', ')}`, { counts });
    }
}

function isRelayUrl(url: string): boolean {
    return url.startsWith('wss://');
}
