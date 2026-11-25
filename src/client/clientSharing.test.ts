import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { PAGE, createTestDeviceAsync, createTestFile, pairAsync, waitForAsync } from './clientHarness.js';
import type { TestDevice } from './clientHarness.js';
import type { FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';

// Running batches share the sender's slots: a batch picked while another sends starts on the next free slot.

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
    readonly bobDone: FileRecord[];
    // Names of the files in the order their offers went out.
    readonly started: string[];
}

async function pairedAsync(slots: number): Promise<Pair> {
    const hub = createFakeNetworkHub();
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', settings: { maxConcurrentFiles: slots } });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob' });
    devices.push(alice, bob);
    await pairAsync(alice, bob);
    const bobDone: FileRecord[] = [];
    bob.client.on('file-done', record => bobDone.push(record));
    const started: string[] = [];
    hub.intercept(entry => {
        if (entry.kind === 'message' && entry.message.t === 'offer') {
            started.push(entry.message.name as string);
        }

        return undefined;
    });

    return { hub, alice, bob, sessionId: alice.client.peer?.sessionId ?? '', bobDone, started };
}

function files(prefix: string, count: number, seed: number, pages: number): File[] {
    return Array.from({ length: count }, (_, index) => createTestFile(`${prefix}-${String(index + 1).padStart(2, '0')}.bin`, pages * PAGE - 5, seed + index));
}

describe('batches share the slots', () => {
    it('starts a batch picked during a 40-file batch on the next free slot, and both finish with every file once', async () => {
        // Arrange
        const { hub, alice, bob, sessionId, bobDone, started } = await pairedAsync(2);
        hub.delayMs = 1;
        await alice.client.sendFilesAsync(files('big', 40, 5001, 2));
        await waitForAsync(() => bobDone.length >= 3, 10_000, 'big batch moving');

        // Act
        const startedBefore = started.length;
        await alice.client.sendFilesAsync(files('small', 5, 5101, 1));
        await waitForAsync(() => bobDone.length === 45, 20_000, 'both batches');

        // Assert
        const afterPick = started.slice(startedBefore);
        const firstSmall = afterPick.findIndex(name => name.startsWith('small'));
        expect(firstSmall).toBeGreaterThanOrEqual(0);
        expect(firstSmall).toBeLessThanOrEqual(2);
        const lastSmall = afterPick.map(name => name.startsWith('small')).lastIndexOf(true);
        expect(afterPick.slice(lastSmall + 1).filter(name => name.startsWith('big')).length).toBeGreaterThan(10);
        expect(new Set(bobDone.map(record => record.name)).size).toBe(45);
        expect(new Set(started).size).toBe(started.length);
        const received = await bob.client.listFilesAsync({ sessionId, direction: 'in' });
        expect(received.filter(record => record.state === 'done')).toHaveLength(45);
        await waitForAsync(async () => (await alice.client.listBatchesAsync(sessionId)).every(batch => batch.finishedAt != null), 5000, 'batches finished');
        const batches = await alice.client.listBatchesAsync(sessionId);
        expect(batches.map(batch => [batch.itemCount, batch.received]).sort()).toEqual([[40, 40], [5, 5]]);
    }, 30_000);

    it('keeps plain pick order with a single batch', async () => {
        // Arrange
        const { hub, alice, bobDone, started } = await pairedAsync(2);
        hub.delayMs = 1;
        const picked = files('one', 8, 5201, 2);

        // Act
        await alice.client.sendFilesAsync(picked);
        await waitForAsync(() => bobDone.length === 8, 10_000, 'sent');

        // Assert
        expect(started).toEqual(picked.map(file => file.name));
    });
});
