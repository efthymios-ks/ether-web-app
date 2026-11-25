// UI-10, GL-01: only the rows on screen, plus one screen above and below, exist in the page.
// Rows may differ in height (gallery day headers vs. thumbnail rows); `offsets` are their running totals.

export interface VirtualListOptions<Row> {
    // The element that scrolls; the list may sit anywhere inside it.
    readonly scroller: HTMLElement;
    readonly rowHeight: (row: Row, index: number) => number;
    readonly renderRow: (row: Row, index: number) => HTMLElement;
    // GL-02: e.g. revokes the object URLs of a row that left the screen.
    readonly releaseRow?: (element: HTMLElement, row: Row) => void;
    readonly className?: string;
    readonly role?: string;
    readonly label?: string;
}

// The reader's place in a list: a row by its key, and how far its top is from the top of the scroller's view.
export interface ListPlace {
    readonly key: string;
    readonly offset: number;
}

export interface VirtualList<Row> {
    readonly element: HTMLElement;
    readonly rows: readonly Row[];
    setRows(rows: readonly Row[]): void;
    // The first keyed row at the top of the view, or undefined while the list's own top is still in view, when
    // there is no place to keep: rows added below then move nothing.
    place(keyOf: (row: Row) => string | undefined): ListPlace | undefined;
    // Puts the row with that key back at the same distance from the top of the view, so rows added or regrouped
    // above it don't move what the reader is looking at.
    restorePlace(place: ListPlace, hasKey: (row: Row, key: string) => boolean): void;
    // Redraws the rows on screen, e.g. after their data changed.
    refresh(): void;
    update(): void;
    renderedRows(): ReadonlyArray<{ readonly index: number; readonly element: HTMLElement; readonly row: Row }>;
    dispose(): void;
}

export function computeOffsets(heights: readonly number[]): number[] {
    const offsets = [0];
    for (const height of heights) {
        offsets.push((offsets.at(-1) ?? 0) + height);
    }

    return offsets;
}

// Index of the row that contains `position`; offsets has one more entry than there are rows.
export function rowAt(offsets: readonly number[], position: number): number {
    let low = 0;
    let high = Math.max(0, offsets.length - 2);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((offsets[middle] ?? 0) <= position) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low;
}

export function visibleRange(
    offsets: readonly number[],
    windowStart: number,
    windowSize: number,
): { readonly start: number; readonly end: number } {
    const count = offsets.length - 1;
    if (count <= 0) {
        return { start: 0, end: 0 };
    }

    const start = rowAt(offsets, Math.max(0, windowStart - windowSize));
    const end = Math.min(count, rowAt(offsets, windowStart + windowSize * 2) + 1);

    return { start, end };
}

export function createVirtualList<Row>(options: VirtualListOptions<Row>): VirtualList<Row> {
    const element = document.createElement('div');
    element.className = options.className ?? 'virtual-list';
    if (options.role != null) {
        element.setAttribute('role', options.role);
    }

    if (options.label != null) {
        element.setAttribute('aria-label', options.label);
    }

    const rendered = new Map<number, HTMLElement>();
    let rows: readonly Row[] = [];
    let offsets: number[] = [0];
    let frame: number | undefined;

    const listTop = (): number => {
        const scrollerTop = options.scroller.getBoundingClientRect().top;

        return element.getBoundingClientRect().top - scrollerTop + options.scroller.scrollTop;
    };

    const viewportSize = (): number => {
        const height = options.scroller.clientHeight;

        return height > 0 ? height : globalThis.innerHeight;
    };

    const release = (index: number): void => {
        const row = rendered.get(index);
        if (row == null) {
            return;
        }

        rendered.delete(index);
        const data = rows[index];
        if (data != null) {
            options.releaseRow?.(row, data);
        }

        row.remove();
    };

    const update = (): void => {
        frame = undefined;
        const { start, end } = visibleRange(offsets, options.scroller.scrollTop - listTop(), viewportSize());
        for (const index of [...rendered.keys()]) {
            if (index < start || index >= end) {
                release(index);
            }
        }

        for (let index = start; index < end; index++) {
            const data = rows[index];
            if (rendered.has(index) || data == null) {
                continue;
            }

            const row = options.renderRow(data, index);
            row.style.setProperty('position', 'absolute');
            row.style.setProperty('inset-inline', '0');
            row.style.setProperty('inset-block-start', `${offsets[index] ?? 0}px`);
            row.style.setProperty('block-size', `${(offsets[index + 1] ?? 0) - (offsets[index] ?? 0)}px`);
            rendered.set(index, row);
            element.append(row);
        }
    };

    const scheduleUpdate = (): void => {
        if (frame != null) {
            return;
        }

        frame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(update)
            : (setTimeout(update, 16) as unknown as number);
    };

    const releaseAll = (): void => {
        for (const index of [...rendered.keys()]) {
            release(index);
        }
    };

    options.scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleUpdate) : undefined;
    resizeObserver?.observe(options.scroller);

    return {
        element,
        get rows() {
            return rows;
        },
        setRows: next => {
            releaseAll();
            rows = next;
            offsets = computeOffsets(rows.map((row, index) => options.rowHeight(row, index)));
            element.style.setProperty('position', 'relative');
            element.style.setProperty('block-size', `${offsets.at(-1) ?? 0}px`);
            update();
        },
        refresh: () => {
            releaseAll();
            update();
        },
        update,
        place: keyOf => {
            const top = listTop();
            const scrollTop = options.scroller.scrollTop;
            if (rows.length === 0 || scrollTop <= top) {
                return undefined;
            }

            for (let index = rowAt(offsets, scrollTop - top); index < rows.length; index++) {
                const key = keyOf(rows[index] as Row);
                if (key != null) {
                    return { key, offset: top + (offsets[index] ?? 0) - scrollTop };
                }
            }

            return undefined;
        },
        restorePlace: (place, hasKey) => {
            const index = rows.findIndex(row => hasKey(row, place.key));
            if (index < 0) {
                return;
            }

            options.scroller.scrollTop = listTop() + (offsets[index] ?? 0) - place.offset;
            update();
        },
        renderedRows: () => [...rendered.entries()]
            .sort(([left], [right]) => left - right)
            .map(([index, row]) => ({ index, element: row, row: rows[index] as Row })),
        dispose: () => {
            options.scroller.removeEventListener('scroll', scheduleUpdate);
            resizeObserver?.disconnect();
            if (frame != null && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(frame);
            }

            releaseAll();
        },
    };
}
