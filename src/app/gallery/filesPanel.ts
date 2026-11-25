import type { Direction, FileRecord, GalleryGroup, GalleryItem, GalleryStatus } from '../../client/clientTypes.js';
import { toGalleryItem } from '../../client/gallery.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { categoryOf } from '../fileIcon.js';
import { formatCount, formatDay, formatMonth, formatPercent, formatSize } from '../format.js';
import { openFileDetails } from '../history/fileDetails.js';
import { createVirtualList } from '../history/virtualList.js';
import type { ListPlace, VirtualList } from '../history/virtualList.js';
import { ICONS } from '../icons.js';
import { createThrottle } from '../throttle.js';
import { describeClientError } from '../transfers/fileActions.js';
import type { FileActions } from '../transfers/fileActions.js';
import { peerNameFor } from '../transfers/fileErrors.js';
import { exceptionStatus, fileStatus, isDownloaded, listStatus, percentOf } from '../transfers/fileStatus.js';
import { activeCount, EMPTY_FILTER, filterLabels, filterStatusOf, matchesFilter } from './fileFilter.js';
import type { FileFilter } from './fileFilter.js';
import { createSearchField, matchesSearch, searchWords } from './fileSearch.js';
import { createGalleryList } from './galleryList.js';
import type { GalleryList } from './galleryList.js';
import { buildRows, cellSizeFor, columnsFor, CELL_GAP, flattenItems, rowHasFile, rowHeightFor } from './galleryLayout.js';
import type { GalleryRow } from './galleryLayout.js';
import { createSelection } from './gallerySelection.js';
import { createGalleryTile } from './galleryTile.js';
import type { GalleryTile, TileStatus, TileView } from './galleryTile.js';
import { openGalleryViewer } from './galleryViewer.js';
import { openRowMenu } from './rowMenu.js';
import { createSelectionControls, hiddenText } from './selectionControls.js';
import { openViewSheet } from './viewSheet.js';
import type { FilesGroupBy, FilesView } from './viewSheet.js';

// The Sent and Received tabs (§4.5, §18.3): one session's files of one direction, as a List of rows or as
// Tiles (the virtualised thumbnail grid, GL-01), grouped by day or by month. The toolbar is
// [Search] [Select] [View & filter]: the sheet behind the last one sets the grouping, the view and the Type and
// Status filters, and a "Filtered: … Clear" line above the list says what hides files. List | Tiles and
// Day | Month are remembered per device; search, filter and selection carry over between them, and switching
// keeps the same item at the top. Rows and tiles follow live progress and state in place; only files new to
// the tab reload the lists.

export interface FilesPanelOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    readonly sessionId: string;
    readonly direction: Direction;
    readonly scroller: HTMLElement;
}

export interface FilesPanel {
    readonly element: HTMLElement;
    // Only this batch's files (a batch card's Show in Received / Sent), or all of them again.
    setBatch(batchId: string | undefined): void;
    reloadAsync(): Promise<void>;
    dispose(): void;
}

export const FILES_VIEW_KEY = 'ether.files.view';
export const FILES_GROUP_BY_KEY = 'ether.files.groupBy';

type ItemTest = (item: GalleryItem) => boolean;

// A tile's status in the List's words while its file's record isn't loaded.
const GALLERY_STATUS: Readonly<Record<GalleryStatus, TileStatus>> = Object.freeze({
    waiting: { text: 'Waiting', tone: 'muted' },
    receiving: { text: 'Receiving', tone: 'accent' },
    received: { text: 'Not downloaded yet', tone: 'warn' },
    saved: { text: 'Downloaded', tone: 'ok' },
    failed: { text: 'Failed', tone: 'fail' },
    queued: { text: 'Not sent yet', tone: 'muted' },
    sending: { text: 'Sending', tone: 'accent' },
    sent: { text: 'Sent', tone: 'ok' },
});

// The plain ends of a transfer, which have no tag, and Downloaded, which has its ✓ instead.
const UNTAGGED_STATUSES: readonly GalleryStatus[] = ['received', 'saved', 'sent'];

const MOVING_STATUSES: readonly GalleryStatus[] = ['receiving', 'sending'];

// The item as the client would list it now: status, progress and stored data from the file's latest record.
// A thumbnail never goes away, and the client flags one without a record event (it says 'thumb' instead), so
// a record from an event may not know of it yet.
function refreshItem(item: GalleryItem, record: FileRecord): GalleryItem {
    const latest = toGalleryItem(record);
    const { progress: _, ...rest } = item;

    return {
        ...rest,
        status: latest.status,
        ...(latest.progress == null ? {} : { progress: latest.progress }),
        hasThumbnail: item.hasThumbnail || latest.hasThumbnail,
        hasData: latest.hasData,
    };
}

function readChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
    try {
        const stored = localStorage.getItem(key);

        return choices.find(choice => choice === stored) ?? fallback;
    } catch {
        return fallback;
    }
}

function storeChoice(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // The choice then lasts for this screen only.
    }
}

// Day groups as the client returns them, or merged into months ('YYYY-MM') or years ('YYYY'), newest first
// either way. A group without a date keeps its own key.
export function groupFiles(groups: readonly GalleryGroup[], groupBy: FilesGroupBy): GalleryGroup[] {
    if (groupBy === 'day') {
        return [...groups];
    }

    const keyLength = groupBy === 'month' ? 7 : 4;
    const merged = new Map<string, GalleryItem[]>();
    for (const group of groups) {
        const key = /^\d{4}-\d{2}-\d{2}$/.test(group.day) ? group.day.slice(0, keyLength) : group.day;
        merged.set(key, [...(merged.get(key) ?? []), ...group.items]);
    }

    return [...merged].map(([day, items]) => ({ day, items }));
}

// "Mon 23 Nov 2026", "November 2026" or "2026".
export function groupLabel(key: string): string {
    if (/^\d{4}$/.test(key)) {
        return key;
    }

    return /^\d{4}-\d{2}$/.test(key) ? formatMonth(key) : formatDay(key);
}

export function createFilesPanel(options: FilesPanelOptions): FilesPanel {
    const { context, actions, sessionId, direction } = options;
    const isIncoming = direction === 'in';
    const selection = createSelection();
    // The tiles on screen, by file, and the ones whose row has just left it.
    const tiles = new Map<string, GalleryTile>();
    const releasedTiles = new Set<string>();
    let isReleaseScheduled = false;
    let batchId: string | undefined;
    // What the client returned, kept up to date from the tracker, and what the filter and the grouping make
    // of it.
    let loadedGroups: GalleryGroup[] = [];
    let loadedById = new Map<string, GalleryItem>();
    let groups: GalleryGroup[] = [];
    let items: GalleryItem[] = [];
    let columns = 4;
    let cellSize = 84;
    let isDisposed = false;
    let view: FilesView = readChoice<FilesView>(FILES_VIEW_KEY, ['list', 'tiles'], 'list');
    let groupBy: FilesGroupBy = readChoice<FilesGroupBy>(FILES_GROUP_BY_KEY, ['day', 'month', 'year'], 'month');
    // The files' records: the List view's rows and what Download ZIP and Delete may take.
    let records = new Map<string, FileRecord>();
    let list: GalleryList | undefined;

    // The Type and Status boxes of the View & filter sheet.
    let filter: FileFilter = EMPTY_FILTER;
    const searchField = createSearchField({ onChange: () => applyFilter() });
    // Selected received items still stored in the app.
    // Stored, verified and not damaged. A file that just finished counts at once: the tracker's latest record
    // wins over the last reload's record and item.
    const isStored = (item: GalleryItem): boolean => {
        const latest = latestRecord(item);

        return latest == null ? item.hasData : latest.state === 'done' && latest.hasData && latest.note !== 'damaged';
    };
    const zippable = (): string[] => items
        .filter(item => selection.has(item.fileId) && item.direction === 'in' && isStored(item))
        .map(item => item.fileId);
    const controls = createSelectionControls({
        context,
        selection,
        orderedIds: () => items.map(item => item.fileId),
        zippableIds: zippable,
        onSelectingChange: isOn => {
            element.dataset.selecting = String(isOn);
            selectionBar.hidden = !isOn;
            syncSelectionMarks();
        },
        onZip: () => void zipSelectionAsync(),
        groupNoun: () => groupBy,
        groupLabel,
    });
    // Selected received items stored in the app, for Delete (N).
    const deletable = (): GalleryItem[] => items
        .filter(item => selection.has(item.fileId) && item.direction === 'in' && isStored(item));
    const deleteLabel = hiddenText('Delete');
    const deleteSelected = h('button', {
        class: 'icon-button selection-delete',
        dataset: { action: 'delete-selected', tooltip: 'Delete' },
        attrs: { type: 'button', hidden: !isIncoming },
        children: [h('span', { class: 'button-icon', html: ICONS.trash }), deleteLabel],
        on: { click: () => void deleteSelectionAsync() },
    });
    controls.zip.hidden = !isIncoming;
    // Sticky at the bottom of the view while selecting.
    const selectionBar = h('div', {
        class: 'selection-bar',
        attrs: { 'hidden': true, 'role': 'toolbar', 'aria-label': 'Selection' },
        children: [controls.count, controls.selectAll, controls.range, controls.zip, deleteSelected],
    });
    const viewLabel = hiddenText('View and filter');
    const viewDot = h('span', { class: 'files-view-dot', attrs: { 'aria-hidden': 'true', 'hidden': true } });
    const viewButton = h('button', {
        class: 'icon-button files-tool',
        dataset: { action: 'view', tooltip: 'View and filter' },
        attrs: { 'type': 'button', 'aria-haspopup': 'dialog' },
        children: [h('span', { class: 'button-icon', html: ICONS.sliders }), viewLabel, viewDot],
        on: { click: () => openView() },
    });
    const toolbar = h('div', {
        class: 'files-toolbar',
        children: [searchField.element, controls.selectButton, viewButton],
    });
    // "Filtered: This batch · Photos · Failed  Clear", while anything but the search hides files.
    const filteredText = h('span', { class: 'files-filtered-text' });
    const filtered = h('div', {
        class: 'files-filtered',
        attrs: { hidden: true },
        children: [
            filteredText,
            h('button', {
                class: 'files-link',
                text: 'Clear',
                dataset: { action: 'clear-filtered' },
                attrs: { 'type': 'button', 'aria-label': 'Clear filters' },
                on: {
                    click: () => {
                        clearFiltered();
                        viewButton.focus();
                    },
                },
            }),
        ],
    });
    const emptyText = h('p', { class: 'files-empty-text' });
    const clearSearch = h('button', {
        class: 'button button-small',
        text: 'Clear search',
        dataset: { action: 'clear-search' },
        attrs: { type: 'button' },
        on: {
            click: () => {
                searchField.clear();
                searchField.focus();
            },
        },
    });
    // Once clearing the filters brings files back, the note and this button go, so focus moves to the search.
    const clearFilters = h('button', {
        class: 'button button-small',
        text: 'Clear filters',
        dataset: { action: 'clear-filters' },
        attrs: { type: 'button', hidden: true },
        on: {
            click: () => {
                setFilter(EMPTY_FILTER);
                if (empty.hidden) {
                    searchField.focus();
                }
            },
        },
    });
    const emptyActions = h('div', {
        class: 'files-empty-actions',
        attrs: { hidden: true },
        children: [clearSearch, clearFilters],
    });
    const empty = h('div', {
        class: 'empty-note files-empty',
        attrs: { hidden: true },
        children: [emptyText, emptyActions],
    });
    const grid: VirtualList<GalleryRow> = createVirtualList<GalleryRow>({
        scroller: options.scroller,
        className: 'gallery-grid',
        role: 'grid',
        label: 'Files',
        rowHeight: row => rowHeightFor(row, cellSize),
        renderRow: row => (row.kind === 'header' ? renderGridHeader(row) : renderCells(row)),
        releaseRow: rowElement => releaseTiles(rowElement),
    });
    const element = h('div', {
        class: 'files-panel',
        dataset: { view, groupBy },
        children: [toolbar, filtered, empty, grid.element, selectionBar],
    });

    // The Type and Status boxes over one item, with its record when loaded.
    const isShownBy = (item: GalleryItem, record: FileRecord | undefined): boolean => matchesFilter(
        filter,
        categoryOf(item),
        filterStatusOf(item, record),
    );

    // The file's latest record: the tracker's, else the one the last reload brought.
    const latestRecord = (item: GalleryItem): FileRecord | undefined => context.tracker.getRecord(item)
        ?? records.get(item.fileId);

    // A group's header in either view: "Today 12", and Select day or month while selecting.
    const renderGroupHeader = (key: string, ids: readonly string[]): HTMLElement => h('div', {
        class: 'gallery-day',
        children: [
            h('h3', { class: 'gallery-day-title', text: groupLabel(key) }),
            h('span', {
                class: 'gallery-day-count',
                children: [ids.length.toLocaleString('en'), hiddenText(ids.length === 1 ? ' item' : ' items')],
            }),
            controls.groupButton(key, ids),
        ],
    });

    // Details for a row or a tile: its preview opens the full-size viewer at that file.
    const openDetails = (record: FileRecord): void => {
        openFileDetails({
            context,
            actions,
            record,
            onView: () => openViewer(record.fileId),
            onChanged: () => void reloadAsync(),
        });
    };

    const openViewer = (fileId: string): void => {
        const index = items.findIndex(other => other.fileId === fileId);
        if (index < 0) {
            return;
        }

        openGalleryViewer({ context, actions, sessionId, items, index, onChanged: () => void reloadAsync() });
    };

    const createList = (): GalleryList => createGalleryList({
        context,
        actions,
        scroller: options.scroller,
        selectable: { pick: (record, isShift) => controls.pick(record.fileId, isShift) },
        onDetails: openDetails,
        isSelecting: () => controls.isSelecting,
        isSelected: fileId => selection.has(fileId),
        renderHeader: renderGroupHeader,
    });

    const openView = (): void => {
        openViewSheet({
            context,
            direction,
            view,
            groupBy,
            filter,
            onView: setView,
            onGroupBy: setGroupBy,
            onFilter: setFilter,
        });
    };

    // A row that leaves the screen takes its tiles and their thumbnails with it (GL-02), unless the same pass
    // draws them again: a new layout releases every row and at once draws the ones in view with the same tiles.
    const flushReleasedTiles = (): void => {
        isReleaseScheduled = false;
        for (const fileId of releasedTiles) {
            tiles.get(fileId)?.dispose();
            tiles.delete(fileId);
        }

        releasedTiles.clear();
    };

    const releaseTiles = (rowElement: HTMLElement): void => {
        for (const cell of rowElement.querySelectorAll<HTMLElement>('.gallery-cell')) {
            releasedTiles.add(cell.dataset.fileId ?? '');
        }

        if (!isReleaseScheduled) {
            isReleaseScheduled = true;
            queueMicrotask(flushReleasedTiles);
        }
    };

    const renderGridHeader = (row: Extract<GalleryRow, { kind: 'header' }>): HTMLElement => {
        const header = renderGroupHeader(row.day, row.items.map(item => item.fileId));
        header.setAttribute('role', 'row');
        header.querySelector('.gallery-day-title')?.setAttribute('role', 'rowheader');

        return header;
    };

    // A tile says what the List row says, from the file's latest record or from the item until it is loaded:
    // a tag only for an exception or a moving file's percent, and a ✓ once downloaded. A moving file's ring
    // follows the live progress, then the progress its record was loaded with.
    const tileViewOf = (item: GalleryItem): TileView => {
        const record = latestRecord(item);
        const peer = peerNameFor(context, sessionId);
        const status: TileStatus = record == null ? GALLERY_STATUS[item.status] : listStatus(record, peer);
        const isDone = record == null ? item.status === 'saved' : isDownloaded(record);
        const exception = record == null
            ? (UNTAGGED_STATUSES.includes(item.status) ? undefined : status)
            : exceptionStatus(record, peer);
        const live = context.tracker.getProgress(item);
        const pages = record?.pagination;
        const recorded = pages != null && pages.totalPages > 0 ? pages.pagesDone / pages.totalPages : item.progress;
        const progress = live == null ? recorded ?? 0 : percentOf(live) / 100;
        const hasRing = MOVING_STATUSES.includes(item.status);
        const isActive = record == null ? hasRing : fileStatus(record, peer).isMoving;
        const percent: TileStatus = { text: formatPercent(progress * 100), tone: 'accent' };

        return {
            item,
            status,
            tag: isDone ? undefined : (isActive ? percent : exception),
            isDownloaded: isDone,
            progress: hasRing ? progress : undefined,
            isSelected: controls.isSelecting ? selection.has(item.fileId) : undefined,
        };
    };

    // A file's tile is drawn once and then updated, by a new layout as by progress.
    const renderCell = (rowItem: GalleryItem, index: number): HTMLElement => {
        const item = loadedById.get(rowItem.fileId) ?? rowItem;
        let tile = tiles.get(item.fileId);
        if (tile == null) {
            tile = createGalleryTile({ context, onClick: (fileId, event) => onCellClick(fileId, event) });
            tiles.set(item.fileId, tile);
        }

        releasedTiles.delete(item.fileId);
        tile.element.dataset.index = String(index);
        tile.update(tileViewOf(item));

        return tile.element;
    };

    const updateTiles = (fileIds: Iterable<string>): void => {
        for (const fileId of new Set(fileIds)) {
            const tile = tiles.get(fileId);
            const item = loadedById.get(fileId);
            if (tile != null && item != null) {
                tile.update(tileViewOf(item));
            }
        }
    };

    const renderCells = (row: Extract<GalleryRow, { kind: 'cells' }>): HTMLElement => {
        const rowElement = h('div', {
            class: 'gallery-row',
            attrs: { role: 'row' },
            children: row.items.map((item, offset) => renderCell(item, row.firstIndex + offset)),
        });
        rowElement.style.setProperty('--columns', String(columns));
        rowElement.style.setProperty('--cell-size', `${cellSize}px`);

        return rowElement;
    };

    // A tile opens what a row opens: a finished file's Details, an unfinished one's actions; while selecting,
    // or with Shift, it picks itself. A file whose record isn't loaded yet opens the viewer.
    const onCellClick = (fileId: string, event: MouseEvent): void => {
        if (controls.isSelecting || event.shiftKey) {
            controls.pick(fileId, event.shiftKey);

            return;
        }

        const item = loadedById.get(fileId);
        const record = item == null ? records.get(fileId) : latestRecord(item);
        if (record == null) {
            openViewer(fileId);

            return;
        }

        if (record.state === 'done' && record.note !== 'moved') {
            openDetails(record);

            return;
        }

        openRowMenu({
            context,
            actions,
            record: () => (item == null ? undefined : latestRecord(item)) ?? record,
            onDetails: openDetails,
        });
    };

    const syncSelectionMarks = (): void => {
        for (const cell of grid.element.querySelectorAll<HTMLElement>('.gallery-cell')) {
            const fileId = cell.dataset.fileId ?? '';
            if (controls.isSelecting) {
                cell.setAttribute('aria-selected', String(selection.has(fileId)));
            } else {
                cell.removeAttribute('aria-selected');
            }
        }

        list?.syncSelection();
        controls.sync(element, new Map(groups.map(group => [group.day, group.items.map(item => item.fileId)])));
        const deleteCount = deletable().length;
        deleteLabel.textContent = deleteCount === 0 ? 'Delete' : `Delete (${deleteCount.toLocaleString('en')})`;
        deleteSelected.disabled = deleteCount === 0;
    };

    const zipSelectionAsync = async (): Promise<void> => {
        const fileIds = zippable();
        if (fileIds.length === 0) {
            return;
        }

        controls.zip.disabled = true;
        try {
            if (await actions.downloadZipAsync(fileIds, sessionId)) {
                controls.setSelecting(false);
            }
        } finally {
            controls.zip.disabled = false;
        }
    };

    // Nothing is ever deleted by itself: the user picks the files and confirms with their count and size.
    const deleteSelectionAsync = async (): Promise<void> => {
        const chosen = deletable();
        if (chosen.length === 0) {
            return;
        }

        const bytes = chosen.reduce((total, item) => total + item.size, 0);
        const isConfirmed = await context.dialogs.confirmAsync({
            title: `Delete ${formatCount(chosen.length, 'received file')} (${formatSize(bytes)}) from the app?`,
            message: 'Downloaded ZIPs keep their copies.',
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!isConfirmed) {
            return;
        }

        try {
            await context.client.deleteReceivedManyAsync(sessionId, chosen.map(item => item.fileId));
            context.dialogs.toast(`Deleted ${formatCount(chosen.length, 'file')}.`, { tone: 'ok' });
        } catch (error) {
            context.dialogs.toast(describeClientError(error), { tone: 'fail' });
        }

        selection.clear();
        context.notifyDataChanged();
    };

    const measure = (): boolean => {
        const width = grid.element.clientWidth > 0 ? grid.element.clientWidth : options.scroller.clientWidth;
        if (width <= 0) {
            return false;
        }

        const nextColumns = columnsFor(width);
        const nextCellSize = cellSizeFor(width, nextColumns, CELL_GAP);
        const isChanged = nextColumns !== columns || Math.abs(nextCellSize - cellSize) > 0.5;
        columns = nextColumns;
        cellSize = nextCellSize;

        return isChanged;
    };

    // The reader's place: the first file at the top of the view and its distance from there, by file ID, so it
    // carries over between List and Tiles and across regrouping.
    const capturePlace = (): ListPlace | undefined => (view === 'list'
        ? list?.place()
        : grid.place(row => (row.kind === 'cells' ? row.items[0]?.fileId : undefined)));

    // GL-01: on rotation, when switching view or grouping, and when files are added or regrouped above the reader,
    // the file they look at stays where it is; files added below move nothing.
    const layout = (place: ListPlace | undefined): void => {
        if (view === 'list') {
            // The hidden grid draws nothing while the list is shown.
            grid.setRows([]);
            list?.setGroups(groups, records);
            if (place != null) {
                list?.restorePlace(place);
            }

            return;
        }

        grid.setRows(buildRows(groups, columns));
        if (place != null) {
            grid.restorePlace(place, rowHasFile);
        }
    };

    // Why nothing shows. With a search typed, the filters share the blame when they hide what the search finds,
    // or hide everything by themselves; the note then offers to clear either.
    const syncEmpty = (isSearching: boolean, isFiltered: ItemTest, isFound: ItemTest): void => {
        empty.hidden = items.length > 0;
        if (empty.hidden) {
            return;
        }

        const hasFilters = activeCount(filter) > 0;
        emptyActions.hidden = !isSearching;
        if (!isSearching) {
            emptyText.textContent = hasFilters || batchId != null
                ? 'No files match these filters.'
                : (isIncoming ? 'Nothing received yet.' : 'Nothing sent yet.');

            return;
        }

        const loaded = flattenItems(loadedGroups);
        const isFiltersToo = hasFilters && (loaded.some(isFound) || !loaded.some(isFiltered));
        const query = searchField.query.trim();
        emptyText.textContent = isFiltersToo
            ? `No files match “${query}” with these filters.`
            : `No files match “${query}”.`;
        clearFilters.hidden = !isFiltersToo;
    };

    // A search shortens the list, and a shorter page would pull the view, and the field with it, down under the
    // reader's finger. While a search is typed, the panel keeps at least the height that holds the view still;
    // the hold goes only once the rows are back, or the page would shrink for a moment and lose the place.
    const holdView = (): void => {
        if (element.getClientRects().length === 0) {
            return;
        }

        const { scroller } = options;
        const panelTop = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            + scroller.scrollTop;
        const height = scroller.scrollTop + scroller.clientHeight - panelTop;
        element.style.setProperty('min-block-size', `${Math.max(0, Math.ceil(height))}px`);
    };

    // The search and the Type and Status boxes over the loaded rows, then the grouping; Select all, Select day
    // or month, Download ZIP and Delete then act on what is shown.
    const applyFilter = (place: ListPlace | undefined = capturePlace()): void => {
        const words = searchWords(searchField.query);
        const isFiltered: ItemTest = item => isShownBy(item, records.get(item.fileId));
        const isFound: ItemTest = item => {
            const folderPath = records.get(item.fileId)?.relativePath;

            return matchesSearch(words, [item.name, folderPath]);
        };
        const shown = loadedGroups
            .map(group => ({ ...group, items: group.items.filter(item => isFiltered(item) && isFound(item)) }))
            .filter(group => group.items.length > 0);
        groups = groupFiles(shown, groupBy);
        items = flattenItems(groups);
        selection.retain(items.map(item => item.fileId));
        const isSearching = words.length > 0;
        syncEmpty(isSearching, isFiltered, isFound);
        if (isSearching) {
            holdView();
        }

        measure();
        layout(place);
        if (!isSearching) {
            element.style.removeProperty('min-block-size');
        }

        syncSelectionMarks();
    };

    const setLoaded = (next: GalleryGroup[]): void => {
        loadedGroups = next;
        loadedById = new Map(flattenItems(next).map(item => [item.fileId, item]));
    };

    const replaceLoaded = (replace: (item: GalleryItem) => GalleryItem): void => {
        setLoaded(loadedGroups.map(group => ({ ...group, items: group.items.map(replace) })));
    };

    const reloadAsync = async (place?: ListPlace): Promise<void> => {
        const [loaded, files] = await Promise.all([
            context.client.listGalleryAsync({ sessionId, batchId, direction, filter: 'all', groupBy: 'day' }),
            context.client.listFilesAsync({ sessionId, direction }).catch(() => undefined),
        ]);
        if (isDisposed) {
            return;
        }

        if (files != null) {
            records = new Map(files.map(record => [record.fileId, record]));
        }

        // The tracker may already know more than the store said a moment ago.
        setLoaded(loaded.map(group => ({
            ...group,
            items: group.items.map(item => {
                const latest = context.tracker.getRecord(item);

                return latest == null ? item : refreshItem(item, latest);
            }),
        })));
        applyFilter(place ?? capturePlace());
    };

    // Files this tab already lists change in memory: their rows and tiles update themselves, and the list moves
    // only when a change shows or hides a file under the filter, keeping the reader's place.
    const refreshItems = (changed: readonly FileRecord[]): void => {
        const known = new Map(changed
            .filter(record => records.has(record.fileId))
            .map(record => [record.fileId, record]));
        if (known.size === 0) {
            return;
        }

        const before = new Map(records);
        let isMoved = false;
        for (const record of known.values()) {
            records.set(record.fileId, record);
        }

        replaceLoaded(item => {
            const record = known.get(item.fileId);
            if (record == null) {
                return item;
            }

            const refreshed = refreshItem(item, record);
            isMoved ||= isShownBy(refreshed, record) !== isShownBy(item, before.get(item.fileId));

            return refreshed;
        });
        if (isMoved) {
            applyFilter();

            return;
        }

        const latest = (item: GalleryItem): GalleryItem => loadedById.get(item.fileId) ?? item;
        groups = groups.map(group => ({ ...group, items: group.items.map(latest) }));
        items = flattenItems(groups);
        updateTiles(known.keys());
    };

    const setView = (next: FilesView): void => {
        if (next === view) {
            return;
        }

        const place = capturePlace();
        view = next;
        storeChoice(FILES_VIEW_KEY, next);
        element.dataset.view = next;
        if (next === 'list') {
            list = createList();
            grid.element.replaceWith(list.element);
            void reloadAsync(place);

            return;
        }

        list?.element.replaceWith(grid.element);
        list?.dispose();
        list = undefined;
        measure();
        layout(place);
        syncSelectionMarks();
    };

    const setGroupBy = (next: FilesGroupBy): void => {
        if (next === groupBy) {
            return;
        }

        const place = capturePlace();
        groupBy = next;
        storeChoice(FILES_GROUP_BY_KEY, next);
        element.dataset.groupBy = next;
        applyFilter(place);
    };

    // The dot on View & filter and the "Filtered: …" line say whether anything but the search hides files.
    const syncFiltered = (): void => {
        const labels = [...(batchId == null ? [] : ['This batch']), ...filterLabels(filter, direction)];
        const count = activeCount(filter) + (batchId == null ? 0 : 1);
        viewDot.hidden = count === 0;
        viewLabel.textContent = count === 0
            ? 'View and filter'
            : `View and filter, ${formatCount(count, 'filter')} on`;
        filtered.hidden = labels.length === 0;
        filteredText.textContent = `Filtered: ${labels.join(' · ')}`;
    };

    const setFilter = (next: FileFilter): void => {
        filter = next;
        syncFiltered();
        applyFilter();
    };

    const setBatch = (next: string | undefined): void => {
        batchId = next;
        syncFiltered();
        void reloadAsync();
    };

    // The line's Clear: every Type and Status box, and a batch card's Show in Received or Sent.
    const clearFiltered = (): void => {
        filter = EMPTY_FILTER;
        if (batchId != null) {
            setBatch(undefined);

            return;
        }

        syncFiltered();
        applyFilter();
    };

    // At most one reload every half second: files arriving one after another show up while the batch still runs.
    const reload = createThrottle(() => {
        void reloadAsync();
    }, 500);

    // Escape clears the selection first, then leaves selecting; an open dialog or the viewer gets it instead.
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || event.defaultPrevented || !controls.isSelecting || !element.isConnected || element.closest('[hidden]') != null) {
            return;
        }

        if (document.querySelector('.dialog-backdrop') != null) {
            return;
        }

        event.preventDefault();
        if (selection.size > 0) {
            selection.clear();

            return;
        }

        controls.setSelecting(false);
    };
    document.addEventListener('keydown', onKeyDown);

    const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            const place = capturePlace();
            if (measure()) {
                layout(place);
            }
        })
        : undefined;
    resizeObserver?.observe(grid.element);

    const unsubscribers = [
        selection.onChange(syncSelectionMarks),
        context.tracker.onChange(change => {
            const mine = change.records.filter(record => record.sessionId === sessionId && record.direction === direction);
            const progressHere = change.progress.filter(progress => progress.sessionId === sessionId && progress.direction === direction);
            // Rows and tiles update in place from live events; only a file new to this tab reloads the lists.
            list?.updateRecords(mine);
            list?.updateProgress(progressHere);
            if (mine.some(record => !records.has(record.fileId))) {
                reload.schedule();
            }

            refreshItems(mine);
            updateTiles(progressHere.map(progress => progress.fileId));
            if (mine.length > 0 && controls.isSelecting) {
                syncSelectionMarks();
            }
        }),
        context.client.on('thumb', (fileId, thumbSessionId) => {
            if (thumbSessionId !== sessionId) {
                return;
            }

            list?.refreshThumbnail(fileId);
            tiles.get(fileId)?.loadThumbnail();
            // A tile drawn later, once scrolled to, loads it too.
            if (loadedById.get(fileId)?.hasThumbnail === false) {
                replaceLoaded(item => (item.fileId === fileId ? { ...item, hasThumbnail: true } : item));
            }
        }),
        context.onDataChanged(() => reload.schedule()),
    ];

    if (view === 'list') {
        list = createList();
        grid.element.replaceWith(list.element);
    }

    void reloadAsync();

    return {
        element,
        setBatch,
        reloadAsync: () => reloadAsync(),
        dispose: () => {
            isDisposed = true;
            reload.cancel();
            searchField.dispose();
            document.removeEventListener('keydown', onKeyDown);
            resizeObserver?.disconnect();
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            grid.dispose();
            list?.dispose();
            for (const tile of tiles.values()) {
                tile.dispose();
            }

            tiles.clear();
        },
    };
}
