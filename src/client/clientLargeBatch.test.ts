import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileMetadata, MediaToolkit } from '../media/metadataTypes.js';
import type { Message } from '../network/networkTypes.js';
import {
    KIB,
    createTestDeviceAsync,
    createTestFile,
    dropWhenPartialAsync,
    messages,
    pairAsync,
    waitForAsync,
} from './clientHarness.js';
import type { TestDevice, TestDeviceOptions } from './clientHarness.js';
import type { BatchProgress, ClientError, FileRecord } from './clientTypes.js';
import { createFakeNetworkHub } from './fakeNetwork.js';
import type { FakeNetworkHub } from './fakeNetwork.js';

const devices: TestDevice[] = [];
const encoder = new TextEncoder();

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

async function pairedAsync(
    hubOptions: Parameters<typeof createFakeNetworkHub>[0] = {},
    senderOptions: Partial<TestDeviceOptions> = {},
): Promise<{ readonly hub: FakeNetworkHub; readonly alice: TestDevice; readonly bob: TestDevice }> {
    const hub = createFakeNetworkHub(hubOptions);
    const alice = await createTestDeviceAsync(hub, { name: 'Alice', ...senderOptions });
    const bob = await createTestDeviceAsync(hub, { name: 'Bob' });
    devices.push(alice, bob);
    await pairAsync(alice, bob);

    return { hub, alice, bob };
}

const GREEK_TITLE = 'Τα παιδιά του Πειραιά και το τραγούδι της θάλασσας που δεν τελειώνει ποτέ';

// Tracks named like a Greek music library, picked as a folder, with file paths as webkitRelativePath.
function greekLibrary(count: number): { readonly files: File[]; readonly paths: string[] } {
    const files: File[] = [];
    const paths: string[] = [];
    for (let index = 0; index < count; index++) {
        const extension = index % 3 === 0 ? 'm4a' : 'mp3';
        const name = `${String(index + 1).padStart(3, '0')} ${GREEK_TITLE.slice(0, 30 + (index % 40))}.${extension}`;
        files.push(createTestFile(name, 300 + (index % 50) * 7, 3000 + index, extension === 'mp3' ? 'audio/mpeg' : 'audio/mp4'));
        paths.push(`Μουσική/Ελληνικά τραγούδια/Καλλιτέχνης ${index % 25}/Δίσκος ${index % 7}/${name}`);
    }

    return { files, paths };
}

// What a metadata reader could hand back for audio: the file-level fields plus tags with broken numbers,
// lyrics far over the limits and a long tag list.
const AUDIO_MEDIA: MediaToolkit = Object.freeze({
    extractMetadataAsync: async (file: File): Promise<FileMetadata | undefined> => ({
        takenAt: new Date(file.lastModified).toISOString(),
        takenAtSource: 'file',
        originalName: file.name,
        relativePath: `Μουσική/Ελληνικά τραγούδια/${file.name}`,
        title: `${GREEK_TITLE} `.repeat(6),
        description: `Στίχοι: ${GREEK_TITLE} `.repeat(80),
        tags: Array.from({ length: 120 }, (_, index) => `λαϊκό ${index}`),
        durationSeconds: Number.NaN,
        rating: Number.POSITIVE_INFINITY,
        width: -4,
    } as FileMetadata),
    createThumbnailAsync: async () => undefined,
});

function offerBatchBytes(hub: FakeNetworkHub): number[] {
    const sizes: number[] = [];
    hub.intercept(traffic => {
        if (traffic.kind === 'message' && traffic.message.t === 'offer-batch') {
            sizes.push(encoder.encode(JSON.stringify(traffic.message)).byteLength);
        }

        return undefined;
    });

    return sizes;
}

describe('large batches with non-Latin names and real-world metadata', () => {
    it('sends 995 Greek-named tracks with dirty tags, every offer under 64 KiB of UTF-8', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({}, { media: AUDIO_MEDIA });
        const sizes = offerBatchBytes(hub);
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const failed = collect<ClientError>(push => alice.client.on('file-failed', (_, error) => push(error)));
        const { files, paths } = greekLibrary(995);

        // Act
        await alice.client.sendFilesAsync(files, { relativePaths: paths });
        await waitForAsync(() => done.length + failed.length === 995, 110_000, 'all 995');

        // Assert
        expect(failed.map(error => error.message)).toEqual([]);
        expect(done).toHaveLength(995);
        expect(sizes.length).toBeGreaterThan(5);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * KIB);
        const sample = done.find(record => record.name.startsWith('001'));
        expect(sample?.metadata?.durationSeconds).toBeUndefined();
        expect(sample?.metadata?.rating).toBeUndefined();
        expect(sample?.metadata?.width).toBeUndefined();
        expect([...(sample?.metadata?.title ?? '')].length).toBeLessThanOrEqual(200);
        expect([...(sample?.metadata?.description ?? '')].length).toBeLessThanOrEqual(1000);
        expect(sample?.metadata?.tags).toHaveLength(30);
        expect(sample?.relativePath).toMatch(/^Μουσική\//);
    }, 120_000);

    it('splits an offer that turns out too large to send, and completes', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({ maxMessageSize: 12 * KIB }, { media: AUDIO_MEDIA });
        const sizes = offerBatchBytes(hub);
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const { files, paths } = greekLibrary(40);

        // Act
        await alice.client.sendFilesAsync(files, { relativePaths: paths });
        await waitForAsync(() => done.length === 40, 30_000, 'all 40');

        // Assert
        expect(Math.max(...sizes)).toBeLessThanOrEqual(12 * KIB);
        expect(messages(alice).some(message => /offer of \d+ files too large, sending \d+ at a time/.test(message))).toBe(true);
    }, 40_000);

    it('sends a single file whose offer is too large without its summary', async () => {
        // Arrange
        const { alice, bob } = await pairedAsync({ maxMessageSize: 3 * KIB }, { media: AUDIO_MEDIA });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        await alice.client.sendFilesAsync([createTestFile(`${GREEK_TITLE}.mp3`, 500, 3999, 'audio/mpeg')]);
        await waitForAsync(() => done.length === 1, 10_000, 'done');

        // Assert
        expect(done[0]?.metadata).toBeUndefined();
        expect(messages(alice).some(message => message.endsWith('offer too large, sending it without its metadata summary'))).toBe(true);
    });

    it('refuses one bad manifest of a batch as invalid and completes the rest', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync();
        let isBroken = false;
        let brokenName = '';
        hub.intercept(traffic => {
            if (isBroken || traffic.kind !== 'message' || traffic.message.t !== 'offer-batch') {
                return undefined;
            }

            const manifests = traffic.message.files as Array<Record<string, unknown>>;
            if (manifests.length < 3) {
                return undefined;
            }

            isBroken = true;
            brokenName = manifests[2]?.name as string;
            const broken = manifests.map((manifest, index) => (index === 2 ? { ...manifest, totalPages: 99 } : manifest));

            return { message: { ...traffic.message, files: broken } as Message };
        });
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));
        const failed = collect<{ readonly record: FileRecord; readonly error: ClientError }>(push => alice.client.on('file-failed', (record, error) => push({ record, error })));
        const progress = collect<BatchProgress>(push => alice.client.on('batch-progress', push));
        const files = Array.from({ length: 12 }, (_, index) => createTestFile(`part-${index}.bin`, 2000 + index, 4100 + index));

        // Act
        await alice.client.sendFilesAsync(files);
        await waitForAsync(() => done.length + failed.length === 12, 15_000, 'all answered');

        // Assert
        expect(failed.map(item => item.record.name)).toEqual([brokenName]);
        expect(failed[0]?.error).toMatchObject({ code: 'invalid-state', message: `Bob could not read the details of ${brokenName}` });
        expect(done).toHaveLength(11);
        expect(messages(bob).some(message => /manifest refused, totalPages does not match size and pageSize/.test(message))).toBe(true);
        await waitForAsync(() => progress.some(item => item.done === 11 && item.failed === 1), 2000, 'batch counts');
    });

    it('fails a single offer the receiver can\'t read at once, with the receiver\'s reason', async () => {
        // Arrange
        const { hub, alice } = await pairedAsync();
        hub.intercept(traffic => (traffic.kind === 'message' && traffic.message.t === 'offer'
            ? { message: { ...traffic.message, mime: 'x'.repeat(300) } }
            : undefined));
        const failed = collect<ClientError>(push => alice.client.on('file-failed', (_, error) => push(error)));
        const started = Date.now();

        // Act
        await alice.client.sendFilesAsync([createTestFile('one.bin', 1000, 4200)]);
        await waitForAsync(() => failed.length === 1, 4000, 'failed');

        // Assert
        expect(Date.now() - started).toBeLessThan(4000);
        expect(failed[0]).toMatchObject({ code: 'invalid-state', message: 'Bob could not read the offer of one.bin: offer: bad field mime' });
    });

    it('sends an unanswered batch offer once more and completes', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync({}, { settings: { offerReplyTimeoutMs: 5000 } });
        let dropped = 0;
        hub.intercept(traffic => (traffic.kind === 'message' && traffic.message.t === 'offer-batch' && dropped++ === 0 ? 'drop' : undefined));
        const done = collect<FileRecord>(push => bob.client.on('file-done', push));

        // Act
        await alice.client.sendFilesAsync([createTestFile('a.bin', 100, 4301), createTestFile('b.bin', 100, 4302)]);
        await waitForAsync(() => done.length === 2, 15_000, 'done');

        // Assert
        expect(messages(alice).some(message => /offer \(\d+ files\) not answered, sending again/.test(message))).toBe(true);
    }, 20_000);

    it('keeps the receiver\'s batch estimate going after the link drops, with no file moving', async () => {
        // Arrange
        const { hub, alice, bob } = await pairedAsync();
        const dropped = dropWhenPartialAsync(hub, 1, 4, 1);
        const files = [createTestFile('big.bin', 4 * 256 * KIB, 4401), createTestFile('next.bin', 1000, 4402)];
        const batches = collect<BatchProgress>(push => bob.client.on('batch-progress', push));
        const progressEvents = collect<number>(push => bob.client.on('progress', items => push(items.length)));
        await alice.client.sendFilesAsync(files);
        await dropped;
        await waitForAsync(() => bob.client.state === 'lost', 5000, 'lost');
        const before = batches.length;

        // Act
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Assert
        expect(batches.length - before).toBeGreaterThanOrEqual(2);
        expect(batches.at(-1)?.direction).toBe('in');
        expect(progressEvents.every(count => count > 0)).toBe(true);
    });
});
