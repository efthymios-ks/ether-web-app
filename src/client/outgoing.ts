import { formatBytes } from '../core/settings.js';
import { mediaKindOf } from '../media/mediaKind.js';
import { SLOT_IDS } from '../network/networkTypes.js';
import type { SlotId } from '../network/networkTypes.js';
import { planOfferBatch, sizesForHeader } from './batches.js';
import { ClientError } from './clientTypes.js';
import type { Batch, FileHandle, FileNote, FileState, ResumeMatch, SyncDecision, UnfinishedElsewhere } from './clientTypes.js';
import {
    HASH_BYTES,
    computeContentDigestAsync,
    computeRootHashAsync,
    fileIdFromDigestAsync,
    identityPathOf,
    prefixHashAsync,
    readPageAsync,
} from './hashing.js';
import { countPages, resolveConcurrency } from './pagination.js';
import { sanitizeMetadata } from './metadataSanitizer.js';
import type { BatchReplyEntry, BatchReplyMessage, CancelMessage, ErrorMessage, FileManifest, OfferBatchMessage, SyncEntry } from './protocol.js';
import { startSendFile } from './sendFile.js';
import type { SendFileRun, SendOutcome, SenderReply } from './sendFile.js';
import type { StoredFile, StoredPagination } from './storage.js';
import { createThumbnailPipeline } from './thumbnailPipeline.js';
import {
    SLOT_MESSAGE_CHANNEL,
    emitFileState,
    isStoppedRecord,
    toFileRecord,
    withoutPagination,
} from './transferContext.js';
import type { BatchStop, Link, TransferContext } from './transferContext.js';

// The sending side: the queue in pick order, file IDs and metadata prepared two at a time just ahead of sending
// (BK-06), batch offers (BK-02), the slot scheduler (TR-03, TR-08, CL-05), thumbnails ahead of the data (TH-02),
// and moving unfinished files from other sessions to the connected device.

const PREPARE_CONCURRENCY = 2;
// Prepared files waiting for a slot; preparation pauses beyond this many.
const PREPARE_AHEAD = 200;
// An unanswered offer is sent once more, after this pause, before its files fail.
const OFFER_RETRY_BACKOFF_MS = 1000;
const RESUMABLE_STATES: readonly FileState[] = Object.freeze(['queued', 'offered', 'active', 'paused', 'needs-file', 'verifying']);
const MOVABLE_STATES: readonly FileState[] = Object.freeze(['queued', 'offered', 'active', 'paused', 'needs-file']);
const FINISHED_STATES: readonly FileState[] = Object.freeze(['done', 'failed', 'canceled']);
const BUSY_STATES: readonly FileState[] = Object.freeze(['offered', 'active', 'verifying']);
const CHECK_NOTES: readonly (FileNote | undefined)[] = Object.freeze(['checking', 'check-waiting']);

// A file that stops while checking, or waiting to, no longer says so.
function withoutCheckNote(record: StoredFile | undefined): Partial<StoredFile> {
    return CHECK_NOTES.includes(record?.note) ? { note: undefined } : {};
}
const STATE_BY_CANCEL_REASON: Readonly<Record<NonNullable<CancelMessage['reason']>, FileState>> = Object.freeze({
    canceled: 'canceled',
    paused: 'paused',
    failed: 'failed',
    'storage-full': 'paused',
});

export interface OutgoingHooks {
    readonly nextQueueIndex: () => number;
    // A file reached done, failed or canceled, for batch counts and session totals.
    readonly onFileFinished: (record: StoredFile) => void;
    // A failed or canceled file is back in its batch (retry, resume), so it no longer counts as ended.
    readonly onFileReopened: (record: StoredFile, previous: FileState) => void;
    // An unfinished file left its batch for a newer pick of it, so the old batch counts one file less.
    readonly onFileLeftBatch: (record: StoredFile) => void;
}

export interface OutgoingSlotInfo {
    readonly slot: SlotId;
    readonly fileId: string;
}

export interface EnqueueOptions {
    readonly sessionId: string;
    readonly relativePaths?: readonly (string | undefined)[];
}

export interface Outgoing {
    loadAsync(): Promise<void>;
    enqueueAsync(files: readonly File[], options: EnqueueOptions): Promise<Batch>;
    // Called once hello and both syncs are done, and with false when the link goes.
    setReady(isReady: boolean): void;
    pump(): void;
    // Nothing new starts until the returned release is called.
    holdPump(): () => void;
    // Delete what arrived: every unfinished file of the batch ends canceled, its partial dropped; resolves with how
    // many.
    cancelBatchAsync(sessionId: string, batchId: string): Promise<number>;
    // Stop: every file of the batch still moving or waiting stops, keeping its pagination and page hashes.
    stopBatchAsync(sessionId: string, batchId: string): Promise<BatchStop>;
    // Resume: the batch's stopped files, or only `fileIds`, go back in the queue; resolves with how many.
    resumeBatchAsync(sessionId: string, batchId: string, fileIds?: readonly string[]): Promise<number>;
    handleReply(message: Exclude<SenderReply, ErrorMessage>): void;
    handleBatchReply(message: BatchReplyMessage): void;
    // The peer could not read a request at all: what it asked about fails now, with the peer's reason.
    handleError(message: ErrorMessage): void;
    handleCancelAsync(message: CancelMessage): Promise<void>;
    linkDownAsync(): Promise<void>;
    syncEntriesAsync(sessionId: string): Promise<SyncEntry[]>;
    applyPeerSyncAsync(sessionId: string, peerEntries: readonly SyncEntry[]): Promise<SyncDecision[]>;
    // Each returns false when the session has no outgoing record of the file.
    pauseAsync(sessionId: string, fileId: string): Promise<boolean>;
    resumeAsync(sessionId: string, fileId: string): Promise<boolean>;
    // Cancels on both sides; the partial file goes on both.
    cancelAsync(sessionId: string, fileId: string): Promise<boolean>;
    deletePartialAsync(sessionId: string, fileId: string): Promise<boolean>;
    // Matches only that session's waiting files when a session is given.
    resumeWithFilesAsync(files: readonly File[], sessionId?: string): Promise<ResumeMatch>;
    sendAgainAsync(sessionId: string, fileId: string): Promise<void>;
    retryFailedAsync(sessionId: string, batchId: string): Promise<void>;
    // Unfinished outgoing files of the sessions other than this one, per session, newest first.
    listUnfinishedElsewhereAsync(sessionId: string): Promise<UnfinishedElsewhere[]>;
    // Moves them into this session as one new batch; the old records end as canceled with note 'moved'.
    moveUnfinishedAsync(fromSessionIds: readonly string[], sessionId: string): Promise<{ readonly queued: number; readonly needsFile: number }>;
    // The File this page still holds for one session's outgoing file.
    heldFile(sessionId: string, fileId: string): { readonly record: StoredFile; readonly file: File } | undefined;
    // Saves changes to an outgoing record, through its run while it sends.
    amendAsync(fileId: string, sessionId: string, changes: Partial<StoredFile>): Promise<StoredFile | undefined>;
    slots(): OutgoingSlotInfo[];
    // Forgets every queued file, after "Clear all data".
    clear(): void;
    // Forgets one session's files: the finished ones, and with `includeUnfinished` the others too, canceled first
    // (the peer hears it when it is the connected one).
    forgetSessionAsync(sessionId: string, includeUnfinished: boolean): Promise<void>;
    dispose(): void;
}

interface OutgoingItem {
    readonly localId: string;
    readonly batchId: string;
    readonly sessionId: string;
    readonly queueIndex: number;
    readonly name: string;
    readonly size: number;
    readonly relativePath?: string;
    file: File | undefined;
    fileId?: string;
    record?: StoredFile;
    preparation: 'waiting' | 'running' | 'ready' | 'dropped';
    // single: offered on its own; pending: waits for an offer-batch; offered: in one; accepted: answered with accept.
    offering: 'single' | 'pending' | 'offered' | 'accepted';
    again: boolean;
    isResuming: boolean;
    isThumbQueued: boolean;
    // Stopped: set at the Stop's call, before its record is written, and for files not prepared yet.
    isStopped: boolean;
    // Resumed after a Stop, or picked again: its offer says so, so a receiver whose copy is stopped takes it.
    resumesStop: boolean;
    run?: SendFileRun;
}

interface OutstandingOffer {
    readonly id: string;
    readonly items: OutgoingItem[];
    readonly message: OfferBatchMessage;
    attempts: number;
    timer?: ReturnType<typeof setTimeout>;
}

interface OutgoingBatch {
    readonly batchId: string;
    readonly sessionId: string;
    readonly items: OutgoingItem[];
    readonly sendThumbnails: boolean;
    messageIndex: number;
    isHeaderAnswered: boolean;
    outstanding?: OutstandingOffer;
    // Fewer manifests per message after one turned out too large to send.
    maxWindow?: number;
}

// SP-05: the summary goes out sanitised, also for records saved before sanitising existed.
function metadataField(record: StoredFile): { readonly metadata?: FileManifest['metadata'] } {
    const metadata = sanitizeMetadata(record.metadata);

    return metadata ? { metadata } : {};
}

interface Rejection {
    readonly code: 'no-space' | 'canceled' | 'invalid-state';
    readonly note?: 'no-space' | 'declined';
    readonly message: string;
}

// Why the receiver refused a file of a batch, as the error and note the sender records.
function rejectionFor(reason: NonNullable<BatchReplyEntry['reason']>, name: string, peerName: string): Rejection {
    const REJECTIONS: Readonly<Record<NonNullable<BatchReplyEntry['reason']>, Rejection>> = {
        space: { code: 'no-space', note: 'no-space', message: 'Not enough space' },
        declined: { code: 'canceled', note: 'declined', message: 'Declined' },
        paused: { code: 'canceled', note: 'declined', message: 'Declined' },
        invalid: { code: 'invalid-state', message: `${peerName} could not read the details of ${name}` },
    };

    return REJECTIONS[reason];
}

// What the first offer-batch message tells the receiver's prompt (BK-03).
function batchHeader(batch: OutgoingBatch): { readonly itemCount: number; readonly totalBytes: number; readonly sizes?: readonly number[] } {
    const live = batch.items.filter(item => item.preparation !== 'dropped');
    const sizes = sizesForHeader(live.map(item => item.size));

    return {
        itemCount: live.length,
        totalBytes: live.reduce((sum, item) => sum + item.size, 0),
        ...(sizes ? { sizes } : {}),
    };
}

export function createOutgoing(context: TransferContext, hooks: OutgoingHooks): Outgoing {
    const itemsByKey = new Map<string, OutgoingItem>();
    // Keys of files being prepared, claimed as soon as their ID is known: two picks of one file prepared side by side
    // would otherwise both pass the twin check before either is registered.
    const preparingKeys = new Set<string>();
    const queue: OutgoingItem[] = [];
    const batches = new Map<string, OutgoingBatch>();
    const runs = new Map<SlotId, SendFileRun>();
    let preparing = 0;
    let isReady = false;
    let isDisposed = false;
    let pumpHolds = 0;
    // Whole-file checks of batch files the receiver already has, one file at a time.
    let peerChecks: Promise<void> = Promise.resolve();

    const keyOf = (sessionId: string, fileId: string): string => `${sessionId}:${fileId}`;

    const isStoppedItem = (item: OutgoingItem): boolean => item.isStopped || isStoppedRecord(item.record);

    const readyLink = (): Link | undefined => {
        const link = context.link();

        return isReady && link?.isOpen ? link : undefined;
    };

    const insertInQueue = (item: OutgoingItem): void => {
        const index = queue.findIndex(other => other.queueIndex > item.queueIndex);
        queue.splice(index < 0 ? queue.length : index, 0, item);
    };

    const removeFromQueue = (item: OutgoingItem): void => {
        const index = queue.indexOf(item);
        if (index >= 0) {
            queue.splice(index, 1);
        }
    };

    const saveAsync = async (item: OutgoingItem, changes: Partial<StoredFile>, isVisible = true): Promise<StoredFile | undefined> => {
        if (!item.record) {
            return undefined;
        }

        const record: StoredFile = { ...item.record, ...changes, updatedAt: context.now() };
        item.record = record;
        try {
            await context.storage.putFileAsync(record);
        } catch (error) {
            context.logger.warn('store', `${record.name} file record not saved`, error);
        }

        if (isVisible) {
            emitFileState(context, record);
        }

        return record;
    };

    const detached = (pagination: StoredPagination | undefined): StoredPagination | undefined => (
        pagination ? { ...pagination, slot: null } : undefined
    );

    const batchSizes = (batchId: string, fallback: number): number[] => {
        const batch = batches.get(batchId);

        return batch ? batch.items.filter(item => item.preparation !== 'dropped').map(item => item.size) : [fallback];
    };

    const isSchedulable = (item: OutgoingItem, link: Link): boolean => (
        item.run == null
        && item.file != null
        && item.sessionId === link.sessionId
        && item.record?.state === 'queued'
        && (item.offering === 'single' || item.offering === 'accepted')
    );

    const freeSlot = (): SlotId | undefined => SLOT_IDS.find(slot => !runs.has(slot));

    const manifestOf = (record: StoredFile, sendsThumbnail: boolean): FileManifest => {
        const pageSize = record.pagination?.pageSize ?? context.transferSettings().pageSize;

        return {
            fileId: record.fileId,
            ...(record.contentId == null ? {} : { contentId: record.contentId }),
            name: record.name,
            size: record.size,
            mime: record.mime,
            lastModified: record.lastModified,
            ...(record.relativePath == null ? {} : { relativePath: record.relativePath }),
            pageSize,
            totalPages: countPages(record.size, pageSize),
            ...metadataField(record),
            ...(sendsThumbnail ? { thumb: true } : {}),
        };
    };

    const thumbnails = createThumbnailPipeline({ link: () => readyLink(), logger: context.logger });

    // A running file's record is owned by its run; the change goes through it so the run's next save keeps it.
    const amendAsync = async (item: OutgoingItem, changes: Partial<StoredFile>, isVisible: boolean): Promise<StoredFile | undefined> => {
        if (!item.run) {
            return saveAsync(item, changes, isVisible);
        }

        const record = item.run.amend(changes);
        try {
            await context.storage.putFileAsync(record);
        } catch (error) {
            context.logger.warn('store', `${record.name} file record not saved`, error);
        }

        if (isVisible) {
            emitFileState(context, record);
        }

        return record;
    };

    const willSendThumbnail = (item: OutgoingItem): boolean => (
        (batches.get(item.batchId)?.sendThumbnails ?? false)
        && item.record != null
        && item.record.kind !== 'other'
        && (item.file != null || item.record.hasThumbnail)
    );

    const makeThumbnailAsync = async (item: OutgoingItem): Promise<Blob | undefined> => {
        const record = item.record;
        if (!record) {
            return undefined;
        }

        const stored = await context.storage.getThumbAsync(item.sessionId, record.fileId);
        if (stored) {
            return stored.data;
        }

        if (!item.file) {
            return undefined;
        }

        try {
            const thumbnail = await context.media.createThumbnailAsync(item.file, record.metadata);
            if (!thumbnail) {
                return undefined;
            }

            await context.storage.putThumbAsync({ sessionId: item.sessionId, fileId: record.fileId, data: thumbnail, createdAt: context.now() });
            await amendAsync(item, { hasThumbnail: true }, false);

            return thumbnail;
        } catch (error) {
            context.logger.warn('xfer', `${item.name} thumbnail not made`, error);

            return undefined;
        }
    };

    // The receiver knows the file now (accept or batch-reply), so its thumbnail can go.
    const queueThumb = (item: OutgoingItem): void => {
        if (item.isThumbQueued || item.fileId == null || !willSendThumbnail(item)) {
            return;
        }

        item.isThumbQueued = true;
        thumbnails.add({ sessionId: item.sessionId, fileId: item.fileId, name: item.name, makeAsync: () => makeThumbnailAsync(item) });
    };

    const finishRunAsync = async (item: OutgoingItem, run: SendFileRun, outcome: SendOutcome): Promise<void> => {
        if (runs.get(run.slot) === run) {
            runs.delete(run.slot);
        }

        if (item.run === run) {
            item.run = undefined;
        }

        // A Stop took the file over: it stays stopped, whatever the run ended with, unless it finished meanwhile.
        if (isStoppedItem(item) && outcome.kind !== 'done' && outcome.kind !== 'failed') {
            item.isResuming = true;
            if (outcome.kind === 'needs-file') {
                item.file = undefined;
            }

            pump();

            return;
        }

        // Stopped by the link going before anyone else changed the state: the file waits for the next pairing.
        if (outcome.kind === 'stopped') {
            item.isResuming = true;
            if (item.record && BUSY_STATES.includes(item.record.state)) {
                await saveAsync(item, { state: 'paused', pausedBy: 'link', pagination: run.snapshot().pagination });
            }

            pump();

            return;
        }

        // A file that reached the receiver once is offered as a resume from now on, even if no ack got back.
        item.isResuming = outcome.kind !== 'done';

        item.record = outcome.record;
        const record = toFileRecord(outcome.record);
        context.events.emit('file-state', record);
        if (outcome.kind === 'done') {
            item.again = false;
            removeFromQueue(item);
            context.events.emit('file-done', record);
            hooks.onFileFinished(outcome.record);
        }

        if (outcome.kind === 'failed') {
            if (!outcome.isPeerAware) {
                context.link()?.send(run.slot, { t: 'cancel', fileId: run.fileId, direction: 'out', keepPartial: true, reason: 'failed' });
            }

            context.events.emit('file-failed', record, outcome.error);
            hooks.onFileFinished(outcome.record);
        }

        if (outcome.kind === 'needs-file') {
            item.file = undefined;
            context.link()?.send(run.slot, { t: 'cancel', fileId: run.fileId, direction: 'out', keepPartial: true, reason: 'paused' });
            context.events.emit('needs-file', record);
        }

        pump();
    };

    const startRun = (item: OutgoingItem, slot: SlotId, link: Link): void => {
        const record = item.record as StoredFile;
        const run = startSendFile({
            context,
            link,
            slot,
            file: item.file as File,
            record: { ...record, pausedBy: undefined },
            again: item.again,
            resume: item.isResuming,
            resumed: item.resumesStop,
            batchId: item.batchId,
            sendsThumbnail: willSendThumbnail(item),
            onRecord: next => {
                item.record = next;
            },
            onAccepted: () => queueThumb(item),
        });
        item.run = run;
        runs.set(slot, run);
        context.logger.info('xfer', `${item.name} slot ${slot} assigned`, { fileId: run.fileId });
        void run.outcome.then(outcome => finishRunAsync(item, run, outcome));
    };

    // Running batches share the slots: the next file comes from the batch with the fewest moving files,
    // the oldest batch on a tie, and in queue order within its batch. With one batch this is plain queue order.
    const nextToStart = (link: Link): OutgoingItem | undefined => {
        const moving = new Map<string, number>();
        for (const item of itemsByKey.values()) {
            if (item.run != null) {
                moving.set(item.batchId, (moving.get(item.batchId) ?? 0) + 1);
            }
        }

        return firstPerBatch(item => isSchedulable(item, link), moving);
    };

    // The earliest matching item of each batch, from the batch with the lowest load; the queue is in queueIndex
    // order, so the first batch seen is the oldest.
    const firstPerBatch = (matches: (item: OutgoingItem) => boolean, load: ReadonlyMap<string, number>): OutgoingItem | undefined => {
        const seen = new Set<string>();
        let best: OutgoingItem | undefined;
        for (const item of queue) {
            if (seen.has(item.batchId) || !matches(item)) {
                continue;
            }

            seen.add(item.batchId);
            if (!best || (load.get(item.batchId) ?? 0) < (load.get(best.batchId) ?? 0)) {
                best = item;
            }
        }

        return best;
    };

    const sendOutstanding = (batch: OutgoingBatch, link: Link): void => {
        const outstanding = batch.outstanding;
        if (!outstanding) {
            return;
        }

        const result = link.trySend(SLOT_MESSAGE_CHANNEL, outstanding.message);
        if (result === 'closed') {
            return;
        }

        if (result === 'too-large') {
            void shrinkOutstandingAsync(batch, outstanding);

            return;
        }

        clearTimeout(outstanding.timer);
        outstanding.timer = setTimeout(() => {
            if (batch.outstanding !== outstanding) {
                return;
            }

            const count = outstanding.items.length;
            if (outstanding.attempts >= 1) {
                batch.outstanding = undefined;
                const error = new ClientError('timeout', `No answer from ${link.peerName} to the batch offer (${count} files)`);
                context.logger.warn('xfer', error.message, { batchId: batch.batchId });
                void failItemsAsync(outstanding.items, error);

                return;
            }

            // CL-02: one more try, after a pause, while the link is alive; the same id, so a late answer still counts.
            outstanding.attempts++;
            context.logger.warn('xfer', `batch ${batch.batchId.slice(0, 8)} offer (${count} files) not answered, sending again`);
            outstanding.timer = setTimeout(() => {
                const current = readyLink();
                if (current && batch.outstanding === outstanding) {
                    sendOutstanding(batch, current);
                }
            }, OFFER_RETRY_BACKOFF_MS);
        }, context.settings().offerReplyTimeoutMs * (outstanding.attempts + 1));
    };

    // A message over 64 KiB is never sent: the window halves, and a single manifest goes without its summary.
    const shrinkOutstandingAsync = async (batch: OutgoingBatch, outstanding: OutstandingOffer): Promise<void> => {
        batch.outstanding = undefined;
        const items = outstanding.items;
        if (items.length > 1) {
            batch.maxWindow = Math.max(1, Math.floor(items.length / 2));
            context.logger.warn('xfer', `batch ${batch.batchId.slice(0, 8)} offer of ${items.length} files too large, sending ${batch.maxWindow} at a time`);
            for (const item of items) {
                item.offering = 'pending';
            }

            pump();

            return;
        }

        const [item] = items as [OutgoingItem];
        if (item.record?.metadata != null) {
            context.logger.warn('xfer', `${item.name} offer too large, sending it without its metadata summary`);
            await saveAsync(item, { metadata: undefined }, false);
            item.offering = 'pending';
            pump();

            return;
        }

        await failItemsAsync([item], new ClientError('invalid-argument', `${item.name} is too large to offer`));
    };

    const failItemsAsync = async (items: readonly OutgoingItem[], error: ClientError): Promise<void> => {
        for (const item of items) {
            removeFromQueue(item);
            const record = await saveAsync(item, { state: 'failed', lastError: error.message });
            if (record) {
                context.events.emit('file-failed', toFileRecord(record), new ClientError(error.code, error.message, record.fileId));
                hooks.onFileFinished(record);
            }
        }

        // The rest of the batch carries on.
        pump();
    };

    // BK-02: prepared files go out as offer-batch messages, one outstanding per batch, as soon as a window
    // is full, the batch is fully prepared, or the slots would otherwise sit idle.
    const offerBatchWindows = (): void => {
        const link = readyLink();
        if (!link) {
            return;
        }

        for (const batch of batches.values()) {
            if (batch.sessionId !== link.sessionId || batch.outstanding) {
                continue;
            }

            // A batch with nothing to start offers what it has prepared, so it never waits behind another batch.
            const isStarving = !batch.items.some(item => isSchedulable(item, link));

            const pending = batch.items
                .filter(item => item.offering === 'pending' && item.preparation !== 'dropped' && !isStoppedItem(item));
            const prepared: OutgoingItem[] = [];
            for (const item of pending) {
                if (item.preparation !== 'ready' || !item.record) {
                    break;
                }

                prepared.push(item);
            }

            const isRest = prepared.length > 0 && prepared.length === pending.length;
            const isFull = prepared.length >= PREPARE_AHEAD;
            if (prepared.length === 0 || (!isRest && !isFull && !isStarving)) {
                continue;
            }

            const header = batch.isHeaderAnswered ? undefined : batchHeader(batch);
            const { message, count } = planOfferBatch({
                id: context.randomId(),
                batchId: batch.batchId,
                index: batch.messageIndex,
                manifests: prepared.map(item => manifestOf(item.record as StoredFile, willSendThumbnail(item))),
                isRest,
                ...(header ? { header } : {}),
                ...(batch.maxWindow == null ? {} : { maxCount: batch.maxWindow }),
            });
            const window = prepared.slice(0, count);
            for (const item of window) {
                item.offering = 'offered';
            }

            batch.messageIndex++;
            batch.outstanding = { id: message.id, items: window, message, attempts: 0 };
            context.logger.info('xfer', `batch ${batch.batchId.slice(0, 8)} offer part ${message.index + 1}: ${count} files`);
            sendOutstanding(batch, link);
        }
    };

    const prepareAsync = async (item: OutgoingItem): Promise<void> => {
        const file = item.file;
        if (!file) {
            item.preparation = 'dropped';

            return;
        }

        let fileId: string;
        let contentId: string;
        try {
            const contentDigest = await computeContentDigestAsync(file);
            fileId = await fileIdFromDigestAsync(contentDigest, identityPathOf(item));
            contentId = await fileIdFromDigestAsync(contentDigest, item.name);
        } catch (error) {
            item.preparation = 'dropped';
            removeFromQueue(item);
            context.logger.warn('xfer', `${item.name} could not be read`, error);
            context.events.emit('error', new ClientError('file-unreadable', `${item.name} could not be read`, undefined, { cause: error }));

            return;
        }

        // PK-06: the same file (bytes and path) picked twice is queued once; a needs-file twin takes the File and resumes.
        const key = keyOf(item.sessionId, fileId);
        const twin = itemsByKey.get(key);
        const isTwinQueued = twin != null
            && twin !== item
            && twin.record != null
            && !FINISHED_STATES.includes(twin.record.state);
        // Picked again in a new selection while it rests (stopped, paused or waiting for its File): the new pick takes
        // the file over, and it continues from the receiver's saved pages.
        const isTwinResting = isTwinQueued
            && twin.batchId !== item.batchId
            && twin.run == null
            && (twin.record?.state === 'paused' || twin.record?.state === 'needs-file');
        if (isTwinResting && !preparingKeys.has(key)) {
            preparingKeys.add(key);
            try {
                await takeOverAsync(item, twin, file, fileId, contentId);
            } finally {
                preparingKeys.delete(key);
            }

            return;
        }

        if (isTwinQueued || preparingKeys.has(key)) {
            item.preparation = 'dropped';
            removeFromQueue(item);
            if (isTwinQueued && !twin.file) {
                twin.file = file;
                await saveAsync(twin, { state: 'queued', pausedBy: undefined, lastError: undefined });
            }

            context.logger.info('xfer', `${item.name} is already queued`, { fileId });

            return;
        }

        preparingKeys.add(key);
        try {
            await registerAsync(item, file, fileId, contentId);
        } finally {
            preparingKeys.delete(key);
        }
    };

    // The twin's record moves into the new pick's batch with its pagination; its old batch counts one file less.
    const takeOverAsync = async (
        item: OutgoingItem,
        twin: OutgoingItem,
        file: File,
        fileId: string,
        contentId: string,
    ): Promise<void> => {
        const previous = twin.record as StoredFile;
        twin.preparation = 'dropped';
        twin.isStopped = false;
        removeFromQueue(twin);
        itemsByKey.delete(keyOf(item.sessionId, fileId));
        hooks.onFileLeftBatch(previous);
        item.resumesStop = true;
        item.isResuming = twin.isResuming || (previous.pagination?.pagesDone ?? 0) > 0;
        context.logger.info('xfer', `${item.name} picked again, it continues from what arrived`, { fileId });
        await registerAsync(item, file, fileId, contentId, previous);
    };

    // Gives a prepared file its metadata and record, keeping a stored partial of the same file, and queues it.
    const registerAsync = async (
        item: OutgoingItem,
        file: File,
        fileId: string,
        contentId: string,
        known?: StoredFile,
    ): Promise<void> => {
        const metadata = sanitizeMetadata(await context.media.extractMetadataAsync(file));
        const existing = known ?? await context.storage.getFileAsync(item.sessionId, fileId, 'out');
        const keepsPagination = existing?.pagination != null && existing.size === file.size && existing.state !== 'done';
        const mime = file.type === '' ? existing?.mime ?? '' : file.type;
        const record: StoredFile = {
            sessionId: item.sessionId,
            fileId,
            contentId,
            direction: 'out',
            batchId: item.batchId,
            name: item.name,
            ...(item.relativePath == null ? {} : { relativePath: item.relativePath }),
            size: file.size,
            mime,
            kind: mediaKindOf(mime, item.name),
            lastModified: file.lastModified,
            ...(metadata == null ? {} : { metadata }),
            // Stopped while it was being prepared: it waits, stopped, for Resume.
            state: item.isStopped ? 'paused' : 'queued',
            ...(item.isStopped ? { pausedBy: 'stop' as const } : {}),
            attempts: existing?.attempts ?? 0,
            createdAt: context.now(),
            updatedAt: context.now(),
            hasThumbnail: existing?.hasThumbnail ?? false,
            hasData: false,
            queueIndex: item.queueIndex,
            ...(keepsPagination ? { pagination: detached(existing.pagination) } : {}),
        };

        // The session was cleared while this file was being prepared.
        if (item.preparation === 'dropped') {
            return;
        }

        item.fileId = fileId;
        item.record = record;
        item.preparation = 'ready';
        if (keepsPagination) {
            item.offering = 'single';
        }

        itemsByKey.set(keyOf(item.sessionId, fileId), item);
        try {
            await context.storage.putFileAsync(record);
        } catch (error) {
            context.logger.warn('store', `${record.name} file record not saved`, error);
        }

        context.events.emit('file-queued', toFileRecord(record));
    };

    // The receiver has a file with this ID. IDs come from samples and the path, so the file is skipped only if the
    // whole of it hashes to the receiver's rootHash; otherwise it is sent again in place of the receiver's copy.
    const checkPeerCopyAsync = async (item: OutgoingItem, entry: BatchReplyEntry, peerName: string): Promise<void> => {
        const isStillChecking = (): boolean => !isDisposed && item.preparation !== 'dropped' && item.record?.state === 'verifying';
        if (!isStillChecking()) {
            return;
        }

        await saveAsync(item, { note: 'checking' });
        const file = item.file;
        const pageSize = entry.pageSize;
        let isSame = false;
        if (file && entry.rootHash != null && pageSize != null) {
            try {
                isSame = await computeRootHashAsync(file.size, pageSize, page => readPageAsync(file, pageSize, page)) === entry.rootHash;
            } catch (error) {
                context.logger.warn('xfer', `${item.name} could not be read to compare with the copy on ${peerName}`, error);
            }
        }

        // Canceled, paused or cleared meanwhile: the check decides nothing any more.
        if (!isStillChecking()) {
            return;
        }

        if (isSame) {
            context.logger.info('xfer', `${item.name} already on ${peerName}, root hash matches`);
            removeFromQueue(item);
            const record = await saveAsync(item, {
                state: 'done',
                note: 'already-on-peer',
                rootHash: entry.rootHash,
                completedAt: context.now(),
                pagination: undefined,
            }, false);
            if (record) {
                context.events.emit('file-state', toFileRecord(record));
                context.events.emit('file-done', toFileRecord(record));
                hooks.onFileFinished(record);
            }

            return;
        }

        context.logger.warn('xfer', `${item.name} differs from the copy on ${peerName}, sending it anyway`);
        item.again = true;
        await saveAsync(item, { state: 'queued', note: undefined });
        pump();
    };

    const isAheadFull = (): boolean => {
        const waiting = queue.filter(item => item.preparation === 'ready' && item.run == null && item.record?.state === 'queued');

        return waiting.length >= PREPARE_AHEAD;
    };

    // Preparation goes round the batches too: the next file comes from the batch with the fewest files prepared ahead
    // or being prepared. PREPARE_AHEAD stays the total for all batches.
    const nextToPrepare = (): OutgoingItem | undefined => {
        const ahead = new Map<string, number>();
        for (const item of queue) {
            const isAhead = item.preparation === 'running'
                || (item.preparation === 'ready' && item.run == null && item.record?.state === 'queued');
            if (isAhead) {
                ahead.set(item.batchId, (ahead.get(item.batchId) ?? 0) + 1);
            }
        }

        return firstPerBatch(item => item.preparation === 'waiting', ahead);
    };

    const prepareNext = (): void => {
        while (preparing < PREPARE_CONCURRENCY && !isDisposed && !isAheadFull()) {
            const item = nextToPrepare();
            if (!item) {
                return;
            }

            preparing++;
            item.preparation = 'running';
            void prepareAsync(item)
                .catch(error => {
                    item.preparation = 'dropped';
                    removeFromQueue(item);
                    context.logger.error('xfer', `${item.name} not prepared`, error);
                })
                .finally(() => {
                    preparing--;
                    prepareNext();
                    pump();
                });
        }
    };

    function pump(): void {
        if (isDisposed || pumpHolds > 0) {
            return;
        }

        prepareNext();
        const link = readyLink();
        if (!link) {
            return;
        }

        const setting = context.transferSettings().maxConcurrentFiles;
        for (let item = nextToStart(link); item != null; item = nextToStart(link)) {
            // Lowering concurrency never stops running files; a new one starts only below the limit (TR-03).
            const limit = resolveConcurrency(setting, batchSizes(item.batchId, item.size));
            const slot = freeSlot();
            if (runs.size >= limit || slot == null) {
                break;
            }

            startRun(item, slot, link);
        }

        offerBatchWindows();
    }

    const stopRun = (item: OutgoingItem): StoredFile | undefined => {
        const run = item.run;
        if (!run) {
            return item.record;
        }

        run.stop();
        runs.delete(run.slot);
        item.run = undefined;
        item.isResuming = true;
        context.progress.remove(item.sessionId, 'out', run.fileId);
        item.record = run.snapshot();

        return item.record;
    };

    // Only the device a file belongs to hears about it; a file of another session changes here alone.
    const sendCancel = (item: OutgoingItem, keepPartial: boolean, reason: CancelMessage['reason'], slot?: SlotId): void => {
        const link = context.link();
        if (!item.fileId || !link || link.sessionId !== item.sessionId) {
            return;
        }

        link.send(slot ?? SLOT_MESSAGE_CHANNEL, { t: 'cancel', fileId: item.fileId, direction: 'out', keepPartial, ...(reason == null ? {} : { reason }) });
    };

    const unfinishedInAsync = async (sessionId: string): Promise<StoredFile[]> => {
        const records = await context.storage.listFilesInStatesAsync(sessionId, MOVABLE_STATES);

        return records.filter(record => record.direction === 'out');
    };

    // The old record ends as canceled/moved; the new one starts over here unless the receiver adopts a partial.
    const moveItemAsync = async (old: StoredFile, sessionId: string, batchId: string): Promise<OutgoingItem | undefined> => {
        const oldItem = itemsByKey.get(keyOf(old.sessionId, old.fileId));
        if (oldItem) {
            stopRun(oldItem);
            removeFromQueue(oldItem);
            itemsByKey.delete(keyOf(old.sessionId, old.fileId));
        }

        const now = context.now();
        const canceled: StoredFile = { ...withoutPagination(old), state: 'canceled', note: 'moved', pausedBy: undefined, updatedAt: now };
        await context.storage.putFileAsync(canceled);
        emitFileState(context, canceled);
        if (!FINISHED_STATES.includes(old.state)) {
            hooks.onFileFinished(canceled);
        }

        const twin = itemsByKey.get(keyOf(sessionId, old.fileId));
        if (twin?.record && !FINISHED_STATES.includes(twin.record.state)) {
            twin.file ??= oldItem?.file;

            return undefined;
        }

        const thumb = await context.storage.getThumbAsync(old.sessionId, old.fileId);
        if (thumb) {
            await context.storage.putThumbAsync({ ...thumb, sessionId }).catch(error => context.logger.warn('store', `${old.name} thumbnail not copied`, error));
        }

        const file = oldItem?.file;
        const queueIndex = hooks.nextQueueIndex();
        const record: StoredFile = {
            ...withoutPagination(old),
            sessionId,
            batchId,
            state: file ? 'queued' : 'needs-file',
            pausedBy: undefined,
            note: undefined,
            lastError: undefined,
            hasThumbnail: thumb != null,
            createdAt: now,
            updatedAt: now,
            queueIndex,
        };
        const item: OutgoingItem = {
            localId: context.randomId(),
            batchId,
            sessionId,
            queueIndex,
            name: old.name,
            size: old.size,
            ...(old.relativePath == null ? {} : { relativePath: old.relativePath }),
            file,
            fileId: old.fileId,
            record,
            preparation: 'ready',
            offering: 'single',
            again: false,
            isResuming: false,
            isThumbQueued: false,
            isStopped: false,
            resumesStop: false,
        };
        itemsByKey.set(keyOf(sessionId, old.fileId), item);
        insertInQueue(item);
        await context.storage.putFileAsync(record);
        context.events.emit('file-queued', toFileRecord(record));
        if (!file) {
            context.events.emit('needs-file', toFileRecord(record));
        }

        return item;
    };

    const detachedItem = (record: StoredFile): OutgoingItem => ({
        localId: context.randomId(),
        batchId: record.batchId ?? record.fileId,
        sessionId: record.sessionId,
        queueIndex: record.queueIndex,
        name: record.name,
        size: record.size,
        ...(record.relativePath == null ? {} : { relativePath: record.relativePath }),
        file: undefined,
        fileId: record.fileId,
        record,
        preparation: 'ready',
        offering: 'single',
        again: false,
        isResuming: record.state !== 'queued' || record.pagination != null,
        isThumbQueued: false,
        isStopped: isStoppedRecord(record),
        resumesStop: false,
    });

    // One session's file, from memory or, when the page no longer holds it (e.g. finished before a reload), from storage.
    const itemForAsync = async (sessionId: string, fileId: string): Promise<OutgoingItem | undefined> => {
        const held = itemsByKey.get(keyOf(sessionId, fileId));
        if (held) {
            return held;
        }

        const stored = await context.storage.getFileAsync(sessionId, fileId, 'out');
        if (!stored) {
            return undefined;
        }

        const item = detachedItem(stored);
        itemsByKey.set(keyOf(sessionId, fileId), item);

        return item;
    };

    const restoreItem = (record: StoredFile): OutgoingItem => {
        const item = detachedItem(record);
        itemsByKey.set(keyOf(record.sessionId, record.fileId), item);
        insertInQueue(item);

        return item;
    };

    // The unfinished files of one batch of one session: queued, being prepared, stopped, or known only to the batch.
    const membersOf = (sessionId: string, batchId: string): OutgoingItem[] => {
        const batch = batches.get(batchId);

        return [...new Set([...queue, ...itemsByKey.values(), ...(batch?.sessionId === sessionId ? batch.items : [])])]
            .filter(item => item.sessionId === sessionId && item.batchId === batchId && item.preparation !== 'dropped')
            .filter(item => item.record == null || !FINISHED_STATES.includes(item.record.state));
    };

    // An offer of the batch still waiting for its answer is dropped; a late answer is ignored.
    const dropOutstanding = (sessionId: string, batchId: string): void => {
        const batch = batches.get(batchId);
        if (batch?.sessionId === sessionId && batch.outstanding) {
            clearTimeout(batch.outstanding.timer);
            batch.outstanding = undefined;
        }
    };

    // Resume: each stopped file goes back in the queue and is offered as resumed, so the receiver continues from its
    // saved pages; one whose File this page no longer holds needs picking again (§7.4 step 5).
    const resumeStoppedAsync = async (items: readonly OutgoingItem[]): Promise<number> => {
        const stopped = items.filter(isStoppedItem);
        for (const item of stopped) {
            item.isStopped = false;
            item.resumesStop = true;
            if (!item.record) {
                if (!queue.includes(item)) {
                    insertInQueue(item);
                }

                continue;
            }

            if (!item.file) {
                const record = await saveAsync(item, { state: 'needs-file', pausedBy: undefined });
                if (record) {
                    context.events.emit('needs-file', toFileRecord(record));
                }

                continue;
            }

            if (!queue.includes(item)) {
                insertInQueue(item);
            }

            await saveAsync(item, { state: 'queued', pausedBy: undefined, note: undefined, lastError: undefined });
        }

        pump();

        return stopped.length;
    };

    // Nothing of the batch starts from the call and moving files stop at their last acknowledged page; every file
    // still moving or waiting is then written stopped with its pagination. Files waiting for their File stay so.
    const stopBatchAsync = async (sessionId: string, batchId: string): Promise<BatchStop> => {
        const release = holdPump();
        try {
            dropOutstanding(sessionId, batchId);
            const members = membersOf(sessionId, batchId)
                .filter(item => !isStoppedItem(item) && item.record?.state !== 'needs-file');
            const movingFileIds: string[] = [];
            const snapshots = new Map<OutgoingItem, StoredFile | undefined>();
            for (const item of members) {
                item.isStopped = true;
                item.resumesStop = false;
                removeFromQueue(item);
                // A batch offer that got no answer goes again on Resume.
                if (item.offering === 'offered') {
                    item.offering = 'pending';
                }

                if (item.run != null && item.fileId != null) {
                    movingFileIds.push(item.fileId);
                }

                if (item.record) {
                    snapshots.set(item, stopRun(item));
                }
            }

            for (const [item, record] of snapshots) {
                // Its run finished it meanwhile (the receiver had already verified it): it stays finished.
                if (item.record != null && FINISHED_STATES.includes(item.record.state)) {
                    item.isStopped = false;
                    continue;
                }

                await saveAsync(item, {
                    ...withoutCheckNote(record),
                    state: 'paused',
                    pausedBy: 'stop',
                    pagination: detached(record?.pagination),
                });
            }

            const stoppedText = `${members.length} files stopped, what arrived is kept`;
            context.logger.info('xfer', `batch ${batchId.slice(0, 8)}: ${stoppedText}`);

            return { count: members.length, movingFileIds };
        } finally {
            release();
        }
    };

    const holdPump = (): (() => void) => {
        pumpHolds++;
        let isReleased = false;

        return () => {
            if (!isReleased) {
                isReleased = true;
                pumpHolds--;
                pump();
            }
        };
    };

    return {
        loadAsync: async () => {
            const sessions = await context.storage.listSessionsAsync();
            for (const session of sessions) {
                const records = await context.storage.listFilesInStatesAsync(session.sessionId, RESUMABLE_STATES);
                for (const record of records) {
                    if (record.direction !== 'out') {
                        continue;
                    }

                    // After a reload the File objects are gone: every unfinished file needs picking again (§7.4 step 5).
                    // A stopped one stays stopped, and needs picking again once it is resumed.
                    const isStopped = isStoppedRecord(record);
                    const restored: StoredFile = {
                        ...record,
                        ...withoutCheckNote(record),
                        state: isStopped ? record.state : 'needs-file',
                        pagination: detached(record.pagination),
                    };
                    if ((record.state !== 'needs-file' && !isStopped) || record.pagination?.slot != null) {
                        await context.storage.putFileAsync(restored);
                    }

                    restoreItem(restored);
                }
            }
        },
        enqueueAsync: async (files, options) => {
            const batchId = context.randomId();
            const sendThumbnails = context.settings().sendThumbnailsFirst;
            const isSingle = files.length === 1;
            const items = files.map((file, index): OutgoingItem => {
                const relativePath = options.relativePaths?.[index];

                return {
                    localId: context.randomId(),
                    batchId,
                    sessionId: options.sessionId,
                    queueIndex: hooks.nextQueueIndex(),
                    name: file.name,
                    size: file.size,
                    ...(relativePath ? { relativePath } : {}),
                    file,
                    preparation: 'waiting',
                    offering: isSingle ? 'single' : 'pending',
                    again: false,
                    isResuming: false,
                    isThumbQueued: false,
                    isStopped: false,
                    resumesStop: false,
                };
            });
            batches.set(batchId, { batchId, sessionId: options.sessionId, items, sendThumbnails, messageIndex: 0, isHeaderAnswered: false });
            for (const item of items) {
                insertInQueue(item);
            }

            await context.batches.updateAsync(options.sessionId, batchId, () => ({
                sessionId: options.sessionId,
                batchId,
                direction: 'out',
                itemCount: files.length,
                totalBytes: files.reduce((sum, file) => sum + file.size, 0),
                received: 0,
                saved: 0,
                failed: 0,
                createdAt: context.now(),
            }));
            context.logger.info('xfer', `queued ${files.length} files (${formatBytes(files.reduce((sum, file) => sum + file.size, 0))})`);
            pump();

            return {
                batchId,
                files: items.map((item): FileHandle => ({
                    localId: item.localId,
                    name: item.name,
                    size: item.size,
                    ...(item.relativePath == null ? {} : { relativePath: item.relativePath }),
                })),
            };
        },
        setReady: value => {
            isReady = value;
            const sessionId = context.link()?.sessionId;
            if (!value || sessionId == null) {
                return;
            }

            // Another session's waiting thumbnails are released; they queue again when that device accepts its files.
            for (const job of thumbnails.retain(sessionId)) {
                const item = itemsByKey.get(keyOf(job.sessionId, job.fileId));
                if (item) {
                    item.isThumbQueued = false;
                }
            }

            pump();
            thumbnails.pump();
        },
        pump,
        handleReply: message => {
            if (message.t === 'wait' && message.batchId != null) {
                const batch = batches.get(message.batchId);
                if (batch?.outstanding?.id === message.re) {
                    clearTimeout(batch.outstanding.timer);
                    batch.outstanding.timer = undefined;
                    context.logger.info('xfer', `batch ${message.batchId.slice(0, 8)} waiting for ${context.link()?.peerName ?? 'the peer'} to answer`);
                }

                return;
            }

            const run = [...runs.values()].find(candidate => candidate.fileId === message.fileId);
            run?.deliver(message);
        },
        handleBatchReply: message => {
            const batch = batches.get(message.batchId);
            const outstanding = batch?.outstanding;
            if (
                !batch
                || !outstanding
                || outstanding.id !== message.re
                || batch.sessionId !== context.link()?.sessionId
            ) {
                context.logger.debug('xfer', 'late batch reply ignored');

                return;
            }

            clearTimeout(outstanding.timer);
            batch.outstanding = undefined;
            batch.isHeaderAnswered = true;
            const replies = new Map(message.files.map(entry => [entry.fileId, entry]));
            const peerName = context.link()?.peerName ?? 'the other device';
            void (async () => {
                for (const item of outstanding.items) {
                    if (item.record == null || FINISHED_STATES.includes(item.record.state)) {
                        continue;
                    }

                    // An entry the receiver left out is one it could not read.
                    const entry: BatchReplyEntry = (item.fileId == null ? undefined : replies.get(item.fileId))
                        ?? { fileId: item.fileId ?? '', reply: 'reject', reason: 'invalid' };

                    if (entry.reply === 'accept') {
                        item.offering = 'accepted';
                        queueThumb(item);
                        continue;
                    }

                    // Checked one at a time in the background, so the accepted files start now; each waits as
                    // 'check-waiting' and is 'checking' only while it is hashed. A paused and resumed file is offered alone.
                    if (entry.reply === 'have') {
                        item.offering = 'single';
                        await saveAsync(item, { state: 'verifying', note: 'check-waiting' });
                        peerChecks = peerChecks
                            .then(() => checkPeerCopyAsync(item, entry, peerName))
                            .catch(error => context.logger.warn('xfer', `${item.name} whole-file check failed`, error));
                        continue;
                    }

                    const rejection = rejectionFor(entry.reason ?? 'declined', item.name, peerName);
                    const error = new ClientError(rejection.code, rejection.message, item.fileId);
                    removeFromQueue(item);
                    const record = await saveAsync(item, { state: 'failed', note: rejection.note, lastError: error.message }, false);
                    if (record) {
                        context.events.emit('file-state', toFileRecord(record));
                        context.events.emit('file-failed', toFileRecord(record), error);
                        hooks.onFileFinished(record);
                    }
                }

                pump();
            })();
        },
        handleError: message => {
            for (const batch of batches.values()) {
                const outstanding = batch.outstanding;
                if (outstanding?.id !== message.re || batch.sessionId !== context.link()?.sessionId) {
                    continue;
                }

                clearTimeout(outstanding.timer);
                batch.outstanding = undefined;
                const peerName = context.link()?.peerName ?? 'the other device';
                void failItemsAsync(outstanding.items, new ClientError('invalid-state', `${peerName} could not read the batch offer: ${message.reason}`));

                return;
            }

            for (const run of runs.values()) {
                run.deliver(message);
            }
        },
        holdPump,
        cancelBatchAsync: async (sessionId, batchId) => {
            const release = holdPump();
            try {
                dropOutstanding(sessionId, batchId);
                const members = membersOf(sessionId, batchId);
                // Everything leaves the queue and every moving file stops at once, before anything is written.
                // Files that never started are written first: none of them can take a slot a moving file frees.
                const ordered = [...members.filter(item => item.run == null), ...members.filter(item => item.run != null)];
                const snapshots = new Map<OutgoingItem, StoredFile | undefined>();
                for (const item of ordered) {
                    removeFromQueue(item);
                    item.isStopped = false;
                    if (item.offering === 'pending' || item.offering === 'offered') {
                        item.offering = 'single';
                    }

                    // Still being prepared: it never gets a record, and the batch counts it as canceled.
                    if (!item.record) {
                        item.preparation = 'dropped';
                        continue;
                    }

                    snapshots.set(item, stopRun(item));
                }

                for (const [item, record] of snapshots) {
                    // Its run finished it meanwhile (the receiver had already verified it): it stays done.
                    if (item.record != null && FINISHED_STATES.includes(item.record.state)) {
                        continue;
                    }

                    await saveAsync(item, { ...withoutCheckNote(record), state: 'canceled', pausedBy: undefined, pagination: undefined });
                }

                context.logger.info('xfer', `batch ${batchId.slice(0, 8)}: ${ordered.length} files canceled`);

                return ordered.length;
            } finally {
                release();
            }
        },
        stopBatchAsync,
        resumeBatchAsync: (sessionId, batchId, fileIds) => resumeStoppedAsync(membersOf(sessionId, batchId)
            .filter(item => fileIds == null || (item.fileId != null && fileIds.includes(item.fileId)))),
        handleCancelAsync: async message => {
            // The peer speaks for its own session only.
            const sessionId = context.link()?.sessionId;
            const item = sessionId == null ? undefined : itemsByKey.get(keyOf(sessionId, message.fileId));
            if (!item?.record || FINISHED_STATES.includes(item.record.state)) {
                return;
            }

            const reason = message.reason ?? 'canceled';
            const isPause = reason === 'paused' || reason === 'storage-full';
            // A pause from the peer never undoes a Stop: the file stays stopped until Resume.
            if (isPause && isStoppedItem(item)) {
                return;
            }

            const record = stopRun(item);
            item.isStopped = false;
            const from = context.link()?.peerName ?? 'peer';
            const cancelText = `${item.name} cancel from ${from} reason=${reason}`;
            context.logger.info('xfer', cancelText, { fileId: message.fileId });
            const stopped = await saveAsync(item, {
                ...withoutCheckNote(record),
                state: STATE_BY_CANCEL_REASON[reason],
                pagination: message.keepPartial && reason !== 'canceled' ? detached(record?.pagination) : undefined,
                ...(isPause ? { pausedBy: 'peer' as const } : {}),
                ...(reason === 'storage-full' ? { note: 'storage-full' as const, lastError: 'Storage full' } : {}),
            });
            if (stopped && FINISHED_STATES.includes(stopped.state)) {
                removeFromQueue(item);
                hooks.onFileFinished(stopped);
            }

            pump();
        },
        linkDownAsync: async () => {
            isReady = false;
            for (const run of [...runs.values()]) {
                const item = [...itemsByKey.values()].find(candidate => candidate.run === run);
                if (!item) {
                    run.stop();
                    continue;
                }

                const record = stopRun(item);
                await saveAsync(item, { ...withoutCheckNote(record), state: 'paused', pausedBy: 'link', pagination: detached(record?.pagination) });
            }

            runs.clear();
            for (const batch of batches.values()) {
                const outstanding = batch.outstanding;
                if (!outstanding) {
                    continue;
                }

                clearTimeout(outstanding.timer);
                batch.outstanding = undefined;
                for (const item of outstanding.items) {
                    item.offering = 'pending';
                }
            }

        },
        syncEntriesAsync: async sessionId => {
            const records = await context.storage.listFilesInStatesAsync(sessionId, RESUMABLE_STATES);
            const entries: SyncEntry[] = [];
            for (const stored of records) {
                const record = itemsByKey.get(keyOf(sessionId, stored.fileId))?.record ?? stored;
                const pagination = record.pagination;
                // A stopped file goes even before its first page, so a receiver that missed the Stop stops it too.
                const isStopped = isStoppedRecord(record);
                if (record.direction !== 'out' || (!pagination && !isStopped)) {
                    continue;
                }

                const pageSize = pagination?.pageSize ?? context.transferSettings().pageSize;
                const pagesDone = pagination?.pagesDone ?? 0;
                const known = Math.min(pagesDone, Math.floor((pagination?.pageHashes?.length ?? 0) / HASH_BYTES));
                entries.push({
                    fileId: record.fileId,
                    direction: 'out',
                    name: record.name,
                    size: record.size,
                    pageSize,
                    totalPages: pagination?.totalPages ?? countPages(record.size, pageSize),
                    pagesDone,
                    ...(known > 0 && known === pagesDone && pagination?.pageHashes
                        ? { prefixHash: await prefixHashAsync(pagination.pageHashes, known) }
                        : {}),
                    state: record.state,
                    ...(record.pausedBy === 'user' || isStopped ? { held: true } : {}),
                    ...(isStopped ? { stopped: true } : {}),
                });
            }

            return entries;
        },
        applyPeerSyncAsync: async (sessionId, peerEntries) => {
            const received = new Map(peerEntries.filter(entry => entry.direction === 'in').map(entry => [entry.fileId, entry]));
            const records = (await context.storage.listFilesInStatesAsync(sessionId, RESUMABLE_STATES))
                .filter(record => record.direction === 'out');
            // A Stop made on the receiver while the link was down reaches this device here: the batch stops here too,
            // unless the user resumed or picked the file again since.
            const missedStops = new Set<string>();
            for (const stored of records) {
                const item = itemsByKey.get(keyOf(sessionId, stored.fileId)) ?? restoreItem(stored);
                const isStoppedThere = received.get(stored.fileId)?.stopped === true;
                if (isStoppedThere && !isStoppedItem(item) && !item.resumesStop && item.run == null) {
                    missedStops.add(item.batchId);
                }
            }

            for (const batchId of missedStops) {
                const peerName = context.link()?.peerName ?? 'the peer';
                const batch = batchId.slice(0, 8);
                context.logger.info('resume', `batch ${batch} was stopped on ${peerName}, stopping it here`);
                await stopBatchAsync(sessionId, batchId);
            }

            const decisions: SyncDecision[] = [];
            for (const stored of records) {
                const item = itemsByKey.get(keyOf(sessionId, stored.fileId)) ?? restoreItem(stored);
                const record = item.record ?? stored;
                const peerEntry = received.get(record.fileId);
                const hasProgress = (record.pagination?.pagesDone ?? 0) > 0 || peerEntry != null;
                // Files that never started wait in the queue as they are; paused ones go back into it. A stopped file
                // waits for Resume, whatever the link does.
                if (
                    record.pausedBy === 'user'
                    || isStoppedItem(item)
                    || item.run != null
                    || (record.state === 'queued' && !hasProgress)
                ) {
                    continue;
                }

                // The receiver's copy is still stopped while this one was resumed: the offer says so, and it is taken.
                if (peerEntry?.held && peerEntry.stopped !== true) {
                    await saveAsync(item, { state: 'paused', pausedBy: 'peer' });
                    continue;
                }

                // §7.4 step 3: the receiver's saved pages decide where the file resumes.
                const fromPage = peerEntry?.pagesDone ?? 0;
                const totalPages = peerEntry?.totalPages ?? record.pagination?.totalPages ?? 0;
                if (!item.file) {
                    await saveAsync(item, { state: 'needs-file' });
                    item.isResuming ||= hasProgress;
                    context.logger.info('resume', `${record.name} needs the file again, page ${fromPage} of ${totalPages}`);
                    decisions.push({ sessionId, fileId: record.fileId, name: record.name, direction: 'out', decision: 'needs-file', fromPage, totalPages });
                    if (item.record) {
                        context.events.emit('needs-file', toFileRecord(item.record));
                    }

                    continue;
                }

                item.offering = 'single';
                item.isResuming ||= hasProgress;
                await saveAsync(item, { state: 'queued', pausedBy: undefined });
                if (!hasProgress) {
                    continue;
                }

                const decision = peerEntry ? 'resume' : 'data-lost';
                context.logger.info('resume', `${record.name} ${decision} fromPage=${fromPage} of ${totalPages}`);
                decisions.push({ sessionId, fileId: record.fileId, name: record.name, direction: 'out', decision, fromPage, totalPages });
            }

            return decisions;
        },
        pauseAsync: async (sessionId, fileId) => {
            const item = await itemForAsync(sessionId, fileId);
            if (!item?.record || FINISHED_STATES.includes(item.record.state)) {
                return false;
            }

            // A stopped file already rests; only Resume moves it again.
            if ((item.record.state === 'paused' && item.record.pausedBy === 'user') || isStoppedItem(item)) {
                return true;
            }

            const slot = item.run?.slot;
            const record = stopRun(item);
            if (slot != null) {
                sendCancel(item, true, 'paused', slot);
            }

            await saveAsync(item, { ...withoutCheckNote(record), state: 'paused', pausedBy: 'user', pagination: detached(record?.pagination) });
            pump();

            return true;
        },
        resumeAsync: async (sessionId, fileId) => {
            const item = await itemForAsync(sessionId, fileId);
            if (!item?.record) {
                return false;
            }

            if (isStoppedItem(item)) {
                await resumeStoppedAsync([item]);

                return true;
            }

            const state = item.record.state;
            const isResumable = state === 'paused' || state === 'needs-file' || (state === 'canceled' && item.record.pagination != null);
            if (item.run || !isResumable) {
                return state !== 'done' && state !== 'failed' && state !== 'canceled';
            }

            if (!item.file) {
                const record = await saveAsync(item, { state: 'needs-file', pausedBy: undefined });
                if (record) {
                    context.events.emit('needs-file', toFileRecord(record));
                }

                return true;
            }

            item.offering = 'single';
            if (!queue.includes(item)) {
                insertInQueue(item);
            }

            const reopened = await saveAsync(item, { state: 'queued', pausedBy: undefined, note: undefined, lastError: undefined });
            if (reopened && state === 'canceled') {
                hooks.onFileReopened(reopened, state);
            }

            pump();

            return true;
        },
        cancelAsync: async (sessionId, fileId) => {
            const item = await itemForAsync(sessionId, fileId);
            if (!item?.record || FINISHED_STATES.includes(item.record.state)) {
                return false;
            }

            const slot = item.run?.slot;
            const record = stopRun(item);
            item.isStopped = false;
            sendCancel(item, false, 'canceled', slot);
            if (item.offering === 'pending') {
                item.offering = 'single';
            }

            removeFromQueue(item);
            const canceled = await saveAsync(item, { ...withoutCheckNote(record), state: 'canceled', pagination: undefined });
            if (canceled) {
                hooks.onFileFinished(canceled);
            }

            pump();

            return true;
        },
        deletePartialAsync: async (sessionId, fileId) => {
            const item = await itemForAsync(sessionId, fileId);
            if (
                !item?.record
                || item.record.state === 'done'
                || item.run
            ) {
                return false;
            }

            removeFromQueue(item);
            item.isStopped = false;
            const wasUnfinished = !FINISHED_STATES.includes(item.record.state);
            // What the receiver saved goes too, when it is the connected device.
            sendCancel(item, false, 'canceled');
            const deleted = await saveAsync(item, {
                pagination: undefined,
                state: wasUnfinished ? 'canceled' : item.record.state,
            });
            if (deleted && wasUnfinished) {
                hooks.onFileFinished(deleted);
            }

            return true;
        },
        resumeWithFilesAsync: async (files, onlySessionId) => {
            const matched: StoredFile[] = [];
            const unmatched: File[] = [];
            const waiting = [...itemsByKey.values()].filter(item => (
                item.file == null
                && item.record != null
                && item.record.state !== 'done'
                && (onlySessionId == null || item.sessionId === onlySessionId)
            ));
            // A picked file fits a waiting record when its content and the record's own path give the record's fileId,
            // so files picked one by one still find records sent from a folder. Same path first, then this session.
            const fitsAsync = async (item: OutgoingItem, file: File, contentDigest: Uint8Array): Promise<boolean> => (
                item.file == null
                && item.size === file.size
                && item.fileId === await fileIdFromDigestAsync(contentDigest, identityPathOf(item))
            );
            for (let index = 0; index < files.length; index += PREPARE_CONCURRENCY) {
                const group = files.slice(index, index + PREPARE_CONCURRENCY);
                const digests = await Promise.all(group.map(file => computeContentDigestAsync(file).catch(() => undefined)));
                for (const [position, file] of group.entries()) {
                    const contentDigest = digests[position];
                    const sessionId = context.link()?.sessionId;
                    const candidates: OutgoingItem[] = [];
                    if (contentDigest != null) {
                        for (const item of waiting) {
                            if (await fitsAsync(item, file, contentDigest)) {
                                candidates.push(item);
                            }
                        }
                    }

                    const ownPath = identityPathOf({ name: file.name, relativePath: file.webkitRelativePath });
                    const item = candidates.find(candidate => identityPathOf(candidate) === ownPath && candidate.sessionId === sessionId)
                        ?? candidates.find(candidate => identityPathOf(candidate) === ownPath)
                        ?? candidates.find(candidate => candidate.sessionId === sessionId)
                        ?? candidates[0];
                    if (!item) {
                        unmatched.push(file);
                        continue;
                    }

                    // Picked to resume: a stopped file resumes too, and the receiver takes it although its copy is
                    // stopped.
                    item.file = file;
                    item.offering = 'single';
                    item.isStopped = false;
                    item.resumesStop = true;
                    if (!queue.includes(item)) {
                        insertInQueue(item);
                    }

                    const record = await saveAsync(item, { state: 'queued', pausedBy: undefined, lastError: undefined });
                    if (record) {
                        matched.push(record);
                    }
                }
            }

            pump();

            return { matched: matched.map(toFileRecord), unmatched };
        },
        sendAgainAsync: async (sessionId, fileId) => {
            const item = await itemForAsync(sessionId, fileId);
            if (!item?.record) {
                throw new ClientError('file-not-found', 'No sent file with this ID', fileId);
            }

            if (item.record.state !== 'done') {
                return;
            }

            if (!item.file) {
                throw new ClientError('file-not-found', `Pick ${item.name} again to send it again`, fileId);
            }

            item.again = true;
            item.offering = 'single';
            if (!queue.includes(item)) {
                insertInQueue(item);
            }

            await saveAsync(item, {
                state: 'queued',
                note: undefined,
                rootHash: undefined,
                completedAt: undefined,
                pagination: undefined,
                attempts: item.record.attempts + 1,
            });
            pump();
        },
        retryFailedAsync: async (sessionId, batchId) => {
            const failed = [...itemsByKey.values()].filter(item => (
                item.sessionId === sessionId
                && item.batchId === batchId
                && item.record?.state === 'failed'
            ));
            for (const item of failed) {
                const isDeclined = item.record?.note === 'declined';
                if (!item.file) {
                    const record = await saveAsync(item, { state: 'needs-file' });
                    if (record) {
                        context.events.emit('needs-file', toFileRecord(record));
                    }

                    continue;
                }

                item.again = isDeclined;
                item.offering = 'single';
                if (!queue.includes(item)) {
                    insertInQueue(item);
                }

                const retried = await saveAsync(item, { state: 'queued', note: undefined, lastError: undefined, attempts: (item.record?.attempts ?? 0) + 1 });
                if (retried) {
                    hooks.onFileReopened(retried, 'failed');
                }
            }

            pump();
        },
        listUnfinishedElsewhereAsync: async sessionId => {
            const groups: UnfinishedElsewhere[] = [];
            for (const session of await context.storage.listSessionsAsync()) {
                if (session.sessionId === sessionId) {
                    continue;
                }

                const records = await unfinishedInAsync(session.sessionId);
                if (records.length === 0) {
                    continue;
                }

                groups.push({
                    sessionId: session.sessionId,
                    peerName: session.peerName,
                    lastConnectedAt: session.lastConnectedAt,
                    fileCount: records.length,
                    totalBytes: records.reduce((sum, record) => sum + record.size, 0),
                    readyCount: records.filter(record => itemsByKey.get(keyOf(session.sessionId, record.fileId))?.file != null).length,
                });
            }

            return groups.sort((first, second) => second.lastConnectedAt - first.lastConnectedAt);
        },
        moveUnfinishedAsync: async (fromSessionIds, sessionId) => {
            const records: StoredFile[] = [];
            for (const fromSessionId of new Set(fromSessionIds)) {
                if (fromSessionId !== sessionId) {
                    records.push(...await unfinishedInAsync(fromSessionId));
                }
            }

            if (records.length === 0) {
                return { queued: 0, needsFile: 0 };
            }

            const batchId = context.randomId();
            const items: OutgoingItem[] = [];
            for (const record of records) {
                const item = await moveItemAsync(record, sessionId, batchId);
                if (item) {
                    items.push(item);
                }
            }

            // Files with their File go out as one batch; the others wait to be picked again, then go on their own.
            const ready = items.filter(item => item.file != null);
            for (const item of ready) {
                item.offering = ready.length > 1 ? 'pending' : 'single';
            }

            batches.set(batchId, { batchId, sessionId, items, sendThumbnails: context.settings().sendThumbnailsFirst, messageIndex: 0, isHeaderAnswered: false });
            await context.batches.updateAsync(sessionId, batchId, () => ({
                sessionId,
                batchId,
                direction: 'out',
                itemCount: items.length,
                totalBytes: items.reduce((sum, item) => sum + item.size, 0),
                received: 0,
                saved: 0,
                failed: 0,
                createdAt: context.now(),
            }));
            const result = { queued: ready.length, needsFile: items.length - ready.length };
            context.logger.info('resume', `moved ${items.length} unfinished files here: ${result.queued} queued, ${result.needsFile} need picking again`, { sessionId });
            pump();

            return result;
        },
        heldFile: (sessionId, fileId) => {
            const item = itemsByKey.get(keyOf(sessionId, fileId));

            return item?.file && item.record ? { record: item.record, file: item.file } : undefined;
        },
        amendAsync: async (fileId, sessionId, changes) => {
            const item = itemsByKey.get(keyOf(sessionId, fileId));
            if (item?.record) {
                return amendAsync(item, changes, true);
            }

            const stored = await context.storage.getFileAsync(sessionId, fileId, 'out');
            if (!stored) {
                return undefined;
            }

            const record = { ...stored, ...changes, updatedAt: context.now() };
            await context.storage.putFileAsync(record);
            emitFileState(context, record);

            return record;
        },
        slots: () => [...runs.values()].map(run => ({ slot: run.slot, fileId: run.fileId })),
        forgetSessionAsync: async (sessionId, includeUnfinished) => {
            const items = new Set([...itemsByKey.values(), ...queue].filter(item => item.sessionId === sessionId));
            for (const item of items) {
                const isFinished = item.record != null && FINISHED_STATES.includes(item.record.state);
                if (!isFinished && !includeUnfinished) {
                    continue;
                }

                if (!isFinished) {
                    const slot = item.run?.slot;
                    stopRun(item);
                    sendCancel(item, false, 'canceled', slot);
                    await saveAsync(item, { state: 'canceled', pagination: undefined }, false);
                }

                item.preparation = 'dropped';
                removeFromQueue(item);
                if (item.fileId != null) {
                    itemsByKey.delete(keyOf(sessionId, item.fileId));
                }
            }

            for (const [batchId, batch] of batches) {
                if (batch.sessionId === sessionId && batch.items.every(item => item.preparation === 'dropped')) {
                    clearTimeout(batch.outstanding?.timer);
                    batches.delete(batchId);
                }
            }

            if (includeUnfinished) {
                thumbnails.removeSession(sessionId);
            }

            pump();
        },
        clear: () => {
            for (const run of runs.values()) {
                run.stop();
            }

            for (const batch of batches.values()) {
                clearTimeout(batch.outstanding?.timer);
            }

            runs.clear();
            itemsByKey.clear();
            batches.clear();
            queue.splice(0);
            thumbnails.clear();
        },
        dispose: () => {
            isDisposed = true;
            thumbnails.clear();
            for (const run of runs.values()) {
                run.stop();
            }

            runs.clear();
            for (const batch of batches.values()) {
                clearTimeout(batch.outstanding?.timer);
            }
        },
    };
}
