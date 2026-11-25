import { FAKE_WALL_START } from '../network/fakeEnvironment.js';
import type { FakeClock } from '../network/fakeEnvironment.js';
import type { DiscoveryEnvironment } from './discovery.js';
import type { FakeRelayNetwork } from './fakeRelay.js';
import type { SessionStore } from './tabIdentity.js';

// Test doubles for discovery: STUN servers that answer with a chosen public address, session storage that
// survives a "reload" or refuses access, and an environment on a shared fake clock with controllable online,
// pagehide, pageshow and visibility events.

// An address answers; 'silent' finishes gathering without one; 'hang' never finishes.
export type FakeStunAnswer = string | 'silent' | 'hang';

export class FakeStunPeerConnection extends EventTarget {
    iceGatheringState: RTCIceGatheringState = 'new';
    isClosed = false;
    readonly channels: string[] = [];

    constructor(readonly server: string, private readonly answer: FakeStunAnswer) {
        super();
    }

    createDataChannel(label: string): object {
        this.channels.push(label);

        return {};
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: 'offer', sdp: 'v=0\r\n' };
    }

    async setLocalDescription(): Promise<void> {
        this.iceGatheringState = 'gathering';
        queueMicrotask(() => this.gather());
    }

    close(): void {
        this.isClosed = true;
    }

    private gather(): void {
        if (this.isClosed) {
            return;
        }

        this.emitCandidate('candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0');
        if (this.answer === 'hang') {
            return;
        }

        if (this.answer !== 'silent') {
            this.emitCandidate(`candidate:2 1 udp 1686052607 ${this.answer} 50001 typ srflx raddr 0.0.0.0 rport 0`);
        }

        this.iceGatheringState = 'complete';
        this.dispatchEvent(new Event('icegatheringstatechange'));
        this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }));
    }

    private emitCandidate(line: string): void {
        this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { candidate: line } }));
    }
}

// Every server gives `address` unless `answers` says otherwise for it.
export class FakeStun {
    address: FakeStunAnswer;
    readonly answers = new Map<string, FakeStunAnswer>();
    readonly connections: FakeStunPeerConnection[] = [];
    readonly configurations: RTCConfiguration[] = [];
    throwsOnCreate = false;

    constructor(address: FakeStunAnswer) {
        this.address = address;
    }

    readonly createPeerConnection = (configuration: RTCConfiguration): RTCPeerConnection => {
        if (this.throwsOnCreate) {
            throw new DOMException('Blocked', 'NotAllowedError');
        }

        this.configurations.push(configuration);
        const urls = configuration.iceServers?.[0]?.urls;
        const server = typeof urls === 'string' ? urls : String(urls?.[0] ?? '');
        const connection = new FakeStunPeerConnection(server, this.answers.get(server) ?? this.address);
        this.connections.push(connection);

        return connection as unknown as RTCPeerConnection;
    };
}

// One tab's sessionStorage: pass the same one to a second discovery to reload the page in that tab.
export class FakeSessionStore implements SessionStore {
    readonly values = new Map<string, string>();
    isBlocked = false;

    read(key: string): string | null {
        if (this.isBlocked) {
            throw new DOMException('The operation is insecure.', 'SecurityError');
        }

        return this.values.get(key) ?? null;
    }

    write(key: string, value: string): void {
        if (this.isBlocked) {
            throw new DOMException('The operation is insecure.', 'SecurityError');
        }

        this.values.set(key, value);
    }
}

export interface FakeDiscoveryEnvironment {
    readonly environment: DiscoveryEnvironment;
    // The status checks asked for, by URL.
    readonly fetches: string[];
    // Answers the status checks; 200 {"status":"ok"} until a test replaces it.
    respondAsync: (url: string) => Promise<Response>;
    setOnline(isOnline: boolean): void;
    pageHide(): void;
    pageShow(): void;
    setHidden(isHidden: boolean): void;
}

export interface FakeDiscoveryEnvironmentOptions {
    readonly clock: FakeClock;
    readonly relays: FakeRelayNetwork;
    readonly stun: FakeStun;
    // Names this device's sockets, so the test can cut it off.
    readonly client: string;
    readonly sessionStore?: FakeSessionStore;
}

export function createFakeDiscoveryEnvironment(options: FakeDiscoveryEnvironmentOptions): FakeDiscoveryEnvironment {
    const { clock } = options;
    const connectivity = new Set<(isOnline: boolean) => void>();
    const pageHides = new Set<() => void>();
    const pageShows = new Set<() => void>();
    const visibilities = new Set<(isHidden: boolean) => void>();
    const visibility = { isHidden: false };
    const subscribe = <Handler>(set: Set<Handler>, handler: Handler): (() => void) => {
        set.add(handler);

        return () => {
            set.delete(handler);
        };
    };

    const fetches: string[] = [];
    const controls = {
        respondAsync: async (_url: string): Promise<Response> => Response.json({ status: 'ok' }),
    };
    const environment: DiscoveryEnvironment = {
        createPeerConnection: options.stun.createPeerConnection,
        createSocket: options.relays.socketFactory(options.client),
        fetchAsync: async url => {
            fetches.push(url);

            return controls.respondAsync(url);
        },
        now: clock.now,
        wallClock: () => FAKE_WALL_START + clock.time,
        setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
        clearTimeout: handle => clock.clear(handle),
        random: () => 0.5,
        randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
        onConnectivityChange: handler => subscribe(connectivity, handler),
        onPageHide: handler => subscribe(pageHides, handler),
        onPageShow: handler => subscribe(pageShows, handler),
        onVisibilityChange: handler => subscribe(visibilities, handler),
        isHidden: () => visibility.isHidden,
        sessionStore: options.sessionStore ?? new FakeSessionStore(),
    };

    return {
        environment,
        fetches,
        get respondAsync() {
            return controls.respondAsync;
        },
        set respondAsync(responder) {
            controls.respondAsync = responder;
        },
        setOnline: isOnline => [...connectivity].forEach(handler => handler(isOnline)),
        pageHide: () => [...pageHides].forEach(handler => handler()),
        pageShow: () => [...pageShows].forEach(handler => handler()),
        setHidden: isHidden => {
            visibility.isHidden = isHidden;
            [...visibilities].forEach(handler => handler(isHidden));
        },
    };
}
