// SV-04: a store-only ZIP assembled from Blob parts, so file data is never copied into memory.

export interface ZipEntry {
    // Path inside the archive with "/" separators, already sanitised (see fileNames.ts).
    readonly name: string;
    readonly data: Blob;
    readonly size: number;
    // CRC-32 of the data, computed while the pages arrived (crc32.ts).
    readonly crc32: number;
    // Epoch milliseconds as sent; `created` falls back to `lastModified`.
    readonly lastModified: number;
    readonly created?: number;
}

export interface ZipOptions {
    // Writes ZIP64 records even when nothing needs them; for tests and interoperability checks.
    readonly forceZip64?: boolean;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const EXTENDED_TIMESTAMP_ID = 0x5455;
// Modified, accessed and created; without the accessed time libarchive sets it to 1970-01-01.
const EXTENDED_TIMESTAMP_FLAGS = 0x01 | 0x02 | 0x04;
const NTFS_EXTRA_ID = 0x000a;
const NTFS_TIMES_TAG = 0x0001;
const NTFS_TIMES_LENGTH = 24;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
// Windows FILETIME counts 100 ns steps from 1601-01-01 UTC; BigInt because the values pass 2^53.
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const FILETIME_TICKS_PER_MS = 10_000n;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const UINT32_RANGE = 0x1_0000_0000;
const UTF8_NAMES_FLAG = 0x0800;
const STORED = 0;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
// Made by Unix, so unzip tools apply the file mode below instead of guessing.
const VERSION_MADE_BY = (3 << 8) | VERSION_ZIP64;
const REGULAR_FILE_MODE = 0o100644;
const LOCAL_HEADER_LENGTH = 30;
const CENTRAL_HEADER_LENGTH = 46;
const END_LENGTH = 22;
const ZIP64_END_LENGTH = 56;
const ZIP64_LOCATOR_LENGTH = 20;
const DOS_EPOCH_YEAR = 1980;
const DOS_LAST_YEAR = 2107;

interface DosDateTime {
    readonly date: number;
    readonly time: number;
}

interface EntryTimes {
    readonly modified: number;
    readonly created: number;
}

interface PreparedEntry {
    readonly entry: ZipEntry;
    readonly name: Uint8Array<ArrayBuffer>;
    readonly modified: DosDateTime;
    readonly times: EntryTimes;
    readonly offset: number;
    readonly zip64Sizes: boolean;
    readonly zip64Offset: boolean;
}

export function createZipBlob(entries: readonly ZipEntry[], options: ZipOptions = {}): Blob {
    const forceZip64 = options.forceZip64 === true;
    const encoder = new TextEncoder();
    const parts: BlobPart[] = [];
    const prepared: PreparedEntry[] = [];
    let offset = 0;

    for (const entry of entries) {
        assertEntry(entry);
        const modified = Number.isFinite(entry.lastModified) ? entry.lastModified : 0;
        const created = entry.created ?? modified;
        const item: PreparedEntry = {
            entry,
            name: encoder.encode(entry.name),
            modified: toDosDateTime(modified),
            times: { modified, created: Number.isFinite(created) ? created : modified },
            offset,
            zip64Sizes: forceZip64 || entry.size >= UINT32_MAX,
            zip64Offset: forceZip64 || offset >= UINT32_MAX,
        };
        const header = localHeader(item);
        prepared.push(item);
        parts.push(header, entry.data);
        offset += header.length + entry.size;
    }

    const centralHeaders = prepared.map(centralHeader);
    const centralOffset = offset;
    const centralSize = centralHeaders.reduce((total, header) => total + header.length, 0);
    parts.push(...centralHeaders);

    const needsZip64End = forceZip64
        || entries.length >= UINT16_MAX
        || centralOffset >= UINT32_MAX
        || centralSize >= UINT32_MAX;
    const directory = { count: entries.length, size: centralSize, offset: centralOffset };
    if (needsZip64End) {
        parts.push(zip64EndRecord(directory), zip64Locator(centralOffset + centralSize));
    }

    parts.push(endRecord(directory));

    return new Blob(parts, { type: 'application/zip' });
}

// DOS time is local wall-clock time with 2-second steps, limited to 1980–2107.
export function toDosDateTime(epochMs: number): DosDateTime {
    const date = new Date(Number.isFinite(epochMs) ? epochMs : 0);
    const year = date.getFullYear();
    if (year < DOS_EPOCH_YEAR) {
        return { date: (1 << 5) | 1, time: 0 };
    }

    if (year > DOS_LAST_YEAR) {
        return {
            date: ((DOS_LAST_YEAR - DOS_EPOCH_YEAR) << 9) | (12 << 5) | 31,
            time: (23 << 11) | (59 << 5) | 29,
        };
    }

    return {
        date: ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    };
}

export function toFileTime(epochMs: number): bigint {
    const ticks = (BigInt(Math.round(epochMs)) + FILETIME_EPOCH_OFFSET_MS) * FILETIME_TICKS_PER_MS;

    return ticks < 0n ? 0n : ticks;
}

function assertEntry(entry: ZipEntry): void {
    if (entry.data.size !== entry.size) {
        const message = `ZIP entry "${entry.name}" says ${entry.size} bytes but its data has ${entry.data.size}`;
        throw new RangeError(message);
    }
}

function localHeader(item: PreparedEntry): Uint8Array<ArrayBuffer> {
    const extra = concatBytes([
        ...(item.zip64Sizes ? [zip64Extra([item.entry.size, item.entry.size])] : []),
        extendedTimestampExtra([item.times.modified, item.times.modified, item.times.created]),
        ntfsExtra(item.times),
    ]);
    const writer = new LittleEndianWriter(LOCAL_HEADER_LENGTH + item.name.length + extra.length);
    const storedSize = item.zip64Sizes ? UINT32_MAX : item.entry.size;
    writer.uint32(LOCAL_HEADER_SIGNATURE);
    writer.uint16(item.zip64Sizes ? VERSION_ZIP64 : VERSION_DEFAULT);
    writer.uint16(UTF8_NAMES_FLAG);
    writer.uint16(STORED);
    writer.uint16(item.modified.time);
    writer.uint16(item.modified.date);
    writer.uint32(item.entry.crc32);
    writer.uint32(storedSize);
    writer.uint32(storedSize);
    writer.uint16(item.name.length);
    writer.uint16(extra.length);
    writer.bytes(item.name);
    writer.bytes(extra);

    return writer.result;
}

function centralHeader(item: PreparedEntry): Uint8Array<ArrayBuffer> {
    // The ZIP64 extra lists only the fields whose 32-bit slot holds 0xFFFFFFFF, in this order.
    const zip64Values = [
        ...(item.zip64Sizes ? [item.entry.size, item.entry.size] : []),
        ...(item.zip64Offset ? [item.offset] : []),
    ];
    const isZip64 = zip64Values.length > 0;
    const extra = concatBytes([
        ...(isZip64 ? [zip64Extra(zip64Values)] : []),
        extendedTimestampExtra([item.times.modified]),
        ntfsExtra(item.times),
    ]);
    const storedSize = item.zip64Sizes ? UINT32_MAX : item.entry.size;
    const writer = new LittleEndianWriter(CENTRAL_HEADER_LENGTH + item.name.length + extra.length);
    writer.uint32(CENTRAL_HEADER_SIGNATURE);
    writer.uint16(VERSION_MADE_BY);
    writer.uint16(isZip64 ? VERSION_ZIP64 : VERSION_DEFAULT);
    writer.uint16(UTF8_NAMES_FLAG);
    writer.uint16(STORED);
    writer.uint16(item.modified.time);
    writer.uint16(item.modified.date);
    writer.uint32(item.entry.crc32);
    writer.uint32(storedSize);
    writer.uint32(storedSize);
    writer.uint16(item.name.length);
    writer.uint16(extra.length);
    writer.uint16(0);
    writer.uint16(0);
    writer.uint16(0);
    writer.uint32(REGULAR_FILE_MODE * 0x10000);
    writer.uint32(item.zip64Offset ? UINT32_MAX : item.offset);
    writer.bytes(item.name);
    writer.bytes(extra);

    return writer.result;
}

function zip64Extra(values: readonly number[]): Uint8Array<ArrayBuffer> {
    const writer = new LittleEndianWriter(4 + values.length * 8);
    writer.uint16(ZIP64_EXTRA_ID);
    writer.uint16(values.length * 8);
    for (const value of values) {
        writer.uint64(value);
    }

    return writer.result;
}

// Info-ZIP "UT": Unix seconds (signed 32-bit). The local header lists the modified, accessed (the same) and created
// times; the central directory lists the modified time only but keeps the same flags, which describe the local header.
function extendedTimestampExtra(times: readonly number[]): Uint8Array<ArrayBuffer> {
    const writer = new LittleEndianWriter(4 + 1 + times.length * 4);
    writer.uint16(EXTENDED_TIMESTAMP_ID);
    writer.uint16(1 + times.length * 4);
    writer.uint8(EXTENDED_TIMESTAMP_FLAGS);
    for (const time of times) {
        writer.int32(Math.min(INT32_MAX, Math.max(INT32_MIN, Math.floor(time / 1000))));
    }

    return writer.result;
}

// NTFS times (tag 1): modified, accessed (the same) and created, as Windows FILETIME.
function ntfsExtra(times: EntryTimes): Uint8Array<ArrayBuffer> {
    const writer = new LittleEndianWriter(4 + 4 + 4 + NTFS_TIMES_LENGTH);
    writer.uint16(NTFS_EXTRA_ID);
    writer.uint16(4 + 4 + NTFS_TIMES_LENGTH);
    writer.uint32(0);
    writer.uint16(NTFS_TIMES_TAG);
    writer.uint16(NTFS_TIMES_LENGTH);
    writer.uint64Big(toFileTime(times.modified));
    writer.uint64Big(toFileTime(times.modified));
    writer.uint64Big(toFileTime(times.created));

    return writer.result;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const writer = new LittleEndianWriter(parts.reduce((total, part) => total + part.length, 0));
    for (const part of parts) {
        writer.bytes(part);
    }

    return writer.result;
}

interface CentralDirectory {
    readonly count: number;
    readonly size: number;
    readonly offset: number;
}

function zip64EndRecord(directory: CentralDirectory): Uint8Array<ArrayBuffer> {
    const writer = new LittleEndianWriter(ZIP64_END_LENGTH);
    writer.uint32(ZIP64_END_SIGNATURE);
    writer.uint64(ZIP64_END_LENGTH - 12);
    writer.uint16(VERSION_MADE_BY);
    writer.uint16(VERSION_ZIP64);
    writer.uint32(0);
    writer.uint32(0);
    writer.uint64(directory.count);
    writer.uint64(directory.count);
    writer.uint64(directory.size);
    writer.uint64(directory.offset);

    return writer.result;
}

function zip64Locator(zip64EndOffset: number): Uint8Array<ArrayBuffer> {
    const writer = new LittleEndianWriter(ZIP64_LOCATOR_LENGTH);
    writer.uint32(ZIP64_LOCATOR_SIGNATURE);
    writer.uint32(0);
    writer.uint64(zip64EndOffset);
    writer.uint32(1);

    return writer.result;
}

// Fields too small for their value hold the maximum; readers then take it from the ZIP64 record.
function endRecord(directory: CentralDirectory): Uint8Array<ArrayBuffer> {
    const count = Math.min(directory.count, UINT16_MAX);
    const writer = new LittleEndianWriter(END_LENGTH);
    writer.uint32(END_SIGNATURE);
    writer.uint16(0);
    writer.uint16(0);
    writer.uint16(count);
    writer.uint16(count);
    writer.uint32(Math.min(directory.size, UINT32_MAX));
    writer.uint32(Math.min(directory.offset, UINT32_MAX));
    writer.uint16(0);

    return writer.result;
}

class LittleEndianWriter {
    readonly result: Uint8Array<ArrayBuffer>;
    readonly #view: DataView;
    #position = 0;

    constructor(length: number) {
        this.result = new Uint8Array(length);
        this.#view = new DataView(this.result.buffer);
    }

    uint8(value: number): void {
        this.#view.setUint8(this.#position, value);
        this.#position += 1;
    }

    uint16(value: number): void {
        this.#view.setUint16(this.#position, value, true);
        this.#position += 2;
    }

    int32(value: number): void {
        this.#view.setInt32(this.#position, value, true);
        this.#position += 4;
    }

    uint32(value: number): void {
        this.#view.setUint32(this.#position, value, true);
        this.#position += 4;
    }

    uint64(value: number): void {
        this.uint32(value % UINT32_RANGE);
        this.uint32(Math.floor(value / UINT32_RANGE));
    }

    uint64Big(value: bigint): void {
        this.#view.setBigUint64(this.#position, value, true);
        this.#position += 8;
    }

    bytes(data: Uint8Array): void {
        this.result.set(data, this.#position);
        this.#position += data.length;
    }
}
