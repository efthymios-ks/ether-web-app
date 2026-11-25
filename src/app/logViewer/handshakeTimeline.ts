import type { LogCategory, LogEntry } from '../../core/logger.js';

export type StepId = 'camera' | 'gathering' | 'code' | 'answer' | 'ice' | 'dtls' | 'channels';

export type StepStatus = 'done' | 'warn' | 'failed' | 'skipped' | 'pending';

export type TimelineOutcome = 'none' | 'in-progress' | 'connected' | 'failed';

export type PairingRole = 'offerer' | 'joiner';

export interface TimelineStep {
    readonly id: StepId;
    readonly label: string;
    readonly status: StepStatus;
    // Milliseconds since the pairing started, when the step was reached or failed.
    readonly t?: number;
    readonly durationMs?: number;
    readonly detail?: string;
    // Failed steps: the last state the connection reached (DL-07).
    readonly lastState?: string;
}

export interface Timeline {
    readonly steps: readonly TimelineStep[];
    readonly outcome: TimelineOutcome;
    readonly role: PairingRole;
    readonly totalMs?: number;
    readonly failedStep?: StepId;
}

export interface MessagePattern {
    readonly categories: readonly LogCategory[];
    readonly pattern: RegExp;
}

export interface StepMatcher {
    readonly id: StepId;
    readonly label: string;
    readonly reached: readonly MessagePattern[];
    // Reached, with a caveat shown in amber (camera denied, gathering cut at the cap).
    isWarning?(entry: LogEntry): boolean;
    readonly failed?: readonly MessagePattern[];
    // Spans log "<name> <n> ms" with data.durationMs (LG-02); other steps measure from the step before.
    readonly isSpan?: boolean;
    // Only the device that showed the offer applies an answer.
    readonly role?: PairingRole;
    // Shows the whole line as detail, e.g. "code 86 B → 138 chars, QR v6".
    readonly isWholeLineDetail?: boolean;
}

// DL-07: the handshake steps in order, matched on category and message text. The network layer's wording
// must keep matching these; every step is optional, so a missing line only leaves its step out.
export const TIMELINE_STEPS: readonly StepMatcher[] = Object.freeze([
    {
        id: 'camera',
        label: 'Camera permission',
        reached: [{ categories: ['pair'], pattern: /\bcamera permission\b/i }],
        isWarning: entry => /\b(denied|blocked|dismissed|unavailable|not asked|no camera)\b/i.test(entry.msg),
    },
    {
        id: 'gathering',
        label: 'Gathering',
        reached: [
            { categories: ['pair', 'ice'], pattern: /\bgathering (complete|completed|done)\b/i },
            { categories: ['pair', 'ice'], pattern: /\bgathering \d+(\.\d+)? ?ms\b/i },
            { categories: ['pair', 'ice'], pattern: /\bgathering[- ](timeout|timed out|capped)\b/i },
            { categories: ['ice'], pattern: /\bice ?gathering ?state\W+complete\b/i },
        ],
        // The gathering span reports `complete: false` when the cap cut it short (HS-02).
        isWarning: entry => /\b(timeout|timed out|capped)\b/i.test(entry.msg)
            || dataField(entry, 'complete') === false,
        isSpan: true,
    },
    {
        id: 'code',
        label: 'Code shown',
        reached: [
            { categories: ['pair'], pattern: /\b(offer|answer|code) shown\b/i },
            { categories: ['pair'], pattern: /\bcode \d+ ?B\b/i },
            { categories: ['pair'], pattern: /\bQR v\d+\b/i },
        ],
        isWholeLineDetail: true,
    },
    {
        id: 'answer',
        label: 'Reply applied',
        reached: [{ categories: ['pair'], pattern: /\banswer applied\b/i }],
        failed: [{ categories: ['pair'], pattern: /\banswer\b.*\b(rejected|invalid|failed)\b/i }],
        role: 'offerer',
    },
    {
        id: 'ice',
        label: 'ICE connected',
        reached: [
            { categories: ['ice'], pattern: /\bice ?connection ?state\W+(connected|completed)\b/i },
            { categories: ['ice'], pattern: /\bice (connected|completed)\b/i },
        ],
        failed: [
            { categories: ['ice'], pattern: /\bice ?connection ?state\W+failed\b/i },
            { categories: ['ice'], pattern: /\bice failed\b/i },
        ],
    },
    {
        id: 'dtls',
        label: 'DTLS connected',
        reached: [
            { categories: ['dtls'], pattern: /^(dtls( state)?\W+)?connected\b/i },
            { categories: ['ice', 'dtls'], pattern: /\bconnection ?state\W+connected\b/i },
        ],
        failed: [
            { categories: ['dtls'], pattern: /\b(dtls( state)?\W+failed|fingerprint mismatch)\b/i },
            { categories: ['ice', 'dtls'], pattern: /\bconnection ?state\W+failed\b/i },
        ],
    },
    {
        id: 'channels',
        label: 'Channels open',
        reached: [{ categories: ['dtls'], pattern: /\bchannels? open(ed)?\b/i }],
    },
] satisfies StepMatcher[]);

// Lines that end a pairing attempt without naming a step; the first step not reached is marked failed.
export const PAIRING_FAILURES: readonly MessagePattern[] = Object.freeze([
    { categories: ['pair', 'ice', 'dtls'], pattern: /\bconnect(ion)?[- ]timeout\b|\btimed out\b/i },
    { categories: ['pair'], pattern: /\bcode expired\b/i },
    { categories: ['pair'], pattern: /\bpairing failed\b/i },
]);

// Lines that only the device that scanned an offer writes; the offerer decodes an answer code instead.
export const JOINER_MARKERS: readonly MessagePattern[] = Object.freeze([
    { categories: ['pair'], pattern: /\boffer code decoded\b/i },
    { categories: ['pair'], pattern: /\banswer created\b/i },
]);

const HANDSHAKE_CATEGORIES: readonly LogCategory[] = Object.freeze(['pair', 'ice', 'dtls']);
// "iceConnectionState checking", "signalingState stable", "DTLS connecting", "SCTP connecting".
const STATE_LINE = /state\b|^(dtls|sctp) [a-z-]+$/i;
// The transport states the network attaches to its failure line (DL-07), in reading order.
const STATE_FIELDS: readonly string[] = Object.freeze([
    'linkState',
    'signalingState',
    'iceGatheringState',
    'iceConnectionState',
    'connectionState',
    'dtlsState',
    'sctpState',
    'openChannels',
]);
const DURATION_IN_MESSAGE = /(\d+(?:\.\d+)?) ?ms\b/i;

interface Reached {
    readonly entry: LogEntry;
    readonly pattern: RegExp;
}

interface Failure {
    readonly step: StepId;
    readonly entry: LogEntry;
    readonly lastState?: string;
}

export function matchesAny(
    entry: LogEntry,
    patterns: readonly MessagePattern[] | undefined,
): RegExp | undefined {
    return patterns?.find(item => item.categories.includes(entry.cat) && item.pattern.test(entry.msg))?.pattern;
}

// Keeps the latest pairing: the logger restarts `t` at zero when one begins (markOrigin).
export function latestAttempt(entries: readonly LogEntry[]): LogEntry[] {
    const own = entries.filter(entry => entry.peer == null);
    let start = 0;
    for (let index = 1; index < own.length; index++) {
        const previous = own[index - 1];
        const current = own[index];
        if (previous != null && current != null && current.t < previous.t) {
            start = index;
        }
    }

    return own.slice(start);
}

export function buildTimeline(
    entries: readonly LogEntry[],
    steps: readonly StepMatcher[] = TIMELINE_STEPS,
): Timeline {
    const attempt = latestAttempt(entries);
    const isJoiner = attempt.some(entry => matchesAny(entry, JOINER_MARKERS) != null);
    const role: PairingRole = isJoiner ? 'joiner' : 'offerer';
    const applicable = steps.filter(step => step.role == null || step.role === role);
    const reached = new Map<StepId, Reached>();
    let failure: Failure | undefined;
    let lastState: string | undefined;

    for (const entry of attempt) {
        for (const step of applicable) {
            const pattern = reached.has(step.id) ? undefined : matchesAny(entry, step.reached);
            if (pattern != null) {
                reached.set(step.id, { entry, pattern });
            }
        }

        if (failure == null) {
            failure = findFailure(entry, applicable, reached, lastState);
        }

        if (HANDSHAKE_CATEGORIES.includes(entry.cat) && STATE_LINE.test(entry.msg)) {
            lastState = entry.msg;
        }
    }

    const timelineSteps = buildSteps({ steps, role, reached, failure });
    const last = reached.get('channels');
    const outcome = resolveOutcome(reached.size, last != null, failure != null);

    return {
        steps: timelineSteps,
        outcome,
        role,
        ...(last == null || outcome !== 'connected' ? {} : { totalMs: last.entry.t }),
        ...(failure == null || outcome !== 'failed' ? {} : { failedStep: failure.step }),
    };
}

function findFailure(
    entry: LogEntry,
    steps: readonly StepMatcher[],
    reached: ReadonlyMap<StepId, Reached>,
    lastState: string | undefined,
): Failure | undefined {
    const last = statesOf(entry) ?? lastState ?? lastReachedMessage(steps, reached);
    const specific = steps.find(step => !reached.has(step.id) && matchesAny(entry, step.failed) != null);
    if (specific != null) {
        return { step: specific.id, entry, ...(last == null ? {} : { lastState: last }) };
    }

    const isGeneric = matchesAny(entry, PAIRING_FAILURES) != null
        || (entry.level === 'error' && HANDSHAKE_CATEGORIES.includes(entry.cat));
    if (!isGeneric) {
        return undefined;
    }

    const pending = firstPendingStep(steps, reached);
    if (pending == null) {
        return undefined;
    }

    return { step: pending.id, entry, ...(last == null ? {} : { lastState: last }) };
}

// "iceConnectionState checking, dtlsState new, openChannels 0", from the network's failure data.
function statesOf(entry: LogEntry): string | undefined {
    const parts = STATE_FIELDS
        .map(field => ({ field, value: dataField(entry, field) }))
        .filter(item => typeof item.value === 'string' || typeof item.value === 'number')
        .map(item => `${item.field} ${String(item.value)}`);

    return parts.length === 0 ? undefined : parts.join(', ');
}

function dataField(entry: LogEntry, field: string): unknown {
    const data = entry.data;

    return data != null && typeof data === 'object' ? (data as Record<string, unknown>)[field] : undefined;
}

// The first step after the furthest one reached.
function firstPendingStep(
    steps: readonly StepMatcher[],
    reached: ReadonlyMap<StepId, Reached>,
): StepMatcher | undefined {
    const furthest = steps.reduce((best, step, index) => (reached.has(step.id) ? index : best), -1);

    return steps.slice(furthest + 1).find(step => !reached.has(step.id));
}

function lastReachedMessage(
    steps: readonly StepMatcher[],
    reached: ReadonlyMap<StepId, Reached>,
): string | undefined {
    const latest = [...steps].reverse().find(step => reached.has(step.id));

    return latest == null ? undefined : reached.get(latest.id)?.entry.msg;
}

function buildSteps(context: {
    readonly steps: readonly StepMatcher[];
    readonly role: PairingRole;
    readonly reached: ReadonlyMap<StepId, Reached>;
    readonly failure: Failure | undefined;
}): TimelineStep[] {
    const { steps, role, reached, failure } = context;
    const furthest = steps.reduce((best, step, index) => (reached.has(step.id) ? index : best), -1);
    let previousT: number | undefined;

    return steps.map((step, index): TimelineStep => {
        const hit = reached.get(step.id);
        if (step.role != null && step.role !== role) {
            return { id: step.id, label: step.label, status: 'skipped', detail: 'On the other device' };
        }

        if (hit != null) {
            const durationMs = step.isSpan === true ? spanDuration(hit.entry) : undefined;
            const since = previousT == null ? hit.entry.t : hit.entry.t - previousT;
            previousT = hit.entry.t;
            const detail = step.isWholeLineDetail === true ? hit.entry.msg : detailOf(hit);

            return {
                id: step.id,
                label: step.label,
                status: step.isWarning?.(hit.entry) === true ? 'warn' : 'done',
                t: hit.entry.t,
                durationMs: durationMs ?? Math.max(0, Math.round(since)),
                ...(detail === '' ? {} : { detail }),
            };
        }

        if (failure?.step === step.id) {
            return {
                id: step.id,
                label: step.label,
                status: 'failed',
                t: failure.entry.t,
                detail: failure.entry.msg,
                ...(failure.lastState == null ? {} : { lastState: failure.lastState }),
            };
        }

        return { id: step.id, label: step.label, status: index < furthest ? 'skipped' : 'pending' };
    });
}

function resolveOutcome(reachedCount: number, isConnected: boolean, hasFailed: boolean): TimelineOutcome {
    if (isConnected) {
        return 'connected';
    }

    if (hasFailed) {
        return 'failed';
    }

    return reachedCount > 0 ? 'in-progress' : 'none';
}

function spanDuration(entry: LogEntry): number | undefined {
    const value = dataField(entry, 'durationMs');
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.round(value);
    }

    const match = DURATION_IN_MESSAGE.exec(entry.msg);

    return match?.[1] == null ? undefined : Math.round(Number(match[1]));
}

// The rest of the line after what matched, e.g. "granted (real local IPs exposed)".
function detailOf(hit: Reached): string {
    return hit.entry.msg
        .replace(hit.pattern, '')
        .replace(/^[\s:;,.–-]+/, '')
        .trim();
}
