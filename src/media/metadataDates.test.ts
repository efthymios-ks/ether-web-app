import { describe, expect, it } from 'vitest';
import { formatLocalDate, formatUtcDate, normalizeOffset, parseMetadataDate, quickTimeSecondsToDate } from './metadataDates.js';

describe('parseMetadataDate', () => {
    it('turns an EXIF date into ISO 8601 with the EXIF offset', () => {
        // Act
        const date = parseMetadataDate('2026:11:23 14:05:42', '+01:00');

        // Assert
        expect(date).toBe('2026-11-23T14:05:42+01:00');
    });

    it('keeps wall-clock time without an offset when none is known', () => {
        // Act
        const date = parseMetadataDate('2026:11:23 14:05:42\0', '   :  ');

        // Assert
        expect(date).toBe('2026-11-23T14:05:42');
    });

    it('prefers the offset written in the value and normalises QuickTime "+0100"', () => {
        // Act
        const quickTime = parseMetadataDate('2026-11-23T14:05:42+0100', '-05:00');
        const xmp = parseMetadataDate('2026-11-23T14:05:42.123Z');
        const noSeconds = parseMetadataDate('2026-11-23T14:05');

        // Assert
        expect(quickTime).toBe('2026-11-23T14:05:42+01:00');
        expect(xmp).toBe('2026-11-23T14:05:42Z');
        expect(noSeconds).toBe('2026-11-23T14:05:00');
    });

    it('rejects placeholders, impossible dates and non-strings', () => {
        // Act
        const values = [
            parseMetadataDate('0000:00:00 00:00:00'),
            parseMetadataDate('2026:02:30 10:00:00'),
            parseMetadataDate('2026:11:23 25:00:00'),
            parseMetadataDate('yesterday'),
            parseMetadataDate(20261123),
        ];

        // Assert
        expect(values).toEqual([undefined, undefined, undefined, undefined, undefined]);
    });
});

describe('normalizeOffset', () => {
    it('accepts Z, ±HH:MM and ±HHMM and rejects anything out of range', () => {
        // Act
        const offsets = ['Z', '+05:30', '-0800', '+15:00', '+01:75', 'abc'].map(normalizeOffset);

        // Assert
        expect(offsets).toEqual(['Z', '+05:30', '-08:00', undefined, undefined, undefined]);
    });
});

describe('formatUtcDate', () => {
    it('drops milliseconds', () => {
        // Act
        const date = formatUtcDate(Date.UTC(2026, 10, 23, 13, 5, 42, 999));

        // Assert
        expect(date).toBe('2026-11-23T13:05:42Z');
    });
});

describe('formatLocalDate', () => {
    it('writes the same instant in local time with this device offset', () => {
        // Arrange
        const instant = Date.UTC(2026, 10, 23, 13, 5, 42);

        // Act
        const date = formatLocalDate(instant);

        // Assert
        expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
        expect(new Date(date).getTime()).toBe(instant);
    });
});

describe('quickTimeSecondsToDate', () => {
    it('converts seconds since 1904 to UTC and ignores unset values', () => {
        // Arrange
        const seconds = Date.UTC(2026, 10, 23, 13, 5, 42) / 1000 + 2_082_844_800;

        // Act
        const date = quickTimeSecondsToDate(seconds);
        const unset = quickTimeSecondsToDate(0);

        // Assert
        expect(date).toBe('2026-11-23T13:05:42Z');
        expect(unset).toBeUndefined();
    });
});
