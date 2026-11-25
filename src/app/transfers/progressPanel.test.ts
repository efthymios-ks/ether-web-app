import { afterEach, describe, expect, it } from 'vitest';
import type { BatchIncoming, BatchProgress, FileRecord } from '../../client/clientTypes.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { createBatchRecord, createFileRecord, createSession, createUnfinishedElsewhere } from '../testing/fakeClient.js';
import { REDRAW_INTERVAL_MS } from './transferTracker.js';

// The Send tab: picker tiles when idle; the progress view with its sticky Total progress card when busy.

let harness: TestApp | undefined;

const PEER = 'Pixel 8 · Blue Otter';

function file(fileId: string, queueIndex: number, overrides: Partial<FileRecord> = {}): FileRecord {
    return createFileRecord({
        fileId,
        name: `${fileId}.MOV`,
        size: 2_000_000,
        direction: 'out',
        state: 'queued',
        batchId: 'batch-1',
        queueIndex,
        ...overrides,
    });
}

function progress(overrides: Partial<BatchProgress> = {}): BatchProgress {
    return {
        batchId: 'batch-1', sessionId: 'session-1', direction: 'out', total: 2, done: 1, saved: 0, failed: 0, canceled: 0,
        bytesDone: 3_000_000, totalBytes: 4_000_000, bytesPerSecond: 1_000_000, secondsLeft: 1, ...overrides,
    };
}

async function openAsync(options: TestAppOptions = {}, isConnected = true): Promise<TestApp> {
    harness = createTestApp({ ...options, client: { sessions: [createSession()], ...options.client } });
    await harness.app.startAsync();
    if (isConnected) {
        harness.client.connect();
    }

    harness.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'send' });
    await settleAsync(300);

    return harness;
}

async function emitAsync(app: TestApp, records: readonly FileRecord[]): Promise<void> {
    for (const record of records) {
        app.client.emit(record.state === 'done' ? 'file-done' : 'file-state', record);
    }

    await settleAsync(REDRAW_INTERVAL_MS + 400);
}

function panel(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>('#panel-send') ?? root;
}

function tileLabels(root: HTMLElement): string[] {
    return [...panel(root).querySelectorAll<HTMLElement>('.picker-tile')].map(tile => tile.textContent ?? '');
}

function total(root: HTMLElement): HTMLElement | null {
    return panel(root).querySelector<HTMLElement>('.transfer-total');
}

function visibleActions(root: HTMLElement): string[] {
    return [...(total(root)?.querySelectorAll<HTMLButtonElement>('.total-actions button:not([hidden])') ?? [])]
        .map(button => button.textContent ?? '');
}

describe('Send tab, idle', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('offers the platform’s pickers as tiles, with what happens to the files under them (§5)', async () => {
        // Arrange
        const { root } = await openAsync({ platform: 'ios' });
        const phone = { tiles: tileLabels(root), hint: panel(root).querySelector('.send-hint')?.textContent };
        harness?.dispose();

        // Act
        const desktop = await openAsync({ platform: 'desktop' });

        // Assert
        expect(phone).toEqual({
            tiles: ['Photos & videos', 'Files'],
            hint: `Files go straight to ${PEER}, encrypted. Received files download as one ZIP.`,
        });
        expect(tileLabels(desktop.root)).toEqual(['Files', 'Folder']);
        expect(total(desktop.root)?.hidden).toBe(true);
    });

    it('opens the picker behind a tile', async () => {
        // Arrange
        const { root } = await openAsync();
        let opened = 0;
        root.querySelector('[data-picker="files"]')?.addEventListener('click', () => opened++);

        // Act
        panel(root).querySelector<HTMLButtonElement>('[data-action="pick-files"]')?.click();

        // Assert
        expect(opened).toBe(1);
    });

    it('greys the tiles out while not connected and says why on a tap', async () => {
        // Arrange
        const { root } = await openAsync({}, false);
        let opened = 0;
        root.querySelector('[data-picker="files"]')?.addEventListener('click', () => opened++);

        // Act
        panel(root).querySelector<HTMLButtonElement>('[data-action="pick-files"]')?.click();

        // Assert
        expect(panel(root).querySelector('.send-hint')?.textContent).toBe(`Connect to ${PEER} again to send files.`);
        expect([...panel(root).querySelectorAll('.picker-tile')].map(tile => tile.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
        expect(opened).toBe(0);
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent).toBe(`Connect to ${PEER} first, then pick the files.`);
    });

    it('puts the unfinished files of other devices at the top', async () => {
        // Act
        const { root } = await openAsync({ client: { unfinishedElsewhere: [createUnfinishedElsewhere()] } });

        // Assert
        expect(panel(root).firstElementChild?.classList.contains('unfinished-elsewhere')).toBe(true);
        expect(panel(root).querySelector('.unfinished-elsewhere .prompt-text')?.textContent).toContain('3 unfinished files');
    });

    it('lists the files that need picking again, with Pick, under the tiles (PK-05)', async () => {
        // Arrange
        const record = createFileRecord({
            state: 'needs-file',
            batchId: 'old-batch',
            pagination: { pageSize: 1_048_576, totalPages: 10, currentPage: 3, pagesDone: 3, slot: null },
        });

        // Act
        const { root } = await openAsync({ client: { files: [record], batches: [createBatchRecord({ batchId: 'old-batch', direction: 'out' })] } });
        const section = [...panel(root).querySelectorAll<HTMLElement>('.progress-section')].find(item => !item.hidden);

        // Assert
        expect(tileLabels(root)).toEqual(['Files', 'Folder']);
        expect(section?.querySelector('.batch-title')?.textContent).toBe('Needs picking again');
        expect(section?.querySelector('.line-words')?.textContent).toBe('Pick it again to resume from page 3 of 10 (30%).');
        expect(section?.querySelector('[data-action="pick-again"]')?.textContent).toBe('Pick');
        expect(panel(root).querySelector('.batch-card')).toBeNull();
    });

    it('leaves a batch that finished before this page run out of the view', async () => {
        // Act
        const { root } = await openAsync({
            client: {
                files: [file('a', 0, { state: 'done' })],
                batches: [createBatchRecord({ direction: 'out', itemCount: 1, received: 1, finishedAt: 1 })],
            },
        });

        // Assert
        expect(panel(root).querySelector('.batch-card')).toBeNull();
        expect(panel(root).querySelector<HTMLElement>('.send-idle')?.hidden).toBe(false);
    });

    it('waits for the answer before showing a batch the receive dialog asks about', async () => {
        // Arrange
        const app = await openAsync({ client: { batches: [createBatchRecord({ batchId: 'asked', direction: 'in', received: 0 })] } });
        const asked: BatchIncoming = {
            batchId: 'asked',
            peerName: PEER,
            itemCount: 3,
            totalBytes: 9_000_000,
            fitsCount: 3,
            fitsBytes: 9_000_000,
            spaceIsShort: false,
        };

        // Act
        app.client.emit('batch-incoming', asked);
        await settleAsync(400);

        // Assert
        expect(panel(app.root).querySelector('.batch-card')).toBeNull();
        expect(document.querySelector('[data-prompt="receive"]')).not.toBeNull();
    });
});

describe('Send tab, busy', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    async function sendingAsync(): Promise<TestApp> {
        return openAsync({
            client: {
                files: [file('a', 0, { state: 'done' }), file('b', 1, { state: 'active' })],
                batches: [createBatchRecord({ direction: 'out', itemCount: 2, received: 1, totalBytes: 4_000_000 })],
            },
        });
    }

    it('shows the progress view with a sticky Total progress card in place of the tiles', async () => {
        // Arrange
        const app = await sendingAsync();

        // Act
        app.client.emit('batch-progress', progress());
        await settleAsync(REDRAW_INTERVAL_MS + 50);

        // Assert
        expect(panel(app.root).querySelector<HTMLElement>('.send-idle')?.hidden).toBe(true);
        expect(total(app.root)?.hidden).toBe(false);
        expect(total(app.root)?.querySelector('.total-title')?.textContent).toBe('Total progress');
        expect(total(app.root)?.querySelector('.total-clock')?.textContent).toMatch(/^\(\d+:\d\d\)$/);
        expect(total(app.root)?.querySelector('.total-percent')?.textContent).toBe('75%');
        expect(total(app.root)?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('75');
        expect(visibleActions(app.root)).toEqual(['Stop']);
        expect(total(app.root)?.querySelector('[data-action="advanced"]')).toBeNull();
    });

    it('always shows three lines: the counts, bytes and speed, time left; it waits for the connection while lost', async () => {
        // Arrange
        const app = await sendingAsync();

        // Act
        app.client.emit('batch-progress', progress());
        await settleAsync(REDRAW_INTERVAL_MS + 50);
        const shown = {
            isHidden: total(app.root)?.querySelector<HTMLElement>('.total-details')?.hidden,
            counts: total(app.root)?.querySelector('.total-counts')?.textContent,
            bytes: total(app.root)?.querySelector('.total-bytes')?.textContent,
            left: total(app.root)?.querySelector('.total-left')?.textContent,
        };
        app.client.setState('lost');
        await settleAsync();

        // Assert
        expect(shown).toEqual({
            isHidden: false,
            counts: '1 of 2 done',
            bytes: '3.0 MB of 4.0 MB · 1.0 MB/s',
            left: '1 s left',
        });
        expect(total(app.root)?.querySelector('.total-bytes')?.textContent).toBe('3.0 MB of 4.0 MB');
        expect(total(app.root)?.querySelector('.total-left')?.textContent).toBe('Waiting for the connection…');
    });

    it('asks before Stop, then stops every batch still moving, keeping what arrived', async () => {
        // Arrange
        const { root, client } = await sendingAsync();

        // Act
        buttonByText(total(root) ?? root, 'Stop')?.click();
        await settleAsync();
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
        const asked = {
            title: dialog?.querySelector('h2')?.textContent,
            message: dialog?.querySelector('.dialog-message')?.textContent,
            buttons: [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(button => button.textContent),
        };
        buttonByText(dialog ?? document.body, 'Stop')?.click();
        await settleAsync();

        // Assert
        expect(asked).toEqual({
            title: 'Stop sending?',
            message: `Finished files stay. Files still moving stop here and on ${PEER}; what arrived is kept, so you can resume them later.`,
            buttons: ['Keep going', 'Stop'],
        });
        expect(client.callsTo('stopBatchAsync')).toEqual([['session-1', 'batch-1', 'out']]);
        expect(client.callsTo('cancelBatchAsync')).toEqual([]);
    });

    it('reads Stopped with Resume and Done once nothing moves and files wait for Resume, and Resume continues them', async () => {
        // Arrange
        const app = await sendingAsync();
        await emitAsync(app, [file('b', 1, { state: 'active' })]);
        await emitAsync(app, [file('b', 1, { state: 'paused', pausedBy: 'stop' })]);
        const stopped = {
            title: total(app.root)?.querySelector('.total-title')?.textContent,
            clock: total(app.root)?.querySelector('.total-clock')?.textContent,
            counts: total(app.root)?.querySelector('.total-counts')?.textContent,
            left: total(app.root)?.querySelector('.total-left')?.textContent,
            actions: visibleActions(app.root),
            isStopped: total(app.root)?.dataset.stopped,
            isFinished: total(app.root)?.dataset.finished,
            status: total(app.root)?.querySelector('[role="status"]')?.textContent,
            line: panel(app.root).querySelectorAll('.batch-card .line-words')[1]?.textContent,
        };

        // Act
        buttonByText(total(app.root) ?? app.root, 'Resume')?.click();
        await settleAsync();

        // Assert
        expect(stopped).toEqual({
            title: 'Stopped',
            clock: expect.stringMatching(/^\(\d+:\d\d\)$/),
            counts: '1 of 2 done · 1 stopped',
            left: 'What arrived is kept. Resume continues from there.',
            actions: ['Resume', 'Done'],
            isStopped: 'true',
            isFinished: 'false',
            status: 'Stopped. 1 of 2 done · 1 stopped.',
            line: 'Stopped',
        });
        expect(app.client.callsTo('resumeBatchAsync')).toEqual([['session-1', 'batch-1', 'out']]);
    });

    it('keeps a stopped batch after a reload until Done, offering Resume only while connected', async () => {
        // Arrange
        const stoppedFiles = [file('a', 0, { state: 'done' }), file('b', 1, { state: 'paused', pausedBy: 'stop' })];
        const batches = [createBatchRecord({ direction: 'out', itemCount: 2, received: 1, totalBytes: 4_000_000 })];
        const offline = await openAsync({ client: { files: stoppedFiles, batches } }, false);
        const whileOffline = {
            hasBatch: panel(offline.root).querySelector('.batch-card') != null,
            actions: visibleActions(offline.root),
            left: total(offline.root)?.querySelector('.total-left')?.textContent,
        };
        offline.client.connect();
        await settleAsync(300);
        const whileConnected = visibleActions(offline.root);

        // Act
        buttonByText(total(offline.root) ?? offline.root, 'Done')?.click();
        offline.app.navigate({ name: 'home' });
        offline.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'send' });
        await settleAsync(300);

        // Assert
        expect(whileOffline).toEqual({ hasBatch: true, actions: ['Done'], left: `What arrived is kept. Connect to ${PEER} again to resume.` });
        expect(whileConnected).toEqual(['Resume', 'Done']);
        expect(panel(offline.root).querySelector('.batch-card')).toBeNull();
        expect(panel(offline.root).querySelector<HTMLElement>('.send-idle')?.hidden).toBe(false);
    });

    it('reads Finished with Send more and Done once everything moved, and Done brings the tiles back for good', async () => {
        // Arrange
        const app = await sendingAsync();
        await emitAsync(app, [file('b', 1, { state: 'active' })]);

        // Act
        await emitAsync(app, [file('b', 1, { state: 'done' })]);
        const finished = {
            title: total(app.root)?.querySelector('.total-title')?.textContent,
            percent: total(app.root)?.querySelector('.total-percent')?.textContent,
            actions: visibleActions(app.root),
            isFinished: total(app.root)?.dataset.finished,
        };
        buttonByText(total(app.root) ?? app.root, 'Done')?.click();
        const afterDone = {
            hasBatch: panel(app.root).querySelector('.batch-card') != null,
            isFocused: document.activeElement?.classList.contains('picker-tile'),
        };
        app.app.navigate({ name: 'home' });
        app.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'send' });
        await settleAsync(300);

        // Assert
        expect(finished).toEqual({ title: 'Finished', percent: '', actions: ['Send more', 'Done'], isFinished: 'true' });
        expect(afterDone).toEqual({ hasBatch: false, isFocused: true });
        expect(panel(app.root).querySelector('.batch-card')).toBeNull();
        expect(panel(app.root).querySelector<HTMLElement>('.send-idle')?.hidden).toBe(false);
    });

    it('tells screen readers when the transfer finishes, with the counts the card shows, not every percent', async () => {
        // Arrange
        const app = await sendingAsync();
        await emitAsync(app, [file('b', 1, { state: 'active' })]);
        const status = (): string | undefined => total(app.root)?.querySelector('[role="status"]')?.textContent ?? undefined;
        const whileMoving = status();

        // Act
        await emitAsync(app, [file('b', 1, { state: 'done' })]);

        // Assert
        const counts = total(app.root)?.querySelector('.total-counts')?.textContent;
        expect(whileMoving).toBe('');
        expect(counts).toMatch(/ of 2 done/);
        expect(status()).toBe(`Finished. ${counts}.`);
    });

    it('keeps a batch that ran during this page run on screen until Done, also after leaving the session', async () => {
        // Arrange
        const app = await sendingAsync();
        await emitAsync(app, [file('b', 1, { state: 'active' })]);
        await emitAsync(app, [file('b', 1, { state: 'done' })]);

        // Act
        app.app.navigate({ name: 'home' });
        app.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'send' });
        await settleAsync(300);

        // Assert
        expect(panel(app.root).querySelector('.batch-card')).not.toBeNull();
        expect(total(app.root)?.querySelector('.total-title')?.textContent).toBe('Finished');
    });

    it('sums the batches still moving: two batches, one card', async () => {
        // Act
        const { root } = await openAsync({
            client: {
                files: [file('a', 0, { state: 'active' }), file('b', 0, { batchId: 'batch-2', direction: 'in', state: 'active' })],
                batches: [
                    createBatchRecord({ direction: 'out', itemCount: 1, received: 0, createdAt: 1 }),
                    createBatchRecord({ batchId: 'batch-2', direction: 'in', itemCount: 3, received: 1, saved: 1, createdAt: 2 }),
                ],
            },
        });

        // Assert
        expect([...panel(root).querySelectorAll('.batch-title')].map(title => title.textContent).slice(0, 2))
            .toEqual([`Sending to ${PEER}`, `Receiving from ${PEER}`]);
        expect(total(root)?.querySelector('.total-counts')?.textContent).toBe('1 of 4 done · 1 downloaded');
    });

    it('lists unfinished files outside any batch under Unfinished', async () => {
        // Act
        const { root } = await openAsync({ client: { files: [createFileRecord({ fileId: 'loose', direction: 'in', state: 'active' })] } });
        const section = [...panel(root).querySelectorAll<HTMLElement>('.progress-section')].find(item => !item.hidden);

        // Assert
        expect(section?.querySelector('.batch-title')?.textContent).toBe('Unfinished');
        expect(section?.querySelectorAll('.progress-line')).toHaveLength(1);
    });
});
