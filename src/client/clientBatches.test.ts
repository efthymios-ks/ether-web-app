import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { crc32 } from '../media/crc32.js';
import {
    KIB,
    PAGE,
    PHOTO_MEDIA,
    bytesOfAsync,
    createTestDeviceAsync,
    createTestFile,
    messages,
    pairAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import type { BatchIncoming, BatchProgress, ClientError, ClientNotice, FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

async function pairedAsync(
    aliceOptions: Partial<TestDeviceOptions> = {},
    bobOptions: Partial<TestDeviceOptions> = {},
): Promise<{ hub: FakeNetworkHub; alice: TestDevice; bob: TestDevice }> {
    const hub = createFakeNetworkHub();
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', ...aliceOptions });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob', ...bobOptions });
    devices.push(alice, bob);
    await pairAsync(alice, bob);

    return { hub, alice, bob };
}

function collect<Item>(subscribe: (push: (item: Item) => void) => void): Item[] {
    const items: Item[] = [];
    subscribe(item => items.push(item));

    return items;
}

function photo(index: number, size = 20 * KIB + index): File {
    return createTestFile(`IMG_${1000 + index}.JPG`, size, 500 + index, 'image/jpeg');
}

describe('batches (§18.1)', () => {
    it('records a batch for a file offered on its own, with batch-progress until it finishes', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const progress = collect<BatchProgress>(push => bob.client.on('batch-progress', push));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const file = createTestFile('single.bin', 3 * PAGE, 1501);

        // Act
        const batch = await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => done.length === 1, 5000, 'done');
        await waitForAsync(() => progress.some(item => item.done === 1), 2000, 'batch progress');

        // Assert
        const sessionId = bob.client.peer?.sessionId ?? '';
        const batches = await bob.client.listBatchesAsync(sessionId);
        expect(batches).toEqual([expect.objectContaining({ batchId: batch.batchId, direction: 'in', itemCount: 1, totalBytes: file.size, received: 1 })]);
        expect(batches[0]?.finishedAt).toBeTypeOf('number');
        expect(batches[0]).not.toHaveProperty('singleOfferFileIds');
        expect(done[0]?.batchId).toBe(batch.batchId);
        expect(progress.at(-1)).toMatchObject({ batchId: batch.batchId, direction: 'in', total: 1, done: 1, totalBytes: file.size, bytesDone: file.size });
    });

    it('gives a single offer without a batch ID a batch of its own, and counts each later single offer of a batch once', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({ settings: { maxConcurrentFiles: 1 } });
        let firstBatchId: string | undefined;
        let offers = 0;
        hub.intercept(traffic => {
            if (traffic.kind !== 'message' || traffic.message.t !== 'offer') {
                return undefined;
            }

            offers++;
            if (offers === 1) {
                return { message: { ...traffic.message, batchId: undefined } };
            }

            firstBatchId ??= traffic.message.batchId as string;

            return { message: { ...traffic.message, batchId: firstBatchId } };
        });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        await alice.client.sendFilesAsync([createTestFile('loose.bin', 100, 1511)]);
        await waitForAsync(() => done.length === 1, 5000, 'first');
        await alice.client.sendFilesAsync([createTestFile('first.bin', 200, 1512)]);
        await waitForAsync(() => done.length === 2, 5000, 'second');
        await alice.client.sendFilesAsync([createTestFile('second.bin', 300, 1513)]);
        await waitForAsync(() => done.length === 3, 5000, 'third');
        await waitForAsync(async () => (await bob.client.listBatchesAsync(bob.client.peer?.sessionId ?? '')).some(item => item.received === 2), 2000, 'counts');

        // Assert
        const batches = await bob.client.listBatchesAsync(bob.client.peer?.sessionId ?? '');
        const loose = batches.find(item => item.batchId === done[0]?.batchId);
        const shared = batches.find(item => item.batchId === firstBatchId);
        expect(done[0]?.batchId).toBeTypeOf('string');
        expect(done[0]?.batchId).not.toBe(firstBatchId);
        expect(loose).toMatchObject({ itemCount: 1, totalBytes: 100, received: 1 });
        expect(shared).toMatchObject({ itemCount: 2, totalBytes: 500, received: 2 });
        expect(shared?.finishedAt).toBeTypeOf('number');
    });

    it('accepts what fits when the batch is larger than the free space (test 33)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({}, { freeBytes: () => 2 * PAGE + 10 * KIB });
        const prompts = collect<BatchIncoming>(push => bob.client.on('batch-incoming', push));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const failed = collect<{ record: FileRecord; error: ClientError }>(push => alice.client.on('file-failed', (record, error) => push({ record, error })));
        const files = [0, 1, 2, 3].map(index => createTestFile(`part-${index}.bin`, PAGE, 600 + index));

        // Act
        const batch = await alice.client.sendFilesAsync(files);
        await waitForAsync(() => prompts.length === 1, 5000, 'prompt');
        await bob.client.acceptBatchAsync(prompts[0]?.batchId ?? '', { mode: 'fits' });
        await waitForAsync(() => done.length === 2 && failed.length === 2, 10_000, 'outcome');

        // Assert
        expect(prompts[0]).toMatchObject({ batchId: batch.batchId, peerName: 'Alice', itemCount: 4, totalBytes: 4 * PAGE, fitsCount: 2, fitsBytes: 2 * PAGE, spaceIsShort: true });
        expect(done.map(record => record.name).sort()).toEqual(['part-0.bin', 'part-1.bin']);
        expect(failed.map(item => item.record.name).sort()).toEqual(['part-2.bin', 'part-3.bin']);
        expect(failed[0]?.error.code).toBe('no-space');
        const received = await bob.client.listFilesAsync({ sessionId: bob.client.peer?.sessionId ?? '', states: ['failed'] });
        expect(received.map(record => record.note)).toEqual(['no-space', 'no-space']);
        // The batch counts are written just after the file events.
        await waitForAsync(async () => {
            const [record] = await alice.client.listBatchesAsync(alice.client.peer?.sessionId ?? '');

            return record != null && record.received + record.failed === 4;
        }, 2000, 'batch counts');
        const batches = await alice.client.listBatchesAsync(alice.client.peer?.sessionId ?? '');
        expect(batches[0]).toMatchObject({ batchId: batch.batchId, itemCount: 4, received: 2, failed: 2 });
        expect(batches[0]?.finishedAt).toBeTypeOf('number');
    });

    it('declines a whole batch on request and retries only the failed files later (BK-07)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({}, { settings: { askBeforeReceiving: true } });
        const prompts = collect<BatchIncoming>(push => bob.client.on('batch-incoming', push));
        const failed = collect<FileRecord>(push => alice.client.on('file-failed', push));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const batch = await alice.client.sendFilesAsync([photo(1), photo(2)]);
        await waitForAsync(() => prompts.length === 1, 5000, 'prompt');

        // Act
        await bob.client.declineBatchAsync(batch.batchId);
        await waitForAsync(() => failed.length === 2, 5000, 'declined');
        await bob.client.configureAsync({ askBeforeReceiving: false });
        await alice.client.retryFailedAsync(alice.client.peer?.sessionId ?? '', batch.batchId);
        await waitForAsync(() => done.length === 2, 5000, 'retried');

        // Assert
        expect(prompts[0]?.spaceIsShort).toBe(false);
        expect(failed.every(record => record.note === 'declined')).toBe(true);
        expect(done.map(record => record.state)).toEqual(['done', 'done']);
    });

    it('offers a large selection in offer-batch messages under 60 KiB and answers each once (BK-02)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({ settings: { maxConcurrentFiles: 4 } });
        const offerBatchSizes: number[] = [];
        const singleOffers: string[] = [];
        hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'offer-batch') {
                offerBatchSizes.push(JSON.stringify(traffic.message).length);
            }

            if (traffic.kind === 'message' && traffic.message.t === 'offer' && traffic.message.batchId == null) {
                singleOffers.push(traffic.message.name as string);
            }

            return undefined;
        });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const progress = collect<BatchProgress>(push => bob.client.on('batch-progress', push));
        const files = Array.from({ length: 260 }, (_, index) => createTestFile(`tiny-${index}.txt`, 64 + index, 1000 + index, 'text/plain'));

        // Act
        const batch = await alice.client.sendFilesAsync(files);
        await waitForAsync(() => done.length === 260, 20_000, 'all done');

        // Assert
        expect(batch.files).toHaveLength(260);
        expect(offerBatchSizes.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...offerBatchSizes)).toBeLessThan(60 * KIB);
        expect(singleOffers).toEqual([]);
        expect(messages(bob).filter(message => message.startsWith(`batch ${batch.batchId.slice(0, 8)} part`))).toHaveLength(offerBatchSizes.length);
        await waitForAsync(() => progress.some(item => item.done === 260), 2000, 'batch progress');
    }, 30_000);
});

describe('thumbnails (§18.2)', () => {
    it('sends thumbnails on control ahead of the data and keeps them after the file is deleted (TH-02, TH-03)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({ media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true } }, { media: PHOTO_MEDIA });
        const thumbs = collect<string>(push => bob.client.on('thumb', fileId => push(fileId)));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const thumbChannels: string[] = [];
        hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'thumb') {
                thumbChannels.push(String(traffic.channel));
            }

            return undefined;
        });

        // Act
        await alice.client.sendFilesAsync([photo(1), photo(2), photo(3)]);
        await waitForAsync(() => done.length === 3 && thumbs.length === 3, 5000, 'thumbs');
        const fileId = done[0]?.fileId ?? '';
        const ref = { sessionId: bob.client.peer?.sessionId ?? '', fileId };
        await bob.client.deleteReceivedAsync(ref);

        // Assert
        expect(thumbChannels).toHaveLength(3);
        expect(new Set(thumbChannels)).toEqual(new Set(['control']));
        expect(await bob.client.getThumbnailAsync(ref)).toBeInstanceOf(Blob);
        expect(await alice.client.getThumbnailAsync(ref)).toBeInstanceOf(Blob);
        const record = (await bob.client.listFilesAsync({ sessionId: bob.client.peer?.sessionId ?? '' })).find(item => item.fileId === fileId);
        expect(record).toMatchObject({ hasThumbnail: true, hasData: false, state: 'done' });
    });

    it('sends the thumbnails of many small images faster than 10 a second, under the control buffer limit (TH-02, test 31)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({ media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true } }, { media: PHOTO_MEDIA });
        const sent: Array<{ readonly time: number; readonly buffered: number }> = [];
        hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'thumb') {
                sent.push({ time: performance.now(), buffered: traffic.from.bufferedAmount('control') });
            }

            return undefined;
        });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        await alice.client.sendFilesAsync(Array.from({ length: 40 }, (_, index) => photo(100 + index, 2 * KIB + index)));
        await waitForAsync(() => done.length === 40 && sent.length === 40, 10_000, 'thumbnails');

        // Assert
        const spreadMs = (sent.at(-1)?.time ?? 0) - (sent[0]?.time ?? 0);
        expect(spreadMs).toBeLessThan(39 * 100);
        expect(Math.max(...sent.map(item => item.buffered))).toBeLessThanOrEqual(256 * KIB);
        expect((await bob.client.listFilesAsync({ sessionId: bob.client.peer?.sessionId ?? '' })).every(record => record.hasThumbnail)).toBe(true);
    });

    it('makes its own thumbnail once the file is verified when the sender could not make one, and keeps only one', async () => {
        // Arrange
        const cannotDecode = { ...PHOTO_MEDIA, createThumbnailAsync: async () => undefined };
        const { hub, alice, bob } = await pairedAsync({ media: cannotDecode, settings: { sendThumbnailsFirst: true } }, { media: PHOTO_MEDIA });
        const noThumbnail: string[] = [];
        hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'thumb' && traffic.message.none === true) {
                noThumbnail.push(traffic.message.fileId as string);
            }

            return undefined;
        });
        const thumbs = collect<string>(push => bob.client.on('thumb', fileId => push(fileId)));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const file = createTestFile('IMG_0001.HEIC', 40 * KIB, 1201, 'image/heic');

        // Act
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => done.length === 1 && thumbs.length === 1, 5000, 'own thumbnail');
        const network = hub.networks.find(candidate => candidate.peer != null && candidate.index === 0);
        network?.send('control', { t: 'thumb', fileId: done[0]?.fileId ?? '', jpeg: 'AAAA' });
        await waitForAsync(() => messages(bob).some(message => message.endsWith('already has a thumbnail, the late one is dropped')), 2000, 'late thumbnail');

        // Assert
        expect(noThumbnail).toEqual([done[0]?.fileId]);
        expect(thumbs).toEqual([done[0]?.fileId]);
        const stored = await bob.client.getThumbnailAsync(done[0] as FileRecord);
        expect(await bytesOfAsync(stored as Blob)).toEqual((await bytesOfAsync(file)).subarray(0, 64));
        expect(await alice.client.getThumbnailAsync({ sessionId: done[0]?.sessionId ?? '', fileId: done[0]?.fileId ?? '', direction: 'out' })).toBeUndefined();
    });

    it('stops waiting for an announced thumbnail when the link goes, and makes its own', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({ media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true } }, { media: PHOTO_MEDIA });
        hub.intercept(traffic => (traffic.kind === 'message' && traffic.message.t === 'thumb' ? 'drop' : undefined));
        const thumbs = collect<string>(push => bob.client.on('thumb', fileId => push(fileId)));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        await alice.client.sendFilesAsync([photo(30)]);
        await waitForAsync(() => done.length === 1, 5000, 'done');
        await new Promise(resolve => setTimeout(resolve, 50));
        const thumbsBeforeLoss = thumbs.length;

        // Act
        await alice.client.disconnectAsync();
        await waitForAsync(() => thumbs.length === 1, 5000, 'own thumbnail');

        // Assert
        expect(thumbsBeforeLoss).toBe(0);
        expect(await bob.client.getThumbnailAsync(done[0] as FileRecord)).toBeInstanceOf(Blob);
    });

    it('makes its own thumbnail after the file arrives when the sender sends none (TH-04)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({ media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: false } }, { media: PHOTO_MEDIA });
        const thumbs = collect<string>(push => bob.client.on('thumb', fileId => push(fileId)));

        // Act
        await alice.client.sendFilesAsync([photo(4)]);
        await waitForAsync(() => thumbs.length === 1, 5000, 'own thumb');

        // Assert
        const ref = { sessionId: bob.client.peer?.sessionId ?? '', fileId: thumbs[0] ?? '' };
        expect(await bob.client.getThumbnailAsync(ref)).toBeInstanceOf(Blob);
        expect(await alice.client.getThumbnailAsync(ref)).toBeUndefined();
    });
});

describe('gallery and saving (§18.3, §18.4, §9)', () => {
    it('receives 50 photos with their metadata and groups them by date taken (test 6)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({ media: PHOTO_MEDIA }, { media: PHOTO_MEDIA });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const files = [...Array.from({ length: 50 }, (_, index) => photo(index)), createTestFile('notes.txt', 300, 9, 'text/plain')];

        // Act
        await alice.client.sendFilesAsync(files);
        await waitForAsync(() => done.length === 51, 20_000, 'all photos');
        const sessionId = bob.client.peer?.sessionId ?? '';
        const all = await bob.client.listGalleryAsync({ sessionId, filter: 'all', groupBy: 'day' });
        const photos = await bob.client.listGalleryAsync({ sessionId, filter: 'photos', groupBy: 'day' });
        const notSaved = await bob.client.listGalleryAsync({ sessionId, filter: 'not-saved', groupBy: 'day' });
        const sent = await alice.client.listGalleryAsync({ sessionId, direction: 'out', filter: 'all', groupBy: 'day' });

        // Assert
        expect(done.every(record => record.rootHash != null)).toBe(true);
        expect(done.find(record => record.name === 'IMG_1000.JPG')?.metadata).toMatchObject({ latitude: 37.97, longitude: 23.72 });
        expect(all.map(group => group.day)).toEqual([...new Set(all.map(group => group.day))]);
        expect(all.at(-1)?.day).toBe('no-date');
        expect(all.slice(0, -1).map(group => group.day)).toEqual(all.slice(0, -1).map(group => group.day).sort().reverse());
        expect(photos.flatMap(group => group.items)).toHaveLength(50);
        expect(notSaved.flatMap(group => group.items)).toHaveLength(51);
        expect(all.flatMap(group => group.items).every(item => item.status === 'received')).toBe(true);
        expect(sent.flatMap(group => group.items).every(item => item.status === 'sent')).toBe(true);
    }, 30_000);

    it('builds a ZIP from stored pages with the CRCs computed on arrival (SV-04)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const files = [createTestFile('a.bin', 2 * PAGE + 3, 701), createTestFile('b.bin', 10, 702)];
        await alice.client.sendFilesAsync(files, { relativePaths: ['Trip/Day 1/a.bin', undefined] });
        await waitForAsync(() => done.length === 2, 5000, 'done');

        // Act
        const zip = await bob.client.buildZipAsync(bob.client.peer?.sessionId ?? '', done.map(record => record.fileId));

        // Assert
        const bytes = await bytesOfAsync(zip);
        const text = new TextDecoder('latin1').decode(bytes);
        expect(text).toContain('Trip/Day 1/a.bin');
        expect(text).toContain('b.bin');
        const view = new DataView(bytes.buffer);
        const firstName = new TextDecoder().decode(bytes.subarray(30, 30 + view.getUint16(26, true)));
        const firstFile = firstName.endsWith('a.bin') ? files[0] : files[1];
        expect(view.getUint32(14, true)).toBe(crc32(await bytesOfAsync(firstFile as File)));
        expect(zip.size).toBeGreaterThan(2 * PAGE + 13);
    });

    it('assembles a received file with a safe name and its original date (RX-03, RX-05)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const file = new File([createTestFile('x', 3 * KIB, 801)], 'report: final?.pdf', { type: 'application/pdf', lastModified: 1_600_000_000_000 });

        // Act
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => done.length === 1, 5000, 'done');
        const received = await bob.client.getReceivedFileAsync(done[0] as FileRecord);

        // Assert
        expect(received.name).toBe('report_ final_.pdf');
        expect(received.type).toBe('application/pdf');
        expect(received.lastModified).toBe(1_600_000_000_000);
        expect(await bytesOfAsync(received)).toEqual(await bytesOfAsync(file));
    });

    it('marks files saved without deleting anything, and deletes many at once on request', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({}, { media: PHOTO_MEDIA });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const progress = collect<BatchProgress>(push => bob.client.on('batch-progress', push));
        await alice.client.sendFilesAsync([photo(7), photo(8), photo(9)]);
        await waitForAsync(() => done.length === 3, 5000, 'done');
        await waitForAsync(async () => (await bob.client.listFilesAsync({ sessionId: bob.client.peer?.sessionId ?? '' })).every(record => record.hasThumbnail), 5000, 'thumbs');
        const sessionId = bob.client.peer?.sessionId ?? '';
        const states = collect<FileRecord>(push => bob.client.on('file-state', push));

        // Act
        await bob.client.markSavedAsync(sessionId, done.map(record => record.fileId));
        await bob.client.markSavedAsync(sessionId, done.map(record => record.fileId));
        await new Promise(resolve => setTimeout(resolve, 100));
        const afterSave = await bob.client.listFilesAsync({ sessionId });
        const saved = await bob.client.listGalleryAsync({ sessionId, filter: 'all', groupBy: 'day' });
        const savedBytes = await bytesOfAsync(await bob.client.getReceivedFileAsync(done[0] as FileRecord));
        const missing = await bob.client.deleteReceivedManyAsync(sessionId, [done[0]?.fileId ?? '', '0'.repeat(32)]).catch((error: unknown) => error);
        const stillThere = await bob.client.listFilesAsync({ sessionId });
        await bob.client.deleteReceivedManyAsync(sessionId, [done[0]?.fileId ?? '', done[1]?.fileId ?? '']);

        // Assert
        expect(afterSave.every(record => record.savedAt != null && record.hasData)).toBe(true);
        expect(savedBytes).toHaveLength(done[0]?.size ?? 0);
        expect(progress.at(-1)).toMatchObject({ saved: 3, done: 3, total: 3 });
        expect(saved.flatMap(group => group.items).every(item => item.status === 'saved')).toBe(true);
        expect(missing).toMatchObject({ code: 'file-not-found' });
        expect(stillThere.every(record => record.hasData)).toBe(true);
        const records = await bob.client.listFilesAsync({ sessionId });
        expect(records.filter(record => !record.hasData).map(record => record.fileId).sort()).toEqual([done[0]?.fileId, done[1]?.fileId].sort());
        expect(records.every(record => record.state === 'done' && record.hasThumbnail)).toBe(true);
        expect(states.filter(record => !record.hasData)).toHaveLength(2);
        await expect(bob.client.getReceivedFileAsync(done[0] as FileRecord)).rejects.toMatchObject({ code: 'file-not-found' });
    });
});

describe('history and settings', () => {
    it('keeps settings across a reload and clears a session only when not connected to it', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        await alice.client.configureAsync({ pageSize: 2 * 1024 * KIB, keepHistoryDays: 30 });
        const sessionId = alice.client.peer?.sessionId ?? '';

        // Act
        const busy = await alice.client.clearSessionAsync(sessionId).catch((error: unknown) => error);
        await alice.client.disconnectAsync();
        await waitForAsync(() => bob.client.state === 'closed', 2000, 'bob closed');
        await alice.client.clearSessionAsync(sessionId);

        // Assert
        expect(busy).toMatchObject({ code: 'busy' });
        expect(alice.client.settings).toMatchObject({ pageSize: 2 * 1024 * KIB, keepHistoryDays: 30 });
        expect(await alice.client.listSessionsAsync()).toEqual([]);
        expect((await bob.client.listSessionsAsync())[0]?.connections[0]?.reason).toBe('peer left');
    });

    it('deletes partials older than Keep partial files with a notice', async () => {
        // Arrange
        let now = Date.UTC(2026, 10, 1);
        const clock = (): number => now;
        const hub = createFakeNetworkHub();
        const alice = await createTestDeviceAsync(hub, { name: 'Alice' });
        const bob = await createTestDeviceAsync(hub, { name: 'Bob', now: clock });
        devices.push(alice, bob);
        await pairAsync(alice, bob);
        let isDropped = false;
        hub.intercept(traffic => {
            if (!isDropped && traffic.kind === 'message' && traffic.message.t === 'ack') {
                isDropped = true;
                queueMicrotask(() => hub.dropLinks());
            }

            return undefined;
        });
        await alice.client.sendFilesAsync([createTestFile('old.bin', 4 * PAGE, 1001)]);
        await waitForAsync(() => bob.client.state === 'lost', 5000, 'lost');
        now += 3 * 24 * 60 * 60 * 1000;
        bob.client.dispose();
        const reopened = await createTestDeviceAsync(hub, { name: 'Bob', factory: bob.factory, now: clock });
        devices.push(reopened);
        const notices = collect<ClientNotice>(push => reopened.client.on('notice', push));
        const sessionId = (await reopened.client.listSessionsAsync())[0]?.sessionId ?? '';
        const before = await reopened.client.listFilesAsync({ sessionId });

        // Act
        await reopened.client.configureAsync({ keepPartialDays: 1 });
        await waitForAsync(() => notices.length > 0, 2000, 'notice');

        // Assert
        expect(before[0]).toMatchObject({ state: 'paused', hasData: false });
        expect(before[0]?.pagination?.pagesDone).toBeGreaterThanOrEqual(1);
        expect(notices).toEqual([{ kind: 'partials-expired', count: 1 }]);
        const records = await reopened.client.listFilesAsync({ sessionId });
        expect(records[0]).toMatchObject({ state: 'canceled', note: 'partial-expired', hasData: false });
        expect(records[0]?.pagination).toBeUndefined();
    });
});
