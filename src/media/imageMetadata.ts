import type { Logger } from '../core/logger.js';
import { parseMetadataDate } from './metadataDates.js';
import type { EmbeddedMetadata } from './metadataTypes.js';
import {
    cleanTags,
    cleanText,
    finiteNumber,
    positiveInteger,
    roundTo,
    TEXT_LIMITS,
    toCoordinates,
    withoutUndefined,
} from './metadataValues.js';

// MD-03: EXIF, XMP and IPTC through exifr, which reads a File in 64 KiB chunks and stops once it has the segments.

type Section = Readonly<Record<string, unknown>>;

interface Exifr {
    readonly parse: typeof import('exifr').parse;
    readonly sidecar: typeof import('exifr').sidecar;
    readonly thumbnail: typeof import('exifr').thumbnail;
}

const CHUNK_BYTES = 64 * 1024;

// Raw values (no translated enums, no Date objects) so dates keep their wall-clock time and offset.
const EXIFR_OPTIONS = {
    tiff: true,
    exif: true,
    gps: true,
    ifd1: false,
    interop: false,
    makerNote: false,
    userComment: false,
    xmp: true,
    iptc: true,
    icc: false,
    jfif: false,
    ihdr: true,
    translateKeys: true,
    translateValues: false,
    reviveValues: false,
    sanitize: true,
    mergeOutput: false,
    silentErrors: true,
    chunked: true,
    firstChunkSize: CHUNK_BYTES,
    chunkSize: CHUNK_BYTES,
    chunkLimit: 8,
};

interface DateSource {
    readonly section: string;
    readonly date: string;
    readonly offsets: readonly string[];
}

// The first match wins (MD-05: DateTimeOriginal first); each date may carry its own offset tag.
const DATE_SOURCES: readonly DateSource[] = Object.freeze([
    { section: 'exif', date: 'DateTimeOriginal', offsets: ['OffsetTimeOriginal', 'OffsetTime'] },
    { section: 'exif', date: 'CreateDate', offsets: ['OffsetTimeDigitized', 'OffsetTime'] },
    { section: 'photoshop', date: 'DateCreated', offsets: [] },
    { section: 'xmp', date: 'CreateDate', offsets: [] },
]);

const RIFF_HEADER_BYTES = 12;
const RIFF_CHUNK_HEADER_BYTES = 8;
const MAX_RIFF_CHUNKS = 64;
const MAX_WEBP_METADATA_BYTES = 1024 * 1024;
const VP8X_PAYLOAD_BYTES = 10;
const EXIF_PREFIX = 'Exif\0\0';

interface WebpChunks {
    readonly exif?: Uint8Array;
    readonly xmp?: Uint8Array;
    readonly width?: number;
    readonly height?: number;
}

export async function readImageMetadataAsync(file: Blob, logger: Logger): Promise<EmbeddedMetadata | undefined> {
    try {
        const exifr = await loadExifrAsync();
        if (await isWebpAsync(file)) {
            return await readWebpMetadataAsync(file, exifr);
        }

        const output: unknown = await exifr.parse(file, EXIFR_OPTIONS);

        return output == null ? undefined : mapExifrOutput(output);
    } catch (error) {
        logger.debug('xfer', 'image metadata unreadable', { error });

        return undefined;
    }
}

// TH-01: the preview JPEG most cameras embed in EXIF (IFD1); undefined when there is none.
export async function readEmbeddedThumbnailAsync(file: Blob): Promise<Blob | undefined> {
    try {
        const exifr = await loadExifrAsync();
        const bytes = await exifr.thumbnail(file);
        if (bytes == null || bytes.length === 0) {
            return undefined;
        }

        return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
    } catch {
        return undefined;
    }
}

export function mapExifrOutput(output: unknown): EmbeddedMetadata {
    const sections = asRecord(output);
    const sectionOf = (name: string): Section => asRecord(sections[name]);
    const ifd0 = sectionOf('ifd0');
    const exif = sectionOf('exif');
    const gps = sectionOf('gps');
    const iptc = sectionOf('iptc');
    const dc = sectionOf('dc');
    const xmp = sectionOf('xmp');
    const ihdr = sectionOf('ihdr');
    const takenAt = DATE_SOURCES
        .map(source => {
            const section = sectionOf(source.section);
            const offset = source.offsets.map(key => section[key]).find(value => value != null);

            return parseMetadataDate(section[source.date], offset);
        })
        .find(date => date != null);
    const coordinates = toCoordinates(gps.latitude, gps.longitude);

    return withoutUndefined({
        dates: takenAt == null ? undefined : { exif: takenAt },
        latitude: coordinates?.latitude,
        longitude: coordinates?.longitude,
        altitude: coordinates == null ? undefined : gpsAltitude(gps),
        make: cleanText(ifd0.Make, TEXT_LIMITS.short),
        model: cleanText(ifd0.Model, TEXT_LIMITS.short),
        lens: cleanText([exif.LensModel, sectionOf('aux').Lens], TEXT_LIMITS.short),
        width: positiveInteger(exif.ExifImageWidth ?? ifd0.ImageWidth ?? ihdr.ImageWidth),
        height: positiveInteger(exif.ExifImageHeight ?? ifd0.ImageHeight ?? ihdr.ImageHeight),
        orientation: orientationOf(ifd0.Orientation),
        tags: cleanTags([iptc.Keywords, dc.subject, splitKeywords(decodeUcs2(ifd0.XPKeywords))]),
        title: cleanText([dc.title, iptc.ObjectName, decodeUcs2(ifd0.XPTitle)], TEXT_LIMITS.title),
        description: cleanText([
            dc.description,
            iptc.Caption,
            ifd0.ImageDescription,
            decodeUcs2(ifd0.XPComment),
            decodeUcs2(ifd0.XPSubject),
        ], TEXT_LIMITS.description),
        rating: ratingOf(xmp.Rating ?? ifd0.Rating),
    });
}

// Loaded on first use so the library stays out of the start-up bundle.
// The ESM build exports `sidecar` by name only; the CommonJS build puts everything on the default export.
async function loadExifrAsync(): Promise<Exifr> {
    const library = await import('exifr');

    return {
        parse: library.parse ?? library.default.parse,
        sidecar: library.sidecar ?? library.default.sidecar,
        thumbnail: library.thumbnail ?? library.default.thumbnail,
    };
}

function asRecord(value: unknown): Section {
    return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Section) : {};
}

function gpsAltitude(gps: Section): number | undefined {
    const altitude = finiteNumber(gps.GPSAltitude);
    if (altitude == null) {
        return undefined;
    }

    const isBelowSeaLevel = finiteNumber(gps.GPSAltitudeRef) === 1;

    return roundTo(isBelowSeaLevel ? -altitude : altitude, 1);
}

function orientationOf(value: unknown): number | undefined {
    const orientation = positiveInteger(value);

    return orientation != null && orientation <= 8 ? orientation : undefined;
}

function ratingOf(value: unknown): number | undefined {
    const rating = positiveInteger(value);

    return rating != null && rating <= 5 ? rating : undefined;
}

// Windows XP* tags hold UTF-16LE bytes ending in a null character.
function decodeUcs2(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }

    if (!Array.isArray(value) && !(value instanceof Uint8Array)) {
        return undefined;
    }

    const bytes = Uint8Array.from(value as ArrayLike<number>);

    return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '');
}

function splitKeywords(value: string | undefined): string[] {
    return value == null ? [] : value.split(';');
}

async function isWebpAsync(file: Blob): Promise<boolean> {
    const header = await readLatin1Async(file, 0, RIFF_HEADER_BYTES);

    return header.startsWith('RIFF') && header.slice(8) === 'WEBP';
}

// exifr has no WebP reader, so its EXIF and XMP chunks are found here and handed over as raw segments.
async function readWebpMetadataAsync(file: Blob, exifr: Exifr): Promise<EmbeddedMetadata | undefined> {
    const chunks = await readWebpChunksAsync(file);
    const tiff: unknown = chunks.exif == null ? undefined : await exifr.parse(chunks.exif, EXIFR_OPTIONS);
    const xmp: unknown = chunks.xmp == null ? undefined : await exifr.sidecar(chunks.xmp, EXIFR_OPTIONS, 'xmp');
    const metadata = mapExifrOutput(mergeSections(tiff, xmp));

    return withoutUndefined({
        ...metadata,
        width: metadata.width ?? chunks.width,
        height: metadata.height ?? chunks.height,
    });
}

async function readWebpChunksAsync(file: Blob): Promise<WebpChunks> {
    let chunks: WebpChunks = {};
    let offset = RIFF_HEADER_BYTES;
    for (let index = 0; index < MAX_RIFF_CHUNKS && offset + RIFF_CHUNK_HEADER_BYTES <= file.size; index++) {
        const header = new Uint8Array(await file.slice(offset, offset + RIFF_CHUNK_HEADER_BYTES).arrayBuffer());
        const type = String.fromCharCode(...header.subarray(0, 4));
        const size = new DataView(header.buffer).getUint32(4, true);
        const payloadStart = offset + RIFF_CHUNK_HEADER_BYTES;
        chunks = { ...chunks, ...(await readWebpChunkAsync(file, type, payloadStart, size)) };
        offset = payloadStart + size + (size % 2);
    }

    return chunks;
}

async function readWebpChunkAsync(file: Blob, type: string, start: number, size: number): Promise<WebpChunks> {
    if (type === 'VP8X' && size >= VP8X_PAYLOAD_BYTES) {
        const payload = new Uint8Array(await file.slice(start, start + VP8X_PAYLOAD_BYTES).arrayBuffer());
        const view = new DataView(payload.buffer);

        return {
            width: (view.getUint32(3, true) >>> 8) + 1,
            height: (view.getUint32(6, true) >>> 8) + 1,
        };
    }

    if ((type !== 'EXIF' && type !== 'XMP ') || size > MAX_WEBP_METADATA_BYTES) {
        return {};
    }

    const payload = new Uint8Array(await file.slice(start, start + size).arrayBuffer());
    if (type === 'XMP ') {
        return { xmp: payload };
    }

    const hasPrefix = String.fromCharCode(...payload.subarray(0, EXIF_PREFIX.length)) === EXIF_PREFIX;

    return { exif: hasPrefix ? payload.subarray(EXIF_PREFIX.length) : payload };
}

function mergeSections(...outputs: readonly unknown[]): Record<string, Section> {
    const merged: Record<string, Section> = {};
    for (const output of outputs) {
        for (const [name, section] of Object.entries(asRecord(output))) {
            merged[name] = { ...merged[name], ...asRecord(section) };
        }
    }

    return merged;
}

async function readLatin1Async(file: Blob, start: number, end: number): Promise<string> {
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());

    return String.fromCharCode(...bytes);
}
