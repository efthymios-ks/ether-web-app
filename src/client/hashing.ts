import { createSha256 } from '../core/sha256.js';
import { countPages, pageRange } from './pagination.js';

// Identities and hashes from §7.1. Files are only ever read a slice at a time (PK-04).

export const HASH_BYTES = 32;
const ID_BYTES = 16;
const SAMPLE_BYTES = 64 * 1024;

export function toHex(bytes: Uint8Array): string {
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }

    return hex;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }

    return bytes;
}

export async function sha256Async(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// SHA-256 of the two device IDs, sorted and joined; the first 16 bytes as hex. Both sides get the same value.
export async function computeSessionIdAsync(firstDeviceId: string, secondDeviceId: string): Promise<string> {
    const joined = [firstDeviceId, secondDeviceId].sort().join('');
    const digest = await sha256Async(new TextEncoder().encode(joined));

    return toHex(digest.subarray(0, ID_BYTES));
}

// The sampled content digest of §7.1: SHA-256 of the size (8 bytes) + first 64 KiB + 64 KiB from the middle + last 64 KiB.
// Equal bytes give equal digests wherever the files are.
export async function computeContentDigestAsync(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
    const size = file.size;
    const middleStart = Math.max(0, Math.floor(size / 2) - SAMPLE_BYTES / 2);
    const parts = await Promise.all([
        file.slice(0, SAMPLE_BYTES).arrayBuffer(),
        file.slice(middleStart, middleStart + SAMPLE_BYTES).arrayBuffer(),
        file.slice(Math.max(0, size - SAMPLE_BYTES), size).arrayBuffer(),
    ]);
    const sizeBytes = new Uint8Array(8);
    new DataView(sizeBytes.buffer).setBigUint64(0, BigInt(size));
    const input = concatBytes([sizeBytes, ...parts.map(part => new Uint8Array(part))]);

    return sha256Async(input);
}

// A file's identity is its content and its path: SHA-256 of the content digest + the UTF-8 of the path; first 16 bytes as hex.
// The same bytes in two folders are two files; a renamed or moved file is a new one (a deviation from §7.1).
export async function fileIdFromDigestAsync(contentDigest: Uint8Array, path: string): Promise<string> {
    const digest = await sha256Async(concatBytes([contentDigest, new TextEncoder().encode(path)]));

    return toHex(digest.subarray(0, ID_BYTES));
}

export async function computeFileIdAsync(file: Blob, path: string): Promise<string> {
    return fileIdFromDigestAsync(await computeContentDigestAsync(file), path);
}

// The path a file's identity uses: its path in the picked folder, else its name.
export function identityPathOf(file: { readonly name: string; readonly relativePath?: string | undefined }): string {
    return file.relativePath != null && file.relativePath.length > 0 ? file.relativePath : file.name;
}

// The rootHash of a whole file at a page size, one page in memory at a time.
export async function computeRootHashAsync(
    size: number,
    pageSize: number,
    readPageAsync: (page: number) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<string> {
    const totalPages = countPages(size, pageSize);
    const pageHashes = new PageHashList();
    for (let page = 0; page < totalPages; page++) {
        pageHashes.set(page, await hashPageAsync(await readPageAsync(page)));
    }

    return rootHashAsync(pageHashes.bytes, totalPages);
}

export async function readPageAsync(file: Blob, pageSize: number, page: number): Promise<Uint8Array<ArrayBuffer>> {
    const range = pageRange(file.size, pageSize, page);

    return new Uint8Array(await file.slice(range.start, range.end).arrayBuffer());
}

export function hashPageAsync(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return sha256Async(bytes);
}

// SHA-256 over page hashes 0..count; prefixHash while a file is in progress, rootHash once all pages are in.
export async function hashOfPageHashesAsync(pageHashes: Uint8Array, count: number): Promise<string> {
    const input = new Uint8Array(count * HASH_BYTES);
    input.set(pageHashes.subarray(0, count * HASH_BYTES));

    return toHex(await sha256Async(input));
}

export function prefixHashAsync(pageHashes: Uint8Array, pagesDone: number): Promise<string> {
    return hashOfPageHashesAsync(pageHashes, pagesDone);
}

export function rootHashAsync(pageHashes: Uint8Array, totalPages: number): Promise<string> {
    return hashOfPageHashesAsync(pageHashes, totalPages);
}

export interface DigestOptions {
    readonly onProgress?: (fraction: number) => void;
    readonly signal?: AbortSignal;
}

// The standard SHA-256 of the parts in order, one part in memory at a time, yielding between parts.
export async function sha256OfPartsAsync(parts: readonly Blob[], options: DigestOptions = {}): Promise<string> {
    const hash = createSha256();
    for (const [index, part] of parts.entries()) {
        options.signal?.throwIfAborted();
        hash.update(new Uint8Array(await part.arrayBuffer()));
        options.onProgress?.((index + 1) / parts.length);
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    options.signal?.throwIfAborted();
    if (parts.length === 0) {
        options.onProgress?.(1);
    }

    return hash.digestHex();
}

// A File as slices of `partSize`, so it is never read whole.
export function sliceIntoParts(file: Blob, partSize: number): Blob[] {
    const parts: Blob[] = [];
    for (let start = 0; start < file.size; start += partSize) {
        parts.push(file.slice(start, Math.min(file.size, start + partSize)));
    }

    return parts;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

// A growable list of 32-byte page hashes, stored as one Uint8Array.
export class PageHashList {
    #bytes: Uint8Array<ArrayBuffer>;
    #count = 0;

    constructor(initial?: Uint8Array, count = 0) {
        this.#bytes = new Uint8Array(Math.max(count, 16) * HASH_BYTES);
        if (initial && count > 0) {
            this.#bytes.set(initial.subarray(0, count * HASH_BYTES));
            this.#count = count;
        }
    }

    get count(): number {
        return this.#count;
    }

    get bytes(): Uint8Array {
        return this.#bytes.subarray(0, this.#count * HASH_BYTES);
    }

    get(page: number): Uint8Array | undefined {
        if (page >= this.#count) {
            return undefined;
        }

        return this.#bytes.subarray(page * HASH_BYTES, (page + 1) * HASH_BYTES);
    }

    set(page: number, hash: Uint8Array): void {
        if (page > this.#count) {
            throw new RangeError(`Page hash ${page} set before page ${this.#count}`);
        }

        this.#ensureCapacity(page + 1);
        this.#bytes.set(hash.subarray(0, HASH_BYTES), page * HASH_BYTES);
        this.#count = Math.max(this.#count, page + 1);
    }

    truncate(count: number): void {
        this.#count = Math.min(this.#count, count);
    }

    copy(): Uint8Array<ArrayBuffer> {
        return this.#bytes.slice(0, this.#count * HASH_BYTES);
    }

    #ensureCapacity(count: number): void {
        if (count * HASH_BYTES <= this.#bytes.length) {
            return;
        }

        const grown = new Uint8Array(Math.max(count, this.#bytes.length / HASH_BYTES * 2) * HASH_BYTES);
        grown.set(this.#bytes);
        this.#bytes = grown;
    }
}
