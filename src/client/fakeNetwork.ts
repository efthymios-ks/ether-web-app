import { createEmitter } from '../core/events.js';
import type { Unsubscribe } from '../core/events.js';
import { FRAME_HEADER_SIZE, MAX_CONTROL_MESSAGE_BYTES, NetworkError } from '../network/networkTypes.js';
import type {
    AnswerCode,
    CandidatePairStats,
    ChannelName,
    CreateNetwork,
    FrameHeader,
    Health,
    LinkState,
    Message,
    Network,
    NetworkEvents,
    NetworkOptions,
    PairingCode,
    SlotId,
} from '../network/networkTypes.js';

// An in-memory Network pair for tests (CL-10): fake pairing codes, delay, loss, per-channel order,
// buffered amounts, disconnects, and hooks that drop or change single messages and frames.

export type FakeTraffic =
    | { readonly kind: 'message'; readonly from: FakeNetwork; readonly channel: ChannelName; readonly message: Message }
    | { readonly kind: 'frame'; readonly from: FakeNetwork; readonly header: FrameHeader; readonly payload: Uint8Array };

// Undefined delivers the traffic unchanged.
export type FakeVerdict = undefined | 'drop' | { readonly message: Message } | { readonly payload: Uint8Array };

export type FakeInterceptor = (traffic: FakeTraffic) => FakeVerdict;

export interface FakeNetworkHubOptions {
    readonly delayMs?: number;
    // Share of messages and frames lost at random, 0 to 1.
    readonly lossRate?: number;
    readonly maxMessageSize?: number;
    readonly random?: () => number;
    readonly now?: () => number;
}

export interface FakeNetwork extends Network {
    readonly index: number;
    readonly peer: FakeNetwork | undefined;
    readonly options: NetworkOptions;
    readonly configureCalls: ReadonlyArray<Partial<Omit<NetworkOptions, 'logger' | 'environment'>>>;
    readonly closeReason: string | undefined;
}

export interface FakeNetworkHub {
    readonly createNetwork: CreateNetwork;
    readonly networks: readonly FakeNetwork[];
    delayMs: number;
    lossRate: number;
    intercept(interceptor: FakeInterceptor): Unsubscribe;
    // As if the Wi‑Fi went away: queued traffic is lost and both ends go to 'lost'.
    dropLinks(): void;
    // Resolves once nothing is queued on any link.
    settleAsync(): Promise<void>;
}

interface Envelope {
    readonly channel: ChannelName;
    readonly bytes: number;
    readonly deliver: () => void;
}

interface FakeNetworkInternal extends FakeNetwork {
    link(peer: FakeNetworkInternal): void;
    receiveConnected(): void;
    receiveMessage(channel: ChannelName, message: Message): void;
    receiveFrame(header: FrameHeader, payload: Uint8Array): void;
    remoteClosed(): void;
    dropLink(): void;
    readonly pending: number;
}

interface PendingCode {
    readonly owner: FakeNetworkInternal;
    readonly expiresAt: number;
    isUsed: boolean;
}

interface HubInternals {
    readonly offers: Map<string, PendingCode>;
    readonly answers: Map<string, { readonly offerer: FakeNetworkInternal; readonly answerer: FakeNetworkInternal }>;
    readonly interceptors: Set<FakeInterceptor>;
    readonly settings: { delayMs: number; lossRate: number };
    readonly maxMessageSize: number;
    readonly random: () => number;
    readonly now: () => number;
    nextCode(): number;
}

const DEFAULT_MAX_MESSAGE_SIZE = 256 * 1024;
const textEncoder = new TextEncoder();
const DRAIN_SHARE = 4;
const HEALTHY: Health = Object.freeze({ status: 'good', lastSeenMs: 0, peerHidden: false });

export function createFakeNetworkHub(options: FakeNetworkHubOptions = {}): FakeNetworkHub {
    const networks: FakeNetworkInternal[] = [];
    let codeCounter = 0;
    const hub: HubInternals = {
        offers: new Map(),
        answers: new Map(),
        interceptors: new Set(),
        settings: { delayMs: options.delayMs ?? 0, lossRate: options.lossRate ?? 0 },
        maxMessageSize: options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
        random: options.random ?? Math.random,
        now: options.now ?? Date.now,
        nextCode: () => ++codeCounter,
    };

    return {
        createNetwork: networkOptions => {
            const network = createFakeNetwork(hub, networkOptions, networks.length);
            networks.push(network);

            return network;
        },
        get networks() {
            return networks;
        },
        get delayMs() {
            return hub.settings.delayMs;
        },
        set delayMs(value: number) {
            hub.settings.delayMs = value;
        },
        get lossRate() {
            return hub.settings.lossRate;
        },
        set lossRate(value: number) {
            hub.settings.lossRate = value;
        },
        intercept: interceptor => {
            hub.interceptors.add(interceptor);

            return () => {
                hub.interceptors.delete(interceptor);
            };
        },
        dropLinks: () => {
            for (const network of networks) {
                network.dropLink();
            }
        },
        settleAsync: async () => {
            while (networks.some(network => network.pending > 0)) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        },
    };
}

// Pairs two fresh networks of the hub by passing the fake codes, as two pages would by QR.
export async function createConnectedPairAsync(
    hub: FakeNetworkHub,
    options: NetworkOptions,
): Promise<readonly [FakeNetwork, FakeNetwork]> {
    const offerer = hub.createNetwork(options) as FakeNetwork;
    const answerer = hub.createNetwork(options) as FakeNetwork;
    const offer = await offerer.createOfferAsync();
    const answer = await answerer.acceptOfferAsync(offer.url);
    await offerer.acceptAnswerAsync(answer.code);

    return [offerer, answerer];
}

function parseCode(codeOrUrl: string): string {
    const hashIndex = codeOrUrl.indexOf('#');

    return (hashIndex >= 0 ? codeOrUrl.slice(hashIndex + 1) : codeOrUrl).trim().toUpperCase();
}

function scheduleTask(callback: () => void, delayMs: number): void {
    if (delayMs > 0) {
        setTimeout(callback, delayMs);

        return;
    }

    const immediate = (globalThis as { setImmediate?: (handler: () => void) => unknown }).setImmediate;
    if (immediate) {
        immediate(callback);

        return;
    }

    setTimeout(callback, 0);
}

function createFakeNetwork(hub: HubInternals, options: NetworkOptions, index: number): FakeNetworkInternal {
    const emitter = createEmitter<NetworkEvents>();
    const buffered = new Map<ChannelName, number>();
    const drainWaiters = new Set<{ readonly slot: SlotId; resolve(): void; reject(error: unknown): void }>();
    const configureCalls: Array<Partial<Omit<NetworkOptions, 'logger' | 'environment'>>> = [];
    let queue: Envelope[] = [];
    let state: LinkState = 'idle';
    let peer: FakeNetworkInternal | undefined;
    let chunkSize = options.chunkSize;
    let maxBuffered = options.maxBuffered;
    let isFlushScheduled = false;
    let closeReason: string | undefined;

    const setState = (next: LinkState): void => {
        if (state === next) {
            return;
        }

        state = next;
        emitter.emit('state', next);
    };

    const drainThreshold = (): number => maxBuffered / DRAIN_SHARE;

    const releaseDrainWaiters = (): void => {
        for (const waiter of [...drainWaiters]) {
            if ((buffered.get(waiter.slot) ?? 0) <= drainThreshold()) {
                drainWaiters.delete(waiter);
                waiter.resolve();
            }
        }
    };

    const rejectDrainWaiters = (): void => {
        for (const waiter of drainWaiters) {
            waiter.reject(new NetworkError('channel-closed', 'The link is down'));
        }

        drainWaiters.clear();
    };

    const flush = (): void => {
        isFlushScheduled = false;
        const batch = queue;
        queue = [];
        for (const envelope of batch) {
            buffered.set(envelope.channel, Math.max(0, (buffered.get(envelope.channel) ?? 0) - envelope.bytes));
            envelope.deliver();
        }

        releaseDrainWaiters();
    };

    const enqueue = (envelope: Envelope): void => {
        buffered.set(envelope.channel, (buffered.get(envelope.channel) ?? 0) + envelope.bytes);
        queue.push(envelope);
        if (!isFlushScheduled) {
            isFlushScheduled = true;
            scheduleTask(flush, hub.settings.delayMs);
        }
    };

    const ensureOpen = (): FakeNetworkInternal => {
        if (state !== 'connected' || !peer) {
            throw new NetworkError('channel-closed', 'The link is not connected');
        }

        return peer;
    };

    const applyInterceptors = (traffic: FakeTraffic): FakeVerdict => {
        for (const interceptor of hub.interceptors) {
            const verdict = interceptor(traffic);
            if (verdict !== undefined) {
                return verdict;
            }
        }

        return undefined;
    };

    const isLost = (): boolean => hub.settings.lossRate > 0 && hub.random() < hub.settings.lossRate;

    const network: FakeNetworkInternal = {
        index,
        options,
        configureCalls,
        get peer() {
            return peer;
        },
        get closeReason() {
            return closeReason;
        },
        get pending() {
            return queue.length;
        },
        get state() {
            return state;
        },
        get health() {
            return HEALTHY;
        },
        get maxMessageSize() {
            return hub.maxMessageSize;
        },
        get checkCode() {
            return state === 'connected' ? 'FAKE' : undefined;
        },
        get maxFramePayload() {
            return Math.min(chunkSize, hub.maxMessageSize) - FRAME_HEADER_SIZE;
        },

        createOfferAsync: async (): Promise<PairingCode> => {
            setState('gathering');
            const code = `FAKEOFFER${hub.nextCode()}`;
            const expiresAt = hub.now() + options.timeouts.codeExpiryMs;
            hub.offers.set(code, { owner: network, expiresAt, isUsed: false });
            setState('awaiting-answer');

            return { code, url: `${options.appUrl}#${code}`, expiresAt };
        },
        acceptOfferAsync: async (codeOrUrl): Promise<AnswerCode> => {
            const offer = hub.offers.get(parseCode(codeOrUrl));
            if (!offer) {
                throw new NetworkError('code-invalid', 'Not a pairing code');
            }

            if (offer.isUsed) {
                throw new NetworkError('code-used', 'This code was already used');
            }

            if (hub.now() > offer.expiresAt) {
                throw new NetworkError('code-expired', 'This code expired, show a new one');
            }

            offer.isUsed = true;
            setState('answering');
            const code = `FAKEANSWER${hub.nextCode()}`;
            hub.answers.set(code, { offerer: offer.owner, answerer: network });
            setState('connecting');

            return { code, url: `${options.appUrl}#${code}` };
        },
        acceptAnswerAsync: async codeOrUrl => {
            const answer = hub.answers.get(parseCode(codeOrUrl));
            if (!answer || answer.offerer !== network) {
                throw new NetworkError('code-invalid', 'Not the answer to this offer');
            }

            hub.answers.delete(parseCode(codeOrUrl));
            setState('connecting');
            network.link(answer.answerer);
            answer.answerer.link(network);
            setState('connected');
            answer.answerer.receiveConnected();
        },

        send: (channel, message) => {
            const target = ensureOpen();
            const text = JSON.stringify(message);
            // The same limit network.ts enforces: 64 KiB of UTF-8, not of UTF-16 units.
            const bytes = textEncoder.encode(text).byteLength;
            const limit = Math.min(MAX_CONTROL_MESSAGE_BYTES, hub.maxMessageSize);
            if (bytes > limit) {
                throw new NetworkError('message-too-large', `A "${message.t}" message is ${bytes} bytes, over ${limit}`);
            }

            const verdict = applyInterceptors({ kind: 'message', from: network, channel, message });
            if (verdict === 'drop' || isLost()) {
                return;
            }

            const delivered = verdict != null && 'message' in verdict ? JSON.stringify(verdict.message) : text;
            enqueue({ channel, bytes: delivered.length, deliver: () => target.receiveMessage(channel, JSON.parse(delivered) as Message) });
        },
        sendFrame: (header, payload) => {
            const target = ensureOpen();
            if (payload.length > network.maxFramePayload) {
                throw new NetworkError('message-too-large', `Frame payload ${payload.length} bytes`);
            }

            const copy = payload.slice();
            const verdict = applyInterceptors({ kind: 'frame', from: network, header, payload: copy });
            if (verdict === 'drop' || isLost()) {
                return;
            }

            const delivered = verdict != null && 'payload' in verdict ? verdict.payload.slice() : copy;
            const frameHeader = { ...header };
            enqueue({
                channel: header.slot,
                bytes: delivered.length + FRAME_HEADER_SIZE,
                deliver: () => target.receiveFrame(frameHeader, delivered),
            });
        },
        waitDrainedAsync: slot => {
            if (state !== 'connected') {
                return Promise.reject(new NetworkError('channel-closed', 'The link is down'));
            }

            if ((buffered.get(slot) ?? 0) <= drainThreshold()) {
                return Promise.resolve();
            }

            return new Promise((resolve, reject) => {
                drainWaiters.add({ slot, resolve, reject });
            });
        },
        bufferedAmount: channel => buffered.get(channel) ?? 0,

        getStatsAsync: async (): Promise<CandidatePairStats[]> => [],
        configure: changes => {
            configureCalls.push(changes);
            chunkSize = changes.chunkSize ?? chunkSize;
            maxBuffered = changes.maxBuffered ?? maxBuffered;
        },
        close: reason => {
            if (state === 'closed') {
                return;
            }

            closeReason = reason;
            const target = peer;
            peer = undefined;
            rejectDrainWaiters();
            if (target) {
                enqueue({ channel: 'control', bytes: 0, deliver: () => target.remoteClosed() });
            }

            setState('closed');
        },
        on: (name, handler) => emitter.on(name, handler),

        link: target => {
            peer = target;
        },
        receiveConnected: () => {
            setState('connected');
        },
        receiveMessage: (channel, message) => {
            if (state !== 'connected') {
                return;
            }

            emitter.emit('message', channel, message);
        },
        receiveFrame: (header, payload) => {
            if (state !== 'connected') {
                return;
            }

            emitter.emit('frame', header, payload);
        },
        remoteClosed: () => {
            if (state === 'closed') {
                return;
            }

            peer = undefined;
            rejectDrainWaiters();
            setState('closed');
        },
        dropLink: () => {
            if (state !== 'connected') {
                return;
            }

            queue = [];
            buffered.clear();
            peer = undefined;
            rejectDrainWaiters();
            setState('lost');
        },
    };

    return network;
}
