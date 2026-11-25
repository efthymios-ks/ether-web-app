import { describe, expect, it } from 'vitest';
import {
    formatClock,
    formatDay,
    formatLiveRate,
    formatMonth,
    formatPercent,
    formatShortWhen,
    formatSize,
    formatSpeed,
    formatTakenAt,
    formatTime,
    formatTimeLeft,
} from './format.js';

describe('formatSize', () => {
    it('uses decimal units the way phones show sizes', () => {
        // Act & Assert
        expect(formatSize(512)).toBe('512 B');
        expect(formatSize(3_800_000_000)).toBe('3.8 GB');
        expect(formatSize(21_000_000_000)).toBe('21.0 GB');
        expect(formatSize(250_000_000)).toBe('250 MB');
        expect(formatSpeed(28_000_000)).toBe('28.0 MB/s');
    });
});

describe('formatTimeLeft', () => {
    it('reads as seconds, minutes, or hours and minutes', () => {
        // Act & Assert
        expect(formatTimeLeft(undefined)).toBe('');
        expect(formatTimeLeft(24.2)).toBe('25 s left');
        expect(formatTimeLeft(150)).toBe('3 min left');
        expect(formatTimeLeft(3900)).toBe('1 h 5 min left');
        expect(formatTimeLeft(2 * 86_400 + 3 * 3600)).toBe('2 d 3 h left');
    });
});

describe('formatClock and formatPercent', () => {
    it('formats video lengths and progress', () => {
        // Act & Assert
        expect(formatClock(42)).toBe('0:42');
        expect(formatClock(3729)).toBe('1:02:09');
        expect(formatPercent(64.06)).toBe('64%');
        expect(formatPercent(0.5)).toBe('0.5%');
        expect(formatPercent(140)).toBe('100%');
    });
});

describe('formatDay', () => {
    it('names today and yesterday, and items without a date', () => {
        // Arrange
        const now = new Date(2026, 10, 23, 15, 0).getTime();

        // Act & Assert
        expect(formatDay('2026-11-23', now)).toBe('Today');
        expect(formatDay('2026-11-22', now)).toBe('Yesterday');
        expect(formatDay('no-date', now)).toBe('No date');
    });
});

describe('formatTakenAt', () => {
    it('keeps the time zone the photo was taken in (MD-07)', () => {
        // Act
        const text = formatTakenAt('2026-11-23T14:05:42+01:00');

        // Assert
        expect(text).toContain('UTC+01:00');
    });
});

describe('formatLiveRate', () => {
    it('shows speed and time left while bytes move, slow ones included', () => {
        // Act & Assert
        expect(formatLiveRate({ bytesPerSecond: 2_000_000, secondsLeft: 24.2 })).toEqual(['2.0 MB/s', '25 s left']);
        expect(formatLiveRate({ bytesPerSecond: 8 * 1024, secondsLeft: 1300 })).toEqual(['8.2 kB/s', '22 min left']);
    });

    it('says it is estimating before the first rate and waiting when stalled', () => {
        // Act & Assert
        expect(formatLiveRate({ bytesPerSecond: 0 })).toEqual(['Estimating time left…']);
        expect(formatLiveRate({ bytesPerSecond: 500, secondsLeft: 99, stalled: true })).toEqual(['Waiting for the connection…']);
    });
});

describe('formatShortWhen', () => {
    it('keeps a thin row’s date short: the time today, then Yesterday, then the date', () => {
        // Arrange
        const now = new Date(2026, 10, 24, 15, 0).getTime();
        const today = new Date(2026, 10, 24, 9, 19).getTime();

        // Act & Assert
        expect(formatShortWhen(today, now)).toBe(formatTime(today));
        expect(formatShortWhen(new Date(2026, 10, 23, 22, 0).getTime(), now)).toBe('Yesterday');
        expect(formatShortWhen(new Date(2026, 2, 3).getTime(), now)).not.toMatch(/2026/);
        expect(formatShortWhen(new Date(2025, 2, 3).getTime(), now)).toMatch(/2025/);
    });
});

describe('formatMonth', () => {
    it('names a month with its year, and says No date for anything else', () => {
        // Act & Assert
        expect(formatMonth('2026-11')).toBe(new Date(2026, 10, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
        expect(formatMonth('no-date')).toBe('No date');
    });
});
