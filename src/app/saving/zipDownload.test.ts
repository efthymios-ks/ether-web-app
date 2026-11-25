import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchProgress } from '../../client/clientTypes.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { createBatchRecord, createFileRecord, createSession } from '../testing/fakeClient.js';
import { downloadZipAsync, zipFileName } from './zipDownload.js';

let harness: TestApp | undefined;
let downloads: string[] = [];

const captureDownload = (event: Event): void => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLAnchorElement && target.hasAttribute('download')) {
        downloads.push(target.download);
        event.preventDefault();
    }
};

function received(fileId: string, batchId = 'batch-1', overrides: Parameters<typeof createFileRecord>[0] = {}) {
    return createFileRecord({ fileId, batchId, direction: 'in', state: 'done', hasData: true, name: `${fileId}.jpg`, ...overrides });
}

function finished(overrides: Partial<BatchProgress> = {}): BatchProgress {
    return {
        batchId: 'batch-1',
        sessionId: 'session-1',
        direction: 'in',
        total: 3,
        done: 2,
        saved: 0,
        failed: 1,
        canceled: 0,
        bytesDone: 6_000_000,
        totalBytes: 9_000_000,
        bytesPerSecond: 0,
        ...overrides,
    };
}

async function connectAsync(options: TestAppOptions = {}): Promise<TestApp> {
    harness = createTestApp({ ...options, client: { sessions: [createSession()], ...options.client } });
    await harness.app.startAsync();
    harness.client.connect();
    await settleAsync();

    return harness;
}

describe('ZIP download', () => {
    beforeEach(() => {
        downloads = [];
        localStorage.clear();
        document.addEventListener('click', captureDownload, true);
    });

    afterEach(() => {
        document.removeEventListener('click', captureDownload, true);
        harness?.dispose();
        harness = undefined;
    });

    it('names the ZIP after the peer and the time, safe for every file system', () => {
        // Act & Assert
        expect(zipFileName('Pixel 8 · Blue Otter', new Date(2026, 10, 24, 9, 5))).toBe('Pixel 8 · Blue Otter-2026-11-24 09.05.zip');
        expect(zipFileName('A/B: "C"', new Date(2026, 0, 2, 13, 40))).toBe('A_B_ _C_-2026-01-02 13.40.zip');
    });

    it('downloads the files as one ZIP and marks them saved by ZIP, with no unzip steps', async () => {
        // Arrange
        const { app, client } = await connectAsync();

        // Act
        await downloadZipAsync(app.context, { fileIds: ['a', 'b'], sessionId: 'session-1' });
        await settleAsync();
        await downloadZipAsync(app.context, { fileIds: ['c'], sessionId: 'session-1' });
        await settleAsync();

        // Assert
        expect(downloads).toHaveLength(2);
        expect(downloads[0]).toMatch(/^Pixel 8 · Blue Otter-\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.zip$/);
        expect(client.callsTo('markSavedAsync')).toEqual([['session-1', ['a', 'b']], ['session-1', ['c']]]);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.body.textContent).not.toMatch(/unzip|extract|Open the ZIP/i);
    });

    it('downloads nothing when a stored copy is damaged, and says which one', async () => {
        // Arrange
        const { app, client } = await connectAsync({ client: { files: [received('a'), received('b', 'batch-1', { name: 'IMG_7.HEIC' })] } });
        client.behaviour.damaged = ['b'];

        // Act
        const isDone = await downloadZipAsync(app.context, { fileIds: ['a', 'b'], sessionId: 'session-1' });

        // Assert
        expect(isDone).toBe(false);
        expect(downloads).toEqual([]);
        expect(client.callsTo('markSavedAsync')).toEqual([]);
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent)
            .toBe('The stored copy of IMG_7.HEIC is damaged. Ask Pixel 8 · Blue Otter to send it again.');
    });
});

describe('Download ZIP from Received', () => {
    beforeEach(() => {
        downloads = [];
        document.addEventListener('click', captureDownload, true);
    });

    afterEach(() => {
        document.removeEventListener('click', captureDownload, true);
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
    });

    it('never downloads by itself: a finished batch stays off the Send tab and waits in Received for the tap, on every platform', async () => {
        for (const platform of ['desktop', 'android', 'ios'] as const) {
            // Arrange
            downloads = [];
            const { client, root } = await connectAsync({
                platform,
                client: {
                    files: [received('a'), received('b'), received('broken', 'batch-1', { note: 'damaged' })],
                    batches: [createBatchRecord({ itemCount: 3, received: 3, finishedAt: 1 })],
                },
            });
            client.emit('batch-progress', finished({ total: 3, done: 3, failed: 0 }));
            client.emit('file-done', received('a'));
            await settleAsync(450);
            const downloadsBeforeTap = downloads.length;
            const cardsInProgress = root.querySelectorAll('#panel-send .batch-card').length;

            // Act
            openReceivedTab(root);
            await settleAsync(300);
            const panel = root.querySelector<HTMLElement>('#panel-received') ?? root;
            buttonByText(panel, 'Select')?.click();
            buttonByText(panel, 'Select all')?.click();
            const label = panel.querySelector('.selection-bar [data-action="download-zip"]')?.textContent;
            panel.querySelector<HTMLButtonElement>('.selection-bar [data-action="download-zip"]')?.click();
            await vi.waitFor(() => expect(downloads).toHaveLength(1));

            // Assert
            expect(downloadsBeforeTap).toBe(0);
            expect(cardsInProgress).toBe(0);
            expect(label).toBe('Download ZIP (2)');
            expect(root.textContent).not.toMatch(/Ready to download|unzip/i);
            expect(client.callsTo('buildZipAsync')).toEqual([['session-1', ['a', 'b']]]);
            expect(client.callsTo('markSavedAsync')).toEqual([['session-1', ['a', 'b']]]);
            harness?.dispose();
            harness = undefined;
        }
    });

    it('lists a received file whose batch this device doesn’t know in Received, ready for a ZIP', async () => {
        // Arrange
        const { client, root } = await connectAsync({ client: { files: [received('single', 'sender-batch')] } });
        openReceivedTab(root);
        await settleAsync(300);
        const panel = root.querySelector<HTMLElement>('#panel-received') ?? root;

        // Act
        buttonByText(panel, 'Select')?.click();
        panel.querySelector<HTMLInputElement>('.file-row[data-file-id="single"] .file-check-box')?.click();
        panel.querySelector<HTMLButtonElement>('.selection-bar [data-action="download-zip"]')?.click();
        await vi.waitFor(() => expect(downloads).toHaveLength(1));

        // Assert
        expect(root.querySelectorAll('#panel-send .batch-card')).toHaveLength(0);
        expect(client.callsTo('buildZipAsync')).toEqual([['session-1', ['single']]]);
    });

    it('never mentions another way to save', async () => {
        // Act
        const { root } = await connectAsync({ client: { files: [received('a')], batches: [createBatchRecord()] } });
        openReceivedTab(root);

        // Assert
        expect(root.textContent).not.toMatch(/Share|Photos…|Save to|Download all/);
        expect(buttonByText(root, 'Save…')).toBeUndefined();
    });
});

function openReceivedTab(root: HTMLElement): void {
    root.querySelector<HTMLButtonElement>('[data-tab="received"]')?.click();
}
