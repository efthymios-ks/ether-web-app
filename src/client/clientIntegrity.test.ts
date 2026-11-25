import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { STORE, requestAsync, transactionDoneAsync } from '../core/database.js';
import {
    KIB,
    PAGE,
    PHOTO_MEDIA,
    bytesOfAsync,
    createTestDeviceAsync,
    createTestFile,
    pairAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import type { FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { StoredPage } from './storage.js';

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

async function receivedAsync(
    files: readonly File[],
    bobOptions: Partial<TestDeviceOptions> = {},
): Promise<{ alice: TestDevice; bob: TestDevice; done: FileRecord[] }> {
    const hub = createFakeNetworkHub();
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', media: PHOTO_MEDIA });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob', media: PHOTO_MEDIA, ...bobOptions });
    devices.push(alice, bob);
    await pairAsync(alice, bob);
    const done: FileRecord[] = [];
    bob.client.on('file-done', record => done.push(record));
    await alice.client.sendFilesAsync(files);
    await waitForAsync(() => done.length === files.length, 10_000, 'received');

    return { alice, bob, done };
}

async function changePageAsync(device: TestDevice, record: FileRecord, pageIndex: number, change: (page: StoredPage) => StoredPage | undefined): Promise<void> {
    const transaction = device.database.transaction(STORE.pages, 'readwrite');
    const pages = transaction.objectStore(STORE.pages);
    const key = [record.sessionId, record.fileId, pageIndex];
    const page = await requestAsync(pages.get(key)) as StoredPage;
    const changed = change(page);
    if (changed) {
        pages.put(changed);
    } else {
        pages.delete(key);
    }

    await transactionDoneAsync(transaction);
}

async function recordAsync(device: TestDevice, fileId: string): Promise<FileRecord | undefined> {
    const sessionId = (await device.client.listSessionsAsync())[0]?.sessionId ?? '';

    return (await device.client.listFilesAsync({ sessionId, direction: 'in' })).find(record => record.fileId === fileId);
}

function sha256Of(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('verify before saving (getReceivedFileAsync)', () => {
    it('re-hashes the stored pages and refuses a damaged one, marking the file damaged', async () => {
        // Arrange
        const file = createTestFile('scan.pdf', 3 * PAGE, 1301, 'application/pdf');
        const { bob, done } = await receivedAsync([file]);
        const record = done[0] as FileRecord;
        const states: FileRecord[] = [];
        bob.client.on('file-state', state => states.push(state));
        const intact = await bob.client.getReceivedFileAsync(record);
        await changePageAsync(bob, record, 1, page => ({ ...page, data: new Blob([new Uint8Array(page.data.size)]) }));

        // Act
        const error = await bob.client.getReceivedFileAsync(record).catch((caught: unknown) => caught);

        // Assert
        expect(await bytesOfAsync(intact)).toEqual(await bytesOfAsync(file));
        expect(error).toMatchObject({ name: 'ClientError', code: 'verify-failed', fileId: record.fileId });
        expect(states.at(-1)).toMatchObject({ fileId: record.fileId, note: 'damaged' });
        expect((await recordAsync(bob, record.fileId))?.note).toBe('damaged');
    });

    it('refuses a file with a missing page', async () => {
        // Arrange
        const { bob, done } = await receivedAsync([createTestFile('video.mp4', 2 * PAGE + 1, 1302, 'video/mp4')]);
        const record = done[0] as FileRecord;
        await changePageAsync(bob, record, 0, () => undefined);

        // Act
        const error = await bob.client.getReceivedFileAsync(record).catch((caught: unknown) => caught);

        // Assert
        expect(error).toMatchObject({ code: 'verify-failed' });
        expect((await recordAsync(bob, record.fileId))?.note).toBe('damaged');
    });
});

describe('saving never deletes', () => {
    it('keeps a downloaded file\'s pages, also across a restart', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await createTestDeviceAsync(hub, { name: 'Alice' });
        const bob = await createTestDeviceAsync(hub, { name: 'Bob' });
        devices.push(alice, bob);
        await pairAsync(alice, bob);
        const done: FileRecord[] = [];
        bob.client.on('file-done', record => done.push(record));
        const file = createTestFile('kept.bin', PAGE + 9, 1321);
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => done.length === 1, 5000, 'received');

        // Act
        await bob.client.markSavedAsync(done[0]?.sessionId ?? '', [done[0]?.fileId ?? '']);
        bob.client.dispose();
        const reopened = await createTestDeviceAsync(hub, { name: 'Bob', factory: bob.factory });
        devices.push(reopened);

        // Assert
        expect(await recordAsync(reopened, done[0]?.fileId ?? '')).toMatchObject({ hasData: true, state: 'done' });
        expect((await recordAsync(reopened, done[0]?.fileId ?? ''))?.savedAt).toBeTypeOf('number');
        expect(await bytesOfAsync(await reopened.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });
});

describe('computeSha256Async', () => {
    it('hashes the stored pages in order, reports progress per page and caches the result', async () => {
        // Arrange
        const file = createTestFile('movie.mov', 3 * PAGE + 123, 1331, 'video/quicktime');
        const { bob, done } = await receivedAsync([file]);
        const fileId = done[0]?.fileId ?? '';
        const fractions: number[] = [];
        const states: FileRecord[] = [];
        bob.client.on('file-state', state => states.push(state));

        // Act
        const sha256 = await bob.client.computeSha256Async(done[0] as FileRecord, { onProgress: fraction => fractions.push(fraction) });
        const cachedFractions: number[] = [];
        const cached = await bob.client.computeSha256Async(done[0] as FileRecord, { onProgress: fraction => cachedFractions.push(fraction) });

        // Assert
        expect(sha256).toBe(sha256Of(await bytesOfAsync(file)));
        expect(fractions).toEqual([0.25, 0.5, 0.75, 1]);
        expect(cached).toBe(sha256);
        expect(cachedFractions).toEqual([]);
        expect(states.at(-1)?.sha256).toBe(sha256);
        expect((await recordAsync(bob, fileId))?.sha256).toBe(sha256);
    });

    it('hashes the File this page still holds on the sender', async () => {
        // Arrange
        const file = createTestFile('sent.bin', 2 * 1024 * KIB + 5, 1341);
        const { alice, done } = await receivedAsync([file]);
        const fileId = done[0]?.fileId ?? '';

        // Act
        const sha256 = await alice.client.computeSha256Async({ sessionId: done[0]?.sessionId ?? '', fileId, direction: 'out' });

        // Assert
        expect(sha256).toBe(sha256Of(await bytesOfAsync(file)));
        const sent = await alice.client.listFilesAsync({ sessionId: alice.client.peer?.sessionId ?? '', direction: 'out' });
        expect(sent[0]?.sha256).toBe(sha256);
    });

    it('stops with an AbortError when its signal fires', async () => {
        // Arrange
        const { bob, done } = await receivedAsync([createTestFile('long.bin', 4 * PAGE, 1351)]);
        const fileId = done[0]?.fileId ?? '';
        const controller = new AbortController();
        const aborted = new AbortController();
        aborted.abort();

        // Act
        const midway = await bob.client.computeSha256Async(done[0] as FileRecord, {
            signal: controller.signal,
            onProgress: fraction => {
                if (fraction >= 0.5) {
                    controller.abort();
                }
            },
        }).catch((caught: unknown) => caught);
        const before = await bob.client.computeSha256Async(done[0] as FileRecord, { signal: aborted.signal }).catch((caught: unknown) => caught);

        // Assert
        expect(midway).toMatchObject({ name: 'AbortError' });
        expect(before).toMatchObject({ name: 'AbortError' });
        expect((await recordAsync(bob, fileId))?.sha256).toBeUndefined();
    });

    it('rejects with file-not-found when neither the pages nor the File are here', async () => {
        // Arrange
        const { bob, done } = await receivedAsync([createTestFile('gone.bin', PAGE, 1361)]);
        const fileId = done[0]?.fileId ?? '';
        await bob.client.deleteReceivedAsync(done[0] as FileRecord);

        // Act
        const error = await bob.client.computeSha256Async(done[0] as FileRecord).catch((caught: unknown) => caught);

        // Assert
        expect(error).toMatchObject({ code: 'file-not-found', fileId });
    });
});
