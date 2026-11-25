// DL-10: only the rows in view (plus a margin) exist in the page. Rows share one height, except expanded
// ones, which add their measured extra height.

export interface ExtraHeight {
    readonly index: number;
    readonly extra: number;
}

export interface WindowInput {
    readonly scrollTop: number;
    readonly viewportHeight: number;
    readonly rowHeight: number;
    readonly count: number;
    // Sorted by index.
    readonly extras?: readonly ExtraHeight[];
    readonly overscan?: number;
}

export interface WindowRange {
    readonly start: number;
    // Exclusive.
    readonly end: number;
    readonly offset: number;
    readonly totalHeight: number;
}

export function totalHeight(count: number, rowHeight: number, extras: readonly ExtraHeight[] = []): number {
    return count * rowHeight + extras.reduce((sum, item) => sum + (item.index < count ? item.extra : 0), 0);
}

export function rowOffset(index: number, rowHeight: number, extras: readonly ExtraHeight[] = []): number {
    return index * rowHeight + extras.reduce((sum, item) => sum + (item.index < index ? item.extra : 0), 0);
}

export function indexAtOffset(
    offset: number,
    rowHeight: number,
    count: number,
    extras: readonly ExtraHeight[] = [],
): number {
    if (count <= 0) {
        return 0;
    }

    let position = 0;
    let base = 0;
    for (const item of extras) {
        const plainRows = item.index - base;
        if (offset < position + plainRows * rowHeight) {
            break;
        }

        position += plainRows * rowHeight;
        if (offset < position + rowHeight + item.extra) {
            return Math.min(count - 1, item.index);
        }

        position += rowHeight + item.extra;
        base = item.index + 1;
    }

    return Math.min(count - 1, Math.max(0, base + Math.floor((offset - position) / rowHeight)));
}

export function computeWindow(input: WindowInput): WindowRange {
    const extras = input.extras ?? [];
    const overscan = input.overscan ?? 10;
    const rowHeight = Math.max(1, input.rowHeight);
    const first = indexAtOffset(Math.max(0, input.scrollTop), rowHeight, input.count, extras);
    const bottom = Math.max(0, input.scrollTop + input.viewportHeight);
    const last = indexAtOffset(bottom, rowHeight, input.count, extras);
    const start = Math.max(0, first - overscan);
    const end = Math.min(input.count, last + 1 + overscan);

    return {
        start,
        end: Math.max(start, end),
        offset: rowOffset(start, rowHeight, extras),
        totalHeight: totalHeight(input.count, rowHeight, extras),
    };
}
