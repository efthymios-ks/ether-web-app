import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PAGE,
    bytesOfAsync,
    countLogs,
    createTestDeviceAsync,
    createTestFile,
    messages,
    dropWhenPartialAsync,
    pairAsync,
    reopenDeviceAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice } from './clientHarness.js';
import { UNFINISHED_STATES } from './clientTypes.js';
import type { FileRecord, SyncDecision } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';

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

async function reopenAsync(...args: Parameters<typeof reopenDeviceAsync>): Promise<TestDevice> {
    const device = await reopenDeviceAsync(...args);
    devices.push(device);

    return device;
}

async function unfinishedAsync(device: TestDevice, direction: 'in' | 'out'): Promise<FileRecord[]> {
    const sessionId = (await device.client.listSessionsAsync())[0]?.sessionId ?? '';

    return device.client.listFilesAsync({ sessionId, direction, states: UNFINISHED_STATES });
}

describe('resume after re-pairing (§7.4)', () => {
    it.each([1, 2, 4])('resumes each partial file from its own page with concurrency %i (tests 21, 30)', async concurrency => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice', settings: { maxConcurrentFiles: concurrency } });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        await pairAsync(alice, bob);
        const files = Array.from({ length: 20 }, (_, index) => createTestFile(`file-${index}.bin`, 4 * PAGE - index * 1000, index + 10));
        const done = new Set<string>();
        bob.client.on('file-done', record => done.add(record.fileId));
        const dropped = dropWhenPartialAsync(hub, Math.min(2, concurrency), 4);

        // Act
        await alice.client.sendFilesAsync(files);
        await dropped;
        await waitForAsync(() => alice.client.state === 'lost' && bob.client.state === 'lost', 5000, 'both lost');
        const partials = (await unfinishedAsync(bob, 'in')).filter(file => (file.pagination?.pagesDone ?? 0) > 0);
        await pairAsync(alice, bob);
        await waitForAsync(() => done.size === 20, 20_000, 'all files done');

        // Assert
        expect(partials.length).toBeGreaterThanOrEqual(Math.min(2, concurrency));
        for (const partial of partials) {
            const pagesDone = partial.pagination?.pagesDone ?? 0;
            expect(messages(alice)).toContain(`${partial.name} resume fromPage=${pagesDone - 1} pageSize=256 KiB`);
        }

        const sessions = await bob.client.listSessionsAsync();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.unfinishedCount).toBe(0);
        for (const [index, file] of files.entries()) {
            const received = await bob.client.listFilesAsync({ sessionId: sessions[0]?.sessionId ?? '', direction: 'in' });
            const record = received.find(item => item.name === `file-${index}.bin`);
            expect(record?.state).toBe('done');
            expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(record as FileRecord))).toEqual(await bytesOfAsync(file));
        }
    }, 30_000);

    it('lists unfinished files with page X of Y when the same devices pair again (test 23)', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice', settings: { maxConcurrentFiles: 1 } });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        await pairAsync(alice, bob);
        const firstSession = alice.client.peer?.sessionId;
        const dropped = dropWhenPartialAsync(hub, 1, 6, 1);
        await alice.client.sendFilesAsync([createTestFile('video.mov', 6 * PAGE, 3)]);
        await dropped;
        await waitForAsync(() => bob.client.state === 'lost', 5000, 'lost');

        // Act
        const sessions = await bob.client.listSessionsAsync();
        const unfinished = await unfinishedAsync(bob, 'in');

        // Assert
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.unfinishedCount).toBe(1);
        expect(sessions[0]?.connections[0]?.end).toBeTypeOf('number');
        expect(unfinished[0]).toMatchObject({ name: 'video.mov', state: 'paused', pausedBy: 'link' });
        expect(unfinished[0]?.pagination).toMatchObject({ totalPages: 6, slot: null });
        expect(unfinished[0]?.pagination?.pagesDone).toBeGreaterThanOrEqual(2);
        await pairAsync(alice, bob);
        expect(alice.client.peer?.sessionId).toBe(firstSession);
        expect((await bob.client.listSessionsAsync())[0]?.connections).toHaveLength(2);
    });

    it('asks for the file again after the sender reloads, then resumes at the right page (test 9)', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        await pairAsync(alice, bob);
        const file = createTestFile('IMG_2231.MOV', 10 * PAGE, 7, 'video/quicktime');
        const dropped = dropWhenPartialAsync(hub, 1, 10, 2);
        await alice.client.sendFilesAsync([file]);
        await dropped;
        await waitForAsync(() => bob.client.state === 'lost', 5000, 'lost');
        const savedPages = (await unfinishedAsync(bob, 'in'))[0]?.pagination?.pagesDone ?? 0;

        // Act
        const reloaded = await reopenAsync(hub, alice);
        const needsFile: FileRecord[] = [];
        reloaded.client.on('needs-file', record => needsFile.push(record));
        await pairAsync(reloaded, bob);
        await waitForAsync(() => needsFile.length === 1, 5000, 'needs-file');
        const done: FileRecord[] = [];
        bob.client.on('file-done', record => done.push(record));
        const match = await reloaded.client.resumeWithFilesAsync([file, createTestFile('other.bin', 1000, 99)]);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(savedPages).toBeGreaterThanOrEqual(3);
        expect(needsFile[0]).toMatchObject({ name: 'IMG_2231.MOV', state: 'needs-file' });
        expect(match.matched.map(record => record.name)).toEqual(['IMG_2231.MOV']);
        expect(match.unmatched.map(item => item.name)).toEqual(['other.bin']);
        expect(messages(reloaded)).toContain(`IMG_2231.MOV resume fromPage=${savedPages - 1} pageSize=256 KiB`);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });

    it('resumes at its last saved page after the receiver reopens, writing only that page twice (test 8)', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        await pairAsync(alice, bob);
        const file = createTestFile('movie.mp4', 10 * PAGE, 8, 'video/mp4');
        const dropped = dropWhenPartialAsync(hub, 1, 10, 5);
        await alice.client.sendFilesAsync([file]);
        await dropped;
        await waitForAsync(() => alice.client.state === 'lost', 5000, 'lost');
        const savedPages = (await unfinishedAsync(bob, 'in'))[0]?.pagination?.pagesDone ?? 0;

        // Act
        const reopened = await reopenAsync(hub, bob);
        const done: FileRecord[] = [];
        reopened.client.on('file-done', record => done.push(record));
        await pairAsync(alice, reopened);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        const savedLines = [...messages(bob), ...messages(reopened)].filter(message => /^movie\.mp4 page \d+\/10 saved/.test(message));
        const writes = new Map<number, number>();
        for (const line of savedLines) {
            const page = Number(/ page (\d+)\/10 /.exec(line)?.[1]);
            writes.set(page, (writes.get(page) ?? 0) + 1);
        }

        expect(savedPages).toBeGreaterThanOrEqual(6);
        expect(savedLines).toHaveLength(11);
        expect([...writes.entries()].filter(([, count]) => count > 1)).toEqual([[savedPages, 2]]);
        expect(writes.size).toBe(10);
        expect(messages(alice)).toContain(`movie.mp4 resume fromPage=${savedPages - 1} pageSize=256 KiB`);
        expect(await bytesOfAsync(await reopened.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });

    it('adopts the partial from the old session after the sender cleared its data (test 10)', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        await pairAsync(alice, bob);
        const file = createTestFile('archive.zip', 8 * PAGE, 9, 'application/zip');
        const dropped = dropWhenPartialAsync(hub, 1, 8, 3);
        await alice.client.sendFilesAsync([file]);
        await dropped;
        await waitForAsync(() => bob.client.state === 'lost', 5000, 'lost');
        const savedPages = (await unfinishedAsync(bob, 'in'))[0]?.pagination?.pagesDone ?? 0;
        const oldSession = (await bob.client.listSessionsAsync())[0]?.sessionId ?? '';

        // Act
        alice.client.dispose();
        const fresh = await deviceAsync(hub, { name: 'Alice' });
        const decisions: SyncDecision[] = [];
        bob.client.on('sync', items => decisions.push(...items));
        const done: FileRecord[] = [];
        bob.client.on('file-done', record => done.push(record));
        await pairAsync(fresh, bob);
        await fresh.client.sendFilesAsync([file]);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(fresh.client.peer?.sessionId).not.toBe(oldSession);
        expect(decisions).toContainEqual(expect.objectContaining({ decision: 'adopted', fromPage: savedPages - 1, direction: 'in' }));
        expect(messages(fresh)).toContain(`archive.zip prefixHash match, ${savedPages - 1} pages`);
        expect(messages(fresh)).toContain(`archive.zip resume fromPage=${savedPages - 1} pageSize=256 KiB`);
        expect(await bob.client.listFilesAsync({ sessionId: oldSession })).toEqual([]);
        expect(await bytesOfAsync(await bob.client.getReceivedFileAsync(done[0] as FileRecord))).toEqual(await bytesOfAsync(file));
    });

    it('restarts from page 0 with a notice when the receiver lost its data (test 11)', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const alice = await deviceAsync(hub, { name: 'Alice' });
        const bob = await deviceAsync(hub, { name: 'Bob' });
        await pairAsync(alice, bob);
        const file = createTestFile('scan.pdf', 6 * PAGE, 11, 'application/pdf');
        const dropped = dropWhenPartialAsync(hub, 1, 6, 2);
        await alice.client.sendFilesAsync([file]);
        await dropped;
        await waitForAsync(() => bob.client.state === 'lost', 5000, 'lost');

        // Act
        await bob.client.clearAllAsync();
        const decisions: SyncDecision[] = [];
        alice.client.on('sync', items => decisions.push(...items));
        const done: FileRecord[] = [];
        alice.client.on('file-done', record => done.push(record));
        await pairAsync(alice, bob);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(decisions).toContainEqual(expect.objectContaining({ decision: 'data-lost', fromPage: 0, direction: 'out' }));
        expect(messages(alice)).toContain('scan.pdf resume fromPage=0 pageSize=256 KiB');
        expect(done[0]?.note).toBe('data-lost');
        expect(countLogs(bob, /^scan\.pdf page \d+\/6 saved/)).toBeGreaterThanOrEqual(6);
    });
});
