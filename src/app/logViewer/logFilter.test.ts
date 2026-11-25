import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_CATEGORIES } from '../../core/logger.js';
import type { LogEntry } from '../../core/logger.js';
import { createSampleLogEntries } from '../testing/adminFakes.js';
import {
    CATEGORY_FILTERS,
    collectFiles,
    createMatcher,
    DEFAULT_FILTER,
    describeFilter,
    isFilterActive,
} from './logFilter.js';

const ENTRIES = createSampleLogEntries();

function messages(entries: readonly LogEntry[]): string[] {
    return entries.map(entry => entry.msg);
}

describe('createMatcher', () => {
    it('keeps everything with the default filter', () => {
        // Act
        const kept = ENTRIES.filter(createMatcher(DEFAULT_FILTER));

        // Assert
        expect(kept).toHaveLength(ENTRIES.length);
        expect(isFilterActive(DEFAULT_FILTER)).toBe(false);
    });

    it('filters by the handshake category group', () => {
        // Act
        const kept = ENTRIES.filter(createMatcher({ ...DEFAULT_FILTER, category: 'handshake' }));

        // Assert
        expect(kept.every(entry => ['pair', 'ice', 'pairs', 'dtls'].includes(entry.cat))).toBe(true);
        expect(kept.length).toBeGreaterThan(5);
    });

    it('filters by minimum level', () => {
        // Act
        const kept = ENTRIES.filter(createMatcher({ ...DEFAULT_FILTER, level: 'warn' }));

        // Assert
        expect(messages(kept)).toEqual(['weak: 6.2 s since last message']);
    });

    it('filters by file', () => {
        // Act
        const kept = ENTRIES.filter(createMatcher({ ...DEFAULT_FILTER, fileId: 'f1c2a9e07b3d4411' }));

        // Assert
        expect(kept.every(entry => entry.fileId === 'f1c2a9e07b3d4411')).toBe(true);
        expect(kept).toHaveLength(4);
    });

    it('searches message, data and peer name, ignoring case', () => {
        // Arrange
        const peerEntry: LogEntry = { t: 1, wall: 1, level: 'info', cat: 'ice', msg: 'remote candidate', peer: 'peer-1' };

        // Act
        const byMessage = ENTRIES.filter(createMatcher({ ...DEFAULT_FILTER, text: 'FINGERPRINT OK' }));
        const byData = ENTRIES.filter(createMatcher({ ...DEFAULT_FILTER, text: '52344' }));
        const byPeer = [peerEntry].filter(createMatcher({ ...DEFAULT_FILTER, text: 'pixel' }, () => 'Pixel 8'));

        // Assert
        expect(messages(byMessage)).toEqual(['connected; fingerprint ok; sctp maxMessageSize 262144']);
        expect(byData.length).toBeGreaterThanOrEqual(3);
        expect(byPeer).toHaveLength(1);
    });
});

describe('collectFiles', () => {
    it('labels each file with its name when an entry carried one', () => {
        // Act
        const files = collectFiles(ENTRIES);

        // Assert
        expect([...files]).toEqual([['f1c2a9e07b3d4411', 'IMG_2231.MOV']]);
    });

    it('falls back to the short id', () => {
        // Act
        const files = collectFiles([{ t: 0, wall: 0, level: 'debug', cat: 'xfer', msg: 'page', fileId: 'abcdef0123456789' }]);

        // Assert
        expect(files.get('abcdef0123456789')).toBe('abcdef01');
    });
});

describe('describeFilter', () => {
    it('summarises the active filters for exports', () => {
        // Act
        const text = describeFilter({ category: 'xfer', level: 'warn', fileId: 'f1', text: ' nack ' }, 'IMG_2231.MOV');

        // Assert
        expect(text).toBe('category xfer, level warn+, file IMG_2231.MOV, text "nack"');
    });
});

describe('CATEGORY_FILTERS', () => {
    it('offers every log category, nearby included, each with its own colour', () => {
        // Arrange
        // Vitest runs from the repository root.
        const styles = readFileSync(join(process.cwd(), 'src', 'app', 'styles', '_log-viewer.scss'), 'utf-8');

        // Act
        const ids = CATEGORY_FILTERS.map(filter => filter.id);
        const uncoloured = LOG_CATEGORIES.filter(category => !styles.includes(`&[data-cat="${category}"]`));

        // Assert
        expect(ids).toEqual(expect.arrayContaining([...LOG_CATEGORIES]));
        expect(ids).toContain('nearby');
        expect(uncoloured).toEqual([]);
    });
});
