import { describe, expect, it } from 'vitest';
import { admitToBudget, computeFits, describeBatchIncoming, estimateFits, planOfferBatch, sizesForHeader } from './batches.js';
import type { BatchBudget } from './batches.js';
import { MAX_BATCH_MESSAGE_BYTES } from './protocol.js';
import type { FileManifest } from './protocol.js';

function manifest(index: number): FileManifest {
    return {
        fileId: index.toString(16).padStart(32, '0'),
        name: `IMG_${index}.JPG`,
        size: 3_000_000,
        mime: 'image/jpeg',
        lastModified: 1_700_000_000_000,
        pageSize: 1024 * 1024,
        totalPages: 3,
        metadata: { takenAt: '2026-11-23T14:05:42+01:00', latitude: 37.97, longitude: 23.72, make: 'Apple', model: 'iPhone 15' },
    };
}

describe('computeFits', () => {
    it('counts the first files, in order, that fit', () => {
        // Act
        const fits = computeFits([400, 300, 500, 100], 800);

        // Assert
        expect(fits).toEqual({ fitsCount: 2, fitsBytes: 700 });
    });

    it('estimates from the average size without the size list', () => {
        // Act
        const fits = estimateFits(10, 1000, 350);

        // Assert
        expect(fits).toEqual({ fitsCount: 3, fitsBytes: 350 });
    });
});

describe('describeBatchIncoming', () => {
    it('flags space as short under 1.1 × the batch (BK-03)', () => {
        // Act
        const tight = describeBatchIncoming({ batchId: 'b', peerName: 'Pixel 8', itemCount: 2, totalBytes: 1000, sizes: [500, 500], freeBytes: 1050 });
        const roomy = describeBatchIncoming({ batchId: 'b', peerName: 'Pixel 8', itemCount: 2, totalBytes: 1000, freeBytes: 2000 });

        // Assert
        expect(tight).toMatchObject({ fitsCount: 2, spaceIsShort: true, freeBytes: 1050 });
        expect(roomy).toMatchObject({ fitsCount: 2, spaceIsShort: false });
    });
});

describe('planOfferBatch', () => {
    it('stays under 60 KiB and the window, and marks the last message (BK-02)', () => {
        // Arrange
        const manifests = Array.from({ length: 500 }, (_, index) => manifest(index));

        // Act
        const first = planOfferBatch({ id: 'r1', batchId: 'b', index: 0, manifests, isRest: true, header: { itemCount: 500, totalBytes: 1_500_000_000, sizes: manifests.map(item => item.size) } });
        const rest = planOfferBatch({ id: 'r2', batchId: 'b', index: 1, manifests: manifests.slice(0, 3), isRest: true });

        // Assert
        expect(JSON.stringify(first.message).length).toBeLessThan(MAX_BATCH_MESSAGE_BYTES);
        expect(first.count).toBeLessThanOrEqual(200);
        expect(first.message).toMatchObject({ index: 0, last: false, itemCount: 500 });
        expect(rest).toMatchObject({ count: 3, message: { last: true, index: 1 } });
    });

    it('leaves the size list out when it would crowd the message', () => {
        // Act
        const sizes = sizesForHeader(Array.from({ length: 10_000 }, () => 1_234_567_890));

        // Assert
        expect(sizes).toBeUndefined();
    });
});

describe('admitToBudget', () => {
    it('admits files in order until one does not fit, then refuses the rest', () => {
        // Arrange
        let budget: BatchBudget = { mode: 'fits', budgetBytes: 1000, acceptedBytes: 0, isSpent: false };
        const admitted: boolean[] = [];

        // Act
        for (const size of [400, 500, 300, 50]) {
            const result = admitToBudget(budget, size);
            budget = result.budget;
            admitted.push(result.isAdmitted);
        }

        // Assert
        expect(admitted).toEqual([true, true, false, false]);
        expect(admitToBudget({ ...budget, mode: 'all' }, 10).isAdmitted).toBe(true);
        expect(admitToBudget({ ...budget, mode: 'declined' }, 1).isAdmitted).toBe(false);
    });
});
