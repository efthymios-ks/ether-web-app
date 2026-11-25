import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { STORE, requestAsync } from '../core/database.js';
import {
    PAGE,
    PHOTO_MEDIA,
    createTestDeviceAsync,
    createTestFile,
    pairAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice } from './clientHarness.js';
import type { ClearScope, FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';
import { computeFileIdAsync } from './hashing.js';

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

function collect<Item>(subscribe: (push: (item: Item) => void) => void): Item[] {
    const items: Item[] = [];
    subscribe(item => items.push(item));

    return items;
}

interface Pair {
    readonly hub: FakeNetworkHub;
    readonly alice: TestDevice;
    readonly bob: TestDevice;
    readonly sessionId: string;
    readonly aliceDone: FileRecord[];
    readonly bobDone: FileRecord[];
}

// Alice and Bob paired, one finished file each way: a1.bin to Bob, b1.jpg (with a thumbnail) to Alice.
async function pairWithHistoryAsync(): Promise<Pair> {
    const hub = createFakeNetworkHub();
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', media: PHOTO_MEDIA });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob', media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true } });
    devices.push(alice, bob);
    await pairAsync(alice, bob);
    const aliceDone = collect<FileRecord>(push => alice.client.on('file-done', push));
    const bobDone = collect<FileRecord>(push => bob.client.on('file-done', push));
    await alice.client.sendFilesAsync([createTestFile('a1.bin', 1000, 1701)]);
    await bob.client.sendFilesAsync([createTestFile('b1.jpg', 2000, 1702, 'image/jpeg')]);
    await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 5000, 'history');
    await waitForAsync(async () => (await alice.client.listFilesAsync({ sessionId: alice.client.peer?.sessionId ?? '', direction: 'in' }))[0]?.hasThumbnail === true, 2000, 'thumbnail');

    return { hub, alice, bob, sessionId: alice.client.peer?.sessionId ?? '', aliceDone, bobDone };
}

// Starts a large file each way and resolves once both have their first page acknowledged.
async function startTransfersEachWayAsync(pair: Pair): Promise<{ readonly fromAlice: File; readonly fromBob: File }> {
    const fromAlice = createTestFile('a2.bin', 16 * PAGE, 1711);
    const fromBob = createTestFile('b2.bin', 16 * PAGE, 1712);
    const ids = new Set([await computeFileIdAsync(fromAlice, fromAlice.name), await computeFileIdAsync(fromBob, fromBob.name)]);
    const acked = new Set<string>();
    pair.hub.delayMs = 2;
    const bothMoving = new Promise<void>(resolve => {
        pair.hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'ack' && ids.has(traffic.message.fileId as string)) {
                acked.add(traffic.message.fileId as string);
                if (acked.size === 2) {
                    resolve();
                }
            }

            return undefined;
        });
    });
    await pair.alice.client.sendFilesAsync([fromAlice]);
    await pair.bob.client.sendFilesAsync([fromBob]);
    await bothMoving;

    return { fromAlice, fromBob };
}

async function pageCountAsync(device: TestDevice, sessionId: string): Promise<number> {
    const transaction = device.database.transaction(STORE.pages, 'readonly');

    return requestAsync(transaction.objectStore(STORE.pages).count(IDBKeyRange.bound([sessionId], [sessionId, []])));
}

async function filesAsync(device: TestDevice, sessionId: string): Promise<FileRecord[]> {
    return device.client.listFilesAsync({ sessionId });
}

describe('clearing a session\'s files', () => {
    it('counts what each scope would remove', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await pair.alice.client.disconnectAsync();
        const queued = collect<FileRecord>(push => pair.alice.client.on('file-queued', push));
        await pair.alice.client.sendFilesAsync([createTestFile('later.bin', 500, 1721)]);
        await waitForAsync(() => queued.length === 1, 2000, 'queued');

        // Act
        const summaries = await Promise.all((['sent', 'received', 'all'] as const).map(scope => pair.alice.client.getClearSummaryAsync(pair.sessionId, scope)));

        // Assert
        expect(summaries).toEqual([
            { finished: 1, unfinished: 1, notDownloaded: 0, bytes: 1500 },
            { finished: 1, unfinished: 0, notDownloaded: 1, bytes: 2000 },
            { finished: 2, unfinished: 1, notDownloaded: 1, bytes: 3500 },
        ]);
    });

    it('clears sent files while connected and lets running transfers finish', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        const cleared = collect<{ readonly sessionId: string; readonly scope: ClearScope }>(push => pair.alice.client.on('session-cleared', (sessionId, scope) => push({ sessionId, scope })));
        const { fromAlice, fromBob } = await startTransfersEachWayAsync(pair);

        // Act
        const result = await pair.alice.client.clearSessionFilesAsync(pair.sessionId, { scope: 'sent' });
        await waitForAsync(() => pair.bobDone.some(record => record.name === fromAlice.name)
            && pair.aliceDone.some(record => record.name === fromBob.name && record.direction === 'in'), 15_000, 'both finish');

        // Assert
        expect(result).toEqual({ removed: 1 });
        expect(cleared).toEqual([{ sessionId: pair.sessionId, scope: 'sent' }]);
        const files = await filesAsync(pair.alice, pair.sessionId);
        expect(files.filter(file => file.direction === 'out').map(file => file.name)).toEqual(['a2.bin']);
        expect(files.filter(file => file.direction === 'in').map(file => file.name).sort()).toEqual(['b1.jpg', 'b2.bin']);
        expect(pair.alice.client.state).toBe('connected');
        // The totals are written just after the file events.
        await waitForAsync(async () => (await pair.alice.client.getSessionAsync(pair.sessionId))?.totals.filesSent === 1, 2000, 'totals');
        const session = await pair.alice.client.getSessionAsync(pair.sessionId);
        expect(session).toMatchObject({ peerName: 'Bob', connected: true });
        expect(session?.connections).toHaveLength(1);
        expect(session?.totals).toMatchObject({ filesSent: 1, filesReceived: 2 });
    }, 30_000);

    it('clears everything while connected, stopping both transfers cleanly, and sends again afterwards', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await startTransfersEachWayAsync(pair);
        const bobStates = collect<FileRecord>(push => pair.bob.client.on('file-state', push));

        // Act
        const result = await pair.alice.client.clearSessionFilesAsync(pair.sessionId, { scope: 'all' });
        await waitForAsync(() => bobStates.filter(record => record.state === 'canceled').length >= 2, 5000, 'Bob stops');
        pair.hub.delayMs = 0;
        await pair.alice.client.sendFilesAsync([createTestFile('a3.bin', 2 * PAGE, 1731)]);
        await pair.bob.client.sendFilesAsync([createTestFile('b3.bin', 2 * PAGE, 1732)]);
        await waitForAsync(() => pair.bobDone.some(record => record.name === 'a3.bin')
            && pair.aliceDone.some(record => record.name === 'b3.bin' && record.direction === 'in'), 10_000, 'sent again');

        // Assert
        expect(result.removed).toBe(4);
        const canceledOnBob = bobStates.filter(record => record.state === 'canceled').map(record => `${record.direction}:${record.name}`);
        expect(canceledOnBob).toEqual(expect.arrayContaining(['in:a2.bin', 'out:b2.bin']));
        expect((await filesAsync(pair.alice, pair.sessionId)).map(file => file.name).sort()).toEqual(['a3.bin', 'b3.bin']);
        await expect(pair.alice.client.getThumbnailAsync({ sessionId: pair.sessionId, fileId: pair.aliceDone[1]?.fileId ?? '' })).rejects.toMatchObject({ code: 'file-not-found' });
        expect(await pageCountAsync(pair.alice, pair.sessionId)).toBe(2);
        expect((await pair.alice.client.listBatchesAsync(pair.sessionId)).length).toBe(2);
    }, 30_000);

    it('cancels a file still arriving when received files are cleared with includeUnfinished', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await startTransfersEachWayAsync(pair);
        const bobStates = collect<FileRecord>(push => pair.bob.client.on('file-state', push));

        // Act
        const result = await pair.alice.client.clearSessionFilesAsync(pair.sessionId, { scope: 'received', includeUnfinished: true });
        await waitForAsync(() => bobStates.some(record => record.direction === 'out' && record.name === 'b2.bin' && record.state === 'canceled'), 5000, 'Bob stops sending');
        await waitForAsync(() => pair.bobDone.some(record => record.name === 'a2.bin'), 15_000, 'Alice keeps sending');

        // Assert
        expect(result).toEqual({ removed: 2 });
        const files = await filesAsync(pair.alice, pair.sessionId);
        expect(files.every(file => file.direction === 'out')).toBe(true);
        expect(await pageCountAsync(pair.alice, pair.sessionId)).toBe(0);
        const bobOut = (await filesAsync(pair.bob, pair.sessionId)).find(record => record.name === 'b2.bin');
        expect(bobOut).toMatchObject({ state: 'canceled' });
        expect(bobOut?.pagination).toBeUndefined();
    }, 30_000);

    it('clears while not connected and leaves the session and its connection log', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await pair.alice.client.disconnectAsync();

        // Act
        const result = await pair.alice.client.clearSessionFilesAsync(pair.sessionId, { scope: 'all' });

        // Assert
        expect(result).toEqual({ removed: 2 });
        expect(await filesAsync(pair.alice, pair.sessionId)).toEqual([]);
        expect(await pair.alice.client.listBatchesAsync(pair.sessionId)).toEqual([]);
        expect(await pageCountAsync(pair.alice, pair.sessionId)).toBe(0);
        const session = await pair.alice.client.getSessionAsync(pair.sessionId);
        expect(session).toMatchObject({ peerName: 'Bob', unfinishedCount: 0, totals: { filesSent: 0, bytesSent: 0, filesReceived: 0, bytesReceived: 0 } });
        expect(session?.connections[0]?.end).toBeTypeOf('number');
    });

    it('never touches another session', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await pair.alice.client.disconnectAsync();
        const carol = await createTestDeviceAsync(pair.hub, { name: 'Carol', media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true } });
        devices.push(carol);
        await pairAsync(carol, pair.alice);
        const carolSession = pair.alice.client.peer?.sessionId ?? '';
        await carol.client.sendFilesAsync([createTestFile('b1.jpg', 2000, 1702, 'image/jpeg')]);
        await waitForAsync(() => pair.aliceDone.filter(record => record.sessionId === carolSession).length === 1, 5000, 'from Carol');
        await waitForAsync(async () => (await filesAsync(pair.alice, carolSession))[0]?.hasThumbnail === true, 2000, 'thumbnail');

        // Act
        await pair.alice.client.clearSessionFilesAsync(pair.sessionId, { scope: 'all' });

        // Assert
        const fromCarol = await filesAsync(pair.alice, carolSession);
        expect(fromCarol).toEqual([expect.objectContaining({ name: 'b1.jpg', state: 'done', hasData: true, hasThumbnail: true })]);
        expect(await pair.alice.client.getThumbnailAsync(fromCarol[0] as FileRecord)).toBeInstanceOf(Blob);
        expect(await pageCountAsync(pair.alice, carolSession)).toBe(1);
        expect(await filesAsync(pair.alice, pair.sessionId)).toEqual([]);
    });
});
