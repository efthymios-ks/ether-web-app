import { describe, expect, it } from 'vitest';
import { bytesForPages, countPages, median, pageLength, pageRange, resolveConcurrency } from './pagination.js';

const MIB = 1024 * 1024;

describe('countPages', () => {
    it.each([
        [0, MIB, 0],
        [1, MIB, 1],
        [MIB, MIB, 1],
        [MIB + 1, MIB, 2],
        [2048 * MIB, MIB, 2048],
    ])('splits %i bytes into pages of %i: %i pages (TR-01, TR-11)', (size, pageSize, expected) => {
        // Act
        const pages = countPages(size, pageSize);

        // Assert
        expect(pages).toBe(expected);
    });
});

describe('page ranges', () => {
    it('gives the last page the remainder', () => {
        // Act
        const ranges = [pageRange(2500, 1000, 2), pageLength(2500, 1000, 2), bytesForPages(2500, 1000, 3)];

        // Assert
        expect(ranges).toEqual([{ start: 2000, end: 2500 }, 500, 2500]);
    });
});

describe('resolveConcurrency', () => {
    it.each([
        [3, [100 * MIB], 3],
        [9, [1], 4],
        [0, [100 * MIB, 200 * MIB], 2],
        [0, [3 * MIB, 3 * MIB, 50 * MIB], 4],
        [0, [], 2],
    ])('setting %i with batch sizes %j uses %i slots (BK-05)', (setting, sizes, expected) => {
        // Act
        const slots = resolveConcurrency(setting, sizes);

        // Assert
        expect(slots).toBe(expected);
    });

    it('takes the middle value as the median', () => {
        // Act
        const values = [median([5, 1, 3]), median([4, 1, 3, 2])];

        // Assert
        expect(values).toEqual([3, 2.5]);
    });
});
