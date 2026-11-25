import { createEmitter } from '../../core/events.js';
import type {
    Discovery,
    DiscoveryEvents,
    DiscoveryStatus,
    NearbyDevice,
    OwnNearbyIdentity,
    PairRequest,
    PairRequestOutcome,
    RelayAllowanceNotice,
} from '../../discovery/discoveryTypes.js';

// An in-memory Discovery for UI tests: it records every call, and the test pushes the status, the devices,
// incoming requests, the answer to this device's own request and the relay's allowance notice.

export interface SentPairRequest {
    readonly nearbyId: string;
    readonly offerCode: string;
    readonly signal: AbortSignal | undefined;
    // The PIN typed for that device, which the real discovery turns into a proof.
    readonly pin: string | undefined;
}

export interface SentAnswer {
    readonly requestId: string;
    readonly answerCode: string;
}

export interface SentDecline {
    readonly requestId: string;
    readonly reason: 'declined' | 'busy' | undefined;
}

export interface FakeDiscoveryBehaviour {
    acceptAsync?: (requestId: string, answerCode: string) => Promise<void>;
    requestPairingAsync?: (nearbyId: string, offerCode: string) => Promise<PairRequestOutcome>;
}

export interface FakeDiscovery extends Discovery {
    readonly starts: OwnNearbyIdentity[];
    readonly stopCount: number;
    readonly isStarted: boolean;
    readonly sent: SentPairRequest[];
    readonly accepts: SentAnswer[];
    readonly declines: SentDecline[];
    behaviour: FakeDiscoveryBehaviour;
    setStatus(status: DiscoveryStatus): void;
    // Shows these devices as the whole list, and moves to listening as a real start would.
    setDevices(devices: readonly NearbyDevice[]): void;
    receiveRequest(request: PairRequest): void;
    endRequest(requestId: string): void;
    // Settles the request this device sent last.
    answer(outcome: PairRequestOutcome): void;
    setRelayAllowance(notice: RelayAllowanceNotice | undefined): void;
}

export function createNearbyDevice(overrides: Partial<NearbyDevice> = {}): NearbyDevice {
    return {
        nearbyId: 'nearby-pixel',
        name: 'Pixel 8 · Blue Otter',
        deviceType: 'phone',
        lastSeenAt: Date.parse('2026-11-25T10:00:00Z'),
        ...overrides,
    };
}

export function createPairRequest(overrides: Partial<PairRequest> = {}): PairRequest {
    return {
        requestId: 'request-1',
        from: createNearbyDevice(),
        offerCode: 'OFFERNEARBY1234',
        expiresAt: Date.now() + 60_000,
        isPinVerified: false,
        ...overrides,
    };
}

export function createRelayAllowanceNotice(
    overrides: Partial<RelayAllowanceNotice> = {},
): RelayAllowanceNotice {
    return {
        relayUrl: 'wss://relay.ether.test',
        isCertain: true,
        resetsAt: Date.now() + 5 * 3_600_000,
        ...overrides,
    };
}

export function createFakeDiscovery(): FakeDiscovery {
    const emitter = createEmitter<DiscoveryEvents>();
    const starts: OwnNearbyIdentity[] = [];
    const sent: SentPairRequest[] = [];
    const accepts: SentAnswer[] = [];
    const declines: SentDecline[] = [];
    const pending: Array<(outcome: PairRequestOutcome) => void> = [];
    let status: DiscoveryStatus = 'off';
    let devices: readonly NearbyDevice[] = [];
    let relayAllowance: RelayAllowanceNotice | undefined;
    let stopCount = 0;

    const setStatus = (next: DiscoveryStatus): void => {
        status = next;
        emitter.emit('status', next);
    };

    const setDevices = (next: readonly NearbyDevice[]): void => {
        if (status !== 'listening') {
            setStatus('listening');
        }

        devices = [...next];
        emitter.emit('devices', devices);
    };

    const fake: FakeDiscovery = {
        starts,
        sent,
        accepts,
        declines,
        behaviour: {},
        get stopCount() {
            return stopCount;
        },
        get isStarted() {
            return status !== 'off';
        },
        status: () => status,
        relayAllowance: () => relayAllowance,
        devices: () => devices,
        on: (name, handler) => emitter.on(name, handler),
        start: identity => {
            starts.push(identity);
            if (status === 'off') {
                setStatus('starting');
            }
        },
        stop: () => {
            stopCount++;
            devices = [];
            setStatus('off');
            emitter.emit('devices', devices);
            for (const settle of pending.splice(0)) {
                settle({ kind: 'canceled' });
            }
        },
        requestPairingAsync: async (nearbyId, offerCode, options) => {
            sent.push({ nearbyId, offerCode, signal: options?.signal, pin: options?.pin });
            if (fake.behaviour.requestPairingAsync != null) {
                return fake.behaviour.requestPairingAsync(nearbyId, offerCode);
            }

            return new Promise<PairRequestOutcome>(resolve => {
                const settle = (outcome: PairRequestOutcome): void => {
                    const index = pending.indexOf(settle);
                    if (index >= 0) {
                        pending.splice(index, 1);
                    }

                    resolve(outcome);
                };
                pending.push(settle);
                options?.signal?.addEventListener('abort', () => settle({ kind: 'canceled' }));
            });
        },
        acceptAsync: async (requestId, answerCode) => {
            accepts.push({ requestId, answerCode });
            await fake.behaviour.acceptAsync?.(requestId, answerCode);
        },
        declineAsync: async (requestId, reason) => {
            declines.push({ requestId, reason });
        },
        setStatus,
        setDevices,
        receiveRequest: request => emitter.emit('request', request),
        endRequest: requestId => emitter.emit('request-ended', requestId),
        setRelayAllowance: notice => {
            relayAllowance = notice;
            emitter.emit('relay-allowance', notice);
        },
        answer: outcome => {
            const settle = pending.at(-1);
            if (settle == null) {
                throw new Error('No pairing request is waiting for an answer.');
            }

            settle(outcome);
        },
    };

    return fake;
}
