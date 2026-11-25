import { createEmitter } from '../core/events.js';
import type { Emitter, Unsubscribe } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { createBrowserEnvironment } from './browserEnvironment.js';
import { mapCandidatePairStats } from './candidateStats.js';
import type { StatsRecord } from './candidateStats.js';
import { deriveCheckCodeAsync } from './checkCode.js';
import { decodeFrame, encodeFrame, validateFrameHeader } from './frame.js';
import { createHealthMonitor } from './healthMonitor.js';
import type { HealthMonitor } from './healthMonitor.js';
import { FRAME_HEADER_SIZE, MAX_CONTROL_MESSAGE_BYTES, NetworkError, SLOT_IDS } from './networkTypes.js';
import type {
    AnswerCode,
    CandidateInfo,
    CandidatePairStats,
    ChannelName,
    CodeKind,
    CodeSummary,
    FrameHeader,
    Health,
    LinkState,
    Message,
    Network,
    NetworkEnvironment,
    NetworkEvents,
    NetworkOptions,
    NetworkTimeouts,
    PairingCode,
    SlotId,
} from './networkTypes.js';
import {
    buildCodeUrl,
    codeByteLength,
    decodePairingCode,
    deriveOfferTagAsync,
    encodePairingCode,
    extractCode,
    selectCodeCandidates,
} from './pairingCode.js';
import type { DecodedPairingCode } from './pairingCode.js';
import { buildSdp, formatFingerprint, parseCandidate, parseSdp } from './sdp.js';
import type { ParsedDescription } from './sdp.js';

// The low-level link (§17.2): pairing by codes, five negotiated channels, frames, backpressure and health.

const DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024;
// HS-08: the devices' clocks may differ; an offer is expired only past its expiry plus this.
const CLOCK_SKEW_MS = 60_000;
const HEALTH_CHECK_MS = 1000;
// DL-09: one round-trip line every 10 s.
const RTT_LOG_MS = 10_000;
const DROP_LOG_MS = 1000;
const STRAY_ANSWER_MESSAGE = 'This answer belongs to another code. Scan the answer shown for this code.';

interface ChannelSpec {
    readonly name: ChannelName;
    readonly id: number;
    readonly label: string;
}

// NW-01, TR-03: id 0 is control and ids 1–4 are the file slots, always all five.
const CHANNEL_SPECS: readonly ChannelSpec[] = Object.freeze([
    { name: 'control', id: 0, label: 'control' },
    ...SLOT_IDS.map(slot => ({ name: slot, id: slot, label: `slot${slot}` })),
]);

interface NetworkSettings {
    readonly chunkSize: number;
    readonly maxBuffered: number;
    readonly timeouts: NetworkTimeouts;
    readonly appUrl: string;
    readonly exposeLocalIps?: () => Promise<(() => void) | null>;
}

interface Deferred<Value> {
    readonly promise: Promise<Value>;
    resolve(value: Value): void;
    reject(error: unknown): void;
}

interface LocalCode {
    readonly kind: CodeKind;
    readonly local: ParsedDescription;
    // Answers carry the tag of the offer they answer.
    readonly offerTag?: number;
}

interface Termination {
    readonly state: 'lost' | 'closed';
    readonly reason: string;
    readonly error?: NetworkError;
    // The caller gets the error from the call it made, so it is not emitted as well.
    readonly isReportedByCaller?: boolean;
}

export function createNetwork(options: NetworkOptions): Network {
    return new PeerNetwork(options);
}

// HS-07: what a code holds, without a peer connection. Throws NetworkError code-invalid or code-version.
export function inspectCode(codeOrUrl: string): CodeSummary {
    const payload = decodePairingCode(codeOrUrl);

    return {
        kind: payload.kind,
        version: payload.version,
        code: extractCode(codeOrUrl),
        createdAt: payload.createdAt * 1000,
        candidateCount: payload.candidates.length,
    };
}

class PeerNetwork implements Network {
    private readonly environment: NetworkEnvironment;
    private readonly logger: Logger;
    private readonly emitter: Emitter<NetworkEvents>;
    private readonly monitor: HealthMonitor;
    private readonly listeners = new AbortController();
    private readonly channels = new Map<ChannelName, RTCDataChannel>();
    private readonly drainWaiters = new Map<SlotId, Set<Deferred<void>>>();
    private readonly timeoutHandles = new Set<unknown>();
    private readonly intervalHandles = new Set<unknown>();
    private readonly unsubscribes: Unsubscribe[] = [];
    private readonly termination = createDeferred<never>();
    private readonly connected = createDeferred<void>();
    private readonly sessionId: number;
    private readonly logKey: string;
    private settings: NetworkSettings;
    private linkState: LinkState = 'idle';
    private hasEnded = false;
    private pendingCalls = 0;
    private peerConnection?: RTCPeerConnection;
    private localDescription?: ParsedDescription;
    private offerTag?: number;
    private checkCodePromise?: Promise<string | undefined>;
    private checkCodeValue?: string;
    private offerDeadline?: number;
    private isOfferExpired = false;
    private isAnswerTaken = false;
    private expiryTimer?: unknown;
    private connectTimer?: unknown;
    private pingTimer?: unknown;
    private pingSequence = 0;
    private droppedCount = 0;
    private lastHealth: Health = { status: 'good', lastSeenMs: 0, peerHidden: false };
    private endConnectSpan?: (data?: unknown) => void;

    // NW-02: these never reach the client.
    private readonly internalHandlers: Readonly<Record<string, (message: Message) => void>> = Object.freeze({
        ping: message => this.onPing(message),
        pong: message => this.onPong(message),
        vis: message => this.onPeerVisibility(message),
        bye: message => this.onBye(message),
    });

    constructor(options: NetworkOptions) {
        this.environment = { ...createBrowserEnvironment(), ...options.environment };
        this.logger = options.logger;
        this.settings = {
            chunkSize: options.chunkSize,
            maxBuffered: options.maxBuffered,
            timeouts: options.timeouts,
            appUrl: options.appUrl,
            ...(options.exposeLocalIps == null ? {} : { exposeLocalIps: options.exposeLocalIps }),
        };
        this.emitter = createEmitter<NetworkEvents>((error, name) => {
            this.logger.error('app', `a network ${String(name)} listener threw`, { error });
        });
        this.monitor = createHealthMonitor({
            now: () => this.environment.now(),
            weakMs: options.timeouts.weakMs,
            lostMs: options.timeouts.lostMs,
        });

        const random = this.environment.randomBytes(4);
        this.sessionId = new DataView(random.buffer, random.byteOffset, 4).getUint32(0);
        this.logKey = `network.${this.sessionId.toString(16)}`;
        this.termination.promise.catch(() => undefined);
        this.unsubscribes.push(this.environment.onPageHide(() => this.close('page hidden')));
    }

    get state(): LinkState {
        return this.linkState;
    }

    get health(): Health {
        return this.linkState === 'connected' ? this.monitor.evaluate() : this.lastHealth;
    }

    get maxMessageSize(): number {
        const size = this.peerConnection?.sctp?.maxMessageSize;

        return size != null && size > 0 ? size : DEFAULT_MAX_MESSAGE_SIZE;
    }

    get maxFramePayload(): number {
        return Math.min(this.settings.chunkSize, this.maxMessageSize) - FRAME_HEADER_SIZE;
    }

    get checkCode(): string | undefined {
        return this.checkCodeValue;
    }

    on<Name extends keyof NetworkEvents>(name: Name, handler: NetworkEvents[Name]): Unsubscribe {
        return this.emitter.on(name, handler);
    }

    async createOfferAsync(): Promise<PairingCode> {
        this.assertIdle();
        this.setState('gathering');

        return this.runPairingStepAsync(async () => {
            const local = await this.gatherLocalAsync('offer', async connection => {
                const offer = await this.guardAsync(connection.createOffer());
                await this.guardAsync(connection.setLocalDescription(offer));
            });
            const code = this.encodeLocal({ kind: 'offer', local });
            this.offerTag = await this.guardAsync(deriveOfferTagAsync(local.fingerprint, local.iceUfrag));
            const expiryMs = this.settings.timeouts.codeExpiryMs;
            this.offerDeadline = this.environment.now() + expiryMs;
            this.expiryTimer = this.after(expiryMs, () => this.expireOffer());
            this.setState('awaiting-answer');

            return {
                code,
                url: buildCodeUrl(this.settings.appUrl, code),
                expiresAt: this.environment.wallClock() + expiryMs,
            };
        });
    }

    async acceptOfferAsync(codeOrUrl: string): Promise<AnswerCode> {
        this.assertIdle();
        const offer = this.decodeRemote(codeOrUrl, 'offer');
        this.assertFresh(offer);
        this.setState('answering');

        return this.runPairingStepAsync(async () => {
            const local = await this.gatherLocalAsync('answer', async connection => {
                await this.applyRemoteAsync(connection, offer, 'offer');
                const answer = await this.guardAsync(connection.createAnswer());
                await this.guardAsync(connection.setLocalDescription(answer));
            });
            const offerTag = await this.guardAsync(deriveOfferTagAsync(offer.fingerprint, offer.iceUfrag));
            const code = this.encodeLocal({ kind: 'answer', local, offerTag });
            this.prepareCheckCode(local.fingerprint, offer.fingerprint);

            // The offerer may take until its code expires to scan this answer, then connectMs to connect.
            const timeouts = this.settings.timeouts;
            this.startConnectTimer(timeouts.codeExpiryMs + timeouts.connectMs);
            this.setState('connecting');

            return { code, url: buildCodeUrl(this.settings.appUrl, code) };
        });
    }

    async acceptAnswerAsync(codeOrUrl: string): Promise<void> {
        // A throttled background tab may not have run the expiry timer yet.
        if (this.offerDeadline != null && this.environment.now() >= this.offerDeadline) {
            this.expireOffer({ isReportedByCaller: true });
        }

        if (this.isOfferExpired) {
            throw new NetworkError('code-expired', 'This code expired, show a new one');
        }

        if (this.isAnswerTaken) {
            throw new NetworkError('code-used', 'This code was already answered, show a new one');
        }

        this.assertOpen();
        const connection = this.peerConnection;
        const local = this.localDescription;
        if (this.linkState !== 'awaiting-answer' || connection == null || local == null) {
            throw new NetworkError('code-invalid', 'No offer is waiting for an answer');
        }

        const answer = this.decodeRemote(codeOrUrl, 'answer');
        if (answer.offerTag !== this.offerTag) {
            this.logger.warn('pair', 'answer for another code refused');
            throw new NetworkError('code-invalid', STRAY_ANSWER_MESSAGE);
        }

        if (answer.mid !== local.mid) {
            throw new NetworkError('code-invalid', 'This answer does not match the data section of this code');
        }

        // Taken before the first await, so a second answer scanned meanwhile gets code-used.
        this.isAnswerTaken = true;
        try {
            await this.applyRemoteAsync(connection, answer, 'answer');
        } catch (error) {
            // A refused answer leaves the offer waiting for another one.
            if (!this.hasEnded) {
                this.isAnswerTaken = false;
            }

            throw error;
        }

        this.cancel(this.expiryTimer);
        this.prepareCheckCode(local.fingerprint, answer.fingerprint);
        this.logger.info('pair', 'answer applied');
        this.startConnectTimer(this.settings.timeouts.connectMs);
        this.setState('connecting');

        await this.runPairingStepAsync(() => this.connected.promise);
    }

    send(channel: ChannelName, message: Message): void {
        const dataChannel = this.requireOpenChannel(channel);
        const json = JSON.stringify(message);
        const limit = Math.min(MAX_CONTROL_MESSAGE_BYTES, this.maxMessageSize);
        if (exceedsBytes(json, limit)) {
            throw new NetworkError('message-too-large', `A "${message.t}" message is over ${limit} bytes`);
        }

        this.transmit(dataChannel, json);
    }

    sendFrame(header: FrameHeader, payload: Uint8Array): void {
        validateFrameHeader(header);
        const dataChannel = this.requireOpenChannel(header.slot);
        const size = FRAME_HEADER_SIZE + payload.byteLength;
        const limit = Math.min(this.settings.chunkSize, this.maxMessageSize);
        if (size > limit) {
            throw new NetworkError('message-too-large', `A ${size}-byte frame is over ${limit} bytes`);
        }

        this.transmit(dataChannel, encodeFrame(header, payload));
    }

    async waitDrainedAsync(slot: SlotId): Promise<void> {
        const channel = this.requireOpenChannel(slot);
        if (channel.bufferedAmount <= this.slotShare(slot)) {
            return;
        }

        const waiter = createDeferred<void>();
        const waiters = this.drainWaiters.get(slot) ?? new Set<Deferred<void>>();
        waiters.add(waiter);
        this.drainWaiters.set(slot, waiters);
        channel.bufferedAmountLowThreshold = this.slotShare(slot);

        await waiter.promise;
    }

    bufferedAmount(channel: ChannelName): number {
        return this.channels.get(channel)?.bufferedAmount ?? 0;
    }

    async getStatsAsync(): Promise<CandidatePairStats[]> {
        const connection = this.peerConnection;
        if (connection == null || this.hasEnded) {
            return [];
        }

        const report = await connection.getStats();

        return mapCandidatePairStats(report.values() as Iterable<StatsRecord>);
    }

    configure(options: Partial<Omit<NetworkOptions, 'logger' | 'environment'>>): void {
        const previousPingMs = this.settings.timeouts.pingMs;
        const exposeLocalIps = 'exposeLocalIps' in options
            ? options.exposeLocalIps
            : this.settings.exposeLocalIps;
        this.settings = {
            chunkSize: options.chunkSize ?? this.settings.chunkSize,
            maxBuffered: options.maxBuffered ?? this.settings.maxBuffered,
            timeouts: { ...this.settings.timeouts, ...options.timeouts },
            appUrl: options.appUrl ?? this.settings.appUrl,
            ...(exposeLocalIps == null ? {} : { exposeLocalIps }),
        };
        this.monitor.configure(this.settings.timeouts);
        this.logger.debug('health', 'network settings applied', () => ({
            chunkSize: this.settings.chunkSize,
            maxBuffered: this.settings.maxBuffered,
            timeouts: this.settings.timeouts,
        }));

        if (this.pingTimer != null && this.settings.timeouts.pingMs !== previousPingMs) {
            this.stopRepeating(this.pingTimer);
            this.pingTimer = this.repeat(this.settings.timeouts.pingMs, () => this.sendPing());
        }

        for (const slot of SLOT_IDS) {
            this.releaseDrainWaiters(slot);
        }
    }

    close(reason = 'closed'): void {
        if (this.hasEnded) {
            return;
        }

        this.sendBye(reason);
        this.terminate({ state: 'closed', reason });
    }

    private assertOpen(): void {
        if (this.hasEnded) {
            throw new NetworkError('closed', 'This connection is closed; pair again');
        }
    }

    private assertIdle(): void {
        this.assertOpen();
        if (this.linkState !== 'idle') {
            throw new NetworkError('code-used', 'This connection already started pairing; pair with a new one');
        }
    }

    private assertFresh(offer: DecodedPairingCode): void {
        const ageMs = this.environment.wallClock() - offer.createdAt * 1000;
        if (ageMs <= this.settings.timeouts.codeExpiryMs + CLOCK_SKEW_MS) {
            return;
        }

        this.logger.warn('pair', 'offer code expired', { ageMs });
        throw new NetworkError('code-expired', 'This code expired, show a new one');
    }

    private decodeRemote(codeOrUrl: string, kind: CodeKind): DecodedPairingCode {
        const payload = decodePairingCode(codeOrUrl);
        if (payload.kind !== kind) {
            const message = kind === 'offer'
                ? 'This is a reply; scan it on the device that shows the offer'
                : 'This is an offer, not a reply';
            throw new NetworkError('code-invalid', message);
        }

        this.logger.info('pair', `${kind} code decoded`, {
            candidates: payload.candidates.length,
            ageMs: this.environment.wallClock() - payload.createdAt * 1000,
        });
        for (const candidate of payload.candidates) {
            this.logger.info('ice', `remote host udp ${candidate.address}:${candidate.port}`, candidate);
        }

        return payload;
    }

    private async runPairingStepAsync<Value>(stepAsync: () => Promise<Value>): Promise<Value> {
        this.pendingCalls++;
        try {
            return await this.guardAsync(stepAsync());
        } catch (error) {
            const networkError = toNetworkError(error);
            this.terminate({ state: 'closed', reason: networkError.message, error: networkError });

            throw networkError;
        } finally {
            this.pendingCalls--;
        }
    }

    // Every await in a pairing step goes through here, so close() stops the step at its next await.
    private async guardAsync<Value>(promise: Promise<Value>): Promise<Value> {
        promise.catch(() => undefined);

        return Promise.race([promise, this.termination.promise]);
    }

    private async gatherLocalAsync(
        kind: CodeKind,
        negotiateAsync: (connection: RTCPeerConnection) => Promise<void>,
    ): Promise<ParsedDescription> {
        const stopExposing = await this.exposeLocalIpsAsync();
        try {
            const connection = this.openPeerConnection();
            const endGathering = this.logger.span('pair', 'gathering');
            await negotiateAsync(connection);
            this.logger.info('pair', `${kind} created, gathering…`);

            const isComplete = await this.guardAsync(this.waitForGatheringAsync(connection));
            const description = parseSdp(connection.localDescription?.sdp ?? '');
            endGathering({ complete: isComplete, candidates: description?.candidates.length ?? 0 });
            if (!isComplete) {
                this.logger.warn('pair', `gathering capped at ${this.settings.timeouts.gatheringMs} ms`);
            }

            if (description == null) {
                const message = 'The browser made a description without ICE credentials or a fingerprint';
                throw new NetworkError('ice-failed', message);
            }

            return description;
        } finally {
            this.stopExposing(stopExposing);
        }
    }

    // NW-06, HS-05: the camera hook runs before gathering and its stop after; without it, .local names.
    private async exposeLocalIpsAsync(): Promise<(() => void) | null> {
        const hook = this.settings.exposeLocalIps;
        if (hook == null) {
            this.logger.info('pair', 'camera permission: not asked (.local names)');

            return null;
        }

        const pending = hook().catch((error: unknown) => {
            this.logger.warn('pair', 'camera hook failed', { error });

            return null;
        });
        try {
            const stop = await this.guardAsync(pending);
            const message = stop == null
                ? 'camera permission: denied or unavailable (.local names)'
                : 'camera permission: granted (real local IPs exposed)';
            this.logger.info('pair', message);

            return stop;
        } catch (error) {
            void pending.then(stop => this.stopExposing(stop));
            throw error;
        }
    }

    private stopExposing(stop: (() => void) | null): void {
        if (stop == null) {
            return;
        }

        try {
            stop();
            this.logger.debug('pair', 'camera released');
        } catch (error) {
            this.logger.warn('pair', 'camera release failed', { error });
        }
    }

    // HS-01: no ICE servers, and every channel exists before the offer or answer is made.
    private openPeerConnection(): RTCPeerConnection {
        const connection = this.environment.createPeerConnection({ iceServers: [] });
        this.peerConnection = connection;
        this.watchPeerConnection(connection);

        for (const spec of CHANNEL_SPECS) {
            const init: RTCDataChannelInit = { negotiated: true, id: spec.id, ordered: true };
            const channel = connection.createDataChannel(spec.label, init);
            channel.binaryType = 'arraybuffer';
            this.channels.set(spec.name, channel);
            this.watchChannel(spec, channel);
        }

        return connection;
    }

    // HS-02: one code with every candidate, so wait for the end of gathering, up to the cap.
    private waitForGatheringAsync(connection: RTCPeerConnection): Promise<boolean> {
        if (connection.iceGatheringState === 'complete') {
            return Promise.resolve(true);
        }

        return new Promise(resolve => {
            const stop = new AbortController();
            const finish = (isComplete: boolean): void => {
                stop.abort();
                this.cancel(timer);
                resolve(isComplete);
            };
            const onChange = (): void => {
                if (connection.iceGatheringState === 'complete') {
                    finish(true);
                }
            };
            const timer = this.after(this.settings.timeouts.gatheringMs, () => finish(false));
            connection.addEventListener('icegatheringstatechange', onChange, { signal: stop.signal });
            connection.addEventListener('icecandidate', onChange, { signal: stop.signal });
            this.listeners.signal.addEventListener('abort', () => stop.abort(), { signal: stop.signal });
        });
    }

    private encodeLocal({ kind, local, offerTag }: LocalCode): string {
        const candidates = selectCodeCandidates(local.candidates);
        if (candidates.length === 0) {
            const message = 'No local network address was found; check the Wi‑Fi connection';
            throw new NetworkError('gathering-timeout', message);
        }

        const code = encodePairingCode({
            ...local,
            kind,
            createdAt: Math.floor(this.environment.wallClock() / 1000),
            candidates,
            ...(offerTag == null ? {} : { offerTag }),
        });
        this.localDescription = local;
        this.logger.info('pair', `${kind} code ${codeByteLength(code)} B, ${code.length} chars`, {
            bytes: codeByteLength(code),
            chars: code.length,
            candidates: candidates.length,
        });

        return code;
    }

    private async applyRemoteAsync(
        connection: RTCPeerConnection,
        payload: DecodedPairingCode,
        type: RTCSdpType,
    ): Promise<void> {
        const sdp = buildSdp(payload, this.sessionId);
        this.logger.debug('pair', `${type} SDP rebuilt`, { lines: sdp.split('\r\n').length - 1 });
        try {
            await this.guardAsync(connection.setRemoteDescription({ type, sdp }));
        } catch (error) {
            if (error instanceof NetworkError) {
                throw error;
            }

            const message = `The browser refused the ${type} in this code`;
            throw new NetworkError('code-invalid', message, { cause: error });
        }

        this.watchTransports(connection);
    }

    private prepareCheckCode(localFingerprint: Uint8Array, remoteFingerprint: Uint8Array): void {
        const deriving = deriveCheckCodeAsync(localFingerprint, remoteFingerprint);
        this.checkCodePromise = deriving.catch((error: unknown) => {
            this.logger.warn('dtls', 'check code unavailable', { error });

            return undefined;
        });
        this.logger.debug('dtls', 'expecting the peer fingerprint', () => ({
            fingerprint: formatFingerprint(remoteFingerprint),
        }));
    }

    private startConnectTimer(ms: number): void {
        this.endConnectSpan = this.logger.span('pair', 'connect');
        this.connectTimer = this.after(ms, () => this.failConnecting(ms));
    }

    // HS-10: not connected in time; the log keeps the last state reached for the failure screen (DL-07).
    private failConnecting(ms: number): void {
        this.logger.error('pair', `not connected after ${ms} ms`, () => this.describeStates());
        void this.logCandidatePairsAsync();
        this.terminate({
            state: 'closed',
            reason: 'connect timeout',
            error: new NetworkError('connect-timeout', `The devices did not connect within ${ms / 1000} s`),
        });
    }

    // HS-08: an unanswered offer expires; a later answer gets code-expired.
    private expireOffer(options: { isReportedByCaller: boolean } = { isReportedByCaller: false }): void {
        if (this.linkState !== 'awaiting-answer' || this.isAnswerTaken) {
            return;
        }

        this.isOfferExpired = true;
        this.logger.info('pair', 'offer code expired');
        this.terminate({
            state: 'closed',
            reason: 'offer expired',
            error: new NetworkError('code-expired', 'This code expired, show a new one'),
            isReportedByCaller: options.isReportedByCaller,
        });
    }

    private watchPeerConnection(connection: RTCPeerConnection): void {
        const signal = this.listeners.signal;
        const onCandidate = (event: RTCPeerConnectionIceEvent): void => this.logLocalCandidate(event.candidate);
        connection.addEventListener('icecandidate', onCandidate, { signal });
        connection.addEventListener('icegatheringstatechange', () => {
            this.logger.info('ice', `iceGatheringState ${connection.iceGatheringState}`);
        }, { signal });
        connection.addEventListener('iceconnectionstatechange', () => {
            this.logger.info('ice', `iceConnectionState ${connection.iceConnectionState}`);
            if (connection.iceConnectionState === 'failed') {
                this.onTransportFailed('ICE failed');
            }
        }, { signal });
        connection.addEventListener('connectionstatechange', () => {
            const state = connection.connectionState;
            this.logger.info('ice', `connectionState ${state}`);
            this.monitor.setConnectionState(state);
            if (state === 'failed' || state === 'closed') {
                this.onTransportFailed(`connection ${state}`);
            }
        }, { signal });
        connection.addEventListener('signalingstatechange', () => {
            this.logger.debug('pair', `signalingState ${connection.signalingState}`);
        }, { signal });
    }

    private logLocalCandidate(candidate: RTCIceCandidate | null): void {
        const parsed = candidate?.candidate ? parseCandidate(candidate.candidate) : undefined;
        if (parsed == null) {
            return;
        }

        this.logger.debug('ice', `local ${parsed.type} ${parsed.protocol} ${parsed.address}:${parsed.port}`, {
            type: parsed.type,
            protocol: parsed.protocol,
            address: parsed.address,
            port: parsed.port,
        });
    }

    private watchTransports(connection: RTCPeerConnection): void {
        const signal = this.listeners.signal;
        const sctp = connection.sctp;
        const dtls = sctp?.transport;
        sctp?.addEventListener('statechange', () => {
            this.logger.info('dtls', `SCTP ${sctp.state}`, { maxMessageSize: sctp.maxMessageSize });
        }, { signal });
        dtls?.addEventListener('statechange', () => {
            if (dtls.state === 'connected') {
                this.logger.info('dtls', 'DTLS connected; fingerprint verified');
                return;
            }

            if (dtls.state === 'failed') {
                this.logger.error('dtls', 'DTLS failed: fingerprint mismatch or handshake error');
                return;
            }

            this.logger.info('dtls', `DTLS ${dtls.state}`);
        }, { signal });
    }

    private watchChannel(spec: ChannelSpec, channel: RTCDataChannel): void {
        const signal = this.listeners.signal;
        channel.addEventListener('open', () => {
            this.logger.debug('dtls', `channel open ${spec.label} (${spec.id})`);
            this.onChannelOpen();
        }, { signal });
        channel.addEventListener('close', () => {
            this.logger.info('dtls', `channel closed ${spec.label} (${spec.id})`);
            this.onChannelClosed(spec);
        }, { signal });
        channel.addEventListener('error', event => {
            const error = (event as RTCErrorEvent).error as unknown;
            this.logger.warn('dtls', `channel error ${spec.label} (${spec.id})`, { error });
        }, { signal });
        channel.addEventListener('message', event => this.onChannelMessage(spec, event.data), { signal });

        const slot = spec.name;
        if (slot !== 'control') {
            channel.addEventListener('bufferedamountlow', () => this.releaseDrainWaiters(slot), { signal });
        }
    }

    private onChannelOpen(): void {
        const channels = [...this.channels.values()];
        const isAllOpen = channels.length === CHANNEL_SPECS.length
            && channels.every(channel => channel.readyState === 'open');
        if (!isAllOpen) {
            return;
        }

        this.logger.info('dtls', `channels open: ${CHANNEL_SPECS.map(spec => spec.label).join(', ')}`);
        void this.completeConnectionAsync();
    }

    private async completeConnectionAsync(): Promise<void> {
        if (this.linkState !== 'connecting') {
            return;
        }

        const pending = this.checkCodePromise ?? Promise.resolve(undefined);
        const checkCode = await this.guardAsync(pending).catch(() => undefined);
        if (this.hasEnded || this.linkState !== 'connecting') {
            return;
        }

        this.cancel(this.connectTimer);
        this.checkCodeValue = checkCode;
        this.endConnectSpan?.({ maxMessageSize: this.maxMessageSize });
        this.logger.info('dtls', `connected; sctp maxMessageSize ${this.maxMessageSize}`, {
            maxMessageSize: this.maxMessageSize,
            checkCode,
        });
        this.monitor.start();
        this.lastHealth = this.monitor.evaluate();
        this.setState('connected');
        this.emitter.emit('health', this.lastHealth);
        this.startHealth();
        this.connected.resolve();
        void this.logCandidatePairsAsync();
    }

    private onChannelClosed(spec: ChannelSpec): void {
        if (this.hasEnded) {
            return;
        }

        if (this.linkState === 'connected') {
            this.terminate({ state: 'lost', reason: `channel ${spec.label} closed without bye` });
            return;
        }

        this.terminate({
            state: 'closed',
            reason: `channel ${spec.label} closed`,
            error: new NetworkError('channel-closed', `Channel ${spec.label} closed while connecting`),
        });
    }

    // HC-03: failed or closed means lost; before connecting it is an ICE failure.
    private onTransportFailed(reason: string): void {
        if (this.hasEnded) {
            return;
        }

        if (this.linkState === 'connected') {
            this.refreshHealth();
            this.terminate({ state: 'lost', reason });
            return;
        }

        this.logger.error('pair', `pairing failed: ${reason}`, () => this.describeStates());
        void this.logCandidatePairsAsync();
        this.terminate({
            state: 'closed',
            reason,
            error: new NetworkError('ice-failed', 'The devices could not reach each other'),
        });
    }

    private onChannelMessage(spec: ChannelSpec, data: unknown): void {
        if (this.hasEnded) {
            return;
        }

        // HC-01: any message is proof of life.
        this.monitor.received();

        if (typeof data === 'string') {
            this.receiveText(spec, data);
            return;
        }

        if (data instanceof ArrayBuffer) {
            this.receiveBinary(spec, data);
            return;
        }

        this.drop(spec, 'not text or an ArrayBuffer');
    }

    // NW-03: JSON over 64 KiB, unparsable, or without a string `t` is dropped and logged.
    private receiveText(spec: ChannelSpec, text: string): void {
        if (exceedsBytes(text, MAX_CONTROL_MESSAGE_BYTES)) {
            this.drop(spec, 'JSON over 64 KiB');
            return;
        }

        const message = parseMessage(text);
        if (message == null) {
            this.drop(spec, 'not JSON with a string t');
            return;
        }

        const handler = this.internalHandlers[message.t];
        if (handler != null) {
            handler(message);
            return;
        }

        this.emitter.emit('message', spec.name, message);
    }

    private receiveBinary(spec: ChannelSpec, data: ArrayBuffer): void {
        if (spec.name === 'control') {
            this.drop(spec, 'binary data on control');
            return;
        }

        const frame = decodeFrame(data);
        if (frame == null) {
            this.drop(spec, 'malformed frame');
            return;
        }

        if (frame.header.slot !== spec.name) {
            this.drop(spec, `frame for slot ${frame.header.slot}`);
            return;
        }

        this.emitter.emit('frame', frame.header, frame.payload);
    }

    private drop(spec: ChannelSpec, reason: string): void {
        this.droppedCount++;
        if (this.logger.every(`${this.logKey}.drop`, DROP_LOG_MS)) {
            const dropped = this.droppedCount;
            this.logger.warn('dtls', `dropped a message on ${spec.label}: ${reason}`, { dropped });
        }
    }

    private onPing(message: Message): void {
        if (typeof message.seq !== 'number' || typeof message.ts !== 'number') {
            return;
        }

        this.trySend({ t: 'pong', seq: message.seq, ts: message.ts });
    }

    private onPong(message: Message): void {
        const sentAt = message.ts;
        if (typeof sentAt !== 'number') {
            return;
        }

        const rttMs = this.environment.now() - sentAt;
        if (!Number.isFinite(rttMs) || rttMs < 0) {
            return;
        }

        this.monitor.recordRtt(rttMs);
        if (this.logger.every(`${this.logKey}.rtt`, RTT_LOG_MS)) {
            this.logger.info('health', `rtt ${Math.round(rttMs)} ms`, { rttMs: Math.round(rttMs) });
        }

        this.refreshHealth();
    }

    private onPeerVisibility(message: Message): void {
        if (typeof message.hidden !== 'boolean') {
            return;
        }

        this.monitor.setPeerHidden(message.hidden);
        this.logger.info('health', message.hidden ? 'peer page hidden' : 'peer page visible');
        this.refreshHealth();
    }

    private onBye(message: Message): void {
        const reason = typeof message.reason === 'string' ? message.reason.slice(0, 100) : 'bye';
        this.logger.info('health', 'bye received', { reason });
        this.terminate({ state: 'closed', reason: 'peer said bye' });
    }

    private onOwnVisibility(hidden: boolean): void {
        this.logger.info('health', hidden ? 'page hidden' : 'page visible');
        this.trySend({ t: 'vis', hidden });
    }

    private startHealth(): void {
        const timeouts = this.settings.timeouts;
        this.pingTimer = this.repeat(timeouts.pingMs, () => this.sendPing());
        this.repeat(HEALTH_CHECK_MS, () => this.checkHealth());
        this.unsubscribes.push(this.environment.onVisibilityChange(hidden => this.onOwnVisibility(hidden)));
        if (this.environment.isHidden()) {
            this.onOwnVisibility(true);
        }
    }

    private sendPing(): void {
        this.pingSequence++;
        this.trySend({ t: 'ping', seq: this.pingSequence, ts: this.environment.now() });
    }

    private checkHealth(): void {
        const health = this.refreshHealth();
        if (health.status === 'lost') {
            this.sendBye('lost');
            this.terminate({ state: 'lost', reason: `nothing from the peer for ${health.lastSeenMs} ms` });
            return;
        }

        for (const slot of SLOT_IDS) {
            this.releaseDrainWaiters(slot);
        }
    }

    private refreshHealth(): Health {
        const previous = this.lastHealth;
        const health = this.monitor.evaluate();
        this.lastHealth = health;

        if (health.status !== previous.status) {
            const level = health.status === 'good' ? 'info' : 'warn';
            const lastSeenMs = health.lastSeenMs;
            this.logger[level]('health', `${previous.status} → ${health.status}`, { lastSeenMs });
        }

        if (
            health.status !== previous.status
            || health.peerHidden !== previous.peerHidden
            || health.rttMs !== previous.rttMs
        ) {
            this.emitter.emit('health', health);
        }

        return health;
    }

    private sendBye(reason: string): void {
        const control = this.channels.get('control');
        if (control?.readyState !== 'open') {
            return;
        }

        this.trySend({ t: 'bye', reason });
        this.logger.info('health', 'bye sent', { reason });
    }

    // Internal control messages are best effort: a missed ping is what health is for.
    private trySend(message: Message): void {
        try {
            this.send('control', message);
        } catch (error) {
            this.logger.debug('health', `could not send ${message.t}`, { error });
        }
    }

    private requireOpenChannel(name: ChannelName): RTCDataChannel {
        const channel = this.channels.get(name);
        if (this.hasEnded || channel == null || channel.readyState !== 'open') {
            throw new NetworkError('channel-closed', `Channel ${labelOf(name)} is not open`);
        }

        return channel;
    }

    private transmit(channel: RTCDataChannel, data: string | Uint8Array<ArrayBuffer>): void {
        try {
            if (typeof data === 'string') {
                channel.send(data);
                return;
            }

            channel.send(data);
        } catch (error) {
            throw new NetworkError('send-failed', `Sending on ${channel.label} failed`, { cause: error });
        }
    }

    // TR-04: maxBuffered is shared by the slots that have bytes queued or a sender waiting.
    private slotShare(slot: SlotId): number {
        const active = SLOT_IDS.filter(id => id === slot
            || (this.channels.get(id)?.bufferedAmount ?? 0) > 0
            || (this.drainWaiters.get(id)?.size ?? 0) > 0);

        return Math.floor(this.settings.maxBuffered / active.length);
    }

    private releaseDrainWaiters(slot: SlotId): void {
        const waiters = this.drainWaiters.get(slot);
        const channel = this.channels.get(slot);
        if (waiters == null || waiters.size === 0 || channel == null) {
            return;
        }

        const share = this.slotShare(slot);
        if (channel.bufferedAmount > share) {
            channel.bufferedAmountLowThreshold = share;
            return;
        }

        for (const waiter of waiters) {
            waiter.resolve();
        }

        waiters.clear();
    }

    private async logCandidatePairsAsync(): Promise<void> {
        try {
            const pairs = await this.getStatsAsync();
            for (const pair of pairs) {
                this.logCandidatePair(pair);
            }
        } catch (error) {
            this.logger.debug('pairs', 'stats unavailable', { error });
        }
    }

    private logCandidatePair(pair: CandidatePairStats): void {
        for (const [side, candidate] of [['local', pair.local], ['remote', pair.remote]] as const) {
            if (candidate.type === 'prflx') {
                this.logger.info('ice', `peer-reflexive ${side} ${candidate.address}:${candidate.port}`);
            }
        }

        const details = [
            pair.state,
            ...(pair.nominated ? ['nominated'] : []),
            ...(pair.rttMs == null ? [] : [`rtt ${pair.rttMs} ms`]),
            ...(pair.selected ? ['selected'] : []),
        ].join(', ');
        const text = `${formatEndpoint(pair.local)} ↔ ${formatEndpoint(pair.remote)} ${details}`;
        const level = pair.selected ? 'info' : 'debug';
        this.logger[level]('pairs', text, pair);
    }

    private describeStates(): Record<string, unknown> {
        const connection = this.peerConnection;

        return {
            linkState: this.linkState,
            signalingState: connection?.signalingState,
            iceGatheringState: connection?.iceGatheringState,
            iceConnectionState: connection?.iceConnectionState,
            connectionState: connection?.connectionState,
            dtlsState: connection?.sctp?.transport?.state,
            sctpState: connection?.sctp?.state,
            openChannels: [...this.channels.values()].filter(channel => channel.readyState === 'open').length,
        };
    }

    private setState(state: LinkState): void {
        if (this.linkState === state) {
            return;
        }

        this.logger.debug('pair', `link ${this.linkState} → ${state}`);
        this.linkState = state;
        this.emitter.emit('state', state);
    }

    // NW-07: stops every timer and listener, releases the browser objects, and leaves the instance unusable.
    private terminate(termination: Termination): void {
        if (this.hasEnded) {
            return;
        }

        this.hasEnded = true;
        const wasConnected = this.linkState === 'connected';

        for (const handle of this.timeoutHandles) {
            this.environment.clearTimeout(handle);
        }

        for (const handle of this.intervalHandles) {
            this.environment.clearInterval(handle);
        }

        this.timeoutHandles.clear();
        this.intervalHandles.clear();
        for (const unsubscribe of this.unsubscribes.splice(0)) {
            unsubscribe();
        }

        this.listeners.abort();
        const closedError = new NetworkError('closed', `The connection closed: ${termination.reason}`);
        this.termination.reject(termination.error ?? closedError);
        this.rejectDrainWaiters();
        this.releaseConnection();

        const level = termination.state === 'lost' || termination.error != null ? 'warn' : 'info';
        this.logger[level]('pair', `link ${termination.state}: ${termination.reason}`, termination.error);

        if (wasConnected && this.lastHealth.status !== 'lost') {
            this.lastHealth = { ...this.lastHealth, status: 'lost' };
            this.emitter.emit('health', this.lastHealth);
        }

        // A failure that a pending call rejects with is not emitted again.
        if (termination.error != null && this.pendingCalls === 0 && termination.isReportedByCaller !== true) {
            this.emitter.emit('error', termination.error);
        }

        this.setState(termination.state);
        this.emitter.clear();
    }

    private rejectDrainWaiters(): void {
        for (const [slot, waiters] of this.drainWaiters) {
            for (const waiter of waiters) {
                waiter.reject(new NetworkError('channel-closed', `Channel ${labelOf(slot)} closed`));
            }

            waiters.clear();
        }
    }

    private releaseConnection(): void {
        for (const channel of this.channels.values()) {
            try {
                channel.close();
            } catch {
                // Already closed.
            }
        }

        try {
            this.peerConnection?.close();
        } catch {
            // Already closed.
        }
    }

    private after(ms: number, handler: () => void): unknown {
        const handle = this.environment.setTimeout(() => {
            this.timeoutHandles.delete(handle);
            handler();
        }, ms);
        this.timeoutHandles.add(handle);

        return handle;
    }

    private cancel(handle: unknown): void {
        if (handle == null) {
            return;
        }

        this.environment.clearTimeout(handle);
        this.timeoutHandles.delete(handle);
    }

    private repeat(ms: number, handler: () => void): unknown {
        const handle = this.environment.setInterval(handler, ms);
        this.intervalHandles.add(handle);

        return handle;
    }

    private stopRepeating(handle: unknown): void {
        this.environment.clearInterval(handle);
        this.intervalHandles.delete(handle);
    }
}

function createDeferred<Value>(): Deferred<Value> {
    const handlers: { resolve?: (value: Value) => void; reject?: (error: unknown) => void } = {};
    const promise = new Promise<Value>((resolve, reject) => {
        handlers.resolve = resolve;
        handlers.reject = reject;
    });

    return {
        promise,
        resolve: value => handlers.resolve?.(value),
        reject: error => handlers.reject?.(error),
    };
}

function toNetworkError(error: unknown): NetworkError {
    if (error instanceof NetworkError) {
        return error;
    }

    const message = error instanceof Error ? error.message : String(error);

    return new NetworkError('ice-failed', `WebRTC failed: ${message}`, { cause: error });
}

function parseMessage(text: string): Message | undefined {
    try {
        const value = JSON.parse(text) as unknown;
        if (value == null || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }

        return typeof (value as { t?: unknown }).t === 'string' ? (value as Message) : undefined;
    } catch {
        return undefined;
    }
}

const textEncoder = new TextEncoder();

// UTF-8 takes 1–3 bytes per UTF-16 unit, so most texts are decided without encoding them.
function exceedsBytes(text: string, limit: number): boolean {
    if (text.length > limit) {
        return true;
    }

    if (text.length * 3 <= limit) {
        return false;
    }

    return textEncoder.encode(text).byteLength > limit;
}

// Chrome leaves the address out of the stats of a candidate it hides behind a .local name.
function formatEndpoint(candidate: CandidateInfo): string {
    const address = candidate.address === '' ? '(hidden)' : candidate.address;

    return `${candidate.type} ${address}:${candidate.port}`;
}

function labelOf(name: ChannelName): string {
    return name === 'control' ? 'control' : `slot${name}`;
}
