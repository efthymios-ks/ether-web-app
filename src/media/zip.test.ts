import { describe, expect, it, vi } from 'vitest';
import { crc32 } from './crc32.js';
import { createZipBlob, toDosDateTime, toFileTime } from './zip.js';
import type { ZipEntry } from './zip.js';

const UINT32_MAX = 0xffffffff;
const ZIP64_ID = 0x0001;
const EXTENDED_TIMESTAMP_ID = 0x5455;
const NTFS_ID = 0x000a;
// "UT" in the local header (4 + 13 bytes) and the NTFS field (4 + 32 bytes); "UT" is 4 + 5 bytes in the central directory.
const LOCAL_TIME_EXTRAS_LENGTH = 17 + 36;
// 100 ns ticks between 1601-01-01 and 1970-01-01.
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

interface ExtraField {
    readonly id: number;
    readonly view: DataView;
}

interface CentralRecord {
    readonly name: string;
    readonly versionNeeded: number;
    readonly flags: number;
    readonly method: number;
    readonly time: number;
    readonly date: number;
    readonly crc32: number;
    readonly rawSize: number;
    readonly size: number;
    readonly rawOffset: number;
    readonly offset: number;
    readonly extras: readonly ExtraField[];
    readonly zip64: readonly number[];
    readonly externalAttributes: number;
}

interface ParsedZip {
    readonly entries: readonly CentralRecord[];
    readonly endCount: number;
    readonly endDirectorySize: number;
    readonly endDirectoryOffset: number;
    readonly zip64?: { readonly count: number; readonly directorySize: number; readonly directoryOffset: number };
}

interface LocalEntry {
    readonly name: string;
    readonly data: Uint8Array;
    readonly rawSize: number;
    readonly time: number;
    readonly date: number;
    readonly extras: readonly ExtraField[];
    readonly zip64: readonly number[];
}

function uint64(view: DataView, position: number): number {
    return view.getUint32(position, true) + view.getUint32(position + 4, true) * 0x1_0000_0000;
}

function readExtraFields(bytes: Uint8Array, start: number, length: number): ExtraField[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fields: ExtraField[] = [];
    let position = start;
    while (position + 4 <= start + length) {
        const size = view.getUint16(position + 2, true);
        const data = new DataView(bytes.buffer, bytes.byteOffset + position + 4, size);
        fields.push({ id: view.getUint16(position, true), view: data });
        position += 4 + size;
    }

    expect(position).toBe(start + length);

    return fields;
}

function zip64Values(fields: readonly ExtraField[]): number[] {
    const field = fields.find(candidate => candidate.id === ZIP64_ID);
    if (field == null) {
        return [];
    }

    return Array.from({ length: field.view.byteLength / 8 }, (_, index) => uint64(field.view, index * 8));
}

function extendedTimestamp(fields: readonly ExtraField[]): { flags: number; seconds: number[] } | undefined {
    const field = fields.find(candidate => candidate.id === EXTENDED_TIMESTAMP_ID);
    if (field == null) {
        return undefined;
    }

    const count = (field.view.byteLength - 1) / 4;

    return {
        flags: field.view.getUint8(0),
        seconds: Array.from({ length: count }, (_, index) => field.view.getInt32(1 + index * 4, true)),
    };
}

function ntfsTimes(fields: readonly ExtraField[]) {
    const field = fields.find(candidate => candidate.id === NTFS_ID);
    if (field == null) {
        return undefined;
    }

    return {
        reserved: field.view.getUint32(0, true),
        tag: field.view.getUint16(4, true),
        tagSize: field.view.getUint16(6, true),
        modified: field.view.getBigUint64(8, true),
        accessed: field.view.getBigUint64(16, true),
        created: field.view.getBigUint64(24, true),
    };
}

function fileTimeOf(epochMs: number): bigint {
    return BigInt(epochMs) * 10_000n + FILETIME_UNIX_EPOCH;
}

// Reads the archive from its end the way unzip tools do; `directoryStart` overrides offsets that faked sizes push out of range.
function parseZip(bytes: Uint8Array, directoryStart?: number): ParsedZip {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endOffset = bytes.length - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    const endCount = view.getUint16(endOffset + 10, true);
    const endDirectorySize = view.getUint32(endOffset + 12, true);
    const endDirectoryOffset = view.getUint32(endOffset + 16, true);
    const hasLocator = endOffset >= 20 && view.getUint32(endOffset - 20, true) === 0x07064b50;
    const zip64 = hasLocator ? readZip64End(view, endOffset - 20 - 56) : undefined;
    const count = zip64?.count ?? endCount;
    const directorySize = zip64?.directorySize ?? endDirectorySize;
    const zip64EndStart = endOffset - (hasLocator ? 20 + 56 : 0);
    let position = directoryStart ?? zip64EndStart - directorySize;
    const entries: CentralRecord[] = [];
    for (let index = 0; index < count; index++) {
        expect(view.getUint32(position, true)).toBe(0x02014b50);
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const commentLength = view.getUint16(position + 32, true);
        const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
        const extras = readExtraFields(bytes, position + 46 + nameLength, extraLength);
        const zip64Fields = zip64Values(extras);
        const rawSize = view.getUint32(position + 24, true);
        const rawOffset = view.getUint32(position + 42, true);
        const pending = [...zip64Fields];
        const size = rawSize === UINT32_MAX ? (pending.shift() ?? -1) : rawSize;
        if (rawSize === UINT32_MAX) {
            pending.shift();
        }

        const offset = rawOffset === UINT32_MAX ? (pending.shift() ?? -1) : rawOffset;
        entries.push({
            name,
            versionNeeded: view.getUint16(position + 6, true),
            flags: view.getUint16(position + 8, true),
            method: view.getUint16(position + 10, true),
            time: view.getUint16(position + 12, true),
            date: view.getUint16(position + 14, true),
            crc32: view.getUint32(position + 16, true),
            rawSize,
            size,
            rawOffset,
            offset,
            extras,
            zip64: zip64Fields,
            externalAttributes: view.getUint32(position + 38, true),
        });
        position += 46 + nameLength + extraLength + commentLength;
    }

    return { entries, endCount, endDirectorySize, endDirectoryOffset, zip64 };
}

function readZip64End(view: DataView, position: number): NonNullable<ParsedZip['zip64']> {
    expect(view.getUint32(position, true)).toBe(0x06064b50);
    expect(uint64(view, position + 4)).toBe(44);

    return {
        count: uint64(view, position + 32),
        directorySize: uint64(view, position + 40),
        directoryOffset: uint64(view, position + 48),
    };
}

function readLocalEntry(bytes: Uint8Array, record: CentralRecord): LocalEntry {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const position = record.offset;
    expect(view.getUint32(position, true)).toBe(0x04034b50);
    expect(view.getUint16(position + 4, true)).toBe(record.versionNeeded);
    expect(view.getUint16(position + 6, true)).toBe(record.flags);
    expect(view.getUint16(position + 8, true)).toBe(record.method);
    expect(view.getUint32(position + 14, true)).toBe(record.crc32);
    const nameLength = view.getUint16(position + 26, true);
    const extraLength = view.getUint16(position + 28, true);
    const dataStart = position + 30 + nameLength + extraLength;
    const extras = readExtraFields(bytes, position + 30 + nameLength, extraLength);

    return {
        name: new TextDecoder().decode(bytes.subarray(position + 30, position + 30 + nameLength)),
        data: bytes.subarray(dataStart, dataStart + record.size),
        rawSize: view.getUint32(position + 22, true),
        time: view.getUint16(position + 10, true),
        date: view.getUint16(position + 12, true),
        extras,
        zip64: zip64Values(extras),
    };
}

const DEFAULT_LAST_MODIFIED = Date.UTC(2026, 10, 23, 13, 5, 42);

function createEntry(
    name: string,
    content: Uint8Array<ArrayBuffer> | string,
    times: Pick<ZipEntry, 'lastModified' | 'created'> = { lastModified: DEFAULT_LAST_MODIFIED },
): ZipEntry {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;

    return { name, data: new Blob([bytes]), size: bytes.length, crc32: crc32(bytes), ...times };
}

async function toBytesAsync(blob: Blob): Promise<Uint8Array> {
    return new Uint8Array(await blob.arrayBuffer());
}

async function parseSingleAsync(entry: ZipEntry): Promise<{ record: CentralRecord; local: LocalEntry }> {
    const bytes = await toBytesAsync(createZipBlob([entry]));
    const record = parseZip(bytes).entries[0]!;

    return { record, local: readLocalEntry(bytes, record) };
}

describe('createZipBlob', () => {
    it('writes stored entries with UTF-8 names, CRCs and offsets that a reader can follow', async () => {
        // Arrange
        const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
        const entries = [
            createEntry('hello.txt', 'Hello, world'),
            createEntry('Φωτογραφίες/εικόνα.jpg', binary),
            createEntry('empty.bin', ''),
        ];

        // Act
        const blob = createZipBlob(entries);
        const bytes = await toBytesAsync(blob);
        const zip = parseZip(bytes);

        // Assert
        expect(blob.type).toBe('application/zip');
        expect(zip.zip64).toBeUndefined();
        expect(zip.endCount).toBe(3);
        expect(zip.entries.map(entry => entry.name)).toEqual(['hello.txt', 'Φωτογραφίες/εικόνα.jpg', 'empty.bin']);
        for (const [index, record] of zip.entries.entries()) {
            const local = readLocalEntry(bytes, record);
            expect(record.method).toBe(0);
            expect(record.flags & 0x0800).toBe(0x0800);
            expect(record.versionNeeded).toBe(20);
            expect(record.zip64).toEqual([]);
            expect(record.externalAttributes >>> 16).toBe(0o100644);
            expect(local.name).toBe(record.name);
            expect(local.rawSize).toBe(entries[index]?.size);
            expect(crc32(local.data)).toBe(record.crc32);
            expect(record.crc32).toBe(entries[index]?.crc32);
        }

        expect(zip.endDirectoryOffset + zip.endDirectorySize + 22).toBe(bytes.length);
        expect(Array.from(readLocalEntry(bytes, zip.entries[1]!).data)).toEqual(Array.from(binary));
    });

    it('stores the last-modified time as local DOS date and time in both headers', async () => {
        // Arrange
        const lastModified = new Date(2026, 10, 23, 14, 5, 43).getTime();

        // Act
        const { record, local } = await parseSingleAsync(createEntry('a.txt', 'a', { lastModified }));

        // Assert
        expect(record.date >> 9).toBe(2026 - 1980);
        expect((record.date >> 5) & 0x0f).toBe(11);
        expect(record.date & 0x1f).toBe(23);
        expect(record.time >> 11).toBe(14);
        expect((record.time >> 5) & 0x3f).toBe(5);
        expect((record.time & 0x1f) * 2).toBe(42);
        expect([local.date, local.time]).toEqual([record.date, record.time]);
    });

    it('writes Info-ZIP and NTFS timestamps with the modified and created dates as sent', async () => {
        // Arrange
        const lastModified = Date.UTC(2026, 10, 23, 13, 5, 42, 345);
        const created = Date.UTC(2025, 0, 2, 3, 4, 5, 678);

        // Act
        const { record, local } = await parseSingleAsync(createEntry('photo.jpg', 'pixels', { lastModified, created }));

        // Assert
        expect(local.extras.map(field => field.id)).toEqual([EXTENDED_TIMESTAMP_ID, NTFS_ID]);
        expect(record.extras.map(field => field.id)).toEqual([EXTENDED_TIMESTAMP_ID, NTFS_ID]);
        expect(extendedTimestamp(local.extras)).toEqual({ flags: 0x07, seconds: [1795439142, 1795439142, 1735787045] });
        expect(extendedTimestamp(record.extras)).toEqual({ flags: 0x07, seconds: [1795439142] });
        for (const extras of [local.extras, record.extras]) {
            expect(ntfsTimes(extras)).toEqual({
                reserved: 0,
                tag: 1,
                tagSize: 24,
                modified: fileTimeOf(lastModified),
                accessed: fileTimeOf(lastModified),
                created: fileTimeOf(created),
            });
        }

        expect(fileTimeOf(lastModified)).toBe(134399127423450000n);
    });

    it('uses the modified time as the created time when none is given', async () => {
        // Act
        const { local } = await parseSingleAsync(createEntry('notes.txt', 'text'));

        // Assert
        const seconds = DEFAULT_LAST_MODIFIED / 1000;
        expect(extendedTimestamp(local.extras)?.seconds).toEqual([seconds, seconds, seconds]);
        expect(ntfsTimes(local.extras)?.created).toBe(fileTimeOf(DEFAULT_LAST_MODIFIED));
    });

    it('keeps exact dates in the extras where the DOS field is clamped', async () => {
        // Arrange
        const early = Date.UTC(1975, 5, 1, 12, 0, 0);
        const beforeUnix = Date.UTC(1965, 0, 1, 0, 0, 0);
        const late = Date.UTC(2150, 0, 1, 0, 0, 0);

        // Act
        const [earlyEntry, beforeUnixEntry, lateEntry] = await Promise.all([early, beforeUnix, late].map(lastModified => (
            parseSingleAsync(createEntry('old.jpg', 'x', { lastModified }))
        )));

        // Assert
        expect([earlyEntry?.local.date, earlyEntry?.local.time]).toEqual([(1 << 5) | 1, 0]);
        expect([earlyEntry?.record.date, earlyEntry?.record.time]).toEqual([(1 << 5) | 1, 0]);
        expect(extendedTimestamp(earlyEntry!.local.extras)?.seconds).toEqual(Array(3).fill(early / 1000));
        expect(ntfsTimes(earlyEntry!.record.extras)?.modified).toBe(fileTimeOf(early));
        expect(extendedTimestamp(beforeUnixEntry!.local.extras)?.seconds).toEqual(Array(3).fill(beforeUnix / 1000));
        expect(lateEntry?.record.date).toBe(((2107 - 1980) << 9) | (12 << 5) | 31);
        expect(lateEntry?.record.time).toBe((23 << 11) | (59 << 5) | 29);
        expect(extendedTimestamp(lateEntry!.record.extras)?.seconds).toEqual([0x7fffffff]);
        expect(ntfsTimes(lateEntry!.local.extras)?.modified).toBe(fileTimeOf(late));
    });

    it('clamps dates the DOS format cannot hold', () => {
        // Act
        const early = toDosDateTime(new Date(1970, 0, 1).getTime());
        const late = toDosDateTime(new Date(2200, 0, 1).getTime());
        const invalid = toDosDateTime(Number.NaN);

        // Assert
        expect(early).toEqual({ date: (1 << 5) | 1, time: 0 });
        expect(late.date >> 9).toBe(2107 - 1980);
        expect(invalid).toEqual(early);
    });

    it('converts epoch milliseconds to Windows FILETIME and never below 1601', () => {
        // Act
        const values = [toFileTime(0), toFileTime(Date.UTC(1601, 0, 1)), toFileTime(Date.UTC(1500, 0, 1))];

        // Assert
        expect(values).toEqual([FILETIME_UNIX_EPOCH, 0n, 0n]);
    });

    it('writes ZIP64 extra fields first, then the timestamps, with the ZIP64 records when forced', async () => {
        // Arrange
        const entries = [createEntry('one.txt', 'one'), createEntry('two.txt', 'second')];

        // Act
        const bytes = await toBytesAsync(createZipBlob(entries, { forceZip64: true }));
        const zip = parseZip(bytes);

        // Assert
        expect(zip.zip64).toEqual({
            count: 2,
            directorySize: zip.endDirectorySize,
            directoryOffset: zip.endDirectoryOffset,
        });
        for (const [index, record] of zip.entries.entries()) {
            const local = readLocalEntry(bytes, record);
            expect(record.versionNeeded).toBe(45);
            expect(record.rawSize).toBe(UINT32_MAX);
            expect(record.rawOffset).toBe(UINT32_MAX);
            expect(record.zip64).toEqual([entries[index]?.size, entries[index]?.size, record.offset]);
            expect(local.rawSize).toBe(UINT32_MAX);
            expect(local.zip64).toEqual([entries[index]?.size, entries[index]?.size]);
            expect(local.extras.map(field => field.id)).toEqual([ZIP64_ID, EXTENDED_TIMESTAMP_ID, NTFS_ID]);
            expect(record.extras.map(field => field.id)).toEqual([ZIP64_ID, EXTENDED_TIMESTAMP_ID, NTFS_ID]);
            expect(extendedTimestamp(record.extras)?.seconds).toEqual([DEFAULT_LAST_MODIFIED / 1000]);
            expect(ntfsTimes(local.extras)?.modified).toBe(fileTimeOf(DEFAULT_LAST_MODIFIED));
            expect(crc32(local.data)).toBe(record.crc32);
        }
    });

    it('switches sizes and offsets to ZIP64 once they reach 4 GiB', async () => {
        // Arrange
        const hugeSize = 0x1_0000_0000 + 5;
        const huge = new Blob(['x']);
        Object.defineProperty(huge, 'size', { value: hugeSize });
        const entries: ZipEntry[] = [
            { name: 'huge.mov', data: huge, size: hugeSize, crc32: 0x12345678, lastModified: 0 },
            createEntry('after.txt', 'after'),
        ];
        const firstHeaderLength = 30 + 'huge.mov'.length + 20 + LOCAL_TIME_EXTRAS_LENGTH;
        const secondHeaderLength = 30 + 'after.txt'.length + LOCAL_TIME_EXTRAS_LENGTH;

        // Act
        const bytes = await toBytesAsync(createZipBlob(entries));
        const directorySize = new DataView(bytes.buffer).getUint32(bytes.length - 22 - 20 - 56 + 40, true);
        const zip = parseZip(bytes, bytes.length - 22 - 20 - 56 - directorySize);

        // Assert
        const [first, second] = zip.entries;
        expect(first).toMatchObject({ rawSize: UINT32_MAX, size: hugeSize, rawOffset: 0, zip64: [hugeSize, hugeSize] });
        expect(second).toMatchObject({ rawSize: 5, rawOffset: UINT32_MAX, offset: firstHeaderLength + hugeSize });
        expect(second?.zip64).toEqual([firstHeaderLength + hugeSize]);
        expect(second?.extras.map(field => field.id)).toEqual([ZIP64_ID, EXTENDED_TIMESTAMP_ID, NTFS_ID]);
        expect(zip.zip64?.directoryOffset).toBe(firstHeaderLength + hugeSize + secondHeaderLength + 5);
        expect(zip.endDirectoryOffset).toBe(UINT32_MAX);
    });

    it('adds the ZIP64 end record at 65,535 entries', async () => {
        // Arrange
        const empty = new Blob([]);
        const entries = Array.from({ length: 0xffff }, (_, index): ZipEntry => ({
            name: `${index}.txt`,
            data: empty,
            size: 0,
            crc32: 0,
            lastModified: 0,
        }));

        // Act
        const zip = parseZip(await toBytesAsync(createZipBlob(entries)));

        // Assert
        expect(zip.endCount).toBe(0xffff);
        expect(zip.zip64?.count).toBe(0xffff);
        expect(zip.entries).toHaveLength(0xffff);
        expect(zip.entries.at(-1)?.name).toBe('65534.txt');
    }, 15_000);

    it('never reads the entry data while building', () => {
        // Arrange
        const entry = createEntry('photo.jpg', 'pixels');
        const reads = [
            vi.spyOn(entry.data, 'arrayBuffer'),
            vi.spyOn(entry.data, 'stream'),
            vi.spyOn(entry.data, 'text'),
            vi.spyOn(entry.data, 'slice'),
        ];

        // Act
        createZipBlob([entry]);

        // Assert
        for (const read of reads) {
            expect(read).not.toHaveBeenCalled();
        }
    });

    it('rejects an entry whose size does not match its data', () => {
        // Arrange
        const entry = { ...createEntry('photo.jpg', 'pixels'), size: 99 };

        // Act
        const build = (): Blob => createZipBlob([entry]);

        // Assert
        expect(build).toThrow(RangeError);
    });
});
