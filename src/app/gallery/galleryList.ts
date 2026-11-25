import type { FileRecord, GalleryGroup, GalleryItem, ProgressInfo } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { createVirtualList } from '../history/virtualList.js';
import type { ListPlace, VirtualList } from '../history/virtualList.js';
import type { FileActions } from '../transfers/fileActions.js';
import type { FileRow, RowSelectable } from '../transfers/fileRow.js';
import { recordKey } from '../transfers/transferTracker.js';
import { DAY_HEADER_HEIGHT } from './galleryLayout.js';
import { createGalleryRow, LIST_ROW_HEIGHT } from './galleryRow.js';

// The List view of the Sent and Received tabs: rows (thumbnail or icon, name, size · date and any exception,
// ⋯, a bar while moving) under day or month headers, each group drawn as one card, virtualised. Rows need the
// files' records for their actions; an item without one is left out.

export interface GalleryListOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    readonly scroller: HTMLElement;
    readonly selectable: RowSelectable;
    readonly onDetails: (record: FileRecord) => void;
    isSelecting(): boolean;
    isSelected(fileId: string): boolean;
    // A group's header, with its title, count and Select day or month.
    renderHeader(key: string, ids: readonly string[]): HTMLElement;
}

export interface GalleryList {
    readonly element: HTMLElement;
    setGroups(groups: readonly GalleryGroup[], records: ReadonlyMap<string, FileRecord>): void;
    // The reader's place, by file, and putting it back after the rows changed.
    place(): ListPlace | undefined;
    restorePlace(place: ListPlace): void;
    syncSelection(): void;
    updateRecords(records: readonly FileRecord[]): void;
    updateProgress(items: readonly ProgressInfo[]): void;
    // A thumbnail the client prepared after the row was drawn.
    refreshThumbnail(fileId: string): void;
    dispose(): void;
}

// Where a row sits in its group's card: the first and last rows carry its rounded edges.
type CardEdge = 'first' | 'middle' | 'last' | 'only';

type ListRow =
    | { readonly kind: 'header'; readonly day: string; readonly ids: readonly string[] }
    | { readonly kind: 'file'; readonly item: GalleryItem; readonly record: FileRecord; readonly edge: CardEdge };

function edgeOf(index: number, count: number): CardEdge {
    if (count === 1) {
        return 'only';
    }

    if (index === 0) {
        return 'first';
    }

    return index === count - 1 ? 'last' : 'middle';
}

export function createGalleryList(options: GalleryListOptions): GalleryList {
    const { context, actions } = options;
    const rows = new Map<string, FileRow>();

    const renderHeader = (row: Extract<ListRow, { kind: 'header' }>): HTMLElement => {
        const header = options.renderHeader(row.day, row.ids);
        header.setAttribute('role', 'listitem');

        return header;
    };

    const renderFile = (row: Extract<ListRow, { kind: 'file' }>): HTMLElement => {
        const fileRow = createGalleryRow({
            context,
            actions,
            selectable: options.selectable,
            onDetails: options.onDetails,
        });
        const record = context.tracker.getRecord(row.record) ?? row.record;
        fileRow.update(record, context.tracker.getProgress(record));
        if (row.item.hasThumbnail && !record.hasThumbnail) {
            fileRow.refreshThumbnail?.();
        }

        fileRow.element.dataset.fileId = record.fileId;
        fileRow.element.dataset.edge = row.edge;
        fileRow.setSelection(options.isSelecting(), options.isSelected(record.fileId));
        rows.set(recordKey(record), fileRow);

        return fileRow.element;
    };

    const list: VirtualList<ListRow> = createVirtualList<ListRow>({
        scroller: options.scroller,
        className: 'file-list virtual-list gallery-list',
        role: 'list',
        label: 'Files',
        rowHeight: row => (row.kind === 'header' ? DAY_HEADER_HEIGHT : LIST_ROW_HEIGHT),
        renderRow: row => (row.kind === 'header' ? renderHeader(row) : renderFile(row)),
        releaseRow: (_, row) => {
            if (row.kind === 'file') {
                rows.get(recordKey(row.record))?.dispose();
                rows.delete(recordKey(row.record));
            }
        },
    });

    return {
        element: list.element,
        setGroups: (groups, records) => {
            const next = groups.flatMap((group): ListRow[] => {
                const found = group.items.flatMap(item => {
                    const record = records.get(item.fileId);

                    return record == null ? [] : [{ item, record }];
                });
                const files = found.map((file, index): ListRow => ({
                    kind: 'file',
                    ...file,
                    edge: edgeOf(index, found.length),
                }));

                return files.length === 0
                    ? []
                    : [{ kind: 'header', day: group.day, ids: found.map(file => file.item.fileId) }, ...files];
            });
            list.setRows(next);
        },
        place: () => list.place(row => (row.kind === 'file' ? row.item.fileId : undefined)),
        restorePlace: place => list.restorePlace(place, (row, key) => row.kind === 'file' && row.item.fileId === key),
        syncSelection: () => {
            for (const row of rows.values()) {
                row.setSelection(options.isSelecting(), options.isSelected(row.element.dataset.fileId ?? ''));
            }
        },
        updateRecords: records => {
            for (const record of records) {
                rows.get(recordKey(record))?.update(record, context.tracker.getProgress(record));
            }
        },
        updateProgress: items => {
            for (const item of items) {
                rows.get(recordKey(item))?.setProgress(item);
            }
        },
        refreshThumbnail: fileId => {
            for (const row of rows.values()) {
                if (row.element.dataset.fileId === fileId) {
                    row.refreshThumbnail?.();
                }
            }
        },
        dispose: () => {
            for (const row of rows.values()) {
                row.dispose();
            }

            rows.clear();
            list.dispose();
        },
    };
}
