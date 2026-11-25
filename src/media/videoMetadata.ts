import type { Logger } from '../core/logger.js';
import { parseMetadataDate, quickTimeSecondsToDate } from './metadataDates.js';
import type { EmbeddedMetadata } from './metadataTypes.js';
import {
    cleanText,
    finiteNumber,
    roundTo,
    TEXT_LIMITS,
    toCoordinates,
    withoutUndefined,
} from './metadataValues.js';

// MD-04: MP4 and QuickTime metadata from the `moov` box, found by walking box headers with File.slice().

// A larger movie box is damaged or unusual; its metadata isn't worth the memory.
export const MAX_MOVIE_BOX_BYTES = 16 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 1024;
const BOX_HEADER_BYTES = 16;
const UINT32_RANGE = 0x1_0000_0000;
const FIXED_16_16 = 0x10000;
const MAX_DURATION_SECONDS = 10_000_000;
const FOUR_CC = /^[\x20-\x7e©]{4}$/;
const UTF8_TYPE = 1;
const UTF16_TYPE = 2;

const APPLE_KEYS = Object.freeze({
    creationDate: 'com.apple.quicktime.creationdate',
    location: 'com.apple.quicktime.location.ISO6709',
    make: 'com.apple.quicktime.make',
    model: 'com.apple.quicktime.model',
});

// Android and older QuickTime writers keep these as plain text atoms inside `udta`.
const USER_DATA_ATOMS = Object.freeze({
    location: '©xyz',
    make: '©mak',
    model: '©mod',
});

export interface Box {
    readonly type: string;
    readonly typeCode: number;
    readonly payloadStart: number;
    readonly end: number;
}

export interface Iso6709Location {
    readonly latitude: number;
    readonly longitude: number;
    readonly altitude?: number;
}

interface BoxSize {
    readonly size: number;
    readonly headerSize: number;
}

interface MovieHeader {
    readonly created?: string;
    readonly durationSeconds?: number;
}

interface TrackHeader {
    readonly width: number;
    readonly height: number;
    readonly rotation: number;
}

interface TextFields {
    readonly location?: string;
    readonly make?: string;
    readonly model?: string;
    readonly creationDate?: string;
}

export async function readVideoMetadataAsync(file: Blob, logger: Logger): Promise<EmbeddedMetadata | undefined> {
    try {
        const movie = await findMovieBoxAsync(file);
        if (movie == null) {
            logger.debug('xfer', 'video has no moov box');

            return undefined;
        }

        if (movie.end - movie.payloadStart > MAX_MOVIE_BOX_BYTES) {
            logger.warn('xfer', 'moov box too large, metadata skipped', { bytes: movie.end - movie.payloadStart });

            return undefined;
        }

        const bytes = new Uint8Array(await file.slice(movie.payloadStart, movie.end).arrayBuffer());

        return parseMovieBox(bytes);
    } catch (error) {
        logger.warn('xfer', 'video metadata unreadable', { error });

        return undefined;
    }
}

// Reads only box headers: `mdat` (the media data) is skipped by its size,
// so a `moov` at the end of the file costs one more read.
export async function findMovieBoxAsync(file: Blob): Promise<Box | undefined> {
    let offset = 0;
    for (let index = 0; index < MAX_TOP_LEVEL_BOXES && offset + 8 <= file.size; index++) {
        const bytes = new Uint8Array(await file.slice(offset, offset + BOX_HEADER_BYTES).arrayBuffer());
        const view = new DataView(bytes.buffer);
        const type = fourCcAt(view, 4);
        const size = FOUR_CC.test(type) ? boxSizeAt(view, 0, file.size - offset) : undefined;
        if (size == null) {
            return undefined;
        }

        if (type === 'moov') {
            return {
                type,
                typeCode: view.getUint32(4),
                payloadStart: offset + size.headerSize,
                end: offset + size.size,
            };
        }

        offset += size.size;
    }

    return undefined;
}

// The payload of a `moov` box; fragmented files (with `mvex`) keep only file-level fields (MD-04).
export function parseMovieBox(bytes: Uint8Array): EmbeddedMetadata {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const children = readBoxes(view, 0, bytes.length);
    if (children.some(box => box.type === 'mvex')) {
        return {};
    }

    const header = parseMovieHeader(view, children.find(box => box.type === 'mvhd'));
    const track = children
        .filter(box => box.type === 'trak')
        .map(trak => parseTrackHeader(view, findChild(view, trak, 'tkhd')))
        .find(candidate => candidate != null && candidate.width > 0 && candidate.height > 0);
    const apple = parseAppleMetadata(view, children.find(box => box.type === 'meta'));
    const userData = parseUserData(view, children.find(box => box.type === 'udta'));
    const location = parseIso6709(apple.location ?? userData.location ?? '');
    const dates = withoutUndefined({
        quicktime: parseMetadataDate(apple.creationDate),
        mvhd: header.created,
    });

    return withoutUndefined({
        dates: Object.keys(dates).length > 0 ? dates : undefined,
        durationSeconds: header.durationSeconds,
        width: track?.width,
        height: track?.height,
        rotation: track?.rotation,
        latitude: location?.latitude,
        longitude: location?.longitude,
        altitude: location?.altitude,
        make: cleanText(apple.make ?? userData.make, TEXT_LIMITS.short),
        model: cleanText(apple.model ?? userData.model, TEXT_LIMITS.short),
    });
}

// ISO 6709 as written by phones: "+37.3317-122.0302+012.345/", also with DDMM(.mm) and DDMMSS(.ss) components.
export function parseIso6709(text: string): Iso6709Location | undefined {
    const match = /^([+-][\d.]+)([+-][\d.]+)([+-][\d.]+)?/.exec(text.trim());
    if (!match) {
        return undefined;
    }

    const [, latitudeText = '', longitudeText = '', altitudeText] = match;
    const coordinates = toCoordinates(sexagesimal(latitudeText, 2), sexagesimal(longitudeText, 3));
    if (coordinates == null) {
        return undefined;
    }

    const altitude = finiteNumber(altitudeText);

    return withoutUndefined({ ...coordinates, altitude: altitude == null ? undefined : roundTo(altitude, 1) });
}

export function readBoxes(view: DataView, start: number, end: number): Box[] {
    const boxes: Box[] = [];
    let position = start;
    while (position + 8 <= end) {
        const size = boxSizeAt(view, position, end - position);
        if (size == null) {
            break;
        }

        boxes.push({
            type: fourCcAt(view, position + 4),
            typeCode: view.getUint32(position + 4),
            payloadStart: position + size.headerSize,
            end: position + size.size,
        });
        position += size.size;
    }

    return boxes;
}

// `available` is how many bytes remain in the parent from `position`; size 0 means "to the end".
function boxSizeAt(view: DataView, position: number, available: number): BoxSize | undefined {
    const size = view.getUint32(position);
    if (size === 0) {
        return { size: available, headerSize: 8 };
    }

    if (size === 1) {
        const largeSize = available >= 16 ? readUint64(view, position + 8) : 0;

        return largeSize >= 16 && largeSize <= available ? { size: largeSize, headerSize: 16 } : undefined;
    }

    return size >= 8 && size <= available ? { size, headerSize: 8 } : undefined;
}

function findChild(view: DataView, parent: Box, type: string): Box | undefined {
    return readBoxes(view, parent.payloadStart, parent.end).find(box => box.type === type);
}

function parseMovieHeader(view: DataView, box: Box | undefined): MovieHeader {
    if (box == null || box.payloadStart + 4 > box.end) {
        return {};
    }

    const isLong = view.getUint8(box.payloadStart) === 1;
    const fields = box.payloadStart + 4;
    if (fields + (isLong ? 28 : 16) > box.end) {
        return {};
    }

    const created = isLong ? readUint64(view, fields) : view.getUint32(fields);
    const timescale = view.getUint32(fields + (isLong ? 16 : 8));
    const duration = isLong ? readUint64(view, fields + 20) : view.getUint32(fields + 12);
    const seconds = timescale > 0 ? duration / timescale : 0;

    return withoutUndefined({
        created: quickTimeSecondsToDate(created),
        durationSeconds: seconds > 0 && seconds < MAX_DURATION_SECONDS ? roundTo(seconds, 3) : undefined,
    });
}

function parseTrackHeader(view: DataView, box: Box | undefined): TrackHeader | undefined {
    if (box == null || box.payloadStart + 4 > box.end) {
        return undefined;
    }

    const isLong = view.getUint8(box.payloadStart) === 1;
    const matrix = box.payloadStart + 4 + (isLong ? 32 : 20) + 16;
    if (matrix + 44 > box.end) {
        return undefined;
    }

    const scaleX = view.getInt32(matrix) / FIXED_16_16;
    const skewY = view.getInt32(matrix + 4) / FIXED_16_16;
    const degrees = Math.round((Math.atan2(skewY, scaleX) * 180) / Math.PI);

    return {
        width: Math.round(view.getUint32(matrix + 36) / FIXED_16_16),
        height: Math.round(view.getUint32(matrix + 40) / FIXED_16_16),
        rotation: ((degrees % 360) + 360) % 360,
    };
}

// Apple's `meta` (keys + ilst). QuickTime's has no version field, the ISO one does: its first word is 0.
function parseAppleMetadata(view: DataView, box: Box | undefined): TextFields {
    if (box == null || box.payloadStart + 8 > box.end) {
        return {};
    }

    const childrenStart = view.getUint32(box.payloadStart) === 0 ? box.payloadStart + 4 : box.payloadStart;
    const children = readBoxes(view, childrenStart, box.end);
    const keysBox = children.find(child => child.type === 'keys');
    const itemList = children.find(child => child.type === 'ilst');
    if (keysBox == null || itemList == null) {
        return {};
    }

    const keys = parseKeys(view, keysBox);
    const values = new Map<string, string>();
    for (const item of readBoxes(view, itemList.payloadStart, itemList.end)) {
        const key = keys[item.typeCode - 1];
        const value = readDataValue(view, findChild(view, item, 'data'));
        if (key != null && value != null) {
            values.set(key, value);
        }
    }

    return withoutUndefined({
        location: values.get(APPLE_KEYS.location),
        make: values.get(APPLE_KEYS.make),
        model: values.get(APPLE_KEYS.model),
        creationDate: values.get(APPLE_KEYS.creationDate),
    });
}

function parseKeys(view: DataView, box: Box): string[] {
    if (box.payloadStart + 8 > box.end) {
        return [];
    }

    const count = view.getUint32(box.payloadStart + 4);
    const keys: string[] = [];
    let position = box.payloadStart + 8;
    for (let index = 0; index < count && position + 8 <= box.end; index++) {
        const size = view.getUint32(position);
        if (size < 8 || position + size > box.end) {
            break;
        }

        keys.push(decodeText(view, position + 8, position + size, 'utf-8'));
        position += size;
    }

    return keys;
}

function readDataValue(view: DataView, box: Box | undefined): string | undefined {
    if (box == null || box.payloadStart + 8 > box.end) {
        return undefined;
    }

    const type = view.getUint32(box.payloadStart) & 0xffffff;
    if (type === UTF8_TYPE) {
        return decodeText(view, box.payloadStart + 8, box.end, 'utf-8');
    }

    if (type === UTF16_TYPE) {
        return decodeText(view, box.payloadStart + 8, box.end, 'utf-16be');
    }

    return undefined;
}

// QuickTime text atoms: a 16-bit length, a 16-bit language code, then the text.
function parseUserData(view: DataView, box: Box | undefined): TextFields {
    if (box == null) {
        return {};
    }

    const children = readBoxes(view, box.payloadStart, box.end);
    const readAtom = (type: string): string | undefined => {
        const atom = children.find(child => child.type === type);
        if (atom == null || atom.payloadStart + 4 > atom.end) {
            return undefined;
        }

        const textStart = atom.payloadStart + 4;
        const textEnd = Math.min(textStart + view.getUint16(atom.payloadStart), atom.end);

        return decodeText(view, textStart, textEnd, 'utf-8');
    };

    return withoutUndefined({
        location: readAtom(USER_DATA_ATOMS.location),
        make: readAtom(USER_DATA_ATOMS.make),
        model: readAtom(USER_DATA_ATOMS.model),
    });
}

// Degrees, or degrees followed by 2-digit minutes and seconds groups, chosen by the number of integer digits.
function sexagesimal(component: string, degreeDigits: number): number | undefined {
    const sign = component.startsWith('-') ? -1 : 1;
    const [integer = '', fraction = ''] = component.slice(1).split('.');
    const subDegreeDigits = Math.max(0, integer.length - degreeDigits);
    if (subDegreeDigits % 2 !== 0 || subDegreeDigits > 4) {
        return undefined;
    }

    const degreesEnd = integer.length - subDegreeDigits;
    const groups = [integer.slice(0, degreesEnd)];
    for (let index = degreesEnd; index < integer.length; index += 2) {
        groups.push(integer.slice(index, index + 2));
    }

    const values = groups.map(Number);
    const last = values.length - 1;
    values[last] = (values[last] ?? 0) + (fraction === '' ? 0 : Number(`0.${fraction}`));
    const degrees = values.reduce((total, value, index) => total + value / 60 ** index, 0);

    return Number.isFinite(degrees) ? sign * degrees : undefined;
}

function fourCcAt(view: DataView, position: number): string {
    return String.fromCharCode(
        view.getUint8(position),
        view.getUint8(position + 1),
        view.getUint8(position + 2),
        view.getUint8(position + 3),
    );
}

function readUint64(view: DataView, position: number): number {
    return view.getUint32(position) * UINT32_RANGE + view.getUint32(position + 4);
}

function decodeText(view: DataView, start: number, end: number, encoding: string): string {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + start, Math.max(0, end - start));

    return new TextDecoder(encoding).decode(bytes).replace(/\0+$/, '');
}
