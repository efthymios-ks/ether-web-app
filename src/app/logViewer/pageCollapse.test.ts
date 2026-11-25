import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../core/logger.js';
import { createSampleLogEntries } from '../testing/adminFakes.js';
import { buildRows, isPageLine, rowEntries } from './pageCollapse.js';

describe('isPageLine', () => {
    it('recognises per-page debug lines in xfer', () => {
        // Arrange
        const base: LogEntry = { t: 0, wall: 0, level: 'debug', cat: 'xfer', msg: 'IMG.MOV page 3/10 ack 9 ms' };

        // Act & Assert
        expect(isPageLine(base)).toBe(true);
        expect(isPageLine({ ...base, msg: 'ack', page: 3 })).toBe(true);
        expect(isPageLine({ ...base, level: 'warn', msg: 'nack page 3/10' })).toBe(false);
        expect(isPageLine({ ...base, level: 'info', msg: 'IMG.MOV 1340/2048 (65.4%)' })).toBe(false);
    });
});

describe('buildRows', () => {
    it('keeps one row per entry when pages are few', () => {
        // Arrange
        const entries = createSampleLogEntries();

        // Act
        const rows = buildRows(entries);

        // Assert
        expect(rows).toHaveLength(entries.length);
        expect(rows.every(row => row.kind === 'entry')).toBe(true);
    });

    it('collapses a busy second of page lines into "+N pages" and keeps the summary (DL-09)', () => {
        // Arrange
        const entries = createSampleLogEntries({ pageBurst: 87 });

        // Act
        const rows = buildRows(entries);
        const groups = rows.filter(row => row.kind === 'pages');
        const last = rows.at(-1);

        // Assert
        expect(groups).toHaveLength(1);
        expect(groups[0]?.kind === 'pages' ? groups[0].entries : []).toHaveLength(87);
        expect(last?.kind === 'entry' ? last.entry.msg : '').toContain('summary');
        expect(rowEntries(rows)).toHaveLength(entries.length);
    });

    it('shows the page lines again when their group is expanded', () => {
        // Arrange
        const entries = createSampleLogEntries({ pageBurst: 30 });
        const group = buildRows(entries).find(row => row.kind === 'pages');

        // Act
        const rows = buildRows(entries, { expandedGroups: new Set(group?.kind === 'pages' ? [group.first] : []) });

        // Assert
        expect(rows.every(row => row.kind === 'entry')).toBe(true);
        expect(rows).toHaveLength(entries.length);
    });

    it('splits a busy second where another line interrupts the pages', () => {
        // Arrange
        const page = (index: number): LogEntry => ({ t: index, wall: 5000 + index, level: 'debug', cat: 'xfer', msg: `page ${index}/100` });
        const entries = [
            ...Array.from({ length: 12 }, (_, index) => page(index)),
            { t: 500, wall: 5500, level: 'info' as const, cat: 'xfer' as const, msg: 'summary' },
            ...Array.from({ length: 12 }, (_, index) => page(600 + index)),
        ];

        // Act
        const rows = buildRows(entries, { threshold: 20 });

        // Assert
        expect(rows.map(row => (row.kind === 'pages' ? `+${row.entries.length}` : row.entry.msg))).toEqual(['+12', 'summary', '+12']);
    });
});
