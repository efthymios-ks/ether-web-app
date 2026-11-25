// Page arithmetic and the concurrency rule (TR-01, TR-03, BK-05).

export const AUTO_CONCURRENCY = 2;
export const AUTO_CONCURRENCY_SMALL_FILES = 4;
export const SMALL_FILE_BYTES = 5 * 1000 * 1000;
export const MAX_SLOTS = 4;

// A zero-byte file has no pages (TR-11).
export function countPages(size: number, pageSize: number): number {
    if (size <= 0) {
        return 0;
    }

    return Math.ceil(size / pageSize);
}

export interface PageRange {
    readonly start: number;
    readonly end: number;
}

export function pageRange(size: number, pageSize: number, page: number): PageRange {
    const start = page * pageSize;

    return { start, end: Math.min(size, start + pageSize) };
}

export function pageLength(size: number, pageSize: number, page: number): number {
    const range = pageRange(size, pageSize, page);

    return Math.max(0, range.end - range.start);
}

// Where a resume starts: at the last saved page rather than after it, so that page is sent again and replaces its
// stored copy, in case it was written just as the transfer broke off (§7.4). Nothing saved starts at page 0.
export function resumePageOf(savedPages: number): number {
    return Math.max(0, savedPages - 1);
}

// Bytes covered by the first `pages` pages.
export function bytesForPages(size: number, pageSize: number, pages: number): number {
    return Math.min(size, pages * pageSize);
}

export function median(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((first, second) => first - second);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? 0;
    }

    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

// 0 means Auto: 2 slots, or 4 when the batch's median file is under 5 MB (BK-05).
export function resolveConcurrency(setting: number, batchSizes: readonly number[]): number {
    if (setting > 0) {
        return Math.min(MAX_SLOTS, setting);
    }

    if (batchSizes.length > 0 && median(batchSizes) < SMALL_FILE_BYTES) {
        return AUTO_CONCURRENCY_SMALL_FILES;
    }

    return AUTO_CONCURRENCY;
}
