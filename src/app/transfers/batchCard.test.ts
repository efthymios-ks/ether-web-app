import { afterEach, describe, expect, it } from 'vitest';
import type { BatchProgress, Direction, FileRecord } from '../../client/clientTypes.js';
import { createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createBatchRecord, createFileRecord, createSession } from '../testing/fakeClient.js';
import { REDRAW_INTERVAL_MS } from './transferTracker.js';

// BK-01: a batch in the progress view: "Sending to <peer> · 2 of 6" with its ⋯, over a flat list of its files.

let harness: TestApp | undefined;

const PEER = 'Pixel 8 · Blue Otter';

function file(fileId: string, queueIndex: number, overrides: Partial<FileRecord> = {}): FileRecord {
    return createFileRecord({ fileId, name: `${fileId}.MOV`, size: 2_000_000, direction: 'out', state: 'queued', batchId: 'batch-1', queueIndex, ...overrides });
}

async function openAsync(direction: Direction, files: readonly FileRecord[], batch: Parameters<typeof createBatchRecord>[0] = {}): Promise<TestApp> {
    harness = createTestApp({
        client: {
            sessions: [createSession()],
            batches: [createBatchRecord({ direction, itemCount: files.length, received: 0, ...batch })],
            files: [...files],
        },
    });
    await harness.app.startAsync();
    harness.client.connect();
    harness.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'send' });
    await settleAsync(300);

    return harness;
}

async function emitAsync(app: TestApp, records: readonly FileRecord[]): Promise<void> {
    for (const record of records) {
        app.client.emit(record.state === 'done' ? 'file-done' : 'file-state', record);
    }

    await settleAsync(REDRAW_INTERVAL_MS + 50);
}

function progress(overrides: Partial<BatchProgress>): BatchProgress {
    return {
        batchId: 'batch-1', sessionId: 'session-1', direction: 'out', total: 3, done: 0, saved: 0, failed: 0, canceled: 0,
        bytesDone: 0, totalBytes: 6_000_000, bytesPerSecond: 0, ...overrides,
    };
}

function card(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>('#panel-send .batch-card');
}

function lines(root: HTMLElement): string[] {
    return [...(card(root)?.querySelectorAll<HTMLElement>('.progress-line') ?? [])]
        .map(line => {
            const state = line.dataset.moving === 'true' ? 'bar' : line.querySelector('.line-words')?.textContent;

            return `${line.querySelector('.line-name')?.textContent}: ${state}`;
        });
}

async function menuAsync(root: HTMLElement): Promise<string[]> {
    card(root)?.querySelector<HTMLButtonElement>('[data-action="batch-menu"]')?.click();
    await settleAsync();

    return [...document.querySelectorAll<HTMLButtonElement>('[data-layout="menu"] button')].map(button => button.textContent ?? '');
}

async function chooseAsync(label: string): Promise<void> {
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === label)?.click();
    await settleAsync();
}

describe('a batch in the progress view', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        document.querySelectorAll('.dialog-layer').forEach(layer => layer.replaceChildren());
    });

    it('shows "Sending to <peer>", its count and ⋯ over a flat list of "name (size)" lines', async () => {
        // Arrange
        const files = [file('a', 0, { state: 'done' }), file('b', 1, { state: 'active' }), file('c', 2)];

        // Act
        const { root } = await openAsync('out', files, { received: 1 });

        // Assert
        expect(card(root)?.querySelector('.batch-title')?.textContent).toBe(`Sending to ${PEER}`);
        expect(card(root)?.querySelector('.batch-count')?.textContent).toBe('1 of 3');
        expect([...(card(root)?.querySelectorAll<HTMLButtonElement>('.batch-head button') ?? [])].map(button => button.dataset.action))
            .toEqual(['batch-menu']);
        expect(lines(root)).toEqual(['a.MOV: Done', 'b.MOV: bar', 'c.MOV: Queue']);
        expect(card(root)?.querySelector('.line-size')?.textContent).toBe(' (2.0 MB)');
    });

    it('counts finished files, with failed, cancelled and stopped ones after the count', async () => {
        // Arrange
        const files = [file('a', 0, { state: 'active' }), file('b', 1, { state: 'active' }), file('c', 2, { state: 'paused', pausedBy: 'stop' })];
        const app = await openAsync('out', files);

        // Act
        app.client.emit('batch-progress', progress({ done: 1, failed: 1, canceled: 1 }));
        await settleAsync(REDRAW_INTERVAL_MS + 50);

        // Assert
        expect(card(app.root)?.querySelector('.batch-count')?.textContent).toBe('1 of 3 · 1 failed · 1 cancelled · 1 stopped');
    });

    it('says Receiving from <peer> while files arrive, and Received from once they all have', async () => {
        // Arrange
        const files = [file('a', 0, { direction: 'in', state: 'active' }), file('b', 1, { direction: 'in', state: 'queued' })];
        const app = await openAsync('in', files);
        const whileRunning = card(app.root)?.querySelector('.batch-title')?.textContent;

        // Act
        await emitAsync(app, [{ ...files[0], state: 'done' } as FileRecord, { ...files[1], state: 'done' } as FileRecord]);

        // Assert
        expect(whileRunning).toBe(`Receiving from ${PEER}`);
        expect(card(app.root)?.querySelector('.batch-title')?.textContent).toBe(`Received from ${PEER}`);
        expect(card(app.root)?.dataset.finished).toBe('true');
    });

    it('shows checks with a spinner and skipped files as "Skipped · already on <peer>"', async () => {
        // Arrange
        const files = Array.from({ length: 3 }, (_, index) => file(`f${index}`, index, { state: 'verifying', note: 'check-waiting' }));
        const app = await openAsync('out', files);

        // Act
        await emitAsync(app, [
            { ...files[0], state: 'done', note: 'already-on-peer' } as FileRecord,
            { ...files[1], note: 'checking' } as FileRecord,
        ]);

        // Assert
        expect(lines(app.root)).toEqual([`f0.MOV: Skipped · already on ${PEER}`, 'f1.MOV: Checking…', 'f2.MOV: Waiting to check']);
        expect(card(app.root)?.querySelectorAll('.progress-line .spinner-small:not([hidden])')).toHaveLength(1);
    });

    it('changes its lines in place while files move and finish, so nothing is replaced under a finger', async () => {
        // Arrange
        const files = Array.from({ length: 4 }, (_, index) => file(`f${index}`, index));
        const app = await openAsync('out', files);
        const before = [...(card(app.root)?.querySelectorAll('.progress-line') ?? [])];
        const added: string[] = [];
        const observer = new MutationObserver(records => {
            for (const record of records) {
                const nodes = [...record.addedNodes, ...record.removedNodes];
                if (nodes.some(node => node.nodeType === Node.ELEMENT_NODE && !(node as Element).matches('img'))) {
                    added.push((record.target as HTMLElement).className);
                }
            }
        });
        const panel = app.root.querySelector('#panel-send');
        if (panel != null) {
            observer.observe(panel, { childList: true, subtree: true });
        }

        // Act
        for (let index = 0; index < files.length; index++) {
            await emitAsync(app, [{ ...files[index], state: 'active' } as FileRecord]);
            app.client.emit('progress', [{
                fileId: files[index]?.fileId ?? '',
                sessionId: 'session-1',
                direction: 'out',
                pagesDone: 1,
                totalPages: 2,
                bytesDone: 1,
                size: 2,
                percent: 50,
                bytesPerSecond: 1,
            }]);
            await settleAsync(REDRAW_INTERVAL_MS + 50);
            await emitAsync(app, [{ ...files[index], state: 'done' } as FileRecord]);
        }

        await settleAsync(400);
        observer.disconnect();

        // Assert
        expect([...(card(app.root)?.querySelectorAll('.progress-line') ?? [])]).toEqual(before);
        expect(added).toEqual([]);
        expect(lines(app.root)).toEqual(['f0.MOV: Done', 'f1.MOV: Done', 'f2.MOV: Done', 'f3.MOV: Done']);
    });

    it('adds files new to the batch to its list, in their queue order', async () => {
        // Arrange
        const app = await openAsync('out', [file('a', 0, { state: 'active' })], { itemCount: 3 });

        // Act
        await emitAsync(app, [file('c', 2), file('b', 1)]);

        // Assert
        expect(lines(app.root)).toEqual(['a.MOV: bar', 'b.MOV: Queue', 'c.MOV: Queue']);
    });

    it('ignores another session’s file with the same batch ID', async () => {
        // Arrange
        const app = await openAsync('out', [file('mine', 0)]);

        // Act
        await emitAsync(app, [file('theirs', 0, { sessionId: 'session-2', state: 'active' })]);

        // Assert
        expect(lines(app.root)).toEqual(['mine.MOV: Queue']);
    });

    it('virtualises a large batch: only the lines near the view are in the page (UI-10)', async () => {
        // Arrange
        const files = Array.from({ length: 1000 }, (_, index) => file(`f${index}`, index));

        // Act
        const { root } = await openAsync('out', files);

        // Assert
        expect(card(root)?.querySelectorAll('.progress-line').length).toBeGreaterThan(0);
        expect(card(root)?.querySelectorAll('.progress-line').length).toBeLessThan(100);
        expect(card(root)?.querySelector('.batch-count')?.textContent).toBe('0 of 1,000');
    });

    it('offers Stop this batch, Show in Sent and Delete what arrived behind ⋯ while sending, and stops the rest, keeping what arrived', async () => {
        // Arrange
        const files = [file('a', 0, { state: 'done' }), file('b', 1, { state: 'active' }), file('c', 2)];
        const { root, client } = await openAsync('out', files, { received: 1 });

        // Act
        const labels = await menuAsync(root);
        await chooseAsync('Stop this batch');
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
        const asked = {
            title: dialog?.querySelector('h2')?.textContent,
            message: dialog?.querySelector('.dialog-message')?.textContent,
            buttons: [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(button => button.textContent),
            isDanger: dialog?.querySelector('[data-tone="danger"], .button-danger') != null,
        };
        await chooseAsync('Stop');

        // Assert
        expect(labels).toEqual(['Stop this batch', 'Show in Sent', 'Delete what arrived']);
        expect(asked).toEqual({
            title: 'Stop this batch?',
            message: `2 files that haven’t finished stop here and on ${PEER}. What arrived is kept, so you can resume them later.`,
            buttons: ['Keep going', 'Stop'],
            isDanger: false,
        });
        expect(client.callsTo('stopBatchAsync')).toEqual([['session-1', 'batch-1', 'out']]);
        expect(client.callsTo('cancelBatchAsync')).toEqual([]);
    });

    it('reads as stopped once nothing moves, and resumes from ⋯ with Resume this batch', async () => {
        // Arrange
        const files = [file('a', 0, { state: 'done' }), file('b', 1, { state: 'paused', pausedBy: 'stop' }), file('c', 2, { state: 'paused', pausedBy: 'stop' })];
        const { root, client } = await openAsync('out', files, { received: 1 });
        const shown = {
            title: card(root)?.querySelector('.batch-title')?.textContent,
            count: card(root)?.querySelector('.batch-count')?.textContent,
            isStopped: card(root)?.dataset.stopped,
            isFinished: card(root)?.dataset.finished,
            lines: lines(root),
        };

        // Act
        const labels = await menuAsync(root);
        await chooseAsync('Resume this batch');

        // Assert
        expect(shown).toEqual({
            title: `Sending to ${PEER}`,
            count: '1 of 3 · 2 stopped',
            isStopped: 'true',
            isFinished: 'false',
            lines: ['a.MOV: Done', 'b.MOV: Stopped', 'c.MOV: Stopped'],
        });
        expect(labels).toEqual(['Resume this batch', 'Show in Sent', 'Delete what arrived']);
        expect(client.callsTo('resumeBatchAsync')).toEqual([['session-1', 'batch-1', 'out']]);
    });

    it('deletes what arrived of the unfinished files on both devices from ⋯, after asking', async () => {
        // Arrange
        const files = [file('a', 0, { direction: 'in', state: 'done', hasData: true }), file('b', 1, { direction: 'in', state: 'paused', pausedBy: 'stop' })];
        const { root, client } = await openAsync('in', files, { received: 1 });

        // Act
        await menuAsync(root);
        await chooseAsync('Delete what arrived');
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
        const asked = {
            title: dialog?.querySelector('h2')?.textContent,
            message: dialog?.querySelector('.dialog-message')?.textContent,
            buttons: [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(button => button.textContent),
        };
        await chooseAsync('Delete');

        // Assert
        expect(asked).toEqual({
            title: 'Delete what arrived?',
            message: `1 file that hasn’t finished stops, and what arrived of it is deleted here and on ${PEER}. Finished files stay.`,
            buttons: ['Keep', 'Delete'],
        });
        expect(client.callsTo('cancelBatchAsync')).toEqual([['session-1', 'batch-1', 'in']]);
    });

    it('offers Retry failed for a batch whose files failed while connected', async () => {
        // Arrange
        const files = [file('a', 0, { state: 'done' }), file('b', 1, { state: 'failed' }), file('c', 2, { state: 'active' })];
        const { root, client } = await openAsync('out', files, { received: 1, failed: 1 });
        client.emit('batch-progress', progress({ total: 3, done: 1, failed: 1 }));
        await settleAsync(REDRAW_INTERVAL_MS + 50);

        // Act
        const labels = await menuAsync(root);
        await chooseAsync('Retry failed');

        // Assert
        expect(labels).toEqual(['Stop this batch', 'Retry failed', 'Show in Sent', 'Delete what arrived']);
        expect(client.callsTo('retryFailedAsync')).toEqual([['session-1', 'batch-1']]);
    });

    it('shows a received batch in Received from ⋯, filtered to it', async () => {
        // Arrange
        const files = [file('a', 0, { direction: 'in', state: 'done', hasData: true }), file('b', 1, { direction: 'in', state: 'active' })];
        const { root } = await openAsync('in', files, { received: 1 });

        // Act
        const labels = await menuAsync(root);
        await chooseAsync('Show in Received');
        await settleAsync(300);

        // Assert
        expect(labels).toEqual(['Stop this batch', 'Show in Received', 'Delete what arrived']);
        expect(root.querySelector('[data-tab="received"]')?.getAttribute('aria-selected')).toBe('true');
        expect(root.querySelector('#panel-received .files-filtered:not([hidden])')?.textContent).toBe('Filtered: This batchClear');
    });

    it('keeps every file’s actions a tap away: Cancel and Delete partial for a paused partial received file', async () => {
        // Arrange
        const files = [file('a', 0, {
            direction: 'in',
            state: 'paused',
            pausedBy: 'user',
            pagination: { pageSize: 1_048_576, totalPages: 10, currentPage: 4, pagesDone: 4, slot: null },
        }), file('b', 1, { direction: 'in', state: 'active' })];
        const { root } = await openAsync('in', files);

        // Act
        card(root)?.querySelector<HTMLButtonElement>('.progress-line .line-open')?.click();
        await settleAsync();
        const sheet = document.querySelector('.files-row-menu');

        // Assert
        expect([...(sheet?.querySelectorAll<HTMLButtonElement>('[data-action]') ?? [])].map(button => button.dataset.action))
            .toEqual(['resume', 'cancel', 'delete-partial']);
    });
});
