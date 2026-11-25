import type { Health, HealthStatus } from './networkTypes.js';

// Connection health (HC-01…HC-04) without timers: the caller asks for it on its own schedule.

export const CONNECT_GRACE_MS = 5000;

export interface HealthTimeouts {
    readonly weakMs: number;
    readonly lostMs: number;
}

export interface HealthMonitorOptions extends HealthTimeouts {
    readonly now: () => number;
    // HC-02: no Weak right after connecting.
    readonly graceMs?: number;
}

export interface HealthMonitor {
    // Starts the clocks when the link connects.
    start(): void;
    // HC-01: any message from the peer is proof of life.
    received(): void;
    // HC-04: the timeout is suspended while the peer is hidden.
    setPeerHidden(hidden: boolean): void;
    // HC-03: disconnected may recover; failed and closed are lost.
    setConnectionState(state: RTCPeerConnectionState): void;
    recordRtt(rttMs: number): void;
    configure(timeouts: HealthTimeouts): void;
    // Lost is final: once reached, it stays.
    evaluate(): Health;
}

const LOST_CONNECTION_STATES: readonly RTCPeerConnectionState[] = Object.freeze(['failed', 'closed']);

interface MonitorState {
    weakMs: number;
    lostMs: number;
    connectedAt?: number;
    lastSeen: number;
    peerHidden: boolean;
    rttMs?: number;
    isLost: boolean;
}

export function createHealthMonitor(options: HealthMonitorOptions): HealthMonitor {
    const graceMs = options.graceMs ?? CONNECT_GRACE_MS;
    const state: MonitorState = {
        weakMs: options.weakMs,
        lostMs: options.lostMs,
        lastSeen: options.now(),
        peerHidden: false,
        isLost: false,
    };

    const statusAt = (now: number, silence: number): HealthStatus => {
        if (state.isLost) {
            return 'lost';
        }

        if (state.connectedAt == null || state.peerHidden) {
            return 'good';
        }

        if (silence > state.lostMs) {
            return 'lost';
        }

        if (silence >= state.weakMs && now - state.connectedAt >= graceMs) {
            return 'weak';
        }

        return 'good';
    };

    return {
        start: () => {
            state.connectedAt = options.now();
            state.lastSeen = state.connectedAt;
        },
        received: () => {
            state.lastSeen = options.now();
        },
        setPeerHidden: hidden => {
            state.peerHidden = hidden;
            state.lastSeen = options.now();
        },
        setConnectionState: connectionState => {
            if (LOST_CONNECTION_STATES.includes(connectionState)) {
                state.isLost = true;
            }
        },
        recordRtt: rttMs => {
            state.rttMs = Math.round(rttMs);
        },
        configure: timeouts => {
            state.weakMs = timeouts.weakMs;
            state.lostMs = timeouts.lostMs;
        },
        evaluate: () => {
            const now = options.now();
            const silence = state.connectedAt == null ? 0 : Math.max(0, now - state.lastSeen);
            const status = statusAt(now, silence);
            state.isLost = status === 'lost';

            return {
                status,
                ...(state.rttMs == null ? {} : { rttMs: state.rttMs }),
                lastSeenMs: Math.round(silence),
                peerHidden: state.peerHidden,
            };
        },
    };
}
