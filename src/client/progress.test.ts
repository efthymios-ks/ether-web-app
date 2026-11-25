import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressInfo } from './clientTypes.js';
import { createProgressTracker } from './progress.js';
import type { ProgressSummary, ProgressUpdate } from './progress.js';

const MIB = 1024 * 1024;

function update(changes: Partial<ProgressUpdate> = {}): ProgressUpdate {
    return {
        fileId: 'f1',
        sessionId: 's1',
        direction: 'in',
        batchId: 'b1',
        name: 'IMG_2231.MOV',
        pagesDone: 0,
        totalPages: 10,
        bytesDone: 0,
        size: 10 * MIB,
        ...changes,
    };
}

describe('createProgressTracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits at most 10 events a second, one batched event for many files (CL-08)', () => {
        // Arrange
        const emitted: ProgressInfo[][] = [];
        const tracker = createProgressTracker({ now: () => Date.now(), emit: items => emitted.push([...items]) });

        // Act
        for (let step = 1; step <= 100; step++) {
            tracker.update(update({ pagesDone: step % 10, bytesDone: step * 10_000 }));
            tracker.update(update({ fileId: 'f2', bytesDone: step * 5000 }));
            vi.advanceTimersByTime(10);
        }

        // Assert
        expect(emitted).toHaveLength(10);
        expect(emitted.every(items => items.length === 2)).toBe(true);
        tracker.dispose();
    });

    it('measures speed and time left from page updates when there is no live position', () => {
        // Arrange
        const emitted: ProgressInfo[] = [];
        const tracker = createProgressTracker({ now: () => Date.now(), emit: items => emitted.push(...items) });

        // Act
        tracker.update(update({ bytesDone: 0 }));
        vi.advanceTimersByTime(1000);
        tracker.update(update({ pagesDone: 2, bytesDone: 2 * MIB }));
        vi.advanceTimersByTime(100);

        // Assert
        const last = emitted.at(-1);
        expect(last).toMatchObject({ pagesDone: 2, percent: 20 });
        expect(last?.bytesPerSecond).toBeCloseTo((2 * MIB) / 1.1, -3);
        expect(last?.secondsLeft).toBeCloseTo(4.4, 1);
        tracker.dispose();
    });

    it('keeps the estimate moving between pages on a slow link, from the live position', () => {
        // Arrange: a 1 MiB page at 20 KiB/s takes 51 s, so no page finishes in this test.
        const emitted: ProgressInfo[] = [];
        const tracker = createProgressTracker({ now: () => Date.now(), emit: items => emitted.push(...items) });
        let position = 0;
        tracker.update(update({ bytesDone: 0 }));
        tracker.trackPosition('s1', 'in', 'f1', () => position);

        // Act
        for (let step = 0; step < 100; step++) {
            vi.advanceTimersByTime(100);
            position += 2 * 1024;
        }

        // Assert
        const last = emitted.at(-1);
        expect(last?.pagesDone).toBe(0);
        expect((last?.bytesPerSecond ?? 0) / (20 * 1024)).toBeCloseTo(1, 1);
        expect((last?.secondsLeft ?? 0) / ((10 * MIB - 200 * 1024) / (20 * 1024))).toBeCloseTo(1, 1);
        expect(last?.stalled).toBeUndefined();
        expect(emitted.length).toBeGreaterThanOrEqual(19);
        tracker.dispose();
    });

    it('flags a transfer whose position stops moving as stalled', () => {
        // Arrange
        const emitted: ProgressInfo[] = [];
        const tracker = createProgressTracker({ now: () => Date.now(), emit: items => emitted.push(...items) });
        let position = 0;
        tracker.update(update({ bytesDone: 0 }));
        tracker.trackPosition('s1', 'in', 'f1', () => position);
        for (let step = 0; step < 50; step++) {
            vi.advanceTimersByTime(100);
            position += 10 * 1024;
        }

        // Act
        vi.advanceTimersByTime(15_000);

        // Assert
        expect(emitted.at(-1)?.stalled).toBe(true);
        tracker.dispose();
    });

    it('measures a batch of many small files with one steady rate', () => {
        // Arrange: 20 files of 100 KiB at 200 KiB/s, one after another, each done in half a second.
        const tracker = createProgressTracker({ now: () => Date.now(), emit: () => undefined });
        const rates: number[] = [];

        // Act
        for (let index = 0; index < 20; index++) {
            const fileId = `small-${index}`;
            const small = update({ fileId, totalPages: 1, size: 100 * 1024 });
            tracker.update(small);
            vi.advanceTimersByTime(500);
            tracker.update({ ...small, pagesDone: 1, bytesDone: 100 * 1024 });
            tracker.remove('s1', 'in', fileId);
            if (index >= 8) {
                rates.push(tracker.batchLive('b1').bytesPerSecond);
            }
        }

        // Assert
        expect(Math.min(...rates)).toBeGreaterThan(150 * 1024);
        expect(Math.max(...rates)).toBeLessThan(250 * 1024);
        tracker.dispose();
    });

    it('reports the live position and rate of a batch', () => {
        // Arrange
        const tracker = createProgressTracker({ now: () => Date.now(), emit: () => undefined });
        let position = 0;
        tracker.update(update({ bytesDone: 0 }));
        tracker.trackPosition('s1', 'in', 'f1', () => position);

        // Act
        for (let step = 0; step < 40; step++) {
            vi.advanceTimersByTime(100);
            position += 25 * 1024;
        }

        // Assert
        const live = tracker.batchLive('b1');
        expect(live.bytesDone).toBe(0);
        expect(live.position).toBeGreaterThan(800 * 1024);
        expect(live.bytesPerSecond / (256 * 1000)).toBeCloseTo(1, 1);
        expect(live.isStalled).toBe(false);
        tracker.dispose();
    });

    it('logs one summary per active file per second (DL-09) and stops its timer once its batch is closed', () => {
        // Arrange
        const summaries: ProgressSummary[] = [];
        const tracker = createProgressTracker({ now: () => Date.now(), emit: () => undefined, summarize: summary => summaries.push(summary) });

        // Act
        for (let step = 0; step < 30; step++) {
            tracker.update(update({ bytesDone: step * MIB / 10 }));
            vi.advanceTimersByTime(100);
        }

        tracker.remove('s1', 'in', 'f1');
        tracker.closeBatch('b1');
        vi.advanceTimersByTime(100);
        const timersAfterClose = vi.getTimerCount();

        // Assert
        expect(summaries.length).toBeGreaterThanOrEqual(2);
        expect(summaries.length).toBeLessThanOrEqual(3);
        expect(summaries[0]?.name).toBe('IMG_2231.MOV');
        expect(timersAfterClose).toBe(0);
    });

    it('keeps an unfinished batch with nothing moving emitting until it reads as stalled', () => {
        // Arrange
        const batchIds: string[][] = [];
        const itemCounts: number[] = [];
        const tracker = createProgressTracker({
            now: () => Date.now(),
            emit: (items, ids) => {
                itemCounts.push(items.length);
                batchIds.push([...ids]);
            },
        });
        for (let step = 1; step <= 20; step++) {
            tracker.update(update({ pagesDone: step % 10, bytesDone: step * MIB / 4 }));
            vi.advanceTimersByTime(100);
        }

        const movingRate = tracker.batchLive('b1').bytesPerSecond;

        // Act
        tracker.remove('s1', 'in', 'f1');
        const emittedBefore = batchIds.length;
        vi.advanceTimersByTime(20_000);
        const idle = tracker.batchLive('b1');

        // Assert
        expect(movingRate).toBeGreaterThan(0);
        expect(batchIds.length - emittedBefore).toBeGreaterThan(10);
        expect(batchIds.slice(emittedBefore).every(ids => ids.includes('b1'))).toBe(true);
        expect(itemCounts.slice(emittedBefore + 1).every(count => count === 0)).toBe(true);
        expect(idle.isStalled).toBe(true);
        expect(idle.bytesPerSecond).toBeLessThan(movingRate);
        tracker.dispose();
    });

    it('stops sampling an idle batch after a minute', () => {
        // Arrange
        const tracker = createProgressTracker({ now: () => Date.now(), emit: () => undefined });
        tracker.update(update({ bytesDone: MIB }));
        vi.advanceTimersByTime(600);

        // Act
        tracker.remove('s1', 'in', 'f1');
        vi.advanceTimersByTime(61_000);

        // Assert
        expect(vi.getTimerCount()).toBe(0);
    });

    it('emits the last state of a file when it is removed', () => {
        // Arrange
        const emitted: ProgressInfo[] = [];
        const tracker = createProgressTracker({ now: () => Date.now(), emit: items => emitted.push(...items) });

        // Act
        tracker.update(update({ pagesDone: 10, bytesDone: 10 * MIB }));
        tracker.remove('s1', 'in', 'f1');

        // Assert
        expect(emitted).toEqual([expect.objectContaining({ pagesDone: 10, percent: 100 })]);
        expect(tracker.get('s1', 'in', 'f1')).toBeUndefined();
    });

    it('keeps the same file of two sessions apart', () => {
        // Arrange
        const emitted: ProgressInfo[][] = [];
        const tracker = createProgressTracker({ now: () => Date.now(), emit: items => emitted.push([...items]) });

        // Act
        tracker.update(update({ sessionId: 's1', bytesDone: 3 * MIB }));
        tracker.update(update({ sessionId: 's2', batchId: 'b2', bytesDone: MIB }));
        vi.advanceTimersByTime(100);
        tracker.remove('s1', 'in', 'f1');

        // Assert
        expect(emitted[0]?.map(item => [item.sessionId, item.bytesDone])).toEqual([['s1', 3 * MIB], ['s2', MIB]]);
        expect(tracker.get('s1', 'in', 'f1')).toBeUndefined();
        expect(tracker.get('s2', 'in', 'f1')).toMatchObject({ sessionId: 's2', bytesDone: MIB });
        tracker.dispose();
    });
});
