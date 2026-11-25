import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PAGE,
    PHOTO_MEDIA,
    PLAIN_MEDIA,
    bytesOfAsync,
    countLogs,
    createTestDeviceAsync,
    createTestFile,
    dropWhenPartialAsync,
    messages,
    pairAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import { UNFINISHED_STATES } from './clientTypes.js';
import type { FileRecord, ProgressInfo } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';
import type { Message } from '../network/networkTypes.js';

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

async function deviceAsync(hub: FakeNetworkHub, options: TestDeviceOptions): Promise<TestDevice> {
    const device = await createTestDeviceAsync(hub, options);
    devices.push(device);

    return device;
}

function collect<Item>(subscribe: (push: (item: Item) => void) => void): Item[] {
    const items: Item[] = [];
    subscribe(item => items.push(item));

    return items;
}

// Everything the offerer's next network sends: pairAsync creates the offerer's network first.
function recordNextOfferer(hub: FakeNetworkHub): { readonly messages: Message[]; frames: number } {
    const index = hub.networks.length;
    const recorded = { messages: [] as Message[], frames: 0 };
    hub.intercept(traffic => {
        if (traffic.from.index !== index) {
            return undefined;
        }

        if (traffic.kind === 'message') {
            recorded.messages.push(traffic.message);
        } else {
            recorded.frames++;
        }

        return undefined;
    });

    return recorded;
}

async function sessionOfAsync(device: TestDevice, peerName: string): Promise<string> {
    const sessions = await device.client.listSessionsAsync();

    return sessions.find(session => session.peerName === peerName)?.sessionId ?? '';
}

describe('isolation between paired devices', () => {
    it('never sends, offers or shows one device\'s files to another, and resumes them when that device returns', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice', media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true, maxConcurrentFiles: 1 } });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        const carol = await deviceAsync(hub, { name: 'Carol' });
        await alice.client.configureAsync({ peerLogs: true, logSinks: ['memory', 'peer'] });
        await carol.client.configureAsync({ peerLogs: true });
        await pairAsync(alice, bob);
        const photo = createTestFile('IMG_4000.JPG', 6 * PAGE, 1601, 'image/jpeg');
        const dropped = dropWhenPartialAsync(hub, 1, 6, 1);
        await alice.client.sendFilesAsync([photo, createTestFile('IMG_4001.JPG', 2 * PAGE, 1602, 'image/jpeg')]);
        await dropped;
        await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost');
        const bobSession = await sessionOfAsync(alice, 'Bob');
        const bobFiles = await alice.client.listFilesAsync({ sessionId: bobSession, direction: 'out' });
        const bobFileIds = new Set(bobFiles.map(record => record.fileId));
        const partial = bobFiles.find(record => record.name === 'IMG_4000.JPG') as FileRecord;
        const queued = bobFiles.find(record => record.name === 'IMG_4001.JPG') as FileRecord;
        const savedPages = (await bob.client.listFilesAsync({ sessionId: bobSession, states: UNFINISHED_STATES }))
            .find(record => record.fileId === partial.fileId)?.pagination?.pagesDone ?? 0;
        alice.controller.logger.info('resume', `${partial.name} waiting for Bob`);
        const toCarol = recordNextOfferer(hub);
        const progress = collect<ProgressInfo>(push => alice.client.on('progress', items => items.forEach(push)));
        const carolEvents = collect<FileRecord>(push => {
            carol.client.on('file-state', push);
            carol.client.on('file-incoming', push);
        });

        // Act
        await pairAsync(alice, carol);
        const carolSession = alice.client.peer?.sessionId ?? '';
        await alice.client.pauseAsync(partial);
        await alice.client.resumeAsync(partial);
        await alice.client.cancelAsync(queued);
        hub.networks.at(-1)?.send(1, { t: 'cancel', fileId: partial.fileId, direction: 'in', keepPartial: false, reason: 'canceled' });
        await new Promise(resolve => setTimeout(resolve, 300));
        const duringCarol = {
            files: await alice.client.listFilesAsync({ sessionId: carolSession }),
            batches: await alice.client.listBatchesAsync(carolSession),
            bobPartial: (await alice.client.listFilesAsync({ sessionId: bobSession })).find(record => record.fileId === partial.fileId),
            carolFiles: await carol.client.listFilesAsync({ sessionId: carolSession }),
            carolLogs: carol.memory.entries().filter(entry => entry.peer != null).map(entry => entry.msg),
        };
        await alice.client.disconnectAsync();
        await waitForAsync(() => carol.client.state === 'closed', 2000, 'carol closed');
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        await pairAsync(alice, bob);
        await waitForAsync(() => done.length === 1, 10_000, 'resumed on Bob');

        // Assert
        const leaked = toCarol.messages.filter(message => bobFileIds.has(message.fileId as string)
            || (message.t === 'offer-batch') || (message.t === 'sync' && (message.files as unknown[]).length > 0));
        expect(leaked).toEqual([]);
        expect(toCarol.frames).toBe(0);
        expect(duringCarol.files).toEqual([]);
        expect(duringCarol.batches).toEqual([]);
        expect(duringCarol.carolFiles).toEqual([]);
        expect(carolEvents).toEqual([]);
        expect(duringCarol.carolLogs.some(message => message.includes('IMG_4000'))).toBe(false);
        expect(duringCarol.bobPartial).toMatchObject({ state: 'queued' });
        expect(progress.filter(item => item.sessionId !== bobSession).filter(item => bobFileIds.has(item.fileId))).toEqual([]);
        expect(messages(alice)).toContain(`IMG_4000.JPG resume fromPage=${savedPages - 1} pageSize=256 KiB`);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(photo));
        expect((await alice.client.listFilesAsync({ sessionId: bobSession })).find(record => record.fileId === queued.fileId)?.state).toBe('canceled');
    }, 30_000);

    it('keeps two records and two progress entries for the same file sent to two devices', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        const carol = await deviceAsync(hub, { name: 'Carol' });
        const file = createTestFile('shared.bin', 4 * PAGE, 1611);
        const progress = collect<ProgressInfo>(push => alice.client.on('progress', items => items.forEach(push)));
        const sent = collect<FileRecord>(push => alice.client.on('file-done', push));

        // Act
        await pairAsync(alice, bob);
        const bobSession = alice.client.peer?.sessionId ?? '';
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => sent.length === 1, 5000, 'sent to Bob');
        await alice.client.disconnectAsync();
        await pairAsync(alice, carol);
        const carolSession = alice.client.peer?.sessionId ?? '';
        await alice.client.sendFilesAsync([new File([file], 'shared.bin')]);
        await waitForAsync(() => sent.length === 2, 5000, 'sent to Carol');

        // Assert
        expect(sent.map(record => record.sessionId)).toEqual([bobSession, carolSession]);
        expect(sent[1]?.note).toBeUndefined();
        expect(sent[0]?.fileId).toBe(sent[1]?.fileId);
        expect((await alice.client.listFilesAsync({ sessionId: bobSession }))).toHaveLength(1);
        expect((await alice.client.listFilesAsync({ sessionId: carolSession }))).toHaveLength(1);
        const forCarol = progress.filter(item => item.sessionId === carolSession);
        const forBob = progress.filter(item => item.sessionId === bobSession);
        expect(forCarol.at(-1)).toMatchObject({ fileId: sent[1]?.fileId, direction: 'out', bytesDone: file.size, percent: 100 });
        expect(forBob.at(-1)).toMatchObject({ fileId: sent[0]?.fileId, direction: 'out', bytesDone: file.size, percent: 100 });
        expect(progress.every(item => item.sessionId === bobSession || item.sessionId === carolSession)).toBe(true);
        expect(countLogs(carol, /^shared\.bin page \d+\/4 saved/)).toBe(4);
    });

    it('keeps the same file received from two devices as two records with their own pages and thumbnails', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice', media: PLAIN_MEDIA });
        const bob = await deviceAsync(hub, { name: 'Bob', media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true } });
        const carol = await deviceAsync(hub, { name: 'Carol', media: PLAIN_MEDIA, settings: { sendThumbnailsFirst: true } });
        const photo = createTestFile('IMG_5000.JPG', 3 * PAGE, 1621, 'image/jpeg');
        const received = collect<FileRecord>(push => alice.client.on('file-done', push));
        const thumbs = collect<{ readonly fileId: string; readonly sessionId: string }>(push => alice.client.on('thumb', (fileId, sessionId) => push({ fileId, sessionId })));

        // Act
        await pairAsync(bob, alice);
        const bobSession = alice.client.peer?.sessionId ?? '';
        await bob.client.sendFilesAsync([photo]);
        await waitForAsync(() => received.length === 1 && thumbs.length === 1, 5000, 'from Bob');
        await bob.client.disconnectAsync();
        await waitForAsync(() => alice.client.state === 'closed', 2000, 'closed');
        await pairAsync(carol, alice);
        const carolSession = alice.client.peer?.sessionId ?? '';
        await carol.client.sendFilesAsync([new File([photo], 'IMG_5000.JPG', { type: 'image/jpeg' })]);
        await waitForAsync(() => received.length === 2, 5000, 'from Carol');
        await new Promise(resolve => setTimeout(resolve, 100));

        // Assert
        const fileId = received[0]?.fileId ?? '';
        const fromBob = (await alice.client.listFilesAsync({ sessionId: bobSession }))[0];
        const fromCarol = (await alice.client.listFilesAsync({ sessionId: carolSession }))[0];
        expect(received[1]?.fileId).toBe(fileId);
        expect(fromBob).toMatchObject({ sessionId: bobSession, state: 'done', hasData: true, hasThumbnail: true });
        expect(fromCarol).toMatchObject({ sessionId: carolSession, state: 'done', hasData: true, hasThumbnail: false });
        expect(countLogs(alice, /^IMG_5000\.JPG page \d+\/3 saved/)).toBe(6);
        expect(thumbs).toEqual([{ fileId, sessionId: bobSession }]);
        expect(await alice.client.getThumbnailAsync({ sessionId: bobSession, fileId })).toBeInstanceOf(Blob);
        expect(await alice.client.getThumbnailAsync({ sessionId: carolSession, fileId })).toBeUndefined();
        expect(await bytesOfAsync(await alice.client.getReceivedFileAsync({ sessionId: carolSession, fileId }))).toEqual(await bytesOfAsync(photo));
        expect(await bytesOfAsync(await alice.client.getReceivedFileAsync({ sessionId: bobSession, fileId }))).toEqual(await bytesOfAsync(photo));
    });

    it('acts only on the named session\'s record, and rejects a session that has no such file', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        const carol = await deviceAsync(hub, { name: 'Carol' });
        const file = createTestFile('both.bin', 2 * PAGE, 1631);
        const received = collect<FileRecord>(push => alice.client.on('file-done', push));
        await pairAsync(bob, alice);
        const bobSession = alice.client.peer?.sessionId ?? '';
        await bob.client.sendFilesAsync([file]);
        await waitForAsync(() => received.length === 1, 5000, 'from Bob');
        await bob.client.disconnectAsync();
        await waitForAsync(() => alice.client.state === 'closed', 2000, 'closed');
        await pairAsync(carol, alice);
        const carolSession = alice.client.peer?.sessionId ?? '';
        await carol.client.sendFilesAsync([new File([file], 'both.bin')]);
        await waitForAsync(() => received.length === 2, 5000, 'from Carol');
        const fileId = received[0]?.fileId ?? '';
        const unknown = { sessionId: '0'.repeat(32), fileId };

        // Act
        await alice.client.markSavedAsync(bobSession, [fileId]);
        await alice.client.deleteReceivedAsync({ sessionId: carolSession, fileId });
        const sha256 = await alice.client.computeSha256Async({ sessionId: bobSession, fileId });
        const rejections = await Promise.all([
            alice.client.getReceivedFileAsync(unknown),
            alice.client.pauseAsync(unknown),
            alice.client.cancelAsync(unknown),
            alice.client.getThumbnailAsync(unknown),
            alice.client.markSavedAsync(unknown.sessionId, [fileId]),
            alice.client.buildZipAsync(unknown.sessionId, [fileId]),
            alice.client.computeSha256Async(unknown),
            alice.client.retryFailedAsync(bobSession, 'no-such-batch'),
            alice.client.sendAgainAsync({ sessionId: bobSession, fileId }),
        ].map(promise => (promise as Promise<unknown>).then(() => 'resolved', (error: { code?: string }) => error.code)));

        // Assert
        const fromBob = (await alice.client.listFilesAsync({ sessionId: bobSession }))[0];
        const fromCarol = (await alice.client.listFilesAsync({ sessionId: carolSession }))[0];
        expect(fromBob).toMatchObject({ hasData: true, sha256 });
        expect(fromBob?.savedAt).toBeTypeOf('number');
        expect(fromCarol).toMatchObject({ hasData: false });
        expect(fromCarol?.savedAt).toBeUndefined();
        expect(fromCarol?.sha256).toBeUndefined();
        expect(rejections).toEqual(Array.from({ length: 9 }, () => 'file-not-found'));
        expect(await bytesOfAsync(await alice.client.getReceivedFileAsync({ sessionId: bobSession, fileId }))).toEqual(await bytesOfAsync(file));
        await expect(alice.client.getReceivedFileAsync({ sessionId: carolSession, fileId })).rejects.toMatchObject({ code: 'file-not-found' });
    });
});
