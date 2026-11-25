import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    KIB,
    PAGE,
    bytesOfAsync,
    countLogs,
    createTestDeviceAsync,
    createTestFile,
    messages,
    pairAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice } from './clientHarness.js';
import type { ClientError, FileRecord, Peer, TestTool } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetwork } from './fakeNetwork.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { createClientStorage } from './storage.js';

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

async function pairedAsync(
    aliceOptions: Partial<Parameters<typeof createTestDeviceAsync>[1]> = {},
    bobOptions: Partial<Parameters<typeof createTestDeviceAsync>[1]> = {},
): Promise<{ hub: ReturnType<typeof createFakeNetworkHub>; alice: TestDevice; bob: TestDevice }> {
    const hub = createFakeNetworkHub();
    const alice = await deviceAsync(hub, { name: 'Alice', ...aliceOptions });
    const bob = await deviceAsync(hub, { name: 'Bob', ...bobOptions });
    await pairAsync(alice, bob);

    return { hub, alice, bob };
}

function collect<Item>(subscribe: (push: (item: Item) => void) => void): Item[] {
    const items: Item[] = [];
    subscribe(item => items.push(item));

    return items;
}

describe('pairing and identity', () => {
    it('opens the same session on both devices and reports the peer', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        const states = collect<string>(push => alice.client.on('state', push));

        // Act
        await pairAsync(alice, bob);

        // Assert
        expect(alice.client.peer).toMatchObject({ name: 'Bob', displayName: 'Bob', deviceId: bob.client.deviceId, protocol: PROTOCOL_VERSION });
        expect(bob.client.peer?.sessionId).toBe(alice.client.peer?.sessionId);
        expect(bob.client.peer?.connectionId).toBe(alice.client.peer?.connectionId);
        expect(states).toEqual(['creating-offer', 'awaiting-answer', 'connecting', 'connected']);
        expect(alice.client.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('adds the end of the device ID when both devices have the same name (DN-03)', async () => {
        // Act
        const { alice, bob } = await pairedAsync({ name: 'Pixel 8' }, { name: 'Pixel 8' });

        // Assert
        expect(alice.client.peer?.displayName).toBe(`Pixel 8 (${bob.client.deviceId.slice(-4)})`);
    });

    it('tells the peer its platform in hello, and pairs with a peer that sends none or an unknown one', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice', platform: 'iPhone' });
        const bob = await deviceAsync(hub, { name: 'Bob', platform: 'Windows' });
        const carol = await deviceAsync(hub, { name: 'Carol' });
        hub.intercept(traffic => (traffic.kind === 'message' && traffic.message.t === 'hello' && traffic.from.index === 1
            ? { message: { ...traffic.message, platform: 'Toaster' } }
            : undefined));

        // Act
        await pairAsync(alice, bob);
        const aliceSaw = alice.client.peer;
        const bobSaw = bob.client.peer;
        await alice.client.disconnectAsync();
        await pairAsync(carol, alice);

        // Assert
        expect(bobSaw?.platform).toBe('iPhone');
        expect(aliceSaw).toMatchObject({ name: 'Bob' });
        expect(aliceSaw?.platform).toBeUndefined();
        expect(alice.client.peer).toMatchObject({ name: 'Carol' });
        expect(alice.client.peer?.platform).toBeUndefined();
        expect(carol.client.peer?.platform).toBe('iPhone');
    });

    it('keeps the peer’s platform in the session, and the last known one when it sends none', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice', platform: 'iPad' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        await pairAsync(alice, bob);
        const first = (await bob.client.listSessionsAsync())[0]?.peerPlatform;
        await alice.client.disconnectAsync();
        hub.intercept(traffic => (traffic.kind === 'message' && traffic.message.t === 'hello' && traffic.from.index === 0
            ? { message: { ...traffic.message, platform: undefined } }
            : undefined));

        // Act
        await pairAsync(alice, bob);
        const sessions = await bob.client.listSessionsAsync();

        // Assert
        expect(first).toBe('iPad');
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.peerPlatform).toBe('iPad');
        expect((await alice.client.listSessionsAsync())[0]?.peerPlatform).toBeUndefined();
    });

    it('saves a new name and tells the peer (DN-02)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const renamed = collect<Peer>(push => bob.client.on('peer', (kind, peer) => kind === 'renamed' && push(peer)));

        // Act
        await alice.client.renameAsync('  Kitchen tablet ');
        await waitForAsync(() => renamed.length === 1, 2000, 'rename');

        // Assert
        expect(alice.client.settings.deviceName).toBe('Kitchen tablet');
        expect(renamed[0]?.name).toBe('Kitchen tablet');
        expect((await bob.client.listSessionsAsync())[0]?.peerName).toBe('Kitchen tablet');
        await expect(alice.client.renameAsync('   ')).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('stops with "Update the app" when the peer speaks another major protocol version (CL-01)', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        hub.intercept(traffic => (traffic.kind === 'message' && traffic.message.t === 'hello' && traffic.from.index === 1
            ? { message: { ...traffic.message, protocol: PROTOCOL_VERSION + 1 } }
            : undefined));
        const errors = collect<ClientError>(push => alice.client.on('error', push));

        // Act
        const offer = await alice.client.startPairingAsync();
        const answer = await bob.client.joinWithCodeAsync(offer.code);
        const pairing = alice.client.completePairingAsync(answer.answerCode);

        // Assert
        await expect(pairing).rejects.toMatchObject({ code: 'protocol-version', message: 'Update the app on this device' });
        expect(errors.map(error => error.code)).toContain('protocol-version');
    });

    it('maps a reused code to code-used', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        const carol = await deviceAsync(hub, { name: 'Carol' });
        const offer = await alice.client.startPairingAsync();
        await bob.client.joinWithCodeAsync(offer.url);

        // Act
        const second = carol.client.joinWithCodeAsync(offer.url);

        // Assert
        await expect(second).rejects.toMatchObject({ code: 'code-used' });
        expect(carol.client.state).toBe('idle');
    });

    it('returns undefined from inspectCode for text that is not a pairing code', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });

        // Act
        const info = alice.client.inspectCode('hello world');

        // Assert
        expect(info).toBeUndefined();
    });
});

describe('transfers', () => {
    it('sends files both ways at once and both verify (test 13)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const toBob = [createTestFile('a1.bin', 3 * PAGE + 7, 21), createTestFile('a2.bin', PAGE, 22)];
        const toAlice = [createTestFile('b1.bin', 2 * PAGE + 1, 23), createTestFile('b2.bin', 5 * KIB, 24)];
        const bobDone = collect<FileRecord>(push => bob.client.on('file-done', push));
        const aliceDone = collect<FileRecord>(push => alice.client.on('file-done', push));

        // Act
        await Promise.all([alice.client.sendFilesAsync(toBob), bob.client.sendFilesAsync(toAlice)]);
        await waitForAsync(() => bobDone.filter(record => record.direction === 'in').length === 2
            && aliceDone.filter(record => record.direction === 'in').length === 2, 10_000, 'both directions');

        // Assert
        for (const [device, files] of [[bob, toBob], [alice, toAlice]] as const) {
            for (const file of files) {
                const record = (device === bob ? bobDone : aliceDone).find(item => item.name === file.name && item.direction === 'in');
                expect(await bytesOfAsync(await device.client.getReceivedFileAsync(record as FileRecord))).toEqual(await bytesOfAsync(file));
            }
        }
    });

    it('records a zero-byte file and goes straight from offer to file-end (TR-11)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        await alice.client.sendFilesAsync([new File([], 'empty.txt', { type: 'text/plain' })]);
        await waitForAsync(() => done.length === 1, 5000, 'done');

        // Assert
        const received = await bob.client.getReceivedFileAsync(done[0] as FileRecord);
        expect(received.size).toBe(0);
        expect(received.name).toBe('empty.txt');
        expect(countLogs(bob, /^empty\.txt page/)).toBe(0);
        expect(done[0]?.rootHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('skips a file sent twice once its whole hash matches, sends a renamed copy as a new file, and sends in full on Send again (test 12)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const file = createTestFile('IMG_2230.HEIC', PAGE + 5, 31, 'image/heic');
        const aliceDone = collect<FileRecord>(push => alice.client.on('file-done', push));
        const aliceStates = collect<FileRecord>(push => alice.client.on('file-state', push));
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => aliceDone.length === 1, 5000, 'first');

        // Act
        await alice.client.sendFilesAsync([new File([file], 'IMG_2230.HEIC', { type: 'image/heic' })]);
        await waitForAsync(() => aliceDone.length === 2, 5000, 'second');
        await alice.client.sendFilesAsync([new File([file], 'renamed copy.heic', { type: 'image/heic' })]);
        await waitForAsync(() => aliceDone.length === 3, 5000, 'renamed');
        await alice.client.sendAgainAsync(aliceDone[1] as FileRecord);
        await waitForAsync(() => aliceDone.length === 4, 5000, 'again');

        // Assert
        expect(aliceDone[1]).toMatchObject({ state: 'done', note: 'already-on-peer', fileId: aliceDone[0]?.fileId, rootHash: aliceDone[0]?.rootHash });
        expect(aliceStates.some(record => record.fileId === aliceDone[0]?.fileId && record.state === 'verifying' && record.note === 'checking')).toBe(true);
        expect(messages(bob)).toContain('IMG_2230.HEIC have verified=true');
        expect(messages(alice)).toContain('IMG_2230.HEIC already on Bob, root hash matches');
        expect(aliceDone[2]).toMatchObject({ name: 'renamed copy.heic', state: 'done' });
        expect(aliceDone[2]?.note).toBeUndefined();
        expect(aliceDone[2]?.fileId).not.toBe(aliceDone[0]?.fileId);
        expect(aliceDone[3]?.note).toBeUndefined();
        expect(countLogs(bob, /page \d+\/2 saved/)).toBe(6);
        const received = await bob.client.listFilesAsync({ sessionId: bob.client.peer?.sessionId ?? '' });
        expect(received.map(record => record.name).sort()).toEqual(['IMG_2230.HEIC', 'renamed copy.heic']);
    });

    it('nacks a page corrupted in transit, resends it and verifies (tests 20, 30)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const tools = collect<readonly TestTool[]>(push => alice.client.on('test-tools', push));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const file = createTestFile('corrupt.bin', 3 * PAGE, 41);

        // Act
        alice.client.setTestTool('corrupt-pages', true);
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(tools).toEqual([['corrupt-pages']]);
        expect(alice.client.activeTestTools).toEqual(['corrupt-pages']);
        expect(countLogs(bob, /^corrupt\.bin page 1\/3 hash mismatch, nack/)).toBe(1);
        expect(countLogs(alice, /^corrupt\.bin nack page 1\/3, resending \(1\/3\)/)).toBe(1);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });

    it('re-acks a page whose ack was lost without writing it again (test 30)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        bob.client.setTestTool('drop-ack', true);
        await alice.client.sendFilesAsync([createTestFile('one-page.bin', 100 * KIB, 51)]);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(countLogs(bob, /^one-page\.bin ack for page 1 dropped by the test tool/)).toBe(1);
        expect(countLogs(alice, /^one-page\.bin page 1\/1 no ack, resending/)).toBe(1);
        expect(countLogs(bob, /^one-page\.bin page 1 already saved, re-acked without writing/)).toBe(1);
        expect(countLogs(bob, /^one-page\.bin page 1\/1 saved/)).toBe(1);
    }, 15_000);

    it('rejects a file before it starts when the receiver lacks space (tests 15, TR-07)', async () => {
        // Arrange
        const { alice } = await pairedAsync({}, { freeBytes: () => 300 * KIB });
        const failures = collect<{ record: FileRecord; error: ClientError }>(push => alice.client.on('file-failed', (record, error) => push({ record, error })));

        // Act
        await alice.client.sendFilesAsync([createTestFile('big.bin', 2 * PAGE, 61)]);
        await waitForAsync(() => failures.length === 1, 5000, 'failure');

        // Assert
        expect(failures[0]?.error).toMatchObject({ code: 'no-space', message: 'Needs 512 KiB, has 300 KiB' });
        expect(failures[0]?.record).toMatchObject({ state: 'failed', note: 'no-space' });
    });

    it('waits for the user when Ask before receiving is on (SP-07)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({ settings: { offerReplyTimeoutMs: 5000 } }, { settings: { askBeforeReceiving: true } });
        const incoming = collect<FileRecord>(push => bob.client.on('file-incoming', push));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const failed = collect<ClientError>(push => alice.client.on('file-failed', (_, error) => push(error)));

        // Act
        await alice.client.sendFilesAsync([createTestFile('wanted.bin', PAGE, 71)]);
        await waitForAsync(() => incoming.length === 1, 5000, 'incoming');
        await bob.client.acceptIncomingAsync(incoming[0] as FileRecord);
        await waitForAsync(() => done.length === 1, 5000, 'done');
        await alice.client.sendFilesAsync([createTestFile('unwanted.bin', PAGE, 72)]);
        await waitForAsync(() => incoming.length === 2, 5000, 'second incoming');
        await bob.client.rejectIncomingAsync(incoming[1] as FileRecord, 'declined');
        await waitForAsync(() => failed.length === 1, 5000, 'declined');

        // Assert
        expect(incoming[0]).toMatchObject({ name: 'wanted.bin', state: 'incoming' });
        expect(messages(alice)).toContain('wanted.bin waiting for Bob to accept');
        expect(failed[0]?.code).toBe('canceled');
    });

    it('keeps a running file at its page size and uses the new one for the next file (tests 22, 27)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({ settings: { maxConcurrentFiles: 1 } });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        let hasChanged = false;
        hub.intercept(traffic => {
            if (!hasChanged && traffic.kind === 'message' && traffic.message.t === 'ack') {
                hasChanged = true;
                void alice.client.configureAsync({ pageSize: 512 * KIB, pageAckTimeoutMs: 3000, maxBuffered: 8 * 1024 * KIB });
            }

            return undefined;
        });

        // Act
        await alice.client.sendFilesAsync([createTestFile('first.bin', 4 * PAGE, 81), createTestFile('second.bin', 4 * PAGE, 82)]);
        await waitForAsync(() => done.length === 2, 10_000, 'done');

        // Assert
        expect(messages(alice)).toContain('first.bin accept fromPage=0 pageSize=256 KiB slot=1');
        expect(messages(alice)).toContain('second.bin accept fromPage=0 pageSize=512 KiB slot=1');
        expect(countLogs(bob, /^first\.bin page \d+\/4 saved/)).toBe(4);
        expect(countLogs(bob, /^second\.bin page \d+\/2 saved/)).toBe(2);
        const network = hub.networks[0] as FakeNetwork;
        expect(network.configureCalls.at(-1)).toMatchObject({ maxBuffered: 8 * 1024 * KIB, timeouts: expect.objectContaining({ lostMs: 10_000 }) });
    });

    it('pauses with Storage full, keeps the saved pages and resumes once there is room (PW-08)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync();
        const errors = collect<ClientError>(push => bob.client.on('error', push));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        let acks = 0;
        hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'ack' && ++acks === 2) {
                bob.client.setTestTool('fill-storage', true);
            }

            return undefined;
        });
        const file = createTestFile('large.bin', 6 * PAGE, 91);

        // Act
        await alice.client.sendFilesAsync([file]);
        await waitForAsync(() => errors.length === 1, 5000, 'storage full');
        const paused = (await bob.client.listFilesAsync({ sessionId: bob.client.peer?.sessionId ?? '', direction: 'in' }))[0];
        await waitForAsync(async () => (await alice.client.listFilesAsync({ sessionId: alice.client.peer?.sessionId ?? '' }))[0]?.note === 'storage-full', 5000, 'sender paused');
        bob.client.setTestTool('fill-storage', false);
        await bob.client.resumeAsync(paused as FileRecord);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(errors[0]?.code).toBe('storage-full');
        expect(paused).toMatchObject({ state: 'paused', pausedBy: 'storage', note: 'storage-full' });
        expect(paused?.pagination?.pagesDone).toBeGreaterThanOrEqual(2);
        expect(messages(alice)).toContain(`large.bin resume fromPage=${(paused?.pagination?.pagesDone ?? 0) - 1} pageSize=256 KiB`);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });

    it('cancels from the sender and deletes the partial file on both sides (TR-09)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync();
        const states = collect<FileRecord>(push => bob.client.on('file-state', push));
        let fileId = '';
        hub.intercept(traffic => {
            if (!fileId && traffic.kind === 'message' && traffic.message.t === 'ack') {
                fileId = traffic.message.fileId as string;
                void alice.client.cancelAsync({ sessionId: alice.client.peer?.sessionId ?? '', fileId });
            }

            return undefined;
        });

        // Act
        await alice.client.sendFilesAsync([createTestFile('cancel.bin', 8 * PAGE, 101)]);
        await waitForAsync(() => states.some(record => record.state === 'canceled'), 5000, 'canceled');
        await alice.client.cancelAsync({ sessionId: alice.client.peer?.sessionId ?? '', fileId });

        // Assert
        const sessionId = bob.client.peer?.sessionId ?? '';
        expect(states.filter(record => record.state === 'canceled').every(record => record.pagination == null && !record.hasData)).toBe(true);
        const records = await bob.client.listFilesAsync({ sessionId });
        expect(records[0]).toMatchObject({ state: 'canceled', hasData: false });
        expect(records[0]?.pagination).toBeUndefined();
        expect(await createClientStorage(bob.database).readPagesAsync(sessionId, fileId)).toEqual([]);
        const sent = (await alice.client.listFilesAsync({ sessionId }))[0];
        expect(sent?.state).toBe('canceled');
        expect(sent?.pagination).toBeUndefined();
    });

    it('pauses and resumes a sending file, and treats repeated calls as no-ops (CL-06)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync();
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const sent = collect<FileRecord>(push => alice.client.on('file-done', push));
        let fileId = '';
        let isPaused = false;
        hub.intercept(traffic => {
            if (!isPaused && traffic.kind === 'message' && traffic.message.t === 'ack') {
                isPaused = true;
                fileId = traffic.message.fileId as string;
                void alice.client.pauseAsync({ sessionId: alice.client.peer?.sessionId ?? '', fileId });
            }

            return undefined;
        });
        await alice.client.sendFilesAsync([createTestFile('pause.bin', 6 * PAGE, 111)]);
        await waitForAsync(async () => (await alice.client.listFilesAsync({ sessionId: alice.client.peer?.sessionId ?? '' }))[0]?.pausedBy === 'user', 5000, 'paused');

        // Act
        const ref = { sessionId: alice.client.peer?.sessionId ?? '', fileId };
        await alice.client.pauseAsync(ref);
        await alice.client.resumeAsync(ref);
        await alice.client.resumeAsync(ref);
        await waitForAsync(() => done.length === 1 && sent.length === 1, 10_000, 'done on both sides');
        await alice.client.cancelAsync(ref);

        // Assert
        expect(countLogs(alice, /^pause\.bin offer slot=\d resume/)).toBe(1);
        expect((await alice.client.listFilesAsync({ sessionId: alice.client.peer?.sessionId ?? '' }))[0]?.state).toBe('done');
    });

    it('asks for persistent storage once, at the first transfer (PW-06)', async () => {
        // Arrange
        const persist = vi.fn(async () => true);
        const { alice, bob } = await pairedAsync({ persistStorageAsync: persist }, {});
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        await alice.client.sendFilesAsync([createTestFile('x.bin', 10, 121)]);
        await alice.client.sendFilesAsync([createTestFile('y.bin', 10, 122)]);
        await waitForAsync(() => done.length === 2, 5000, 'done');

        // Assert
        expect(persist).toHaveBeenCalledTimes(1);
        expect((await alice.client.getStorageInfoAsync()).persisted).toBe(true);
    });

    it('drops invalid messages and disconnects after repeated ones (CL-03)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync();
        const network = hub.networks[1] as FakeNetwork;

        // Act
        network.send(1, { t: 'ack', re: 'x', fileId: 'not-a-file-id', page: -1 });
        await waitForAsync(() => countLogs(alice, /^invalid message dropped/) === 1, 2000, 'first invalid');
        const stateAfterOne = alice.client.state;
        for (let index = 0; index < 9; index++) {
            network.send('control', { t: 'unknown-type' });
        }

        await waitForAsync(() => alice.client.state === 'closed', 2000, 'closed');

        // Assert
        expect(stateAfterOne).toBe('connected');
        expect(messages(alice)).toContain('invalid message dropped: ack: bad field fileId');
        expect(messages(alice)).toContain('invalid message dropped: unknown type unknown-type');
        await waitForAsync(() => bob.client.state === 'closed', 2000, 'peer closed');
    });

    it('streams resume logs to the peer when Show peer logs is on (DL-15)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync();
        await alice.client.configureAsync({ peerLogs: true });
        await bob.client.configureAsync({ peerLogs: true, logSinks: ['memory', 'peer'] });

        // Act
        bob.controller.logger.info('resume', 'peer sync: IMG_2231.MOV in, 1312/2048 pages');
        bob.controller.logger.info('xfer', 'not forwarded');

        // Assert
        await waitForAsync(() => alice.memory.entries().some(entry => entry.peer === 'Bob'), 3000, 'peer logs');
        const forwarded = alice.memory.entries().filter(entry => entry.peer === 'Bob');
        expect(forwarded.map(entry => entry.msg)).toContain('peer sync: IMG_2231.MOV in, 1312/2048 pages');
        expect(forwarded.map(entry => entry.msg)).not.toContain('not forwarded');
    });

    it('retries the whole file once when the root hash does not match, then fails (§7.3)', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync();
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const failed = collect<ClientError>(push => alice.client.on('file-failed', (_, error) => push(error)));
        let wrongRoots = 1;
        hub.intercept(traffic => (traffic.kind === 'message' && traffic.message.t === 'file-end' && wrongRoots-- > 0
            ? { message: { ...traffic.message, rootHash: '0'.repeat(64) } }
            : undefined));

        // Act
        await alice.client.sendFilesAsync([createTestFile('retry.bin', 2 * PAGE, 131)]);
        await waitForAsync(() => done.length === 1, 10_000, 'retried file');
        wrongRoots = 2;
        await alice.client.sendFilesAsync([createTestFile('broken.bin', PAGE, 132)]);
        await waitForAsync(() => failed.length === 1, 10_000, 'failed file');

        // Assert
        expect(countLogs(alice, /^retry\.bin root hash mismatch, sending again from page 0/)).toBe(1);
        expect(countLogs(bob, /^retry\.bin page \d+\/2 saved/)).toBe(4);
        expect(failed[0]).toMatchObject({ code: 'verify-failed' });
    });

    it('applies per-session transfer overrides without touching the defaults (AP-05)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({ settings: { maxConcurrentFiles: 1 } });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        await alice.client.configureSessionAsync({ pageSize: 512 * KIB });
        await alice.client.sendFilesAsync([createTestFile('session.bin', 4 * PAGE, 141)]);
        await waitForAsync(() => done.length === 1, 5000, 'done');

        // Assert
        expect(messages(alice)).toContain('session.bin accept fromPage=0 pageSize=512 KiB slot=1');
        expect(alice.client.settings.pageSize).toBe(PAGE);
        expect((await alice.client.getSessionAsync(alice.client.peer?.sessionId ?? ''))?.transferSettings).toEqual({ pageSize: 512 * KIB });
    });

    it('removes a session override given as undefined, falling back to the default (AP-05)', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({ settings: { maxConcurrentFiles: 1 } });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        await alice.client.configureSessionAsync({ pageSize: 512 * KIB, maxConcurrentFiles: 2 });

        // Act
        await alice.client.configureSessionAsync({ pageSize: undefined });
        await alice.client.sendFilesAsync([createTestFile('reset.bin', 2 * PAGE, 151)]);
        await waitForAsync(() => done.length === 1, 5000, 'done');

        // Assert
        expect((await alice.client.getSessionAsync(alice.client.peer?.sessionId ?? ''))?.transferSettings).toEqual({ maxConcurrentFiles: 2 });
        expect(messages(alice)).toContain('reset.bin accept fromPage=0 pageSize=256 KiB slot=1');
    });

    it('keeps settings across a reload, refusing out-of-range values', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        await alice.client.configureAsync({ askBeforeReceiving: true, keepHistoryDays: 30 });

        // Act
        await alice.client.configureAsync({ askBeforeReceiving: 'maybe' as never });
        alice.client.dispose();
        const reopened = await deviceAsync(hub, { name: 'Alice', factory: alice.factory });

        // Assert
        expect(reopened.client.settings).toMatchObject({ askBeforeReceiving: true, keepHistoryDays: 30 });
        expect(reopened.client.deviceId).toBe(alice.client.deviceId);
    });

    it('reports diagnostics with the active slots', async () => {
        // Arrange
        const { alice } = await pairedAsync();

        // Act
        const diagnostics = await alice.client.getDiagnosticsAsync();

        // Assert
        expect(diagnostics).toMatchObject({ state: 'connected', pairs: [], slots: [], checkCode: 'FAKE', maxMessageSize: 256 * KIB });
    });
});
