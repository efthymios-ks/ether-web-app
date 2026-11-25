import { LOG_CATEGORIES, LOG_LEVELS } from '../../core/logger.js';
import type { LogCategory, LogEntry, LogLevel } from '../../core/logger.js';
import { safeStringify } from './logFormat.js';

export interface CategoryFilter {
    readonly id: string;
    readonly label: string;
    // Null keeps every category.
    readonly categories: readonly LogCategory[] | null;
}

export interface LevelFilter {
    readonly id: LogLevel;
    readonly label: string;
}

// DL-04: one choice per category, plus the handshake group the timeline is built from.
export const CATEGORY_FILTERS: readonly CategoryFilter[] = Object.freeze([
    { id: 'all', label: 'All categories', categories: null },
    { id: 'handshake', label: 'Handshake', categories: ['pair', 'ice', 'pairs', 'dtls'] },
    ...LOG_CATEGORIES.map(category => ({ id: category, label: category, categories: [category] })),
]);

export const LEVEL_FILTERS: readonly LevelFilter[] = Object.freeze([
    { id: 'debug', label: 'All levels' },
    { id: 'info', label: 'Info and up' },
    { id: 'warn', label: 'Warnings and errors' },
    { id: 'error', label: 'Errors' },
]);

export interface LogFilter {
    readonly category: string;
    readonly level: LogLevel;
    // Empty for every file.
    readonly fileId: string;
    readonly text: string;
}

export const DEFAULT_FILTER: LogFilter = Object.freeze({
    category: 'all',
    level: 'debug',
    fileId: '',
    text: '',
});

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze(
    Object.fromEntries(LOG_LEVELS.map((level, index) => [level, index])) as Record<LogLevel, number>,
);

const searchCache = new WeakMap<LogEntry, string>();

export function isFilterActive(filter: LogFilter): boolean {
    return filter.category !== DEFAULT_FILTER.category
        || filter.level !== DEFAULT_FILTER.level
        || filter.fileId !== DEFAULT_FILTER.fileId
        || filter.text.trim() !== '';
}

export function createMatcher(
    filter: LogFilter,
    peerName: (entry: LogEntry) => string | undefined = () => undefined,
): (entry: LogEntry) => boolean {
    const categories = CATEGORY_FILTERS.find(item => item.id === filter.category)?.categories ?? null;
    const minimum = LEVEL_RANK[filter.level];
    const needle = filter.text.trim().toLowerCase();

    return entry => {
        if (LEVEL_RANK[entry.level] < minimum) {
            return false;
        }

        if (categories != null && !categories.includes(entry.cat)) {
            return false;
        }

        if (filter.fileId !== '' && entry.fileId !== filter.fileId) {
            return false;
        }

        if (needle === '') {
            return true;
        }

        return searchText(entry, peerName(entry)).includes(needle);
    };
}

// Lower-case text a search runs against: category, level, peer, message, ids and data.
export function searchText(entry: LogEntry, peerName?: string): string {
    const cached = searchCache.get(entry);
    if (cached != null) {
        return cached;
    }

    const data = entry.data === undefined ? '' : safeStringify(entry.data);
    const text = [entry.cat, entry.level, peerName ?? entry.peer ?? '', entry.msg, entry.fileId ?? '', data]
        .join(' ')
        .toLowerCase();
    searchCache.set(entry, text);

    return text;
}

// DL-04 "filter by file": every fileId seen, labelled with a name when an entry carried one.
export function collectFiles(
    entries: readonly LogEntry[],
    known: Map<string, string> = new Map(),
): Map<string, string> {
    for (const entry of entries) {
        if (entry.fileId == null) {
            continue;
        }

        const name = fileNameOf(entry);
        const current = known.get(entry.fileId);
        if (current == null || (name != null && current === shortId(entry.fileId))) {
            known.set(entry.fileId, name ?? shortId(entry.fileId));
        }
    }

    return known;
}

// For the export header, e.g. "category handshake, level warn+, text "nack"".
export function describeFilter(filter: LogFilter, fileLabel?: string): string {
    const parts = [
        filter.category === 'all' ? null : `category ${filter.category}`,
        filter.level === 'debug' ? null : `level ${filter.level}+`,
        filter.fileId === '' ? null : `file ${fileLabel ?? shortId(filter.fileId)}`,
        filter.text.trim() === '' ? null : `text "${filter.text.trim()}"`,
    ];

    return parts.filter(part => part != null).join(', ');
}

function fileNameOf(entry: LogEntry): string | undefined {
    const data = entry.data;
    if (data == null || typeof data !== 'object') {
        return undefined;
    }

    const name = (data as Record<string, unknown>).name;

    return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function shortId(fileId: string): string {
    return fileId.slice(0, 8);
}
