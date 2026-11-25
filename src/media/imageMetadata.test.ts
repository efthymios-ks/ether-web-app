import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SILENT_LOGGER } from '../core/logger.js';
import { crc32 } from './crc32.js';
import { mapExifrOutput, readEmbeddedThumbnailAsync, readImageMetadataAsync } from './imageMetadata.js';

const TIFF_TYPES = Object.freeze({ byte: 1, ascii: 2, short: 3, long: 4, rational: 5 });
const THUMBNAIL = Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xd9);

interface TiffField {
    readonly tag: number;
    readonly type: number;
    readonly count: number;
    readonly bytes: Uint8Array;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let position = 0;
    for (const part of parts) {
        result.set(part, position);
        position += part.length;
    }

    return result;
}

function numberBytes(value: number, size: 2 | 4, littleEndian: boolean): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    if (size === 2) {
        view.setUint16(0, value, littleEndian);
    } else {
        view.setUint32(0, value, littleEndian);
    }

    return bytes;
}

function latin1(text: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(text, character => character.charCodeAt(0));
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(text);
}

function ascii(tag: number, text: string): TiffField {
    return { tag, type: TIFF_TYPES.ascii, count: text.length + 1, bytes: latin1(`${text}\0`) };
}

function short(tag: number, value: number): TiffField {
    return { tag, type: TIFF_TYPES.short, count: 1, bytes: numberBytes(value, 2, true) };
}

function long(tag: number, value: number): TiffField {
    return { tag, type: TIFF_TYPES.long, count: 1, bytes: numberBytes(value, 4, true) };
}

function rationals(tag: number, values: readonly (readonly [number, number])[]): TiffField {
    const bytes = concat(...values.flatMap(([numerator, denominator]) => [
        numberBytes(numerator, 4, true),
        numberBytes(denominator, 4, true),
    ]));

    return { tag, type: TIFF_TYPES.rational, count: values.length, bytes };
}

function byteField(tag: number, bytes: Uint8Array): TiffField {
    return { tag, type: TIFF_TYPES.byte, count: bytes.length, bytes };
}

function ucs2(text: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (const [index, character] of Array.from(text).entries()) {
        bytes[index * 2] = character.charCodeAt(0) & 0xff;
        bytes[index * 2 + 1] = character.charCodeAt(0) >> 8;
    }

    return bytes;
}

function outOfLineLength(field: TiffField): number {
    return field.bytes.length > 4 ? field.bytes.length + (field.bytes.length % 2) : 0;
}

function ifdLength(fields: readonly TiffField[]): number {
    const data = fields.reduce((total, field) => total + outOfLineLength(field), 0);

    return 2 + fields.length * 12 + 4 + data;
}

function writeIfd(fields: readonly TiffField[], start: number, next: number): Uint8Array<ArrayBuffer> {
    const sorted = [...fields].sort((left, right) => left.tag - right.tag);
    const entries: Uint8Array[] = [];
    const data: Uint8Array[] = [];
    let dataOffset = start + 2 + sorted.length * 12 + 4;
    for (const field of sorted) {
        const isInline = field.bytes.length <= 4;
        const value = isInline ? concat(field.bytes, new Uint8Array(4 - field.bytes.length)) : numberBytes(dataOffset, 4, true);
        const tagAndType = concat(numberBytes(field.tag, 2, true), numberBytes(field.type, 2, true));
        entries.push(concat(tagAndType, numberBytes(field.count, 4, true), value));
        if (!isInline) {
            const padded = concat(field.bytes, new Uint8Array(field.bytes.length % 2));
            data.push(padded);
            dataOffset += padded.length;
        }
    }

    return concat(numberBytes(sorted.length, 2, true), ...entries, numberBytes(next, 4, true), ...data);
}

interface TiffLayout {
    readonly ifd0: TiffField[];
    readonly exif: TiffField[];
    readonly gps: TiffField[];
    readonly thumbnail?: Uint8Array;
}

// Little-endian TIFF laid out as header, IFD0, Exif IFD, GPS IFD, IFD1 and the thumbnail.
function buildTiff(options: TiffLayout): Uint8Array<ArrayBuffer> {
    const pointers = [long(0x8769, 0), long(0x8825, 0)];
    const thumbnailFields = options.thumbnail ? [long(0x0201, 0), long(0x0202, options.thumbnail.length)] : [];
    const ifd0Start = 8;
    const exifStart = ifd0Start + ifdLength([...options.ifd0, ...pointers]);
    const gpsStart = exifStart + ifdLength(options.exif);
    const ifd1Start = gpsStart + ifdLength(options.gps);
    const thumbnailStart = ifd1Start + ifdLength(thumbnailFields);
    const ifd1 = options.thumbnail
        ? [writeIfd([long(0x0201, thumbnailStart), long(0x0202, options.thumbnail.length)], ifd1Start, 0), options.thumbnail]
        : [];
    const ifd0Fields = [...options.ifd0, long(0x8769, exifStart), long(0x8825, gpsStart)];

    return concat(
        latin1('II'),
        numberBytes(42, 2, true),
        numberBytes(ifd0Start, 4, true),
        writeIfd(ifd0Fields, ifd0Start, options.thumbnail ? ifd1Start : 0),
        writeIfd(options.exif, exifStart, 0),
        writeIfd(options.gps, gpsStart, 0),
        ...ifd1,
    );
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    return concat(Uint8Array.of(0xff, marker), numberBytes(payload.length + 2, 2, false), payload);
}

function iptcDataset(dataset: number, text: string): Uint8Array<ArrayBuffer> {
    return concat(Uint8Array.of(0x1c, 0x02, dataset), numberBytes(text.length, 2, false), latin1(text));
}

function photoshopBlock(iptc: Uint8Array): Uint8Array<ArrayBuffer> {
    const padded = concat(iptc, new Uint8Array(iptc.length % 2));
    const emptyName = Uint8Array.of(0, 0);
    const resourceHeader = concat(latin1('8BIM'), numberBytes(0x0404, 2, false), emptyName, numberBytes(iptc.length, 4, false));

    return concat(latin1('Photoshop 3.0\0'), resourceHeader, padded);
}

interface JpegParts {
    readonly tiff?: Uint8Array;
    readonly xmp?: string;
    readonly iptc?: Uint8Array;
    readonly scanBytes?: number;
}

function buildJpeg(options: JpegParts): Uint8Array<ArrayBuffer> {
    const xmpHeader = latin1('http://ns.adobe.com/xap/1.0/\0');

    return concat(
        Uint8Array.of(0xff, 0xd8),
        options.tiff ? jpegSegment(0xe1, concat(latin1('Exif\0\0'), options.tiff)) : new Uint8Array(0),
        options.xmp ? jpegSegment(0xe1, concat(xmpHeader, utf8(options.xmp))) : new Uint8Array(0),
        options.iptc ? jpegSegment(0xed, photoshopBlock(options.iptc)) : new Uint8Array(0),
        jpegSegment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
        new Uint8Array(options.scanBytes ?? 16),
        Uint8Array.of(0xff, 0xd9),
    );
}

function xmpPacket(properties: string): string {
    return [
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
        '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
        ` ${properties}`,
        '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
    ].join('');
}

const PHONE_XMP = xmpPacket([
    'xmp:Rating="4">',
    '<dc:subject><rdf:Bag><rdf:li>Sunset</rdf:li><rdf:li>Café</rdf:li></rdf:Bag></dc:subject>',
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Evening</rdf:li></rdf:Alt></dc:title>',
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">At the pier</rdf:li></rdf:Alt></dc:description>',
].join(''));

function phoneTiff(): Uint8Array<ArrayBuffer> {
    return buildTiff({
        ifd0: [
            ascii(0x010f, 'Apple'),
            ascii(0x0110, 'iPhone 15 Pro'),
            short(0x0112, 6),
            ascii(0x010e, '   '),
            byteField(0x9c9e, ucs2('family;holiday')),
        ],
        exif: [
            ascii(0x9003, '2026:11:23 14:05:42'),
            ascii(0x9011, '+01:00'),
            long(0xa002, 4032),
            long(0xa003, 3024),
            ascii(0xa434, 'iPhone 15 Pro back camera 6.86mm f/1.78'),
        ],
        gps: [
            ascii(0x0001, 'N'),
            rationals(0x0002, [[37, 1], [19, 1], [5400, 100]]),
            ascii(0x0003, 'W'),
            rationals(0x0004, [[122, 1], [1, 1], [4872, 100]]),
            byteField(0x0005, Uint8Array.of(0)),
            rationals(0x0006, [[12345, 1000]]),
        ],
        thumbnail: THUMBNAIL,
    });
}

function phoneJpeg(scanBytes = 16): Uint8Array<ArrayBuffer> {
    const iptc = concat(iptcDataset(25, 'beach'), iptcDataset(25, 'sunset'), iptcDataset(5, 'Lower priority title'));

    return buildJpeg({ tiff: phoneTiff(), xmp: PHONE_XMP, iptc, scanBytes });
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
    const typeAndData = concat(latin1(type), data);

    return concat(numberBytes(data.length, 4, false), typeAndData, numberBytes(crc32(typeAndData), 4, false));
}

function riffChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
    return concat(latin1(type), numberBytes(data.length, 4, true), data, new Uint8Array(data.length % 2));
}

class TestFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;

    readAsArrayBuffer(blob: Blob): void {
        void (async () => {
            try {
                this.result = await blob.arrayBuffer();
                this.onloadend?.();
            } catch (error) {
                this.onerror?.(error);
            }
        })();
    }
}

describe('readImageMetadataAsync', () => {
    // exifr reads Blobs with FileReader, which Node lacks.
    beforeAll(() => {
        vi.stubGlobal('FileReader', TestFileReader);
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('reads EXIF, GPS, XMP, IPTC and Windows keywords from a JPEG', async () => {
        // Arrange
        const file = new File([phoneJpeg()], 'IMG_2230.JPG', { type: 'image/jpeg' });

        // Act
        const metadata = await readImageMetadataAsync(file, SILENT_LOGGER);

        // Assert
        expect(metadata).toStrictEqual({
            dates: { exif: '2026-11-23T14:05:42+01:00' },
            latitude: 37.331667,
            longitude: -122.0302,
            altitude: 12.3,
            make: 'Apple',
            model: 'iPhone 15 Pro',
            lens: 'iPhone 15 Pro back camera 6.86mm f/1.78',
            width: 4032,
            height: 3024,
            orientation: 6,
            tags: ['beach', 'sunset', 'Café', 'family', 'holiday'],
            title: 'Evening',
            description: 'At the pier',
            rating: 4,
        });
    });

    it('reads only the leading chunks of a large photo', async () => {
        // Arrange
        const file = new File([phoneJpeg(2_000_000)], 'IMG_2230.JPG', { type: 'image/jpeg' });
        const slice = vi.spyOn(file, 'slice');

        // Act
        const metadata = await readImageMetadataAsync(file, SILENT_LOGGER);

        // Assert
        const largestEnd = Math.max(...slice.mock.calls.map(([, end = file.size]) => end));
        expect(metadata?.make).toBe('Apple');
        expect(slice).toHaveBeenCalled();
        expect(largestEnd).toBeLessThanOrEqual(2 * 64 * 1024);
    });

    it('resolves undefined for a JPEG without metadata and for unknown formats', async () => {
        // Arrange
        const bare = new File([buildJpeg({})], 'bare.jpg', { type: 'image/jpeg' });
        const gif = new File([latin1('GIF89a\x01\x00\x01\x00')], 'dot.gif', { type: 'image/gif' });

        // Act
        const results = await Promise.all([bare, gif].map(file => readImageMetadataAsync(file, SILENT_LOGGER)));

        // Assert
        expect(results).toEqual([undefined, undefined]);
    });

    it('reads the size of a PNG from its header', async () => {
        // Arrange
        const header = concat(numberBytes(640, 4, false), numberBytes(480, 4, false), Uint8Array.of(8, 6, 0, 0, 0));
        const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
        const png = concat(signature, pngChunk('IHDR', header), pngChunk('IEND', new Uint8Array(0)));

        // Act
        const metadata = await readImageMetadataAsync(new File([png], 'screen.png', { type: 'image/png' }), SILENT_LOGGER);

        // Assert
        expect(metadata).toStrictEqual({ width: 640, height: 480 });
    });

    it('reads EXIF and XMP chunks that follow the image data in a WebP', async () => {
        // Arrange
        const extended = concat(Uint8Array.of(0x0c, 0, 0, 0), Uint8Array.of(0x7f, 0x07, 0x00), Uint8Array.of(0x37, 0x04, 0x00));
        const body = concat(
            latin1('WEBP'),
            riffChunk('VP8X', extended),
            riffChunk('VP8 ', new Uint8Array(5001)),
            riffChunk('EXIF', concat(latin1('Exif\0\0'), phoneTiff())),
            riffChunk('XMP ', utf8(PHONE_XMP)),
        );
        const webp = concat(latin1('RIFF'), numberBytes(body.length, 4, true), body);

        // Act
        const metadata = await readImageMetadataAsync(new File([webp], 'photo.webp', { type: 'image/webp' }), SILENT_LOGGER);

        // Assert
        expect(metadata).toMatchObject({
            dates: { exif: '2026-11-23T14:05:42+01:00' },
            latitude: 37.331667,
            make: 'Apple',
            width: 4032,
            tags: ['Sunset', 'Café', 'family', 'holiday'],
            title: 'Evening',
            rating: 4,
        });
    });
});

describe('readEmbeddedThumbnailAsync', () => {
    beforeAll(() => {
        vi.stubGlobal('FileReader', TestFileReader);
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('returns the EXIF preview as a JPEG Blob', async () => {
        // Arrange
        const file = new File([phoneJpeg()], 'IMG_2230.JPG', { type: 'image/jpeg' });

        // Act
        const thumbnail = await readEmbeddedThumbnailAsync(file);

        // Assert
        expect(thumbnail?.type).toBe('image/jpeg');
        expect(new Uint8Array(await thumbnail!.arrayBuffer())).toEqual(THUMBNAIL);
    });

    it('resolves undefined when there is no preview', async () => {
        // Arrange
        const file = new File([buildJpeg({})], 'bare.jpg', { type: 'image/jpeg' });

        // Act
        const thumbnail = await readEmbeddedThumbnailAsync(file);

        // Assert
        expect(thumbnail).toBeUndefined();
    });
});

describe('mapExifrOutput', () => {
    it('falls back from DateTimeOriginal to CreateDate and XMP dates', () => {
        // Act
        const digitized = mapExifrOutput({
            exif: { DateTimeOriginal: '0000:00:00 00:00:00', CreateDate: '2026:01:02 03:04:05', OffsetTime: '-05:00' },
        });
        const xmp = mapExifrOutput({ photoshop: { DateCreated: '2026-01-02T03:04:05+09:00' } });

        // Assert
        expect(digitized.dates).toEqual({ exif: '2026-01-02T03:04:05-05:00' });
        expect(xmp.dates).toEqual({ exif: '2026-01-02T03:04:05+09:00' });
    });

    it('drops GPS without a fix and makes altitude below sea level negative', () => {
        // Act
        const noFix = mapExifrOutput({ gps: { latitude: 0, longitude: 0, GPSAltitude: 10 } });
        const deadSea = mapExifrOutput({
            gps: { latitude: 31.5, longitude: 35.5, GPSAltitude: 430.44, GPSAltitudeRef: Uint8Array.of(1) },
        });

        // Assert
        expect(noFix).toStrictEqual({});
        expect(deadSea).toStrictEqual({ latitude: 31.5, longitude: 35.5, altitude: -430.4 });
    });

    it('ignores out-of-range orientation and rating and reads Windows rating', () => {
        // Act
        const invalid = mapExifrOutput({ ifd0: { Orientation: 9 }, xmp: { Rating: 7 } });
        const windows = mapExifrOutput({ ifd0: { Rating: 3, XPTitle: 'Already text' } });

        // Assert
        expect(invalid).toStrictEqual({});
        expect(windows).toStrictEqual({ rating: 3, title: 'Already text' });
    });

    it('caps tag counts and text lengths so the summary stays small', () => {
        // Act
        const metadata = mapExifrOutput({
            dc: { subject: Array.from({ length: 50 }, (_, index) => `tag ${index}`), description: 'x'.repeat(5000) },
        });

        // Assert
        expect(metadata.tags).toHaveLength(30);
        expect(metadata.description).toHaveLength(1000);
    });

    it('returns nothing for empty or unexpected output', () => {
        // Act
        const values = [mapExifrOutput(undefined), mapExifrOutput('text'), mapExifrOutput([1, 2])];

        // Assert
        expect(values).toEqual([{}, {}, {}]);
    });
});
