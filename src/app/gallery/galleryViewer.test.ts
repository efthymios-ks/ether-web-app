import { afterEach, describe, expect, it } from 'vitest';
import type { FileRecord, GalleryItem } from '../../client/clientTypes.js';
import { toGalleryItem } from '../../client/gallery.js';
import { mediaKindOf } from '../../media/mediaKind.js';
import { createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createFileRecord, createSession } from '../testing/fakeClient.js';
import { createFileActions } from '../transfers/fileActions.js';
import { openGalleryViewer } from './galleryViewer.js';

// The one-item viewer (GL-06): photos full size, videos and audio with the browser's own controls, and every
// file that doesn't preview, or that this browser can't decode, as its category's icon with the reason.

let harness: TestApp | undefined;

function received(fileId: string, name: string, mime: string, overrides: Partial<FileRecord> = {}): FileRecord {
    return createFileRecord({
        fileId,
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

async function openAsync(records: readonly FileRecord[], index = 0): Promise<TestApp> {
    harness = createTestApp({ client: { sessions: [createSession()], files: [...records] } });
    await harness.app.startAsync();
    const context = harness.app.context;
    const items: GalleryItem[] = records.map(toGalleryItem);
    openGalleryViewer({
        context,
        actions: createFileActions(context),
        sessionId: 'session-1',
        items,
        index,
        onChanged: () => undefined,
    });
    await settleAsync();

    return harness;
}

function stage(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.viewer-stage');
}

function next(): void {
    document.querySelector<HTMLButtonElement>('.viewer-next')?.click();
}

// What the stage shows: the player or picture's class, or the fallback's icon and words.
function shown(): string {
    const fallback = stage()?.querySelector('.viewer-fallback');
    if (fallback != null) {
        const category = fallback.querySelector<HTMLElement>('.file-icon')?.dataset.category;

        return `${category}: ${fallback.querySelector('p')?.textContent}`;
    }

    return stage()?.firstElementChild?.className ?? '';
}

describe('the viewer', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('plays a received song with the browser’s own controls under its icon, with its length', async () => {
        // Arrange
        const metadata = { durationSeconds: 187 };
        const song = received('song', 'Αθηναίισσα.mp3', 'audio/mpeg', { metadata });

        // Act
        const { client } = await openAsync([song]);
        const player = stage()?.querySelector<HTMLAudioElement>('audio');

        // Assert
        expect(stage()?.querySelector<HTMLElement>('.viewer-audio-stage .file-icon')?.dataset.category).toBe('audio');
        expect(player?.classList.contains('viewer-audio')).toBe(true);
        expect(player?.hasAttribute('controls')).toBe(true);
        expect(player?.getAttribute('preload')).toBe('metadata');
        expect(player?.getAttribute('src')).toMatch(/^blob:/);
        expect(player?.hasAttribute('autoplay')).toBe(false);
        expect(document.querySelector('.viewer-details')?.textContent).toContain('Length3:07');
        expect(client.callsTo('getReceivedFileAsync')).toHaveLength(1);
    });

    it('shows each file that doesn’t preview as its category’s icon, saying why', async () => {
        // Arrange
        const records = [
            received('pdf', 'report.pdf', 'application/pdf'),
            received('zip', 'photos.zip', 'application/zip'),
            received('bin', 'firmware.bin', 'application/octet-stream'),
            received('flac', 'album.flac', 'audio/flac'),
            received('heic', 'IMG_1.HEIC', 'image/heic', { kind: 'image' }),
            received('sent', 'song.mp3', 'audio/mpeg', { direction: 'out', hasData: false }),
            received('gone', 'clip.mp4', 'video/mp4', { kind: 'video', hasData: false, hasThumbnail: false }),
        ];
        const seen: string[] = [];

        // Act
        await openAsync(records);
        for (let index = 0; index < records.length; index++) {
            await settleAsync();
            seen.push(shown());
            next();
        }

        // Assert
        expect(seen).toEqual([
            'document: There’s no preview for this kind of file.',
            'archive: There’s no preview for this kind of file.',
            'other: There’s no preview for this kind of file.',
            'audio: This browser can’t play this format.',
            'image: This browser can’t show this format.',
            'audio: Only the details are kept for this item.',
            'video: Only the details are kept for this item.',
        ]);
    });

    it('gives way to the icon when a video or a song turns out not to play', async () => {
        // Arrange
        await openAsync([
            received('clip', 'clip.mp4', 'video/mp4', { kind: 'video' }),
            received('song', 'song.mp3', 'audio/mpeg'),
        ]);
        const video = stage()?.querySelector('video');

        // Act
        video?.dispatchEvent(new Event('error'));
        const afterVideo = shown();
        next();
        await settleAsync();
        stage()?.querySelector('audio')?.dispatchEvent(new Event('error'));

        // Assert
        expect(video?.classList.contains('viewer-video')).toBe(true);
        expect(afterVideo).toBe('video: This browser can’t play this format.');
        expect(shown()).toBe('audio: This browser can’t play this format.');
    });

    it('shows a photo full size, and its icon when the picture can’t be drawn', async () => {
        // Arrange
        await openAsync([received('photo', 'IMG_2231.JPG', 'image/jpeg', { kind: 'image' })]);
        const image = stage()?.querySelector('img');

        // Act
        image?.dispatchEvent(new Event('error'));

        // Assert
        expect(image?.classList.contains('viewer-image')).toBe(true);
        expect(shown()).toBe('image: This browser can’t show this format.');
    });
});
