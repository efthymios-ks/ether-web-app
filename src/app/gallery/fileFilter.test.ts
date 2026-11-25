import { afterEach, describe, expect, it } from 'vitest';
import type { FileRecord, GalleryItem, GalleryStatus, MediaKind } from '../../client/clientTypes.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { createFileRecord, createSession } from '../testing/fakeClient.js';
import { FILES_VIEW_KEY } from './filesPanel.js';
import { filterLabels, filterStatusOf, filterTypeOf, matchesFilter, TYPE_CHOICES } from './fileFilter.js';
import type { FileFilter, FilterStatus, FilterType } from './fileFilter.js';

// The Type and Status filters of the View & filter sheet, in the Received and Sent tabs.

let harness: TestApp | undefined;

function item(fileId: string, kind: MediaKind, status: GalleryStatus, direction: 'in' | 'out' = 'in'): GalleryItem {
    return {
        fileId,
        sessionId: 'session-1',
        direction,
        name: `${fileId}.bin`,
        mime: 'application/octet-stream',
        size: 1000,
        kind,
        status,
        hasThumbnail: false,
        hasData: direction === 'in',
    };
}

const ITEMS: readonly GalleryItem[] = [
    item('photo-new', 'image', 'received'),
    item('photo-saved', 'image', 'saved'),
    item('video-new', 'video', 'received'),
    item('doc-failed', 'other', 'failed'),
    item('sent-photo', 'image', 'sent', 'out'),
    item('queued-video', 'video', 'queued', 'out'),
];

type FilesTab = 'received' | 'sent';

async function openAsync(tab: FilesTab, options: TestAppOptions = {}, view: 'list' | 'tiles' = 'tiles'): Promise<TestApp> {
    localStorage.setItem(FILES_VIEW_KEY, view);
    harness = createTestApp({
        ...options,
        client: { sessions: [createSession()], gallery: [{ day: '2026-11-23', items: [...ITEMS] }], ...options.client },
    });
    await harness.app.startAsync();
    harness.app.navigate({ name: 'session', sessionId: 'session-1', tab });
    await settleAsync(300);

    return harness;
}

function panel(root: HTMLElement, tab: FilesTab): HTMLElement {
    return root.querySelector<HTMLElement>(`#panel-${tab}`) ?? root;
}

function viewButton(root: HTMLElement, tab: FilesTab): HTMLButtonElement | null {
    return panel(root, tab).querySelector<HTMLButtonElement>('[data-action="view"]');
}

function sheet(): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
}

function toggle(label: string): void {
    const option = [...(sheet()?.querySelectorAll<HTMLLabelElement>('.filter-option') ?? [])]
        .find(row => row.textContent === label);
    option?.querySelector<HTMLInputElement>('input')?.click();
}

function shownCells(root: HTMLElement, tab: FilesTab = 'received'): string[] {
    return [...panel(root, tab).querySelectorAll<HTMLElement>('.gallery-cell')].map(cell => cell.dataset.fileId ?? '');
}

describe('matchesFilter', () => {
    it('adds up within a group, narrows across groups, and shows everything with nothing checked', () => {
        // Arrange
        const photosOrVideos: FileFilter = { types: new Set<MediaKind>(['image', 'video']), statuses: new Set() };
        const newPhotos: FileFilter = { types: new Set<MediaKind>(['image']), statuses: new Set<FilterStatus>(['not-downloaded']) };
        const none: FileFilter = { types: new Set<MediaKind>(), statuses: new Set() };

        // Act & Assert
        expect(matchesFilter(photosOrVideos, 'video', 'failed')).toBe(true);
        expect(matchesFilter(photosOrVideos, 'other', 'failed')).toBe(false);
        expect(matchesFilter(newPhotos, 'image', 'not-downloaded')).toBe(true);
        expect(matchesFilter(newPhotos, 'image', 'downloaded')).toBe(false);
        expect(matchesFilter(none, 'other', undefined)).toBe(true);
    });
});

describe('the Type boxes', () => {
    it('offer Photos, Videos, Audio, Documents and Other files, in that order', () => {
        // Act
        const labels = TYPE_CHOICES.map(choice => `${choice.id}:${choice.label}`);

        // Assert
        expect(labels).toEqual(['image:Photos', 'video:Videos', 'audio:Audio', 'document:Documents', 'other:Other files']);
    });

    it('count archives as Other files and every other category as itself', () => {
        // Act
        const types = (['image', 'video', 'audio', 'document', 'archive', 'other'] as const).map(filterTypeOf);

        // Assert
        expect(types).toEqual(['image', 'video', 'audio', 'document', 'other', 'other']);
    });

    it('match a file by its category', () => {
        // Arrange
        const audioOrDocuments: FileFilter = { types: new Set<FilterType>(['audio', 'document']), statuses: new Set() };
        const otherFiles: FileFilter = { types: new Set<FilterType>(['other']), statuses: new Set() };

        // Act & Assert
        expect(matchesFilter(audioOrDocuments, 'audio', undefined)).toBe(true);
        expect(matchesFilter(audioOrDocuments, 'document', 'failed')).toBe(true);
        expect(matchesFilter(audioOrDocuments, 'image', undefined)).toBe(false);
        expect(matchesFilter(audioOrDocuments, 'archive', undefined)).toBe(false);
        expect(matchesFilter(otherFiles, 'archive', undefined)).toBe(true);
        expect(matchesFilter(otherFiles, 'other', undefined)).toBe(true);
        expect(matchesFilter(otherFiles, 'document', undefined)).toBe(false);
    });
});

describe('filterLabels', () => {
    it('names the checked boxes in the sheet’s order, with the side’s own status words', () => {
        // Arrange
        const filter: FileFilter = {
            types: new Set<MediaKind>(['other', 'image']),
            statuses: new Set<FilterStatus>(['failed', 'not-sent']),
        };

        // Act
        const labels = filterLabels(filter, 'out');

        // Assert
        expect(labels).toEqual(['Photos', 'Other files', 'Not sent yet', 'Failed']);
    });
});

describe('filterStatusOf', () => {
    it('counts a damaged received copy as Failed, and reads the item otherwise', () => {
        // Arrange
        const received = item('a', 'image', 'received');
        const damaged: FileRecord = createFileRecord({
            fileId: 'a',
            direction: 'in',
            state: 'done',
            hasData: true,
            note: 'damaged',
        });

        // Act
        const statuses = [
            filterStatusOf(received, damaged),
            filterStatusOf(received, undefined),
            filterStatusOf(item('s', 'image', 'sent', 'out'), undefined),
        ];

        // Assert
        expect(statuses).toEqual(['failed', 'not-downloaded', 'sent']);
    });
});

describe('View & filter in Received and Sent', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    it('filters at once from the sheet’s Type and Status boxes, naming the count on the button', async () => {
        // Arrange
        const { root } = await openAsync('received');
        const button = viewButton(root, 'received');

        // Act
        button?.click();
        toggle('Photos');
        toggle('Videos');
        const photosOrVideos = shownCells(root);
        toggle('Not downloaded');
        const newMedia = shownCells(root);

        // Assert
        expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
        expect(photosOrVideos).toEqual(['photo-new', 'photo-saved', 'video-new']);
        expect(newMedia).toEqual(['photo-new', 'video-new']);
        expect(button?.textContent).toBe('View and filter, 3 filters on');
        expect(panel(root, 'received').querySelector('.files-filtered-text')?.textContent)
            .toBe('Filtered: Photos · Videos · Not downloaded');
    });

    it('clears all filters at once, and Select all acts on the filtered view only', async () => {
        // Arrange
        const { root } = await openAsync('received');
        viewButton(root, 'received')?.click();
        toggle('Videos');
        sheet()?.querySelector<HTMLButtonElement>('[data-action="done"]')?.click();

        // Act
        buttonByText(panel(root, 'received'), 'Select')?.click();
        buttonByText(panel(root, 'received'), 'Select all')?.click();
        const selectedCount = panel(root, 'received').querySelector('.selection-count')?.textContent;
        viewButton(root, 'received')?.click();
        const clear = sheet()?.querySelector<HTMLButtonElement>('[data-action="clear-filters"]');
        const wasDisabled = clear?.disabled;
        clear?.click();

        // Assert
        expect(selectedCount).toBe('1 selected');
        expect(wasDisabled).toBe(false);
        expect(clear?.disabled).toBe(true);
        expect(shownCells(root)).toEqual(['photo-new', 'photo-saved', 'video-new', 'doc-failed']);
        expect(viewButton(root, 'received')?.textContent).toBe('View and filter');
    });

    it('closes with Escape, Done or ×, each time back on the View & filter button', async () => {
        // Arrange
        const { root } = await openAsync('received');
        const button = viewButton(root, 'received');
        const closedBy: Array<{ isOpen: boolean; isFocused: boolean }> = [];
        const ways: ReadonlyArray<() => void> = [
            () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
            () => sheet()?.querySelector<HTMLButtonElement>('[data-action="done"]')?.click(),
            () => sheet()?.querySelector<HTMLButtonElement>('.files-sheet-close')?.click(),
        ];

        // Act
        for (const close of ways) {
            button?.focus();
            button?.click();
            close();
            closedBy.push({
                isOpen: document.querySelector('.files-view-sheet') != null,
                isFocused: document.activeElement === button,
            });
        }

        // Assert
        expect(closedBy).toEqual([
            { isOpen: false, isFocused: true },
            { isOpen: false, isFocused: true },
            { isOpen: false, isFocused: true },
        ]);
    });

    it('offers the Sent side’s statuses in the Sent tab', async () => {
        // Arrange
        const { root } = await openAsync('sent');
        viewButton(root, 'sent')?.click();

        // Act
        const statuses = [...(sheet()?.querySelectorAll('.files-sheet-checks:last-of-type .filter-option') ?? [])]
            .map(option => option.textContent);
        toggle('Not sent yet');

        // Assert
        expect(statuses).toEqual(['Sent', 'Not sent yet', 'Failed']);
        expect(shownCells(root, 'sent')).toEqual(['queued-video']);
    });

    it('keeps the filter when the sheet opens again', async () => {
        // Arrange
        const { root } = await openAsync('received');
        viewButton(root, 'received')?.click();
        toggle('Failed');
        sheet()?.querySelector<HTMLButtonElement>('[data-action="done"]')?.click();

        // Act
        viewButton(root, 'received')?.click();
        const checked = [...(sheet()?.querySelectorAll<HTMLLabelElement>('.filter-option') ?? [])]
            .filter(option => option.querySelector('input')?.checked === true)
            .map(option => option.textContent);

        // Assert
        expect(checked).toEqual(['Failed']);
        expect(shownCells(root)).toEqual(['doc-failed']);
    });
});

describe('Filter over the Received list', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    function received(fileId: string, kind: MediaKind, overrides: Partial<FileRecord> = {}): FileRecord {
        return createFileRecord({ fileId, name: `${fileId}.bin`, kind, direction: 'in', state: 'done', hasData: true, ...overrides });
    }

    function listed(root: HTMLElement): Array<string | undefined> {
        return [...panel(root, 'received').querySelectorAll<HTMLElement>('.file-row')].map(row => row.dataset.fileId);
    }

    it('filters the list the same way, a damaged copy counting as Failed', async () => {
        // Arrange
        const files = [
            received('p', 'image'),
            received('v', 'video', { savedAt: 1 }),
            received('o', 'other'),
            received('x', 'image', { note: 'damaged' }),
        ];
        const { root } = await openAsync('received', { client: { files, gallery: [] } }, 'list');

        // Act
        viewButton(root, 'received')?.click();
        toggle('Downloaded');
        const downloaded = listed(root);
        toggle('Downloaded');
        toggle('Failed');
        const failed = listed(root);
        toggle('Failed');
        toggle('Photos');
        toggle('Other files');
        sheet()?.querySelector<HTMLButtonElement>('[data-action="done"]')?.click();
        buttonByText(panel(root, 'received'), 'Select')?.click();
        buttonByText(panel(root, 'received'), 'Select all')?.click();

        // Assert
        expect(downloaded).toEqual(['v']);
        expect(failed).toEqual(['x']);
        expect(listed(root).sort()).toEqual(['o', 'p', 'x']);
        expect(panel(root, 'received').querySelector('.selection-count')?.textContent).toBe('3 selected');
    });

    it('shows Audio, Documents and Other files by the file’s category, the one its icon shows', async () => {
        // Arrange
        const files = [
            received('photo', 'image', { name: 'IMG_1.JPG', mime: 'image/jpeg' }),
            received('song', 'other', { name: 'Αθηναίισσα.mp3', mime: 'audio/mpeg' }),
            received('voice', 'other', { name: 'voice.m4a', mime: '' }),
            received('report', 'other', { name: 'report.pdf', mime: 'application/pdf' }),
            received('sheet', 'other', { name: 'budget.xlsx', mime: '' }),
            received('zip', 'other', { name: 'photos.zip', mime: 'application/zip' }),
            received('bin', 'other', { name: 'firmware.bin', mime: 'application/octet-stream' }),
        ];
        const { root } = await openAsync('received', { client: { files, gallery: [] } }, 'list');

        // Act
        viewButton(root, 'received')?.click();
        toggle('Audio');
        const audio = listed(root).sort();
        toggle('Audio');
        toggle('Documents');
        const documents = listed(root).sort();
        toggle('Documents');
        toggle('Other files');
        const other = listed(root).sort();
        toggle('Audio');
        const labels = panel(root, 'received').querySelector('.files-filtered-text')?.textContent;
        const icons = [...panel(root, 'received').querySelectorAll<HTMLElement>('.file-row .file-icon')]
            .map(icon => icon.dataset.category);

        // Assert
        expect(audio).toEqual(['song', 'voice']);
        expect(documents).toEqual(['report', 'sheet']);
        expect(other).toEqual(['bin', 'zip']);
        expect(labels).toBe('Filtered: Audio · Other files');
        expect(icons.sort()).toEqual(['archive', 'audio', 'audio', 'other']);
    });
});
