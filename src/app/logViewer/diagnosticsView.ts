import type { Diagnostics } from '../../client/clientTypes.js';
import { h } from '../dom.js';
import { buildPairRows, PAIR_NOTES, summarizeDiagnostics, summarizeSlots } from './candidatePairs.js';
import type { CandidateCell, PairRow } from './candidatePairs.js';
import { formatOffset } from './logFormat.js';
import type { StepStatus, Timeline, TimelineStep } from './handshakeTimeline.js';

const STATUS_MARKS: Readonly<Record<StepStatus, string>> = Object.freeze({
    done: '✓',
    warn: '!',
    failed: '✕',
    skipped: '–',
    pending: '·',
});

export interface PairsState {
    readonly diagnostics?: Diagnostics;
    readonly isPolling: boolean;
    readonly error?: string;
}

export function formatDuration(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// The line beside the "Handshake" heading.
export function timelineSummary(timeline: Timeline): string {
    if (timeline.outcome === 'connected') {
        return timeline.totalMs == null ? 'Connected' : `Connected in ${formatDuration(timeline.totalMs)}`;
    }

    if (timeline.outcome === 'failed') {
        const step = timeline.steps.find(item => item.id === timeline.failedStep);

        return `Failed at ${step?.label ?? 'pairing'}`;
    }

    return timeline.outcome === 'in-progress' ? 'In progress' : 'No pairing yet';
}

// DL-07: camera permission → … → channels open, durations from `t`, failures in red with the last state.
export function renderTimeline(timeline: Timeline): HTMLElement {
    if (timeline.outcome === 'none') {
        return h('p', { class: 'timeline-empty', text: 'The steps appear here once a pairing starts.' });
    }

    return h('ol', {
        class: 'timeline',
        dataset: { outcome: timeline.outcome },
        aria: { label: 'Handshake steps' },
        children: timeline.steps.map(renderStep),
    });
}

function renderStep(step: TimelineStep): HTMLElement {
    const detail = step.status === 'failed' ? `Failed: ${step.detail ?? 'no answer'}` : step.detail;

    return h('li', {
        class: 'timeline-step',
        dataset: { status: step.status, step: step.id },
        children: [
            h('span', { class: 'timeline-mark', text: STATUS_MARKS[step.status], aria: { hidden: 'true' } }),
            h('span', { class: 'timeline-label', text: step.label }),
            h('span', { class: 'timeline-time', text: step.t == null ? '' : formatOffset(step.t) }),
            h('span', {
                class: 'timeline-duration',
                text: step.durationMs == null || step.status === 'failed' ? '' : formatDuration(step.durationMs),
            }),
            detail == null ? null : h('span', { class: 'timeline-detail', text: detail }),
            step.lastState == null
                ? null
                : h('span', { class: 'timeline-last-state', text: `Last state: ${step.lastState}` }),
        ],
    });
}

// DL-06: the candidate-pair table with the selected pair highlighted, and what `.local` and peer-reflexive mean.
export function renderPairs(state: PairsState): HTMLElement {
    const notes = h('ul', {
        class: 'pairs-notes',
        children: [
            h('li', { text: PAIR_NOTES.mdns }),
            h('li', { text: PAIR_NOTES.peerReflexive }),
        ],
    });

    if (!state.isPolling) {
        return h('div', {
            class: 'pairs',
            children: [
                h('p', { class: 'pairs-empty', text: 'Debug logging is off, so connection stats aren’t polled.' }),
                notes,
            ],
        });
    }

    const diagnostics = state.diagnostics;
    const rows = buildPairRows(diagnostics?.pairs ?? []);
    const slots = diagnostics == null ? [] : summarizeSlots(diagnostics);

    return h('div', {
        class: 'pairs',
        children: [
            diagnostics == null ? null : h('p', { class: 'pairs-summary', text: summarizeDiagnostics(diagnostics) }),
            state.error == null ? null : h('p', { class: 'pairs-error', text: state.error }),
            rows.length === 0
                ? h('p', {
                    class: 'pairs-empty',
                    text: diagnostics == null ? 'Reading connection stats…' : 'No candidate pairs yet.',
                })
                : renderPairTable(rows),
            slots.length === 0 ? null : h('p', { class: 'pairs-slots', text: slots.join(' · ') }),
            notes,
        ],
    });
}

function renderPairTable(rows: readonly PairRow[]): HTMLElement {
    const headings = ['Local', 'Remote', 'State', 'Nominated', 'RTT', 'Sent', 'Received'];

    return h('div', {
        class: 'pairs-scroll',
        attrs: { tabindex: '0' },
        aria: { label: 'Candidate pairs' },
        children: [
            h('table', {
                class: 'pairs-table',
                children: [
                    h('thead', {
                        children: [h('tr', {
                            children: headings.map(text => h('th', { text, attrs: { scope: 'col' } })),
                        })],
                    }),
                    h('tbody', { children: rows.map(renderPairRow) }),
                ],
            }),
        ],
    });
}

function renderPairRow(row: PairRow): HTMLElement {
    return h('tr', {
        class: 'pairs-row',
        dataset: { selected: `${row.selected}`, state: row.state },
        children: [
            h('td', { children: [renderCandidate(row.local)] }),
            h('td', { children: [renderCandidate(row.remote)] }),
            h('td', {
                children: [
                    h('span', { class: 'pairs-state', dataset: { state: row.state }, text: row.state }),
                    row.selected ? h('span', { class: 'pairs-selected', text: 'selected' }) : null,
                ],
            }),
            h('td', { text: row.nominated ? 'yes' : 'no' }),
            h('td', { class: 'pairs-number', text: row.rtt }),
            h('td', { class: 'pairs-number', text: row.sent }),
            h('td', { class: 'pairs-number', text: row.received }),
        ],
    });
}

function renderCandidate(cell: CandidateCell): HTMLElement {
    return h('span', {
        class: 'candidate',
        dataset: { type: cell.type, mdns: `${cell.isHidden}` },
        children: [
            h('span', { class: 'candidate-type', text: cell.typeLabel }),
            ' ',
            h('span', { class: 'candidate-address', text: cell.address }),
        ],
    });
}
