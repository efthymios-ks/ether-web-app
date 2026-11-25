import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError } from '../../client/clientTypes.js';
import type { FileRecord } from '../../client/clientTypes.js';
import { createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createFileRecord, createSession } from '../testing/fakeClient.js';
import { createFileActions } from '../transfers/fileActions.js';
import { formatDateTime, formatTakenAt } from '../format.js';
import { noteFor } from '../transfers/fileRow.js';
import { openFileDetails, SHA256_HELP } from './fileDetails.js';

let harness: TestApp | undefined;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

async function startAsync(): Promise<TestApp> {
    harness = createTestApp({ client: { sessions: [createSession()] } });
    await harness.app.startAsync();
    harness.client.connect();
    await settleAsync();

    return harness;
}

function received(overrides: Parameters<typeof createFileRecord>[0] = {}) {
    return createFileRecord({ fileId: 'f-1', direction: 'in', state: 'done', hasData: true, name: 'report.pdf', mime: 'application/pdf', kind: 'other', ...overrides });
}

function dialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="dialog"]');
}

// Each detail as "term: value".
function details(): string[] {
    const terms = [...(dialog()?.querySelectorAll('.file-details dt') ?? [])];

    return terms.map(term => `${term.textContent}: ${term.nextElementSibling?.textContent ?? ''}`);
}

function actionLabels(): string[] {
    return [...(dialog()?.querySelectorAll<HTMLButtonElement>('.files-sheet-actions button') ?? [])]
        .map(button => button.textContent ?? '');
}

describe('file details and SHA-256', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        if (originalClipboard != null) {
            Object.defineProperty(navigator, 'clipboard', originalClipboard);
        }
    });

    it('shows a photo’s preview, size, dates, location with Open in Maps, camera, length, status and verification (MD-07)', async () => {
        // Arrange
        const { app, client } = await startAsync();
        client.behaviour.thumbnail = () => new Blob(['thumb'], { type: 'image/jpeg' });
        const record = received({
            name: 'IMG_2231.JPG',
            mime: 'image/jpeg',
            kind: 'image',
            hasThumbnail: true,
            completedAt: Date.parse('2026-11-23T14:05:00'),
            rootHash: '5d2c8e7f9a0b1c2d',
            metadata: {
                takenAt: '2026-11-23T13:05:42+01:00',
                latitude: 37.97153,
                longitude: 23.72575,
                make: 'Google',
                model: 'Pixel 8',
                lens: 'f/1.7',
                width: 4032,
                height: 3024,
                durationSeconds: 42,
            },
        });
        let viewed = 0;

        // Act
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record, onView: () => viewed++ });
        await settleAsync();
        const thumb = dialog()?.querySelector('.files-details-thumb');
        const link = dialog()?.querySelector<HTMLAnchorElement>('.files-map-link');
        const shown = details();
        dialog()?.querySelector<HTMLButtonElement>('.files-details-preview')?.click();

        // Assert
        expect(thumb).not.toBeNull();
        expect(shown.slice(0, 2))
            .toEqual(['Size: 2.1 GB (2,147,483,648 bytes) · 4032 × 3024', `Received: ${formatDateTime(record.completedAt ?? 0)}`]);
        expect(shown).toContain('Date taken: ' + formatTakenAt('2026-11-23T13:05:42+01:00'));
        expect(shown).toContain('Location: 37.97153, 23.72575 · Open in Maps');
        expect(shown).toContain('Camera: Google Pixel 8 · f/1.7');
        expect(shown).toContain('Length: 0:42');
        expect(shown).toContain('Status: Not downloaded yet');
        expect(shown).toContain('Verified: Every page matched (5d2c8e7f…)');
        expect({ href: link?.href, target: link?.target })
            .toEqual({ href: app.context.platform.mapsUrl(37.97153, 23.72575), target: '_blank' });
        expect(actionLabels()).toEqual([]);
        expect(viewed).toBe(1);
        expect(dialog()).toBeNull();
    });

    it('offers Download ZIP and Delete for a received file, and runs them after closing', async () => {
        // Arrange
        const { app, client } = await startAsync();
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record: received() });
        const labels = actionLabels();

        // Act
        dialog()?.querySelector<HTMLButtonElement>('[data-action="download-zip"]')?.click();
        await settleAsync();

        // Assert
        expect(labels).toEqual(['Download ZIP', 'Delete']);
        expect(document.querySelector('.files-details')).toBeNull();
        expect(client.callsTo('buildZipAsync')).toEqual([['session-1', ['f-1']]]);
    });

    it('offers Send again for a sent file while connected', async () => {
        // Arrange
        const { app, client } = await startAsync();
        const record = createFileRecord({ fileId: 'f-2', direction: 'out', state: 'done', name: 'notes.txt', kind: 'other' });
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record });
        const labels = actionLabels();

        // Act
        dialog()?.querySelector<HTMLButtonElement>('[data-action="send-again"]')?.click();
        await settleAsync();

        // Assert
        expect(labels).toEqual(['Send again']);
        expect(dialog()?.querySelector('.files-details-preview')).toBeUndefined();
        expect(client.callsTo('sendAgainAsync')).toEqual([[{ sessionId: 'session-1', fileId: 'f-2', direction: 'out' }]]);
    });

    it('says a damaged copy in red under Verified, and offers no Download ZIP for it', async () => {
        // Arrange
        const { app } = await startAsync();

        // Act
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record: received({ note: 'damaged' }) });

        // Assert
        expect(dialog()?.querySelector('.files-details-damaged')?.textContent)
            .toBe('Stored copy is damaged. Ask Pixel 8 · Blue Otter to send it again.');
        expect(details()).toContain('Status: Damaged');
        expect(actionLabels()).toEqual(['Delete']);
    });

    it('computes the SHA-256 on request with progress, then shows it with Copy', async () => {
        // Arrange
        const { app, client } = await startAsync();
        const progress: string[] = [];
        let finish: (value: string) => void = () => undefined;
        client.behaviour.computeSha256Async = async (_, options) => {
            options?.onProgress?.(0.4);

            return new Promise(resolve => {
                finish = resolve;
            });
        };
        const copied: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => copied.push(text) } });
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record: received() });

        // Act
        dialog()?.querySelector<HTMLButtonElement>('[data-action="compute-sha256"]')?.click();
        await settleAsync();
        progress.push(dialog()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? '');
        finish('b'.repeat(64));
        await settleAsync();
        dialog()?.querySelector<HTMLButtonElement>('[data-action="copy-sha256"]')?.click();
        await settleAsync();

        // Assert
        expect(progress).toEqual(['40']);
        expect(dialog()?.querySelector('.sha256-value')?.textContent).toBe('b'.repeat(64));
        expect(dialog()?.textContent).toContain(SHA256_HELP);
        expect(copied).toEqual(['b'.repeat(64)]);
        expect(client.callsTo('computeSha256Async')).toEqual([[{ sessionId: 'session-1', fileId: 'f-1', direction: 'in' }]]);
    });

    it('shows a known SHA-256 at once, without computing', async () => {
        // Arrange
        const { app, client } = await startAsync();

        // Act
        const record = received({ sha256: 'c'.repeat(64) });
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record });

        // Assert
        expect(dialog()?.querySelector('.sha256-value')?.textContent).toBe('c'.repeat(64));
        expect(client.callsTo('computeSha256Async')).toEqual([]);
    });

    it('can cancel a running computation', async () => {
        // Arrange
        const { app, client } = await startAsync();
        client.behaviour.computeSha256Async = (_, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('canceled', 'AbortError')));
        });
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record: received() });
        dialog()?.querySelector<HTMLButtonElement>('[data-action="compute-sha256"]')?.click();
        await settleAsync();

        // Act
        dialog()?.querySelector<HTMLButtonElement>('[data-action="cancel-sha256"]')?.click();
        await settleAsync();

        // Assert
        expect(dialog()?.querySelector('[data-action="compute-sha256"]')).not.toBeNull();
        expect(dialog()?.querySelector('.sha256-value')).toBeNull();
    });

    it('says a damaged stored copy must be sent again, in the row’s sheet and as a toast', async () => {
        // Arrange
        const { app, client } = await startAsync();
        client.behaviour.damaged = ['f-1'];
        client.behaviour.computeSha256Async = async () => {
            throw new ClientError('verify-failed', 'damaged', 'f-1');
        };

        // Act
        const note = noteFor(received({ note: 'damaged' }), 'Pixel 8 · Blue Otter', app.context);
        openFileDetails({ context: app.context, actions: createFileActions(app.context), record: received() });
        dialog()?.querySelector<HTMLButtonElement>('[data-action="compute-sha256"]')?.click();
        await settleAsync();

        // Assert
        const text = 'The stored copy of report.pdf is damaged. Ask Pixel 8 · Blue Otter to send it again.';
        expect(note).toBe(text);
        expect(dialog()?.querySelector('.sha256-error')?.textContent).toBe(text);
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent).toBe(text);
    });
});

describe('the Details preview', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        vi.restoreAllMocks();
    });

    function preview(): HTMLElement | null | undefined {
        return dialog()?.querySelector<HTMLElement>('.files-details-preview');
    }

    function previewIcon(): string | undefined {
        return preview()?.querySelector<HTMLElement>('.file-icon')?.dataset.category;
    }

    function openDetails(context: TestApp['app']['context'], record: FileRecord, onView?: () => void): void {
        openFileDetails({ context, actions: createFileActions(context), record, ...(onView == null ? {} : { onView }) });
    }

    it('plays a received song in an <audio controls> player, reading the file only on Play, with its length', async () => {
        // Arrange
        const { app, client } = await startAsync();
        const metadata = { durationSeconds: 187 };
        const record = received({ name: 'Αθηναίισσα.mp3', mime: 'audio/mpeg', kind: 'other', metadata });
        openDetails(app.context, record, () => undefined);
        const play = dialog()?.querySelector<HTMLButtonElement>('[data-action="play"]');
        const iconBefore = previewIcon();
        const readsBefore = client.callsTo('getReceivedFileAsync').length;

        // Act
        play?.click();
        await settleAsync();
        const player = preview()?.querySelector<HTMLAudioElement>('audio');

        // Assert
        expect(iconBefore).toBe('audio');
        expect(play?.getAttribute('aria-label')).toBe('Play Αθηναίισσα.mp3');
        expect(readsBefore).toBe(0);
        expect(details()).toContain('Length: 3:07');
        expect(client.callsTo('getReceivedFileAsync'))
            .toEqual([[{ sessionId: 'session-1', fileId: 'f-1', direction: 'in' }]]);
        expect(player?.classList.contains('files-details-audio')).toBe(true);
        expect(player?.hasAttribute('controls')).toBe(true);
        expect(player?.getAttribute('src')).toMatch(/^blob:/);
        expect(player?.getAttribute('aria-label')).toBe('Αθηναίισσα.mp3');
        expect(preview()?.dataset.state).toBe('playing');
        expect(previewIcon()).toBe('audio');
        expect(dialog()?.querySelector('[data-action="play"]')).toBeNull();
    });

    it('plays a received video in place over its poster, while the poster still opens the viewer', async () => {
        // Arrange
        const { app, client } = await startAsync();
        client.behaviour.thumbnail = () => new Blob(['poster'], { type: 'image/jpeg' });
        const record = received({ name: 'clip.mp4', mime: 'video/mp4', kind: 'video', hasThumbnail: true });
        let viewed = 0;
        openDetails(app.context, record, () => viewed++);
        await settleAsync();
        const poster = preview()?.querySelector<HTMLImageElement>('.files-details-view .files-details-thumb');
        const posterUrl = poster?.getAttribute('src');

        // Act
        dialog()?.querySelector<HTMLButtonElement>('[data-action="play"]')?.click();
        await settleAsync();
        const video = preview()?.querySelector<HTMLVideoElement>('video');

        // Assert
        expect(posterUrl).toMatch(/^blob:/);
        expect(video?.classList.contains('files-details-video')).toBe(true);
        expect(video?.getAttribute('poster')).toBe(posterUrl);
        expect(video?.hasAttribute('controls')).toBe(true);
        expect(video?.hasAttribute('playsinline')).toBe(true);
        expect(video?.getAttribute('src')).toMatch(/^blob:/);
        expect(viewed).toBe(0);
    });

    it('opens the viewer from a playable file’s poster rather than playing it', async () => {
        // Arrange
        const { app } = await startAsync();
        const record = received({ name: 'song.mp3', mime: 'audio/mpeg', kind: 'other' });
        let viewed = 0;
        openDetails(app.context, record, () => viewed++);

        // Act
        const view = dialog()?.querySelector<HTMLButtonElement>('.files-details-view');
        const label = view?.getAttribute('aria-label');
        view?.click();

        // Assert
        expect(label).toBe('Open song.mp3 in the viewer');
        expect(viewed).toBe(1);
        expect(dialog()).toBeNull();
    });

    it('gives a song this browser can’t play, a sent one or a damaged one its icon, without Play', async () => {
        // Arrange
        const { app } = await startAsync();
        const records = [
            received({ name: 'album.flac', mime: 'audio/flac', kind: 'other' }),
            received({ fileId: 'f-2', direction: 'out', hasData: false, name: 'song.mp3', mime: 'audio/mpeg' }),
            received({ name: 'song.mp3', mime: 'audio/mpeg', kind: 'other', note: 'damaged' }),
        ];
        const shown: Array<readonly [string | undefined, boolean]> = [];

        // Act
        for (const record of records) {
            openDetails(app.context, record);
            shown.push([previewIcon(), dialog()?.querySelector('[data-action="play"]') != null]);
            dialog()?.querySelector<HTMLButtonElement>('.files-sheet-close')?.click();
        }

        // Assert
        expect(shown).toEqual([['audio', false], ['audio', false], ['audio', false]]);
    });

    it('falls back to the icon with a note when the player can’t play the file after all', async () => {
        // Arrange
        const { app } = await startAsync();
        const record = received({ name: 'voice.mp3', mime: 'audio/mpeg', kind: 'other' });
        openDetails(app.context, record);
        dialog()?.querySelector<HTMLButtonElement>('[data-action="play"]')?.click();
        await settleAsync();

        // Act
        preview()?.querySelector('audio')?.dispatchEvent(new Event('error'));

        // Assert
        expect(preview()?.querySelector('audio')).toBeNull();
        expect(preview()?.dataset.state).toBe('message');
        expect(previewIcon()).toBe('audio');
        expect(preview()?.querySelector('.files-details-message')?.textContent)
            .toBe('This browser can’t play this format.');
    });

    it('says a damaged copy must be sent again when Play finds it damaged', async () => {
        // Arrange
        const { app, client } = await startAsync();
        client.behaviour.damaged = ['f-1'];
        const record = received({ name: 'song.mp3', mime: 'audio/mpeg', kind: 'other' });
        openDetails(app.context, record);

        // Act
        dialog()?.querySelector<HTMLButtonElement>('[data-action="play"]')?.click();
        await settleAsync();

        // Assert
        expect(preview()?.querySelector('audio')).toBeNull();
        expect(preview()?.querySelector('.files-details-message')?.textContent)
            .toBe('The stored copy of song.mp3 is damaged. Ask Pixel 8 · Blue Otter to send it again.');
    });

    it('shows the icon of a document, an archive or any other file in a preview that opens nothing', async () => {
        // Arrange
        const { app } = await startAsync();
        const records = [
            received({ name: 'report.pdf', mime: 'application/pdf', kind: 'other' }),
            received({ name: 'notes.md', mime: '', kind: 'other' }),
            received({ name: 'photos.zip', mime: 'application/zip', kind: 'other' }),
            received({ name: 'firmware.bin', mime: 'application/octet-stream', kind: 'other' }),
        ];
        const shown: Array<readonly [string | undefined, string | undefined]> = [];

        // Act
        for (const record of records) {
            openDetails(app.context, record, () => undefined);
            shown.push([previewIcon(), preview()?.tagName]);
            dialog()?.querySelector<HTMLButtonElement>('.files-sheet-close')?.click();
        }

        // Assert
        expect(shown).toEqual([['document', 'DIV'], ['document', 'DIV'], ['archive', 'DIV'], ['other', 'DIV']]);
    });

    it('brings a photo’s icon back when its thumbnail can’t be drawn', async () => {
        // Arrange
        const { app, client } = await startAsync();
        client.behaviour.thumbnail = () => new Blob(['thumb'], { type: 'image/heic' });
        const record = received({ name: 'IMG_1.HEIC', mime: 'image/heic', kind: 'image', hasThumbnail: true });
        openDetails(app.context, record, () => undefined);
        await settleAsync();
        const thumb = preview()?.querySelector('.files-details-thumb');

        // Act
        thumb?.dispatchEvent(new Event('error'));

        // Assert
        expect(thumb).not.toBeNull();
        expect(preview()?.querySelector('.files-details-thumb')).toBeNull();
        expect(previewIcon()).toBe('image');
        expect(preview()?.tagName).toBe('BUTTON');
    });

    it('lets go of the poster and the file once the sheet closes', async () => {
        // Arrange
        const { app, client } = await startAsync();
        client.behaviour.thumbnail = () => new Blob(['poster'], { type: 'image/jpeg' });
        const record = received({ name: 'clip.mp4', mime: 'video/mp4', kind: 'video', hasThumbnail: true });
        openDetails(app.context, record);
        await settleAsync();
        dialog()?.querySelector<HTMLButtonElement>('[data-action="play"]')?.click();
        await settleAsync();
        const urls = [
            preview()?.querySelector('video')?.getAttribute('poster'),
            preview()?.querySelector('video')?.getAttribute('src'),
        ];
        const revoke = vi.spyOn(URL, 'revokeObjectURL');

        // Act
        dialog()?.querySelector<HTMLButtonElement>('.files-sheet-close')?.click();

        // Assert
        expect(urls.every(url => url?.startsWith('blob:') === true)).toBe(true);
        expect(revoke.mock.calls.map(call => call[0])).toEqual(urls);
    });
});
