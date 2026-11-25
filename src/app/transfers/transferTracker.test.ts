import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchIncoming, BatchProgress, ProgressInfo } from '../../client/clientTypes.js';
import { createFakeClient, createFileRecord } from '../testing/fakeClient.js';
import { createTransferTracker, REDRAW_INTERVAL_MS } from './transferTracker.js';
import type { TrackerChange } from './transferTracker.js';

function progress(percent: number): ProgressInfo {
    return {
        fileId: 'file-1',
        sessionId: 'session-1',
        direction: 'out',
        pagesDone: percent,
        totalPages: 100,
        bytesDone: percent * 1000,
        size: 100_000,
        percent,
        bytesPerSecond: 1_000_000,
        secondsLeft: 5,
    };
}

describe('createTransferTracker', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('redraws at most 10 times a second, with the latest progress (TR-10)', () => {
        // Arrange
        vi.useFakeTimers();
        const client = createFakeClient();
        const tracker = createTransferTracker(client);
        const changes: TrackerChange[] = [];
        tracker.onChange(change => changes.push(change));

        // Act
        for (let percent = 1; percent <= 30; percent++) {
            client.emit('progress', [progress(percent)]);
        }

        vi.advanceTimersByTime(REDRAW_INTERVAL_MS);

        // Assert
        expect(changes).toHaveLength(1);
        expect(changes[0]?.progress.map(item => item.percent)).toEqual([30]);
    });

    it('knows when a transfer runs, for the wake lock and the update banner', () => {
        // Arrange
        vi.useFakeTimers();
        const client = createFakeClient();
        const tracker = createTransferTracker(client);
        client.connect();

        // Act
        client.emit('file-state', createFileRecord({ state: 'active' }));
        const isRunning = tracker.isTransferring;
        client.emit('file-done', createFileRecord({ state: 'done' }));

        // Assert
        expect(isRunning).toBe(true);
        expect(tracker.isTransferring).toBe(false);
    });

    it('counts only the connected session’s files as running', () => {
        // Arrange
        const client = createFakeClient();
        const tracker = createTransferTracker(client);
        client.connect({ sessionId: 'session-b' });

        // Act
        client.emit('file-state', createFileRecord({ sessionId: 'session-a', state: 'active' }));
        const isOtherSessionRunning = tracker.isTransferring;
        client.setState('lost');
        client.emit('file-state', createFileRecord({ sessionId: 'session-b', state: 'active' }));

        // Assert
        expect(isOtherSessionRunning).toBe(false);
        expect(tracker.isTransferring).toBe(false);
    });

    it('keeps progress, errors and batch progress apart for two sessions with the same file and batch IDs', () => {
        // Arrange
        vi.useFakeTimers();
        const client = createFakeClient();
        const tracker = createTransferTracker(client);
        const inA = createFileRecord({ sessionId: 'session-a', fileId: 'same', direction: 'in', state: 'active' });
        const inB = createFileRecord({ sessionId: 'session-b', fileId: 'same', direction: 'in', state: 'done' });

        // Act
        client.emit('file-state', inA);
        client.emit('file-done', inB);
        client.emit('progress', [{ ...progress(40), sessionId: 'session-a', direction: 'in', fileId: 'same' }]);
        client.emit('batch-progress', { ...batch(), sessionId: 'session-a', done: 1 });
        client.emit('batch-progress', { ...batch(), sessionId: 'session-b', done: 3 });
        vi.advanceTimersByTime(REDRAW_INTERVAL_MS);

        // Assert
        expect(tracker.getProgress(inA)?.percent).toBe(40);
        expect(tracker.getProgress(inB)).toBeUndefined();
        expect(tracker.getRecord(inB)?.state).toBe('done');
        expect(tracker.getRecord(inA)?.state).toBe('active');
        expect(tracker.getBatchProgress('session-a', 'batch-1')?.done).toBe(1);
        expect(tracker.getBatchProgress('session-b', 'batch-1')?.done).toBe(3);
    });

    it('drops live rates when the link ends', () => {
        // Arrange
        const client = createFakeClient();
        const tracker = createTransferTracker(client);
        client.connect();
        const record = createFileRecord({ state: 'active' });
        client.emit('file-state', record);
        client.emit('progress', [progress(50)]);

        // Act
        client.setState('lost');

        // Assert
        expect(tracker.getProgress(record)).toBeUndefined();
    });

    it('lists batches waiting for an answer per session, until answered or the link ends (BK-03)', () => {
        // Arrange
        const client = createFakeClient();
        const tracker = createTransferTracker(client);
        let notified = 0;
        tracker.onBatchesChange(() => notified++);
        client.connect({ sessionId: 'session-a' });

        // Act
        client.emit('batch-incoming', incoming('batch-9'));
        client.emit('batch-incoming', incoming('batch-10'));
        const pending = tracker.pendingBatchesFor('session-a').map(item => item.batchId);
        const forOther = tracker.pendingBatchesFor('session-b');
        tracker.resolveBatch('session-a', 'batch-9');
        const afterAnswer = tracker.pendingBatchesFor('session-a').map(item => item.batchId);
        client.setState('lost');

        // Assert
        expect(pending).toEqual(['batch-9', 'batch-10']);
        expect(forOther).toEqual([]);
        expect(afterAnswer).toEqual(['batch-10']);
        expect(tracker.pendingBatchesFor('session-a')).toEqual([]);
        expect(notified).toBe(4);
    });

    it('remembers when this page first saw a batch run, from its files or its progress, but not from an ended one', () => {
        // Arrange
        vi.useFakeTimers({ now: 5_000 });
        const client = createFakeClient();
        const tracker = createTransferTracker(client);

        // Act
        client.emit('batch-progress', { ...batch(), batchId: 'ended', done: 3 });
        client.emit('batch-progress', batch());
        vi.advanceTimersByTime(1_000);
        client.emit('file-state', createFileRecord({ state: 'active', batchId: 'batch-1' }));
        client.emit('file-queued', createFileRecord({ fileId: 'file-2', batchId: 'batch-2' }));
        const marked = tracker.markBatchStarted('session-1', 'batch-3');

        // Assert
        expect(tracker.batchStartedAt('session-1', 'ended')).toBeUndefined();
        expect(tracker.batchStartedAt('session-1', 'batch-1')).toBe(5_000);
        expect(tracker.batchStartedAt('session-1', 'batch-2')).toBe(6_000);
        expect(marked).toBe(6_000);
        expect(tracker.markBatchStarted('session-1', 'batch-1')).toBe(5_000);
        expect(tracker.batchStartedAt('session-2', 'batch-1')).toBeUndefined();
    });

    it('keeps the batches dismissed with Done per session', () => {
        // Arrange
        const client = createFakeClient();
        const tracker = createTransferTracker(client);

        // Act
        tracker.dismissBatches('session-1', ['batch-1', 'batch-2']);

        // Assert
        expect(tracker.isBatchDismissed('session-1', 'batch-1')).toBe(true);
        expect(tracker.isBatchDismissed('session-1', 'batch-2')).toBe(true);
        expect(tracker.isBatchDismissed('session-1', 'batch-3')).toBe(false);
        expect(tracker.isBatchDismissed('session-2', 'batch-1')).toBe(false);
    });

    it('brings a dismissed batch back once it moves again, e.g. after Retry failed', () => {
        // Arrange
        const client = createFakeClient();
        const tracker = createTransferTracker(client);
        tracker.dismissBatches('session-1', ['batch-1']);

        // Act
        client.emit('file-queued', createFileRecord({ state: 'queued', batchId: 'batch-1' }));

        // Assert
        expect(tracker.isBatchDismissed('session-1', 'batch-1')).toBe(false);
    });
});

function batch(): BatchProgress {
    return {
        batchId: 'batch-1',
        sessionId: 'session-1',
        direction: 'in',
        total: 3,
        done: 0,
        saved: 0,
        failed: 0,
        canceled: 0,
        bytesDone: 0,
        totalBytes: 9_000_000,
        bytesPerSecond: 0,
    };
}

function incoming(batchId: string): BatchIncoming {
    return {
        batchId,
        peerName: 'Pixel 8',
        itemCount: 1240,
        totalBytes: 3_800_000_000,
        freeBytes: 21_000_000_000,
        fitsCount: 1240,
        fitsBytes: 3_800_000_000,
        spaceIsShort: false,
    };
}
