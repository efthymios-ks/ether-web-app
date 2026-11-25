import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileRecord, GalleryItem, GalleryStatus, MediaKind, ProgressInfo } from '../../client/clientTypes.js';
import { formatDay, formatMonth } from '../format.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createFileRecord, createSession } from '../testing/fakeClient.js';
import { REDRAW_INTERVAL_MS } from '../transfers/transferTracker.js';
import { FILES_GROUP_BY_KEY, FILES_VIEW_KEY } from './filesPanel.js';
import { SEARCH_DELAY_MS } from './fileSearch.js';

// The Sent and Received tabs: [Search] [Select] [View & filter], with selection that selects and unselects the
// same way everywhere (GL-03), one ZIP (N) or Delete for what was picked, rows and tiles that show only the
// exceptions, and each row's actions in its ⋯ sheet.

let harness: TestApp | undefined;

function item(fileId: string, kind: MediaKind, status: GalleryStatus, size = 1_000_000): GalleryItem {
    return {
        fileId,
        sessionId: 'session-1',
        direction: 'in',
        name: `${fileId}.jpg`,
        mime: 'image/jpeg',
        size,
        kind,
        status,
        hasThumbnail: false,
        hasData: status !== 'receiving',
    };
}

function record(fileId: string, kind: MediaKind, overrides: Partial<FileRecord> = {}): FileRecord {
    return createFileRecord({
        fileId,
        name: `${fileId}.jpg`,
        kind,
        direction: 'in',
        state: 'done',
        hasData: true,
        size: 1_000_000,
        ...overrides,
    });
}

function sent(fileId: string, overrides: Partial<FileRecord> = {}): FileRecord {
    return createFileRecord({
        fileId,
        name: `${fileId}.jpg`,
        kind: 'image',
        direction: 'out',
        state: 'done',
        size: 1_000_000,
        ...overrides,
    });
}

const PAGINATION = { pageSize: 1_048_576, totalPages: 10, currentPage: 0, pagesDone: 0, slot: 1 };

// a, b on 23 November; c, m on 22 November; d on 30 October.
const GROUPS = [
    { day: '2026-11-23', items: [item('a', 'image', 'received'), item('b', 'video', 'saved')] },
    { day: '2026-11-22', items: [item('c', 'image', 'received'), item('m', 'image', 'receiving')] },
    { day: '2026-10-30', items: [item('d', 'other', 'received')] },
];
const RECORDS = [
    record('a', 'image'),
    record('b', 'video', { savedAt: 1 }),
    record('c', 'image'),
    record('m', 'image', { state: 'active', hasData: false, pagination: PAGINATION }),
    record('d', 'other'),
];

async function openAsync(view: 'list' | 'tiles' = 'list', groupBy: 'day' | 'month' | 'year' = 'day'): Promise<TestApp> {
    localStorage.setItem(FILES_VIEW_KEY, view);
    localStorage.setItem(FILES_GROUP_BY_KEY, groupBy);
    harness = createTestApp({ client: { sessions: [createSession()], gallery: GROUPS, files: RECORDS } });
    await harness.app.startAsync();
    harness.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'received' });
    await settleAsync(300);

    return harness;
}

function panel(root: HTMLElement, tab: FilesTab = 'received'): HTMLElement {
    return root.querySelector<HTMLElement>(`#panel-${tab}`) ?? root;
}

// The sheet on top: View & filter, a row's ⋯ or Details.
function sheet(): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
}

function viewButton(root: HTMLElement, tab: FilesTab = 'received'): HTMLButtonElement | null {
    return panel(root, tab).querySelector<HTMLButtonElement>('[data-action="view"]');
}

function openView(root: HTMLElement, tab: FilesTab = 'received'): HTMLElement | undefined {
    viewButton(root, tab)?.click();

    return sheet();
}

function closeSheet(): void {
    sheet()?.querySelector<HTMLButtonElement>('.files-sheet-close')?.click();
}

// Day, Month, List or Tiles, through the View & filter sheet.
function chooseView(root: HTMLElement, id: string): void {
    openView(root)?.querySelector<HTMLButtonElement>(`[data-choice="${id}"]`)?.click();
    closeSheet();
}

function toggleFilter(root: HTMLElement, label: string, tab: FilesTab = 'received'): void {
    const view = openView(root, tab);
    const option = [...(view?.querySelectorAll<HTMLLabelElement>('.filter-option') ?? [])]
        .find(row => row.textContent === label);
    option?.querySelector<HTMLInputElement>('input')?.click();
    closeSheet();
}

function select(root: HTMLElement): void {
    panel(root).querySelector<HTMLButtonElement>('[data-action="select"]')?.click();
}

function listed(root: HTMLElement, tab: FilesTab = 'received'): string[] {
    return [...panel(root, tab).querySelectorAll<HTMLElement>('.gallery-list .file-row')].map(row => row.dataset.fileId ?? '');
}

function tiles(root: HTMLElement): string[] {
    return [...panel(root).querySelectorAll<HTMLElement>('.gallery-cell')].map(cell => cell.dataset.fileId ?? '');
}

function selectedInList(root: HTMLElement): string[] {
    return [...panel(root).querySelectorAll<HTMLElement>('.gallery-list .file-row')]
        .filter(row => row.querySelector<HTMLInputElement>('.file-check-box')?.checked === true)
        .map(row => row.dataset.fileId ?? '');
}

function groupButton(root: HTMLElement, key: string): HTMLButtonElement | null {
    return panel(root).querySelector<HTMLButtonElement>(`[data-action="select-group"][data-group="${key}"]`);
}

function headers(root: HTMLElement): string[] {
    return [...panel(root).querySelectorAll('.gallery-day-title')].map(title => title.textContent ?? '');
}

function row(root: HTMLElement, fileId: string, tab: FilesTab = 'received'): HTMLElement | null {
    return panel(root, tab).querySelector<HTMLElement>(`.file-row[data-file-id="${fileId}"]`);
}

describe('Sent and Received', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        vi.unstubAllGlobals();
        localStorage.clear();
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    it('has [Search] [Select] [View & filter], and only three tabs', async () => {
        // Act
        const { root } = await openAsync();

        // Assert
        expect([...root.querySelectorAll('[role="tab"] .tab-label')].map(tab => tab.textContent))
            .toEqual(['Send', 'Received', 'Sent']);
        const toolbar = [...(panel(root).querySelector('.files-toolbar')?.children ?? [])];
        expect(toolbar.map(child => child.className))
            .toEqual(['files-search', 'icon-button files-tool', 'icon-button files-tool']);
        expect(toolbar.slice(1).map(child => child.textContent)).toEqual(['Select', 'View and filter']);
        expect(toolbar.slice(1).map(child => child.querySelector('.icon') != null)).toEqual([true, true]);
        expect(panel(root).querySelector('[data-action="select"]')?.getAttribute('aria-pressed')).toBe('false');
        expect(panel(root).querySelector<HTMLElement>('.files-view-dot')?.hidden).toBe(true);
        expect(panel(root).querySelector<HTMLElement>('.files-filtered')?.hidden).toBe(true);
        expect(listed(root)).toEqual(['a', 'b', 'c', 'm', 'd']);
    });

    it('opens View & filter with Group by, Show as, Type and Status, and applies each change at once', async () => {
        // Arrange
        const { root } = await openAsync();

        // Act
        const view = openView(root);
        const content = {
            title: view?.querySelector('.files-sheet-title')?.textContent,
            groups: [...(view?.querySelectorAll('.segmented') ?? [])].map(group => group.getAttribute('aria-label')),
            segments: [...(view?.querySelectorAll('.segment') ?? [])]
                .map(button => `${button.textContent}:${button.getAttribute('aria-pressed')}`),
            legends: [...(view?.querySelectorAll('legend') ?? [])].map(legend => legend.textContent),
            boxes: [...(view?.querySelectorAll('.filter-option') ?? [])].map(option => option.textContent),
        };
        view?.querySelector<HTMLButtonElement>('[data-choice="month"]')?.click();
        const behind = headers(root);

        // Assert
        expect(content).toEqual({
            title: 'View & filter',
            groups: ['Group by', 'Show as'],
            segments: ['Day:true', 'Month:false', 'Year:false', 'List:true', 'Tiles:false'],
            legends: ['Type', 'Status'],
            boxes: ['Photos', 'Videos', 'Audio', 'Documents', 'Other files', 'Not downloaded', 'Downloaded', 'Failed'],
        });
        expect(behind).toEqual([formatMonth('2026-11'), formatMonth('2026-10')]);
        expect(view?.querySelector('[data-choice="month"]')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('groups by month ("November 2026") with Select month ↔ Unselect month while selecting, remembered per device', async () => {
        // Arrange
        const { root } = await openAsync();

        // Act
        chooseView(root, 'month');
        await settleAsync();
        const isHiddenBeforeSelecting = groupButton(root, '2026-11')?.hidden;
        select(root);
        groupButton(root, '2026-11')?.click();
        const afterSelect = {
            label: groupButton(root, '2026-11')?.textContent,
            name: groupButton(root, '2026-11')?.getAttribute('aria-label'),
            ids: selectedInList(root),
        };

        // Assert
        expect(isHiddenBeforeSelecting).toBe(true);
        expect(afterSelect)
            .toEqual({ label: 'Unselect month', name: `Unselect month: ${formatMonth('2026-11')}`, ids: ['a', 'b', 'c', 'm'] });
        expect(groupButton(root, '2026-10')?.textContent).toBe('Select month');
        expect(groupButton(root, '2026-10')?.hidden).toBe(false);
        expect(localStorage.getItem(FILES_GROUP_BY_KEY)).toBe('month');
    });

    it('groups by year ("2026") with Select year ↔ Unselect year while selecting, remembered per device', async () => {
        // Arrange
        const { root } = await openAsync();

        // Act
        chooseView(root, 'year');
        await settleAsync();
        const titles = headers(root);
        select(root);
        groupButton(root, '2026')?.click();

        // Assert
        expect(titles).toEqual(['2026']);
        expect(groupButton(root, '2026')?.textContent).toBe('Unselect year');
        expect(groupButton(root, '2026')?.getAttribute('aria-label')).toBe('Unselect year: 2026');
        expect(selectedInList(root)).toEqual(['a', 'b', 'c', 'm', 'd']);
        expect(localStorage.getItem(FILES_GROUP_BY_KEY)).toBe('year');
    });

    it('groups by month until the device has chosen otherwise', async () => {
        // Arrange
        localStorage.removeItem(FILES_GROUP_BY_KEY);
        harness = createTestApp({ client: { sessions: [createSession()], gallery: GROUPS, files: RECORDS } });

        // Act
        await harness.app.startAsync();
        harness.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'received' });
        await settleAsync(300);

        // Assert
        expect(headers(harness.root)).toEqual([formatMonth('2026-11'), formatMonth('2026-10')]);
    });

    it('switches List ↔ Tiles keeping the filter and the selection, and remembers it', async () => {
        // Arrange
        const { root } = await openAsync();
        toggleFilter(root, 'Photos');
        select(root);
        row(root, 'c')?.querySelector<HTMLInputElement>('.file-check-box')?.click();

        // Act
        chooseView(root, 'tiles');
        await settleAsync();
        const inTiles = { cells: tiles(root), selected: panel(root).querySelector('.gallery-cell[data-file-id="c"]')?.getAttribute('aria-selected') };
        groupButton(root, '2026-11-23')?.click();
        chooseView(root, 'list');
        await settleAsync(200);

        // Assert
        expect(inTiles).toEqual({ cells: ['a', 'c', 'm'], selected: 'true' });
        expect(listed(root)).toEqual(['a', 'c', 'm']);
        expect(selectedInList(root)).toEqual(['a', 'c']);
        expect(panel(root).querySelector('.selection-bar [data-action="download-zip"]')?.textContent)
            .toBe('Download ZIP (2)');
        expect(localStorage.getItem(FILES_VIEW_KEY)).toBe('list');
    });

    it('puts a dot on View & filter and a "Filtered: … Clear" line above the list while filters are on', async () => {
        // Arrange
        const { root } = await openAsync();

        // Act
        toggleFilter(root, 'Photos');
        toggleFilter(root, 'Failed');
        const whileFiltered = {
            dot: panel(root).querySelector<HTMLElement>('.files-view-dot')?.hidden,
            name: viewButton(root)?.textContent,
            line: panel(root).querySelector<HTMLElement>('.files-filtered')?.hidden,
            text: panel(root).querySelector('.files-filtered-text')?.textContent,
            order: [...panel(root).children].map(child => child.className.split(' ')[0]),
        };
        panel(root).querySelector<HTMLButtonElement>('[data-action="clear-filtered"]')?.click();

        // Assert
        expect(whileFiltered).toEqual({
            dot: false,
            name: 'View and filter, 2 filters on',
            line: false,
            text: 'Filtered: Photos · Failed',
            order: ['files-toolbar', 'files-filtered', 'empty-note', 'file-list', 'selection-bar'],
        });
        expect(panel(root).querySelector<HTMLElement>('.files-view-dot')?.hidden).toBe(true);
        expect(panel(root).querySelector<HTMLElement>('.files-filtered')?.hidden).toBe(true);
        expect(listed(root)).toEqual(['a', 'b', 'c', 'm', 'd']);
        expect(document.activeElement).toBe(viewButton(root));
    });

    it('shows Select day only while selecting, turning into Unselect day, and Select all into Unselect all', async () => {
        // Arrange
        const { root } = await openAsync('tiles');
        const day = groupButton(root, '2026-11-23');
        const isHiddenBefore = day?.hidden;

        // Act
        select(root);
        const isShownWhileSelecting = day?.hidden === false;
        day?.click();
        const afterDay = { label: day?.textContent, name: day?.getAttribute('aria-label') };
        const selectAll = buttonByText(panel(root), 'Select all');
        selectAll?.click();
        const afterAll = { label: selectAll?.textContent, count: panel(root).querySelector('.selection-count')?.textContent };
        selectAll?.click();

        // Assert
        expect({ isHiddenBefore, isShownWhileSelecting }).toEqual({ isHiddenBefore: true, isShownWhileSelecting: true });
        expect(afterDay).toEqual({ label: 'Unselect day', name: `Unselect day: ${formatDay('2026-11-23')}` });
        expect(afterAll).toEqual({ label: 'Unselect all', count: '5 selected' });
        expect(panel(root).querySelector('.selection-count')?.textContent).toBe('0 selected');
    });

    it('reads "N selected · Select all · Range · ZIP (N) · Delete" on a sticky bar, and the Select icon leaves', async () => {
        // Arrange
        const { root } = await openAsync();

        // Act
        select(root);
        groupButton(root, '2026-11-23')?.click();
        const bar = panel(root).querySelector<HTMLElement>('.selection-bar');
        const visible = [...(bar?.children ?? [])].map(child => [...child.childNodes]
            .filter(node => !(node instanceof HTMLElement && node.classList.contains('files-sr-only')))
            .map(node => node.textContent)
            .join('')
            .trim());
        const isPressed = panel(root).querySelector('[data-action="select"]')?.getAttribute('aria-pressed');
        const deleteName = bar?.querySelector('.selection-delete')?.textContent;
        select(root);

        // Assert
        expect(visible).toEqual(['2 selected', 'Select all', 'Range', 'ZIP (2)', '']);
        expect(deleteName).toBe('Delete (2)');
        expect(isPressed).toBe('true');
        expect(bar?.hidden).toBe(true);
        expect(selectedInList(root)).toEqual([]);
    });

    it('applies the first item’s new state to a range, by Range taps or Shift-click, in either view', async () => {
        // Arrange
        const { root } = await openAsync();
        select(root);

        // Act
        row(root, 'a')?.querySelector<HTMLInputElement>('.file-check-box')?.click();
        const shiftClick = new MouseEvent('click', { bubbles: true, shiftKey: true });
        row(root, 'c')?.querySelector('.file-check-box')?.dispatchEvent(shiftClick);
        const afterShift = selectedInList(root);
        buttonByText(panel(root), 'Range')?.click();
        const isRangePressed = buttonByText(panel(root), 'Range')?.getAttribute('aria-pressed');
        row(root, 'b')?.querySelector<HTMLInputElement>('.file-check-box')?.click();
        row(root, 'd')?.querySelector<HTMLInputElement>('.file-check-box')?.click();

        // Assert
        expect(afterShift).toEqual(['a', 'b', 'c']);
        expect(isRangePressed).toBe('true');
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent).toBe('Tap the first and the last item.');
        expect(selectedInList(root)).toEqual(['a']);
    });

    it('clears with Escape, then leaves selecting', async () => {
        // Arrange
        const { root } = await openAsync();
        select(root);
        groupButton(root, '2026-11-23')?.click();

        // Act
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const afterFirst = selectedInList(root);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // Assert
        expect(afterFirst).toEqual([]);
        expect(panel(root).querySelector<HTMLElement>('.selection-bar')?.hidden).toBe(true);
    });

    it('deletes the picked received files only after a confirm with their count and size, in one call', async () => {
        // Arrange
        const { root, client } = await openAsync();
        select(root);
        groupButton(root, '2026-11-22')?.click();
        const label = panel(root).querySelector('[data-action="delete-selected"]')?.textContent;

        // Act
        panel(root).querySelector<HTMLButtonElement>('[data-action="delete-selected"]')?.click();
        await settleAsync();
        const dialog = sheet();
        const confirm = { title: dialog?.querySelector('h2')?.textContent, message: dialog?.querySelector('.dialog-message')?.textContent };
        dialog?.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();
        await settleAsync();

        // Assert
        expect(label).toBe('Delete (1)');
        expect(confirm)
            .toEqual({ title: 'Delete 1 received file (1.0 MB) from the app?', message: 'Downloaded ZIPs keep their copies.' });
        expect(client.callsTo('deleteReceivedManyAsync')).toEqual([['session-1', ['c']]]);
    });

    it('counts a file for ZIP (N) as soon as it finishes, before the list reloads', async () => {
        // Arrange
        const { root, client } = await openAsync();
        select(root);
        row(root, 'm')?.querySelector<HTMLInputElement>('.file-check-box')?.click();
        const whileMoving = panel(root).querySelector('.selection-bar [data-action="download-zip"]')?.textContent;

        // Act
        client.emit('file-done', record('m', 'image'));
        await settleAsync(REDRAW_INTERVAL_MS + 50);

        // Assert
        expect(whileMoving).toBe('Download ZIP');
        expect(panel(root).querySelector('.selection-bar [data-action="download-zip"]')?.textContent)
            .toBe('Download ZIP (1)');
    });

    it('opens Details on a row tap and shows a moving file’s own bar in the list', async () => {
        // Arrange
        const { root, client } = await openAsync();

        // Act
        client.emit('progress', [{
            fileId: 'm',
            sessionId: 'session-1',
            direction: 'in',
            pagesDone: 4,
            totalPages: 10,
            bytesDone: 4_000_000,
            size: 1_000_000,
            percent: 40,
            bytesPerSecond: 1_000_000,
        }]);
        await settleAsync(REDRAW_INTERVAL_MS + 50);
        row(root, 'a')?.querySelector<HTMLButtonElement>('.file-open')?.click();
        await settleAsync();

        // Assert
        expect(row(root, 'm')?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
        expect(row(root, 'm')?.querySelector('.file-meta')?.textContent).toBe('40%');
        expect(row(root, 'm')?.querySelector('.file-list-status')?.textContent).toBe('Receiving');
        expect(sheet()?.querySelector('.files-sheet-title')?.textContent).toBe('a.jpg');
        expect(sheet()?.querySelector('.file-details')?.textContent).toContain('StatusNot downloaded yet');
    });

    it('loads a list row’s thumbnail when the client says it is ready', async () => {
        // Arrange
        const { root, client } = await openAsync();
        const before = client.callsTo('getThumbnailAsync').length;

        // Act
        client.emit('thumb', 'c', 'session-1');
        await settleAsync();

        // Assert
        expect(row(root, 'c')).not.toBeNull();
        expect(client.callsTo('getThumbnailAsync').slice(before))
            .toEqual([[{ sessionId: 'session-1', fileId: 'c', direction: 'in' }]]);
    });

    it('falls back to List by month when storage is blocked', async () => {
        // Arrange
        const blocked = (): never => {
            throw new DOMException('blocked', 'SecurityError');
        };
        harness = createTestApp({ client: { sessions: [createSession()], gallery: GROUPS, files: RECORDS } });
        vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked, clear: () => undefined });

        // Act
        await harness.app.startAsync();
        harness.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'received' });
        await settleAsync(300);
        const view = openView(harness.root);

        // Assert
        expect(view?.querySelector('[data-choice="list"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(view?.querySelector('[data-choice="month"]')?.getAttribute('aria-pressed')).toBe('true');
    });
});

type FilesTab = 'sent' | 'received';

// Two Greek songs in a music folder, two trip files in day folders, and loose notes, all received the same day.
const SEARCH_FILES = [
    record('song', 'other', { name: 'Αθηναίισσα.mp3', relativePath: 'Μουσική/Αθηναίισσα.mp3' }),
    record('rebetiko', 'other', { name: 'Σου.mp3', relativePath: 'Μουσική/Ρεμπέτικα/Σου.mp3' }),
    record('photo', 'image', { name: 'IMG_2231.JPG', relativePath: 'Trip/Day 1/IMG_2231.JPG', savedAt: 1 }),
    record('clip', 'video', { name: 'clip.mp4', relativePath: 'Trip/Day 2/clip.mp4' }),
    record('notes', 'other', { name: 'notes.txt' }),
];
const EVERY_SEARCH_FILE = ['song', 'rebetiko', 'photo', 'clip', 'notes'];

async function openFilesAsync(
    files: readonly FileRecord[],
    tab: FilesTab = 'received',
    view: 'list' | 'tiles' = 'list',
): Promise<TestApp> {
    localStorage.setItem(FILES_VIEW_KEY, view);
    harness = createTestApp({ client: { sessions: [createSession()], gallery: [], files: [...files] } });
    await harness.app.startAsync();
    harness.app.navigate({ name: 'session', sessionId: 'session-1', tab });
    await settleAsync(300);

    return harness;
}

function searchInput(root: HTMLElement, tab: FilesTab = 'received'): HTMLInputElement | null {
    return root.querySelector<HTMLInputElement>(`#panel-${tab} .files-search input`);
}

function typeSearch(root: HTMLElement, text: string): void {
    const input = searchInput(root);
    if (input == null) {
        return;
    }

    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function searchAsync(root: HTMLElement, text: string): Promise<void> {
    typeSearch(root, text);
    await settleAsync(SEARCH_DELAY_MS + 50);
}

function emptyNote(root: HTMLElement): { readonly text: string | undefined; readonly buttons: string[] } | undefined {
    const note = panel(root).querySelector<HTMLElement>('.files-empty');
    if (note == null || note.hidden) {
        return undefined;
    }

    return {
        text: note.querySelector('p')?.textContent ?? undefined,
        buttons: [...note.querySelectorAll<HTMLButtonElement>('button')]
            .filter(button => button.closest('[hidden]') == null)
            .map(button => button.textContent ?? ''),
    };
}

describe('Search in Sent and Received', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    it('leads the toolbar with a labelled search field, with its × only while there is text', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);
        const input = searchInput(root);
        const cross = panel(root).querySelector<HTMLButtonElement>('.files-search [data-action="clear-search"]');
        const isCrossHiddenWhenEmpty = cross?.hidden;

        // Act
        typeSearch(root, 'trip');

        // Assert
        expect(panel(root).querySelector('.files-toolbar')?.firstElementChild?.className).toBe('files-search');
        expect({ type: input?.type, label: input?.getAttribute('aria-label'), placeholder: input?.placeholder })
            .toEqual({ type: 'search', label: 'Search files', placeholder: 'Search' });
        expect(panel(root).querySelector('.files-search-icon .icon')).not.toBeNull();
        expect(isCrossHiddenWhenEmpty).toBe(true);
        expect({ isHidden: cross?.hidden, label: cross?.getAttribute('aria-label') })
            .toEqual({ isHidden: false, label: 'Clear search' });
    });

    it('finds files by name or folder, without case or accents, in List and in Tiles', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);

        // Act
        await searchAsync(root, 'αθηναι');
        const byName = listed(root);
        await searchAsync(root, 'ΡΕΜΠΕΤΙΚΑ');
        const byFolder = listed(root);
        await searchAsync(root, 'σου');
        const byFinalSigma = listed(root);
        await searchAsync(root, 'day trip');
        const byTwoWords = listed(root);
        chooseView(root, 'tiles');
        await settleAsync();

        // Assert
        expect(byName).toEqual(['song']);
        expect(byFolder).toEqual(['rebetiko']);
        expect(byFinalSigma).toEqual(['rebetiko']);
        expect(byTwoWords).toEqual(['photo', 'clip']);
        expect(tiles(root)).toEqual(['photo', 'clip']);
        expect(searchInput(root)?.value).toBe('day trip');
    });

    it('filters once typing pauses, and the field keeps focus while the list redraws', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);
        const input = searchInput(root);
        input?.focus();

        // Act
        for (const text of ['t', 'tr', 'tri', 'trip']) {
            typeSearch(root, text);
            await settleAsync(SEARCH_DELAY_MS / 3);
        }

        const whileTyping = listed(root);
        await settleAsync(SEARCH_DELAY_MS + 50);

        // Assert
        expect(whileTyping).toEqual(EVERY_SEARCH_FILE);
        expect(listed(root)).toEqual(['photo', 'clip']);
        expect(document.activeElement).toBe(input);
    });

    it('holds the panel’s height while a search is typed, so a shorter list doesn’t pull the field down', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);
        const scroller = root.querySelector<HTMLElement>('.app-main');
        const filesPanel = panel(root);
        if (scroller == null) {
            throw new Error('no scroller');
        }

        // The toolbar is scrolled to the top of an 800 px view: the scroller starts 56 px down, the panel 4 px below it.
        let scrollTop = 175;
        Object.defineProperty(scroller, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
                scrollTop = value;
            },
        });
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 });
        vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 56, 390, 800));
        vi.spyOn(filesPanel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 300));
        vi.spyOn(filesPanel, 'getClientRects').mockReturnValue([new DOMRect(0, 60, 390, 300)] as unknown as DOMRectList);

        // Act
        await searchAsync(root, 'αθηναι');
        const whileSearching = filesPanel.style.getPropertyValue('min-block-size');
        await searchAsync(root, '');

        // Assert
        expect(whileSearching).toBe(`${175 + 800 - (60 - 56 + 175)}px`);
        expect(filesPanel.style.getPropertyValue('min-block-size')).toBe('');
    });

    it('narrows the type and status filters further, in Tiles too', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES, 'received', 'tiles');
        await searchAsync(root, 'trip');

        // Act
        toggleFilter(root, 'Photos');
        const tripPhotos = tiles(root);
        toggleFilter(root, 'Photos');
        toggleFilter(root, 'Not downloaded');
        const tripNotDownloaded = tiles(root);

        // Assert
        expect(tripPhotos).toEqual(['photo']);
        expect(tripNotDownloaded).toEqual(['clip']);
    });

    it('says when nothing matches the search, with Clear search, also when the filters are not the cause', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);

        // Act
        await searchAsync(root, 'remb');
        const withoutFilters = emptyNote(root);
        toggleFilter(root, 'Photos');
        const withFilters = emptyNote(root);
        panel(root).querySelector<HTMLButtonElement>('.files-empty [data-action="clear-search"]')?.click();
        await settleAsync();

        // Assert
        expect(withoutFilters).toEqual({ text: 'No files match “remb”.', buttons: ['Clear search'] });
        expect(withFilters).toEqual({ text: 'No files match “remb”.', buttons: ['Clear search'] });
        expect(searchInput(root)?.value).toBe('');
        expect(listed(root)).toEqual(['photo']);
        expect(emptyNote(root)).toBeUndefined();
    });

    it('says so when the search and the filters only miss together, with a button for each', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);
        toggleFilter(root, 'Photos');

        // Act
        await searchAsync(root, 'clip');
        const both = emptyNote(root);
        panel(root).querySelector<HTMLButtonElement>('.files-empty [data-action="clear-filters"]')?.click();
        await settleAsync();

        // Assert
        expect(both)
            .toEqual({ text: 'No files match “clip” with these filters.', buttons: ['Clear search', 'Clear filters'] });
        expect(listed(root)).toEqual(['clip']);
        expect(searchInput(root)?.value).toBe('clip');
        expect(panel(root).querySelector<HTMLElement>('.files-view-dot')?.hidden).toBe(true);
        expect(panel(root).querySelector<HTMLElement>('.files-filtered')?.hidden).toBe(true);
    });

    it('says when only the filters hide everything', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);

        // Act
        toggleFilter(root, 'Failed');

        // Assert
        expect(emptyNote(root)).toEqual({ text: 'No files match these filters.', buttons: [] });
        expect(panel(root).querySelector('.files-filtered-text')?.textContent).toBe('Filtered: Failed');
    });

    it('clears with Escape or ×, and Clear filters in the sheet leaves the search alone', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);
        select(root);
        const input = searchInput(root);
        input?.focus();
        await searchAsync(root, 'trip');

        // Act
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await settleAsync();
        const afterEscape = {
            value: input?.value,
            rows: listed(root),
            isSelecting: panel(root).querySelector<HTMLElement>('.selection-bar')?.hidden === false,
        };
        await searchAsync(root, 'trip');
        panel(root).querySelector<HTMLButtonElement>('.files-search [data-action="clear-search"]')?.click();
        await settleAsync();
        const afterCross = { value: input?.value, rows: listed(root), isFocused: document.activeElement === input };
        await searchAsync(root, 'trip');
        toggleFilter(root, 'Videos');
        const view = openView(root);
        view?.querySelector<HTMLButtonElement>('[data-action="clear-filters"]')?.click();
        const boxes = [...(view?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])].map(box => box.checked);
        view?.querySelector<HTMLButtonElement>('[data-action="done"]')?.click();

        // Assert
        expect(afterEscape).toEqual({ value: '', rows: EVERY_SEARCH_FILE, isSelecting: true });
        expect(afterCross).toEqual({ value: '', rows: EVERY_SEARCH_FILE, isFocused: true });
        expect(boxes.every(isChecked => !isChecked)).toBe(true);
        expect(document.querySelector('.files-view-sheet')).toBeNull();
        expect(searchInput(root)?.value).toBe('trip');
        expect(listed(root)).toEqual(['photo', 'clip']);
    });

    it('selects, counts and deletes only the files the search shows', async () => {
        // Arrange
        const { root, client } = await openFilesAsync(SEARCH_FILES);
        select(root);
        row(root, 'notes')?.querySelector<HTMLInputElement>('.file-check-box')?.click();

        // Act
        await searchAsync(root, 'trip');
        const countAfterSearch = panel(root).querySelector('.selection-count')?.textContent;
        panel(root).querySelector<HTMLButtonElement>('[data-action="select-group"]')?.click();
        const day = {
            ids: selectedInList(root),
            zip: panel(root).querySelector('.selection-bar [data-action="download-zip"]')?.textContent,
            delete: panel(root).querySelector('[data-action="delete-selected"]')?.textContent,
        };
        panel(root).querySelector<HTMLButtonElement>('[data-action="select-group"]')?.click();
        buttonByText(panel(root), 'Select all')?.click();
        const all = panel(root).querySelector('.selection-count')?.textContent;
        panel(root).querySelector<HTMLButtonElement>('[data-action="delete-selected"]')?.click();
        await settleAsync();
        sheet()?.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();
        await settleAsync();

        // Assert
        expect(countAfterSearch).toBe('0 selected');
        expect(day).toEqual({ ids: ['photo', 'clip'], zip: 'Download ZIP (2)', delete: 'Delete (2)' });
        expect(all).toBe('2 selected');
        expect(client.callsTo('deleteReceivedManyAsync')).toEqual([['session-1', ['photo', 'clip']]]);
    });

    it('keeps its own text in each tab and stores none of it', async () => {
        // Arrange
        const { root } = await openFilesAsync(SEARCH_FILES);
        await searchAsync(root, 'trip');

        // Act
        root.querySelector<HTMLButtonElement>('[data-tab="sent"]')?.click();
        await settleAsync(300);
        const inSent = searchInput(root, 'sent')?.value;
        root.querySelector<HTMLButtonElement>('[data-tab="received"]')?.click();
        await settleAsync();
        const stored = Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index) ?? '') ?? '');

        // Assert
        expect(inSent).toBe('');
        expect(searchInput(root)?.value).toBe('trip');
        expect(listed(root)).toEqual(['photo', 'clip']);
        expect(stored.filter(value => value.includes('trip'))).toEqual([]);
    });
});

describe('List rows', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    // Each row's shown status as "text/tone", or "none" when it says nothing.
    function statuses(root: HTMLElement, tab: FilesTab): Record<string, string> {
        return Object.fromEntries([...panel(root, tab).querySelectorAll<HTMLElement>('.gallery-list .file-row')].map(fileRow => {
            const status = fileRow.querySelector<HTMLElement>('.file-list-status');
            const isDone = status?.querySelector('.file-list-done') != null;

            const text = `${isDone ? '✓ ' : ''}${status?.textContent}/${status?.dataset.tone}`;

            return [fileRow.dataset.fileId ?? '', status == null || status.hidden ? 'none' : text];
        }));
    }

    function menu(): string[] {
        return [...(sheet()?.querySelectorAll<HTMLButtonElement>('.menu-item') ?? [])]
            .map(button => `${button.textContent}${button.dataset.tone === 'danger' ? ' (danger)' : ''}`);
    }

    function openMenu(root: HTMLElement, fileId: string, tab: FilesTab = 'received'): void {
        row(root, fileId, tab)?.querySelector<HTMLButtonElement>('[data-action="more"]')?.click();
    }

    it('shows a Received status only for the exceptions, Damaged in red and Downloaded with a ✓', async () => {
        // Arrange
        const files = [
            record('plain', 'image'),
            record('downloaded', 'image', { savedAt: 1 }),
            record('damaged', 'image', { note: 'damaged' }),
            record('failed', 'image', { state: 'failed', hasData: false }),
            record('paused', 'image', { state: 'paused', pausedBy: 'user', hasData: false }),
            record('deleted', 'image', { hasData: false }),
        ];

        // Act
        const { root } = await openFilesAsync(files);

        // Assert
        expect(statuses(root, 'received')).toEqual({
            plain: 'none',
            downloaded: '✓ Downloaded/ok',
            damaged: 'Damaged/fail',
            failed: 'Failed/fail',
            paused: 'Paused/warn',
            deleted: 'Deleted from app/muted',
        });
        expect(row(root, 'plain')?.querySelector('.file-open')?.getAttribute('aria-label'))
            .toMatch(/^plain\.jpg, 1\.0 MB · .+, Not downloaded yet\. Details$/);
    });

    it('shows a Sent status only for the exceptions', async () => {
        // Arrange
        const files = [
            sent('done'),
            sent('skipped', { note: 'already-on-peer' }),
            sent('failed', { state: 'failed' }),
            sent('waiting', { state: 'queued' }),
        ];

        // Act
        const { root } = await openFilesAsync(files, 'sent');

        // Assert
        expect(statuses(root, 'sent')).toEqual({
            done: 'none',
            skipped: 'Skipped · already on Pixel 8 · Blue Otter/muted',
            failed: 'Failed/fail',
            waiting: 'Not sent yet/muted',
        });
    });

    it('holds a row’s actions in its ⋯ sheet, Delete last, and runs the one picked', async () => {
        // Arrange
        const { root, client } = await openFilesAsync([record('photo', 'image')]);

        // Act
        openMenu(root, 'photo');
        const title = sheet()?.querySelector('.files-sheet-title')?.textContent;
        const items = menu();
        sheet()?.querySelector<HTMLButtonElement>('[data-action="download-zip"]')?.click();
        await settleAsync();

        // Assert
        expect(title).toBe('photo.jpg');
        expect(items).toEqual(['Download ZIP', 'Details', 'Delete (danger)']);
        expect(document.querySelector('.files-row-menu')).toBeNull();
        expect(client.callsTo('buildZipAsync')).toEqual([['session-1', ['photo']]]);
    });

    it('offers Cancel and Delete partial for a paused received file, and Resume once connected', async () => {
        // Arrange
        const paused = record('paused', 'image', {
            state: 'paused',
            pausedBy: 'user',
            hasData: false,
            pagination: { ...PAGINATION, pagesDone: 4 },
        });
        const { root, client } = await openFilesAsync([paused]);

        // Act
        openMenu(root, 'paused');
        const offline = menu();
        closeSheet();
        client.connect();
        await settleAsync();
        openMenu(root, 'paused');
        const online = menu();
        sheet()?.querySelector<HTMLButtonElement>('[data-action="resume"]')?.click();
        await settleAsync();

        // Assert
        expect(offline).toEqual(['Cancel', 'Delete partial (danger)']);
        expect(online).toEqual(['Resume', 'Cancel', 'Delete partial (danger)']);
        expect(client.callsTo('resumeAsync')).toEqual([[{ sessionId: 'session-1', fileId: 'paused', direction: 'in' }]]);
    });

    it('offers Send again and Details for a sent file while connected', async () => {
        // Arrange
        const { root, client } = await openFilesAsync([sent('done')], 'sent');
        client.connect();
        await settleAsync();

        // Act
        openMenu(root, 'done', 'sent');

        // Assert
        expect(menu()).toEqual(['Send again', 'Details']);
    });

    it('notes a damaged copy in its ⋯ sheet, without Download ZIP', async () => {
        // Arrange
        const { root } = await openFilesAsync([record('broken', 'image', { note: 'damaged' })]);

        // Act
        openMenu(root, 'broken');

        // Assert
        const note = sheet()?.querySelector<HTMLElement>('.files-note');
        expect({ text: note?.textContent, tone: note?.dataset.tone }).toEqual({
            text: 'The stored copy of broken.jpg is damaged. Ask Pixel 8 · Blue Otter to send it again.',
            tone: 'fail',
        });
        expect(menu()).toEqual(['Details', 'Delete (danger)']);
    });

    it('hides ⋯ while selecting, and a row tap picks the row instead', async () => {
        // Arrange
        const { root } = await openFilesAsync([record('photo', 'image')]);

        // Act
        select(root);
        row(root, 'photo')?.querySelector<HTMLButtonElement>('.file-open')?.click();

        // Assert
        expect(row(root, 'photo')?.querySelector<HTMLElement>('[data-action="more"]')?.hidden).toBe(true);
        expect(selectedInList(root)).toEqual(['photo']);
        expect(sheet()).toBeUndefined();
    });

    it('draws each group as one card, with the first and last rows marked', async () => {
        // Act
        const { root } = await openAsync();

        // Assert
        expect(['a', 'b', 'c', 'm', 'd'].map(fileId => row(root, fileId)?.dataset.edge))
            .toEqual(['first', 'last', 'first', 'last', 'only']);
        expect(panel(root).querySelector('.gallery-day-count')?.textContent).toBe('2 items');
    });
});

describe('Tiles', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    // Each tile's tag as "text/tone", or "none", with "✓" for the Downloaded badge.
    function tags(root: HTMLElement, tab: FilesTab): Record<string, string> {
        return Object.fromEntries([...root.querySelectorAll<HTMLElement>(`#panel-${tab} .gallery-cell`)].map(cell => {
            const tag = cell.querySelector<HTMLElement>('.gallery-tag');
            const isDone = cell.querySelector<HTMLElement>('.gallery-done')?.hidden === false;
            const text = tag == null || tag.hidden ? 'none' : `${tag.textContent}/${tag.dataset.tone}`;

            return [cell.dataset.fileId ?? '', isDone ? `✓ ${text}` : text];
        }));
    }

    function names(root: HTMLElement, tab: FilesTab): string[][] {
        return [...root.querySelectorAll<HTMLElement>(`#panel-${tab} .gallery-cell`)].map(cell => [cell.getAttribute('aria-label') ?? '', cell.title]);
    }

    it('tags a Sent tile only for an exception, and a moving one with its percent', async () => {
        // Arrange
        const files = [
            sent('done'),
            sent('failed', { state: 'failed' }),
            sent('waiting', { state: 'queued' }),
            sent('skipped', { note: 'already-on-peer' }),
            sent('moving', { state: 'active', pagination: { ...PAGINATION, pagesDone: 4 } }),
        ];

        // Act
        const { root } = await openFilesAsync(files, 'sent', 'tiles');

        // Assert
        expect(tags(root, 'sent')).toEqual({
            done: 'none',
            failed: 'Failed/fail',
            waiting: 'Not sent yet/muted',
            skipped: 'Skipped · already on Pixel 8 · Blue Otter/muted',
            moving: '40%/accent',
        });
    });

    it('tags a Received tile only for an exception, and gives a downloaded one a small ✓ instead', async () => {
        // Arrange
        const files = [
            record('plain', 'image'),
            record('downloaded', 'image', { savedAt: 1 }),
            record('failed', 'image', { state: 'failed', hasData: false }),
            record('deleted', 'image', { hasData: false }),
            record('damaged', 'image', { note: 'damaged' }),
            record('paused', 'image', { state: 'paused', pausedBy: 'user', hasData: false, pagination: PAGINATION }),
        ];

        // Act
        const { root } = await openFilesAsync(files, 'received', 'tiles');

        // Assert
        expect(tags(root, 'received')).toEqual({
            plain: 'none',
            downloaded: '✓ none',
            failed: 'Failed/fail',
            deleted: 'Deleted from app/muted',
            damaged: 'Damaged/fail',
            paused: 'Paused/warn',
        });
    });

    it('shows a video’s length on its tile', async () => {
        // Arrange
        localStorage.setItem(FILES_VIEW_KEY, 'tiles');
        const clip = { ...item('clip', 'video', 'received'), durationSeconds: 42 };
        harness = createTestApp({ client: { sessions: [createSession()], gallery: [{ day: '2026-11-23', items: [clip] }] } });
        await harness.app.startAsync();

        // Act
        harness.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'received' });
        await settleAsync(300);
        const { root } = harness;

        // Assert
        expect(panel(root).querySelector('.gallery-duration')?.textContent).toBe('0:42');
    });

    it('names every tile with its full status, the plain one included, in its tooltip too', async () => {
        // Arrange
        const files = [sent('photo', { name: 'IMG_2231.JPG' }), sent('skipped', { note: 'already-on-peer' })];

        // Act
        const { root } = await openFilesAsync(files, 'sent', 'tiles');

        // Assert
        expect(names(root, 'sent')).toEqual([
            ['IMG_2231.JPG, Sent', 'IMG_2231.JPG, Sent'],
            ['skipped.jpg, Skipped · already on Pixel 8 · Blue Otter', 'skipped.jpg, Skipped · already on Pixel 8 · Blue Otter'],
        ]);
    });

    it('opens Details on a tap, whose preview opens the viewer at that file', async () => {
        // Arrange
        const files = [record('a', 'image'), record('b', 'image')];
        const { root } = await openFilesAsync(files, 'received', 'tiles');

        // Act
        panel(root).querySelector<HTMLButtonElement>('.gallery-cell[data-file-id="b"]')?.click();
        await settleAsync();
        const title = sheet()?.querySelector('.files-sheet-title')?.textContent;
        sheet()?.querySelector<HTMLButtonElement>('.files-details-preview')?.click();
        await settleAsync(20);

        // Assert
        expect(title).toBe('b.jpg');
        expect(document.querySelector('.files-details')).toBeNull();
        expect(document.querySelector('.viewer .viewer-position')?.textContent).toBe('2 of 2');
    });

    it('opens an unfinished tile’s actions on a tap', async () => {
        // Arrange
        const paused = record('paused', 'image', {
            state: 'paused',
            pausedBy: 'user',
            hasData: false,
            pagination: { ...PAGINATION, pagesDone: 4 },
        });
        const { root } = await openFilesAsync([paused], 'received', 'tiles');

        // Act
        panel(root).querySelector<HTMLButtonElement>('.gallery-cell')?.click();
        await settleAsync();

        // Assert
        expect([...(sheet()?.querySelectorAll('.menu-item') ?? [])].map(button => button.textContent))
            .toEqual(['Cancel', 'Delete partial']);
    });
});

describe('Files updating in place', () => {
    // Waits past the tracker's redraw and the panel's reload delay, so a reload would have happened.
    const SETTLE_MS = REDRAW_INTERVAL_MS + 600;
    const RING_LENGTH = 2 * Math.PI * 15;

    // a and b are finished, m is still arriving.
    const MOVING_FILES = [
        record('a', 'image', { hasThumbnail: true }),
        record('m', 'image', { state: 'active', hasData: false, pagination: PAGINATION }),
        record('b', 'image'),
    ];

    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    function tile(root: HTMLElement, fileId: string): HTMLElement | null {
        return panel(root).querySelector<HTMLElement>(`.gallery-cell[data-file-id="${fileId}"]`);
    }

    function progressOf(fileId: string, percent: number): ProgressInfo {
        return {
            fileId,
            sessionId: 'session-1',
            direction: 'in',
            pagesDone: percent / 10,
            totalPages: 10,
            bytesDone: percent * 10_000,
            size: 1_000_000,
            percent,
            bytesPerSecond: 1_000_000,
        };
    }

    // Every node the grid changes from now on.
    function watchGrid(root: HTMLElement): () => Node[] {
        const targets: Node[] = [];
        const observer = new MutationObserver(records => targets.push(...records.map(change => change.target)));
        const grid = panel(root).querySelector('.gallery-grid');
        if (grid != null) {
            observer.observe(grid, { subtree: true, childList: true, attributes: true, characterData: true });
        }

        return () => {
            targets.push(...observer.takeRecords().map(change => change.target));
            observer.disconnect();

            return targets;
        };
    }

    it('moves a tile’s ring and percent in place, changing no other tile and reloading nothing', async () => {
        // Arrange
        const { root, client } = await openFilesAsync(MOVING_FILES, 'received', 'tiles');
        const moving = tile(root, 'm');
        const tag = moving?.querySelector('.gallery-tag');
        const others = [tile(root, 'a'), tile(root, 'b')];
        const loads = client.callsTo('listGalleryAsync').length;
        const changes = watchGrid(root);

        // Act
        client.emit('progress', [progressOf('m', 40)]);
        await settleAsync(SETTLE_MS);
        const targets = changes();

        // Assert
        expect(tile(root, 'm')).toBe(moving);
        expect(Number(moving?.querySelector('.progress-ring-value')?.getAttribute('stroke-dashoffset'))).toBeCloseTo(RING_LENGTH * 0.6);
        expect(moving?.querySelector('.gallery-tag')).toBe(tag);
        expect(tag?.textContent).toBe('40%');
        expect(tile(root, 'a')).toBe(others[0]);
        expect(tile(root, 'b')).toBe(others[1]);
        expect(targets.length).toBeGreaterThan(0);
        expect(targets.filter(target => moving?.contains(target) !== true)).toEqual([]);
        expect(client.callsTo('listGalleryAsync')).toHaveLength(loads);
    });

    it('turns a tile to finished in place when its file is done', async () => {
        // Arrange
        const { root, client } = await openFilesAsync(MOVING_FILES, 'received', 'tiles');
        const moving = tile(root, 'm');
        const loads = client.callsTo('listGalleryAsync').length;
        const changes = watchGrid(root);

        // Act
        client.emit('file-done', record('m', 'image'));
        await settleAsync(SETTLE_MS);
        const targets = changes();

        // Assert
        const finished = tile(root, 'm');
        expect(finished).toBe(moving);
        expect({
            ring: finished?.querySelector('.progress-ring') ?? null,
            tag: finished?.querySelector('.gallery-tag:not([hidden])') ?? null,
            name: finished?.getAttribute('aria-label'),
        }).toEqual({ ring: null, tag: null, name: 'm.jpg, Not downloaded yet' });
        expect(targets.filter(target => moving?.contains(target) !== true)).toEqual([]);
        expect(client.callsTo('listGalleryAsync')).toHaveLength(loads);
    });

    it('shows a file the filter matches once it finishes, without reloading, keeping the other tiles', async () => {
        // Arrange
        const { root, client } = await openFilesAsync(MOVING_FILES, 'received', 'tiles');
        toggleFilter(root, 'Not downloaded');
        const beforeDone = tiles(root);
        const others = [tile(root, 'a'), tile(root, 'b')];
        const loads = client.callsTo('listGalleryAsync').length;

        // Act
        client.emit('file-done', record('m', 'image'));
        await settleAsync(SETTLE_MS);

        // Assert
        expect(beforeDone).toEqual(['a', 'b']);
        expect(tiles(root)).toEqual(['a', 'm', 'b']);
        expect(tile(root, 'a')).toBe(others[0]);
        expect(tile(root, 'b')).toBe(others[1]);
        expect(client.callsTo('listGalleryAsync')).toHaveLength(loads);
    });

    it('reloads for a new file and keeps the tiles already there, thumbnails included', async () => {
        // Arrange
        const { root, client } = await openFilesAsync(MOVING_FILES, 'received', 'tiles');
        const before = ['a', 'm', 'b'].map(fileId => tile(root, fileId));
        const loads = client.callsTo('listGalleryAsync').length;
        const thumbnails = client.callsTo('getThumbnailAsync').length;
        const added = record('n', 'image', { state: 'incoming', hasData: false });

        // Act
        client.files.push(added);
        client.emit('file-incoming', added);
        await settleAsync(SETTLE_MS);

        // Assert
        expect(tiles(root)).toEqual(['a', 'm', 'b', 'n']);
        expect(['a', 'm', 'b'].every((fileId, index) => tile(root, fileId) === before[index])).toBe(true);
        expect(client.callsTo('listGalleryAsync')).toHaveLength(loads + 1);
        expect(client.callsTo('getThumbnailAsync')).toHaveLength(thumbnails);
    });

    it('keeps a thumbnail that the tracker’s copy of the record doesn’t know about, for tiles drawn later', async () => {
        // Arrange
        const { root, client } = await openFilesAsync(MOVING_FILES, 'received', 'tiles');
        const thumbnailCalls = (): number => client.callsTo('getThumbnailAsync')
            .filter(call => (call[0] as { readonly fileId: string }).fileId === 'a').length;
        // The client flags a stored thumbnail without a record event, and says so with 'thumb' instead.
        client.emit('file-state', record('a', 'image'));
        await settleAsync(SETTLE_MS);
        chooseView(root, 'list');
        await settleAsync(300);
        const before = thumbnailCalls();

        // Act
        chooseView(root, 'tiles');
        await settleAsync(300);

        // Assert
        expect(thumbnailCalls()).toBe(before + 1);
    });

    it('updates a List row in place when its file finishes, without reloading', async () => {
        // Arrange
        const { root, client } = await openFilesAsync(MOVING_FILES, 'received', 'list');
        const fileRow = row(root, 'm');
        const loads = client.callsTo('listGalleryAsync').length;

        // Act
        client.emit('file-done', record('m', 'image'));
        await settleAsync(SETTLE_MS);

        // Assert
        const after = row(root, 'm');
        expect(after).toBe(fileRow);
        expect(after?.querySelector<HTMLElement>('.file-list-status')?.hidden).toBe(true);
        expect(after?.querySelector('.file-open')?.getAttribute('aria-label')).toContain(', Not downloaded yet. Details');
        expect(client.callsTo('listGalleryAsync')).toHaveLength(loads);
    });
});
