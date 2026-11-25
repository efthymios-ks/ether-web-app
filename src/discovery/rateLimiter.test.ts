import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rateLimiter.js';

function createLimiter(maxKeys = 10): { take(key: string): boolean; advance(ms: number): void; clear(): void } {
    let time = 0;
    const limiter = createRateLimiter({ burst: 3, refillMs: 1000, maxKeys, now: () => time });

    return {
        take: key => limiter.take(key),
        advance: ms => {
            time += ms;
        },
        clear: () => limiter.clear(),
    };
}

describe('createRateLimiter', () => {
    it('allows a burst, then one per refill period', () => {
        // Arrange
        const limiter = createLimiter();

        // Act
        const burst = [limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('a')];
        limiter.advance(999);
        const early = limiter.take('a');
        limiter.advance(1);
        const refilled = [limiter.take('a'), limiter.take('a')];

        // Assert
        expect(burst).toEqual([true, true, true, false]);
        expect(early).toBe(false);
        expect(refilled).toEqual([true, false]);
    });

    it('keeps each key in its own bucket', () => {
        // Arrange
        const limiter = createLimiter();
        limiter.take('a');
        limiter.take('a');
        limiter.take('a');

        // Act
        const other = limiter.take('b');

        // Assert
        expect(other).toBe(true);
    });

    it('refills no further than the burst after a long quiet spell', () => {
        // Arrange
        const limiter = createLimiter();
        limiter.take('a');
        limiter.advance(60_000);

        // Act
        const results = [limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('a')];

        // Assert
        expect(results).toEqual([true, true, true, false]);
    });

    it('forgets the oldest keys beyond its cap, and everything on clear', () => {
        // Arrange
        const limiter = createLimiter(2);
        for (let index = 0; index < 3; index++) {
            limiter.take('a');
        }

        // Act
        limiter.take('b');
        limiter.take('c');
        const forgotten = limiter.take('a');
        for (let index = 0; index < 3; index++) {
            limiter.take('d');
        }

        limiter.clear();
        const cleared = limiter.take('d');

        // Assert
        expect(forgotten).toBe(true);
        expect(cleared).toBe(true);
    });
});
