import { describe, expect, it } from 'vitest';
import {
    PageHashList,
    computeContentDigestAsync,
    computeFileIdAsync,
    computeRootHashAsync,
    computeSessionIdAsync,
    identityPathOf,
    fromHex,
    hashPageAsync,
    prefixHashAsync,
    readPageAsync,
    rootHashAsync,
    sha256Async,
    toHex,
} from './hashing.js';

function bytesFrom(size: number, seed: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        bytes[index] = (index * 31 + seed) & 0xff;
    }

    return bytes;
}

describe('computeSessionIdAsync', () => {
    it('gives both devices the same 16-byte ID whatever the order', async () => {
        // Act
        const first = await computeSessionIdAsync('device-a', 'device-b');
        const second = await computeSessionIdAsync('device-b', 'device-a');

        // Assert
        expect(first).toBe(second);
        expect(first).toMatch(/^[0-9a-f]{32}$/);
        expect(first).toBe(toHex((await sha256Async(new TextEncoder().encode('device-adevice-b'))).subarray(0, 16)));
    });
});

describe('computeFileIdAsync', () => {
    it('is the content and the path: the same bytes in two folders, or renamed, are different files', async () => {
        // Arrange
        const bytes = bytesFrom(600 * 1024, 1);
        const changed = bytes.slice();
        changed[300 * 1024] = (changed[300 * 1024] ?? 0) ^ 1;
        const file = new File([bytes], 'a.jpg');

        // Act
        const original = await computeFileIdAsync(file, 'Trip/a.jpg');
        const again = await computeFileIdAsync(new File([bytes], 'a.jpg'), 'Trip/a.jpg');
        const otherFolder = await computeFileIdAsync(file, 'Backup/a.jpg');
        const renamed = await computeFileIdAsync(new File([bytes], 'b.jpg'), 'Trip/b.jpg');
        const edited = await computeFileIdAsync(new File([changed], 'a.jpg'), 'Trip/a.jpg');

        // Assert
        expect(original).toMatch(/^[0-9a-f]{32}$/);
        expect(again).toBe(original);
        expect(new Set([original, otherFolder, renamed, edited]).size).toBe(4);
        const expected = await sha256Async(new Uint8Array([...await computeContentDigestAsync(file), ...new TextEncoder().encode('Trip/a.jpg')]));
        expect(original).toBe(toHex(expected.subarray(0, 16)));
    });

    it('takes the path in the picked folder, else the name', () => {
        // Act
        const inFolder = identityPathOf({ name: 'a.jpg', relativePath: 'Trip/a.jpg' });
        const alone = identityPathOf({ name: 'a.jpg' });
        const empty = identityPathOf({ name: 'a.jpg', relativePath: '' });

        // Assert
        expect([inFolder, alone, empty]).toEqual(['Trip/a.jpg', 'a.jpg', 'a.jpg']);
    });

    it('gives a sampled collision the same ID, which only the whole-file root hash tells apart', async () => {
        // Arrange
        const bytes = bytesFrom(600 * 1024, 4);
        const collided = bytes.slice();
        collided[100 * 1024] = (collided[100 * 1024] ?? 0) ^ 1;
        const read = (data: Uint8Array<ArrayBuffer>) => (page: number) => readPageAsync(new Blob([data]), 256 * 1024, page);

        // Act
        const ids = [await computeFileIdAsync(new File([bytes], 'a'), 'a'), await computeFileIdAsync(new File([collided], 'a'), 'a')];
        const roots = [await computeRootHashAsync(bytes.length, 256 * 1024, read(bytes)), await computeRootHashAsync(collided.length, 256 * 1024, read(collided))];

        // Assert
        expect(ids[1]).toBe(ids[0]);
        expect(roots[1]).not.toBe(roots[0]);
        expect(await computeRootHashAsync(0, 256 * 1024, read(new Uint8Array(0)))).toBe(await rootHashAsync(new Uint8Array(0), 0));
    });

    it('reads only slices, so huge files cost the same', async () => {
        // Arrange
        let sliced = 0;
        const blob = new Blob([bytesFrom(1024, 2)]);
        const tracked = {
            size: 5 * 1024 * 1024 * 1024,
            slice: (start: number, end: number) => {
                sliced += Math.max(0, end - start);

                return blob.slice(0, Math.min(1024, end - start));
            },
        } as unknown as Blob;

        // Act
        await computeFileIdAsync(tracked, 'huge.bin');

        // Assert
        expect(sliced).toBe(3 * 64 * 1024);
    });

    it('handles a zero-byte file', async () => {
        // Act
        const fileId = await computeFileIdAsync(new File([], 'empty'), 'empty');

        // Assert
        expect(fileId).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('page hashes', () => {
    it('reads one page at a time and chains prefix and root hashes over page hashes', async () => {
        // Arrange
        const file = new File([bytesFrom(2500, 3)], 'f');
        const pages = await Promise.all([0, 1, 2].map(page => readPageAsync(file, 1000, page)));
        const hashes = new PageHashList();
        for (const [page, bytes] of pages.entries()) {
            hashes.set(page, await hashPageAsync(bytes));
        }

        // Act
        const prefix = await prefixHashAsync(hashes.bytes, 2);
        const root = await rootHashAsync(hashes.bytes, 3);

        // Assert
        expect(pages.map(page => page.length)).toEqual([1000, 1000, 500]);
        expect(prefix).toBe(toHex(await sha256Async(new Uint8Array([...(hashes.get(0) ?? []), ...(hashes.get(1) ?? [])]))));
        expect(root).toMatch(/^[0-9a-f]{64}$/);
        expect(await prefixHashAsync(hashes.bytes, 0)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('grows, truncates and refuses gaps', () => {
        // Arrange
        const hashes = new PageHashList();
        const hash = fromHex('ab'.repeat(32));

        // Act
        for (let page = 0; page < 40; page++) {
            hashes.set(page, hash);
        }

        hashes.truncate(10);

        // Assert
        expect(hashes.count).toBe(10);
        expect(hashes.copy()).toHaveLength(320);
        expect(() => hashes.set(12, hash)).toThrow(RangeError);
        expect(toHex(hashes.get(9) ?? new Uint8Array())).toBe('ab'.repeat(32));
    });
});
