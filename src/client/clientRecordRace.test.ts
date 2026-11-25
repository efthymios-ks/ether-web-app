import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PAGE,
    PHOTO_MEDIA,
    createTestDeviceAsync,
    createTestFile,
    delayWritesTo,
    pairAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import type { FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';

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

// A mix like the one that stalled on a phone: small one-page images among other files.
function mixedSelection(seed: number): File[] {
    const images = Array.from({ length: 6 }, (_, index) => createTestFile(`canvas-${index}.png`, 20_000 + index * 700, seed + index, 'image/png'));
    const others = Array.from({ length: 4 }, (_, index) => createTestFile(`doc-${index}.bin`, PAGE + index * 5000, seed + 10 + index));

    return [...images, ...others];
}

async function sendAndSettleAsync(
    hub: FakeNetworkHub,
    receiverOptions: Partial<TestDeviceOptions>,
    senderOptions: Partial<TestDeviceOptions> = {},
): Promise<{ readonly receiver: TestDevice; readonly sessionId: string; readonly done: FileRecord[] }> {
    const sender = await createTestDeviceAsync(hub, { name: 'Desk', media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true }, ...senderOptions });
    const receiver = await createTestDeviceAsync(hub, { name: 'Phone', media: PHOTO_MEDIA, ...receiverOptions });
    devices.push(sender, receiver);
    await pairAsync(sender, receiver);
    const done = collect<FileRecord>(push => receiver.client.on('file-done', push));
    const sent = collect<FileRecord>(push => sender.client.on('file-done', push));
    const files = mixedSelection(1800);
    await sender.client.sendFilesAsync(files);
    await waitForAsync(() => done.length === files.length && sent.length === files.length, 10_000, 'all done');
    // Let every thumbnail write, own thumbnail and fallback that is still in flight finish.
    await new Promise(resolve => setTimeout(resolve, 400));

    return { receiver, sessionId: receiver.client.peer?.sessionId ?? '', done };
}

describe('received records never fall back to an older state', () => {
    it('keeps every file done when the sender\'s thumbnails are still being written as files finish', async () => {
        // Arrange
        const hub = createFakeNetworkHub();

        // Act
        const { receiver, sessionId } = await sendAndSettleAsync(hub, { wrapDatabase: delayWritesTo('thumbs', 120) });

        // Assert
        const records = await receiver.client.listFilesAsync({ sessionId, direction: 'in' });
        expect(records.map(record => [record.name, record.state])).toEqual(records.map(record => [record.name, 'done']));
        expect(records.every(record => record.pagination == null && record.completedAt != null && record.hasData)).toBe(true);
        expect(records.filter(record => record.kind === 'image').every(record => record.hasThumbnail)).toBe(true);
        expect(await receiver.client.getClearSummaryAsync(sessionId, 'received')).toMatchObject({ finished: 10, unfinished: 0 });
    });

    it('keeps every file done when the receiver makes its own thumbnails slowly', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const cannotDecode = { ...PHOTO_MEDIA, createThumbnailAsync: async () => undefined };

        // Act
        const { receiver, sessionId } = await sendAndSettleAsync(hub, { wrapDatabase: delayWritesTo('thumbs', 120) }, { media: cannotDecode });

        // Assert
        const records = await receiver.client.listFilesAsync({ sessionId, direction: 'in' });
        expect(records.every(record => record.state === 'done' && record.pagination == null)).toBe(true);
        expect(records.filter(record => record.kind === 'image').every(record => record.hasThumbnail)).toBe(true);
    });

    it.each([0, 15, 40, 90])('keeps every file done with thumbnail writes %i ms late', async delayMs => {
        // Arrange
        const hub = createFakeNetworkHub({ delayMs: 1 });

        // Act
        const { receiver, sessionId } = await sendAndSettleAsync(hub, { wrapDatabase: delayWritesTo('thumbs', delayMs) });

        // Assert
        const records = await receiver.client.listFilesAsync({ sessionId, direction: 'in' });
        expect(records.filter(record => record.state !== 'done').map(record => `${record.name}:${record.state}`)).toEqual([]);
    });

    it('keeps a saved file saved when a thumbnail lands after it was marked saved', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const sender = await createTestDeviceAsync(hub, { name: 'Desk', media: PHOTO_MEDIA, settings: { sendThumbnailsFirst: true } });
        const receiver = await createTestDeviceAsync(hub, { name: 'Phone', media: PHOTO_MEDIA, wrapDatabase: delayWritesTo('thumbs', 150) });
        devices.push(sender, receiver);
        await pairAsync(sender, receiver);
        const done = collect<FileRecord>(push => receiver.client.on('file-done', push));
        await sender.client.sendFilesAsync([createTestFile('quick.png', 9000, 1850, 'image/png')]);
        await waitForAsync(() => done.length === 1, 5000, 'done');

        // Act
        await receiver.client.markSavedAsync(done[0]?.sessionId ?? '', [done[0]?.fileId ?? '']);
        await new Promise(resolve => setTimeout(resolve, 400));

        // Assert
        const record = (await receiver.client.listFilesAsync({ sessionId: done[0]?.sessionId ?? '' }))[0];
        expect(record).toMatchObject({ state: 'done', hasThumbnail: true });
        expect(record?.savedAt).toBeTypeOf('number');
    });
});
