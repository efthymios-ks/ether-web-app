import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileMetadata, MediaToolkit } from '../media/metadataTypes.js';
import { createZipBlob } from '../media/zip.js';
import type { ZipEntry } from '../media/zip.js';
import { createTestDeviceAsync, createTestFile, pairAsync, waitForAsync } from './clientHarness.js';
import type { TestDevice } from './clientHarness.js';
import type { FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';

vi.mock(import('../media/zip.js'), async importOriginal => {
    const actual = await importOriginal();

    return { ...actual, createZipBlob: vi.fn(actual.createZipBlob) };
});

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

const TAKEN_AT = '2026-11-20T10:00:00+01:00';

const DATED_MEDIA: MediaToolkit = Object.freeze({
    extractMetadataAsync: async (file: File): Promise<FileMetadata | undefined> => {
        if (file.name === 'camera.jpg') {
            return { takenAt: TAKEN_AT, takenAtSource: 'exif' };
        }

        if (file.name === 'screenshot.png') {
            return { takenAt: '2026-11-21T08:00:00Z', takenAtSource: 'file' };
        }

        return undefined;
    },
    createThumbnailAsync: async () => undefined,
});

describe('buildZipAsync', () => {
    it('keeps folders and the sender\'s dates, with the date taken as the creation date', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await createTestDeviceAsync(hub, { name: 'Alice', media: DATED_MEDIA });
        const bob = await createTestDeviceAsync(hub, { name: 'Bob', media: DATED_MEDIA });
        devices.push(alice, bob);
        await pairAsync(alice, bob);
        const done: FileRecord[] = [];
        bob.client.on('file-done', record => done.push(record));
        const files = [
            createTestFile('camera.jpg', 3000, 1401, 'image/jpeg'),
            createTestFile('screenshot.png', 2000, 1402, 'image/png'),
            createTestFile('notes.txt', 100, 1403, 'text/plain'),
            createTestFile('notes.txt', 120, 1404, 'text/plain'),
        ];
        await alice.client.sendFilesAsync(files, { relativePaths: ['Trip/Day 1/camera.jpg', undefined, 'Docs/notes.txt', 'Docs/notes.txt'] });
        await waitForAsync(() => done.length === 4, 10_000, 'received');
        done.sort((first, second) => first.queueIndex - second.queueIndex);
        vi.mocked(createZipBlob).mockClear();

        // Act
        const zip = await bob.client.buildZipAsync(done[0]?.sessionId ?? '', done.map(record => record.fileId));

        // Assert
        const entries = vi.mocked(createZipBlob).mock.calls[0]?.[0] as ReadonlyArray<ZipEntry & { readonly created?: number }>;
        expect(zip).toBeInstanceOf(Blob);
        expect(entries.map(entry => entry.name)).toEqual(['Trip/Day 1/camera.jpg', 'screenshot.png', 'Docs/notes.txt', 'Docs/notes (2).txt']);
        expect(entries.map(entry => entry.lastModified)).toEqual(files.map(file => file.lastModified));
        expect(entries[0]?.created).toBe(Date.parse(TAKEN_AT));
        expect(entries.slice(1).every(entry => entry.created === undefined)).toBe(true);
    });
});
