import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PAGE,
    bytesOfAsync,
    createTestDeviceAsync,
    createTestFile,
    dropWhenPartialAsync,
    pairAsync,
    reopenDeviceAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice } from './clientHarness.js';
import type { FileRecord, UnfinishedElsewhere } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

async function deviceAsync(...args: Parameters<typeof createTestDeviceAsync>): Promise<TestDevice> {
    const device = await createTestDeviceAsync(...args);
    devices.push(device);

    return device;
}

function collect<Item>(subscribe: (push: (item: Item) => void) => void): Item[] {
    const items: Item[] = [];
    subscribe(item => items.push(item));

    return items;
}

// Alice sends to Bob until the link drops mid-file; returns the old session and the file.
async function interruptedAsync(hub: FakeNetworkHub): Promise<{ alice: TestDevice; bob: TestDevice; oldSessionId: string; file: File }> {
    const alice = await deviceAsync(hub, { name: 'Alice' });
    const bob = await deviceAsync(hub, { name: 'Bob' });
    await pairAsync(alice, bob);
    const oldSessionId = alice.client.peer?.sessionId ?? '';
    const file = createTestFile('IMG_2231.MOV', 8 * PAGE, 77, 'video/quicktime');
    const dropped = dropWhenPartialAsync(hub, 1, 8, 2);
    await alice.client.sendFilesAsync([file]);
    await dropped;
    await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'lost');

    return { alice, bob, oldSessionId, file };
}

describe('sending unfinished files to this device', () => {
    it('offers them once after pairing, moves them and verifies here (open question 1)', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const { alice, oldSessionId, file } = await interruptedAsync(hub);
        const clearedBob = await deviceAsync(hub, { name: 'Bob' });
        const offered = collect<readonly UnfinishedElsewhere[]>(push => alice.client.on('unfinished-elsewhere', push));
        const done = collect<FileRecord>(push => clearedBob.client.on('file-done', push));
        await pairAsync(alice, clearedBob);
        await waitForAsync(() => offered.length === 1, 2000, 'event');

        // Act
        const listed = await alice.client.listUnfinishedElsewhereAsync();
        const moved = await alice.client.sendUnfinishedHereAsync([oldSessionId]);
        await waitForAsync(() => done.length === 1, 10_000, 'done');
        const again = await alice.client.sendUnfinishedHereAsync([oldSessionId]);

        // Assert
        expect(alice.client.peer?.sessionId).not.toBe(oldSessionId);
        expect(offered[0]).toEqual([expect.objectContaining({
            sessionId: oldSessionId,
            peerName: 'Bob',
            fileCount: 1,
            totalBytes: file.size,
            readyCount: 1,
        })]);
        expect(listed).toEqual(offered[0]);
        expect(moved).toEqual({ queued: 1, needsFile: 0 });
        expect(again).toEqual({ queued: 0, needsFile: 0 });
        expect(await alice.client.listUnfinishedElsewhereAsync()).toEqual([]);
        expect((await alice.client.listFilesAsync({ sessionId: oldSessionId }))[0]).toMatchObject({ state: 'canceled', note: 'moved' });
        expect(await bytesOfAsync(await clearedBob.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });

    it('makes files this page no longer holds wait as needs-file here after a reload', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const { alice, oldSessionId, file } = await interruptedAsync(hub);
        const reloaded = await reopenDeviceAsync(hub, alice);
        devices.push(reloaded);
        const clearedBob = await deviceAsync(hub, { name: 'Bob' });
        const offered = collect<readonly UnfinishedElsewhere[]>(push => reloaded.client.on('unfinished-elsewhere', push));
        const needsFile = collect<FileRecord>(push => reloaded.client.on('needs-file', push));
        const done = collect<FileRecord>(push => clearedBob.client.on('file-done', push));
        await pairAsync(reloaded, clearedBob);
        await waitForAsync(() => offered.length === 1, 2000, 'event');

        // Act
        const moved = await reloaded.client.sendUnfinishedHereAsync([oldSessionId]);
        const waiting = await reloaded.client.listFilesAsync({ sessionId: reloaded.client.peer?.sessionId ?? '', states: ['needs-file'] });
        const match = await reloaded.client.resumeWithFilesAsync([file]);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(offered[0]?.[0]).toMatchObject({ fileCount: 1, readyCount: 0 });
        expect(moved).toEqual({ queued: 0, needsFile: 1 });
        expect(waiting.map(record => record.name)).toEqual(['IMG_2231.MOV']);
        expect(needsFile.some(record => record.sessionId === reloaded.client.peer?.sessionId)).toBe(true);
        expect(match.matched).toHaveLength(1);
        expect((await reloaded.client.listFilesAsync({ sessionId: oldSessionId }))[0]).toMatchObject({ state: 'canceled', note: 'moved' });
        expect(await bytesOfAsync(await clearedBob.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });

    it('says nothing when no other device has unfinished files, and returns nothing while not connected', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        const offered = collect<readonly UnfinishedElsewhere[]>(push => alice.client.on('unfinished-elsewhere', push));
        const beforePairing = await alice.client.listUnfinishedElsewhereAsync();

        // Act
        await pairAsync(alice, bob);
        const sending = alice.client.disconnectAsync().then(() => alice.client.sendUnfinishedHereAsync(['x']).catch((error: unknown) => error));

        // Assert
        expect(beforePairing).toEqual([]);
        expect(offered).toEqual([]);
        expect(await sending).toMatchObject({ code: 'not-connected' });
    });
});
