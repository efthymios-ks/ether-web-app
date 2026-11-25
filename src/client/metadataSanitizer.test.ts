import { describe, expect, it } from 'vitest';
import { SILENT_LOGGER } from '../core/logger.js';
import { extractFileMetadataAsync } from '../media/fileMetadata.js';
import { sanitizeMetadata } from './metadataSanitizer.js';
import { MAX_MANIFEST_BYTES, jsonByteLength, validateManifest } from './protocol.js';

const GREEK = 'Τα παιδιά του Πειραιά';

function manifestFor(file: File, metadata: unknown): Record<string, unknown> {
    const sanitized = sanitizeMetadata(metadata);

    return {
        fileId: '0123456789abcdef0123456789abcdef',
        name: file.name,
        size: file.size,
        mime: file.type,
        lastModified: file.lastModified,
        relativePath: `Μουσική/${file.name}`,
        pageSize: 1024 * 1024,
        totalPages: 1,
        ...(sanitized ? { metadata: sanitized } : {}),
    };
}

function box(type: string, payload: Uint8Array): Uint8Array {
    const result = new Uint8Array(8 + payload.length);
    new DataView(result.buffer).setUint32(0, result.length);
    result.set(new TextEncoder().encode(type), 4);
    result.set(payload, 8);

    return result;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

// An iTunes-style m4a: mvhd with timescale 0, and an ilst with long lyrics and cover art.
function m4aBytes(): Uint8Array<ArrayBuffer> {
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(16, 1_000_000);
    const lyrics = new TextEncoder().encode(`${GREEK} `.repeat(400));
    const data = (bytes: Uint8Array): Uint8Array => box('data', concat(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), bytes));
    const ilst = box('ilst', concat(box('©lyr', data(lyrics)), box('covr', data(new Uint8Array(30_000)))));
    const meta = box('meta', concat(new Uint8Array(4), box('hdlr', new Uint8Array(25)), ilst));

    return concat(box('ftyp', new TextEncoder().encode('M4A isomiso2')), box('moov', concat(box('mvhd', mvhd), box('udta', meta))));
}

// An mp3 with an ID3v2 header and a long Greek title frame.
function mp3Bytes(): Uint8Array<ArrayBuffer> {
    const title = concat(new Uint8Array([3]), new TextEncoder().encode(GREEK.repeat(30)));
    const frame = concat(new TextEncoder().encode('TIT2'), new Uint8Array([0, 0, (title.length >> 7) & 0x7f, title.length & 0x7f, 0, 0]), title);
    const header = concat(new TextEncoder().encode('ID3'), new Uint8Array([3, 0, 0, 0, 0, (frame.length >> 7) & 0x7f, frame.length & 0x7f]));

    return concat(header, frame, new Uint8Array(2000));
}

describe('sanitizeMetadata', () => {
    it('drops non-finite and out-of-range numbers, unknown fields and empty strings', () => {
        // Act
        const metadata = sanitizeMetadata({
            durationSeconds: Number.NaN,
            rating: Number.POSITIVE_INFINITY,
            latitude: 123,
            longitude: 23.72,
            width: 0,
            height: 3024.5,
            orientation: 9,
            rotation: 90,
            make: '   ',
            model: 'iPhone 15',
            unknownField: 'x',
            takenAt: 'not a date',
        });

        // Assert
        expect(metadata).toEqual({ longitude: 23.72, rotation: 90, model: 'iPhone 15' });
    });

    it('caps strings and tags to the media layer\'s limits, by characters', () => {
        // Act
        const metadata = sanitizeMetadata({
            title: '🎵'.repeat(500),
            description: GREEK.repeat(200),
            tags: [...Array.from({ length: 50 }, (_, index) => `tag ${index}`), 'Tag 1', '  ', 7],
            originalName: 'ü'.repeat(400),
        });

        // Assert
        expect([...(metadata?.title ?? '')]).toHaveLength(200);
        expect([...(metadata?.description ?? '')]).toHaveLength(1000);
        expect(metadata?.tags).toHaveLength(30);
        expect([...(metadata?.originalName ?? '')]).toHaveLength(255);
    });

    it('returns undefined when nothing usable is left', () => {
        // Act
        const results = [sanitizeMetadata(undefined), sanitizeMetadata([]), sanitizeMetadata({ durationSeconds: Number.NaN })];

        // Assert
        expect(results).toEqual([undefined, undefined, undefined]);
    });

    it.each([
        ['an mp3 with ID3 tags', () => new File([mp3Bytes()], `${GREEK}.mp3`, { type: 'audio/mpeg', lastModified: 1_700_000_000_000 })],
        ['an m4a with lyrics and cover art', () => new File([m4aBytes()], `${GREEK}.m4a`, { type: 'audio/mp4', lastModified: 1_700_000_000_000 })],
        ['an m4a typed as video', () => new File([m4aBytes()], `${GREEK}.m4a`, { type: 'video/mp4', lastModified: 1_700_000_000_000 })],
    ])('turns what the media layer reads from %s into a valid, small manifest', async (_, makeFile) => {
        // Arrange
        const file = makeFile();

        // Act
        const metadata = await extractFileMetadataAsync(file, { logger: SILENT_LOGGER });
        const manifest = manifestFor(file, metadata);

        // Assert
        expect(validateManifest(manifest)).toBeUndefined();
        expect(jsonByteLength(manifest)).toBeLessThan(MAX_MANIFEST_BYTES / 8);
        expect(JSON.stringify(manifest)).not.toContain('null');
    });
});
