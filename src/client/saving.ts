import { CRC32_INITIAL, crc32Update } from '../media/crc32.js';
import { sanitizeFileName, uniqueFileName } from '../media/fileNames.js';
import { createZipBlob } from '../media/zip.js';
import type { ZipEntry } from '../media/zip.js';
import { ClientError } from './clientTypes.js';
import { sha256Async, toHex } from './hashing.js';
import type { ClientStorage, StoredFile, StoredPage } from './storage.js';

// Getting received files out of the app (§9, §18.4): files leave only as a ZIP download, which keeps their dates;
// the viewer opens full-size files assembled from stored page Blobs, never read whole (RX-03, SV-04).

const PATH_SEPARATORS = /[/\\]+/;

// The stored pages no longer match what was verified on arrival: the file is damaged in app storage.
export class DamagedDataError extends ClientError {
    constructor(readonly record: StoredFile, detail: string) {
        super('verify-failed', `${record.name} is damaged in the app's storage: ${detail}`, record.fileId);
    }
}

// Pages present, in order, and adding up to the file's size.
async function readCompletePagesAsync(storage: ClientStorage, record: StoredFile): Promise<StoredPage[]> {
    if (record.state !== 'done' || !record.hasData) {
        throw new ClientError('file-not-found', `${record.name} is not in the app`, record.fileId);
    }

    const pages = await storage.readPagesAsync(record.sessionId, record.fileId);
    const missing = pages.findIndex((page, index) => page.pageIndex !== index);
    if (missing >= 0) {
        throw new DamagedDataError(record, `page ${missing + 1} is missing`);
    }

    const bytes = pages.reduce((sum, page) => sum + page.data.size, 0);
    if (bytes !== record.size) {
        throw new DamagedDataError(record, `${bytes} of ${record.size} bytes stored`);
    }

    return pages;
}

// Each page is read and hashed on its own, so the file is never in memory whole.
async function verifyStoredPagesAsync(storage: ClientStorage, record: StoredFile): Promise<StoredPage[]> {
    const pages = await readCompletePagesAsync(storage, record);
    for (const page of pages) {
        const bytes = new Uint8Array(await page.data.arrayBuffer());
        if (toHex(await sha256Async(bytes)) !== toHex(page.hash)) {
            throw new DamagedDataError(record, `page ${page.pageIndex + 1} does not match its hash`);
        }
    }

    return pages;
}

// RX-05: a safe name with its extension; folders kept as "/" paths inside the ZIP.
export function safeRelativePath(record: Pick<StoredFile, 'name' | 'relativePath'>): string {
    const segments = (record.relativePath ?? '')
        .split(PATH_SEPARATORS)
        .map(segment => segment.trim())
        .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
        .map(sanitizeFileName);

    return segments.length > 0 ? segments.join('/') : sanitizeFileName(record.name);
}

// RX-03: re-hashes every stored page against its saved hash before handing the File out.
export async function assembleFileAsync(storage: ClientStorage, record: StoredFile): Promise<File> {
    const pages = await verifyStoredPagesAsync(storage, record);

    return new File(pages.map(page => page.data), sanitizeFileName(record.name), {
        type: record.mime,
        lastModified: record.lastModified,
    });
}

// SV-04 keeps the CRC from the arrival of the pages; older records get it page by page.
async function crcOfAsync(record: StoredFile, pages: readonly StoredPage[]): Promise<number> {
    if (record.crc32 != null) {
        return record.crc32;
    }

    let crc = CRC32_INITIAL;
    for (const page of pages) {
        crc = crc32Update(crc, new Uint8Array(await page.data.arrayBuffer()));
    }

    return crc;
}

// The date taken from the metadata, unless it only repeats the file date (MD-05).
export function takenAtMs(record: Pick<StoredFile, 'metadata'>): number | undefined {
    const metadata = record.metadata;
    if (metadata?.takenAt == null || metadata.takenAtSource === 'file') {
        return undefined;
    }

    const time = Date.parse(metadata.takenAt);

    return Number.isNaN(time) ? undefined : time;
}

// No pages are read: the ZIP must be ready at once (test 32), and the unzipper checks each entry's CRC-32.
// Each entry carries the sender's modification date and, when known, the date taken as its creation date.
export async function buildZipAsync(storage: ClientStorage, records: readonly StoredFile[]): Promise<Blob> {
    const taken = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const record of records) {
        const pages = await readCompletePagesAsync(storage, record);
        const created = takenAtMs(record);
        entries.push({
            name: uniqueFileName(safeRelativePath(record), taken),
            data: new Blob(pages.map(page => page.data), { type: record.mime }),
            size: record.size,
            crc32: await crcOfAsync(record, pages),
            lastModified: record.lastModified,
            ...(created == null ? {} : { created }),
        });
    }

    return createZipBlob(entries);
}
