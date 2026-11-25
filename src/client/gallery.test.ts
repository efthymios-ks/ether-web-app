import { describe, expect, it } from 'vitest';
import type { FileRecord } from './clientTypes.js';
import { NO_DATE, buildGallery, dayOf, galleryStatus } from './gallery.js';

function record(changes: Partial<FileRecord>): FileRecord {
    return {
        sessionId: 's1',
        fileId: 'f',
        direction: 'in',
        name: 'IMG.JPG',
        size: 10,
        mime: 'image/jpeg',
        kind: 'image',
        lastModified: 0,
        state: 'done',
        attempts: 0,
        createdAt: 0,
        updatedAt: 0,
        hasThumbnail: true,
        hasData: true,
        queueIndex: 0,
        ...changes,
    };
}

describe('galleryStatus', () => {
    it.each<[Partial<FileRecord>, string]>([
        [{ direction: 'in', state: 'queued' }, 'waiting'],
        [{ direction: 'in', state: 'active' }, 'receiving'],
        [{ direction: 'in', state: 'done' }, 'received'],
        [{ direction: 'in', state: 'done', savedAt: 1 }, 'saved'],
        [{ direction: 'in', state: 'canceled' }, 'failed'],
        [{ direction: 'out', state: 'needs-file' }, 'queued'],
        [{ direction: 'out', state: 'verifying' }, 'sending'],
        [{ direction: 'out', state: 'done' }, 'sent'],
    ])('maps %j to %s (GL-04, GL-07)', (changes, expected) => {
        // Act
        const status = galleryStatus(record(changes));

        // Assert
        expect(status).toBe(expected);
    });
});

describe('dayOf', () => {
    it('keeps the day as written with its offset, and no-date without one', () => {
        // Act
        const days = [
            dayOf(record({ metadata: { takenAt: '2026-11-23T23:30:00-05:00' } })),
            dayOf(record({})),
        ];

        // Assert
        expect(days).toEqual(['2026-11-23', NO_DATE]);
    });
});

describe('buildGallery', () => {
    it('groups by date taken, newest first, with no-date last, and applies the filter (GL-03, GL-05)', () => {
        // Arrange
        const files = [
            record({ fileId: 'a', metadata: { takenAt: '2026-11-20T10:00:00+01:00' } }),
            record({ fileId: 'b', metadata: { takenAt: '2026-11-23T09:00:00+01:00' } }),
            record({ fileId: 'c', metadata: { takenAt: '2026-11-23T18:00:00+01:00', durationSeconds: 12 }, kind: 'video', mime: 'video/mp4' }),
            record({ fileId: 'd' }),
            record({ fileId: 'e', state: 'failed', metadata: { takenAt: '2026-11-21T10:00:00+01:00' } }),
            record({ fileId: 'f', state: 'active', pagination: { pageSize: 1, totalPages: 4, currentPage: 1, pagesDone: 1, slot: 1 } }),
        ];

        // Act
        const all = buildGallery(files, { filter: 'all' });
        const videos = buildGallery(files, { filter: 'videos' });
        const failed = buildGallery(files, { filter: 'failed' });

        // Assert
        expect(all.map(group => [group.day, group.items.map(item => item.fileId)])).toEqual([
            ['2026-11-23', ['c', 'b']],
            ['2026-11-21', ['e']],
            ['2026-11-20', ['a']],
            [NO_DATE, ['d', 'f']],
        ]);
        expect(videos.flatMap(group => group.items)).toEqual([expect.objectContaining({ fileId: 'c', durationSeconds: 12 })]);
        expect(failed.flatMap(group => group.items.map(item => item.fileId))).toEqual(['e']);
        expect(all.at(-1)?.items[1]).toMatchObject({ status: 'receiving', progress: 0.25 });
    });
});
