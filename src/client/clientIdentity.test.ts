import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { KIB, PAGE, PLAIN_MEDIA, bytesOfAsync, createTestDeviceAsync, createTestFile, messages, pairAsync, waitForAsync } from './clientHarness.js';
import type { TestDevice } from './clientHarness.js';
import type { BatchProgress, FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';
import { createClientStorage } from './storage.js';
import type { MediaToolkit } from '../media/metadataTypes.js';

// A file is its content and its path; one already on the other device is skipped only after a whole-file check.

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
    readonly aliceStates: FileRecord[];
    readonly bobDone: FileRecord[];
}

async function pairedAsync(media: MediaToolkit = PLAIN_MEDIA): Promise<Pair> {
    const hub = createFakeNetworkHub();
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', media });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob' });
    devices.push(alice, bob);
    await pairAsync(alice, bob);
    const aliceDone: FileRecord[] = [];
    const aliceStates: FileRecord[] = [];
    const bobDone: FileRecord[] = [];
    alice.client.on('file-done', record => aliceDone.push(record));
    alice.client.on('file-state', record => aliceStates.push(record));
    bob.client.on('file-done', record => bobDone.push(record));

    return { hub, alice, bob, sessionId: alice.client.peer?.sessionId ?? '', aliceDone, aliceStates, bobDone };
}

interface Traffic {
    frames: number;
    // Pages sent, by fileId.
    readonly pages: Map<string, number>;
}

function watchTraffic(hub: FakeNetworkHub): Traffic {
    const traffic: Traffic = { frames: 0, pages: new Map() };
    hub.intercept(entry => {
        if (entry.kind === 'frame') {
            traffic.frames++;
        } else if (entry.message.t === 'page-end') {
            const fileId = entry.message.fileId as string;
            traffic.pages.set(fileId, (traffic.pages.get(fileId) ?? 0) + 1);
        }

        return undefined;
    });

    return traffic;
}

interface Folder {
    readonly files: File[];
    readonly paths: string[];
}

// New File objects each time, as a second pick of the same folder gives.
function folder(count: number, seed: number): Folder {
    const files = Array.from({ length: count }, (_, index) => createTestFile(`track ${index + 1}.bin`, PAGE + 100 * index + 1, seed + index));

    return { files, paths: files.map(file => `Album/${file.name}`) };
}

// The most files shown as 'checking' at the same time, replaying the file-state events in order.
function mostCheckingAtOnce(states: readonly FileRecord[]): number {
    const checking = new Set<string>();
    let most = 0;
    for (const state of states) {
        if (state.state === 'verifying' && state.note === 'checking') {
            checking.add(state.fileId);
        } else {
            checking.delete(state.fileId);
        }

        most = Math.max(most, checking.size);
    }

    return most;
}

function delayAsync(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function receivedAsync(device: TestDevice, sessionId: string): Promise<FileRecord[]> {
    return device.client.listFilesAsync({ sessionId, direction: 'in' });
}

// The same bytes with one byte changed outside the three 64 KiB samples, so the sampled ID can't tell them apart.
async function collidedAsync(file: File, offset: number): Promise<File> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;

    return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}

describe('file identity is content and path', () => {
    it('sends the same bytes in two folders as two files', async () => {
        // Arrange
        const { alice, bob, sessionId, bobDone } = await pairedAsync();
        const photo = createTestFile('photo.jpg', PAGE + 10, 2101);
        const files = [photo, new File([photo], 'photo.jpg'), createTestFile('notes.txt', 900, 2102)];

        // Act
        await alice.client.sendFilesAsync(files, { relativePaths: ['Trip/2024/photo.jpg', 'Trip/Backup/photo.jpg', 'Trip/notes.txt'] });
        await waitForAsync(() => bobDone.length === 3, 5000, 'received');

        // Assert
        const received = await receivedAsync(bob, sessionId);
        const photos = received.filter(record => record.name === 'photo.jpg');
        expect(photos.map(record => record.relativePath).sort()).toEqual(['Trip/2024/photo.jpg', 'Trip/Backup/photo.jpg']);
        expect(new Set(photos.map(record => record.fileId)).size).toBe(2);
        expect(photos.every(record => record.hasData && record.state === 'done')).toBe(true);
        for (const record of photos) {
            expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(record))).toEqual(await bytesOfAsync(photo));
        }
    });

    it('queues the same file at the same path once, even when picked twice in one selection (PK-06)', async () => {
        // Arrange
        // Slow metadata keeps the first pick unregistered while its twin, prepared beside it, gets the same ID.
        const media: MediaToolkit = {
            ...PLAIN_MEDIA,
            extractMetadataAsync: async () => {
                await new Promise(resolve => setTimeout(resolve, 50));

                return undefined;
            },
        };
        const { alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync(media);
        const file = createTestFile('a.bin', 2 * PAGE, 2111);
        const queued: FileRecord[] = [];
        alice.client.on('file-queued', record => queued.push(record));

        // Act
        await alice.client.sendFilesAsync([file, new File([file], 'a.bin'), createTestFile('b.bin', 500, 2112)], { relativePaths: ['Box/a.bin', 'Box/a.bin', 'Box/b.bin'] });
        await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 3000, 'sent');

        // Assert
        expect(queued.map(record => record.name).sort()).toEqual(['a.bin', 'b.bin']);
        expect((await receivedAsync(bob, sessionId)).map(record => record.name).sort()).toEqual(['a.bin', 'b.bin']);
    });
});

describe('the verified skip', () => {
    it('skips every file of a folder sent again after a whole-file check, without sending a frame', async () => {
        // Arrange
        const { hub, alice, bob, sessionId, aliceDone, aliceStates, bobDone } = await pairedAsync();
        const first = folder(4, 2201);
        await alice.client.sendFilesAsync(first.files, { relativePaths: first.paths });
        await waitForAsync(() => aliceDone.length === 4 && bobDone.length === 4, 5000, 'first');
        const rootHashes = new Map(aliceDone.map(record => [record.fileId, record.rootHash]));
        const second = folder(4, 2201);
        const traffic = watchTraffic(hub);
        aliceStates.length = 0;

        // Act
        await alice.client.sendFilesAsync(second.files, { relativePaths: second.paths });
        await waitForAsync(() => aliceDone.length === 8, 5000, 'second');

        // Assert
        const skipped = aliceDone.slice(4);
        expect(skipped.every(record => record.state === 'done' && record.note === 'already-on-peer')).toBe(true);
        expect(skipped.every(record => record.rootHash === rootHashes.get(record.fileId))).toBe(true);
        for (const record of skipped) {
            const notes = aliceStates.filter(state => state.fileId === record.fileId && state.state === 'verifying').map(state => state.note);
            expect(notes).toEqual(['check-waiting', 'checking']);
        }

        expect(mostCheckingAtOnce(aliceStates)).toBe(1);
        expect(traffic.frames).toBe(0);
        expect(traffic.pages.size).toBe(0);
        expect(bobDone).toHaveLength(4);
        expect(await receivedAsync(bob, sessionId)).toHaveLength(4);
        expect(messages(alice).filter(message => message.endsWith('already on Bob, root hash matches'))).toHaveLength(4);
    });

    it('counts the files the receiver already has in its batch bytes, so its bar reaches the end, also after a reload', async () => {
        // Arrange
        const { alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync();
        const six = folder(6, 2951);
        await alice.client.sendFilesAsync(six.files, { relativePaths: six.paths });
        await waitForAsync(() => aliceDone.length === 6 && bobDone.length === 6, 5000, 'first six');
        const progress: BatchProgress[] = [];
        bob.client.on('batch-progress', item => progress.push(item));
        const ten = folder(10, 2951);

        // Act
        const batch = await alice.client.sendFilesAsync(ten.files, { relativePaths: ten.paths });
        await waitForAsync(() => aliceDone.length === 16 && bobDone.length === 10, 5000, 'second');
        await waitForAsync(async () => (await bob.client.listBatchesAsync(sessionId)).find(record => record.batchId === batch.batchId)?.finishedAt != null, 5000, 'finished');

        // Assert
        const totalBytes = ten.files.reduce((sum, file) => sum + file.size, 0);
        const ofBatch = progress.filter(item => item.batchId === batch.batchId);
        expect(ofBatch.at(-1)).toMatchObject({ total: 10, done: 10, totalBytes, bytesDone: totalBytes });
        expect(ofBatch.every((item, index) => index === 0 || item.bytesDone >= (ofBatch[index - 1]?.bytesDone ?? 0))).toBe(true);
        expect(await createClientStorage(bob.database).getBatchAsync(sessionId, batch.batchId)).toMatchObject({ received: 10, bytesDone: totalBytes });
    });

    it('sends again exactly the file whose data the receiver deleted, into the same record', async () => {
        // Arrange
        const { hub, alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync();
        const first = folder(5, 2301);
        await alice.client.sendFilesAsync(first.files, { relativePaths: first.paths });
        await waitForAsync(() => aliceDone.length === 5 && bobDone.length === 5, 5000, 'first');
        const deleted = bobDone.find(record => record.name === 'track 3.bin') as FileRecord;
        await bob.client.deleteReceivedAsync(deleted);
        const second = folder(5, 2301);
        const traffic = watchTraffic(hub);

        // Act
        await alice.client.sendFilesAsync(second.files, { relativePaths: second.paths });
        await waitForAsync(() => aliceDone.length === 10 && bobDone.length === 6, 5000, 'second');

        // Assert
        const secondRound = aliceDone.slice(5);
        expect(secondRound.filter(record => record.note === 'already-on-peer').map(record => record.name).sort())
            .toEqual(['track 1.bin', 'track 2.bin', 'track 4.bin', 'track 5.bin']);
        expect(secondRound.find(record => record.name === 'track 3.bin')).toMatchObject({ state: 'done', fileId: deleted.fileId });
        expect([...traffic.pages.keys()]).toEqual([deleted.fileId]);
        expect(traffic.pages.get(deleted.fileId)).toBe(2);
        const received = await receivedAsync(bob, sessionId);
        expect(received).toHaveLength(5);
        expect(received.every(record => record.hasData)).toBe(true);
        const restored = received.find(record => record.fileId === deleted.fileId) as FileRecord;
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(restored))).toEqual(await bytesOfAsync(second.files[2] as File));
    });

    it('sends a sampled collision in a folder anyway, replacing the receiver\'s copy', async () => {
        // Arrange
        const { hub, alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync();
        const original = createTestFile('a.bin', 3 * PAGE, 2401);
        const other = createTestFile('b.bin', PAGE, 2402);
        const paths = ['Trip/a.bin', 'Trip/b.bin'];
        await alice.client.sendFilesAsync([original, other], { relativePaths: paths });
        await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 5000, 'first');
        const before = bobDone.find(record => record.name === 'a.bin') as FileRecord;
        const collided = await collidedAsync(original, 150 * KIB);
        const traffic = watchTraffic(hub);

        // Act
        await alice.client.sendFilesAsync([collided, new File([other], 'b.bin')], { relativePaths: paths });
        await waitForAsync(() => aliceDone.length === 4 && bobDone.length === 3, 5000, 'second');

        // Assert
        const secondRound = aliceDone.slice(2);
        expect(secondRound.find(record => record.name === 'b.bin')?.note).toBe('already-on-peer');
        const resent = secondRound.find(record => record.name === 'a.bin') as FileRecord;
        expect(resent).toMatchObject({ state: 'done', fileId: before.fileId });
        expect(resent.note).toBeUndefined();
        expect(messages(alice)).toContain('a.bin differs from the copy on Bob, sending it anyway');
        expect([...traffic.pages.keys()]).toEqual([before.fileId]);
        const received = await receivedAsync(bob, sessionId);
        expect(received).toHaveLength(2);
        const replaced = received.find(record => record.fileId === before.fileId) as FileRecord;
        expect(replaced.rootHash).not.toBe(before.rootHash);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(replaced))).toEqual(await bytesOfAsync(collided));
    });

    it('sends a single sampled collision anyway, replacing the receiver\'s copy', async () => {
        // Arrange
        const { alice, bob, sessionId, aliceDone, aliceStates, bobDone } = await pairedAsync();
        const original = createTestFile('clip.bin', 3 * PAGE, 2501);
        await alice.client.sendFilesAsync([original]);
        await waitForAsync(() => aliceDone.length === 1 && bobDone.length === 1, 5000, 'first');
        const collided = await collidedAsync(original, 150 * KIB);

        // Act
        await alice.client.sendFilesAsync([collided]);
        await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 5000, 'second');

        // Assert
        expect(aliceDone[1]).toMatchObject({ state: 'done', fileId: aliceDone[0]?.fileId });
        expect(aliceDone[1]?.note).toBeUndefined();
        expect(aliceStates.some(record => record.state === 'verifying' && record.note === 'checking')).toBe(true);
        const received = await receivedAsync(bob, sessionId);
        expect(received).toHaveLength(1);
        expect(received[0]?.rootHash).toBe(aliceDone[1]?.rootHash);
        expect(received[0]?.rootHash).not.toBe(aliceDone[0]?.rootHash);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(received[0] as FileRecord))).toEqual(await bytesOfAsync(collided));
    });

    it('sends a file again in full on Send again even though the receiver has it', async () => {
        // Arrange
        const { hub, alice, aliceDone, bobDone } = await pairedAsync();
        await alice.client.sendFilesAsync([createTestFile('again.bin', 2 * PAGE, 2601)]);
        await waitForAsync(() => aliceDone.length === 1 && bobDone.length === 1, 5000, 'first');
        const traffic = watchTraffic(hub);

        // Act
        await alice.client.sendAgainAsync(aliceDone[0] as FileRecord);
        await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 5000, 'again');

        // Assert
        expect(traffic.pages.get(aliceDone[0]?.fileId ?? '')).toBe(2);
        expect(aliceDone[1]?.note).toBeUndefined();
    });

    it('leaves a file canceled while it waits for its check as canceled, without its note', async () => {
        // Arrange
        const { alice, sessionId, aliceDone, bobDone } = await pairedAsync();
        const first = folder(4, 2701);
        await alice.client.sendFilesAsync(first.files, { relativePaths: first.paths });
        await waitForAsync(() => aliceDone.length === 4 && bobDone.length === 4, 5000, 'first');
        const second = folder(4, 2701);
        const lastId = aliceDone.find(record => record.name === 'track 4.bin')?.fileId;
        let cancel: Promise<void> | undefined;
        alice.client.on('file-state', record => {
            if (record.fileId === lastId && record.note === 'check-waiting' && cancel == null) {
                cancel = alice.client.cancelAsync(record);
            }
        });

        // Act
        await alice.client.sendFilesAsync(second.files, { relativePaths: second.paths });
        await waitForAsync(() => aliceDone.length === 7 && cancel != null, 5000, 'second');
        await cancel;
        await delayAsync(100);

        // Assert
        const canceled = (await alice.client.listFilesAsync({ sessionId, direction: 'out' })).find(record => record.fileId === lastId && record.batchId !== aliceDone[0]?.batchId);
        expect(canceled).toMatchObject({ state: 'canceled' });
        expect(canceled?.note).toBeUndefined();
        expect(aliceDone.slice(4).map(record => record.name).sort()).toEqual(['track 1.bin', 'track 2.bin', 'track 3.bin']);
    });
});

describe('a file already here from another send', () => {
    it('skips a subfolder or a file sent alone after its whole folder, without sending a frame', async () => {
        // Arrange
        const { hub, alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync();
        const songs = [createTestFile('a.mp3', PAGE + 7, 2801), createTestFile('b.mp3', 900, 2802), createTestFile('c.mp3', PAGE, 2803)];
        await alice.client.sendFilesAsync(songs, { relativePaths: ['My Music/Ρεμπέτικα/a.mp3', 'My Music/Ρεμπέτικα/b.mp3', 'My Music/c.mp3'] });
        await waitForAsync(() => aliceDone.length === 3 && bobDone.length === 3, 5000, 'first');
        const traffic = watchTraffic(hub);

        // Act
        await alice.client.sendFilesAsync([new File([songs[0] as File], 'a.mp3'), new File([songs[1] as File], 'b.mp3')], { relativePaths: ['Ρεμπέτικα/a.mp3', 'Ρεμπέτικα/b.mp3'] });
        await waitForAsync(() => aliceDone.length === 5, 5000, 'subfolder');
        await alice.client.sendFilesAsync([new File([songs[2] as File], 'c.mp3')]);
        await waitForAsync(() => aliceDone.length === 6, 5000, 'single file');

        // Assert
        expect(aliceDone.slice(3).every(record => record.state === 'done' && record.note === 'already-on-peer')).toBe(true);
        expect(traffic.frames).toBe(0);
        expect(bobDone).toHaveLength(3);
        expect(await receivedAsync(bob, sessionId)).toHaveLength(3);
        expect(messages(bob)).toContain('a.mp3 is here already as My Music/Ρεμπέτικα/a.mp3');
        expect(messages(bob)).toContain('c.mp3 is here already as My Music/c.mp3');
    });

    it('sends both copies of a file picked twice in one selection, even when the first is in before the second is offered', async () => {
        // Arrange
        const song = createTestFile('Into My Arms.mp3', PAGE + 3, 2901);
        const later = new File([song], 'Into My Arms.mp3');
        const media: MediaToolkit = {
            ...PLAIN_MEDIA,
            extractMetadataAsync: async file => {
                if (file === later) {
                    await delayAsync(400);
                }

                return undefined;
            },
        };
        const { hub, alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync(media);
        const traffic = watchTraffic(hub);
        let isFirstInBeforeSecondOffered = false;
        hub.intercept(entry => {
            if (entry.kind === 'message' && entry.message.t === 'offer-batch' && JSON.stringify(entry.message).includes('Best Of/')) {
                isFirstInBeforeSecondOffered = bobDone.length === 1;
            }

            return undefined;
        });

        // Act
        await alice.client.sendFilesAsync([song, later], { relativePaths: ['Nick Cave/Into My Arms.mp3', 'Best Of/Into My Arms.mp3'] });
        await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 5000, 'both');

        // Assert
        expect(isFirstInBeforeSecondOffered).toBe(true);
        expect(aliceDone.every(record => record.note == null)).toBe(true);
        expect(traffic.pages.size).toBe(2);
        const received = await receivedAsync(bob, sessionId);
        expect(received.map(record => record.relativePath).sort()).toEqual(['Best Of/Into My Arms.mp3', 'Nick Cave/Into My Arms.mp3']);
        expect(received.every(record => record.hasData)).toBe(true);
    });

    it('sends a file with the same name but other content', async () => {
        // Arrange
        const { alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync();
        await alice.client.sendFilesAsync([createTestFile('cover.jpg', 1200, 3001)], { relativePaths: ['Album/cover.jpg'] });
        await waitForAsync(() => aliceDone.length === 1 && bobDone.length === 1, 5000, 'first');

        // Act
        await alice.client.sendFilesAsync([createTestFile('cover.jpg', 1200, 3002)]);
        await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 5000, 'second');

        // Assert
        expect(aliceDone[1]?.note).toBeUndefined();
        expect((await receivedAsync(bob, sessionId)).filter(record => record.hasData)).toHaveLength(2);
    });

    it('sends a file again when the receiver deleted its copy from the other send', async () => {
        // Arrange
        const { alice, bob, sessionId, aliceDone, bobDone } = await pairedAsync();
        const song = createTestFile('a.mp3', PAGE + 1, 3101);
        await alice.client.sendFilesAsync([song, createTestFile('b.mp3', 800, 3102)], { relativePaths: ['My Music/S/a.mp3', 'My Music/b.mp3'] });
        await waitForAsync(() => aliceDone.length === 2 && bobDone.length === 2, 5000, 'first');
        await bob.client.deleteReceivedAsync(bobDone.find(record => record.name === 'a.mp3') as FileRecord);

        // Act
        await alice.client.sendFilesAsync([new File([song], 'a.mp3')], { relativePaths: ['S/a.mp3'] });
        await waitForAsync(() => aliceDone.length === 3 && bobDone.length === 3, 5000, 'second');

        // Assert
        expect(aliceDone[2]?.note).toBeUndefined();
        const copies = (await receivedAsync(bob, sessionId)).filter(record => record.name === 'a.mp3');
        expect(copies.map(record => `${record.relativePath}:${record.hasData}`).sort()).toEqual(['My Music/S/a.mp3:false', 'S/a.mp3:true']);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(bobDone[2] as FileRecord))).toEqual(await bytesOfAsync(song));
    });
});
