import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../core/logger.js';
import type { LogRouting } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { findMovieBoxAsync, parseIso6709, parseMovieBox, readVideoMetadataAsync } from './videoMetadata.js';

const QUICKTIME_EPOCH_OFFSET_SECONDS = 2_082_844_800;
const ROTATE_90 = [0, 1, 0, -1, 0, 0, 0, 0, 1];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let position = 0;
    for (const part of parts) {
        result.set(part, position);
        position += part.length;
    }

    return result;
}

function uint16(value: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value);

    return bytes;
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value);

    return bytes;
}

function uint64(value: number): Uint8Array<ArrayBuffer> {
    return concat(uint32(Math.floor(value / 0x1_0000_0000)), uint32(value % 0x1_0000_0000));
}

function int32(value: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value);

    return bytes;
}

function latin1(text: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(text, character => character.charCodeAt(0));
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(text);
}

function rawBox(type: Uint8Array, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const payload = concat(...parts);

    return concat(uint32(8 + payload.length), type, payload);
}

function box(type: string, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    return rawBox(latin1(type), ...parts);
}

function largeBox(type: string, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const payload = concat(...parts);

    return concat(uint32(1), latin1(type), uint64(16 + payload.length), payload);
}

function fullBox(type: string, version: number, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    return box(type, Uint8Array.of(version, 0, 0, 0), ...parts);
}

function quickTimeSeconds(epochMs: number): number {
    return epochMs / 1000 + QUICKTIME_EPOCH_OFFSET_SECONDS;
}

function movieHeader(created: number, timescale: number, duration: number): Uint8Array<ArrayBuffer> {
    return fullBox('mvhd', 0, uint32(created), uint32(created), uint32(timescale), uint32(duration), new Uint8Array(80));
}

function movieHeaderLong(created: number, timescale: number, duration: number): Uint8Array<ArrayBuffer> {
    return fullBox('mvhd', 1, uint64(created), uint64(created), uint32(timescale), uint64(duration), new Uint8Array(80));
}

function track(matrix: readonly number[], width: number, height: number): Uint8Array<ArrayBuffer> {
    return box(
        'trak',
        fullBox(
            'tkhd',
            0,
            new Uint8Array(20),
            new Uint8Array(16),
            ...matrix.map((value, index) => int32((index + 1) % 3 === 0 ? value * 0x40000000 : value * 0x10000)),
            uint32(width * 0x10000),
            uint32(height * 0x10000),
        ),
    );
}

function appleMetadata(values: Readonly<Record<string, string>>): Uint8Array<ArrayBuffer> {
    const keys = Object.keys(values);
    const keyEntries = keys.map(key => concat(uint32(8 + utf8(key).length), latin1('mdta'), utf8(key)));
    const items = keys.map((key, index) => rawBox(uint32(index + 1), box('data', uint32(1), uint32(0), utf8(values[key] ?? ''))));

    return box(
        'meta',
        fullBox('hdlr', 0, uint32(0), latin1('mdta'), new Uint8Array(13)),
        fullBox('keys', 0, uint32(keys.length), ...keyEntries),
        box('ilst', ...items),
    );
}

function textAtom(type: string, text: string): Uint8Array<ArrayBuffer> {
    return box(type, uint16(utf8(text).length), uint16(0x15c7), utf8(text));
}

function iphoneMovie(): Uint8Array<ArrayBuffer> {
    const created = quickTimeSeconds(Date.UTC(2026, 10, 23, 13, 5, 42));

    return concat(
        box('ftyp', latin1('qt  '), uint32(0), latin1('qt  ')),
        box('wide'),
        largeBox('mdat', new Uint8Array(200_000)),
        box(
            'moov',
            movieHeader(created, 600, 7500),
            track(IDENTITY, 0, 0),
            track(ROTATE_90, 1920, 1080),
            appleMetadata({
                'com.apple.quicktime.location.ISO6709': '+37.3317-122.0302+012.345/',
                'com.apple.quicktime.make': 'Apple',
                'com.apple.quicktime.model': 'iPhone 15 Pro',
                'com.apple.quicktime.creationdate': '2026-11-23T14:05:42+0100',
                'com.apple.quicktime.software': '18.1',
            }),
        ),
    );
}

const DEBUG_ROUTING: LogRouting = { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] };

function createTestLogger() {
    const memory = createMemorySink(20);
    const { logger } = createLogger({ sinks: [memory], routing: DEBUG_ROUTING });

    return { logger, memory };
}

describe('readVideoMetadataAsync', () => {
    it('reads an iPhone movie whose moov sits after a 64-bit mdat', async () => {
        // Arrange
        const { logger } = createTestLogger();
        const file = new File([iphoneMovie()], 'IMG_2231.MOV', { type: 'video/quicktime' });

        // Act
        const metadata = await readVideoMetadataAsync(file, logger);

        // Assert
        expect(metadata).toStrictEqual({
            dates: { quicktime: '2026-11-23T14:05:42+01:00', mvhd: '2026-11-23T13:05:42Z' },
            durationSeconds: 12.5,
            width: 1920,
            height: 1080,
            rotation: 90,
            latitude: 37.3317,
            longitude: -122.0302,
            altitude: 12.3,
            make: 'Apple',
            model: 'iPhone 15 Pro',
        });
    });

    it('reads only box headers until the moov box', async () => {
        // Arrange
        const bytes = iphoneMovie();
        const file = new File([bytes], 'IMG_2231.MOV');
        const slice = vi.spyOn(file, 'slice');

        // Act
        const movie = await findMovieBoxAsync(file);

        // Assert
        expect(movie?.type).toBe('moov');
        expect(movie?.end).toBe(bytes.length);
        for (const [start = 0, end = 0] of slice.mock.calls) {
            expect(end - start).toBeLessThanOrEqual(16);
        }
    });

    it('reads Android location from ©xyz in udta and a 64-bit mvhd', async () => {
        // Arrange
        const { logger } = createTestLogger();
        const created = quickTimeSeconds(Date.UTC(2026, 6, 14, 9, 30, 0));
        const bytes = concat(
            box('ftyp', latin1('isom'), uint32(0), latin1('isommp42')),
            box(
                'moov',
                movieHeaderLong(created, 1000, 3200),
                track(IDENTITY, 3840, 2160),
                box('udta', textAtom('©xyz', '+48.8584+002.2945/'), textAtom('©mod', 'Pixel 8')),
            ),
            box('mdat', new Uint8Array(64)),
        );

        // Act
        const metadata = await readVideoMetadataAsync(new File([bytes], 'PXL_1.mp4'), logger);

        // Assert
        expect(metadata).toStrictEqual({
            dates: { mvhd: '2026-07-14T09:30:00Z' },
            durationSeconds: 3.2,
            width: 3840,
            height: 2160,
            rotation: 0,
            latitude: 48.8584,
            longitude: 2.2945,
            model: 'Pixel 8',
        });
    });

    it('treats an unset mvhd creation time as missing', () => {
        // Arrange
        const moov = movieHeader(0, 600, 600);

        // Act
        const metadata = parseMovieBox(moov);

        // Assert
        expect(metadata).toStrictEqual({ durationSeconds: 1 });
    });

    it('keeps only file-level fields for fragmented MP4', () => {
        // Arrange
        const header = movieHeader(quickTimeSeconds(Date.UTC(2026, 0, 1)), 1000, 0);
        const moov = concat(header, box('mvex', fullBox('trex', 0, new Uint8Array(20))));

        // Act
        const metadata = parseMovieBox(moov);

        // Assert
        expect(metadata).toStrictEqual({});
    });

    it('resolves undefined when an mdat of size 0 runs to the end without a moov', async () => {
        // Arrange
        const { logger, memory } = createTestLogger();
        const bytes = concat(box('ftyp', latin1('isom')), uint32(0), latin1('mdat'), new Uint8Array(100));

        // Act
        const metadata = await readVideoMetadataAsync(new File([bytes], 'cut.mp4'), logger);

        // Assert
        expect(metadata).toBeUndefined();
        expect(memory.entries().map(entry => entry.msg)).toEqual(['video has no moov box']);
    });

    it('resolves undefined for files that are not ISO media', async () => {
        // Arrange
        const { logger } = createTestLogger();
        const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00);
        const truncated = concat(box('ftyp', latin1('isom')), uint32(5000), latin1('moov'));

        // Act
        const results = await Promise.all([
            readVideoMetadataAsync(new File([jpeg], 'photo.mov'), logger),
            readVideoMetadataAsync(new File([truncated], 'cut.mov'), logger),
        ]);

        // Assert
        expect(results).toEqual([undefined, undefined]);
    });

    it('survives a damaged moov payload', () => {
        // Arrange
        const moov = concat(box('trak', box('tkhd', Uint8Array.of(0, 0))), box('meta', uint32(0)), uint32(3), latin1('udta'));

        // Act
        const metadata = parseMovieBox(moov);

        // Assert
        expect(metadata).toStrictEqual({});
    });
});

describe('parseIso6709', () => {
    it('reads decimal degrees with altitude', () => {
        // Act
        const location = parseIso6709('+37.3317-122.0302+012.345/');

        // Assert
        expect(location).toStrictEqual({ latitude: 37.3317, longitude: -122.0302, altitude: 12.3 });
    });

    it('reads degrees-minutes and degrees-minutes-seconds forms', () => {
        // Act
        const minutes = parseIso6709('+4851.5040+00217.6700/');
        const seconds = parseIso6709('+485130.24+0021740.20CRSWGS_84/');

        // Assert
        expect(minutes).toStrictEqual({ latitude: 48.8584, longitude: 2.2945 });
        expect(seconds).toStrictEqual({ latitude: 48.8584, longitude: 2.2945 });
    });

    it('rejects out-of-range, empty and malformed values', () => {
        // Act
        const values = ['+91.0000+000.0000/', '+00.0000+000.0000/', 'here', '', '+485.5+0021.5/'].map(parseIso6709);

        // Assert
        expect(values).toEqual([undefined, undefined, undefined, undefined, undefined]);
    });
});
