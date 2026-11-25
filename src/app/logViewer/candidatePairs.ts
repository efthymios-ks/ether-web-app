import type { DiagnosticPair, Diagnostics } from '../../client/clientTypes.js';
import { formatBytes } from '../../core/settings.js';

type CandidateType = DiagnosticPair['local']['type'];
type PairState = DiagnosticPair['state'];

export const CANDIDATE_TYPE_LABELS: Readonly<Record<CandidateType, string>> = Object.freeze({
    host: 'host',
    srflx: 'server-reflexive',
    prflx: 'peer-reflexive',
    relay: 'relay',
});

// Selected first, then the pairs still in play, failed last.
const STATE_ORDER: readonly PairState[] = Object.freeze([
    'succeeded',
    'in-progress',
    'waiting',
    'frozen',
    'failed',
]);

// DL-06: shown under the table.
export const PAIR_NOTES = Object.freeze({
    mdns: '.local = this browser hid its IP (no camera permission)',
    peerReflexive: "peer-reflexive = address learned from the other device's checks",
});

export interface CandidateCell {
    readonly type: CandidateType;
    readonly typeLabel: string;
    readonly address: string;
    readonly isHidden: boolean;
}

export interface PairRow {
    readonly id: string;
    readonly local: CandidateCell;
    readonly remote: CandidateCell;
    readonly state: PairState;
    readonly nominated: boolean;
    readonly selected: boolean;
    readonly rtt: string;
    readonly sent: string;
    readonly received: string;
}

export function isMdnsAddress(address: string): boolean {
    return address.toLowerCase().endsWith('.local');
}

// "192.168.1.23:52344", "[fe80::1]:52344", "3f2a….local:60111".
export function formatAddress(address: string, port: number): string {
    const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;

    return `${host}:${port}`;
}

export function buildPairRows(pairs: readonly DiagnosticPair[]): PairRow[] {
    return [...pairs]
        .sort((left, right) => rank(left) - rank(right))
        .map(pair => ({
            id: pair.id,
            local: candidateCell(pair.local),
            remote: candidateCell(pair.remote),
            state: pair.state,
            nominated: pair.nominated,
            selected: pair.selected,
            rtt: pair.rttMs == null ? '—' : `${Math.round(pair.rttMs)} ms`,
            sent: formatBytes(pair.bytesSent),
            received: formatBytes(pair.bytesReceived),
        }));
}

// "connected · rtt 4 ms · max message 256 KiB", the line above the table.
export function summarizeDiagnostics(diagnostics: Diagnostics): string {
    const parts = [
        diagnostics.state,
        diagnostics.health == null ? null : `health ${diagnostics.health.status}`,
        diagnostics.health?.rttMs == null ? null : `rtt ${Math.round(diagnostics.health.rttMs)} ms`,
        diagnostics.maxMessageSize == null ? null : `max message ${formatBytes(diagnostics.maxMessageSize)}`,
        diagnostics.health?.peerHidden === true ? 'peer hidden' : null,
    ];

    return parts.filter(part => part != null).join(' · ');
}

// "slot 1 out 1.9 MiB buffered" for each busy slot.
export function summarizeSlots(diagnostics: Diagnostics): string[] {
    return diagnostics.slots
        .filter(slot => slot.fileId != null || slot.buffered > 0)
        .map(slot => [`slot ${slot.slot}`, slot.direction ?? '', `${formatBytes(slot.buffered)} buffered`]
            .filter(part => part !== '')
            .join(' '));
}

function candidateCell(candidate: DiagnosticPair['local']): CandidateCell {
    return {
        type: candidate.type,
        typeLabel: CANDIDATE_TYPE_LABELS[candidate.type] ?? candidate.type,
        address: formatAddress(candidate.address, candidate.port),
        isHidden: isMdnsAddress(candidate.address),
    };
}

function rank(pair: DiagnosticPair): number {
    if (pair.selected) {
        return -1;
    }

    const index = STATE_ORDER.indexOf(pair.state);

    return index < 0 ? STATE_ORDER.length : index;
}
