import type { Logger } from '../core/logger.js';

// One Nostr relay over a WebSocket (NIP-01): one subscription, publishing, and reconnecting with backoff.
// It uses only EVENT, REQ and CLOSE, and reads OK, EVENT, EOSE, NOTICE and CLOSED; AUTH is ignored.
// Only live events count: many public relays keep ephemeral events for a while anyway and replay them to a
// new subscription, so whatever arrives before EOSE (stored history) is dropped.

export interface RelaySocket {
    send(text: string): void;
    close(): void;
}

export interface RelaySocketHandlers {
    onOpen(): void;
    onMessage(data: unknown): void;
    // Called once, whether the socket failed to open or closed later.
    onClose(): void;
}

// The browser WebSocket behind a small interface, so tests can put a fake relay there.
export type RelaySocketFactory = (url: string, handlers: RelaySocketHandlers) => RelaySocket;

export interface RelayClock {
    now(): number;
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    random(): number;
}

export type RelayFilter = Readonly<Record<string, unknown>>;

// idle: not connected yet. connecting: opening the socket. open: ready, subscribed when a filter is set.
// waiting: closed or failed, retrying after a delay. stopped: closed for good.
export type RelayState = 'idle' | 'connecting' | 'open' | 'waiting' | 'stopped';

export interface RelayConnectionOptions {
    readonly url: string;
    readonly createSocket: RelaySocketFactory;
    readonly clock: RelayClock;
    readonly logger: Logger;
    // An event that arrived for the subscription, not yet checked.
    readonly onEvent: (event: unknown) => void;
    readonly onPublishResult: (eventId: string, isAccepted: boolean) => void;
    readonly onStateChange: () => void;
    // The socket opened.
    readonly onOpened?: () => void;
    // The socket failed to open, or the relay or the network closed it; not when this side closed it.
    readonly onFailed?: () => void;
}

export interface RelayConnection {
    readonly url: string;
    readonly state: RelayState;
    // True once a connection attempt failed or an open socket closed, until the next open.
    readonly hasFailed: boolean;
    connect(): void;
    // The filter is called again on every (re)subscribe, so `since` stays recent.
    setFilter(filter: (() => RelayFilter) | undefined): void;
    // Sends the signed event's JSON now, or once open if that happens before `expiresAt` (clock time).
    // False when it was dropped.
    publish(eventJson: string, expiresAt: number): boolean;
    // Skips the remaining backoff, e.g. when the browser comes back online; a paused relay stays paused.
    reconnectNow(): void;
    // Stops trying until resume(), e.g. while the relay is out of its daily allowance.
    pause(): void;
    resume(): void;
    // Closes the socket and retries later, e.g. when the browser goes offline.
    disconnect(): void;
    stop(): void;
}

// Bigger frames are dropped unread; nearby events are a few kilobytes.
export const MAX_INCOMING_FRAME_CHARS = 64 * 1024;
const OPEN_TIMEOUT_MS = 10_000;
// A socket that has heard nothing, not even an OK for its own presence, for this long is dead.
const SILENCE_LIMIT_MS = 100_000;
const SILENCE_CHECK_MS = 20_000;
// An open that lasts this long counts as healthy and resets the backoff.
const STABLE_OPEN_MS = 30_000;
const BACKOFF_STEPS_MS = Object.freeze([1000, 3000, 10_000, 30_000, 60_000]);
// A refused subscription (auth or payment required) is retried slowly.
const REFUSED_RETRY_MS = 5 * 60_000;
const BACKOFF_JITTER = 0.25;
const MAX_QUEUED = 16;
// A relay that never sends EOSE is taken as live after this.
const EOSE_WAIT_MS = 5000;
const MAX_NOTICE_CHARS = 200;
const LOG_SAMPLE_MS = 30_000;

interface QueuedEvent {
    readonly json: string;
    readonly expiresAt: number;
}

export function createRelayConnection(options: RelayConnectionOptions): RelayConnection {
    return new NostrRelayConnection(options);
}

class NostrRelayConnection implements RelayConnection {
    readonly url: string;
    private readonly options: RelayConnectionOptions;
    private readonly logger: Logger;
    private connectionState: RelayState = 'idle';
    private isFailed = false;
    private isPaused = false;
    private socket?: RelaySocket;
    private socketGeneration = 0;
    private filter?: () => RelayFilter;
    private subscriptionId?: string;
    private subscriptionCount = 0;
    private queue: QueuedEvent[] = [];
    private failures = 0;
    private openedAt = 0;
    private lastHeardAt = 0;
    private isLive = false;
    private storedCount = 0;
    private retryTimer?: unknown;
    private openTimer?: unknown;
    private silenceTimer?: unknown;
    private eoseTimer?: unknown;

    constructor(options: RelayConnectionOptions) {
        this.options = options;
        this.url = options.url;
        this.logger = options.logger;
    }

    get state(): RelayState {
        return this.connectionState;
    }

    get hasFailed(): boolean {
        return this.isFailed;
    }

    connect(): void {
        const isBusy = this.connectionState === 'connecting' || this.connectionState === 'open';
        if (isBusy || this.connectionState === 'stopped') {
            return;
        }

        this.cancelTimer('retryTimer');
        this.openSocket();
    }

    setFilter(filter: (() => RelayFilter) | undefined): void {
        if (this.connectionState === 'open') {
            this.closeSubscription();
        }

        this.filter = filter;
        if (this.connectionState === 'open') {
            this.subscribe();
        }
    }

    publish(eventJson: string, expiresAt: number): boolean {
        if (this.connectionState === 'stopped') {
            return false;
        }

        if (this.connectionState === 'open') {
            return this.sendText(toEventFrame(eventJson));
        }

        this.queue = [...this.queue, { json: eventJson, expiresAt }].slice(-MAX_QUEUED);

        return true;
    }

    reconnectNow(): void {
        this.failures = 0;
        if (this.connectionState === 'waiting' && !this.isPaused) {
            this.connect();
        }
    }

    pause(): void {
        if (this.connectionState === 'stopped' || this.isPaused) {
            return;
        }

        this.isPaused = true;
        this.logger.info('nearby', `relay ${this.url} paused`);
        this.dropSocket();
        this.cancelTimer('retryTimer');
        this.isFailed = true;
        this.setState('waiting');
    }

    resume(): void {
        if (!this.isPaused) {
            return;
        }

        this.isPaused = false;
        this.logger.info('nearby', `relay ${this.url} resumed`);
        this.reconnectNow();
    }

    disconnect(): void {
        if (this.connectionState !== 'open' && this.connectionState !== 'connecting') {
            return;
        }

        this.logger.info('nearby', `relay ${this.url} disconnected while offline`);
        this.dropSocket();
        this.scheduleRetry();
    }

    stop(): void {
        if (this.connectionState === 'stopped') {
            return;
        }

        this.dropSocket();
        this.cancelTimer('retryTimer');
        this.queue = [];
        this.setState('stopped');
    }

    private openSocket(): void {
        const generation = ++this.socketGeneration;
        const isCurrent = (): boolean => generation === this.socketGeneration;
        this.setState('connecting');
        this.openTimer = this.options.clock.setTimeout(() => {
            if (isCurrent()) {
                this.onSocketFailed(`no answer within ${OPEN_TIMEOUT_MS / 1000} s`);
            }
        }, OPEN_TIMEOUT_MS);
        try {
            this.socket = this.options.createSocket(this.url, {
                onOpen: () => {
                    if (isCurrent()) {
                        this.onSocketOpen();
                    }
                },
                onMessage: data => {
                    if (isCurrent()) {
                        this.onSocketMessage(data);
                    }
                },
                onClose: () => {
                    if (isCurrent()) {
                        this.onSocketFailed(this.connectionState === 'open' ? 'closed' : 'could not connect');
                    }
                },
            });
        } catch (error) {
            this.logger.warn('nearby', `relay ${this.url} refused by the browser`, { error });
            this.onSocketFailed('refused by the browser');
        }
    }

    private onSocketOpen(): void {
        this.cancelTimer('openTimer');
        const now = this.options.clock.now();
        this.openedAt = now;
        this.lastHeardAt = now;
        this.isFailed = false;
        this.logger.info('nearby', `relay ${this.url} connected`);
        this.setState('open');
        this.subscribe();
        this.flushQueue();
        this.watchSilence();
        this.options.onOpened?.();
    }

    private onSocketFailed(reason: string): void {
        const wasOpen = this.connectionState === 'open';
        const level = wasOpen ? 'info' : 'warn';
        if (wasOpen || this.logger.every(`nearby.relay.${this.url}.fail`, LOG_SAMPLE_MS)) {
            this.logger[level]('nearby', `relay ${this.url} ${reason}`, { failures: this.failures + 1 });
        }

        if (wasOpen && this.options.clock.now() - this.openedAt >= STABLE_OPEN_MS) {
            this.failures = 0;
        }

        this.dropSocket();
        this.scheduleRetry();
        this.options.onFailed?.();
    }

    private dropSocket(): void {
        this.socketGeneration++;
        this.cancelTimer('openTimer');
        this.cancelTimer('silenceTimer');
        this.cancelTimer('eoseTimer');
        this.subscriptionId = undefined;
        const socket = this.socket;
        this.socket = undefined;
        if (socket != null) {
            try {
                socket.close();
            } catch {
                // A socket that is already closing may throw; it is gone either way.
            }
        }
    }

    private scheduleRetry(delayMs = this.nextBackoffMs()): void {
        this.isFailed = true;
        this.failures++;
        this.setState('waiting');
        this.cancelTimer('retryTimer');
        this.retryTimer = this.options.clock.setTimeout(() => this.connect(), delayMs);
    }

    private nextBackoffMs(): number {
        const step = BACKOFF_STEPS_MS[Math.min(this.failures, BACKOFF_STEPS_MS.length - 1)] ?? 60_000;
        const jitter = 1 + (this.options.clock.random() * 2 - 1) * BACKOFF_JITTER;

        return Math.round(step * jitter);
    }

    private onSocketMessage(data: unknown): void {
        if (typeof data !== 'string' || data.length > MAX_INCOMING_FRAME_CHARS) {
            this.logDrop('a frame that is not text or is too large');
            return;
        }

        this.lastHeardAt = this.options.clock.now();
        const message = parseFrame(data);
        if (message == null) {
            this.logDrop('a frame that is not a JSON array');
            return;
        }

        const [type, first, second, third] = message;
        if (type === 'EVENT' && first === this.subscriptionId && first != null) {
            this.onSubscriptionEvent(second);
            return;
        }

        if (type === 'OK' && typeof first === 'string') {
            this.onPublishResult(first, second === true, third);
            return;
        }

        if (type === 'CLOSED' && first === this.subscriptionId && first != null) {
            this.onSubscriptionClosed(second);
            return;
        }

        if (type === 'EOSE' && first === this.subscriptionId && first != null) {
            this.goLive();
            return;
        }

        if (type === 'NOTICE' && this.logger.every(`nearby.relay.${this.url}.notice`, LOG_SAMPLE_MS)) {
            this.logger.info('nearby', `relay ${this.url} notice: ${shorten(first)}`);
        }
    }

    private onSubscriptionEvent(event: unknown): void {
        if (this.isLive) {
            this.options.onEvent(event);
            return;
        }

        this.storedCount++;
    }

    private goLive(): void {
        this.cancelTimer('eoseTimer');
        if (this.isLive) {
            return;
        }

        this.isLive = true;
        const skipped = this.storedCount === 0 ? '' : `; skipped ${this.storedCount} stored event(s)`;
        this.logger.debug('nearby', `relay ${this.url} subscribed${skipped}`);
    }

    private onPublishResult(eventId: string, isAccepted: boolean, message: unknown): void {
        if (!isAccepted && this.logger.every(`nearby.relay.${this.url}.refused`, LOG_SAMPLE_MS)) {
            this.logger.warn('nearby', `relay ${this.url} refused an event: ${shorten(message)}`);
        }

        this.options.onPublishResult(eventId, isAccepted);
    }

    // The relay ended the subscription, e.g. it wants auth or payment: this relay is no use for now.
    private onSubscriptionClosed(message: unknown): void {
        this.logger.warn('nearby', `relay ${this.url} closed the subscription: ${shorten(message)}`);
        this.dropSocket();
        this.scheduleRetry(REFUSED_RETRY_MS);
    }

    private subscribe(): void {
        const filter = this.filter;
        if (filter == null || this.connectionState !== 'open') {
            return;
        }

        this.subscriptionCount++;
        this.subscriptionId = `nearby-${this.subscriptionCount}`;
        this.isLive = false;
        this.storedCount = 0;
        this.cancelTimer('eoseTimer');
        this.eoseTimer = this.options.clock.setTimeout(() => this.goLive(), EOSE_WAIT_MS);
        this.sendText(JSON.stringify(['REQ', this.subscriptionId, filter()]));
    }

    private closeSubscription(): void {
        if (this.subscriptionId == null) {
            return;
        }

        this.sendText(JSON.stringify(['CLOSE', this.subscriptionId]));
        this.subscriptionId = undefined;
        this.cancelTimer('eoseTimer');
    }

    private flushQueue(): void {
        const now = this.options.clock.now();
        const queued = this.queue;
        this.queue = [];
        for (const item of queued) {
            if (item.expiresAt > now) {
                this.sendText(toEventFrame(item.json));
            }
        }
    }

    // Some networks leave a dead socket looking open for minutes; a long silence means reconnect.
    private watchSilence(): void {
        this.silenceTimer = this.options.clock.setTimeout(() => {
            if (this.connectionState !== 'open') {
                return;
            }

            const silentMs = this.options.clock.now() - this.lastHeardAt;
            if (silentMs >= SILENCE_LIMIT_MS) {
                this.onSocketFailed(`silent for ${Math.round(silentMs / 1000)} s`);
                return;
            }

            this.watchSilence();
        }, SILENCE_CHECK_MS);
    }

    private sendText(text: string): boolean {
        const socket = this.socket;
        if (socket == null) {
            return false;
        }

        try {
            socket.send(text);

            return true;
        } catch (error) {
            this.logger.warn('nearby', `relay ${this.url} send failed`, { error });

            return false;
        }
    }

    private logDrop(reason: string): void {
        if (this.logger.every(`nearby.relay.${this.url}.drop`, LOG_SAMPLE_MS)) {
            this.logger.warn('nearby', `relay ${this.url} sent ${reason}; dropped`);
        }
    }

    private setState(state: RelayState): void {
        if (this.connectionState === state) {
            return;
        }

        this.connectionState = state;
        this.options.onStateChange();
    }

    private cancelTimer(name: 'retryTimer' | 'openTimer' | 'silenceTimer' | 'eoseTimer'): void {
        const handle = this[name];
        if (handle != null) {
            this.options.clock.clearTimeout(handle);
            this[name] = undefined;
        }
    }
}

// The event is already JSON, so it goes out exactly as it was signed.
function toEventFrame(eventJson: string): string {
    return `["EVENT",${eventJson}]`;
}

function parseFrame(text: string): unknown[] | undefined {
    try {
        const value: unknown = JSON.parse(text);

        return Array.isArray(value) && typeof value[0] === 'string' ? value : undefined;
    } catch {
        return undefined;
    }
}

function shorten(value: unknown): string {
    return typeof value === 'string' ? value.slice(0, MAX_NOTICE_CHARS) : '';
}
