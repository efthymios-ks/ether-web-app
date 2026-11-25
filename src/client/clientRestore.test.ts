import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PAGE,
    countLogs,
    createTestDeviceAsync,
    createTestFile,
    pairAsync,
    reopenDeviceAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import type { FileRecord, SessionKnown, SessionReset } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';
import { computeFileIdAsync } from './hashing.js';

// The Restore prompt (UI plan §6): a known session that holds files waits on both devices for Restore or
// Start fresh; Start fresh from either side clears the history on both.

const devices: TestDevice[] = [];

afterEach(() => {
    for (const device of devices.splice(0)) {
        device.client.dispose();
    }
});

interface Watched {
    readonly device: TestDevice;
    readonly known: SessionKnown[];
    readonly resets: SessionReset[];
    readonly done: FileRecord[];
}

interface Pair {
    readonly hub: FakeNetworkHub;
    readonly alice: Watched;
    readonly bob: Watched;
    readonly sessionId: string;
}

function watch(device: TestDevice): Watched {
    const watched: Watched = { device, known: [], resets: [], done: [] };
    device.client.on('session-known', info => watched.known.push(info));
    device.client.on('session-reset', reset => watched.resets.push(reset));
    device.client.on('file-done', record => watched.done.push(record));

    return watched;
}

async function deviceAsync(hub: FakeNetworkHub, name: string, options: Partial<TestDeviceOptions> = {}): Promise<Watched> {
    const device = await createTestDeviceAsync(hub, { name, restorePrompt: 'ask', ...options });
    devices.push(device);

    return watch(device);
}

async function reopenAsync(hub: FakeNetworkHub, watched: Watched): Promise<Watched> {
    const device = await reopenDeviceAsync(hub, watched.device, { restorePrompt: 'ask' });
    devices.push(device);

    return watch(device);
}

// Pairs by code and waits for both links, without waiting for sync: a device asking Restore sends none yet.
async function connectAsync(offerer: Watched, answerer: Watched): Promise<void> {
    const offer = await offerer.device.client.startPairingAsync();
    const answer = await answerer.device.client.joinWithCodeAsync(offer.url);
    await offerer.device.client.completePairingAsync(answer.answerCode);
    await waitForAsync(
        () => offerer.device.client.state === 'connected' && answerer.device.client.state === 'connected',
        5000,
        'both connected',
    );
}

async function filesAsync(watched: Watched, sessionId: string): Promise<FileRecord[]> {
    return watched.device.client.listFilesAsync({ sessionId });
}

async function disconnectAsync(pair: Pair): Promise<void> {
    await pair.alice.device.client.disconnectAsync();
    await waitForAsync(() => pair.bob.device.client.state === 'closed', 5000, 'Bob closed');
}

// Alice and Bob paired once, with one finished file each way.
async function pairWithHistoryAsync(): Promise<Pair> {
    const hub = createFakeNetworkHub();
    const alice = await deviceAsync(hub, 'Alice');
    const bob = await deviceAsync(hub, 'Bob');
    await pairAsync(alice.device, bob.device);
    await alice.device.client.sendFilesAsync([createTestFile('a1.bin', 1000, 3101)]);
    await bob.device.client.sendFilesAsync([createTestFile('b1.bin', 2000, 3102)]);
    await waitForAsync(() => alice.done.length === 2 && bob.done.length === 2, 5000, 'history');

    return { hub, alice, bob, sessionId: alice.device.client.peer?.sessionId ?? '' };
}

// Starts a 16-page file from Alice and disconnects once Bob has saved two of its pages.
async function disconnectMidwayAsync(pair: Pair): Promise<File> {
    const file = createTestFile('movie.mp4', 16 * PAGE, 3103, 'video/mp4');
    const fileId = await computeFileIdAsync(file, file.name);
    pair.hub.delayMs = 2;
    let acks = 0;
    const midway = new Promise<void>(resolve => {
        const stop = pair.hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'ack' && traffic.message.fileId === fileId && ++acks === 2) {
                stop();
                resolve();
            }

            return undefined;
        });
    });
    await pair.alice.device.client.sendFilesAsync([file]);
    await midway;
    await disconnectAsync(pair);

    return file;
}

describe('the Restore prompt (UI plan §6)', () => {
    it('asks on both devices when a known session holds files, with the last connection and its counts', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await disconnectAsync(pair);
        const before = await pair.alice.device.client.getSessionAsync(pair.sessionId);

        // Act
        await connectAsync(pair.alice, pair.bob);
        await waitForAsync(() => pair.alice.known.length === 1 && pair.bob.known.length === 1, 5000, 'both asked');

        // Assert
        expect(pair.alice.known).toEqual([{
            sessionId: pair.sessionId,
            peerName: 'Bob',
            lastConnectedAt: before?.lastConnectedAt,
            receivedCount: 1,
            sentCount: 1,
            unfinishedCount: 0,
        }]);
        expect(pair.bob.known).toEqual([
            expect.objectContaining({ sessionId: pair.sessionId, peerName: 'Alice', receivedCount: 1, sentCount: 1 }),
        ]);
        expect(countLogs(pair.alice.device, /^sync sent/)).toBe(1);
        expect(countLogs(pair.bob.device, /^sync sent/)).toBe(1);
    });

    it('resumes transfers only once both devices chose Restore', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        const file = await disconnectMidwayAsync(pair);
        await connectAsync(pair.alice, pair.bob);
        await waitForAsync(() => pair.alice.known.length === 1 && pair.bob.known.length === 1, 5000, 'both asked');
        const unfinished = pair.bob.known[0]?.unfinishedCount;

        // Act
        await pair.alice.device.client.restoreSessionAsync(pair.sessionId);
        await new Promise(resolve => setTimeout(resolve, 200));
        const whileBobAsks = (await filesAsync(pair.bob, pair.sessionId)).find(record => record.name === file.name);
        const resumedWhileBobAsks = countLogs(pair.alice.device, /^movie\.mp4 resume fromPage/);
        await pair.bob.device.client.restoreSessionAsync(pair.sessionId);
        await waitForAsync(() => pair.bob.done.some(record => record.name === file.name), 10_000, 'movie done');

        // Assert
        expect(unfinished).toBe(1);
        expect(whileBobAsks).toMatchObject({ state: 'paused', pausedBy: 'link' });
        expect(resumedWhileBobAsks).toBe(0);
        expect(countLogs(pair.alice.device, /^movie\.mp4 resume fromPage=[1-9]\d* pageSize=/)).toBe(1);
    });

    it('clears both devices when one starts fresh while the other’s prompt is open', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await disconnectAsync(pair);
        await connectAsync(pair.alice, pair.bob);
        await waitForAsync(() => pair.alice.known.length === 1 && pair.bob.known.length === 1, 5000, 'both asked');

        // Act
        const result = await pair.alice.device.client.startFreshAsync(pair.sessionId);
        await waitForAsync(() => pair.bob.resets.length === 1, 5000, 'Bob reset');
        await pair.bob.device.client.restoreSessionAsync(pair.sessionId);
        await pair.bob.device.client.sendFilesAsync([createTestFile('after.bin', 3000, 3104)]);
        await waitForAsync(() => pair.alice.done.some(record => record.name === 'after.bin'), 5000, 'new file');

        // Assert
        expect(result).toEqual({ removed: 2, isPeerNotified: true });
        expect(pair.bob.resets).toEqual([{ sessionId: pair.sessionId, peerName: 'Alice', removed: 2 }]);
        expect(pair.alice.resets).toEqual([]);
        expect((await filesAsync(pair.alice, pair.sessionId)).map(record => record.name)).toEqual(['after.bin']);
        expect((await filesAsync(pair.bob, pair.sessionId)).map(record => record.name)).toEqual(['after.bin']);
    });

    it('lets Start fresh win over a Restore already chosen on the other device', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        const file = await disconnectMidwayAsync(pair);
        await connectAsync(pair.alice, pair.bob);
        await waitForAsync(() => pair.alice.known.length === 1 && pair.bob.known.length === 1, 5000, 'both asked');

        // Act
        await pair.alice.device.client.restoreSessionAsync(pair.sessionId);
        await pair.bob.device.client.startFreshAsync(pair.sessionId);
        await waitForAsync(() => pair.alice.resets.length === 1, 5000, 'Alice reset');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Assert
        expect(pair.alice.resets[0]).toEqual({ sessionId: pair.sessionId, peerName: 'Bob', removed: 3 });
        expect(await filesAsync(pair.alice, pair.sessionId)).toEqual([]);
        expect(await filesAsync(pair.bob, pair.sessionId)).toEqual([]);
        expect(pair.bob.done.some(record => record.name === file.name)).toBe(false);
        expect(countLogs(pair.alice.device, /^movie\.mp4 resume fromPage/)).toBe(0);
    });

    it('clears each device once when both start fresh at the same time', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await disconnectAsync(pair);
        await connectAsync(pair.alice, pair.bob);
        await waitForAsync(() => pair.alice.known.length === 1 && pair.bob.known.length === 1, 5000, 'both asked');
        const cleared: string[] = [];
        pair.alice.device.client.on('session-cleared', () => cleared.push('Alice'));
        pair.bob.device.client.on('session-cleared', () => cleared.push('Bob'));

        // Act
        const results = await Promise.all([
            pair.alice.device.client.startFreshAsync(pair.sessionId),
            pair.bob.device.client.startFreshAsync(pair.sessionId),
        ]);
        await waitForAsync(
            () => countLogs(pair.alice.device, /started fresh too/) === 1 && countLogs(pair.bob.device, /started fresh too/) === 1,
            5000,
            'both resets heard',
        );
        await pair.alice.device.client.sendFilesAsync([createTestFile('after.bin', 3000, 3105)]);
        await waitForAsync(() => pair.bob.done.some(record => record.name === 'after.bin'), 5000, 'new file');

        // Assert
        expect(results).toEqual([{ removed: 2, isPeerNotified: true }, { removed: 2, isPeerNotified: true }]);
        expect(cleared.sort()).toEqual(['Alice', 'Bob']);
        expect([...pair.alice.resets, ...pair.bob.resets]).toEqual([]);
        expect((await filesAsync(pair.bob, pair.sessionId)).map(record => record.name)).toEqual(['after.bin']);
    });

    it('tells the peer at the next connection when Start fresh ran while the link was down', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        pair.hub.dropLinks();
        await waitForAsync(() => pair.alice.device.client.state === 'lost' && pair.bob.device.client.state === 'lost', 5000, 'both lost');

        // Act
        const result = await pair.alice.device.client.startFreshAsync(pair.sessionId);
        const pending = (await pair.alice.device.client.getSessionAsync(pair.sessionId))?.resetPending;
        await connectAsync(pair.alice, pair.bob);
        await waitForAsync(() => pair.bob.resets.length === 1, 5000, 'Bob reset');

        // Assert
        expect(result).toEqual({ removed: 2, isPeerNotified: false });
        expect(pending).toBe(true);
        expect(pair.bob.resets).toEqual([{ sessionId: pair.sessionId, peerName: 'Alice', removed: 2 }]);
        expect(await filesAsync(pair.bob, pair.sessionId)).toEqual([]);
        expect([...pair.alice.known, ...pair.bob.known]).toEqual([]);
        expect((await pair.alice.device.client.getSessionAsync(pair.sessionId))?.resetPending).toBeUndefined();
    });

    it('asks nothing when the known session holds no files', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, 'Alice');
        const bob = await deviceAsync(hub, 'Bob');
        await pairAsync(alice.device, bob.device);
        await alice.device.client.disconnectAsync();
        await waitForAsync(() => bob.device.client.state === 'closed', 5000, 'Bob closed');

        // Act
        await pairAsync(alice.device, bob.device);

        // Assert
        expect([...alice.known, ...bob.known]).toEqual([]);
    });

    it('asks nothing on a reconnect after link loss in the same page run, and asks again after a reload', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        pair.hub.dropLinks();
        await waitForAsync(() => pair.bob.device.client.state === 'lost', 5000, 'lost');

        // Act
        await pairAsync(pair.alice.device, pair.bob.device);
        const askedAfterLoss = [...pair.alice.known, ...pair.bob.known];
        const reloaded = await reopenAsync(pair.hub, pair.bob);
        await waitForAsync(() => pair.alice.device.client.state === 'closed', 5000, 'Alice closed');
        await connectAsync(pair.alice, reloaded);
        await waitForAsync(() => reloaded.known.length === 1, 5000, 'Bob asked');

        // Assert
        expect(askedAfterLoss).toEqual([]);
        expect(reloaded.known[0]).toMatchObject({ sessionId: pair.sessionId, peerName: 'Alice', receivedCount: 1, sentCount: 1 });
    });

    it('spares the next reconnect the prompt when Restore was chosen after the link dropped', async () => {
        // Arrange
        const pair = await pairWithHistoryAsync();
        await disconnectAsync(pair);
        await connectAsync(pair.alice, pair.bob);
        await waitForAsync(() => pair.alice.known.length === 1 && pair.bob.known.length === 1, 5000, 'both asked');
        pair.hub.dropLinks();
        await waitForAsync(() => pair.alice.device.client.state === 'lost' && pair.bob.device.client.state === 'lost', 5000, 'both lost');

        // Act
        await pair.alice.device.client.restoreSessionAsync(pair.sessionId);
        await pair.bob.device.client.restoreSessionAsync(pair.sessionId);
        await pairAsync(pair.alice.device, pair.bob.device);

        // Assert
        expect(pair.alice.known).toHaveLength(1);
        expect(pair.bob.known).toHaveLength(1);
    });
});
