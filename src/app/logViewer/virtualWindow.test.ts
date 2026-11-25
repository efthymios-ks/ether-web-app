import { describe, expect, it } from 'vitest';
import { computeWindow, indexAtOffset, rowOffset, totalHeight } from './virtualWindow.js';

describe('computeWindow', () => {
    it('renders only the rows in view plus the overscan (DL-10)', () => {
        // Act
        const range = computeWindow({ scrollTop: 1800, viewportHeight: 360, rowHeight: 18, count: 5000, overscan: 10 });

        // Assert
        expect(range.start).toBe(90);
        expect(range.end).toBe(131);
        expect(range.offset).toBe(1620);
        expect(range.totalHeight).toBe(90_000);
    });

    it('clamps at the ends of the list', () => {
        // Act
        const top = computeWindow({ scrollTop: 0, viewportHeight: 360, rowHeight: 18, count: 5 });
        const empty = computeWindow({ scrollTop: 0, viewportHeight: 360, rowHeight: 18, count: 0 });

        // Assert
        expect(top).toEqual({ start: 0, end: 5, offset: 0, totalHeight: 90 });
        expect(empty).toEqual({ start: 0, end: 0, offset: 0, totalHeight: 0 });
    });
});

describe('expanded rows', () => {
    it('adds the extra height of expanded rows to the offsets', () => {
        // Arrange
        const extras = [{ index: 2, extra: 100 }, { index: 5, extra: 40 }];

        // Act & Assert
        expect(totalHeight(10, 20, extras)).toBe(340);
        expect(rowOffset(2, 20, extras)).toBe(40);
        expect(rowOffset(3, 20, extras)).toBe(160);
        expect(rowOffset(6, 20, extras)).toBe(260);
    });

    it('finds the row under an offset, inside or after an expanded row', () => {
        // Arrange
        const extras = [{ index: 2, extra: 100 }];

        // Act & Assert
        expect(indexAtOffset(39, 20, 10, extras)).toBe(1);
        expect(indexAtOffset(45, 20, 10, extras)).toBe(2);
        expect(indexAtOffset(159, 20, 10, extras)).toBe(2);
        expect(indexAtOffset(160, 20, 10, extras)).toBe(3);
        expect(indexAtOffset(10_000, 20, 10, extras)).toBe(9);
    });
});
