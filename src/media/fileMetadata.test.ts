import { describe, expect, it, vi } from 'vitest';
import { createLogger, SILENT_LOGGER } from '../core/logger.js';
import type { LogRouting } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { buildFileMetadata, extractFileMetadataAsync } from './fileMetadata.js';
import { formatLocalDate } from './metadataDates.js';
import type { EmbeddedMetadata } from './metadataTypes.js';

const LAST_MODIFIED = Date.UTC(2026, 10, 24, 8, 0, 0);

function createFile(name: string, type: string, relativePath = ''): File {
    const file = new File(['bytes'], name, { type, lastModified: LAST_MODIFIED });
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });

    return file;
}

const DEBUG_ROUTING: LogRouting = { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] };

function createTestLogger() {
    const memory = createMemorySink(20);
    const { logger } = createLogger({ sinks: [memory], routing: DEBUG_ROUTING });

    return { logger, memory };
}

describe('buildFileMetadata', () => {
    it('follows EXIF → QuickTime → mvhd for the date taken', () => {
        // Arrange
        const file = createFile('clip.mov', 'video/quicktime');
        const allDates = { exif: '2026-01-01T10:00:00', quicktime: '2026-01-02T10:00:00+01:00', mvhd: '2026-01-03T09:00:00Z' };

        // Act
        const sources = [
            buildFileMetadata(file, { dates: allDates }),
            buildFileMetadata(file, { dates: { quicktime: allDates.quicktime, mvhd: allDates.mvhd } }),
            buildFileMetadata(file, { dates: { mvhd: allDates.mvhd } }),
        ].map(metadata => [metadata.takenAt, metadata.takenAtSource]);

        // Assert
        expect(sources).toEqual([
            ['2026-01-01T10:00:00', 'exif'],
            ['2026-01-02T10:00:00+01:00', 'quicktime'],
            ['2026-01-03T09:00:00Z', 'mvhd'],
        ]);
    });

    it('falls back to the file date and adds the file-level fields', () => {
        // Arrange
        const file = createFile('IMG_1.jpg', 'image/jpeg', 'Trip/Day 1/IMG_1.jpg');

        // Act
        const metadata = buildFileMetadata(file, { make: 'Canon' });

        // Assert
        expect(metadata).toStrictEqual({
            takenAt: formatLocalDate(LAST_MODIFIED),
            takenAtSource: 'file',
            make: 'Canon',
            originalName: 'IMG_1.jpg',
            relativePath: 'Trip/Day 1/IMG_1.jpg',
        });
    });

    it('leaves the date out when the file has no usable date either', () => {
        // Arrange
        const file = { name: 'x.bin', lastModified: 0, webkitRelativePath: '' };

        // Act
        const metadata = buildFileMetadata(file, undefined);

        // Assert
        expect(metadata).toStrictEqual({ originalName: 'x.bin' });
    });
});

describe('extractFileMetadataAsync', () => {
    it('reads images, videos and audio with their reader and other files with none', async () => {
        // Arrange
        const image = vi.fn(async (): Promise<EmbeddedMetadata> => ({ dates: { exif: '2026-11-23T14:05:42+01:00' }, width: 10 }));
        const video = vi.fn(async (): Promise<EmbeddedMetadata> => ({ durationSeconds: 3 }));
        const audio = vi.fn(async (): Promise<EmbeddedMetadata> => ({ durationSeconds: 187.5 }));
        const options = { logger: SILENT_LOGGER, readers: { image, video, audio } };

        // Act
        const photo = await extractFileMetadataAsync(createFile('IMG.HEIC', ''), options);
        const clip = await extractFileMetadataAsync(createFile('clip.mp4', 'video/mp4'), options);
        const song = await extractFileMetadataAsync(createFile('song.m4a', ''), options);
        const document = await extractFileMetadataAsync(createFile('notes.pdf', 'application/pdf'), options);

        // Assert
        expect(photo).toMatchObject({ takenAt: '2026-11-23T14:05:42+01:00', takenAtSource: 'exif', width: 10 });
        expect(clip).toMatchObject({ takenAtSource: 'file', durationSeconds: 3 });
        expect(song).toMatchObject({ takenAtSource: 'file', durationSeconds: 187.5, originalName: 'song.m4a' });
        expect(document).toStrictEqual({
            takenAt: formatLocalDate(LAST_MODIFIED),
            takenAtSource: 'file',
            originalName: 'notes.pdf',
        });
        expect(image).toHaveBeenCalledTimes(1);
        expect(video).toHaveBeenCalledTimes(1);
        expect(audio).toHaveBeenCalledTimes(1);
    });

    it('resolves undefined once the time limit passes', async () => {
        // Arrange
        const { logger, memory } = createTestLogger();
        const readForeverAsync = (): Promise<EmbeddedMetadata> => new Promise(() => undefined);

        // Act
        const metadata = await extractFileMetadataAsync(createFile('IMG.jpg', 'image/jpeg'), {
            logger,
            timeoutMs: 20,
            readers: { image: readForeverAsync },
        });

        // Assert
        expect(metadata).toBeUndefined();
        expect(memory.entries().map(entry => entry.msg)).toEqual(['metadata took over 20 ms, sending without it']);
    });

    it('resolves undefined when a reader throws', async () => {
        // Arrange
        const { logger, memory } = createTestLogger();
        const readCorruptAsync = async (): Promise<EmbeddedMetadata> => {
            throw new Error('corrupt');
        };

        // Act
        const metadata = await extractFileMetadataAsync(createFile('IMG.jpg', 'image/jpeg'), {
            logger,
            readers: { image: readCorruptAsync },
        });

        // Assert
        expect(metadata).toBeUndefined();
        expect(memory.entries()[0]).toMatchObject({ level: 'warn', cat: 'xfer', data: { error: { message: 'corrupt' } } });
    });

    it('uses the real readers by default', async () => {
        // Arrange
        const file = createFile('clip.mov', 'video/quicktime');

        // Act
        const metadata = await extractFileMetadataAsync(file, { logger: SILENT_LOGGER });

        // Assert
        expect(metadata).toStrictEqual({
            takenAt: formatLocalDate(LAST_MODIFIED),
            takenAtSource: 'file',
            originalName: 'clip.mov',
        });
    });
});
