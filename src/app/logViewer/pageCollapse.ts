import type { LogEntry } from '../../core/logger.js';

export interface EntryRow {
    readonly kind: 'entry';
    readonly entry: LogEntry;
}

// DL-09: page lines of one busy second folded into "+87 pages".
export interface PagesRow {
    readonly kind: 'pages';
    readonly first: LogEntry;
    readonly entries: readonly LogEntry[];
}

export type LogRow = EntryRow | PagesRow;

// Above this many page lines in one second, they collapse; the per-second summaries stay.
export const COLLAPSE_PAGES_PER_SECOND = 20;

const PAGE_MESSAGE = /\bpage \d+\s*\/\s*\d+/;

// One line per page (DL-09): xfer at debug, with a page in its context or "page X/Y" in the message.
export function isPageLine(entry: LogEntry): boolean {
    return entry.cat === 'xfer'
        && entry.level === 'debug'
        && (entry.page != null || PAGE_MESSAGE.test(entry.msg));
}

export interface BuildRowsOptions {
    readonly threshold?: number;
    // Groups the user opened, keyed by their first entry.
    readonly expandedGroups?: ReadonlySet<LogEntry>;
}

export function buildRows(entries: readonly LogEntry[], options: BuildRowsOptions = {}): LogRow[] {
    const threshold = options.threshold ?? COLLAPSE_PAGES_PER_SECOND;
    const busySeconds = findBusySeconds(entries, threshold);
    if (busySeconds.size === 0) {
        return entries.map(entry => ({ kind: 'entry', entry }));
    }

    const expanded = options.expandedGroups;
    const rows: LogRow[] = [];
    let run: LogEntry[] = [];
    let runSecond = Number.NaN;

    const flush = (): void => {
        const first = run[0];
        if (first == null) {
            return;
        }

        if (run.length === 1 || expanded?.has(first) === true) {
            rows.push(...run.map(entry => ({ kind: 'entry' as const, entry })));
        } else {
            rows.push({ kind: 'pages', first, entries: run });
        }

        run = [];
    };

    for (const entry of entries) {
        const second = secondOf(entry);
        if (isPageLine(entry) && busySeconds.has(second)) {
            if (second !== runSecond) {
                flush();
            }

            runSecond = second;
            run.push(entry);
            continue;
        }

        flush();
        rows.push({ kind: 'entry', entry });
    }

    flush();

    return rows;
}

export function rowEntries(rows: readonly LogRow[]): LogEntry[] {
    return rows.flatMap(row => (row.kind === 'entry' ? [row.entry] : row.entries));
}

function findBusySeconds(entries: readonly LogEntry[], threshold: number): Set<number> {
    const counts = new Map<number, number>();
    for (const entry of entries) {
        if (isPageLine(entry)) {
            const second = secondOf(entry);
            counts.set(second, (counts.get(second) ?? 0) + 1);
        }
    }

    return new Set([...counts].filter(([, count]) => count > threshold).map(([second]) => second));
}

function secondOf(entry: LogEntry): number {
    return Math.floor(entry.wall / 1000);
}
