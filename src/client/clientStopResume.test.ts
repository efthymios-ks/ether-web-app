import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PAGE,
    bytesOfAsync,
    countLogs,
    createTestDeviceAsync,
    createTestFile,
    dropWhenPartialAsync,
    messages,
    pairAsync,
    reopenDeviceAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import type { BatchRecord, Direction, FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';
import { computeFileIdAsync } from './hashing.js';
import { createClientStorage } from './storage.js';
import type { StoredFile } from './storage.js';

// Stop keeps what arrived on both devices: nothing moves again until Resume, not even after a reconnect, and
// Resume, or picking the file again, continues from the receiver's saved pages. Every resume sends the receiver's
// last saved page again, and its new copy replaces the stored one.

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

async function pairedAsync(aliceOptions: Partial<TestDeviceOptions> = {}): Promise<Pair> {
    const hub = createFakeNetworkHub();
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', settings: { maxConcurrentFiles: 1 }, ...aliceOptions });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob' });
    devices.push(alice, bob);
    await pairAsync(alice, bob);
    hub.delayMs = 1;
    const aliceDone: FileRecord[] = [];
    const bobDone: FileRecord[] = [];
    alice.client.on('file-done', record => aliceDone.push(record));
    bob.client.on('file-done', record => bobDone.push(record));

    return { hub, alice, bob, sessionId: alice.client.peer?.sessionId ?? '', aliceDone, bobDone };
}

async function reopenAsync(hub: FakeNetworkHub, device: TestDevice): Promise<TestDevice> {
    const reopened = await reopenDeviceAsync(hub, device);
    devices.push(reopened);

    return reopened;
}

interface Picked {
    readonly files: File[];
    readonly paths: string[];
}

// One page, `longPages` pages, one page: a Stop in the long file finds one file done, one part-way, one not started.
// New File objects each call, as a second pick of the same folder gives.
function pick(seed: number, longPages = 12): Picked {
    const sizes = [PAGE - 3, longPages * PAGE - 5, PAGE - 7];
    const files = sizes.map((size, index) => createTestFile(`f${index + 1}.bin`, size, seed + index));

    return { files, paths: files.map(file => `Set/${file.name}`) };
}

async function idsOfAsync(picked: Picked): Promise<string[]> {
    return Promise.all(picked.files.map((file, index) => computeFileIdAsync(file, picked.paths[index] as string)));
}

async function recordOfAsync(
    device: TestDevice,
    sessionId: string,
    fileId: string,
    direction: Direction,
): Promise<FileRecord | undefined> {
    return (await device.client.listFilesAsync({ sessionId, direction })).find(record => record.fileId === fileId);
}

async function filesOfAsync(
    device: TestDevice,
    sessionId: string,
    batchId: string,
    direction: Direction,
): Promise<FileRecord[]> {
    return (await device.client.listFilesAsync({ sessionId, direction })).filter(record => record.batchId === batchId);
}

async function batchOfAsync(device: TestDevice, sessionId: string, batchId: string): Promise<BatchRecord | undefined> {
    return (await device.client.listBatchesAsync(sessionId)).find(batch => batch.batchId === batchId);
}

async function storedRecordAsync(
    device: TestDevice,
    sessionId: string,
    fileId: string,
    direction: Direction,
): Promise<StoredFile | undefined> {
    return createClientStorage(device.database).getFileAsync(sessionId, fileId, direction);
}

async function storedPagesAsync(device: TestDevice, sessionId: string, fileId: string): Promise<number> {
    return (await createClientStorage(device.database).readPagesAsync(sessionId, fileId)).length;
}

function isStopped(record: FileRecord | undefined): boolean {
    return record?.state === 'paused' && record.pausedBy === 'stop';
}

function pauseAsync(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Presses `stop` once, from inside the network, as soon as the receiver acknowledges `page` of `fileId`.
function stopAtPage(
    hub: FakeNetworkHub,
    fileId: string,
    page: number,
    stop: () => Promise<number>,
): () => Promise<number> | undefined {
    let stopping: Promise<number> | undefined;
    hub.intercept(entry => {
        const isThePage = entry.kind === 'message' && entry.message.t === 'ack' && entry.message.fileId === fileId
            && entry.message.page === page;
        if (stopping == null && isThePage) {
            stopping = stop();
        }

        return undefined;
    });

    return () => stopping;
}

// The page index of every page-end from now on, per file, in the order they go.
function watchPages(hub: FakeNetworkHub): Map<string, number[]> {
    const pages = new Map<string, number[]>();
    hub.intercept(entry => {
        if (entry.kind === 'message' && entry.message.t === 'page-end') {
            const fileId = entry.message.fileId as string;
            pages.set(fileId, [...(pages.get(fileId) ?? []), entry.message.page as number]);
        }

        return undefined;
    });

    return pages;
}

async function bothStoppedAsync(pair: Pair, fileId: string): Promise<void> {
    await waitForAsync(async () => isStopped(await recordOfAsync(pair.alice, pair.sessionId, fileId, 'out'))
        && isStopped(await recordOfAsync(pair.bob, pair.sessionId, fileId, 'in')), 5000, 'stopped on both devices');
}

// Sends the three files and stops their batch from `side` once three pages of the long one are saved.
async function sendAndStopAsync(pair: Pair, side: Direction, picked: Picked): Promise<{ readonly batchId: string; readonly stopped: number }> {
    const [, longId] = await idsOfAsync(picked);
    const stopper = side === 'out' ? pair.alice : pair.bob;
    let batchId = '';
    const stopping = stopAtPage(pair.hub, longId as string, 2, () => stopper.client.stopBatchAsync(pair.sessionId, batchId, side));
    batchId = (await pair.alice.client.sendFilesAsync(picked.files, { relativePaths: picked.paths })).batchId;
    await waitForAsync(() => stopping() != null, 10_000, 'stop pressed');
    const stopped = await stopping() ?? 0;
    await bothStoppedAsync(pair, longId as string);

    return { batchId, stopped };
}

describe('stopBatchAsync and resumeBatchAsync', () => {
    it.each<{ readonly side: Direction }>([{ side: 'out' }, { side: 'in' }])(
        'stops from the $side side keeping what arrived on both devices, and Resume continues from the last saved page',
        async ({ side }) => {
            // Arrange
            const pair = await pairedAsync();
            const { alice, bob, sessionId, bobDone } = pair;
            const picked = pick(5101);
            const [, longId] = await idsOfAsync(picked) as [string, string, string];
            const { batchId, stopped } = await sendAndStopAsync(pair, side, picked);
            const pages = watchPages(pair.hub);
            await pauseAsync(300);
            const whileStopped = {
                moved: pages.size,
                sent: (await filesOfAsync(alice, sessionId, batchId, 'out')).map(record => `${record.name} ${record.state} ${record.pausedBy ?? ''}`),
                received: (await filesOfAsync(bob, sessionId, batchId, 'in')).map(record => `${record.name} ${record.state} ${record.pausedBy ?? ''}`),
                isSentOpen: (await batchOfAsync(alice, sessionId, batchId))?.finishedAt == null,
                isReceivedOpen: (await batchOfAsync(bob, sessionId, batchId))?.finishedAt == null,
            };
            const saved = (await recordOfAsync(bob, sessionId, longId, 'in'))?.pagination?.pagesDone ?? 0;
            const storedPages = await storedPagesAsync(bob, sessionId, longId);
            const senderPagination = (await storedRecordAsync(alice, sessionId, longId, 'out'))?.pagination;
            const resumer = side === 'out' ? alice : bob;

            // Act
            const resumed = await resumer.client.resumeBatchAsync(sessionId, batchId, side);
            await waitForAsync(() => bobDone.length === 3, 10_000, 'all received');
            await waitForAsync(async () => (await batchOfAsync(alice, sessionId, batchId))?.finishedAt != null, 5000, 'sent batch finished');

            // Assert
            expect(stopped).toBe(2);
            expect(whileStopped).toEqual({
                moved: 0,
                sent: ['f1.bin done ', 'f2.bin paused stop', 'f3.bin paused stop'],
                received: ['f1.bin done ', 'f2.bin paused stop', 'f3.bin paused stop'],
                isSentOpen: true,
                isReceivedOpen: true,
            });
            expect(saved).toBeGreaterThanOrEqual(3);
            expect(storedPages).toBe(saved);
            expect(senderPagination?.pagesDone).toBeGreaterThan(0);
            expect(senderPagination?.pageHashes?.length).toBeGreaterThanOrEqual((senderPagination?.pagesDone ?? 0) * 32);
            expect(resumed).toBe(2);
            expect(pages.get(longId)).toEqual(Array.from({ length: 12 - (saved - 1) }, (_, index) => saved - 1 + index));
            expect(messages(alice)).toContain(`f2.bin resume fromPage=${saved - 1} pageSize=256 KiB`);
            const long = await recordOfAsync(bob, sessionId, longId, 'in') as FileRecord;
            expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(long))).toEqual(await bytesOfAsync(picked.files[1] as File));
            expect(await batchOfAsync(alice, sessionId, batchId)).toMatchObject({ itemCount: 3, received: 3, canceled: 0 });
            expect(await batchOfAsync(bob, sessionId, batchId)).toMatchObject({ itemCount: 3, received: 3, canceled: 0 });
        },
        20_000,
    );

    it('resumes one stopped file from its row on the receiver, and leaves the rest of the batch stopped', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { alice, bob, sessionId, bobDone } = pair;
        const picked = pick(5151);
        const [, longId, lastId] = await idsOfAsync(picked) as [string, string, string];
        await sendAndStopAsync(pair, 'out', picked);
        const long = await recordOfAsync(bob, sessionId, longId, 'in') as FileRecord;

        // Act
        await bob.client.resumeAsync(long);
        await waitForAsync(() => bobDone.length === 2, 10_000, 'the long file received');
        await pauseAsync(200);

        // Assert
        expect(isStopped(await recordOfAsync(alice, sessionId, lastId, 'out'))).toBe(true);
        expect(isStopped(await recordOfAsync(bob, sessionId, lastId, 'in'))).toBe(true);
        expect(bobDone.map(record => record.name)).toEqual(['f1.bin', 'f2.bin']);
    }, 20_000);

    it('moves nothing after a Stop, even across a reconnect, while a lost link resumes by itself', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, alice, bob, sessionId, bobDone } = pair;
        const lost = createTestFile('lost.bin', 8 * PAGE, 5201);
        const dropped = dropWhenPartialAsync(hub, 1, 8, 2);
        await alice.client.sendFilesAsync([lost]);
        await dropped;
        await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost');
        await pairAsync(alice, bob);
        await waitForAsync(() => bobDone.length === 1, 10_000, 'the lost link resumed by itself');
        const picked = pick(5251);
        const [, longId] = await idsOfAsync(picked) as [string, string, string];
        await sendAndStopAsync(pair, 'out', picked);

        // Act
        hub.dropLinks();
        await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost after the Stop');
        await pairAsync(alice, bob);
        const pages = watchPages(hub);
        await pauseAsync(500);

        // Assert
        expect(bobDone.map(record => record.name)).toEqual(['lost.bin', 'f1.bin']);
        expect(pages.size).toBe(0);
        expect(isStopped(await recordOfAsync(alice, sessionId, longId, 'out'))).toBe(true);
        expect(isStopped(await recordOfAsync(bob, sessionId, longId, 'in'))).toBe(true);
    }, 20_000);

    it('stops the sender too when the receiver stopped while the link was down', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, alice, bob, sessionId, bobDone } = pair;
        const file = createTestFile('away.bin', 10 * PAGE, 5301);
        const fileId = await computeFileIdAsync(file, file.name);
        const dropped = dropWhenPartialAsync(hub, 1, 10, 2);
        const batch = await alice.client.sendFilesAsync([file]);
        await dropped;
        await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost');
        await bob.client.stopBatchAsync(sessionId, batch.batchId, 'in');

        // Act
        await pairAsync(alice, bob);
        const pages = watchPages(hub);
        await pauseAsync(500);
        const whileStopped = { moved: pages.size, isSenderStopped: isStopped(await recordOfAsync(alice, sessionId, fileId, 'out')) };
        await bob.client.resumeBatchAsync(sessionId, batch.batchId, 'in');
        await waitForAsync(() => bobDone.length === 1, 10_000, 'received after Resume');

        // Assert
        expect(whileStopped).toEqual({ moved: 0, isSenderStopped: true });
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(bobDone[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    }, 20_000);

    it('keeps the pages on a receiver that drops stop-batch, as an older build does, by pausing the moving file', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, bob, sessionId } = pair;
        hub.intercept(entry => (entry.kind === 'message' && entry.message.t === 'stop-batch' ? 'drop' : undefined));
        const picked = pick(5351);
        const [, longId] = await idsOfAsync(picked) as [string, string, string];
        let batchId = '';
        const stopping = stopAtPage(hub, longId, 2, () => pair.alice.client.stopBatchAsync(sessionId, batchId, 'out'));

        // Act
        batchId = (await pair.alice.client.sendFilesAsync(picked.files, { relativePaths: picked.paths })).batchId;
        await waitForAsync(() => stopping() != null, 10_000, 'stop pressed');
        await stopping();
        await waitForAsync(async () => (await recordOfAsync(bob, sessionId, longId, 'in'))?.state === 'paused', 5000, 'paused on the receiver');

        // Assert
        const long = await recordOfAsync(bob, sessionId, longId, 'in');
        expect(long).toMatchObject({ state: 'paused', pausedBy: 'peer' });
        expect(long?.pagination?.pagesDone).toBeGreaterThanOrEqual(3);
        expect(await storedPagesAsync(bob, sessionId, longId)).toBe(long?.pagination?.pagesDone);
    }, 20_000);

    it('rejects a Stop or a Resume of a batch this device does not have, and a Resume while not connected', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { alice, sessionId } = pair;
        const batch = await alice.client.sendFilesAsync([createTestFile('one.bin', PAGE, 5401)]);
        await alice.client.disconnectAsync();

        // Act
        const results = await Promise.all([
            alice.client.stopBatchAsync(sessionId, 'no-such-batch', 'out').catch((error: unknown) => error),
            alice.client.resumeBatchAsync(sessionId, 'no-such-batch', 'out').catch((error: unknown) => error),
            alice.client.resumeBatchAsync(sessionId, batch.batchId, 'out').catch((error: unknown) => error),
        ]);

        // Assert
        expect(results).toEqual([
            expect.objectContaining({ code: 'file-not-found' }),
            expect.objectContaining({ code: 'file-not-found' }),
            expect.objectContaining({ code: 'not-connected' }),
        ]);
    });
});

describe('resuming a stopped file by picking it again', () => {
    it('resumes from the saved page after the sender reloads: Resume asks for the file, and picking it continues', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, bob, sessionId, bobDone } = pair;
        const picked = pick(5501);
        const [, longId] = await idsOfAsync(picked) as [string, string, string];
        const { batchId } = await sendAndStopAsync(pair, 'out', picked);
        const saved = (await recordOfAsync(bob, sessionId, longId, 'in'))?.pagination?.pagesDone ?? 0;
        const reloaded = await reopenAsync(hub, pair.alice);
        await waitForAsync(() => bob.client.state !== 'connected', 5000, 'the reload seen on Bob');
        await pairAsync(reloaded, bob);
        const pages = watchPages(hub);
        await pauseAsync(300);
        const afterReload = { moved: pages.size, isStopped: isStopped(await recordOfAsync(reloaded, sessionId, longId, 'out')) };
        const needsFile: FileRecord[] = [];
        reloaded.client.on('needs-file', record => needsFile.push(record));

        // Act
        await reloaded.client.resumeBatchAsync(sessionId, batchId, 'out');
        await waitForAsync(() => needsFile.length === 2, 5000, 'needs picking again');
        const again = pick(5501);
        const match = await reloaded.client.resumeWithFilesAsync(again.files.slice(1), { sessionId });
        await waitForAsync(() => bobDone.length === 3, 10_000, 'all received');

        // Assert
        expect(afterReload).toEqual({ moved: 0, isStopped: true });
        expect(match.matched.map(record => record.name).sort()).toEqual(['f2.bin', 'f3.bin']);
        expect(pages.get(longId)?.[0]).toBe(saved - 1);
        expect(messages(reloaded)).toContain(`f2.bin resume fromPage=${saved - 1} pageSize=256 KiB`);
        const long = await recordOfAsync(bob, sessionId, longId, 'in') as FileRecord;
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(long))).toEqual(await bytesOfAsync(picked.files[1] as File));
    }, 20_000);

    it('continues a stopped file picked again in a new batch from the saved pages, skipping the finished one', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, alice, bob, sessionId, aliceDone, bobDone } = pair;
        const picked = pick(5601);
        const [firstId, longId, lastId] = await idsOfAsync(picked) as [string, string, string];
        const { batchId } = await sendAndStopAsync(pair, 'in', picked);
        const saved = (await recordOfAsync(bob, sessionId, longId, 'in'))?.pagination?.pagesDone ?? 0;
        const pages = watchPages(hub);
        const doneBefore = aliceDone.length;
        const again = pick(5601);

        // Act
        const batch = await alice.client.sendFilesAsync(again.files, { relativePaths: again.paths });
        await waitForAsync(() => aliceDone.length === doneBefore + 3, 10_000, 'the new batch sent');
        await waitForAsync(async () => (await batchOfAsync(bob, sessionId, batch.batchId))?.finishedAt != null, 5000, 'received batch finished');

        // Assert
        expect(aliceDone.slice(doneBefore).find(record => record.fileId === firstId)?.note).toBe('already-on-peer');
        expect(pages.has(firstId)).toBe(false);
        expect(pages.get(longId)?.[0]).toBe(saved - 1);
        expect(pages.get(longId)).toHaveLength(12 - (saved - 1));
        expect(pages.get(lastId)).toEqual([0]);
        expect(messages(alice)).toContain('f2.bin picked again, it continues from what arrived');
        expect(bobDone.map(record => record.name).sort()).toEqual(['f1.bin', 'f2.bin', 'f3.bin']);
        const received = await bob.client.listFilesAsync({ sessionId, direction: 'in' });
        expect(received.map(record => `${record.name} ${record.state}`).sort()).toEqual(['f1.bin done', 'f2.bin done', 'f3.bin done']);
        for (const [index, file] of again.files.entries()) {
            const record = received.find(item => item.name === file.name) as FileRecord;
            expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(record))).toEqual(await bytesOfAsync(picked.files[index] as File));
        }

        const batches = await Promise.all([alice, bob].flatMap(device => [batchOfAsync(device, sessionId, batchId), batchOfAsync(device, sessionId, batch.batchId)]));
        expect(batches.map(item => [item?.itemCount, item?.received, item?.failed, item?.canceled, item?.finishedAt != null]))
            .toEqual([[1, 1, 0, 0, true], [3, 3, 0, 0, true], [1, 1, 0, 0, true], [3, 3, 0, 0, true]]);
    }, 20_000);
});

describe('deletePartialAsync after a Stop', () => {
    it.each<{ readonly side: Direction }>([{ side: 'out' }, { side: 'in' }])(
        'deletes what arrived on both devices when the $side side deletes the partial',
        async ({ side }) => {
            // Arrange
            const pair = await pairedAsync();
            const { alice, bob, sessionId } = pair;
            const picked = pick(5701);
            const [, longId] = await idsOfAsync(picked) as [string, string, string];
            await sendAndStopAsync(pair, 'out', picked);
            const deleter = side === 'out' ? alice : bob;
            const record = await recordOfAsync(deleter, sessionId, longId, side) as FileRecord;

            // Act
            await deleter.client.deletePartialAsync(record);
            await waitForAsync(async () => (await recordOfAsync(alice, sessionId, longId, 'out'))?.state === 'canceled'
                && (await recordOfAsync(bob, sessionId, longId, 'in'))?.state === 'canceled', 5000, 'canceled on both');

            // Assert
            expect((await recordOfAsync(alice, sessionId, longId, 'out'))?.pagination).toBeUndefined();
            expect(await recordOfAsync(bob, sessionId, longId, 'in')).toMatchObject({ state: 'canceled', hasData: false });
            expect((await recordOfAsync(bob, sessionId, longId, 'in'))?.pagination).toBeUndefined();
            expect(await storedPagesAsync(bob, sessionId, longId)).toBe(0);
        },
        20_000,
    );
});

describe('the last saved page goes again on every resume', () => {
    it('asks for the last saved page again with the prefix of the pages before it, and writes the new copy over it', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, alice, bob, sessionId, bobDone } = pair;
        const file = createTestFile('movie.mp4', 8 * PAGE, 5801, 'video/mp4');
        const fileId = await computeFileIdAsync(file, file.name);
        const dropped = dropWhenPartialAsync(hub, 1, 8, 2);
        await alice.client.sendFilesAsync([file]);
        await dropped;
        await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost');
        const saved = (await recordOfAsync(bob, sessionId, fileId, 'in'))?.pagination?.pagesDone ?? 0;
        const accepts: Array<Record<string, unknown>> = [];
        hub.intercept(entry => {
            if (entry.kind === 'message' && entry.message.t === 'accept') {
                accepts.push(entry.message);
            }

            return undefined;
        });
        const pages = watchPages(hub);
        const writesBefore = countLogs(bob, new RegExp(`^movie\\.mp4 page ${saved}/8 saved`));

        // Act
        await pairAsync(alice, bob);
        await waitForAsync(() => bobDone.length === 1, 10_000, 'received');

        // Assert
        expect(saved).toBeGreaterThanOrEqual(3);
        expect(accepts).toEqual([expect.objectContaining({ fileId, fromPage: saved - 1, prefixHash: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
        expect(messages(alice)).toContain(`movie.mp4 prefixHash match, ${saved - 1} pages`);
        expect(pages.get(fileId)?.[0]).toBe(saved - 1);
        expect(writesBefore).toBe(1);
        expect(countLogs(bob, new RegExp(`^movie\\.mp4 page ${saved}/8 saved`))).toBe(2);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(bobDone[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    }, 20_000);

    it('starts at page 0 when nothing was saved, and at page 0 again when one page was, without calling it lost data', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, alice, bob, sessionId, aliceDone, bobDone } = pair;
        const empty = createTestFile('empty-start.bin', 4 * PAGE, 5901);
        const one = createTestFile('one-page.bin', 4 * PAGE, 5902);
        const [emptyId, oneId] = await Promise.all([computeFileIdAsync(empty, empty.name), computeFileIdAsync(one, one.name)]);
        // Nothing saved: the link drops with the first page on its way. One saved: the second page never arrives,
        // and the link drops once the first one's ack is through.
        const cutAsync = (fileId: string, savedPages: number): Promise<void> => new Promise(resolve => {
            const stop = hub.intercept(entry => {
                if (entry.kind !== 'message' || entry.message.fileId !== fileId) {
                    return undefined;
                }

                if (entry.message.t === 'page-end' && (entry.message.page as number) >= savedPages) {
                    if (savedPages === 0) {
                        stop();
                        queueMicrotask(() => {
                            hub.dropLinks();
                            resolve();
                        });
                    }

                    return 'drop';
                }

                if (savedPages > 0 && entry.message.t === 'ack' && entry.message.page === savedPages - 1) {
                    stop();
                    setTimeout(() => {
                        hub.dropLinks();
                        resolve();
                    }, 50);
                }

                return undefined;
            });
        });
        const accepts: Array<Record<string, unknown>> = [];
        hub.intercept(entry => {
            if (entry.kind === 'message' && entry.message.t === 'accept') {
                accepts.push(entry.message);
            }

            return undefined;
        });
        const resumes: Array<Record<string, unknown>> = [];

        // Act
        for (const [file, fileId, savedPages] of [[empty, emptyId, 0], [one, oneId, 1]] as const) {
            const cutting = cutAsync(fileId, savedPages);
            await alice.client.sendFilesAsync([file]);
            await cutting;
            await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost');
            accepts.length = 0;
            await pairAsync(alice, bob);
            await waitForAsync(() => bobDone.some(record => record.fileId === fileId), 10_000, `${file.name} received`);
            resumes.push(...accepts);
        }

        // Assert
        expect(resumes.map(message => [message.fileId, message.fromPage])).toEqual([[emptyId, 0], [oneId, 0]]);
        expect(countLogs(bob, /^one-page\.bin page 1\/4 saved/)).toBe(2);
        expect(aliceDone.find(record => record.fileId === oneId)?.note).toBeUndefined();
        expect(bobDone.find(record => record.fileId === oneId)?.note).toBeUndefined();
        for (const [file, fileId] of [[empty, emptyId], [one, oneId]] as const) {
            const record = await recordOfAsync(bob, sessionId, fileId, 'in') as FileRecord;
            expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(record))).toEqual(await bytesOfAsync(file));
        }
    }, 30_000);

    it('heals a stored last page whose bytes no longer match its hash, since the new copy replaces it', async () => {
        // Arrange
        const pair = await pairedAsync();
        const { hub, alice, bob, sessionId, bobDone } = pair;
        const file = createTestFile('photo.raw', 6 * PAGE, 6001);
        const fileId = await computeFileIdAsync(file, file.name);
        const dropped = dropWhenPartialAsync(hub, 1, 6, 2);
        await alice.client.sendFilesAsync([file]);
        await dropped;
        await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost');
        const storage = createClientStorage(bob.database);
        const record = await storage.getFileAsync(sessionId, fileId, 'in') as StoredFile;
        const last = (await storage.readPagesAsync(sessionId, fileId)).at(-1);
        // The right hash over the wrong bytes, as a page torn by a crash would leave it.
        const torn = new Uint8Array(await (last?.data ?? new Blob()).arrayBuffer()).map(byte => byte ^ 0x5a);
        await storage.writePageAsync({ ...(last as NonNullable<typeof last>), data: new Blob([torn]) }, record);

        // Act
        await pairAsync(alice, bob);
        await waitForAsync(() => bobDone.length === 1, 10_000, 'received');

        // Assert
        expect(last?.pageIndex).toBe((record.pagination?.pagesDone ?? 0) - 1);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(bobDone[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    }, 20_000);
});
