import { isQuotaExceeded } from '../core/database.js';
import type { Logger } from '../core/logger.js';
import { formatBytes } from '../core/settings.js';
import { CRC32_INITIAL, crc32Update } from '../media/crc32.js';
import { mediaKindOf } from '../media/mediaKind.js';
import type { FrameHeader, SlotId } from '../network/networkTypes.js';
import { admitToBudget, describeBatchIncoming } from './batches.js';
import type { BatchBudget } from './batches.js';
import { ClientError, UNFINISHED_STATES } from './clientTypes.js';
import type { BatchIncoming, FileNote, FileState, SyncDecision, SyncDecisionKind } from './clientTypes.js';
import { PageHashList, hashPageAsync, prefixHashAsync, rootHashAsync, toHex } from './hashing.js';
import { sanitizeMetadata } from './metadataSanitizer.js';
import { countPages, pageLength, resumePageOf } from './pagination.js';
import { validateManifest } from './protocol.js';
import type {
    BatchReplyEntry,
    CancelMessage,
    FileEndMessage,
    FileManifest,
    OfferBatchMessage,
    OfferMessage,
    PageEndMessage,
    RejectReason,
    SyncEntry,
    ThumbMessage,
} from './protocol.js';
import type { StoredBatch, StoredFile, StoredPagination } from './storage.js';
import {
    SLOT_MESSAGE_CHANNEL,
    emitFileState,
    isStoppedRecord,
    toFileRecord,
    withoutPagination,
} from './transferContext.js';
import type { BatchStop, Link, TransferContext } from './transferContext.js';

// The receiving side: offers and batches, pages saved then acknowledged (TR-06), final check, cancel, thumbnails.

const ONGOING_STATES: readonly FileState[] = Object.freeze([
    'queued',
    'offered',
    'incoming',
    'active',
    'paused',
    'verifying',
    'failed',
    'canceled',
]);
const BUSY_STATES: readonly FileState[] = Object.freeze(['offered', 'active', 'verifying']);
const FINISHED_STATES: readonly FileState[] = Object.freeze(['done', 'failed', 'canceled']);
const UNLIMITED_BYTES = Number.MAX_SAFE_INTEGER;
const STATE_BY_CANCEL_REASON: Readonly<Record<NonNullable<CancelMessage['reason']>, FileState>> = Object.freeze({
    canceled: 'canceled',
    paused: 'paused',
    failed: 'failed',
    'storage-full': 'paused',
});
const DROP_LOG_INTERVAL_MS = 1000;
// How long a verified file waits for a thumbnail the sender announced before the receiver makes its own.
export const THUMB_WAIT_MS = 15_000;

// A file of a batch offered on its own before the batch's first message (a partial picked again goes alone) makes a
// batch of its single offers; the first message's counts replace them, whichever of the two is stored first.
function withHeader(batch: StoredBatch, message: OfferBatchMessage): StoredBatch {
    if (batch.singleOfferFileIds == null || message.itemCount == null) {
        return batch;
    }

    const { finishedAt: _, singleOfferFileIds: __, ...rest } = batch;

    return { ...rest, itemCount: message.itemCount, totalBytes: message.totalBytes ?? rest.totalBytes };
}

// The running CRC-32 over pages [0, pages) of a stored pagination: known for its saved page count and the one
// before it, else undefined, and the ZIP then reads the pages for it (SV-04).
function crcAt(pagination: StoredPagination | undefined, pages: number): number | undefined {
    if (pages === 0) {
        return CRC32_INITIAL;
    }

    if (pagination == null) {
        return undefined;
    }

    if (pages === pagination.pagesDone) {
        return pagination.crc32;
    }

    return pages === pagination.pagesDone - 1 ? pagination.crc32Previous : undefined;
}

export interface IncomingHooks {
    readonly nextQueueIndex: () => number;
    // A received file passed the final check.
    readonly onFileDone: (record: StoredFile) => void;
    // A file ended here without arriving: canceled (by either side) or failed. Called once per file.
    readonly onFileStopped: (record: StoredFile) => void;
    // An unfinished file was offered in a newer batch, so its old batch counts one file less.
    readonly onFileLeftBatch: (record: StoredFile) => void;
    // A batch message got its answer: files already here count as received, rejected ones as failed;
    // accepted files count when they end.
    readonly onBatchAnswered: (
        sessionId: string,
        batchId: string,
        answered: { readonly alreadyHere: number; readonly alreadyHereBytes: number; readonly rejected: number },
    ) => void;
}

export interface IncomingSlotInfo {
    readonly slot: SlotId;
    readonly fileId: string;
}

export interface Incoming {
    handleOfferAsync(slot: SlotId, offer: OfferMessage): Promise<void>;
    handleOfferBatchAsync(slot: SlotId, message: OfferBatchMessage): Promise<void>;
    handleFrame(header: FrameHeader, payload: Uint8Array): void;
    handlePageEnd(slot: SlotId, message: PageEndMessage): void;
    handleFileEndAsync(slot: SlotId, message: FileEndMessage): Promise<void>;
    handleCancelAsync(message: CancelMessage): Promise<void>;
    // Delete what arrived: every unfinished file of the batch ends canceled with its saved pages deleted; offers for
    // it are ignored while this link lasts. Resolves with how many files were canceled.
    cancelBatchAsync(sessionId: string, batchId: string): Promise<number>;
    // Stop: every unfinished file of the batch stops, keeping its saved pages; offers for it are ignored while this
    // link lasts, unless they say the file was resumed.
    stopBatchAsync(sessionId: string, batchId: string): Promise<BatchStop>;
    // Resume: the batch's stopped files, or only `fileIds`, wait for the sender's offer again; resolves with how many.
    resumeBatchAsync(sessionId: string, batchId: string, fileIds?: readonly string[]): Promise<number>;
    // Undoes the hold of a Stop that named a batch this side doesn't have.
    releaseBatch(sessionId: string, batchId: string): void;
    handleThumbAsync(message: ThumbMessage): Promise<void>;
    linkDownAsync(): Promise<void>;
    // A device connected: prompts left from another session's batches are released.
    linkUp(sessionId: string): void;
    // Forgets one session's received files: thumbnail bookkeeping for `fileIds`, and with `includeUnfinished`
    // every file still arriving or waiting for an answer, canceled first (the peer hears it when connected).
    forgetSessionAsync(sessionId: string, fileIds: readonly string[], includeUnfinished: boolean): Promise<void>;
    syncEntriesAsync(sessionId: string): Promise<SyncEntry[]>;
    applyPeerSyncAsync(sessionId: string, peerEntries: readonly SyncEntry[]): Promise<SyncDecision[]>;
    acceptIncomingAsync(sessionId: string, fileId: string): Promise<void>;
    rejectIncomingAsync(sessionId: string, fileId: string, reason: 'declined' | 'space'): Promise<void>;
    acceptBatchAsync(batchId: string, mode: 'all' | 'fits'): Promise<void>;
    declineBatchAsync(batchId: string): Promise<void>;
    // Returns false when the file isn't an unfinished incoming one.
    pauseAsync(sessionId: string, fileId: string): Promise<boolean>;
    resumeAsync(sessionId: string, fileId: string): Promise<boolean>;
    // Cancels on both sides; the partial file goes on both.
    cancelAsync(sessionId: string, fileId: string): Promise<boolean>;
    deletePartialAsync(sessionId: string, fileId: string): Promise<boolean>;
    // One session's received file, live while it arrives.
    findAsync(sessionId: string, fileId: string): Promise<StoredFile | undefined>;
    slots(): IncomingSlotInfo[];
    pendingBatches(): BatchIncoming[];
}

interface Receiving {
    record: StoredFile;
    readonly slot: SlotId;
    readonly sessionId: string;
    readonly pageSize: number;
    readonly totalPages: number;
    readonly logger: Logger;
    receivingPage: number;
    buffer: Uint8Array<ArrayBuffer> | undefined;
    received: number;
    pagesDone: number;
    hashes: PageHashList;
    // Undefined once unknown, e.g. pages lost from storage: the ZIP then reads the pages for it.
    crc: number | undefined;
    chain: Promise<void>;
    generation: number;
    isClosed: boolean;
}

// What a Stop or Delete what arrived finds on this side once nothing more starts: the batch's unfinished files,
// the moving ones among them.
interface BatchHalt {
    readonly fileIds: readonly string[];
    readonly movingFileIds: readonly string[];
}

interface PendingOffer {
    readonly slot: SlotId;
    readonly offer: OfferMessage;
    readonly link: Link;
}

interface PendingBatch {
    readonly sessionId: string;
    readonly info: BatchIncoming;
    queue: Array<{ readonly slot: SlotId; readonly message: OfferBatchMessage }>;
}

type OfferDecision =
    | { readonly kind: 'have'; readonly verified: boolean; readonly rootHash?: string; readonly pageSize?: number }
    | { readonly kind: 'reject'; readonly reason: RejectReason; readonly needed?: number; readonly free?: number }
    | { readonly kind: 'ask' }
    | {
        readonly kind: 'accept';
        readonly record: StoredFile;
        readonly fromPage: number;
        readonly pageSize: number;
        readonly note?: FileNote;
        readonly decision?: SyncDecisionKind;
    };

// What the receiver keeps of a sender's summary: the same rules the sender applies (SP-05).
function metadataOf(metadata: unknown): { readonly metadata?: StoredFile['metadata'] } {
    const sanitized = sanitizeMetadata(metadata);

    return sanitized ? { metadata: sanitized } : {};
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
}

export function createIncoming(context: TransferContext, hooks: IncomingHooks): Incoming {
    const bySlot = new Map<SlotId, Receiving>();
    const byFileId = new Map<string, Receiving>();
    const prompts = new Map<string, PendingOffer>();
    const batchPrompts = new Map<string, PendingBatch>();
    // Files whose sender said a thumbnail follows; the receiver makes its own only for the others (TH-04).
    // Keyed by session and file, like every thumbnail set here: the same file can come from two devices.
    const expectedThumbs = new Set<string>();
    // Files whose sender said it has no thumbnail; a later offer announcing one again doesn't make the receiver wait.
    const declinedThumbs = new Set<string>();
    // Announces a thumbnail unless it is already stored or the sender already gave up on it.
    const expectThumb = (key: string): void => {
        if (!storedThumbs.has(key) && !declinedThumbs.has(key)) {
            expectedThumbs.add(key);
        }
    };
    // Thumbnails saved while the file record was being rewritten elsewhere, keyed by session and file.
    const storedThumbs = new Set<string>();
    // Being stored or made right now; a second one for the same file is dropped, so each file gets one thumbnail.
    const busyThumbs = new Set<string>();
    // Verified files waiting for an announced thumbnail, with the timer that gives up on it.
    const awaitingThumbs = new Map<string, { readonly record: StoredFile; readonly timer: ReturnType<typeof setTimeout> }>();
    const thumbKey = (sessionId: string, fileId: string): string => `${sessionId}:${fileId}`;
    // Per session: contentId → fileIds of received files, read from storage on first use and added to as files finish.
    // Entries are only candidates: each is read again before it counts, so a deleted or replaced file never matches.
    const contentIndexes = new Map<string, Promise<Map<string, Set<string>>>>();
    // Batches stopped or canceled on either side while this link lasts, by session and batch: offers still on their
    // way for them get no answer, unless they say the file was resumed.
    const stoppedBatches = new Set<string>();
    const isStopped = (sessionId: string, batchId: string | undefined): boolean => batchId != null && stoppedBatches.has(`${sessionId}:${batchId}`);
    // Offers being answered, by session and batch: a Stop waits for them, so no record is written after it looked.
    const answering = new Map<string, Set<Promise<unknown>>>();
    const trackAsync = async (sessionId: string, batchId: string | undefined, work: () => Promise<void>): Promise<void> => {
        if (batchId == null) {
            await work();

            return;
        }

        const key = `${sessionId}:${batchId}`;
        const promise = work();
        const running = answering.get(key) ?? new Set<Promise<unknown>>();
        running.add(promise);
        answering.set(key, running);
        try {
            await promise;
        } finally {
            running.delete(promise);
            if (running.size === 0) {
                answering.delete(key);
            }
        }
    };

    const sendSlot = (link: Link, slot: SlotId, message: Parameters<Link['send']>[1]): void => {
        link.send(slot, message);
    };

    const putRecordAsync = async (record: StoredFile, isVisible = true): Promise<void> => {
        try {
            await context.storage.putFileAsync(record);
        } catch (error) {
            context.logger.warn('store', `${record.name} file record not saved`, error);
        }

        if (isVisible) {
            emitFileState(context, record);
        }
    };

    // Changes to one or two fields of a stored record, applied to the record as it is now in storage.
    const patchRecordAsync = async (
        sessionId: string,
        fileId: string,
        patch: (current: StoredFile) => StoredFile | undefined,
        options: { readonly isVisible?: boolean; readonly deletePages?: boolean } = {},
    ): Promise<StoredFile | undefined> => {
        try {
            const patched = await context.storage.patchFileAsync(sessionId, fileId, 'in', patch, { deletePages: options.deletePages ?? false });
            if (patched && (options.isVisible ?? true)) {
                emitFileState(context, patched);
            }

            return patched;
        } catch (error) {
            context.logger.warn('store', 'file record not updated', error);

            return undefined;
        }
    };

    const markThumbnailAsync = (sessionId: string, fileId: string): Promise<StoredFile | undefined> => patchRecordAsync(
        sessionId,
        fileId,
        current => (current.hasThumbnail ? undefined : { ...current, hasThumbnail: true }),
        { isVisible: false },
    );

    const reportProgress = (receiving: Receiving): void => {
        const record = receiving.record;
        context.progress.trackPosition(receiving.sessionId, 'in', record.fileId, () => receiving.pagesDone * receiving.pageSize + receiving.received);
        context.progress.update({
            fileId: record.fileId,
            sessionId: receiving.sessionId,
            direction: 'in',
            ...(record.batchId == null ? {} : { batchId: record.batchId }),
            name: record.name,
            pagesDone: receiving.pagesDone,
            totalPages: receiving.totalPages,
            bytesDone: Math.min(record.size, receiving.pagesDone * receiving.pageSize),
            size: record.size,
        });
    };

    const close = (receiving: Receiving): void => {
        receiving.isClosed = true;
        receiving.generation++;
        receiving.buffer = undefined;
        if (bySlot.get(receiving.slot) === receiving) {
            bySlot.delete(receiving.slot);
        }

        if (byFileId.get(receiving.record.fileId) === receiving) {
            byFileId.delete(receiving.record.fileId);
        }

        context.progress.remove(receiving.sessionId, 'in', receiving.record.fileId);
    };

    // The saved pages count, not where this run started: a resume asks for the last saved page again, and that page
    // stays saved until its new copy replaces it.
    const detachedPagination = (receiving: Receiving): StoredPagination | undefined => {
        const pagination = receiving.record.pagination;
        if (!pagination || pagination.pagesDone === 0) {
            return undefined;
        }

        return { ...pagination, slot: null };
    };

    const stopReceivingAsync = async (receiving: Receiving, changes: Partial<StoredFile>): Promise<StoredFile> => {
        close(receiving);
        await receiving.chain;
        const record: StoredFile = {
            ...receiving.record,
            pagination: detachedPagination(receiving),
            ...changes,
            updatedAt: context.now(),
        };
        receiving.record = record;
        await putRecordAsync(record);

        return record;
    };

    const newRecord = (offer: FileManifest & { readonly batchId?: string }, sessionId: string, existing?: StoredFile): StoredFile => {
        const batchId = offer.batchId ?? existing?.batchId;

        return {
            sessionId,
            fileId: offer.fileId,
            direction: 'in',
            ...(batchId == null ? {} : { batchId }),
            ...(offer.contentId == null ? {} : { contentId: offer.contentId }),
            name: offer.name,
            ...(offer.relativePath == null ? {} : { relativePath: offer.relativePath }),
            size: offer.size,
            mime: offer.mime,
            kind: mediaKindOf(offer.mime, offer.name),
            lastModified: offer.lastModified,
            ...metadataOf(offer.metadata),
            state: 'offered',
            attempts: existing?.attempts ?? 0,
            createdAt: existing?.createdAt ?? context.now(),
            updatedAt: context.now(),
            // A done file offered again may be different bytes under the same ID: its thumbnail is made again.
            hasThumbnail: existing?.state === 'done' ? false : existing?.hasThumbnail ?? false,
            hasData: false,
            queueIndex: existing?.queueIndex ?? hooks.nextQueueIndex(),
        };
    };

    // A file is on this device only while its data is: a done record whose data was deleted counts as absent,
    // so the file is taken again into the same record.
    const isHeld = (file: StoredFile): boolean => file.state === 'done' && file.hasData;

    // An unfinished file offered in a newer batch (picked again on the sender) moves to it; its old batch counts one
    // file less. A finished one was counted where it ended.
    const leaveBatch = (existing: StoredFile | undefined, batchId: string | undefined): void => {
        if (
            existing?.batchId != null
            && batchId != null
            && existing.batchId !== batchId
            && !FINISHED_STATES.includes(existing.state)
        ) {
            hooks.onFileLeftBatch(existing);
        }
    };

    // What a sender needs to check its copy against this done file before skipping it.
    const peerCheckOf = (existing: StoredFile): { readonly rootHash?: string; readonly pageSize?: number } => (
        existing.rootHash != null && existing.rootPageSize != null
            ? { rootHash: existing.rootHash, pageSize: existing.rootPageSize }
            : {}
    );

    const addToIndex = (index: Map<string, Set<string>>, file: StoredFile): void => {
        if (file.contentId == null) {
            return;
        }

        const fileIds = index.get(file.contentId) ?? new Set<string>();
        fileIds.add(file.fileId);
        index.set(file.contentId, fileIds);
    };

    const buildContentIndexAsync = async (sessionId: string): Promise<Map<string, Set<string>>> => {
        const index = new Map<string, Set<string>>();
        const files = await context.storage.listFilesInStatesAsync(sessionId, ['done']);
        for (const file of files.filter(candidate => candidate.direction === 'in')) {
            addToIndex(index, file);
        }

        return index;
    };

    const contentIndexOfAsync = (sessionId: string): Promise<Map<string, Set<string>>> => {
        let index = contentIndexes.get(sessionId);
        if (!index) {
            index = buildContentIndexAsync(sessionId);
            contentIndexes.set(sessionId, index);
            index.catch(() => contentIndexes.delete(sessionId));
        }

        return index;
    };

    // A file that just finished joins its session's index, if that index was already read.
    const indexContent = (file: StoredFile): void => {
        void contentIndexes.get(file.sessionId)?.then(index => addToIndex(index, file)).catch(() => undefined);
    };

    // A file offered under an ID this device has never seen may still be here: the same name and content
    // received in another send (another folder, or a subfolder picked alone). One from the same batch doesn't count,
    // so two copies picked together are both sent. The sender then checks its whole file against this one's rootHash.
    const findHeldCopyAsync = async (sessionId: string, offer: { readonly contentId?: string; readonly batchId?: string }): Promise<StoredFile | undefined> => {
        const contentId = offer.contentId;
        if (contentId == null) {
            return undefined;
        }

        const fileIds = (await contentIndexOfAsync(sessionId)).get(contentId) ?? new Set<string>();
        for (const fileId of fileIds) {
            const file = await context.storage.getFileAsync(sessionId, fileId, 'in');
            if (
                file != null
                && isHeld(file)
                && file.contentId === contentId
                && file.batchId !== offer.batchId
                && file.rootHash != null
                && file.rootPageSize != null
            ) {
                return file;
            }
        }

        return undefined;
    };

    // The old thumbnail of a file being replaced goes, so the new one (the sender's or our own) takes its place.
    const forgetThumbAsync = async (sessionId: string, fileId: string): Promise<void> => {
        const key = thumbKey(sessionId, fileId);
        storedThumbs.delete(key);
        declinedThumbs.delete(key);
        await context.storage.deleteThumbAsync(sessionId, fileId).catch(error => context.logger.warn('store', 'old thumbnail not deleted', error));
    };

    const isResumable = (file: StoredFile | undefined, size: number): file is StoredFile & { pagination: StoredPagination } => (
        file != null
        && file.pagination != null
        && file.pagination.pagesDone > 0
        && file.size === size
        && file.state !== 'done'
    );

    // §7.5: a partial with the same fileId and size in another session, e.g. after the sender's data was cleared.
    const adoptPartialAsync = async (offer: FileManifest & { readonly batchId?: string }, sessionId: string): Promise<StoredFile | undefined> => {
        const candidates = await context.storage.findFilesByFileIdAsync(offer.fileId);
        const partial = candidates.find(file => (
            file.direction === 'in'
            && file.sessionId !== sessionId
            && isResumable(file, offer.size)
            && !BUSY_STATES.includes(file.state)
        ));
        if (!partial) {
            return undefined;
        }

        const adopted: StoredFile = {
            ...partial,
            sessionId,
            ...(offer.batchId == null ? {} : { batchId: offer.batchId }),
            pausedBy: undefined,
            updatedAt: context.now(),
        };
        await context.storage.movePartialAsync(partial, adopted);
        context.logger.info('resume', `${offer.name} partial adopted from session ${partial.sessionId.slice(0, 8)}, ${partial.pagination?.pagesDone ?? 0} pages`);

        return adopted;
    };

    const decideOfferAsync = async (offer: OfferMessage, existing: StoredFile | undefined, link: Link): Promise<OfferDecision> => {
        const settings = context.settings();
        if (
            existing != null
            && isHeld(existing)
            && !offer.again
            && !offer.restart
        ) {
            return { kind: 'have', verified: existing.rootHash != null, ...peerCheckOf(existing) };
        }

        const copy = existing == null && !offer.again && !offer.restart ? await findHeldCopyAsync(link.sessionId, offer) : undefined;
        if (copy) {
            context.logger.info('xfer', `${offer.name} is here already as ${copy.relativePath ?? copy.name}`, { fileId: offer.fileId });

            return { kind: 'have', verified: true, ...peerCheckOf(copy) };
        }

        if (
            existing?.state === 'paused'
            && existing.pausedBy === 'user'
            && !offer.again
        ) {
            return { kind: 'reject', reason: 'paused' };
        }

        if (
            existing?.state === 'failed'
            && existing.note === 'declined'
            && !offer.again
        ) {
            return { kind: 'reject', reason: 'declined' };
        }

        // Stopped here: only an offer that says the user resumed it (or picked it again) moves it, so an offer sent
        // before the Stop, or by an older build that missed it, leaves it stopped.
        if (
            isStoppedRecord(existing)
            && offer.resumed !== true
            && !offer.again
        ) {
            return { kind: 'reject', reason: 'paused' };
        }

        if (
            !offer.restart
            && !offer.again
            && isResumable(existing, offer.size)
        ) {
            return {
                kind: 'accept',
                record: { ...existing, ...(offer.batchId == null ? {} : { batchId: offer.batchId }) },
                fromPage: existing.pagination.pagesDone,
                pageSize: existing.pagination.pageSize,
                decision: 'resume',
            };
        }

        if (
            !offer.restart
            && !offer.again
            && !isResumable(existing, offer.size)
        ) {
            const adopted = await adoptPartialAsync(offer, link.sessionId);
            if (adopted?.pagination) {
                return {
                    kind: 'accept',
                    record: adopted,
                    fromPage: adopted.pagination.pagesDone,
                    pageSize: adopted.pagination.pageSize,
                    note: 'adopted',
                    decision: 'adopted',
                };
            }
        }

        // Accepted before: queued, or resting since and resumed by the sender.
        const isApproved = existing?.state === 'queued' || (offer.resumed === true && existing?.state === 'paused');
        const record = newRecord(offer, link.sessionId, existing);
        if (!isApproved) {
            const free = await context.freeSpaceAsync();
            if (free != null && offer.size > free) {
                return { kind: 'reject', reason: 'space', needed: offer.size, free };
            }
        }

        if (
            !isApproved
            && settings.askBeforeReceiving
            && !offer.resume
            && !offer.restart
        ) {
            return { kind: 'ask' };
        }

        const isDataLost = offer.resume === true && !offer.restart;

        return {
            kind: 'accept',
            record,
            fromPage: 0,
            pageSize: offer.pageSize,
            ...(isDataLost ? { note: 'data-lost' as const, decision: 'data-lost' as const } : {}),
            ...(offer.restart ? { note: 'restarted' as const, decision: 'restart' as const } : {}),
        };
    };

    const readHashesAsync = async (sessionId: string, fileId: string, count: number): Promise<PageHashList> => {
        const pages = await context.storage.readPagesAsync(sessionId, fileId);
        const hashes = new PageHashList();
        for (const page of pages) {
            if (page.pageIndex !== hashes.count || hashes.count >= count) {
                break;
            }

            hashes.set(page.pageIndex, page.hash);
        }

        return hashes;
    };

    // A file offered on its own still belongs to a recorded batch, so it gets batch-progress like the rest;
    // an unknown batch is made for it, and later single offers of the same batch each count once.
    const ensureBatchAsync = async (sessionId: string, offer: OfferMessage, record: StoredFile): Promise<string> => {
        const batchId = record.batchId ?? offer.batchId ?? context.randomId();
        await context.batches.updateAsync(sessionId, batchId, current => {
            if (!current) {
                return {
                    sessionId,
                    batchId,
                    direction: 'in',
                    itemCount: 1,
                    totalBytes: offer.size,
                    received: 0,
                    saved: 0,
                    failed: 0,
                    createdAt: context.now(),
                    singleOfferFileIds: [offer.fileId],
                };
            }

            if (!current.singleOfferFileIds || current.singleOfferFileIds.includes(offer.fileId)) {
                return current;
            }

            const { finishedAt: _, ...open } = current;

            return {
                ...open,
                itemCount: current.itemCount + 1,
                totalBytes: current.totalBytes + offer.size,
                singleOfferFileIds: [...current.singleOfferFileIds, offer.fileId],
            };
        });

        return batchId;
    };

    const beginAsync = async (link: Link, slot: SlotId, offer: OfferMessage, decision: Extract<OfferDecision, { kind: 'accept' }>): Promise<void> => {
        const batchId = await ensureBatchAsync(link.sessionId, offer, decision.record);
        const pageSize = decision.pageSize;
        const totalPages = countPages(offer.size, pageSize);
        const hashes = decision.fromPage > 0
            ? await readHashesAsync(link.sessionId, offer.fileId, decision.fromPage)
            : new PageHashList();
        // Pages missing from storage (e.g. evicted) count as lost: only the contiguous ones from page 0 stay saved.
        const savedPages = Math.min(decision.fromPage, hashes.count);
        // The last saved page is asked for again; its stored copy stays until the new one, checked against the
        // sender's hash, replaces it. The prefix hash covers the pages before it.
        const fromPage = resumePageOf(savedPages);
        hashes.truncate(fromPage);
        const prefixHash = fromPage > 0 ? await prefixHashAsync(hashes.bytes, fromPage) : undefined;
        const stored = decision.record.pagination;
        const savedCrc = crcAt(stored, savedPages);
        const previousCrc = savedPages > 0 ? crcAt(stored, savedPages - 1) : undefined;
        const record: StoredFile = {
            ...decision.record,
            batchId,
            hasThumbnail: decision.record.hasThumbnail || storedThumbs.has(thumbKey(link.sessionId, offer.fileId)),
            state: 'active',
            note: decision.note,
            pausedBy: undefined,
            lastError: undefined,
            updatedAt: context.now(),
            pagination: {
                pageSize,
                totalPages,
                currentPage: fromPage,
                pagesDone: savedPages,
                slot,
                lastConnectionId: link.connectionId,
                ...(savedCrc == null ? {} : { crc32: savedCrc }),
                ...(previousCrc == null ? {} : { crc32Previous: previousCrc }),
            },
        };
        // Stopped while this file was being set up: it never starts. A Stop during the write below finds the
        // record and cancels it, since it waits for this answer; nothing is accepted after Stop was pressed.
        if (isStopped(link.sessionId, batchId)) {
            return;
        }

        await context.storage.putFileDeletingPagesAsync(record, savedPages);
        if (isStopped(link.sessionId, batchId)) {
            return;
        }

        const logger = context.logger.with({ sessionId: link.sessionId, connectionId: link.connectionId, fileId: offer.fileId });
        const receiving: Receiving = {
            record,
            slot,
            sessionId: link.sessionId,
            pageSize,
            totalPages,
            logger,
            receivingPage: fromPage,
            buffer: undefined,
            received: 0,
            pagesDone: fromPage,
            hashes,
            crc: crcAt(stored, fromPage),
            chain: Promise.resolve(),
            generation: 0,
            isClosed: false,
        };
        bySlot.set(slot, receiving);
        byFileId.set(offer.fileId, receiving);

        sendSlot(link, slot, { t: 'accept', re: offer.id, fileId: offer.fileId, fromPage, pageSize, ...(prefixHash == null ? {} : { prefixHash }) });
        logger.info('xfer', `${offer.name} accept fromPage=${fromPage} pageSize=${formatBytes(pageSize)} slot=${slot}`);
        if (decision.decision) {
            logger.info('resume', `${offer.name} ${decision.decision} fromPage=${fromPage} of ${totalPages}`);
            context.emitSync([{ sessionId: link.sessionId, fileId: offer.fileId, name: offer.name, direction: 'in', decision: decision.decision, fromPage, totalPages }]);
        }

        context.ensurePersistentStorage();
        emitFileState(context, record);
        reportProgress(receiving);
    };

    const handleOfferAsync = async (slot: SlotId, offer: OfferMessage): Promise<void> => {
        const link = context.link();
        if (!link) {
            return;
        }

        if (isStopped(link.sessionId, offer.batchId) && offer.resumed !== true) {
            context.logger.debug('xfer', `${offer.name} offer of a stopped batch ignored`, { fileId: offer.fileId });

            return;
        }

        await trackAsync(link.sessionId, offer.batchId, () => answerOfferAsync(link, slot, offer));
    };

    const answerOfferAsync = async (link: Link, slot: SlotId, offer: OfferMessage): Promise<void> => {
        const previous = bySlot.get(slot);
        if (previous && previous.record.fileId !== offer.fileId) {
            await stopReceivingAsync(previous, { state: 'paused', pausedBy: 'peer' });
        }

        const current = byFileId.get(offer.fileId);
        if (current) {
            close(current);
            await current.chain;
        }

        if (offer.thumb) {
            expectThumb(thumbKey(link.sessionId, offer.fileId));
        }

        const existing = current?.record ?? await context.storage.getFileAsync(link.sessionId, offer.fileId, 'in');
        const decision = await decideOfferAsync(offer, existing, link);
        const logger = context.logger.with({ sessionId: link.sessionId, fileId: offer.fileId });

        if (decision.kind === 'have') {
            sendSlot(link, slot, {
                t: 'have',
                re: offer.id,
                fileId: offer.fileId,
                verified: decision.verified,
                ...(decision.rootHash == null ? {} : { rootHash: decision.rootHash }),
                ...(decision.pageSize == null ? {} : { pageSize: decision.pageSize }),
            });
            logger.info('xfer', `${offer.name} have verified=${decision.verified}`);

            return;
        }

        // A done file offered again (Send again, a failed whole-file check on the sender, or its data was deleted) is replaced.
        if (existing?.state === 'done' && (decision.kind === 'accept' || decision.kind === 'ask')) {
            logger.info('xfer', `${offer.name} offered again, replacing the received copy`);
            await forgetThumbAsync(link.sessionId, offer.fileId);
        }

        if (decision.kind === 'reject') {
            sendSlot(link, slot, {
                t: 'reject',
                re: offer.id,
                fileId: offer.fileId,
                reason: decision.reason,
                ...(decision.needed == null ? {} : { needed: decision.needed }),
                ...(decision.free == null ? {} : { free: decision.free }),
            });
            logger.info('xfer', `${offer.name} reject reason=${decision.reason}`);
            if (decision.reason === 'space') {
                const detail = `Needs ${formatBytes(decision.needed ?? 0)}, has ${formatBytes(decision.free ?? 0)}`;
                await putRecordAsync({ ...newRecord(offer, link.sessionId, existing), state: 'failed', note: 'no-space', lastError: detail });
            }

            return;
        }

        // Stopped while this offer was being decided: it gets no answer and no record.
        if (isStopped(link.sessionId, offer.batchId) && offer.resumed !== true) {
            return;
        }

        leaveBatch(existing, offer.batchId);

        if (decision.kind === 'ask') {
            const record: StoredFile = { ...newRecord(offer, link.sessionId, existing), state: 'incoming' };
            await putRecordAsync(record, false);
            prompts.set(thumbKey(link.sessionId, offer.fileId), { slot, offer, link });
            sendSlot(link, slot, { t: 'wait', re: offer.id, fileId: offer.fileId });
            logger.info('xfer', `${offer.name} asking before receiving`);
            context.events.emit('file-incoming', toFileRecord(record));

            return;
        }

        await beginAsync(link, slot, offer, decision);
    };

    const handleFrame = (header: FrameHeader, payload: Uint8Array): void => {
        const receiving = bySlot.get(header.slot);
        if (!receiving) {
            if (context.logger.every(`orphan-frame-${header.slot}`, DROP_LOG_INTERVAL_MS)) {
                context.logger.debug('xfer', `chunk on idle slot ${header.slot} dropped`);
            }

            return;
        }

        // TR-02: only the page the slot expects now counts.
        if (header.page !== receiving.receivingPage) {
            if (receiving.logger.every(`stale-page-${receiving.record.fileId}-${header.page}`, DROP_LOG_INTERVAL_MS)) {
                receiving.logger.debug('xfer', `${receiving.record.name} chunk for page ${header.page + 1} dropped while expecting page ${receiving.receivingPage + 1}`);
            }

            return;
        }

        const expected = pageLength(receiving.record.size, receiving.pageSize, header.page);
        if (header.offset + payload.length > expected) {
            receiving.logger.warn('xfer', `${receiving.record.name} chunk past the end of page ${header.page + 1} dropped`);

            return;
        }

        receiving.buffer ??= new Uint8Array(expected);
        receiving.buffer.set(payload, header.offset);
        receiving.received += payload.length;
    };

    const commitPageAsync = async (receiving: Receiving, message: PageEndMessage, bytes: Uint8Array<ArrayBuffer>, received: number, generation: number): Promise<void> => {
        if (receiving.isClosed || generation !== receiving.generation) {
            return;
        }

        const record = receiving.record;
        const link = context.link();
        const expected = pageLength(record.size, receiving.pageSize, message.page);
        const started = context.now();
        const hash = received === expected && bytes.length === expected ? await hashPageAsync(bytes) : undefined;
        if (receiving.isClosed || generation !== receiving.generation) {
            return;
        }

        if (!hash || toHex(hash) !== message.sha256) {
            receiving.generation++;
            receiving.receivingPage = message.page;
            receiving.buffer = undefined;
            receiving.received = 0;
            receiving.logger.warn('xfer', `${record.name} page ${message.page + 1}/${receiving.totalPages} hash mismatch, nack`, { page: message.page });
            if (link) {
                sendSlot(link, receiving.slot, { t: 'nack', re: message.id, fileId: record.fileId, page: message.page });
            }

            return;
        }

        const crc = receiving.crc == null ? undefined : crc32Update(receiving.crc, bytes);
        const pagesDone = message.page + 1;
        const latest = receiving.record;
        const { crc32: _, crc32Previous: __, ...pagination } = latest.pagination as StoredPagination;
        const updated: StoredFile = {
            ...latest,
            updatedAt: context.now(),
            pagination: {
                ...pagination,
                currentPage: pagesDone,
                pagesDone,
                ...(crc == null ? {} : { crc32: crc }),
                ...(receiving.crc == null ? {} : { crc32Previous: receiving.crc }),
                prefixHash: undefined,
            },
        };

        try {
            await context.storage.writePageAsync(
                { sessionId: receiving.sessionId, fileId: record.fileId, pageIndex: message.page, data: new Blob([bytes]), hash },
                updated,
            );
        } catch (error) {
            await storageFailedAsync(receiving, error);

            return;
        }

        receiving.record = { ...updated, hasThumbnail: updated.hasThumbnail || receiving.record.hasThumbnail };
        receiving.pagesDone = pagesDone;
        receiving.hashes.set(message.page, hash);
        receiving.crc = crc;
        if (receiving.logger.isEnabled('xfer', 'debug')) {
            const writeMs = Math.round(context.now() - started);
            receiving.logger.debug('xfer', `${record.name} page ${pagesDone}/${receiving.totalPages} saved ${writeMs} ms hash ${message.sha256.slice(0, 8)}…`, {
                page: message.page,
            });
        }

        reportProgress(receiving);
        if (
            receiving.isClosed
            || !link
            || context.link() !== link
        ) {
            return;
        }

        if (context.consumeTestTool('drop-ack')) {
            receiving.logger.warn('xfer', `${record.name} ack for page ${pagesDone} dropped by the test tool`);

            return;
        }

        sendSlot(link, receiving.slot, { t: 'ack', re: message.id, fileId: record.fileId, page: message.page });
    };

    // PW-08, §7.5: storage full pauses the file and keeps every saved page.
    const storageFailedAsync = async (receiving: Receiving, error: unknown): Promise<void> => {
        const isFull = isQuotaExceeded(error);
        const record = receiving.record;
        receiving.logger.warn('store', isFull
            ? `${record.name} storage full, paused after page ${receiving.pagesDone}`
            : `${record.name} page write failed`, error);
        close(receiving);
        const paused: StoredFile = {
            ...record,
            state: 'paused',
            pausedBy: 'storage',
            note: isFull ? 'storage-full' : undefined,
            lastError: isFull ? 'Storage full' : 'Could not save a page',
            pagination: detachedPagination(receiving),
            updatedAt: context.now(),
        };
        receiving.record = paused;
        await putRecordAsync(paused);
        const link = context.link();
        if (link) {
            sendSlot(link, receiving.slot, { t: 'cancel', fileId: record.fileId, direction: 'in', keepPartial: true, reason: 'storage-full' });
        }

        context.events.emit('error', new ClientError(isFull ? 'storage-full' : 'internal', paused.lastError ?? 'Storage error', record.fileId));
    };

    const handlePageEnd = (slot: SlotId, message: PageEndMessage): void => {
        const receiving = byFileId.get(message.fileId);
        if (!receiving || receiving.slot !== slot) {
            context.logger.debug('xfer', `page-end for an unknown file ignored`, { fileId: message.fileId });

            return;
        }

        if (message.page >= receiving.totalPages) {
            receiving.logger.warn('xfer', `page-end for page ${message.page + 1} of ${receiving.totalPages} dropped`);

            return;
        }

        const link = context.link();
        if (message.page < receiving.pagesDone) {
            const saved = receiving.hashes.get(message.page);
            const isSame = saved != null && toHex(saved) === message.sha256;
            receiving.logger.info('xfer', isSame
                ? `${receiving.record.name} page ${message.page + 1} already saved, re-acked without writing`
                : `${receiving.record.name} page ${message.page + 1} differs from the saved one, nack`, { page: message.page });
            if (link) {
                sendSlot(link, slot, { t: isSame ? 'ack' : 'nack', re: message.id, fileId: message.fileId, page: message.page });
            }

            return;
        }

        if (message.page !== receiving.receivingPage) {
            receiving.logger.debug('xfer', `${receiving.record.name} page-end for page ${message.page + 1} ignored while expecting ${receiving.receivingPage + 1}`);

            return;
        }

        const bytes = receiving.buffer ?? new Uint8Array(0);
        const received = receiving.received;
        receiving.buffer = undefined;
        receiving.received = 0;
        receiving.receivingPage = message.page + 1;
        const generation = receiving.generation;
        receiving.chain = receiving.chain
            .then(() => commitPageAsync(receiving, message, bytes, received, generation))
            .catch(error => receiving.logger.error('xfer', `${receiving.record.name} page ${message.page + 1} not saved`, error));
    };

    // TH-04, and whenever the sender could not make one: the receiver makes its own from the verified file.
    const createOwnThumbnailAsync = async (record: StoredFile): Promise<void> => {
        const key = thumbKey(record.sessionId, record.fileId);
        if (record.kind === 'other' || !record.hasData || storedThumbs.has(key) || busyThumbs.has(key)) {
            return;
        }

        busyThumbs.add(key);
        try {
            if (record.hasThumbnail || await context.storage.getThumbAsync(record.sessionId, record.fileId)) {
                storedThumbs.add(key);

                return;
            }

            const pages = await context.storage.readPagesAsync(record.sessionId, record.fileId);
            const file = new File(pages.map(page => page.data), record.name, { type: record.mime, lastModified: record.lastModified });
            const thumbnail = await context.media.createThumbnailAsync(file, record.metadata);
            if (!thumbnail) {
                return;
            }

            await context.storage.putThumbAsync({ sessionId: record.sessionId, fileId: record.fileId, data: thumbnail, createdAt: context.now() });
            storedThumbs.add(key);
            await markThumbnailAsync(record.sessionId, record.fileId);

            context.logger.debug('xfer', `${record.name} thumbnail made here`);
            context.events.emit('thumb', record.fileId, record.sessionId);
        } catch (error) {
            context.logger.warn('xfer', `${record.name} thumbnail not made`, error);
        } finally {
            busyThumbs.delete(key);
        }
    };

    const stopWaitingForThumb = (key: string, isMakingOwn: boolean): void => {
        const waiting = awaitingThumbs.get(key);
        if (!waiting) {
            return;
        }

        clearTimeout(waiting.timer);
        awaitingThumbs.delete(key);
        expectedThumbs.delete(key);
        if (isMakingOwn) {
            void createOwnThumbnailAsync(waiting.record);
        }
    };

    // A verified file gets its thumbnail now, unless the sender announced one: then only if it doesn't come in time.
    const ensureThumbnail = (record: StoredFile): void => {
        if (!expectedThumbs.has(thumbKey(record.sessionId, record.fileId))) {
            void createOwnThumbnailAsync(record);

            return;
        }

        const key = thumbKey(record.sessionId, record.fileId);
        const timer = setTimeout(() => stopWaitingForThumb(key, true), THUMB_WAIT_MS);
        awaitingThumbs.set(key, { record, timer });
    };

    const handleFileEndAsync = async (slot: SlotId, message: FileEndMessage): Promise<void> => {
        const link = context.link();
        if (!link) {
            return;
        }

        const receiving = byFileId.get(message.fileId);
        if (!receiving || receiving.slot !== slot) {
            // The done reply of a finished file was lost: answer from the record.
            const existing = await context.storage.getFileAsync(link.sessionId, message.fileId, 'in');
            if (existing?.state === 'done') {
                sendSlot(link, slot, { t: 'done', re: message.id, fileId: message.fileId, ok: existing.rootHash === message.rootHash });
            }

            return;
        }

        await receiving.chain;
        if (receiving.isClosed || context.link() !== link) {
            return;
        }

        const rootHash = receiving.pagesDone === receiving.totalPages
            ? await rootHashAsync(receiving.hashes.bytes, receiving.totalPages)
            : undefined;
        if (receiving.isClosed || context.link() !== link) {
            return;
        }

        if (rootHash !== message.rootHash) {
            receiving.logger.warn('xfer', `${receiving.record.name} root hash mismatch, starting over from page 0`);
            receiving.generation++;
            receiving.pagesDone = 0;
            receiving.receivingPage = 0;
            receiving.hashes = new PageHashList();
            receiving.crc = CRC32_INITIAL;
            const { crc32Previous: _, ...pagination } = receiving.record.pagination as StoredPagination;
            receiving.record = {
                ...receiving.record,
                attempts: receiving.record.attempts + 1,
                updatedAt: context.now(),
                pagination: {
                    ...pagination,
                    currentPage: 0,
                    pagesDone: 0,
                    crc32: CRC32_INITIAL,
                    prefixHash: undefined,
                },
            };
            await context.storage.putFileDeletingPagesAsync(receiving.record, 0);
            sendSlot(link, slot, { t: 'done', re: message.id, fileId: message.fileId, ok: false });

            return;
        }

        close(receiving);
        const done: StoredFile = {
            ...withoutPagination(receiving.record),
            hasThumbnail: receiving.record.hasThumbnail || storedThumbs.has(thumbKey(link.sessionId, message.fileId)),
            state: 'done',
            rootHash,
            rootPageSize: receiving.pageSize,
            completedAt: context.now(),
            updatedAt: context.now(),
            ...(receiving.crc == null ? {} : { crc32: receiving.crc }),
            hasData: true,
            pausedBy: undefined,
            lastError: undefined,
        };
        // §7.2: pagination goes and rootHash/completedAt stay in the one write that marks the file done.
        await putRecordAsync(done, false);
        indexContent(done);
        sendSlot(link, slot, { t: 'done', re: message.id, fileId: message.fileId, ok: true });
        receiving.logger.info('xfer', `${done.name} verified, root hash ${rootHash.slice(0, 8)}…`);
        hooks.onFileDone(done);
        ensureThumbnail(done);
    };

    // A canceled file keeps nothing: its pages and pagination go. A file that finished meanwhile stays finished.
    // `isCounted` false leaves the batch count to the caller (Stop counts the whole batch at once).
    const cancelDroppingPartialAsync = async (sessionId: string, fileId: string, isCounted: boolean): Promise<StoredFile | undefined> => {
        const receiving = receivingFor(sessionId, fileId);
        if (receiving) {
            close(receiving);
            await receiving.chain;
        }

        let wasUnfinished = receiving != null;
        const canceled = await patchRecordAsync(sessionId, fileId, current => {
            if (current.state === 'done' || current.state === 'failed') {
                return undefined;
            }

            wasUnfinished ||= current.state !== 'canceled';

            return { ...withoutPagination(current), state: 'canceled', pausedBy: undefined, hasData: false, updatedAt: context.now() };
        }, { deletePages: true });
        if (canceled && wasUnfinished && isCounted) {
            hooks.onFileStopped(canceled);
        }

        return canceled;
    };

    const handleCancelAsync = async (message: CancelMessage): Promise<void> => {
        const link = context.link();
        if (!link) {
            return;
        }

        const reason = message.reason ?? 'canceled';
        prompts.delete(thumbKey(link.sessionId, message.fileId));
        const receiving = byFileId.get(message.fileId);
        const changes: Partial<StoredFile> = {
            state: STATE_BY_CANCEL_REASON[reason],
            ...(reason === 'paused' ? { pausedBy: 'peer' as const } : {}),
            ...(reason === 'failed' ? { lastError: `Failed on ${link.peerName}` } : {}),
        };
        context.logger.info('xfer', `cancel from ${link.peerName} reason=${reason}`, { fileId: message.fileId });
        // Canceled by the sender: the partial goes, whatever keepPartial says. Pauses and failures keep it.
        if (reason === 'canceled') {
            await cancelDroppingPartialAsync(link.sessionId, message.fileId, true);

            return;
        }

        // A pause from the peer never undoes a Stop here: the file stays stopped until Resume.
        const isPause = reason === 'paused' || reason === 'storage-full';
        const isKept = (current: StoredFile): boolean => FINISHED_STATES.includes(current.state)
            || (isPause && isStoppedRecord(current));
        const stopped = receiving
            ? await stopReceivingAsync(receiving, changes)
            : await patchRecordAsync(link.sessionId, message.fileId, current => (isKept(current)
                ? undefined
                : { ...current, ...changes, updatedAt: context.now() }));
        if (stopped && FINISHED_STATES.includes(stopped.state)) {
            hooks.onFileStopped(stopped);
        }
    };

    // Stop and Delete what arrived start the same way, before any await: offers of the batch get no answer and its
    // moving files stop taking pages. Then the offers being answered are waited for, so no record is written after
    // the files are listed: the waiting ones first, then the moving ones once their last page is written.
    const haltBatchAsync = async (sessionId: string, batchId: string): Promise<BatchHalt> => {
        const key = `${sessionId}:${batchId}`;
        stoppedBatches.add(key);
        const moving = [...byFileId.values()]
            .filter(receiving => receiving.sessionId === sessionId && receiving.record.batchId === batchId);
        for (const receiving of moving) {
            close(receiving);
        }

        await Promise.allSettled([...(answering.get(key) ?? [])]);
        batchPrompts.delete(batchId);
        for (const [promptKey, prompt] of [...prompts]) {
            if (prompt.link.sessionId === sessionId && prompt.offer.batchId === batchId) {
                prompts.delete(promptKey);
            }
        }

        const stored = await context.storage.listFilesInStatesAsync(sessionId, UNFINISHED_STATES);
        const movingIds = new Set(moving.map(receiving => receiving.record.fileId));
        const waitingIds = stored
            .filter(file => file.direction === 'in' && file.batchId === batchId && !movingIds.has(file.fileId))
            .map(file => file.fileId);
        for (const receiving of moving) {
            await receiving.chain;
        }

        return { fileIds: [...waitingIds, ...movingIds], movingFileIds: [...movingIds] };
    };

    const cancelBatchAsync = async (sessionId: string, batchId: string): Promise<number> => {
        const { fileIds } = await haltBatchAsync(sessionId, batchId);
        for (const fileId of fileIds) {
            await cancelDroppingPartialAsync(sessionId, fileId, false);
        }

        const batch = batchId.slice(0, 8);
        context.logger.info('xfer', `batch ${batch}: ${fileIds.length} incoming files canceled, partial files deleted`);

        return fileIds.length;
    };

    // A stopped file keeps its saved pages and pagination. One still waiting for this device's Accept had nothing
    // arrive: it ends canceled, so resuming it asks again.
    const stopKeepingAsync = async (sessionId: string, fileId: string): Promise<boolean> => {
        let isAsked = false;
        const stopped = await patchRecordAsync(sessionId, fileId, current => {
            if (FINISHED_STATES.includes(current.state) || isStoppedRecord(current)) {
                return undefined;
            }

            if (current.state === 'incoming') {
                isAsked = true;

                return undefined;
            }

            const pagination = current.pagination && current.pagination.pagesDone > 0
                ? { pagination: { ...current.pagination, slot: null } }
                : {};

            return {
                ...withoutPagination(current),
                ...pagination,
                state: 'paused',
                pausedBy: 'stop',
                updatedAt: context.now(),
            };
        });
        if (isAsked) {
            return (await cancelDroppingPartialAsync(sessionId, fileId, true)) != null;
        }

        return stopped != null;
    };

    const stopBatchAsync = async (sessionId: string, batchId: string): Promise<BatchStop> => {
        const { fileIds, movingFileIds } = await haltBatchAsync(sessionId, batchId);
        let count = 0;
        for (const fileId of fileIds) {
            count += await stopKeepingAsync(sessionId, fileId) ? 1 : 0;
        }

        const stoppedText = `${count} incoming files stopped, what arrived is kept`;
        context.logger.info('xfer', `batch ${batchId.slice(0, 8)}: ${stoppedText}`);

        return { count, movingFileIds };
    };

    // The stopped files wait as queued, with their saved pages, for the sender's offer; the batch's offers are
    // answered again.
    const resumeBatchAsync = async (
        sessionId: string,
        batchId: string,
        fileIds?: readonly string[],
    ): Promise<number> => {
        stoppedBatches.delete(`${sessionId}:${batchId}`);
        const stopped = (await context.storage.listFilesInStatesAsync(sessionId, ['paused']))
            .filter(file => file.direction === 'in' && file.batchId === batchId && isStoppedRecord(file))
            .filter(file => fileIds == null || fileIds.includes(file.fileId));
        let count = 0;
        for (const file of stopped) {
            const resumed = await patchRecordAsync(sessionId, file.fileId, current => (isStoppedRecord(current)
                ? { ...current, state: 'queued', pausedBy: undefined, updatedAt: context.now() }
                : undefined));
            count += resumed ? 1 : 0;
        }

        context.logger.info('xfer', `batch ${batchId.slice(0, 8)}: ${count} incoming files resumed`);

        return count;
    };

    const handleThumbAsync = async (message: ThumbMessage): Promise<void> => {
        const link = context.link();
        if (!link) {
            return;
        }

        const key = thumbKey(link.sessionId, message.fileId);
        expectedThumbs.delete(key);
        if (message.jpeg == null) {
            declinedThumbs.add(key);
            context.logger.debug('xfer', 'the sender has no thumbnail, making one here', { fileId: message.fileId });
            stopWaitingForThumb(key, true);

            return;
        }

        stopWaitingForThumb(key, false);
        const receiving = byFileId.get(message.fileId);
        const existing = receiving?.record ?? await context.storage.getFileAsync(link.sessionId, message.fileId, 'in');
        if (!existing) {
            context.logger.debug('xfer', 'thumbnail for an unknown file dropped', { fileId: message.fileId });

            return;
        }

        if (existing.hasThumbnail || storedThumbs.has(key) || busyThumbs.has(key)) {
            context.logger.debug('xfer', `${existing.name} already has a thumbnail, the late one is dropped`);

            return;
        }

        busyThumbs.add(key);
        try {
            const data = new Blob([decodeBase64(message.jpeg)], { type: 'image/jpeg' });
            await context.storage.putThumbAsync({ sessionId: link.sessionId, fileId: message.fileId, data, createdAt: context.now() });
            storedThumbs.add(key);
        } catch (error) {
            context.logger.warn('store', `${existing.name} thumbnail not saved`, error);

            return;
        } finally {
            busyThumbs.delete(key);
        }

        // The file may have finished while the thumbnail was written: only the flag changes, on the stored record.
        if (receiving && !receiving.isClosed) {
            receiving.record = { ...receiving.record, hasThumbnail: true };
        }

        await markThumbnailAsync(link.sessionId, message.fileId);
        context.events.emit('thumb', message.fileId, link.sessionId);
    };

    const answerBatchMessageAsync = (link: Link, slot: SlotId, message: OfferBatchMessage, batch: StoredBatch): Promise<void> => trackAsync(
        link.sessionId,
        message.batchId,
        () => answerBatchWindowAsync(link, slot, message, batch),
    );

    const answerBatchWindowAsync = async (link: Link, slot: SlotId, message: OfferBatchMessage, batch: StoredBatch): Promise<void> => {
        let budget: BatchBudget = batch.budget ?? { mode: 'all', budgetBytes: UNLIMITED_BYTES, acceptedBytes: 0, isSpent: false };
        const entries: BatchReplyEntry[] = [];
        let rejected = 0;
        let alreadyHere = 0;
        let alreadyHereBytes = 0;
        for (const candidate of message.files as readonly unknown[]) {
            // Stopped meanwhile: the rest of the window is left alone and the window gets no answer.
            if (isStopped(link.sessionId, message.batchId)) {
                break;
            }

            // SP-05 per file: one manifest that can't be read is refused alone, the rest of the batch goes on.
            const problem = validateManifest(candidate);
            if (problem) {
                const fields = (candidate ?? {}) as Readonly<Record<string, unknown>>;
                const fileId = typeof fields.fileId === 'string' && /^[0-9a-f]{32}$/.test(fields.fileId) ? fields.fileId : undefined;
                context.logger.warn('xfer', `batch ${message.batchId.slice(0, 8)}: manifest refused, ${problem}`, {
                    ...(fileId == null ? {} : { fileId }),
                    name: typeof fields.name === 'string' ? fields.name.slice(0, 80) : undefined,
                });
                rejected++;
                if (fileId != null) {
                    entries.push({ fileId, reply: 'reject', reason: 'invalid' });
                }

                continue;
            }

            const manifest = candidate as FileManifest;
            const offer = { ...manifest, batchId: message.batchId };
            if (manifest.thumb) {
                expectThumb(thumbKey(link.sessionId, manifest.fileId));
            }

            const existing = await context.storage.getFileAsync(link.sessionId, manifest.fileId, 'in');
            if (existing != null && isHeld(existing)) {
                entries.push({ fileId: manifest.fileId, reply: 'have', ...peerCheckOf(existing) });
                alreadyHere++;
                alreadyHereBytes += manifest.size;
                continue;
            }

            const copy = existing == null ? await findHeldCopyAsync(link.sessionId, offer) : undefined;
            if (copy) {
                context.logger.info('xfer', `${manifest.name} is here already as ${copy.relativePath ?? copy.name}`, { fileId: manifest.fileId });
                entries.push({ fileId: manifest.fileId, reply: 'have', ...peerCheckOf(copy) });
                alreadyHere++;
                alreadyHereBytes += manifest.size;
                continue;
            }

            if (existing?.state === 'done') {
                await forgetThumbAsync(link.sessionId, manifest.fileId);
            }

            // A partial offered again in a batch, also one stopped here, waits with its saved pages for the
            // file's offer.
            leaveBatch(existing, message.batchId);
            if (isResumable(existing, manifest.size)) {
                const waiting = isStoppedRecord(existing) ? { state: 'queued' as const, pausedBy: undefined } : {};
                const moved = { ...existing, ...waiting, batchId: message.batchId, updatedAt: context.now() };
                await putRecordAsync(moved, false);
                entries.push({
                    fileId: manifest.fileId,
                    reply: 'accept',
                    fromPage: resumePageOf(existing.pagination.pagesDone),
                    pageSize: existing.pagination.pageSize,
                });
                continue;
            }

            const adopted = await adoptPartialAsync(offer, link.sessionId);
            if (adopted?.pagination) {
                entries.push({
                    fileId: manifest.fileId,
                    reply: 'accept',
                    fromPage: resumePageOf(adopted.pagination.pagesDone),
                    pageSize: adopted.pagination.pageSize,
                });
                continue;
            }

            const admission = admitToBudget(budget, manifest.size);
            budget = admission.budget;
            const record = newRecord(offer, link.sessionId, existing);
            if (!admission.isAdmitted) {
                const reason: RejectReason = budget.mode === 'declined' ? 'declined' : 'space';
                rejected++;
                entries.push({ fileId: manifest.fileId, reply: 'reject', reason });
                await putRecordAsync({ ...record, state: 'failed', note: reason === 'space' ? 'no-space' : 'declined', lastError: reason === 'space' ? 'Not enough space' : 'Declined' });
                continue;
            }

            entries.push({ fileId: manifest.fileId, reply: 'accept', fromPage: 0, pageSize: manifest.pageSize });
            await putRecordAsync({ ...record, state: 'queued' });
        }

        const finalBudget = budget;
        await context.batches.updateAsync(link.sessionId, message.batchId, current => ({
            ...withHeader(current ?? batch, message),
            budget: finalBudget,
        }));
        hooks.onBatchAnswered(link.sessionId, message.batchId, { alreadyHere, alreadyHereBytes, rejected });
        if (isStopped(link.sessionId, message.batchId)) {
            return;
        }

        sendSlot(link, slot, { t: 'batch-reply', re: message.id, batchId: message.batchId, files: entries });
        context.logger.info('xfer', `batch ${message.batchId.slice(0, 8)} part ${message.index + 1}: ${entries.length} files answered, ${rejected} rejected`);
    };

    const handleOfferBatchAsync = async (slot: SlotId, message: OfferBatchMessage): Promise<void> => {
        const link = context.link();
        if (!link) {
            return;
        }

        if (isStopped(link.sessionId, message.batchId)) {
            context.logger.debug('xfer', `batch ${message.batchId.slice(0, 8)} offer of a stopped batch ignored`);

            return;
        }

        const pending = batchPrompts.get(message.batchId);
        if (pending) {
            pending.queue.push({ slot, message });
            sendSlot(link, slot, { t: 'wait', re: message.id, batchId: message.batchId });

            return;
        }

        const stored = await context.batches.getAsync(link.sessionId, message.batchId);
        const batch: StoredBatch = stored ? withHeader(stored, message) : {
            sessionId: link.sessionId,
            batchId: message.batchId,
            direction: 'in',
            itemCount: message.itemCount ?? message.files.length,
            totalBytes: message.totalBytes ?? message.files.reduce((sum, file) => sum + file.size, 0),
            received: 0,
            saved: 0,
            failed: 0,
            createdAt: context.now(),
        };
        if (batch.budget) {
            await answerBatchMessageAsync(link, slot, message, batch);

            return;
        }

        const free = await context.freeSpaceAsync();
        const info = describeBatchIncoming({
            sessionId: link.sessionId,
            batchId: message.batchId,
            peerName: link.peerName,
            itemCount: batch.itemCount,
            totalBytes: batch.totalBytes,
            ...(message.sizes == null ? {} : { sizes: message.sizes }),
            ...(free == null ? {} : { freeBytes: free }),
        });
        const isShort = free != null && free < batch.totalBytes;
        if (context.settings().askBeforeReceiving || isShort) {
            await context.batches.updateAsync(
                link.sessionId,
                message.batchId,
                current => (current ? withHeader(current, message) : batch),
            );
            batchPrompts.set(message.batchId, { sessionId: link.sessionId, info, queue: [{ slot, message }] });
            sendSlot(link, slot, { t: 'wait', re: message.id, batchId: message.batchId });
            context.logger.info('xfer', `batch of ${batch.itemCount} files (${formatBytes(batch.totalBytes)}) waiting for an answer`);
            context.events.emit('batch-incoming', info);

            return;
        }

        await answerBatchMessageAsync(link, slot, message, { ...batch, budget: { mode: 'all', budgetBytes: UNLIMITED_BYTES, acceptedBytes: 0, isSpent: false } });
    };

    const answerBatchPromptAsync = async (batchId: string, budget: BatchBudget): Promise<void> => {
        const pending = batchPrompts.get(batchId);
        if (!pending) {
            return;
        }

        batchPrompts.delete(batchId);
        const answered = await context.batches.updateAsync(pending.sessionId, batchId, current => (current ? { ...current, budget } : current));
        const link = context.link();
        if (
            !answered
            || !link
            || link.sessionId !== pending.sessionId
        ) {
            return;
        }

        for (const { slot, message } of pending.queue) {
            const batch = (await context.batches.getAsync(pending.sessionId, batchId)) ?? answered;
            await answerBatchMessageAsync(link, slot, message, batch);
        }
    };

    const linkDownAsync = async (): Promise<void> => {
        // Offers on their way at a Stop are gone with the link; the stopped records keep the Stop.
        stoppedBatches.clear();
        const active = [...byFileId.values()];
        await Promise.all(active.map(receiving => stopReceivingAsync(receiving, { state: 'paused', pausedBy: 'link' })));
        prompts.clear();
        for (const pending of batchPrompts.values()) {
            pending.queue = [];
        }

        // Announced thumbnails can't come over a dead link: verified files get their own now.
        for (const key of [...awaitingThumbs.keys()]) {
            stopWaitingForThumb(key, true);
        }
    };

    const syncEntriesAsync = async (sessionId: string): Promise<SyncEntry[]> => {
        const files = await context.storage.listFilesInStatesAsync(sessionId, ONGOING_STATES);
        const entries: SyncEntry[] = [];
        for (const file of files) {
            const pagination = file.pagination;
            // A stopped file goes even before its first page, so a sender that missed the Stop stops it too.
            const isStopped = isStoppedRecord(file);
            if (file.direction !== 'in' || (!pagination && !isStopped)) {
                continue;
            }

            const hashes = pagination
                ? await readHashesAsync(sessionId, file.fileId, pagination.pagesDone)
                : new PageHashList();
            const pagesDone = Math.min(pagination?.pagesDone ?? 0, hashes.count);
            const pageSize = pagination?.pageSize ?? context.transferSettings().pageSize;
            entries.push({
                fileId: file.fileId,
                direction: 'in',
                name: file.name,
                size: file.size,
                pageSize,
                totalPages: pagination?.totalPages ?? countPages(file.size, pageSize),
                pagesDone,
                ...(pagesDone > 0 ? { prefixHash: await prefixHashAsync(hashes.bytes, pagesDone) } : {}),
                state: file.state,
                ...(file.pausedBy === 'user' || isStopped ? { held: true } : {}),
                ...(isStopped ? { stopped: true } : {}),
            });
        }

        return entries;
    };

    const applyPeerSyncAsync = async (sessionId: string, peerEntries: readonly SyncEntry[]): Promise<SyncDecision[]> => {
        const offered = new Map(peerEntries.filter(entry => entry.direction === 'out').map(entry => [entry.fileId, entry]));
        // A Stop made on the sender while the link was down reaches this device here: the batch stops here too.
        const missedStops = new Set<string>();
        for (const peerEntry of offered.values()) {
            if (peerEntry.stopped !== true) {
                continue;
            }

            const record = await context.storage.getFileAsync(sessionId, peerEntry.fileId, 'in');
            if (record?.batchId != null && isUnfinished(record) && !isStoppedRecord(record)) {
                missedStops.add(record.batchId);
            }
        }

        for (const batchId of missedStops) {
            const peerName = context.link()?.peerName ?? 'the peer';
            context.logger.info('resume', `batch ${batchId.slice(0, 8)} was stopped on ${peerName}, stopping it here`);
            await stopBatchAsync(sessionId, batchId);
        }

        const own = await syncEntriesAsync(sessionId);
        const decisions: SyncDecision[] = [];
        for (const entry of own) {
            // A stopped file doesn't resume until Resume.
            const peerEntry = offered.get(entry.fileId);
            if (!peerEntry || entry.stopped === true) {
                continue;
            }

            // §7.4 step 3: the receiver's saved pages win.
            context.logger.info('resume', `peer sync: ${entry.name} in, ${entry.pagesDone}/${entry.totalPages} pages, peer says ${peerEntry.pagesDone}`);
            decisions.push({
                sessionId,
                fileId: entry.fileId,
                name: entry.name,
                direction: 'in',
                decision: 'resume',
                fromPage: resumePageOf(entry.pagesDone),
                totalPages: entry.totalPages,
            });
        }

        return decisions;
    };

    // A file arriving now belongs to the connected session only.
    const receivingFor = (sessionId: string, fileId: string): Receiving | undefined => {
        const receiving = byFileId.get(fileId);

        return receiving?.sessionId === sessionId ? receiving : undefined;
    };

    const findAsync = async (sessionId: string, fileId: string): Promise<StoredFile | undefined> => (
        receivingFor(sessionId, fileId)?.record ?? context.storage.getFileAsync(sessionId, fileId, 'in')
    );

    // Only the device a file belongs to hears about it; a record of another session changes here alone.
    const sendCancel = (record: StoredFile, keepPartial: boolean, reason: CancelMessage['reason']): void => {
        const link = context.link();
        const fileId = record.fileId;
        if (!link || link.sessionId !== record.sessionId) {
            return;
        }

        sendSlot(link, byFileId.get(fileId)?.slot ?? SLOT_MESSAGE_CHANNEL, { t: 'cancel', fileId, direction: 'in', keepPartial, ...(reason == null ? {} : { reason }) });
    };

    const isUnfinished = (file: StoredFile | undefined): file is StoredFile => file != null && !FINISHED_STATES.includes(file.state);

    return {
        handleOfferAsync,
        handleOfferBatchAsync,
        handleFrame,
        handlePageEnd,
        handleFileEndAsync,
        handleCancelAsync,
        cancelBatchAsync,
        stopBatchAsync,
        resumeBatchAsync,
        releaseBatch: (sessionId, batchId) => {
            stoppedBatches.delete(`${sessionId}:${batchId}`);
        },
        handleThumbAsync,
        linkDownAsync,
        forgetSessionAsync: async (sessionId, fileIds, includeUnfinished) => {
            contentIndexes.delete(sessionId);
            if (includeUnfinished) {
                for (const receiving of [...byFileId.values()].filter(candidate => candidate.sessionId === sessionId)) {
                    sendCancel(receiving.record, false, 'canceled');
                    close(receiving);
                    await receiving.chain;
                }

                for (const [key, prompt] of [...prompts]) {
                    if (prompt.link.sessionId !== sessionId) {
                        continue;
                    }

                    prompts.delete(key);
                    if (prompt.link === context.link() && prompt.link.isOpen) {
                        sendSlot(prompt.link, prompt.slot, { t: 'reject', re: prompt.offer.id, fileId: prompt.offer.fileId, reason: 'declined' });
                    }
                }

                for (const [batchId, pending] of [...batchPrompts]) {
                    if (pending.sessionId === sessionId) {
                        batchPrompts.delete(batchId);
                    }
                }
            }

            for (const fileId of fileIds) {
                const key = thumbKey(sessionId, fileId);
                const waiting = awaitingThumbs.get(key);
                clearTimeout(waiting?.timer);
                awaitingThumbs.delete(key);
                expectedThumbs.delete(key);
                declinedThumbs.delete(key);
                storedThumbs.delete(key);
            }
        },
        linkUp: sessionId => {
            for (const [batchId, pending] of batchPrompts) {
                if (pending.sessionId !== sessionId) {
                    batchPrompts.delete(batchId);
                }
            }
        },
        syncEntriesAsync,
        applyPeerSyncAsync,
        acceptIncomingAsync: async (sessionId, fileId) => {
            const prompt = prompts.get(thumbKey(sessionId, fileId));
            prompts.delete(thumbKey(sessionId, fileId));
            const link = context.link();
            if (
                prompt
                && link === prompt.link
                && link.isOpen
            ) {
                const existing = await context.storage.getFileAsync(link.sessionId, fileId, 'in');
                const record = existing ?? newRecord(prompt.offer, link.sessionId);
                await beginAsync(link, prompt.slot, prompt.offer, { kind: 'accept', record, fromPage: 0, pageSize: prompt.offer.pageSize });

                return;
            }

            // Answered while the link is down: the next offer of this file is accepted without asking.
            await patchRecordAsync(sessionId, fileId, current => (current.state === 'incoming'
                ? { ...current, state: 'queued', updatedAt: context.now() }
                : undefined));
        },
        rejectIncomingAsync: async (sessionId, fileId, reason) => {
            const prompt = prompts.get(thumbKey(sessionId, fileId));
            prompts.delete(thumbKey(sessionId, fileId));
            const link = context.link();
            if (
                prompt
                && link === prompt.link
                && link.isOpen
            ) {
                sendSlot(link, prompt.slot, { t: 'reject', re: prompt.offer.id, fileId, reason });
            }

            const existing = await findAsync(sessionId, fileId);
            if (existing?.state === 'incoming' || existing?.state === 'queued') {
                await patchRecordAsync(sessionId, fileId, current => (current.state === 'incoming' || current.state === 'queued'
                    ? {
                        ...current,
                        state: 'failed',
                        note: reason === 'space' ? 'no-space' : 'declined',
                        lastError: reason === 'space' ? 'Not enough space' : 'Declined',
                        updatedAt: context.now(),
                    }
                    : undefined));
            }
        },
        acceptBatchAsync: async (batchId, mode) => {
            const pending = batchPrompts.get(batchId);
            if (!pending) {
                return;
            }

            const budgetBytes = mode === 'fits' ? pending.info.fitsBytes : UNLIMITED_BYTES;
            await answerBatchPromptAsync(batchId, { mode, budgetBytes, acceptedBytes: 0, isSpent: false });
        },
        declineBatchAsync: async batchId => {
            await answerBatchPromptAsync(batchId, { mode: 'declined', budgetBytes: 0, acceptedBytes: 0, isSpent: true });
        },
        pauseAsync: async (sessionId, fileId) => {
            const receiving = receivingFor(sessionId, fileId);
            if (receiving) {
                sendCancel(receiving.record, true, 'paused');
                await stopReceivingAsync(receiving, { state: 'paused', pausedBy: 'user' });

                return true;
            }

            const existing = await findAsync(sessionId, fileId);
            if (!isUnfinished(existing)) {
                return false;
            }

            // A stopped file already rests; only Resume moves it again.
            if (isStoppedRecord(existing)) {
                return true;
            }

            if (existing.state !== 'paused' || existing.pausedBy !== 'user') {
                sendCancel(existing, true, 'paused');
                await patchRecordAsync(sessionId, fileId, current => (FINISHED_STATES.includes(current.state)
                    ? undefined
                    : { ...current, state: 'paused', pausedBy: 'user', updatedAt: context.now() }));
            }

            return true;
        },
        resumeAsync: async (sessionId, fileId) => {
            if (receivingFor(sessionId, fileId)) {
                return true;
            }

            const existing = await findAsync(sessionId, fileId);
            if (!existing || existing.state !== 'paused') {
                return existing != null && isUnfinished(existing);
            }

            await patchRecordAsync(sessionId, fileId, current => (current.state === 'paused'
                ? { ...current, pausedBy: undefined, note: undefined, lastError: undefined, updatedAt: context.now() }
                : undefined));

            return true;
        },
        cancelAsync: async (sessionId, fileId) => {
            const prompt = prompts.get(thumbKey(sessionId, fileId));
            const receiving = receivingFor(sessionId, fileId);
            const existing = receiving?.record ?? await findAsync(sessionId, fileId);
            if (!isUnfinished(existing)) {
                return false;
            }

            if (prompt) {
                prompts.delete(thumbKey(sessionId, fileId));
                const link = context.link();
                if (link === prompt.link && link.isOpen) {
                    sendSlot(link, prompt.slot, { t: 'reject', re: prompt.offer.id, fileId, reason: 'declined' });
                }
            } else {
                sendCancel(existing, false, 'canceled');
            }

            await cancelDroppingPartialAsync(sessionId, fileId, true);

            return true;
        },
        deletePartialAsync: async (sessionId, fileId) => {
            const receiving = receivingFor(sessionId, fileId);
            const existing = receiving?.record ?? await findAsync(sessionId, fileId);
            if (!existing || existing.state === 'done') {
                return false;
            }

            // The sender drops the file too, when it is the connected device.
            sendCancel(existing, false, 'canceled');
            if (receiving) {
                close(receiving);
                await receiving.chain;
            }

            let wasUnfinished = false;
            const deleted = await patchRecordAsync(sessionId, fileId, current => {
                if (current.state === 'done') {
                    return undefined;
                }

                wasUnfinished = !FINISHED_STATES.includes(current.state);

                return {
                    ...withoutPagination(current),
                    state: wasUnfinished ? 'canceled' : current.state,
                    hasData: false,
                    updatedAt: context.now(),
                };
            }, { deletePages: true });
            if (deleted && wasUnfinished) {
                hooks.onFileStopped(deleted);
            }

            return true;
        },
        findAsync,
        slots: () => [...bySlot.values()].map(receiving => ({ slot: receiving.slot, fileId: receiving.record.fileId })),
        pendingBatches: () => [...batchPrompts.values()].map(pending => pending.info),
    };
}
