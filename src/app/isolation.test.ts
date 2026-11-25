import { afterEach, describe, expect, it } from 'vitest';
import type { BatchIncoming, GalleryItem } from '../client/clientTypes.js';
import { FILES_GROUP_BY_KEY, FILES_VIEW_KEY } from './gallery/filesPanel.js';
import { buttonByText, createTestApp, settleAsync } from './testing/appHarness.js';
import type { TestApp } from './testing/appHarness.js';
import { createFileRecord, createPeer, createSession } from './testing/fakeClient.js';

// Two paired devices must never share what the screen shows, even for the same file ID.

let harness: TestApp | undefined;

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

function galleryItem(sessionId: string, fileId: string): GalleryItem {
    return {
        fileId,
        sessionId,
        direction: 'in',
        name: `${fileId}.jpg`,
        mime: 'image/jpeg',
        size: 1000,
        kind: 'image',
        status: 'received',
        hasThumbnail: true,
        hasData: true,
    };
}

function incoming(batchId: string): BatchIncoming {
    return { batchId, peerName: 'iPhone · Old Fox', itemCount: 12, totalBytes: 9_000_000, fitsCount: 12, fitsBytes: 9_000_000, spaceIsShort: false };
}

async function startAsync(): Promise<TestApp> {
    harness = createTestApp({
        client: {
            sessions: [
                createSession({ sessionId: SESSION_A, peerName: 'iPhone · Old Fox', peerDeviceId: 'device-aaaa' }),
                createSession({ sessionId: SESSION_B, peerName: 'Pixel 8 · Blue Otter', peerDeviceId: 'device-bbbb' }),
            ],
            files: [
                createFileRecord({ sessionId: SESSION_A, fileId: 'same', direction: 'in', state: 'active', name: 'from-a.jpg' }),
                createFileRecord({ sessionId: SESSION_B, fileId: 'same', direction: 'in', state: 'done', hasData: true, name: 'from-b.jpg' }),
            ],
        },
    });
    await harness.app.startAsync();

    return harness;
}

async function openAsync(app: TestApp, sessionId: string, tab?: 'send' | 'received'): Promise<void> {
    app.app.navigate({ name: 'session', sessionId, tab });
    await settleAsync(450);
}

describe('no state carries over between sessions', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
    });

    it('keeps progress of a file in one session out of the same file ID in another', async () => {
        // Arrange
        const app = await startAsync();
        app.client.connect({ sessionId: SESSION_A, displayName: 'iPhone · Old Fox', name: 'iPhone · Old Fox' });
        await openAsync(app, SESSION_A, 'send');
        app.client.emit('progress', [{
            fileId: 'same',
            sessionId: SESSION_A,
            direction: 'in',
            pagesDone: 4,
            totalPages: 10,
            bytesDone: 400,
            size: 1000,
            percent: 40,
            bytesPerSecond: 1000,
        }]);
        await settleAsync(150);
        const inA = app.root.querySelector('#panel-send .progress-line')?.textContent ?? '';

        // Act
        await openAsync(app, SESSION_B, 'received');
        const inB = app.root.querySelector('#panel-received .file-row')?.textContent ?? '';
        await openAsync(app, SESSION_B, 'send');
        const progressOfB = app.root.querySelector('#panel-send')?.textContent ?? '';

        // Assert
        expect(inA).toContain('from-a.jpg');
        expect(inA).toContain('40%');
        expect(inB).toContain('from-b.jpg');
        expect(inB).not.toContain('40%');
        expect(progressOfB).not.toContain('from-a.jpg');
    });

    it('names the record’s own peer, not the connected one', async () => {
        // Arrange
        const app = await startAsync();
        app.client.files.push(createFileRecord({ sessionId: SESSION_B, fileId: 'twice', state: 'done', note: 'already-on-peer' }));
        app.client.connect({ sessionId: SESSION_A, displayName: 'iPhone · Old Fox', name: 'iPhone · Old Fox' });

        // Act
        await openAsync(app, SESSION_B, 'send');
        app.root.querySelector<HTMLButtonElement>('[data-tab="sent"]')?.click();
        await settleAsync(450);

        // Assert
        expect(app.root.querySelector('#panel-sent')?.textContent).toContain('Skipped · already on Pixel 8 · Blue Otter');
    });

    it('starts each session’s Received tiles with its own thumbnails and no selection', async () => {
        // Arrange
        localStorage.setItem(FILES_VIEW_KEY, 'tiles');
        localStorage.setItem(FILES_GROUP_BY_KEY, 'day');
        const app = await startAsync();
        app.client.gallery = [{ day: '2026-11-23', items: [galleryItem(SESSION_A, 'same'), galleryItem(SESSION_B, 'same')] }];
        app.client.listGalleryAsync = async options => [{
            day: '2026-11-23',
            items: [galleryItem(options.sessionId, 'same')],
        }];
        await openAsync(app, SESSION_A, 'received');
        buttonByText(app.root, 'Select')?.click();
        buttonByText(app.root, 'Select day')?.click();
        const selectedInA = app.root.querySelector('.selection-count')?.textContent;

        // Act
        await openAsync(app, SESSION_B, 'received');

        // Assert
        expect(selectedInA).toBe('1 selected');
        expect(app.root.querySelector('.selection-bar')?.hasAttribute('hidden')).toBe(true);
        expect(app.root.querySelector('.gallery-cell')?.getAttribute('aria-selected')).toBeNull();
        const thumbnailSessions = app.client.callsTo('getThumbnailAsync').map(([file]) => (file as { sessionId: string }).sessionId);
        expect(thumbnailSessions).toEqual([SESSION_A, SESSION_B]);
    });

    it('starts a new pairing with a different peer with a clean transfer view', async () => {
        // Arrange
        const app = await startAsync();
        app.client.connect({ sessionId: SESSION_A, displayName: 'iPhone · Old Fox', name: 'iPhone · Old Fox', connectionId: 'c-a' });
        await openAsync(app, SESSION_A, 'send');
        app.client.emit('health', { status: 'weak', rttMs: 300, lastSeenMs: 7000, peerHidden: false });
        app.client.emit('batch-incoming', incoming('batch-a'));
        const promptsInA = document.querySelectorAll('[data-prompt="receive"]').length;

        // Act
        app.client.setState('lost');
        app.client.connect(createPeer({ sessionId: SESSION_B, connectionId: 'c-b' }));
        await settleAsync(450);

        // Assert
        expect(promptsInA).toBe(1);
        expect(app.app.route).toEqual({ name: 'session', sessionId: SESSION_B });
        expect(document.querySelectorAll('[data-prompt="receive"]')).toHaveLength(0);
        expect(app.root.querySelector('.peer-bar .peer-name')?.textContent).toBe('Pixel 8 · Blue Otter');
        expect(app.root.querySelector('.health-text')?.textContent).toBe('Connected');
        expect(app.root.querySelector('#panel-send')?.textContent).not.toContain('from-a.jpg');
        expect(app.app.context.tracker.isTransferring).toBe(false);
    });
});
