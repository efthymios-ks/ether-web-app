import { createEmitter } from '../core/events.js';
import type { Emitter, Unsubscribe } from '../core/events.js';
import { toDevicePlatform } from '../core/deviceInfo.js';
import type { Logger } from '../core/logger.js';
import { isValidPin } from '../core/pin.js';
import { DiscoveryError } from './discoveryError.js';
import type {
    Discovery,
    DiscoveryEvents,
    DiscoveryStatus,
    NearbyDevice,
    OwnNearbyIdentity,
    PairRequest,
    PairRequestOptions,
    PairRequestOutcome,
    RelayAllowanceNotice,
} from './discoveryTypes.js';
import { bytesToBase64Url } from './encoding.js';
import {
    createExchangeKeysAsync,
    deriveDirectKeyAsync,
    deriveRoomAsync,
    openSealedAsync,
    sealAsync,
} from './nearbyCrypto.js';
import type { ExchangeKeys, RoomSecrets } from './nearbyCrypto.js';
import {
    isValidCode,
    parseDirectMessage,
    parseRoomMessage,
    sanitizeName,
    serializeDirectMessage,
    serializeRoomMessage,
    toDeviceType,
} from './nearbyMessages.js';
import type { DeclineReason, DirectMessage, RoomMessage } from './nearbyMessages.js';
import {
    createPinGuard,
    createPinProof,
    isPinProofValid,
    PIN_ATTEMPTS_IN_TOTAL,
    PIN_ATTEMPTS_PER_ASKER,
    PIN_LOCKOUT_MS,
} from './nearbyPin.js';
import type { PinGuard } from './nearbyPin.js';
import { createNostrSigner, readTag } from './nostrEvent.js';
import type { NostrEvent, NostrSigner } from './nostrEvent.js';
import { createRateLimiter } from './rateLimiter.js';
import type { RateLimiter } from './rateLimiter.js';
import { createRelayAllowanceMonitor } from './relayAllowance.js';
import type { RelayAllowanceMonitor } from './relayAllowance.js';
import type { RelaySocketFactory } from './relayConnection.js';
import { createRelayPool, OWN_RELAY_URLS, RELAY_URLS } from './relayPool.js';
import type { RelayPool } from './relayPool.js';
import { findPublicAddressAsync, STUN_SERVERS } from './stunPool.js';
import { createTabIdentity, loadTabIdentity, saveTabIdentity } from './tabIdentity.js';
import type { SessionStore } from './tabIdentity.js';

// Nearby devices (see docs/Nearby.md): learn the public IPv4 address, meet in the room it names on Nostr
// relays, say "I'm here" every ~30 s, and swap pairing codes with one device only when it accepts, or when the
// request proves it knows that device's PIN (nearbyPin.ts).

// Ephemeral (20000–29999), so relays pass the events on without storing them.
export const NEARBY_EVENT_KIND = 25050;
// The single-letter tag that carries the room tag, for the relays' `#x` filter.
export const ROOM_TAG_NAME = 'x';

export interface DiscoveryEnvironment {
    // For the STUN lookup only.
    createPeerConnection(configuration: RTCConfiguration): RTCPeerConnection;
    createSocket: RelaySocketFactory;
    // For the status check of Ether's own relays.
    fetchAsync(url: string, init: RequestInit): Promise<Response>;
    // Monotonic milliseconds.
    now(): number;
    // Epoch milliseconds.
    wallClock(): number;
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    // In [0, 1), for jitter.
    random(): number;
    randomBytes(length: number): Uint8Array;
    // The browser's online and offline events.
    onConnectivityChange(handler: (isOnline: boolean) => void): Unsubscribe;
    onPageHide(handler: () => void): Unsubscribe;
    // The page came back from the back-forward cache.
    onPageShow(handler: () => void): Unsubscribe;
    // A hidden page leaves the room and joins again once visible: a page in the background can't answer,
    // and hiding comes before unloading, so a reload or a closed tab still gets its goodbye out.
    onVisibilityChange(handler: (isHidden: boolean) => void): Unsubscribe;
    isHidden(): boolean;
    // sessionStorage, for the tab's identity (tabIdentity.ts).
    readonly sessionStore: SessionStore;
}

export interface DiscoveryTimings {
    readonly presenceMs: number;
    // Each presence comes presenceMs ± this, so devices that started together drift apart.
    readonly presenceJitterMs: number;
    readonly deviceTimeoutMs: number;
    readonly sweepMs: number;
    // How long the asked device shows the request.
    readonly requestTimeoutMs: number;
    // How much longer the asker waits, for an answer made at the last moment (gathering takes up to 3 s).
    readonly answerGraceMs: number;
    readonly stunTimeoutMs: number;
    readonly addressRecheckMs: number;
    // Waits between lookups while no STUN server answers; the last one repeats.
    readonly lookupRetryMs: readonly number[];
    // A newcomer is greeted after a random wait in this range, so a room doesn't answer all at once.
    readonly greetingDelayMs: readonly [number, number];
    // A new device takes the row of one with the same name and type that has been quiet this long:
    // a presence interval and its jitter, plus a margin.
    readonly replaceQuietAfterMs: number;
}

export const DEFAULT_DISCOVERY_TIMINGS: DiscoveryTimings = Object.freeze({
    presenceMs: 30_000,
    presenceJitterMs: 5000,
    deviceTimeoutMs: 75_000,
    sweepMs: 5000,
    requestTimeoutMs: 60_000,
    answerGraceMs: 10_000,
    stunTimeoutMs: 5000,
    addressRecheckMs: 5 * 60_000,
    lookupRetryMs: Object.freeze([5000, 15_000, 30_000, 60_000]),
    greetingDelayMs: Object.freeze([500, 2500]) as readonly [number, number],
    replaceQuietAfterMs: 40_000,
});

export interface DiscoveryOptions {
    readonly logger: Logger;
    readonly environment: DiscoveryEnvironment;
    readonly relayUrls?: readonly string[];
    // Which of relayUrls are Ether's own, watched for their free allowance.
    readonly ownRelayUrls?: readonly string[];
    readonly stunServers?: readonly string[];
    readonly timings?: Partial<DiscoveryTimings>;
}

// The room ignores events this far from its own clock: older ones are replays.
const MAX_CLOCK_SKEW_S = 10 * 60;
// The subscription asks for events from this far back, so a device whose clock runs slow is still heard;
// stored history that a relay replays is dropped before EOSE (relayConnection.ts).
const SINCE_WINDOW_S = MAX_CLOCK_SKEW_S;
const MAX_DEVICES = 32;
const MAX_INCOMING_REQUESTS = 8;
const MAX_REQUESTS_PER_SENDER = 2;
const MAX_PINS = 256;
const MAX_DIRECT_KEYS = 64;
// Withdrawn requests are remembered, so a request that a relay delivers after its cancel stays withdrawn.
const MAX_WITHDRAWN_IDS = 64;
// Goodbyes remembered per device, and this page's own runs, to tell late messages from new ones.
const MAX_RUNS = 16;
// A STUN answer this recent shows the internet works, when no other relay is connected to show it.
const INTERNET_EVIDENCE_MS = 5 * 60_000;
const SENDER_BURST = 10;
const SENDER_REFILL_MS = 3000;
const DROP_LOG_MS = 30_000;
const ID_BYTES = 16;

interface KnownDevice {
    readonly nearbyId: string;
    readonly run: string;
    readonly name: string;
    readonly deviceType: NearbyDevice['deviceType'];
    readonly platform: NearbyDevice['platform'];
    readonly hasPin: boolean;
    readonly exchangeKey: string;
    readonly lastSeenAt: number;
    readonly heardAt: number;
}

interface Peer {
    readonly nearbyId: string;
    readonly run: string;
    readonly exchangeKey: string;
}

interface IncomingRequest {
    readonly request: PairRequest;
    readonly sender: Peer;
    readonly timer: unknown;
}

interface OutgoingRequest {
    readonly requestId: string;
    readonly target: Peer;
    readonly timer: unknown;
    readonly resolve: (outcome: PairRequestOutcome) => void;
    readonly stopListening: () => void;
}

type Room = RoomSecrets;

// Sealed when the room is joined, so a goodbye can go out at once, even while the page hides.
interface SealedBye {
    readonly room: Room;
    readonly content: string;
}

export function createDiscovery(options: DiscoveryOptions): Discovery {
    return new NearbyDiscovery(options);
}

class NearbyDiscovery implements Discovery {
    private readonly environment: DiscoveryEnvironment;
    private readonly logger: Logger;
    private readonly timings: DiscoveryTimings;
    private readonly stunServers: readonly string[];
    private readonly relayUrls: readonly string[];
    private readonly allowance: RelayAllowanceMonitor;
    private readonly emitter: Emitter<DiscoveryEvents>;
    private readonly pool: RelayPool;
    private readonly sessionStore: SessionStore;
    private signer: NostrSigner;
    private nearbyId: string;
    // New each time this device joins, so a goodbye ends one run and a reloaded page is welcome back.
    private currentRun = '';
    private readonly ownRuns = new Set<string>();
    private readonly senderLimiter: RateLimiter;
    private readonly knownDevices = new Map<string, KnownDevice>();
    private readonly incoming = new Map<string, IncomingRequest>();
    private readonly outgoing = new Map<string, OutgoingRequest>();
    // nearbyId → the Nostr key that first spoke for it, so no one else can speak for that device.
    private readonly pins = new Map<string, string>();
    private readonly directKeys = new Map<string, Promise<CryptoKey | undefined>>();
    private readonly withdrawnIds = new Set<string>();
    // Wrong PINs from askers, for the lockout; kept across rooms, so leaving and joining again doesn't reset it.
    private readonly pinGuard: PinGuard;
    // nearbyId → the runs that said goodbye, so a presence of such a run, arriving late through another relay,
    // can't bring it back, while a new run of the same device (a reload, a page shown again) is welcome.
    private readonly departures = new Map<string, Set<string>>();
    private readonly runUnsubscribes: Unsubscribe[] = [];
    private exchangeKeys?: Promise<ExchangeKeys>;
    private identity?: OwnNearbyIdentity;
    private suspendedIdentity?: OwnNearbyIdentity;
    // The room left on hiding, joined again at once when the page is shown, if the address check isn't due.
    private resumeAddress?: string;
    private sealedBye?: SealedBye;
    private statusValue: DiscoveryStatus = 'off';
    private deviceList: readonly NearbyDevice[] = Object.freeze([]);
    private room?: Room;
    private generation = 0;
    private isRunning = false;
    private isLookingUp = false;
    private hasLookupFailed = false;
    private lookupFailures = 0;
    private lastLookupAt = Number.NEGATIVE_INFINITY;
    // The next presence asks the room to greet: the first one in a room, and the first after being offline.
    private isJoining = true;
    private lastStunAnswerAt = Number.NEGATIVE_INFINITY;
    private isBrowserOnline = true;
    private lookupTimer?: unknown;
    private presenceTimer?: unknown;
    private greetingTimer?: unknown;
    private sweepTimer?: unknown;
    private dropCounts = new Map<string, number>();

    constructor(options: DiscoveryOptions) {
        this.environment = options.environment;
        this.logger = options.logger;
        this.timings = { ...DEFAULT_DISCOVERY_TIMINGS, ...options.timings };
        this.stunServers = options.stunServers ?? STUN_SERVERS;
        const relayUrls = options.relayUrls ?? RELAY_URLS;
        this.relayUrls = relayUrls;
        this.emitter = createEmitter<DiscoveryEvents>((error, name) => {
            this.logger.error('app', `a nearby ${String(name)} listener threw`, { error });
        });
        this.sessionStore = this.environment.sessionStore;
        const randomBytes = (length: number): Uint8Array => this.environment.randomBytes(length);
        const tabIdentity = loadTabIdentity(this.sessionStore, randomBytes, this.logger);
        this.nearbyId = tabIdentity.nearbyId;
        this.signer = createNostrSigner(tabIdentity.secretKey, randomBytes);
        this.senderLimiter = createRateLimiter({
            burst: SENDER_BURST,
            refillMs: SENDER_REFILL_MS,
            maxKeys: MAX_PINS,
            now: () => this.environment.now(),
        });
        this.pinGuard = createPinGuard(() => this.environment.now());
        this.pool = createRelayPool({
            urls: relayUrls,
            createSocket: this.environment.createSocket,
            clock: this.environment,
            logger: this.logger,
        });
        this.allowance = createRelayAllowanceMonitor({
            ownUrls: options.ownRelayUrls ?? OWN_RELAY_URLS.filter(url => relayUrls.includes(url)),
            fetchAsync: (url, init) => this.environment.fetchAsync(url, init),
            clock: this.environment,
            logger: this.logger,
            isInternetWorking: relayUrl => this.isInternetWorking(relayUrl),
            pauseRelay: relayUrl => this.pool.pause(relayUrl),
            resumeRelay: relayUrl => this.pool.resume(relayUrl),
            onChange: notice => this.emitter.emit('relay-allowance', notice),
        });
        this.pool.on('event', event => this.onRelayEvent(event));
        this.pool.on('change', () => this.refreshStatus());
        this.pool.on('relay-opened', url => this.allowance.relayOpened(url));
        this.pool.on('relay-failed', url => this.allowance.relayFailed(url));
        // For the page's whole life: hiding the page pauses discovery, and showing it again brings it back.
        this.environment.onPageHide(() => this.suspend('page hidden'));
        this.environment.onPageShow(() => this.resume());
        this.environment.onVisibilityChange(isHidden => {
            if (isHidden) {
                this.suspend('page hidden');
                return;
            }

            this.resume();
        });
    }

    status(): DiscoveryStatus {
        return this.statusValue;
    }

    devices(): readonly NearbyDevice[] {
        return this.deviceList;
    }

    relayAllowance(): RelayAllowanceNotice | undefined {
        return this.allowance.notice;
    }

    on<Name extends keyof DiscoveryEvents>(name: Name, handler: DiscoveryEvents[Name]): Unsubscribe {
        return this.emitter.on(name, handler);
    }

    start(identity: OwnNearbyIdentity): void {
        const cleaned = cleanIdentity(identity);
        if (this.isRunning) {
            const previous = this.identity;
            this.identity = cleaned;
            // Presence says whether there is a PIN, never which, so a PIN changed for another says nothing.
            const isChanged = previous?.name !== cleaned.name
                || previous.deviceType !== cleaned.deviceType
                || previous.platform !== cleaned.platform
                || (previous.pin != null) !== (cleaned.pin != null);
            if (isChanged) {
                this.logger.info('nearby', 'name, device type or PIN changed; announcing');
                this.announce();
            }

            return;
        }

        if (this.environment.isHidden()) {
            this.suspendedIdentity = cleaned;
            this.logger.info('nearby', 'page hidden; joining once it is visible');

            return;
        }

        this.suspendedIdentity = undefined;
        this.isRunning = true;
        this.generation++;
        this.currentRun = this.createId();
        this.ownRuns.add(this.currentRun);
        trimOldest(this.ownRuns, MAX_RUNS);
        this.identity = cleaned;
        this.hasLookupFailed = false;
        this.lookupFailures = 0;
        this.exchangeKeys ??= createExchangeKeysAsync();
        this.exchangeKeys.catch(() => undefined);
        this.runUnsubscribes.push(
            this.environment.onConnectivityChange(isOnline => this.onConnectivityChange(isOnline)),
        );
        this.logger.info('nearby', 'starting', {
            relays: this.relayUrls.length,
            stunServers: this.stunServers.length,
        });
        this.setStatus('starting');
        this.scheduleSweep();
        void this.rejoinOrLookUpAsync();
    }

    stop(): void {
        this.suspendedIdentity = undefined;
        this.resumeAddress = undefined;
        this.shutDown('stopped');
        this.lastLookupAt = Number.NEGATIVE_INFINITY;
    }

    async requestPairingAsync(
        nearbyId: string,
        offerCode: string,
        options: PairRequestOptions = {},
    ): Promise<PairRequestOutcome> {
        const signal = options.signal;
        if (signal?.aborted === true) {
            return { kind: 'canceled' };
        }

        if (this.statusValue !== 'listening' || this.room == null) {
            throw new DiscoveryError('not-listening', 'Nearby devices are not available right now');
        }

        const device = this.knownDevices.get(nearbyId);
        if (device == null) {
            throw new DiscoveryError('unknown-device', 'That device is no longer nearby');
        }

        if (!isValidCode(offerCode)) {
            throw new DiscoveryError('invalid-code', 'This is not a pairing code');
        }

        const requestId = this.createId();
        const target: Peer = { nearbyId, run: device.run, exchangeKey: device.exchangeKey };
        const outcome = new Promise<PairRequestOutcome>(resolve => {
            const onAbort = (): void => this.finishOutgoing(requestId, { kind: 'canceled' }, true);
            const onTimeout = (): void => this.finishOutgoing(requestId, { kind: 'no-answer' }, true);
            signal?.addEventListener('abort', onAbort, { once: true });
            const waitMs = this.timings.requestTimeoutMs + this.timings.answerGraceMs;
            this.outgoing.set(requestId, {
                requestId,
                target,
                timer: this.environment.setTimeout(onTimeout, waitMs),
                resolve,
                stopListening: () => signal?.removeEventListener('abort', onAbort),
            });
        });
        this.logger.info('nearby', 'pairing request sent', { requestId, hasPin: options.pin != null });
        const isSent = await this.sendDirectAsync(target, {
            t: 'request',
            id: requestId,
            offer: offerCode,
            ttl: this.timings.requestTimeoutMs,
            name: this.identity?.name ?? 'Device',
            device: this.identity?.deviceType ?? 'desktop',
            ...(options.pin == null ? {} : { proof: createPinProof(options.pin, requestId, offerCode) }),
        });
        if (!isSent && this.outgoing.has(requestId)) {
            this.finishOutgoing(requestId, { kind: 'no-answer' }, false);
            throw new DiscoveryError('send-failed', 'The request did not reach any relay');
        }

        return outcome;
    }

    async acceptAsync(requestId: string, answerCode: string): Promise<void> {
        const entry = this.incoming.get(requestId);
        if (entry == null) {
            throw new DiscoveryError('request-ended', 'This request ended before it was accepted');
        }

        if (!isValidCode(answerCode)) {
            throw new DiscoveryError('invalid-code', 'This is not a pairing code');
        }

        this.removeIncoming(requestId);
        this.logger.info('nearby', 'pairing request accepted', { requestId });
        const message: DirectMessage = { t: 'accept', id: requestId, answer: answerCode };
        const isSent = await this.sendDirectAsync(entry.sender, message);
        if (!isSent) {
            throw new DiscoveryError('send-failed', 'The answer did not reach any relay');
        }
    }

    async declineAsync(requestId: string, reason: 'declined' | 'busy' = 'declined'): Promise<void> {
        const entry = this.incoming.get(requestId);
        if (entry == null) {
            return;
        }

        this.removeIncoming(requestId);
        this.logger.info('nearby', `pairing request answered ${reason}`, { requestId });
        const isSent = await this.sendDirectAsync(entry.sender, { t: 'decline', id: requestId, reason });
        if (!isSent) {
            this.logger.warn('nearby', 'the decline did not reach any relay; the other device will time out');
        }
    }

    // Says goodbye and leaves; requests this device sent end as canceled, and the prompts it shows end too.
    private suspend(reason: string): void {
        if (!this.isRunning) {
            return;
        }

        this.suspendedIdentity = this.identity;
        this.resumeAddress = this.room?.address;
        this.shutDown(reason);
    }

    // Joins again with the same identity and a new run, so the others update the row the goodbye removed.
    private resume(): void {
        const identity = this.suspendedIdentity;
        if (identity == null || this.isRunning || this.environment.isHidden()) {
            return;
        }

        this.logger.info('nearby', 'page visible again; rejoining');
        this.start(identity);
    }

    private shutDown(reason: string): void {
        if (!this.isRunning) {
            return;
        }

        this.logger.info('nearby', `stopping: ${reason}`);
        for (const requestId of [...this.outgoing.keys()]) {
            this.finishOutgoing(requestId, { kind: 'canceled' }, false);
        }

        // The goodbye goes out before the sockets close; it also ends this device's requests elsewhere.
        this.sendByeNow();
        this.isRunning = false;
        this.generation++;
        for (const unsubscribe of this.runUnsubscribes.splice(0)) {
            unsubscribe();
        }

        for (const name of ['lookupTimer', 'presenceTimer', 'greetingTimer', 'sweepTimer'] as const) {
            this.cancelTimer(name);
        }

        this.pool.stop();
        this.pool.setSubscription(undefined);
        this.allowance.stop();
        this.leaveRoom();
        this.room = undefined;
        this.sealedBye = undefined;
        this.isLookingUp = false;
        this.setStatus('off');
    }

    // A page shown again rejoins the room it left at once, and checks the address when that is due.
    private async rejoinOrLookUpAsync(): Promise<void> {
        const address = this.resumeAddress;
        this.resumeAddress = undefined;
        const sinceLookupMs = this.environment.now() - this.lastLookupAt;
        if (address == null || sinceLookupMs >= this.timings.addressRecheckMs) {
            await this.lookUpAddressAsync();
            return;
        }

        const generation = this.generation;
        try {
            await this.joinRoomAsync(address, generation);
            if (generation === this.generation) {
                this.scheduleLookup(this.timings.addressRecheckMs - sinceLookupMs);
            }
        } catch (error) {
            if (generation === this.generation) {
                this.logger.warn('nearby', 'rejoining the room failed; checking the address', { error });
                void this.lookUpAddressAsync();
            }
        }
    }

    private async lookUpAddressAsync(): Promise<void> {
        if (!this.isRunning || this.isLookingUp) {
            return;
        }

        const runId = this.generation;
        this.isLookingUp = true;
        this.cancelTimer('lookupTimer');
        this.lastLookupAt = this.environment.now();
        try {
            const result = await findPublicAddressAsync({
                servers: this.stunServers,
                environment: this.environment,
                logger: this.logger,
                timeoutMs: this.timings.stunTimeoutMs,
            });
            if (runId !== this.generation) {
                return;
            }

            if (result.address == null) {
                this.onLookupFailed();
                return;
            }

            this.lookupFailures = 0;
            this.hasLookupFailed = false;
            this.lastStunAnswerAt = this.environment.now();
            if (result.address !== this.room?.address) {
                await this.joinRoomAsync(result.address, runId);
            }

            if (runId === this.generation) {
                this.scheduleLookup(this.timings.addressRecheckMs);
                this.refreshStatus();
            }
        } catch (error) {
            if (runId === this.generation) {
                this.logger.error('nearby', 'finding the room failed', { error });
                this.onLookupFailed();
            }
        } finally {
            if (runId === this.generation) {
                this.isLookingUp = false;
            }
        }
    }

    // Without an address there is no room; a known room is kept through a failed re-check.
    private onLookupFailed(): void {
        const steps = this.timings.lookupRetryMs;
        const delayMs = steps[Math.min(this.lookupFailures, steps.length - 1)] ?? 60_000;
        this.lookupFailures++;
        this.hasLookupFailed = true;
        this.scheduleLookup(delayMs);
        this.refreshStatus();
    }

    private async joinRoomAsync(address: string, generation: number): Promise<void> {
        const room: Room = await deriveRoomAsync(address);
        const byeContent = await this.sealByeAsync(room);
        if (generation !== this.generation) {
            return;
        }

        if (this.room != null) {
            this.logger.info('nearby', 'public address changed; moving to the new room');
            this.sendByeNow();
            this.leaveRoom();
        }

        this.room = room;
        this.sealedBye = { room, content: byeContent };
        this.isJoining = true;
        this.logger.info('nearby', `joined room ${room.tag.slice(0, 8)}`);
        this.pool.setSubscription({
            filter: () => ({
                kinds: [NEARBY_EVENT_KIND],
                [`#${ROOM_TAG_NAME}`]: [room.tag],
                since: this.nowSeconds() - SINCE_WINDOW_S,
            }),
            matches: event => event.kind === NEARBY_EVENT_KIND && readTag(event, ROOM_TAG_NAME) === room.tag,
        });
        this.pool.start();
        this.refreshStatus();
        this.announce();
    }

    // Forgets everything learned in the room: its devices, their keys and every open request.
    private leaveRoom(): void {
        for (const requestId of [...this.outgoing.keys()]) {
            this.finishOutgoing(requestId, { kind: 'no-answer' }, false);
        }

        for (const requestId of [...this.incoming.keys()]) {
            this.endIncoming(requestId);
        }

        this.pins.clear();
        this.directKeys.clear();
        this.withdrawnIds.clear();
        this.departures.clear();
        this.senderLimiter.clear();
        if (this.knownDevices.size > 0) {
            this.knownDevices.clear();
            this.publishDeviceList();
        }
    }

    private onConnectivityChange(isOnline: boolean): void {
        this.isBrowserOnline = isOnline;
        if (!isOnline) {
            this.logger.info('nearby', 'browser offline');
            this.pool.disconnectAll();
            this.refreshStatus();
            return;
        }

        this.logger.info('nearby', 'browser online; reconnecting and checking the address');
        this.pool.reconnectNow();
        this.lookupFailures = 0;
        void this.lookUpAddressAsync();
    }

    private isInternetWorking(relayUrl: string): boolean {
        if (!this.isBrowserOnline) {
            return false;
        }

        const isOtherRelayOpen = this.relayUrls.some(url => url !== relayUrl && this.pool.isOpen(url));

        return isOtherRelayOpen || this.environment.now() - this.lastStunAnswerAt <= INTERNET_EVIDENCE_MS;
    }

    private refreshStatus(): void {
        this.setStatus(this.computeStatus());
    }

    private computeStatus(): DiscoveryStatus {
        if (!this.isRunning) {
            return 'off';
        }

        if (this.room == null) {
            return this.hasLookupFailed ? 'offline' : 'starting';
        }

        if (this.pool.openCount > 0) {
            return 'listening';
        }

        return this.pool.isUnreachable ? 'offline' : 'starting';
    }

    private setStatus(status: DiscoveryStatus): void {
        if (status === this.statusValue) {
            return;
        }

        const previous = this.statusValue;
        this.statusValue = status;
        this.logger.info('nearby', `status ${status}`, { relays: this.pool.openCount });
        this.emitter.emit('status', status);
        if (status === 'listening' && previous !== 'listening') {
            this.isJoining = true;
            this.announce();
        }
    }

    // Presence now, then every presenceMs ± jitter.
    private announce(): void {
        const room = this.room;
        const identity = this.identity;
        if (!this.isRunning || room == null || identity == null || this.statusValue !== 'listening') {
            return;
        }

        this.cancelTimer('greetingTimer');
        this.cancelTimer('presenceTimer');
        const jitter = (this.environment.random() * 2 - 1) * this.timings.presenceJitterMs;
        this.presenceTimer = this.environment.setTimeout(() => this.announce(), this.timings.presenceMs + jitter);
        const isJoining = this.isJoining;
        this.isJoining = false;
        void this.sendPresenceAsync(room, identity, isJoining);
    }

    private async sendPresenceAsync(room: Room, identity: OwnNearbyIdentity, isJoining: boolean): Promise<void> {
        try {
            const keys = await this.requireExchangeKeysAsync();
            const presence = {
                t: 'here',
                from: this.nearbyId,
                run: this.currentRun,
                name: identity.name,
                device: identity.deviceType,
                ...(identity.platform == null ? {} : { platform: identity.platform }),
                key: keys.publicKey,
                ...(identity.pin == null ? {} : { pin: true as const }),
            } as const;
            const message: RoomMessage = isJoining ? { ...presence, joined: true } : presence;
            const isSent = await this.publishToRoomAsync(room, serializeRoomMessage(message));
            this.logger.debug('nearby', isSent ? 'presence sent' : 'presence reached no relay');
        } catch (error) {
            this.logger.warn('nearby', 'presence failed', { error });
        }
    }

    // A device that just joined missed every presence sent before it subscribed, so the room greets it
    // with an early presence instead of leaving it to wait up to 35 s. One greeting covers several joiners.
    private greet(): void {
        if (this.greetingTimer != null) {
            return;
        }

        const [minimum, maximum] = this.timings.greetingDelayMs;
        const delayMs = minimum + this.environment.random() * (maximum - minimum);
        this.greetingTimer = this.environment.setTimeout(() => {
            this.greetingTimer = undefined;
            this.announce();
        }, delayMs);
    }

    private async sealByeAsync(room: Room): Promise<string> {
        const bye: RoomMessage = { t: 'bye', from: this.nearbyId, run: this.currentRun };

        return sealAsync(room.key, serializeRoomMessage(bye), room.tag);
    }

    private sendByeNow(): void {
        const room = this.room;
        const bye = this.sealedBye;
        if (room == null || bye?.room !== room) {
            return;
        }

        try {
            this.pool.publishNow(this.signRoomEvent(room, bye.content));
            this.logger.info('nearby', 'goodbye sent');
        } catch (error) {
            this.logger.warn('nearby', 'goodbye failed', { error });
        }
    }

    private async publishToRoomAsync(room: Room, plaintext: string): Promise<boolean> {
        const content = await sealAsync(room.key, plaintext, room.tag);
        if (room !== this.room) {
            return false;
        }

        return this.pool.publishAsync(this.signRoomEvent(room, content));
    }

    private signRoomEvent(room: Room, content: string): NostrEvent {
        return this.signer.sign({
            createdAt: this.nowSeconds(),
            kind: NEARBY_EVENT_KIND,
            tags: [[ROOM_TAG_NAME, room.tag]],
            content,
        });
    }

    private async sendDirectAsync(peer: Peer, message: DirectMessage): Promise<boolean> {
        const room = this.room;
        if (room == null) {
            return false;
        }

        try {
            const keys = await this.requireExchangeKeysAsync();
            const key = await this.directKeyAsync(peer.exchangeKey, room);
            if (key == null) {
                return false;
            }

            const context = directContext(this.nearbyId, peer.nearbyId);
            const box = await sealAsync(key, serializeDirectMessage(message), context);
            const envelope: RoomMessage = {
                t: 'direct',
                from: this.nearbyId,
                run: this.currentRun,
                to: peer.nearbyId,
                key: keys.publicKey,
                box,
            };

            return await this.publishToRoomAsync(room, serializeRoomMessage(envelope));
        } catch (error) {
            this.logger.warn('nearby', `sending ${message.t} failed`, { error });

            return false;
        }
    }

    private async requireExchangeKeysAsync(): Promise<ExchangeKeys> {
        this.exchangeKeys ??= createExchangeKeysAsync();

        return this.exchangeKeys;
    }

    private async directKeyAsync(peerKey: string, room: Room): Promise<CryptoKey | undefined> {
        const cached = this.directKeys.get(peerKey);
        if (cached != null) {
            return cached;
        }

        const keys = await this.requireExchangeKeysAsync();
        const deriving = deriveDirectKeyAsync(keys.privateKey, peerKey, room.tag);
        this.directKeys.set(peerKey, deriving);
        while (this.directKeys.size > MAX_DIRECT_KEYS) {
            const oldest = this.directKeys.keys().next().value;
            if (oldest == null) {
                break;
            }

            this.directKeys.delete(oldest);
        }

        return deriving;
    }

    // The pool already checked the id and signature, and drops this device's own events; here: this room
    // and a sane time. Another tab with this tab's key (a duplicated tab) is found after opening the message.
    private onRelayEvent(event: NostrEvent): void {
        const room = this.room;
        if (!this.isRunning || room == null) {
            return;
        }

        if (Math.abs(this.nowSeconds() - event.created_at) > MAX_CLOCK_SKEW_S) {
            this.drop('too old or from the future');
            return;
        }

        void this.receiveAsync(event, room);
    }

    private async receiveAsync(event: NostrEvent, room: Room): Promise<void> {
        const plaintext = await openSealedAsync(room.key, event.content, room.tag);
        if (room !== this.room) {
            return;
        }

        const message = plaintext == null ? undefined : parseRoomMessage(plaintext);
        if (message == null) {
            this.drop(plaintext == null ? 'not sealed for this room' : 'malformed');
            return;
        }

        if (message.from === this.nearbyId) {
            this.onOwnIdentity(message.run);
            return;
        }

        const pinned = this.pins.get(message.from);
        if (pinned != null && pinned !== event.pubkey) {
            this.drop('another key speaking for a known device');
            return;
        }

        if (!this.senderLimiter.take(message.from)) {
            this.drop('flood from one device');
            return;
        }

        this.pin(message.from, event.pubkey);
        if (message.t === 'here') {
            if (this.departures.get(message.from)?.has(message.run) !== true) {
                this.onPresence(message);
            }

            return;
        }

        if (message.t === 'bye') {
            this.onBye(message);
            return;
        }

        if (message.to === this.nearbyId) {
            await this.receiveDirectAsync(message, room);
        }
    }

    // A duplicated tab copies sessionStorage, so two tabs can share one identity. Of the two, the one whose run
    // sorts first keeps it and the other takes a new one, so exactly one of them moves.
    private onOwnIdentity(run: string): void {
        if (this.ownRuns.has(run) || run > this.currentRun) {
            return;
        }

        const room = this.room;
        const identity = createTabIdentity(length => this.environment.randomBytes(length));
        this.logger.warn('nearby', 'another tab speaks as this device (a duplicated tab); taking a new identity');
        this.nearbyId = identity.nearbyId;
        this.signer = createNostrSigner(identity.secretKey, length => this.environment.randomBytes(length));
        saveTabIdentity(this.sessionStore, identity, this.logger);
        this.sealedBye = undefined;
        if (room != null) {
            void this.sealByeAsync(room).then(content => {
                if (room === this.room) {
                    this.sealedBye = { room, content };
                }
            });
        }

        this.isJoining = true;
        this.announce();
    }

    // One row per nearbyId: a presence from a listed device updates its row, whatever run it comes from.
    private onPresence(message: Extract<RoomMessage, { t: 'here' }>): void {
        const existing = this.knownDevices.get(message.from);
        if (existing == null) {
            this.replaceQuietNamesake(message);
        }

        if (existing == null && this.knownDevices.size >= MAX_DEVICES) {
            this.drop('room full');
            return;
        }

        this.knownDevices.set(message.from, {
            nearbyId: message.from,
            run: message.run,
            name: message.name,
            deviceType: message.device,
            platform: message.platform,
            hasPin: message.pin === true,
            exchangeKey: message.key,
            lastSeenAt: this.environment.wallClock(),
            heardAt: this.environment.now(),
        });
        if (existing == null) {
            this.logger.info('nearby', 'device appeared', { devices: this.knownDevices.size });
        }

        if (message.joined === true) {
            this.greet();
        }

        this.publishDeviceList();
    }

    // A tab closed without its goodbye leaves a row behind, and the same device then comes back with a new id
    // (a new tab). A new device with the same name and type as a row that has been quiet for longer than a presence
    // interval takes its place. Two live devices that share a name both speak every ~30 s, so neither is ever that
    // quiet and both rows stay.
    private replaceQuietNamesake(message: Extract<RoomMessage, { t: 'here' }>): void {
        const now = this.environment.now();
        const namesake = [...this.knownDevices.values()].find(device => device.name === message.name
            && device.deviceType === message.device
            && now - device.heardAt > this.timings.replaceQuietAfterMs);
        if (namesake == null) {
            return;
        }

        this.endRequestsOf(namesake.nearbyId, namesake.run);
        this.knownDevices.delete(namesake.nearbyId);
        this.logger.info('nearby', 'a quiet device was replaced by a new one with the same name');
    }

    // A goodbye ends that run only: a goodbye arriving after the device came back (a reload) leaves its row alone.
    private onBye(message: Extract<RoomMessage, { t: 'bye' }>): void {
        const runs = this.departures.get(message.from) ?? new Set<string>();
        runs.add(message.run);
        trimOldest(runs, MAX_RUNS);
        this.departures.delete(message.from);
        this.departures.set(message.from, runs);
        trimOldest(this.departures, MAX_PINS);
        this.endRequestsOf(message.from, message.run);
        if (this.knownDevices.get(message.from)?.run !== message.run) {
            return;
        }

        this.knownDevices.delete(message.from);
        this.logger.info('nearby', 'device left', { devices: this.knownDevices.size });
        this.publishDeviceList();
    }

    // What belonged to one run of a device: requests to it get no answer, and its requests to this device end.
    private endRequestsOf(nearbyId: string, run: string): void {
        for (const [requestId, entry] of this.outgoing) {
            if (entry.target.nearbyId === nearbyId && entry.target.run === run) {
                this.finishOutgoing(requestId, { kind: 'no-answer' }, false);
            }
        }

        for (const [requestId, entry] of this.incoming) {
            if (entry.sender.nearbyId === nearbyId && entry.sender.run === run) {
                this.endIncoming(requestId);
            }
        }
    }

    private async receiveDirectAsync(envelope: Extract<RoomMessage, { t: 'direct' }>, room: Room): Promise<void> {
        const known = this.knownDevices.get(envelope.from);
        if (known?.run === envelope.run && known.exchangeKey !== envelope.key) {
            this.drop('a direct message under another key');
            return;
        }

        const key = await this.directKeyAsync(envelope.key, room);
        const plaintext = key == null
            ? undefined
            : await openSealedAsync(key, envelope.box, directContext(envelope.from, envelope.to));
        if (room !== this.room) {
            return;
        }

        const message = plaintext == null ? undefined : parseDirectMessage(plaintext);
        if (message == null) {
            this.drop(plaintext == null ? 'a direct message not sealed for this device' : 'malformed');
            return;
        }

        const sender: Peer = { nearbyId: envelope.from, run: envelope.run, exchangeKey: envelope.key };
        if (message.t === 'request') {
            this.onRequest(message, sender);
            return;
        }

        if (message.t === 'cancel') {
            this.onCancel(message.id, sender);
            return;
        }

        const entry = this.outgoing.get(message.id);
        if (entry?.target.nearbyId !== sender.nearbyId) {
            return;
        }

        const outcome: PairRequestOutcome = message.t === 'accept'
            ? { kind: 'accepted', answerCode: message.answer }
            : { kind: message.reason };
        this.finishOutgoing(message.id, outcome, false);
    }

    private onCancel(requestId: string, sender: Peer): void {
        const entry = this.incoming.get(requestId);
        if (entry != null && entry.sender.nearbyId !== sender.nearbyId) {
            return;
        }

        this.withdrawnIds.add(requestId);
        while (this.withdrawnIds.size > MAX_WITHDRAWN_IDS) {
            const oldest = this.withdrawnIds.values().next().value;
            if (oldest == null) {
                break;
            }

            this.withdrawnIds.delete(oldest);
        }

        if (entry != null) {
            this.logger.info('nearby', 'pairing request withdrawn', { requestId });
            this.endIncoming(requestId);
        }
    }

    private onRequest(message: Extract<DirectMessage, { t: 'request' }>, sender: Peer): void {
        if (this.incoming.has(message.id) || this.withdrawnIds.has(message.id)) {
            return;
        }

        const fromSender = [...this.incoming.values()].filter(entry => entry.sender.nearbyId === sender.nearbyId);
        if (this.incoming.size >= MAX_INCOMING_REQUESTS || fromSender.length >= MAX_REQUESTS_PER_SENDER) {
            this.drop('too many open requests');
            return;
        }

        const pin = this.identity?.pin;
        const refusal = pin == null ? undefined : this.checkPin(pin, message, sender);
        if (refusal != null) {
            this.logger.info('nearby', `pairing request answered ${refusal}`, { requestId: message.id });
            void this.sendDirectAsync(sender, { t: 'decline', id: message.id, reason: refusal });

            return;
        }

        const known = this.knownDevices.get(sender.nearbyId);
        const from: NearbyDevice = known == null
            ? {
                nearbyId: sender.nearbyId,
                name: message.name,
                deviceType: message.device,
                lastSeenAt: this.environment.wallClock(),
            }
            : toNearbyDevice(known);
        const request: PairRequest = {
            requestId: message.id,
            from,
            offerCode: message.offer,
            expiresAt: this.environment.wallClock() + message.ttl,
            isPinVerified: pin != null,
        };
        const timer = this.environment.setTimeout(() => {
            this.logger.info('nearby', 'pairing request expired', { requestId: message.id });
            this.endIncoming(message.id);
        }, message.ttl);
        this.incoming.set(message.id, { request, sender, timer });
        this.logger.info('nearby', 'pairing request received', {
            requestId: message.id,
            ttlMs: message.ttl,
            isPinVerified: request.isPinVerified,
        });
        this.emitter.emit('request', request);
    }

    // A device with a PIN takes only requests that prove it. A missing proof costs nothing, since an older build
    // sends none; wrong ones count towards a lockout, during which the asker, or everyone, is answered busy.
    // The log never holds the PIN, the proof or who asked.
    private checkPin(
        pin: string,
        message: Extract<DirectMessage, { t: 'request' }>,
        sender: Peer,
    ): DeclineReason | undefined {
        if (this.pinGuard.isLockedOut(sender)) {
            return 'busy';
        }

        if (message.proof == null) {
            return 'pin-required';
        }

        if (isPinProofValid(pin, message.id, message.offer, message.proof)) {
            this.pinGuard.recordRight(sender);

            return undefined;
        }

        const result = this.pinGuard.recordWrong(sender);
        const lockout = { lockoutMs: PIN_LOCKOUT_MS };
        if (result === 'asker-locked') {
            const message = `${PIN_ATTEMPTS_PER_ASKER} wrong PINs from one device; answering it busy`;
            this.logger.warn('nearby', message, lockout);
        }

        if (result === 'all-locked') {
            const message = `${PIN_ATTEMPTS_IN_TOTAL} wrong PINs from nearby devices; answering all busy`;
            this.logger.warn('nearby', message, lockout);
        }

        return 'wrong-pin';
    }

    private removeIncoming(requestId: string): IncomingRequest | undefined {
        const entry = this.incoming.get(requestId);
        if (entry != null) {
            this.incoming.delete(requestId);
            this.environment.clearTimeout(entry.timer);
        }

        return entry;
    }

    private endIncoming(requestId: string): void {
        if (this.removeIncoming(requestId) != null) {
            this.emitter.emit('request-ended', requestId);
        }
    }

    private finishOutgoing(requestId: string, outcome: PairRequestOutcome, shouldCancel: boolean): void {
        const entry = this.outgoing.get(requestId);
        if (entry == null) {
            return;
        }

        this.outgoing.delete(requestId);
        this.environment.clearTimeout(entry.timer);
        entry.stopListening();
        if (shouldCancel) {
            void this.sendDirectAsync(entry.target, { t: 'cancel', id: requestId });
        }

        this.logger.info('nearby', `pairing request ${outcome.kind}`, { requestId });
        entry.resolve(outcome);
    }

    private scheduleSweep(): void {
        this.sweepTimer = this.environment.setTimeout(() => {
            this.sweep();
            this.scheduleSweep();
        }, this.timings.sweepMs);
    }

    // Devices silent for deviceTimeoutMs are gone; their requests run on until they expire.
    private sweep(): void {
        const now = this.environment.now();
        const silent = [...this.knownDevices.values()]
            .filter(device => now - device.heardAt > this.timings.deviceTimeoutMs);
        if (silent.length === 0) {
            return;
        }

        for (const device of silent) {
            this.knownDevices.delete(device.nearbyId);
        }

        this.logger.info('nearby', `${silent.length} device(s) went quiet`, { devices: this.knownDevices.size });
        this.publishDeviceList();
    }

    private publishDeviceList(): void {
        const devices = [...this.knownDevices.values()]
            .map(toNearbyDevice)
            .sort(compareDevices);
        this.deviceList = Object.freeze(devices);
        this.emitter.emit('devices', this.deviceList);
    }

    private pin(nearbyId: string, publicKey: string): void {
        if (this.pins.has(nearbyId)) {
            return;
        }

        this.pins.set(nearbyId, publicKey);
        while (this.pins.size > MAX_PINS) {
            const oldest = this.pins.keys().next().value;
            if (oldest == null) {
                break;
            }

            this.pins.delete(oldest);
        }
    }

    private scheduleLookup(delayMs: number): void {
        this.cancelTimer('lookupTimer');
        this.lookupTimer = this.environment.setTimeout(() => {
            this.lookupTimer = undefined;
            void this.lookUpAddressAsync();
        }, delayMs);
    }

    private cancelTimer(name: 'lookupTimer' | 'presenceTimer' | 'greetingTimer' | 'sweepTimer'): void {
        const handle = this[name];
        if (handle != null) {
            this.environment.clearTimeout(handle);
            this[name] = undefined;
        }
    }

    private drop(reason: string): void {
        this.dropCounts.set(reason, (this.dropCounts.get(reason) ?? 0) + 1);
        if (!this.logger.every('nearby.drop', DROP_LOG_MS)) {
            return;
        }

        const counts = Object.fromEntries(this.dropCounts);
        this.dropCounts = new Map();
        this.logger.warn('nearby', `dropped nearby messages: ${Object.keys(counts).join(', ')}`, { counts });
    }

    private nowSeconds(): number {
        return Math.floor(this.environment.wallClock() / 1000);
    }

    // Request ids and runs; the tab's nearbyId comes from tabIdentity.ts.
    private createId(): string {
        return bytesToBase64Url(this.environment.randomBytes(ID_BYTES));
    }
}

// Drops the oldest entries, in insertion order, beyond the cap.
function trimOldest(collection: Set<string> | Map<string, unknown>, cap: number): void {
    while (collection.size > cap) {
        const oldest = collection.keys().next().value;
        if (oldest == null) {
            return;
        }

        collection.delete(oldest);
    }
}

function cleanIdentity(identity: OwnNearbyIdentity): OwnNearbyIdentity {
    const platform = toDevicePlatform(identity.platform);

    return {
        name: sanitizeName(identity.name) ?? 'Device',
        deviceType: toDeviceType(identity.deviceType),
        ...(platform == null ? {} : { platform }),
        ...(isValidPin(identity.pin) ? { pin: identity.pin } : {}),
    };
}

function toNearbyDevice(device: KnownDevice): NearbyDevice {
    return Object.freeze({
        nearbyId: device.nearbyId,
        name: device.name,
        deviceType: device.deviceType,
        ...(device.platform == null ? {} : { platform: device.platform }),
        lastSeenAt: device.lastSeenAt,
        ...(device.hasPin ? { hasPin: true } : {}),
    });
}

// By name, then by id, so the list keeps its order between updates.
function compareDevices(first: NearbyDevice, second: NearbyDevice): number {
    const byName = first.name.localeCompare(second.name, undefined, { sensitivity: 'base' });

    return byName === 0 ? first.nearbyId.localeCompare(second.nearbyId) : byName;
}

// Bound into each direct box, so a box can't be replayed in the other direction or to another device.
function directContext(from: string, to: string): string {
    return `ether-nearby-v1|${from}|${to}`;
}
