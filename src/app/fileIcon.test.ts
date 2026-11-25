import { afterEach, describe, expect, it } from 'vitest';
import type { FileRecord, GalleryItem } from '../client/clientTypes.js';
import { toGalleryItem } from '../client/gallery.js';
import { FILE_CATEGORIES } from '../media/fileCategory.js';
import { mediaKindOf } from '../media/mediaKind.js';
import { createGalleryRow } from './gallery/galleryRow.js';
import { createGalleryTile } from './gallery/galleryTile.js';
import type { GalleryTile, TileView } from './gallery/galleryTile.js';
import { CATEGORY_ICONS, categoryOf, createFileIcon } from './fileIcon.js';
import { ICONS } from './icons.js';
import { createTestApp, settleAsync } from './testing/appHarness.js';
import type { TestApp } from './testing/appHarness.js';
import { createFileRecord } from './testing/fakeClient.js';
import { createFileActions } from './transfers/fileActions.js';
import type { FileRow } from './transfers/fileRow.js';
import { createProgressLine } from './transfers/progressLine.js';
import type { ProgressLine } from './transfers/progressLine.js';

// Files that don't preview get their category's fixed icon, the same on tiles, list rows and progress lines;
// photos and videos show their thumbnail, and their icon again when this browser can't draw it.

let harness: TestApp | undefined;

// One received file of each category, as a picker would name it.
const FILES: ReadonlyArray<readonly [name: string, mime: string, category: string]> = [
    ['IMG_2231.JPG', 'image/jpeg', 'image'],
    ['IMG_2232.MOV', 'video/quicktime', 'video'],
    ['Αθηναίισσα.mp3', 'audio/mpeg', 'audio'],
    ['report.pdf', 'application/pdf', 'document'],
    ['budget.xlsx', '', 'document'],
    ['photos.zip', 'application/x-zip-compressed', 'archive'],
    ['firmware.bin', 'application/octet-stream', 'other'],
];

function received(name: string, mime: string, overrides: Partial<FileRecord> = {}): FileRecord {
    return createFileRecord({
        fileId: name,
        name,
        mime,
        kind: mediaKindOf(mime, name),
        direction: 'in',
        state: 'done',
        hasData: true,
        size: 1_000_000,
        ...overrides,
    });
}

function startApp(): TestApp {
    harness = createTestApp();
    harness.client.connect();

    return harness;
}

function tileView(item: GalleryItem, progress?: number): TileView {
    return {
        item,
        status: { text: progress == null ? 'Received' : 'Receiving', tone: progress == null ? 'muted' : 'accent' },
        tag: undefined,
        isDownloaded: false,
        progress,
        isSelected: undefined,
    };
}

function renderTile(context: TestApp['app']['context'], item: GalleryItem): GalleryTile {
    const tile = createGalleryTile({ context, onClick: () => undefined });
    tile.update(tileView(item));
    document.body.append(tile.element);

    return tile;
}

function renderRow(app: TestApp, record: FileRecord): FileRow {
    const context = app.app.context;
    const row = createGalleryRow({
        context,
        actions: createFileActions(context),
        selectable: { pick: () => undefined },
        onDetails: () => undefined,
    });
    row.update(record);
    document.body.append(row.element);

    return row;
}

function renderLine(app: TestApp, record: FileRecord): ProgressLine {
    const context = app.app.context;
    const line = createProgressLine({ context, actions: createFileActions(context) });
    line.update(record);
    document.body.append(line.element);

    return line;
}

function iconIn(element: Element): string | undefined {
    return element.querySelector<HTMLElement>('.file-icon')?.dataset.category;
}

describe('file icons', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('gives each category its own icon, marked with the category for its colour', () => {
        // Act
        const icons = FILE_CATEGORIES.map(category => createFileIcon(category));

        // Assert
        expect(icons.map(icon => icon.dataset.category)).toEqual([...FILE_CATEGORIES]);
        expect(icons.every(icon => icon.classList.contains('file-icon'))).toBe(true);
        expect(icons.every(icon => icon.querySelector('svg.icon') != null)).toBe(true);
        expect(new Set(Object.values(CATEGORY_ICONS)).size).toBe(6);
        expect(CATEGORY_ICONS.audio).toBe(ICONS.audio);
        expect(CATEGORY_ICONS.document).toBe(ICONS.document);
        expect(CATEGORY_ICONS.archive).toBe(ICONS.archive);
        expect(CATEGORY_ICONS.other).toBe(ICONS.file);
    });

    it('reads a file’s category from its MIME type and name', () => {
        // Act
        const categories = FILES.map(([name, mime]) => categoryOf(received(name, mime)));

        // Assert
        expect(categories).toEqual(FILES.map(([, , category]) => category));
    });

    it('lets a record’s stored kind settle photo or video, and sorts the rest by MIME type and name', () => {
        // Act
        const categories = [
            categoryOf({ name: 'IMG_1.HEIC', mime: '', kind: 'image' }),
            categoryOf({ name: 'clip.bin', mime: 'application/octet-stream', kind: 'video' }),
            categoryOf({ name: 'IMG_2.JPG', mime: 'image/jpeg', kind: 'other' }),
            categoryOf({ name: 'song.mp3', mime: 'audio/mpeg', kind: 'other' }),
            categoryOf({ name: 'report.pdf', mime: '', kind: 'other' }),
        ];

        // Assert
        expect(categories).toEqual(['image', 'video', 'other', 'audio', 'document']);
    });

    it('shows each file’s category icon, large and centred, on a tile without a thumbnail', () => {
        // Arrange
        const { app } = startApp();

        // Act
        const tiles = FILES.map(([name, mime]) => renderTile(app.context, toGalleryItem(received(name, mime))));

        // Assert
        expect(tiles.map(tile => iconIn(tile.element.querySelector('.gallery-placeholder') ?? tile.element)))
            .toEqual(FILES.map(([, , category]) => category));
        expect(tiles.map(tile => tile.element.dataset.category)).toEqual(FILES.map(([, , category]) => category));
    });

    it('shows the same icon in a list row’s 40 px thumbnail slot', () => {
        // Arrange
        const app = startApp();

        // Act
        const rows = FILES.map(([name, mime]) => renderRow(app, received(name, mime)));

        // Assert
        expect(rows.map(row => iconIn(row.element.querySelector('.file-thumb') ?? row.element)))
            .toEqual(FILES.map(([, , category]) => category));
    });

    it('shows the same icon on a progress line, sending or receiving', () => {
        // Arrange
        const app = startApp();

        // Act
        const lines = FILES.map(([name, mime], index) => renderLine(app, received(name, mime, {
            direction: index % 2 === 0 ? 'in' : 'out',
            state: 'active',
            hasData: false,
        })));

        // Assert
        expect(lines.map(line => iconIn(line.element.querySelector('.file-thumb') ?? line.element)))
            .toEqual(FILES.map(([, , category]) => category));
    });

    it('replaces a photo’s icon with its thumbnail, and brings it back when the thumbnail can’t be drawn', async () => {
        // Arrange
        const app = startApp();
        app.client.behaviour.thumbnail = () => new Blob(['thumb'], { type: 'image/jpeg' });
        const record = received('IMG_2231.JPG', 'image/jpeg', { hasThumbnail: true });
        const row = renderRow(app, record);
        const line = renderLine(app, record);
        const tile = renderTile(app.app.context, toGalleryItem(record));
        await settleAsync();
        const thumbs = [
            row.element.querySelector('.file-thumb-image'),
            line.element.querySelector('.file-thumb-image'),
            tile.element.querySelector('.gallery-thumb[src]'),
        ];

        // Act
        for (const thumb of thumbs) {
            thumb?.dispatchEvent(new Event('error'));
        }

        // Assert
        expect(thumbs.every(thumb => thumb != null)).toBe(true);
        expect(row.element.querySelector('.file-thumb-image')).toBeNull();
        expect(iconIn(row.element.querySelector('.file-thumb') ?? row.element)).toBe('image');
        expect(line.element.querySelector('.file-thumb-image')).toBeNull();
        expect(iconIn(line.element.querySelector('.file-thumb') ?? line.element)).toBe('image');
        expect(tile.element.querySelector('.gallery-thumb')?.hasAttribute('src')).toBe(false);
        expect(tile.element.dataset.hasThumb).toBeUndefined();
        expect(iconIn(tile.element.querySelector('.gallery-placeholder') ?? tile.element)).toBe('image');
    });

    it('keeps a moving tile’s icon inside its ring, and gives it its full size once the file is done', () => {
        // Arrange
        const { app } = startApp();
        const item = toGalleryItem(received('Αθηναίισσα.mp3', 'audio/mpeg'));
        const tile = renderTile(app.context, item);

        // Act
        tile.update(tileView(item, 0.4));
        const moving = tile.element.dataset.moving;
        tile.update(tileView(item));

        // Assert
        expect(moving).toBe('true');
        expect(tile.element.dataset.moving).toBeUndefined();
        expect(tile.element.querySelector('.progress-ring')).toBeNull();
        expect(iconIn(tile.element)).toBe('audio');
    });
});
