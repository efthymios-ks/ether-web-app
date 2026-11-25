import type { BatchIncoming } from './clientTypes.js';
import { BATCH_WINDOW, MAX_BATCH_MESSAGE_BYTES, countFitting, jsonByteLength } from './protocol.js';
import type { FileManifest, OfferBatchMessage } from './protocol.js';

// Batch planning (§18.1): the offer-batch split, the receiver's prompt numbers and "Accept what fits".

// BK-03: warn when free space is under 1.1 × the batch.
export const SPACE_MARGIN = 1.1;
// The file sizes ride in the first offer-batch message only while they leave room for manifests.
const MAX_SIZES_BYTES = 40 * 1024;
const MESSAGE_OVERHEAD_BYTES = 512;

export interface Fits {
    readonly fitsCount: number;
    readonly fitsBytes: number;
}

// The first N files, in order, whose sizes add up to no more than the free space.
export function computeFits(sizes: readonly number[], freeBytes: number | undefined): Fits {
    let fitsBytes = 0;
    let fitsCount = 0;
    for (const size of sizes) {
        if (freeBytes != null && fitsBytes + size > freeBytes) {
            break;
        }

        fitsBytes += size;
        fitsCount++;
    }

    return { fitsCount, fitsBytes };
}

// Without the size list, an estimate from the average file size.
export function estimateFits(itemCount: number, totalBytes: number, freeBytes: number | undefined): Fits {
    if (freeBytes == null || freeBytes >= totalBytes) {
        return { fitsCount: itemCount, fitsBytes: totalBytes };
    }

    const average = itemCount === 0 ? 0 : totalBytes / itemCount;
    const fitsCount = average === 0 ? itemCount : Math.min(itemCount, Math.floor(freeBytes / average));

    return { fitsCount, fitsBytes: Math.min(totalBytes, freeBytes) };
}

export interface BatchIncomingInput {
    readonly sessionId?: string;
    readonly batchId: string;
    readonly peerName: string;
    readonly itemCount: number;
    readonly totalBytes: number;
    readonly sizes?: readonly number[];
    readonly freeBytes?: number;
}

export function describeBatchIncoming(input: BatchIncomingInput): BatchIncoming {
    const fits = input.sizes
        ? computeFits(input.sizes, input.freeBytes)
        : estimateFits(input.itemCount, input.totalBytes, input.freeBytes);

    return {
        ...(input.sessionId == null ? {} : { sessionId: input.sessionId }),
        batchId: input.batchId,
        peerName: input.peerName,
        itemCount: input.itemCount,
        totalBytes: input.totalBytes,
        ...(input.freeBytes == null ? {} : { freeBytes: input.freeBytes }),
        fitsCount: fits.fitsCount,
        fitsBytes: fits.fitsBytes,
        spaceIsShort: input.freeBytes != null && input.freeBytes < input.totalBytes * SPACE_MARGIN,
    };
}

export function sizesForHeader(sizes: readonly number[]): readonly number[] | undefined {
    return jsonByteLength(sizes) <= MAX_SIZES_BYTES ? sizes : undefined;
}

export interface OfferBatchInput {
    readonly id: string;
    readonly batchId: string;
    readonly index: number;
    readonly manifests: readonly FileManifest[];
    // True when `manifests` holds every file of the batch not yet offered.
    readonly isRest: boolean;
    readonly header?: { readonly itemCount: number; readonly totalBytes: number; readonly sizes?: readonly number[] };
    // Fewer manifests than the window, after a message turned out too large to send.
    readonly maxCount?: number;
}

// One offer-batch message with as many manifests as fit under 60 KiB and the window size (BK-02).
export function planOfferBatch(input: OfferBatchInput): { readonly message: OfferBatchMessage; readonly count: number } {
    const headerBytes = input.header ? jsonByteLength(input.header) : 0;
    const budget = MAX_BATCH_MESSAGE_BYTES - MESSAGE_OVERHEAD_BYTES - headerBytes;
    const count = countFitting(input.manifests, budget, Math.min(BATCH_WINDOW, input.maxCount ?? BATCH_WINDOW));
    const message: OfferBatchMessage = {
        t: 'offer-batch',
        id: input.id,
        batchId: input.batchId,
        index: input.index,
        last: input.isRest && count === input.manifests.length,
        files: input.manifests.slice(0, count),
        ...(input.header ?? {}),
    };

    return { message, count };
}

// The receiver's answer to one batch, applied file by file in order ("first N files", BK-03).
export interface BatchBudget {
    readonly mode: 'all' | 'fits' | 'declined';
    readonly budgetBytes: number;
    readonly acceptedBytes: number;
    readonly isSpent: boolean;
}

export function admitToBudget(budget: BatchBudget, bytes: number): { readonly isAdmitted: boolean; readonly budget: BatchBudget } {
    if (budget.mode === 'declined') {
        return { isAdmitted: false, budget };
    }

    if (budget.mode === 'all') {
        return { isAdmitted: true, budget: { ...budget, acceptedBytes: budget.acceptedBytes + bytes } };
    }

    if (budget.isSpent || budget.acceptedBytes + bytes > budget.budgetBytes) {
        return { isAdmitted: false, budget: { ...budget, isSpent: true } };
    }

    return { isAdmitted: true, budget: { ...budget, acceptedBytes: budget.acceptedBytes + bytes } };
}
