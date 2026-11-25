import { describe, expect, it } from 'vitest';
import { createRateEstimator, secondsLeftAt } from './rateEstimator.js';

const KIB = 1024;

// Feeds a steady rate in half-second samples; `end` is the time of the last sample.
function feed(bytesPerSecond: number, seconds: number, startPosition = 0) {
    const estimator = createRateEstimator();
    for (let step = 0; step <= seconds * 2; step++) {
        estimator.record(startPosition + (bytesPerSecond * step) / 2, step * 500);
    }

    return { estimator, end: seconds * 1000 };
}

describe('createRateEstimator', () => {
    it('has no rate before the second sample', () => {
        // Arrange
        const estimator = createRateEstimator();

        // Act
        estimator.record(0, 0);
        estimator.record(0, 500);

        // Assert
        expect(estimator.bytesPerSecondAt(500)).toBe(0);
        expect(estimator.isStalled(60_000)).toBe(false);
    });

    it('uses the average since the start during the first seconds', () => {
        // Act
        const { estimator, end } = feed(100 * KIB, 2);

        // Assert
        expect(estimator.bytesPerSecondAt(end)).toBeCloseTo(100 * KIB, 0);
    });

    it('settles on a steady rate, slow links included', () => {
        // Act
        const fast = feed(30 * 1024 * KIB, 20);
        const slow = feed(8 * KIB, 60);

        // Assert
        expect(fast.estimator.bytesPerSecondAt(fast.end) / (30 * 1024 * KIB)).toBeCloseTo(1, 2);
        expect(slow.estimator.bytesPerSecondAt(slow.end) / (8 * KIB)).toBeCloseTo(1, 2);
    });

    it('counts from a resumed position, not from zero', () => {
        // Act
        const { estimator, end } = feed(50 * KIB, 10, 1312 * 1024 * KIB);

        // Assert
        expect(estimator.bytesPerSecondAt(end) / (50 * KIB)).toBeCloseTo(1, 2);
    });

    it('keeps a moving estimate when movement comes in rare whole-chunk steps', () => {
        // Arrange: 64 KiB chunks every 8 s on a link of 8 KiB/s.
        const estimator = createRateEstimator();
        const rates: number[] = [];

        // Act
        for (let time = 0; time <= 120_000; time += 500) {
            estimator.record(Math.floor(time / 8000) * 64 * KIB, time);
            if (time >= 60_000) {
                rates.push(estimator.bytesPerSecondAt(time));
            }
        }

        // Assert
        expect(Math.min(...rates)).toBeGreaterThan(4 * KIB);
        expect(Math.max(...rates)).toBeLessThan(16 * KIB);
        expect(estimator.isStalled(120_000)).toBe(false);
    });

    it('decays and reports stalled when nothing moves', () => {
        // Arrange
        const { estimator, end } = feed(100 * KIB, 10);
        const before = estimator.bytesPerSecondAt(end);

        // Act
        for (let time = 10_500; time <= 25_000; time += 500) {
            estimator.record(1000 * KIB, time);
        }

        // Assert
        expect(estimator.bytesPerSecondAt(25_000)).toBeLessThan(before / 5);
        expect(estimator.isStalled(25_000)).toBe(true);
        expect(estimator.isStalled(15_000)).toBe(false);
    });

    it('ignores a position that goes backwards', () => {
        // Arrange
        const { estimator, end } = feed(100 * KIB, 5);
        const before = estimator.bytesPerSecondAt(end);

        // Act
        estimator.record(0, end + 500);

        // Assert
        expect(estimator.bytesPerSecondAt(end + 500)).toBeLessThanOrEqual(before);
        expect(estimator.bytesPerSecondAt(end + 500)).toBeGreaterThan(0);
    });
});

describe('secondsLeftAt', () => {
    it('divides what is left by the rate', () => {
        // Act & Assert
        expect(secondsLeftAt(10 * KIB, 2 * KIB)).toBe(5);
        expect(secondsLeftAt(0, 0)).toBe(0);
        expect(secondsLeftAt(10 * KIB, 0)).toBeUndefined();
    });
});
