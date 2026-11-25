import { describe, expect, it } from 'vitest';
import type { GalleryGroup, GalleryItem } from '../../client/clientTypes.js';
import { computeOffsets, rowAt, visibleRange } from '../history/virtualList.js';
import { buildRows, cellSizeFor, columnsFor, rowHasFile } from './galleryLayout.js';
import { createSelection } from './gallerySelection.js';

function item(fileId: string): GalleryItem {
    return {
        fileId,
        sessionId: 'session-1',
        direction: 'in',
        name: `${fileId}.jpg`,
        mime: 'image/jpeg',
        size: 3_000_000,
        kind: 'image',
        status: 'received',
        hasThumbnail: true,
        hasData: true,
    };
}

function group(day: string, count: number, prefix: string): GalleryGroup {
    return { day, items: Array.from({ length: count }, (_, index) => item(`${prefix}${index}`)) };
}

describe('gallery layout', () => {
    it('picks columns by width with cells of at least 80 px (GL-01)', () => {
        // Act & Assert
        expect(columnsFor(358)).toBe(4);
        expect(columnsFor(640)).toBeGreaterThanOrEqual(6);
        expect(columnsFor(940)).toBeGreaterThanOrEqual(8);
        expect(cellSizeFor(358, 4)).toBeGreaterThanOrEqual(80);
    });

    it('builds a day header and rows of cells per day, newest first as given (GL-03)', () => {
        // Arrange
        const groups = [group('2026-11-23', 5, 'a'), group('no-date', 2, 'b')];

        // Act
        const rows = buildRows(groups, 4);

        // Assert
        expect(rows.map(row => row.kind)).toEqual(['header', 'cells', 'cells', 'header', 'cells']);
        expect(rows[2]?.items.map(entry => entry.fileId)).toEqual(['a4']);
        expect(rows[4]?.kind === 'cells' ? rows[4].firstIndex : -1).toBe(5);
        expect(rows.findIndex(row => rowHasFile(row, 'b1'))).toBe(4);
    });

    it('keeps the same item findable after the column count changes on rotation', () => {
        // Arrange
        const groups = [group('2026-11-23', 30, 'a')];

        // Act
        const portrait = buildRows(groups, 4).findIndex(row => rowHasFile(row, 'a17'));
        const landscape = buildRows(groups, 8).findIndex(row => rowHasFile(row, 'a17'));

        // Assert
        expect(portrait).toBe(5);
        expect(landscape).toBe(3);
    });
});

describe('virtual list range', () => {
    it('keeps only the rows on screen plus one screen above and below (UI-10, GL-01)', () => {
        // Arrange
        const offsets = computeOffsets(Array.from({ length: 1000 }, () => 100));

        // Act
        const range = visibleRange(offsets, 50_000, 800);

        // Assert
        expect(rowAt(offsets, 50_050)).toBe(500);
        expect(range.start).toBe(492);
        expect(range.end).toBe(517);
        expect(range.end - range.start).toBeLessThan(30);
    });

    it('handles an empty list', () => {
        // Act & Assert
        expect(visibleRange([0], 0, 800)).toEqual({ start: 0, end: 0 });
    });
});

describe('createSelection', () => {
    it('applies the anchor item’s state to a range, both ends included (GL-03)', () => {
        // Arrange
        const selection = createSelection();
        const ordered = ['a', 'b', 'c', 'd', 'e'];

        // Act
        selection.toggle('b');
        selection.applyRange(ordered, 'd');
        const selected = selection.ids().sort();
        selection.toggle('c');
        selection.applyRange(ordered, 'e');

        // Assert
        expect(selected).toEqual(['b', 'c', 'd']);
        expect(selection.ids()).toEqual(['b']);
        expect(selection.anchor).toBe('e');
    });

    it('selects a day, toggles off, and drops ids that no longer exist', () => {
        // Arrange
        const selection = createSelection();
        let changes = 0;
        selection.onChange(() => changes++);

        // Act
        selection.setMany(['a', 'b', 'c'], true);
        selection.toggle('b');
        selection.retain(['a']);

        // Assert
        expect(selection.ids()).toEqual(['a']);
        expect(changes).toBe(3);
    });
});
