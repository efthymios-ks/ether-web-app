import type { StatsRecord } from './candidateStats.js';
import type { NetworkEnvironment } from './networkTypes.js';
import { formatFingerprint } from './sdp.js';
import type { HostCandidate, SetupRole } from './sdp.js';

// Test doubles for the network: a controllable clock, RTCPeerConnection and RTCDataChannel.
// Messages between linked fakes arrive in a microtask, as they would from another thread.

export const FAKE_WALL_START = 1_795_000_000_000;

export interface FakeProfile {
    readonly iceUfrag: string;
    readonly icePwd: string;
    readonly fingerprint: Uint8Array;
    readonly mid: string;
    readonly candidates: readonly HostCandidate[];
}

export type FakeGathering = 'complete' | 'hang';

interface FakeTimer {
    at: number;
    readonly handler: () => void;
    readonly every?: number;
}

export class FakeClock {
    time = 0;
    private nextId = 1;
    private readonly timers = new Map<number, FakeTimer>();

    readonly now = (): number => this.time;

    setTimeout(handler: () => void, ms: number): number {
        return this.add({ at: this.time + ms, handler });
    }

    setInterval(handler: () => void, ms: number): number {
        return this.add({ at: this.time + ms, handler, every: ms });
    }

    clear(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    has(handle: unknown): boolean {
        return this.timers.has(handle as number);
    }

    // Runs every timer that falls due, in time order, including intervals that repeat within the span.
    advance(ms: number): void {
        const end = this.time + ms;
        for (let next = this.nextDue(end); next != null; next = this.nextDue(end)) {
            const [id, timer] = next;
            this.time = timer.at;
            if (timer.every == null) {
                this.timers.delete(id);
            } else {
                timer.at += timer.every;
            }

            timer.handler();
        }

        this.time = end;
    }

    private add(timer: FakeTimer): number {
        const id = this.nextId++;
        this.timers.set(id, timer);

        return id;
    }

    private nextDue(end: number): [number, FakeTimer] | undefined {
        return [...this.timers.entries()]
            .filter(([, timer]) => timer.at <= end)
            .sort((first, second) => first[1].at - second[1].at)[0];
    }
}

// Counts listeners, honouring `signal`, so tests can check that close() removes them all (NW-07).
class CountingTarget extends EventTarget {
    private readonly active = new Set<object>();

    get listenerCount(): number {
        return this.active.size;
    }

    override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean,
    ): void {
        super.addEventListener(type, listener, options);
        if (listener == null) {
            return;
        }

        const key = { type, listener };
        this.active.add(key);
        const signal = typeof options === 'object' ? options.signal : undefined;
        signal?.addEventListener('abort', () => this.active.delete(key), { once: true });
    }

    override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean,
    ): void {
        super.removeEventListener(type, listener, options);
        for (const key of this.active) {
            const entry = key as { type: string; listener: unknown };
            if (entry.type === type && entry.listener === listener) {
                this.active.delete(key);
            }
        }
    }
}

export class FakeDataChannel extends CountingTarget {
    readyState: RTCDataChannelState = 'connecting';
    binaryType: BinaryType = 'blob';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    peer?: FakeDataChannel;
    // Keeps sent bytes counted in bufferedAmount until drain() is called.
    holdsBuffer = false;
    failsSend = false;
    readonly sent: (string | Uint8Array)[] = [];

    constructor(
        readonly label: string,
        readonly id: number,
        readonly negotiated: boolean,
        readonly ordered: boolean,
    ) {
        super();
    }

    send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
        if (this.readyState !== 'open') {
            throw new DOMException('The channel is not open', 'InvalidStateError');
        }

        if (this.failsSend) {
            throw new DOMException('The send queue is full', 'OperationError');
        }

        const copy = typeof data === 'string' ? data : copyBytes(data);
        this.sent.push(copy);
        if (this.holdsBuffer) {
            this.bufferedAmount += typeof copy === 'string' ? copy.length : copy.byteLength;
        }

        const peer = this.peer;
        queueMicrotask(() => peer?.receive(copy));
    }

    receive(data: string | Uint8Array): void {
        if (this.readyState !== 'open') {
            return;
        }

        const payload = typeof data === 'string' ? data : data.slice().buffer;
        this.dispatchEvent(new MessageEvent('message', { data: payload }));
    }

    open(): void {
        this.readyState = 'open';
        this.dispatchEvent(new Event('open'));
    }

    close(): void {
        if (this.readyState === 'closed') {
            return;
        }

        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
        const peer = this.peer;
        queueMicrotask(() => peer?.closeFromPeer());
    }

    closeFromPeer(): void {
        if (this.readyState === 'closed') {
            return;
        }

        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
    }

    drain(remaining = 0): void {
        this.bufferedAmount = remaining;
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
            this.dispatchEvent(new Event('bufferedamountlow'));
        }
    }
}

export class FakeDtlsTransport extends CountingTarget {
    state: RTCDtlsTransportState = 'new';
}

export class FakeSctpTransport extends CountingTarget {
    state: RTCSctpTransportState = 'connecting';
    readonly transport = new FakeDtlsTransport();

    constructor(readonly maxMessageSize: number) {
        super();
    }
}

export class FakePeerConnection extends CountingTarget {
    readonly calls: string[] = [];
    readonly channels: FakeDataChannel[] = [];
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    iceGatheringState: RTCIceGatheringState = 'new';
    iceConnectionState: RTCIceConnectionState = 'new';
    connectionState: RTCPeerConnectionState = 'new';
    signalingState: RTCSignalingState = 'stable';
    sctp: FakeSctpTransport | null = null;
    statsRecords: StatsRecord[] = [];
    refusesRemote = false;

    constructor(
        readonly configuration: RTCConfiguration,
        readonly profile: FakeProfile,
        readonly gathering: FakeGathering,
    ) {
        super();
    }

    createDataChannel(label: string, init: RTCDataChannelInit = {}): FakeDataChannel {
        this.calls.push(`createDataChannel ${label} ${init.id}`);
        const isNegotiated = init.negotiated === true;
        const channel = new FakeDataChannel(label, init.id ?? -1, isNegotiated, init.ordered !== false);
        this.channels.push(channel);

        return channel;
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
        this.calls.push('createOffer');

        return { type: 'offer', sdp: buildFakeSdp(this.profile, 'actpass', []) };
    }

    async createAnswer(): Promise<RTCSessionDescriptionInit> {
        this.calls.push('createAnswer');

        return { type: 'answer', sdp: buildFakeSdp(this.profile, 'active', []) };
    }

    async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.calls.push('setLocalDescription');
        this.localDescription = description;
        this.setSignalingState(description.type === 'offer' ? 'have-local-offer' : 'stable');
        this.iceGatheringState = 'gathering';
        this.dispatchEvent(new Event('icegatheringstatechange'));
        queueMicrotask(() => this.gather(description));
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.calls.push('setRemoteDescription');
        if (this.refusesRemote) {
            throw new DOMException('Failed to parse SessionDescription', 'OperationError');
        }

        this.remoteDescription = description;
        this.setSignalingState(description.type === 'offer' ? 'have-remote-offer' : 'stable');
        this.sctp = new FakeSctpTransport(262144);
    }

    async getStats(): Promise<Map<string, StatsRecord>> {
        return new Map(this.statsRecords.map(record => [record.id, record]));
    }

    close(): void {
        this.calls.push('close');
        this.connectionState = 'closed';
        this.signalingState = 'closed';
        for (const channel of this.channels) {
            channel.readyState = 'closed';
            const peer = channel.peer;
            queueMicrotask(() => peer?.closeFromPeer());
        }
    }

    setConnectionState(state: RTCPeerConnectionState): void {
        this.connectionState = state;
        this.dispatchEvent(new Event('connectionstatechange'));
    }

    private gather(description: RTCSessionDescriptionInit): void {
        const setup = description.type === 'offer' ? 'actpass' : 'active';
        this.profile.candidates.forEach((candidate, index) => {
            const event = Object.assign(new Event('icecandidate'), {
                candidate: { candidate: candidateLine(candidate, index).slice('a='.length) },
            });
            this.dispatchEvent(event);
        });
        const sdp = buildFakeSdp(this.profile, setup, this.profile.candidates);
        this.localDescription = { type: description.type, sdp };
        if (this.gathering === 'hang') {
            return;
        }

        this.iceGatheringState = 'complete';
        this.dispatchEvent(new Event('icegatheringstatechange'));
        this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }));
    }

    private setSignalingState(state: RTCSignalingState): void {
        this.signalingState = state;
        this.dispatchEvent(new Event('signalingstatechange'));
    }
}

// Links the channels of two fakes by id and opens them, as ICE, DTLS and SCTP would.
export function connectFakePeers(first: FakePeerConnection, second: FakePeerConnection): void {
    for (const channel of first.channels) {
        const match = second.channels.find(candidate => candidate.id === channel.id);
        channel.peer = match;
        if (match != null) {
            match.peer = channel;
        }
    }

    for (const connection of [first, second]) {
        connection.setConnectionState('connected');
        for (const channel of connection.channels) {
            channel.open();
        }
    }
}

export interface FakeEnvironment {
    readonly environment: NetworkEnvironment;
    readonly clock: FakeClock;
    readonly peerConnections: FakePeerConnection[];
    readonly subscriptionCount: number;
    readonly pendingTimerCount: number;
    setHidden(hidden: boolean): void;
    pageHide(): void;
}

export interface FakeEnvironmentOptions {
    readonly clock: FakeClock;
    readonly profile: FakeProfile;
    readonly gathering?: FakeGathering;
}

export function createFakeEnvironment(options: FakeEnvironmentOptions): FakeEnvironment {
    const { clock, profile } = options;
    const peerConnections: FakePeerConnection[] = [];
    const visibilityHandlers = new Set<(hidden: boolean) => void>();
    const pageHideHandlers = new Set<() => void>();
    const handles = new Set<unknown>();
    const visibility = { hidden: false };

    const track = (handle: number): number => {
        handles.add(handle);

        return handle;
    };

    const environment: NetworkEnvironment = {
        createPeerConnection: configuration => {
            const gathering = options.gathering ?? 'complete';
            const connection = new FakePeerConnection(configuration, profile, gathering);
            peerConnections.push(connection);

            return connection as unknown as RTCPeerConnection;
        },
        now: clock.now,
        wallClock: () => FAKE_WALL_START + clock.time,
        setTimeout: (handler, ms) => track(clock.setTimeout(handler, ms)),
        clearTimeout: handle => clock.clear(handle),
        setInterval: (handler, ms) => track(clock.setInterval(handler, ms)),
        clearInterval: handle => clock.clear(handle),
        onVisibilityChange: handler => {
            visibilityHandlers.add(handler);

            return () => visibilityHandlers.delete(handler);
        },
        isHidden: () => visibility.hidden,
        onPageHide: handler => {
            pageHideHandlers.add(handler);

            return () => pageHideHandlers.delete(handler);
        },
        randomBytes: length => Uint8Array.from({ length }, (_, index) => index + 1),
    };

    return {
        environment,
        clock,
        peerConnections,
        get subscriptionCount() {
            return visibilityHandlers.size + pageHideHandlers.size;
        },
        get pendingTimerCount() {
            return [...handles].filter(handle => clock.has(handle)).length;
        },
        setHidden: hidden => {
            visibility.hidden = hidden;
            for (const handler of [...visibilityHandlers]) {
                handler(hidden);
            }
        },
        pageHide: () => {
            for (const handler of [...pageHideHandlers]) {
                handler();
            }
        },
    };
}

// A Chrome-shaped description, with the extra lines a real browser writes.
export function buildFakeSdp(
    profile: FakeProfile,
    setup: SetupRole,
    candidates: readonly HostCandidate[],
): string {
    const lines = [
        'v=0',
        'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        `a=group:BUNDLE ${profile.mid}`,
        'a=extmap-allow-mixed',
        'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        ...candidates.map((candidate, index) => candidateLine(candidate, index)),
        `a=ice-ufrag:${profile.iceUfrag}`,
        `a=ice-pwd:${profile.icePwd}`,
        'a=ice-options:trickle',
        `a=fingerprint:sha-256 ${formatFingerprint(profile.fingerprint)}`,
        `a=setup:${setup}`,
        `a=mid:${profile.mid}`,
        'a=sctp-port:5000',
        'a=max-message-size:262144',
    ];

    return `${lines.join('\r\n')}\r\n`;
}

function candidateLine(candidate: HostCandidate, index: number): string {
    const priority = 2122260223 - index * 65536;

    const endpoint = `${candidate.address} ${candidate.port}`;

    return `a=candidate:${1000 + index} 1 udp ${priority} ${endpoint} typ host generation 0 network-id ${index + 1}`;
}

function copyBytes(data: ArrayBuffer | ArrayBufferView | Blob): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data.slice(0));
    }

    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }

    throw new TypeError('The fake channel does not send Blobs');
}
