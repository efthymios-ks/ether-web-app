import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { PAGE, bytesOfAsync, createTestDeviceAsync, createTestFile, delayWritesTo, messages, pairAsync, reopenDeviceAsync, waitForAsync } from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import type { BatchRecord, Direction, FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetwork, FakeNetworkHub } from './fakeNetwork.js';
import { computeFileIdAsync } from './hashing.js';
import { createClientStorage } from './storage.js';

// Delete what arrived: one call cancels the rest of a batch on both devices and deletes the partial files,
// and picking the same files again skips the finished ones and sends the rest in full.
// Stop, which keeps what arrived, is in clientStopResume.test.ts.

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

interface Pair {
    readonly hub: FakeNetworkHub;
    readonly alice: TestDevice;
    readonly bob: TestDevice;
    readonly sessionId: string;
    readonly aliceDone: FileRecord[];
    readonly bobDone: FileRecord[];
}

async function pairedAsync(aliceOptions: Partial<TestDeviceOptions> = {}, bobOptions: Partial<TestDeviceOptions> = {}): Promise<Pair> {
    const hub = createFakeNetworkHub();
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', ...aliceOptions });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob', ...bobOptions });
    devices.push(alice, bob);
    await pairAsync(alice, bob);
    const aliceDone: FileRecord[] = [];
    const bobDone: FileRecord[] = [];
    alice.client.on('file-done', record => aliceDone.push(record));
    bob.client.on('file-done', record => bobDone.push(record));

    return { hub, alice, bob, sessionId: alice.client.peer?.sessionId ?? '', aliceDone, bobDone };
}

interface Picked {
    readonly files: File[];
    readonly paths: string[];
}

// New File objects each call, as a second pick of the same folder gives; `sizes` in pages, one page each by default.
function pick(count: number, seed: number, pagesOf: (index: number) => number = () => 1): Picked {
    const files = Array.from({ length: count }, (_, index) => {
        const name = `f${String(index + 1).padStart(2, '0')}.bin`;

        return createTestFile(name, pagesOf(index) * PAGE - 3, seed + index);
    });

    return { files, paths: files.map(file => `Set/${file.name}`) };
}

async function batchOfAsync(device: TestDevice, sessionId: string, batchId: string): Promise<BatchRecord | undefined> {
    return (await device.client.listBatchesAsync(sessionId)).find(batch => batch.batchId === batchId);
}

async function filesOfAsync(device: TestDevice, sessionId: string, batchId: string, direction: Direction): Promise<FileRecord[]> {
    return (await device.client.listFilesAsync({ sessionId, direction })).filter(record => record.batchId === batchId);
}

// The receiver's stored pages of one file, read straight from its database.
async function storedPagesAsync(device: TestDevice, sessionId: string, fileId: string): Promise<number> {
    return (await createClientStorage(device.database).readPagesAsync(sessionId, fileId)).length;
}

function countsAddUp(batch: BatchRecord | undefined): boolean {
    return batch != null && batch.received + batch.failed + batch.canceled === batch.itemCount;
}

// Calls `stop` once, from inside the network, as soon as the receiver acknowledges `page` of a file it is
// still receiving (with at least `doneFirst` files finished), so a file is mid-way when Stop is pressed.
function stopMidFile(hub: FakeNetworkHub, stop: () => Promise<number>, options: { readonly page: number; readonly fileId?: string; readonly isReady?: () => boolean }): {
    readonly stopping: () => Promise<number> | undefined;
    readonly isStopped: () => boolean;
} {
    let stopping: Promise<number> | undefined;
    hub.intercept(entry => {
        if (
            stopping == null
            && entry.kind === 'message'
            && entry.message.t === 'ack'
            && entry.message.page === options.page
            && (options.fileId == null || entry.message.fileId === options.fileId)
            && (options.isReady?.() ?? true)
        ) {
            stopping = stop();
        }

        return undefined;
    });

    return { stopping: () => stopping, isStopped: () => stopping != null };
}

describe('cancelBatchAsync', () => {
    it.each<{ readonly side: Direction }>([{ side: 'out' }, { side: 'in' }])(
        'cancels a 50-file batch from the $side side: nothing starts after, both sides end canceled with partials deleted, both batches finish',
        async ({ side }) => {
            // Arrange
            const { hub, alice, bob, sessionId, bobDone } = await pairedAsync();
            hub.delayMs = 1;
            const picked = pick(50, 4001, () => 3);
            const stopper = side === 'out' ? alice : bob;
            let batchId = '';
            const offersAfterStop: string[] = [];
            const startedAfterStop: string[] = [];
            // Each device stops when it handles the cancel: the pressing one at the call, the other when cancel-batch
            // reaches it; what the other sent or began before then is in flight, not started after.
            let isCalled = false;
            const control = stopMidFile(hub, () => {
                isCalled = true;

                return stopper.client.cancelBatchAsync(sessionId, batchId, side);
            }, { page: 1, isReady: () => bobDone.length >= 5 });
            const hasHandled = (device: TestDevice, peerName: string): boolean => messages(device).some(message => message.includes(`canceled by ${peerName}`));
            const hasSenderStopped = (): boolean => (side === 'out' ? isCalled : hasHandled(alice, 'Bob'));
            const hasReceiverStopped = (): boolean => (side === 'in' ? isCalled : hasHandled(bob, 'Alice'));
            hub.intercept(entry => {
                if (entry.kind === 'message' && (entry.message.t === 'offer' || entry.message.t === 'offer-batch') && hasSenderStopped()) {
                    offersAfterStop.push(entry.message.t);
                }

                return undefined;
            });
            // A start is a file's first active state; moving files report active until the Stop closes them.
            const seenActive = new Set<string>();
            bob.client.on('file-state', record => {
                if (record.state !== 'active' || seenActive.has(record.fileId)) {
                    return;
                }

                seenActive.add(record.fileId);
                if (hasReceiverStopped()) {
                    startedAfterStop.push(record.name);
                }
            });

            // Act
            batchId = (await alice.client.sendFilesAsync(picked.files, { relativePaths: picked.paths })).batchId;
            await waitForAsync(() => control.isStopped(), 10_000, 'stop pressed');
            const stopped = await control.stopping();
            await waitForAsync(async () => (await batchOfAsync(alice, sessionId, batchId))?.finishedAt != null
                && (await batchOfAsync(bob, sessionId, batchId))?.finishedAt != null, 5000, 'both batches finished');
            await new Promise(resolve => setTimeout(resolve, 200));

            // Assert
            expect(stopped).toBeGreaterThan(0);
            expect(offersAfterStop).toEqual([]);
            expect(startedAfterStop).toEqual([]);
            const sent = await filesOfAsync(alice, sessionId, batchId, 'out');
            const received = await filesOfAsync(bob, sessionId, batchId, 'in');
            expect(sent.every(record => record.state === 'done' || record.state === 'canceled')).toBe(true);
            expect(received.every(record => record.state === 'done' || record.state === 'canceled')).toBe(true);
            const canceledHere = received.filter(record => record.state === 'canceled');
            expect(canceledHere.length).toBeGreaterThan(0);
            expect(canceledHere.every(record => record.pagination == null && !record.hasData)).toBe(true);
            expect(sent.filter(record => record.state === 'canceled').every(record => record.pagination == null)).toBe(true);
            const leftPages = await Promise.all(canceledHere.map(record => storedPagesAsync(bob, sessionId, record.fileId)));
            expect(leftPages.every(count => count === 0)).toBe(true);
            const aliceBatch = await batchOfAsync(alice, sessionId, batchId);
            const bobBatch = await batchOfAsync(bob, sessionId, batchId);
            expect(aliceBatch).toMatchObject({ itemCount: 50, failed: 0 });
            expect(bobBatch).toMatchObject({ itemCount: 50, failed: 0 });
            expect(countsAddUp(aliceBatch)).toBe(true);
            expect(countsAddUp(bobBatch)).toBe(true);
            expect(aliceBatch?.received).toBe(sent.filter(record => record.state === 'done').length);
            expect(bobBatch?.received).toBe(received.filter(record => record.state === 'done').length);
            expect(aliceBatch?.canceled).toBeGreaterThan(0);

            // Act: both devices reload
            const reopenedAlice = await reopenDeviceAsync(hub, alice);
            const reopenedBob = await reopenDeviceAsync(hub, bob);
            devices.push(reopenedAlice, reopenedBob);

            // Assert
            expect(await batchOfAsync(reopenedAlice, sessionId, batchId)).toEqual(aliceBatch);
            expect(await batchOfAsync(reopenedBob, sessionId, batchId)).toEqual(bobBatch);
        },
        20_000,
    );

    it('accepts nothing once the receiver deletes what arrived, even while it is writing the record of a file it is starting', async () => {
        // Arrange
        // The receiver's record write for a starting file takes 30 ms; Stop lands 10 ms after that file's offer.
        const { hub, alice, bob, sessionId, bobDone } = await pairedAsync({ settings: { maxConcurrentFiles: 1 } }, { wrapDatabase: delayWritesTo(['files', 'pages'], 30) });
        const picked = pick(6, 4401);
        let batchId = '';
        let stopping: Promise<number> | undefined;
        let isCalled = false;
        const acceptsAfterStop: string[] = [];
        hub.intercept(entry => {
            if (entry.kind !== 'message') {
                return undefined;
            }

            if (entry.message.t === 'accept' && isCalled) {
                acceptsAfterStop.push(entry.message.fileId as string);
            }

            if (entry.message.t === 'offer' && bobDone.length >= 2 && stopping == null) {
                stopping = new Promise<number>(resolve => setTimeout(() => {
                    isCalled = true;
                    resolve(bob.client.cancelBatchAsync(sessionId, batchId, 'in'));
                }, 10));
            }

            return undefined;
        });

        // Act
        batchId = (await alice.client.sendFilesAsync(picked.files, { relativePaths: picked.paths })).batchId;
        await waitForAsync(() => stopping != null, 5000, 'stop scheduled');
        await stopping;
        await waitForAsync(async () => (await batchOfAsync(alice, sessionId, batchId))?.finishedAt != null
            && (await batchOfAsync(bob, sessionId, batchId))?.finishedAt != null, 5000, 'both batches finished');

        // Assert
        expect(acceptsAfterStop).toEqual([]);
        const received = await filesOfAsync(bob, sessionId, batchId, 'in');
        expect(received.every(record => record.state === 'done' || record.state === 'canceled')).toBe(true);
        expect(countsAddUp(await batchOfAsync(bob, sessionId, batchId))).toBe(true);
        expect(countsAddUp(await batchOfAsync(alice, sessionId, batchId))).toBe(true);
    });

    it('sends no offer once the sender deletes what arrived, even for a file given a slot just before', async () => {
        // Arrange
        // The sender's record writes take 30 ms, so a file that got its slot waits that long before its offer goes;
        // Stop is pressed as soon as the third file gets its slot, inside that wait.
        const { hub, alice, sessionId } = await pairedAsync({ settings: { maxConcurrentFiles: 1 }, wrapDatabase: delayWritesTo('files', 30) });
        const picked = pick(6, 4501);
        let batchId = '';
        let stopping: Promise<number> | undefined;
        let isCalled = false;
        const offersAfterStop: string[] = [];
        hub.intercept(entry => {
            if (entry.kind === 'message' && entry.message.t === 'offer' && isCalled) {
                offersAfterStop.push(entry.message.name as string);
            }

            return undefined;
        });
        const watch = setInterval(() => {
            if (stopping == null && messages(alice).filter(message => / slot \d assigned$/.test(message)).length >= 3) {
                isCalled = true;
                stopping = alice.client.cancelBatchAsync(sessionId, batchId, 'out');
            }
        }, 1);

        // Act
        batchId = (await alice.client.sendFilesAsync(picked.files, { relativePaths: picked.paths })).batchId;
        await waitForAsync(() => stopping != null, 5000, 'stop pressed');
        clearInterval(watch);
        const stopped = await stopping;
        await waitForAsync(async () => (await batchOfAsync(alice, sessionId, batchId))?.finishedAt != null, 5000, 'finished');

        // Assert
        expect(stopped).toBeGreaterThan(0);
        expect(offersAfterStop).toEqual([]);
        expect(countsAddUp(await batchOfAsync(alice, sessionId, batchId))).toBe(true);
    });

    it('counts a single canceled file toward finishing its batch', async () => {
        // Arrange
        const { hub, alice, sessionId, aliceDone } = await pairedAsync({ settings: { maxConcurrentFiles: 1 } });
        hub.delayMs = 1;
        const picked = pick(3, 4101, index => (index === 2 ? 6 : 1));
        const batch = await alice.client.sendFilesAsync(picked.files, { relativePaths: picked.paths });
        await waitForAsync(() => aliceDone.length === 2, 5000, 'two done');
        const last = (await filesOfAsync(alice, sessionId, batch.batchId, 'out')).find(record => record.name === 'f03.bin') as FileRecord;

        // Act
        await alice.client.cancelAsync(last);

        // Assert
        await waitForAsync(async () => (await batchOfAsync(alice, sessionId, batch.batchId))?.finishedAt != null, 5000, 'finished');
        expect(await batchOfAsync(alice, sessionId, batch.batchId)).toMatchObject({ received: 2, failed: 0, canceled: 1 });
    });

    it('rejects a batch this device does not have', async () => {
        // Arrange
        const { alice, sessionId } = await pairedAsync();

        // Act
        const result = await alice.client.cancelBatchAsync(sessionId, 'no-such-batch', 'out').catch((error: unknown) => error);

        // Assert
        expect(result).toMatchObject({ code: 'file-not-found' });
    });
});

describe('picking the same files again after Delete what arrived', () => {
    it.each<{ readonly side: Direction }>([{ side: 'out' }, { side: 'in' }])(
        'skips the finished files when picked again after a delete from the $side side, and sends the canceled one and the rest in full',
        async ({ side }) => {
            // Arrange
            const { hub, alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync({ settings: { maxConcurrentFiles: 1 } });
            hub.delayMs = 1;
            const pagesOf = (index: number): number => (index === 7 ? 24 : 1);
            const first = pick(20, 4201, pagesOf);
            const eighthId = await computeFileIdAsync(first.files[7] as File, first.paths[7] as string);
            const stopper = side === 'out' ? alice : bob;
            let batchId = '';
            const control = stopMidFile(hub, () => stopper.client.cancelBatchAsync(sessionId, batchId, side), { page: 1, fileId: eighthId });
            batchId = (await alice.client.sendFilesAsync(first.files, { relativePaths: first.paths })).batchId;
            await waitForAsync(() => control.isStopped(), 10_000, 'stop pressed');
            await control.stopping();
            await waitForAsync(async () => (await batchOfAsync(alice, sessionId, batchId))?.finishedAt != null
                && (await batchOfAsync(bob, sessionId, batchId))?.finishedAt != null, 5000, 'stopped batches finished');
            await new Promise(resolve => setTimeout(resolve, 200));
            const stoppedBatches = [await batchOfAsync(alice, sessionId, batchId), await batchOfAsync(bob, sessionId, batchId)];
            const eighth = (await bob.client.listFilesAsync({ sessionId, direction: 'in' })).find(record => record.fileId === eighthId);
            const pagesLeft = await storedPagesAsync(bob, sessionId, eighthId);
            const pagesSent = new Map<string, number>();
            hub.intercept(entry => {
                if (entry.kind === 'message' && entry.message.t === 'page-end') {
                    const fileId = entry.message.fileId as string;
                    pagesSent.set(fileId, (pagesSent.get(fileId) ?? 0) + 1);
                }

                return undefined;
            });
            const doneBefore = aliceDone.length;
            const second = pick(20, 4201, pagesOf);

            // Act
            const again = await alice.client.sendFilesAsync(second.files, { relativePaths: second.paths });
            await waitForAsync(() => aliceDone.length === doneBefore + 20, 10_000, 'second pick');
            await waitForAsync(async () => (await batchOfAsync(bob, sessionId, again.batchId))?.finishedAt != null, 5000, 'receiver batch finished');

            // Assert
            expect(eighth).toMatchObject({ state: 'canceled', hasData: false });
            expect(eighth?.pagination).toBeUndefined();
            expect(pagesLeft).toBe(0);
            const secondRound = aliceDone.slice(doneBefore);
            const skipped = secondRound.filter(record => record.note === 'already-on-peer').map(record => record.name).sort();
            expect(skipped).toEqual(['f01.bin', 'f02.bin', 'f03.bin', 'f04.bin', 'f05.bin', 'f06.bin', 'f07.bin']);
            expect(pagesSent.get(eighthId)).toBe(24);
            const ids = await Promise.all(second.files.map((file, index) => computeFileIdAsync(file, second.paths[index] as string)));
            expect(ids.slice(8).every(fileId => pagesSent.get(fileId) === 1)).toBe(true);
            expect(ids.slice(0, 7).every(fileId => !pagesSent.has(fileId))).toBe(true);
            expect([...pagesSent.values()].reduce((sum, pages) => sum + pages, 0)).toBe(24 + 12);
            const received = await bob.client.listFilesAsync({ sessionId, direction: 'in' });
            expect(received).toHaveLength(20);
            expect(received.every(record => record.state === 'done' && record.hasData)).toBe(true);
            const resumed = received.find(record => record.fileId === eighthId) as FileRecord;
            expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(resumed))).toEqual(await bytesOfAsync(second.files[7] as File));
            expect((await alice.client.listFilesAsync({ sessionId, direction: 'out' }))).toHaveLength(20);
            expect([await batchOfAsync(alice, sessionId, batchId), await batchOfAsync(bob, sessionId, batchId)]).toEqual(stoppedBatches);
            expect(countsAddUp(await batchOfAsync(alice, sessionId, again.batchId))).toBe(true);
            expect(countsAddUp(await batchOfAsync(bob, sessionId, again.batchId))).toBe(true);
            expect(bobDone.length).toBeGreaterThan(0);
        },
        20_000,
    );
});

describe('cancelAsync', () => {
    it('deletes the receiver\'s partial on a cancel from the sender, even one asking to keep it', async () => {
        // Arrange
        const { hub, alice, bob, sessionId } = await pairedAsync();
        hub.delayMs = 1;
        const file = createTestFile('long.bin', 24 * PAGE, 4301);
        const fileId = await computeFileIdAsync(file, file.name);
        let aliceNetwork: FakeNetwork | undefined;
        let isMidWay = false;
        hub.intercept(entry => {
            if (entry.kind === 'message' && entry.message.t === 'offer') {
                aliceNetwork = entry.from;
            }

            if (entry.kind === 'message' && entry.message.t === 'ack' && entry.message.fileId === fileId && entry.message.page === 1) {
                isMidWay = true;
            }

            return undefined;
        });
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => isMidWay, 5000, 'two pages in');

        // Act
        aliceNetwork?.send(1, { t: 'cancel', fileId, direction: 'out', keepPartial: true, reason: 'canceled' });
        await waitForAsync(async () => (await bob.client.listFilesAsync({ sessionId, direction: 'in' }))[0]?.state === 'canceled', 5000, 'canceled');
        await new Promise(resolve => setTimeout(resolve, 100));

        // Assert
        const record = (await bob.client.listFilesAsync({ sessionId, direction: 'in' }))[0];
        expect(record).toMatchObject({ state: 'canceled', hasData: false });
        expect(record?.pagination).toBeUndefined();
        expect(await storedPagesAsync(bob, sessionId, fileId)).toBe(0);
    });
});
