import { describe, expect, it } from 'vitest';
import { SILENT_LOGGER } from '../core/logger.js';
import type { Network } from '../network/networkTypes.js';
import type { ProtocolMessage } from './protocol.js';
import { CONTROL_BUFFER_LIMIT, createThumbnailPipeline, encodeBase64 } from './thumbnailPipeline.js';
import type { ThumbnailJob } from './thumbnailPipeline.js';
import type { Link } from './transferContext.js';

interface FakeLink {
    readonly link: Link;
    readonly sent: ProtocolMessage[];
    buffered: number;
}

function createFakeLink(): FakeLink {
    const fake: FakeLink = {
        sent: [],
        buffered: 0,
        link: undefined as unknown as Link,
    };
    const network = { bufferedAmount: () => fake.buffered } as unknown as Network;
    (fake as { link: Link }).link = {
        network,
        sessionId: 's1',
        connectionId: 'c1',
        peerName: 'Pixel 8',
        isOpen: true,
        send: (_, message) => {
            fake.sent.push(message);

            return true;
        },
        trySend: (_, message) => {
            fake.sent.push(message);

            return 'sent';
        },
        sendFrame: () => true,
        waitDrainedAsync: async () => undefined,
    };

    return fake;
}

function job(index: number, onMake?: () => Promise<void>): ThumbnailJob {
    return {
        sessionId: 's1',
        fileId: index.toString(16).padStart(32, '0'),
        name: `IMG_${index}.JPG`,
        makeAsync: async () => {
            await onMake?.();

            return new Blob([new Uint8Array([index, 1, 2])], { type: 'image/jpeg' });
        },
    };
}

async function untilAsync(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('Timed out');
        }

        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

describe('createThumbnailPipeline', () => {
    it('sends each thumbnail as soon as it is made, with no rate cap', async () => {
        // Arrange
        const fake = createFakeLink();
        const pipeline = createThumbnailPipeline({ link: () => fake.link, logger: SILENT_LOGGER });
        const started = performance.now();

        // Act
        for (let index = 0; index < 50; index++) {
            pipeline.add(job(index));
        }

        await untilAsync(() => fake.sent.length === 50);

        // Assert
        expect(performance.now() - started).toBeLessThan(49 * 100);
        expect(fake.sent[0]).toEqual({ t: 'thumb', fileId: job(0).fileId, jpeg: encodeBase64(new Uint8Array([0, 1, 2])) });
        expect(pipeline.pending).toBe(0);
    });

    it('makes at most two thumbnails at a time', async () => {
        // Arrange
        const fake = createFakeLink();
        const pipeline = createThumbnailPipeline({ link: () => fake.link, logger: SILENT_LOGGER });
        let making = 0;
        let mostAtOnce = 0;
        const makeSlowlyAsync = async (): Promise<void> => {
            making++;
            mostAtOnce = Math.max(mostAtOnce, making);
            await new Promise(resolve => setTimeout(resolve, 5));
            making--;
        };

        // Act
        for (let index = 0; index < 8; index++) {
            pipeline.add(job(index, makeSlowlyAsync));
        }

        await untilAsync(() => fake.sent.length === 8);

        // Assert
        expect(mostAtOnce).toBe(2);
    });

    it('holds while the control channel has over 256 KiB queued and resumes when it drains (§4)', async () => {
        // Arrange
        const fake = createFakeLink();
        fake.buffered = CONTROL_BUFFER_LIMIT + 1;
        const pipeline = createThumbnailPipeline({ link: () => fake.link, logger: SILENT_LOGGER, pollMs: 5 });

        // Act
        pipeline.add(job(1));
        pipeline.add(job(2));
        await new Promise(resolve => setTimeout(resolve, 60));
        const sentWhileFull = fake.sent.length;
        fake.buffered = CONTROL_BUFFER_LIMIT;
        await untilAsync(() => fake.sent.length === 2);

        // Assert
        expect(sentWhileFull).toBe(0);
        expect(fake.sent).toHaveLength(2);
    });

    it('waits for the link and goes on when pumped again', async () => {
        // Arrange
        const fake = createFakeLink();
        let link: Link | undefined;
        const pipeline = createThumbnailPipeline({ link: () => link, logger: SILENT_LOGGER });

        // Act
        pipeline.add(job(1));
        await new Promise(resolve => setTimeout(resolve, 20));
        const sentWithoutLink = fake.sent.length;
        link = fake.link;
        pipeline.pump();
        await untilAsync(() => fake.sent.length === 1);

        // Assert
        expect(sentWithoutLink).toBe(0);
        expect(pipeline.pending).toBe(0);
    });

    it('tells the receiver when the sender could not make a thumbnail', async () => {
        // Arrange
        const fake = createFakeLink();
        const pipeline = createThumbnailPipeline({ link: () => fake.link, logger: SILENT_LOGGER });

        // Act
        pipeline.add({ sessionId: 's1', fileId: 'a'.repeat(32), name: 'IMG_0001.HEIC', makeAsync: async () => undefined });
        await untilAsync(() => fake.sent.length === 1);

        // Assert
        expect(fake.sent).toEqual([{ t: 'thumb', fileId: 'a'.repeat(32), none: true }]);
    });

    it('forgets queued jobs on clear', async () => {
        // Arrange
        const fake = createFakeLink();
        fake.buffered = CONTROL_BUFFER_LIMIT * 2;
        const pipeline = createThumbnailPipeline({ link: () => fake.link, logger: SILENT_LOGGER, pollMs: 5 });
        for (let index = 0; index < 5; index++) {
            pipeline.add(job(index));
        }

        // Act
        pipeline.clear();
        fake.buffered = 0;
        await new Promise(resolve => setTimeout(resolve, 40));

        // Assert
        expect(fake.sent).toEqual([]);
        expect(pipeline.pending).toBe(0);
    });
});
