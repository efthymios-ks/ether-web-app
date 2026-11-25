import type { GalleryGroup, GalleryItem } from '../../client/clientTypes.js';

// GL-01, GL-03: columns by width (cells ≥ 80 px), day headers, and rows of cells for the virtual list.

export const MIN_CELL_SIZE = 84;
export const CELL_GAP = 4;
export const DAY_HEADER_HEIGHT = 52;

export type GalleryRow =
    | { readonly kind: 'header'; readonly day: string; readonly items: readonly GalleryItem[] }
    | { readonly kind: 'cells'; readonly day: string; readonly items: readonly GalleryItem[]; readonly firstIndex: number };

export function columnsFor(width: number, minCell: number = MIN_CELL_SIZE, gap: number = CELL_GAP): number {
    return Math.max(1, Math.floor((width + gap) / (minCell + gap)));
}

export function cellSizeFor(width: number, columns: number, gap: number = CELL_GAP): number {
    return Math.max(1, (width - gap * (columns - 1)) / columns);
}

export function buildRows(groups: readonly GalleryGroup[], columns: number): GalleryRow[] {
    const rows: GalleryRow[] = [];
    let index = 0;
    for (const group of groups) {
        if (group.items.length === 0) {
            continue;
        }

        rows.push({ kind: 'header', day: group.day, items: group.items });
        for (let start = 0; start < group.items.length; start += columns) {
            rows.push({ kind: 'cells', day: group.day, items: group.items.slice(start, start + columns), firstIndex: index + start });
        }

        index += group.items.length;
    }

    return rows;
}

export function rowHeightFor(row: GalleryRow, cellSize: number, gap: number = CELL_GAP): number {
    return row.kind === 'header' ? DAY_HEADER_HEIGHT : cellSize + gap;
}

// The row that holds an item, so rotating keeps the same item in view (GL-01).
// Whether a row of tiles holds this file: how the reader's place is found again after rotation or regrouping.
export function rowHasFile(row: GalleryRow, fileId: string): boolean {
    return row.kind === 'cells' && row.items.some(item => item.fileId === fileId);
}

export function flattenItems(groups: readonly GalleryGroup[]): GalleryItem[] {
    return groups.flatMap(group => [...group.items]);
}
