import type { CandidateInfo, CandidatePairState, CandidatePairStats, CandidateType } from './networkTypes.js';

// DL-06: the candidate-pair table from the entries of an RTCStatsReport.

export interface StatsRecord {
    readonly id: string;
    readonly type: string;
    readonly [key: string]: unknown;
}

// Older Firefox and Safari spell some values out.
const CANDIDATE_TYPES: Readonly<Record<string, CandidateType>> = Object.freeze({
    host: 'host',
    srflx: 'srflx',
    serverreflexive: 'srflx',
    prflx: 'prflx',
    peerreflexive: 'prflx',
    relay: 'relay',
    relayed: 'relay',
});

const PAIR_STATES: Readonly<Record<string, CandidatePairState>> = Object.freeze({
    frozen: 'frozen',
    waiting: 'waiting',
    'in-progress': 'in-progress',
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'failed',
});

const MISSING_CANDIDATE: CandidateInfo = Object.freeze({ type: 'host', protocol: '', address: '', port: 0 });

export function mapCandidatePairStats(records: Iterable<StatsRecord>): CandidatePairStats[] {
    const byId = new Map<string, StatsRecord>();
    for (const record of records) {
        byId.set(record.id, record);
    }

    const all = [...byId.values()];
    const pairs = all.filter(record => record.type === 'candidate-pair');
    const selectedId = findSelectedPairId(all, pairs);

    return pairs.map(pair => {
        const rtt = numberOf(pair.currentRoundTripTime);

        return {
            id: pair.id,
            local: toCandidateInfo(byId.get(stringOf(pair.localCandidateId))),
            remote: toCandidateInfo(byId.get(stringOf(pair.remoteCandidateId))),
            state: PAIR_STATES[stringOf(pair.state)] ?? 'waiting',
            nominated: pair.nominated === true,
            selected: pair.id === selectedId,
            ...(rtt == null ? {} : { rttMs: Math.round(rtt * 1000) }),
            bytesSent: numberOf(pair.bytesSent) ?? 0,
            bytesReceived: numberOf(pair.bytesReceived) ?? 0,
        };
    });
}

type SelectedPairFinder = (all: readonly StatsRecord[], pairs: readonly StatsRecord[]) => string | undefined;

// Order is priority: the transport's selected pair, Firefox's `selected` flag,
// then the nominated pair that succeeded.
const SELECTED_PAIR_FINDERS: readonly SelectedPairFinder[] = [
    all => all
        .filter(record => record.type === 'transport')
        .map(record => stringOf(record.selectedCandidatePairId))
        .find(id => id !== ''),
    (_, pairs) => pairs.find(pair => pair.selected === true)?.id,
    (_, pairs) => pairs.find(pair => pair.nominated === true && pair.state === 'succeeded')?.id,
];

function findSelectedPairId(all: readonly StatsRecord[], pairs: readonly StatsRecord[]): string | undefined {
    for (const find of SELECTED_PAIR_FINDERS) {
        const id = find(all, pairs);
        if (id != null) {
            return id;
        }
    }

    return undefined;
}

function toCandidateInfo(record: StatsRecord | undefined): CandidateInfo {
    if (record == null) {
        return MISSING_CANDIDATE;
    }

    return {
        type: CANDIDATE_TYPES[stringOf(record.candidateType)] ?? 'host',
        protocol: stringOf(record.protocol),
        address: stringOf(record.address ?? record.ip),
        port: numberOf(record.port) ?? 0,
    };
}

function stringOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
