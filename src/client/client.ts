import { createEmitter } from '../core/events.js';
import {
    createDefaultSettings,
    formatBytes,
    migrateSettings,
    normalizeSettings,
    SETTINGS_SCHEMA_VERSION,
    toLogRouting,
} from '../core/settings.js';
import type { Settings } from '../core/settings.js';
import { inspectCode } from '../network/network.js';
import type { ChannelName, NetworkOptions, SlotId } from '../network/networkTypes.js';
import { createBatchStore } from './batchStore.js';
import { ClientError, UNFINISHED_STATES } from './clientTypes.js';
import type {
    BatchRecord,
    ClearScope,
    ClearSummary,
    Client,
    Direction,
    FileRef,
    ClientEvents,
    ClientOptions,
    FileRecord,
    FileState,
    SessionRecord,
    SessionSummary,
    TestTool,
    TransferSettings,
} from './clientTypes.js';
import { createConnection } from './connection.js';
import type { ConnectionRouter } from './connection.js';
import { buildGallery } from './gallery.js';
import { createIncoming } from './incoming.js';
import { createOutgoing } from './outgoing.js';
import { createProgressTracker } from './progress.js';
import { secondsLeftAt } from './rateEstimator.js';
import type { ProtocolMessage } from './protocol.js';
import { sha256OfPartsAsync, sliceIntoParts } from './hashing.js';
import { DamagedDataError, assembleFileAsync, buildZipAsync } from './saving.js';
import { createSessionStore } from './sessionStore.js';
import { createClientStorage } from './storage.js';
import type { StoredBatch, StoredFile } from './storage.js';
import {
    SLOT_MESSAGE_CHANNEL,
    emitFileState,
    isStoppedRecord,
    toFileRecord,
    withoutPagination,
} from './transferContext.js';
import type { BatchStop, Link, TransferContext } from './transferContext.js';

// The use-case layer (§17.3): one function per use case, events for the UI, and everything below it wired up.

const ONE_SHOT_TOOLS: readonly TestTool[] = Object.freeze(['corrupt-pages', 'drop-ack']);
const TRANSFER_KEYS: ReadonlyArray<keyof TransferSettings> = Object.freeze(['pageSize', 'chunkSize', 'maxConcurrentFiles', 'maxBuffered']);
const RETENTION_KEYS: ReadonlyArray<keyof Settings> = Object.freeze(['keepPartialDays', 'keepHistoryDays', 'keepHistoryPerSession']);
const INTERRUPTED_INCOMING: readonly FileState[] = Object.freeze(['offered', 'active', 'verifying']);
const MAX_NAME_CHARACTERS = 32;
const SHA_PART_BYTES = 1024 * 1024;
const FINISHED_STATES: readonly FileState[] = Object.freeze(['done', 'failed', 'canceled']);
const CLEAR_DIRECTIONS: Readonly<Record<ClearScope, readonly Direction[]>> = Object.freeze({
    sent: ['out'],
    received: ['in'],
    all: ['out', 'in'],
});

type Handler<Message extends ProtocolMessage> = (channel: ChannelName, message: Message) => void | Promise<void>;
type MessageHandlers = { readonly [Type in ProtocolMessage['t']]?: Handler<Extract<ProtocolMessage, { t: Type }>> };

interface BrowserStorageManager {
    estimate?: () => Promise<{ usage?: number; quota?: number }>;
    persist?: () => Promise<boolean>;
    persisted?: () => Promise<boolean>;
}

function browserStorage(): BrowserStorageManager | undefined {
    return (globalThis as { navigator?: { storage?: BrowserStorageManager } }).navigator?.storage;
}

// A key given as undefined removes that override, so the session falls back to the default setting.
function applySessionOverrides(
    overrides: Partial<TransferSettings>,
    changes: Partial<TransferSettings>,
    defaults: Settings,
): Partial<TransferSettings> {
    const normalized = normalizeSettings(changes, defaults).settings;
    const result: Partial<Record<keyof TransferSettings, number>> = { ...overrides };
    for (const key of TRANSFER_KEYS) {
        if (!Object.hasOwn(changes, key)) {
            continue;
        }

        if (changes[key] === undefined) {
            delete result[key];
            continue;
        }

        result[key] = normalized[key];
    }

    return result;
}

function toBatchRecord(batch: StoredBatch): BatchRecord {
    return {
        sessionId: batch.sessionId,
        batchId: batch.batchId,
        direction: batch.direction,
        itemCount: batch.itemCount,
        totalBytes: batch.totalBytes,
        received: batch.received,
        saved: batch.saved,
        failed: batch.failed,
        canceled: batch.canceled ?? 0,
        createdAt: batch.createdAt,
        ...(batch.finishedAt == null ? {} : { finishedAt: batch.finishedAt }),
    };
}

export async function createClientAsync(options: ClientOptions): Promise<Client> {
    const now = options.now ?? (() => Date.now());
    const randomId = options.randomId ?? (() => crypto.randomUUID());
    const logger = options.logger;
    const storage = createClientStorage(options.database);
    const batches = createBatchStore(storage);
    const sessions = createSessionStore(storage);
    const events = createEmitter<ClientEvents>((error, name) => logger.error('app', `${String(name)} listener failed`, error));

    // AP-05: the device ID and the settings record, with its schema version and migrations.
    let deviceId = await storage.readDeviceIdAsync();
    if (deviceId == null) {
        deviceId = crypto.randomUUID();
        await storage.writeDeviceIdAsync(deviceId);
        logger.info('device', 'first run, new device ID');
    }

    const defaults = createDefaultSettings(options.defaultSettings);
    const storedSettings = await storage.readSettingsAsync();
    let settings = storedSettings == null ? defaults : normalizeSettings(migrateSettings(storedSettings), defaults).settings;
    if ((storedSettings as Partial<Settings> | undefined)?.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
        await storage.writeSettingsAsync(settings);
    }

    options.loggerController?.configure(toLogRouting(settings));

    let sessionOverrides: Partial<TransferSettings> = {};
    let unfinishedNoticeConnectionId: string | undefined;
    let lastQueueIndex = 0;
    let isPersistRequested = false;
    let isPersisted = false;
    const activeTools = new Set<TestTool>();
    const armedTools = new Set<TestTool>();
    // The bytes done last emitted per batch: a file's live bytes go a moment before its size is stored, and the bar never dips.
    const emittedBytes = new Map<string, number>();

    const nextQueueIndex = (): number => {
        lastQueueIndex = Math.max(lastQueueIndex + 1, Math.floor(now()) * 1000);

        return lastQueueIndex;
    };

    const transferSettings = (): TransferSettings => ({
        pageSize: sessionOverrides.pageSize ?? settings.pageSize,
        chunkSize: sessionOverrides.chunkSize ?? settings.chunkSize,
        maxConcurrentFiles: sessionOverrides.maxConcurrentFiles ?? settings.maxConcurrentFiles,
        maxBuffered: sessionOverrides.maxBuffered ?? settings.maxBuffered,
    });

    const networkOptions = (): NetworkOptions => {
        const transfer = transferSettings();

        return {
            chunkSize: transfer.chunkSize,
            maxBuffered: transfer.maxBuffered,
            timeouts: {
                gatheringMs: settings.gatheringCapMs,
                codeExpiryMs: settings.codeExpiryMs,
                connectMs: settings.connectTimeoutMs,
                pingMs: settings.pingIntervalMs,
                weakMs: settings.weakAfterMs,
                lostMs: settings.lostAfterMs,
            },
            appUrl: options.appUrl,
            ...(options.exposeLocalIps ? { exposeLocalIps: options.exposeLocalIps } : {}),
            logger,
        };
    };

    const estimateAsync = options.storageEstimateAsync ?? browserStorage()?.estimate?.bind(browserStorage());

    const freeSpaceAsync = async (): Promise<number | undefined> => {
        if (!estimateAsync) {
            return undefined;
        }

        try {
            const estimate = await estimateAsync();

            return estimate.quota == null ? undefined : Math.max(0, estimate.quota - (estimate.usage ?? 0));
        } catch {
            return undefined;
        }
    };

    // PW-06: ask once, at the first transfer.
    const ensurePersistentStorage = (): void => {
        if (isPersistRequested) {
            return;
        }

        isPersistRequested = true;
        const persistAsync = options.persistStorageAsync ?? browserStorage()?.persist?.bind(browserStorage());
        if (!persistAsync) {
            return;
        }

        void persistAsync()
            .then(result => {
                isPersisted = result;
                logger.info('device', `persistent storage ${result ? 'granted' : 'not granted'}`);
            })
            .catch(error => logger.warn('device', 'persistent storage request failed', error));
    };

    const emitBatchProgress = (batchId: string): void => {
        const batch = batches.cached(batchId);
        if (!batch) {
            return;
        }

        const live = progress.batchLive(batchId);
        const finished = batch.bytesDone ?? 0;
        const bytesDone = Math.min(batch.totalBytes, Math.max(emittedBytes.get(batchId) ?? 0, finished + live.bytesDone));
        emittedBytes.set(batchId, bytesDone);
        // The estimate covers the whole batch, queued files included, at the batch's live rate.
        const secondsLeft = secondsLeftAt(batch.totalBytes - Math.min(batch.totalBytes, finished + live.position), live.bytesPerSecond);
        events.emit('batch-progress', {
            batchId,
            sessionId: batch.sessionId,
            direction: batch.direction,
            total: batch.itemCount,
            done: batch.received,
            saved: batch.saved,
            failed: batch.failed,
            canceled: batch.canceled ?? 0,
            bytesDone,
            totalBytes: batch.totalBytes,
            bytesPerSecond: live.bytesPerSecond,
            ...(secondsLeft == null ? {} : { secondsLeft }),
            ...(live.isStalled ? { stalled: true } : {}),
        });
    };

    const progress = createProgressTracker({
        now,
        emit: (items, batchIds) => {
            if (items.length > 0) {
                events.emit('progress', items);
            }

            for (const batchId of batchIds) {
                emitBatchProgress(batchId);
            }
        },
        // DL-09: one summary line per active file per second.
        summarize: summary => {
            if (!logger.isEnabled('xfer', 'info')) {
                return;
            }

            const left = summary.secondsLeft == null ? '' : `, ${Math.round(summary.secondsLeft)} s left`;
            logger.info('xfer', `${summary.name} ${summary.pagesDone}/${summary.totalPages} (${summary.percent.toFixed(1)}%) ${formatBytes(summary.bytesPerSecond)}/s${left}`, {
                fileId: summary.fileId,
            });
        },
    });

    // A batch is finished once every file has an end: received, failed or canceled.
    const updateBatchAsync = async (sessionId: string, batchId: string, change: (batch: StoredBatch) => StoredBatch): Promise<void> => {
        const updated = await batches.updateAsync(sessionId, batchId, batch => {
            if (!batch) {
                return batch;
            }

            const next = change(batch);
            const isFinished = next.finishedAt == null && next.received + next.failed + (next.canceled ?? 0) >= next.itemCount;

            return isFinished ? { ...next, finishedAt: now() } : next;
        });
        if (updated) {
            if (updated.finishedAt != null) {
                progress.closeBatch(batchId);
            }

            emitBatchProgress(batchId);
        }
    };

    const updateBatchCountsAsync = async (record: StoredFile, change: (batch: StoredBatch) => StoredBatch): Promise<void> => {
        if (record.batchId != null) {
            await updateBatchAsync(record.sessionId, record.batchId, change);
        }
    };

    // A file that ended counts once in its batch: done as received, canceled as canceled, anything else as failed.
    const onFileFinished = (record: StoredFile): void => {
        const isDone = record.state === 'done';
        const isCanceled = record.state === 'canceled';
        void updateBatchCountsAsync(record, batch => {
            const next = {
                ...batch,
                bytesDone: (batch.bytesDone ?? 0) + (isDone ? record.size : 0),
                received: batch.received + (isDone ? 1 : 0),
                failed: batch.failed + (isDone || isCanceled ? 0 : 1),
                canceled: (batch.canceled ?? 0) + (isCanceled ? 1 : 0),
            };
            // A file that ended just as its batch was stopped was already counted as canceled by the Stop.
            const excess = next.received + next.failed + next.canceled - next.itemCount;

            return batch.finishedAt != null && excess > 0 && !isCanceled
                ? { ...next, canceled: Math.max(0, next.canceled - excess) }
                : next;
        });
        if (!isDone) {
            return;
        }

        const isOut = record.direction === 'out';
        void sessions.updateAsync(record.sessionId, session => (session
            ? {
                ...session,
                totals: {
                    filesSent: session.totals.filesSent + (isOut ? 1 : 0),
                    bytesSent: session.totals.bytesSent + (isOut ? record.size : 0),
                    filesReceived: session.totals.filesReceived + (isOut ? 0 : 1),
                    bytesReceived: session.totals.bytesReceived + (isOut ? 0 : record.size),
                },
            }
            : session));
    };

    const context: TransferContext = {
        storage,
        batches,
        logger,
        media: options.media,
        events,
        progress,
        now,
        randomId,
        settings: () => settings,
        transferSettings,
        link: () => connection.link,
        consumeTestTool: tool => armedTools.delete(tool),
        freeSpaceAsync,
        ensurePersistentStorage,
        emitSync: decisions => events.emit('sync', decisions),
    };

    // A failed or canceled file going back into its batch (retry, resume) no longer counts, and the batch is open again.
    const onFileReopened = (record: StoredFile, previous: FileState): void => {
        void updateBatchCountsAsync(record, batch => {
            const { finishedAt: _, ...open } = batch;

            return {
                ...open,
                failed: Math.max(0, batch.failed - (previous === 'failed' ? 1 : 0)),
                canceled: Math.max(0, (batch.canceled ?? 0) - (previous === 'canceled' ? 1 : 0)),
            };
        });
    };

    // A file picked again in a newer batch left its old one: the old batch counts one file less, and may finish.
    const onFileLeftBatch = (record: StoredFile): void => {
        void updateBatchCountsAsync(record, batch => ({
            ...batch,
            itemCount: Math.max(0, batch.itemCount - 1),
            totalBytes: Math.max(0, batch.totalBytes - record.size),
            ...(batch.singleOfferFileIds == null
                ? {}
                : { singleOfferFileIds: batch.singleOfferFileIds.filter(fileId => fileId !== record.fileId) }),
        }));
    };

    const outgoing = createOutgoing(context, { nextQueueIndex, onFileFinished, onFileReopened, onFileLeftBatch });
    const incoming = createIncoming(context, {
        nextQueueIndex,
        onFileDone: record => {
            events.emit('file-done', toFileRecord(record));
            onFileFinished(record);
        },
        onFileStopped: onFileFinished,
        onFileLeftBatch,
        onBatchAnswered: (sessionId, batchId, answered) => {
            void updateBatchAsync(sessionId, batchId, batch => ({
                ...batch,
                bytesDone: (batch.bytesDone ?? 0) + answered.alreadyHereBytes,
                received: batch.received + answered.alreadyHere,
                failed: batch.failed + answered.rejected,
            }));
        },
    });

    // A batch whose partials were deleted ends now: what its files didn't count yet (canceled ones, and files the
    // other side never heard of) counts as canceled.
    const finishCanceledBatchAsync = (sessionId: string, batchId: string): Promise<void> => updateBatchAsync(
        sessionId,
        batchId,
        batch => {
            const counted = batch.received + batch.failed + (batch.canceled ?? 0);

            return { ...batch, canceled: (batch.canceled ?? 0) + Math.max(0, batch.itemCount - counted) };
        },
    );

    // Delete what arrived (from this device, or from the peer's cancel-batch): every unfinished file of the batch on
    // this side ends canceled and its partial file is deleted; picking the same files again skips the finished ones.
    // The side's halt starts before any await: the sender's moving files stop and its queue is held, or the
    // receiver answers no more offers of the batch, from the very call. A batch this side doesn't have stops no file;
    // cancelBatchAsync then releases the receiver's hold on it. Stop starts the same way and keeps what arrived.
    const haltBatchAsync = (sessionId: string, batchId: string, direction: Direction): Promise<number> => (direction === 'out'
        ? outgoing.cancelBatchAsync(sessionId, batchId)
        : incoming.cancelBatchAsync(sessionId, batchId));

    const stopHereAsync = (sessionId: string, batchId: string, direction: Direction): Promise<BatchStop> => (
        direction === 'out' ? outgoing.stopBatchAsync(sessionId, batchId) : incoming.stopBatchAsync(sessionId, batchId)
    );

    const resumeHereAsync = (
        sessionId: string,
        batchId: string,
        direction: Direction,
        fileIds?: readonly string[],
    ): Promise<number> => (direction === 'out'
        ? outgoing.resumeBatchAsync(sessionId, batchId, fileIds)
        : incoming.resumeBatchAsync(sessionId, batchId, fileIds));

    // The link to that session's device, when it is the connected one.
    const linkTo = (sessionId: string): Link | undefined => {
        const link = context.link();

        return link?.sessionId === sessionId && link.isOpen ? link : undefined;
    };

    const requireBatchAsync = async (sessionId: string, batchId: string, direction: Direction): Promise<void> => {
        const batch = await batches.getAsync(sessionId, batchId);
        if (batch?.direction !== direction) {
            throw new ClientError('file-not-found', 'This device has no such batch');
        }
    };

    // Resume needs the other device: the sender's File and the receiver's saved pages are on different devices.
    // The sender is told first, so its offers of the batch come after; an older sender, which drops resume-batch,
    // resumes from the receiver's sync instead.
    const resumeStoppedAsync = async (
        sessionId: string,
        batchId: string,
        direction: Direction,
        fileIds?: readonly string[],
    ): Promise<number> => {
        const link = linkTo(sessionId);
        if (!link) {
            throw new ClientError('not-connected', 'Connect to the other device to resume');
        }

        const message: ProtocolMessage = { t: 'resume-batch', batchId, direction, ...(fileIds ? { fileIds } : {}) };
        if (direction === 'out') {
            link.send(SLOT_MESSAGE_CHANNEL, message);
        }

        const resumed = await resumeHereAsync(sessionId, batchId, direction, fileIds);
        if (direction === 'in') {
            link.send(SLOT_MESSAGE_CHANNEL, message);
            await connection.sendSyncAsync();
        }

        logger.info('xfer', `batch ${batchId.slice(0, 8)} resumed: ${resumed} files`);

        return resumed;
    };

    const completeCancelAsync = async (
        sessionId: string,
        batchId: string,
        direction: Direction,
        halting: Promise<number>,
        isFromPeer: boolean,
    ): Promise<number> => {
        const link = context.link();
        if (!isFromPeer && link?.sessionId === sessionId && link.isOpen) {
            link.send(SLOT_MESSAGE_CHANNEL, { t: 'cancel-batch', batchId, direction });
        }

        const canceled = await halting;
        await finishCanceledBatchAsync(sessionId, batchId);
        const by = isFromPeer ? ` by ${link?.peerName ?? 'the peer'}` : '';
        logger.info('xfer', `batch ${batchId.slice(0, 8)} canceled${by}: ${canceled} files`);

        return canceled;
    };

    const logFailure = (what: string) => (error: unknown): void => {
        logger.error('xfer', `${what} failed`, error);
    };

    const MESSAGE_HANDLERS: MessageHandlers = {
        offer: (channel, message) => incoming.handleOfferAsync(channel as SlotId, message),
        'offer-batch': (channel, message) => incoming.handleOfferBatchAsync(channel as SlotId, message),
        'page-end': (channel, message) => incoming.handlePageEnd(channel as SlotId, message),
        'file-end': (channel, message) => incoming.handleFileEndAsync(channel as SlotId, message),
        thumb: (_, message) => incoming.handleThumbAsync(message),
        accept: (_, message) => outgoing.handleReply(message),
        have: (_, message) => outgoing.handleReply(message),
        reject: (_, message) => outgoing.handleReply(message),
        wait: (_, message) => outgoing.handleReply(message),
        ack: (_, message) => outgoing.handleReply(message),
        nack: (_, message) => outgoing.handleReply(message),
        done: (_, message) => outgoing.handleReply(message),
        'batch-reply': (_, message) => outgoing.handleBatchReply(message),
        cancel: (_, message) => (message.direction === 'out' ? incoming.handleCancelAsync(message) : outgoing.handleCancelAsync(message)),
        'cancel-batch': async (_, message) => {
            const sessionId = context.link()?.sessionId;
            if (sessionId != null) {
                const direction: Direction = message.direction === 'out' ? 'in' : 'out';
                const halting = haltBatchAsync(sessionId, message.batchId, direction);
                await completeCancelAsync(sessionId, message.batchId, direction, halting, true);
            }
        },
        'stop-batch': async (_, message) => {
            const link = context.link();
            if (link != null) {
                const direction: Direction = message.direction === 'out' ? 'in' : 'out';
                const stopped = await stopHereAsync(link.sessionId, message.batchId, direction);
                const batch = message.batchId.slice(0, 8);
                const kept = `what arrived is kept: ${stopped.count} files`;
                logger.info('xfer', `batch ${batch} stopped by ${link.peerName}, ${kept}`);
            }
        },
        'resume-batch': async (_, message) => {
            const link = context.link();
            if (link != null) {
                const direction: Direction = message.direction === 'out' ? 'in' : 'out';
                const resumed = await resumeHereAsync(link.sessionId, message.batchId, direction, message.fileIds);
                const batch = message.batchId.slice(0, 8);
                logger.info('xfer', `batch ${batch} resumed by ${link.peerName}: ${resumed} files`);
            }
        },
        error: (_, message) => outgoing.handleError(message),
    };

    const router: ConnectionRouter = {
        linkUpAsync: async link => {
            const session = await storage.getSessionAsync(link.sessionId);
            sessionOverrides = session?.transferSettings ?? {};
            incoming.linkUp(link.sessionId);
            connection.configureNetwork();
        },
        restoreCountsAsync: async sessionId => {
            const files = await storage.listFilesAsync(sessionId);
            if (files.length === 0) {
                return undefined;
            }

            const finished = files.filter(file => !UNFINISHED_STATES.includes(file.state));

            return {
                receivedCount: finished.filter(file => file.direction === 'in').length,
                sentCount: finished.filter(file => file.direction === 'out').length,
                unfinishedCount: files.length - finished.length,
            };
        },
        resetSessionAsync: async sessionId => (await clearSessionFilesAsync(sessionId, { scope: 'all' })).removed,
        syncEntriesAsync: async sessionId => [
            ...await outgoing.syncEntriesAsync(sessionId),
            ...await incoming.syncEntriesAsync(sessionId),
        ],
        applyPeerSyncAsync: async (sessionId, entries) => {
            const decisions = [
                ...await outgoing.applyPeerSyncAsync(sessionId, entries),
                ...await incoming.applyPeerSyncAsync(sessionId, entries),
            ];
            if (decisions.length > 0) {
                events.emit('sync', decisions);
            }

            outgoing.setReady(true);
            await announceUnfinishedElsewhereAsync();
        },
        handleMessage: (channel, message) => {
            const handler = MESSAGE_HANDLERS[message.t] as Handler<ProtocolMessage> | undefined;
            const result = handler?.(channel, message);
            if (result instanceof Promise) {
                result.catch(logFailure(message.t));
            }
        },
        handleFrame: (header, payload) => incoming.handleFrame(header, payload),
        linkDownAsync: async () => {
            await outgoing.linkDownAsync();
            await incoming.linkDownAsync();
            progress.flush();
            // This session's overrides must not shape the next pairing, which may be another device.
            sessionOverrides = {};
        },
    };

    // Once per connection: other devices' unfinished files could go to this one instead.
    const announceUnfinishedElsewhereAsync = async (): Promise<void> => {
        const link = connection.link;
        if (!link || unfinishedNoticeConnectionId === link.connectionId) {
            return;
        }

        unfinishedNoticeConnectionId = link.connectionId;
        const groups = await outgoing.listUnfinishedElsewhereAsync(link.sessionId);
        if (groups.length > 0) {
            logger.info('resume', `${groups.reduce((sum, group) => sum + group.fileCount, 0)} unfinished files for other devices`, { sessionId: link.sessionId });
            events.emit('unfinished-elsewhere', groups);
        }
    };

    const connection = createConnection({
        deviceId,
        ...(options.platform == null ? {} : { platform: options.platform }),
        logger,
        ...(options.loggerController ? { loggerController: options.loggerController } : {}),
        events,
        sessions,
        createNetwork: options.createNetwork,
        networkOptions,
        settings: () => settings,
        now,
        randomId,
        router,
    });

    const cleanupAsync = async (): Promise<void> => {
        const result = await storage.cleanupAsync({
            now: now(),
            keepPartialDays: settings.keepPartialDays,
            keepHistoryDays: settings.keepHistoryDays,
            keepHistoryPerSession: settings.keepHistoryPerSession,
        });
        if (result.expiredPartials > 0) {
            logger.info('store', `deleted ${result.expiredPartials} partial files older than ${settings.keepPartialDays} days`);
            events.emit('notice', { kind: 'partials-expired', count: result.expiredPartials });
        }

        if (result.trimmedHistory > 0) {
            logger.info('store', `trimmed ${result.trimmedHistory} finished files from history`);
            events.emit('notice', { kind: 'history-trimmed', count: result.trimmedHistory });
        }
    };

    // After a reload nothing is moving: interrupted incoming files wait for the next pairing.
    const recoverIncomingAsync = async (): Promise<void> => {
        for (const session of await storage.listSessionsAsync()) {
            const files = await storage.listFilesInStatesAsync(session.sessionId, INTERRUPTED_INCOMING);
            for (const file of files.filter(candidate => candidate.direction === 'in')) {
                const pagination = file.pagination && file.pagination.pagesDone > 0 ? { ...file.pagination, slot: null } : undefined;
                await storage.putFileAsync({ ...withoutPagination(file), ...(pagination ? { pagination } : {}), state: 'paused', pausedBy: 'link' });
            }
        }
    };

    await outgoing.loadAsync();
    await recoverIncomingAsync();
    setTimeout(() => {
        void cleanupAsync().catch(error => logger.warn('store', 'cleanup failed', error));
    }, 0);

    const requireSessionId = (): string => {
        const sessionId = connection.link?.sessionId ?? connection.lastSessionId;
        if (sessionId == null) {
            throw new ClientError('not-connected', 'Pair with a device first');
        }

        return sessionId;
    };

    const notFound = (fileId: string): ClientError => new ClientError('file-not-found', 'This device has no such file', fileId);

    const findReceivedAsync = async (sessionId: string, fileId: string): Promise<StoredFile> => {
        const record = await incoming.findAsync(sessionId, fileId);
        if (!record) {
            throw notFound(fileId);
        }

        return record;
    };

    // Which side of the session a call is about; the record must exist in that session (isolation).
    const sideOfAsync = async (file: FileRef): Promise<Direction> => {
        const [sent, received] = await Promise.all([
            storage.getFileAsync(file.sessionId, file.fileId, 'out'),
            storage.getFileAsync(file.sessionId, file.fileId, 'in'),
        ]);
        const records = { out: sent, in: received };
        if (file.direction != null) {
            if (!records[file.direction]) {
                throw notFound(file.fileId);
            }

            return file.direction;
        }

        if (!sent && !received) {
            throw notFound(file.fileId);
        }

        if (!sent || !received) {
            return sent ? 'out' : 'in';
        }

        const isReceiving = !FINISHED_STATES.includes(received.state) && FINISHED_STATES.includes(sent.state);

        return isReceiving ? 'in' : 'out';
    };

    // Records that a received file left the app; its pages stay until the user deletes them.
    const markSavedRecordsAsync = async (records: readonly StoredFile[]): Promise<void> => {
        for (const record of records) {
            if (record.state !== 'done' || record.direction !== 'in') {
                continue;
            }

            // Only savedAt changes, on the record as it is now, so nothing written meanwhile is lost.
            let isFirstSave = false;
            const updated = await storage.patchFileAsync(record.sessionId, record.fileId, 'in', current => {
                if (current.state !== 'done') {
                    return undefined;
                }

                isFirstSave = current.savedAt == null;

                return isFirstSave ? { ...current, savedAt: now(), updatedAt: now() } : undefined;
            });
            if (updated) {
                emitFileState(context, updated);
            }

            if (isFirstSave) {
                await updateBatchCountsAsync(record, batch => ({ ...batch, saved: batch.saved + 1 }));
            }
        }
    };

    // The pages of a received file go; the record and its thumbnail stay in history. Unfinished files drop their partial.
    const deleteReceivedRecordAsync = async (record: StoredFile): Promise<void> => {
        if (record.state !== 'done') {
            await incoming.deletePartialAsync(record.sessionId, record.fileId);

            return;
        }

        const updated = await storage.patchFileAsync(record.sessionId, record.fileId, 'in', current => (
            current.state === 'done' && current.hasData ? { ...current, hasData: false, updatedAt: now() } : undefined
        ), { deletePages: true });
        if (updated) {
            emitFileState(context, updated);
        }
    };

    // The stored pages failed their check: the file is marked damaged so the UI stops offering it as saved data.
    const withDamageCheckAsync = async <Result>(work: () => Promise<Result>): Promise<Result> => {
        try {
            return await work();
        } catch (error) {
            if (error instanceof DamagedDataError) {
                logger.error('store', error.message, { fileId: error.record.fileId, sessionId: error.record.sessionId });
                const damaged = await storage.patchFileAsync(error.record.sessionId, error.record.fileId, 'in', current => (
                    current.note === 'damaged' ? undefined : { ...current, note: 'damaged', updatedAt: now() }
                ));
                if (damaged) {
                    emitFileState(context, damaged);
                }
            }

            throw error;
        }
    };

    // The standard whole-file SHA-256, from the stored pages (receiver) or the File this page holds (sender).
    const computeSha256Async: Client['computeSha256Async'] = async (file, hashOptions = {}) => {
        const { sessionId, fileId } = file;
        const [sent, received] = await Promise.all([
            storage.getFileAsync(sessionId, fileId, 'out'),
            storage.getFileAsync(sessionId, fileId, 'in'),
        ]);
        const direction = file.direction ?? (received ? 'in' : 'out');
        const held = direction === 'out' ? outgoing.heldFile(sessionId, fileId) : undefined;
        const record = held?.record ?? (direction === 'in' ? received : sent);
        if (!record) {
            throw notFound(fileId);
        }

        if (record?.sha256) {
            return record.sha256;
        }

        if (direction === 'in' && record?.state === 'done' && record.hasData) {
            const pages = await storage.readPagesAsync(record.sessionId, record.fileId);
            if (pages.reduce((sum, page) => sum + page.data.size, 0) !== record.size) {
                throw new ClientError('file-not-found', `Some of ${record.name} is missing`, fileId);
            }

            const sha256 = await sha256OfPartsAsync(pages.map(page => page.data), hashOptions);
            const updated = await storage.patchFileAsync(record.sessionId, record.fileId, 'in', current => ({ ...current, sha256, updatedAt: now() }));
            if (updated) {
                emitFileState(context, updated);
            }

            return sha256;
        }

        if (direction === 'out' && held) {
            const sha256 = await sha256OfPartsAsync(sliceIntoParts(held.file, SHA_PART_BYTES), hashOptions);
            await outgoing.amendAsync(fileId, held.record.sessionId, { sha256 });

            return sha256;
        }

        throw new ClientError('file-not-found', 'Neither the stored pages nor the File are here', fileId);
    };

    const filesInScopeAsync = async (sessionId: string, scope: ClearScope): Promise<StoredFile[]> => (
        (await storage.listFilesAsync(sessionId)).filter(file => CLEAR_DIRECTIONS[scope].includes(file.direction))
    );

    const getClearSummaryAsync = async (sessionId: string, scope: ClearScope): Promise<ClearSummary> => {
        const files = await filesInScopeAsync(sessionId, scope);
        const finished = files.filter(file => FINISHED_STATES.includes(file.state)).length;

        return {
            finished,
            unfinished: files.length - finished,
            notDownloaded: files.filter(file => file.direction === 'in' && file.state === 'done' && file.hasData && file.savedAt == null).length,
            bytes: files.reduce((sum, file) => sum + file.size, 0),
        };
    };

    // Removes one session's files of a scope; the session record, its peer, the connection log and the live link stay.
    const clearSessionFilesAsync: Client['clearSessionFilesAsync'] = async (sessionId, clearOptions) => {
        const scope = clearOptions.scope;
        const directions = CLEAR_DIRECTIONS[scope];
        const includeUnfinished = scope === 'all' || clearOptions.includeUnfinished === true;
        const before = await filesInScopeAsync(sessionId, scope);
        if (directions.includes('out')) {
            await outgoing.forgetSessionAsync(sessionId, includeUnfinished);
        }

        if (directions.includes('in')) {
            const incomingIds = before.filter(file => file.direction === 'in').map(file => file.fileId);
            await incoming.forgetSessionAsync(sessionId, incomingIds, includeUnfinished);
        }

        const inScope = await filesInScopeAsync(sessionId, scope);
        const removed = inScope.filter(file => includeUnfinished || FINISHED_STATES.includes(file.state));
        const removedKeys = new Set(removed.map(file => `${file.direction}:${file.fileId}`));
        const remaining = (await storage.listFilesAsync(sessionId)).filter(file => !removedKeys.has(`${file.direction}:${file.fileId}`));
        // A thumbnail is shared by both directions of a file; it goes when no record of it is left.
        const thumbFileIds = [...new Set(removed.map(file => file.fileId))].filter(fileId => !remaining.some(file => file.fileId === fileId));
        const batchIds = (await storage.listBatchesAsync(sessionId))
            .filter(batch => directions.includes(batch.direction))
            .filter(batch => !remaining.some(file => file.batchId === batch.batchId && file.direction === batch.direction))
            .map(batch => batch.batchId);
        await storage.removeSessionFilesAsync(sessionId, { files: removed, thumbFileIds, batchIds });
        batches.forget(batchIds);
        await sessions.updateAsync(sessionId, session => (session
            ? {
                ...session,
                totals: {
                    filesSent: directions.includes('out') ? 0 : session.totals.filesSent,
                    bytesSent: directions.includes('out') ? 0 : session.totals.bytesSent,
                    filesReceived: directions.includes('in') ? 0 : session.totals.filesReceived,
                    bytesReceived: directions.includes('in') ? 0 : session.totals.bytesReceived,
                },
            }
            : session));
        logger.info('store', `session ${sessionId.slice(0, 8)}: ${removed.length} ${scope} files cleared`, { sessionId });
        events.emit('session-cleared', sessionId, scope);

        return { removed: removed.length };
    };

    const toSummaryAsync = async (session: SessionRecord): Promise<SessionSummary> => ({
        ...session,
        unfinishedCount: await storage.countUnfinishedAsync(session.sessionId),
        connected: connection.link?.sessionId === session.sessionId,
    });

    const configureAsync = async (changes: Partial<Settings>): Promise<Settings> => {
        const previous = settings;
        settings = normalizeSettings(changes, settings).settings;
        await storage.writeSettingsAsync(settings);
        options.loggerController?.configure(toLogRouting(settings));
        connection.configureNetwork();
        if (settings.deviceName !== previous.deviceName) {
            connection.sendName(settings.deviceName);
        }

        if (settings.peerLogs !== previous.peerLogs) {
            connection.refreshPeerLogs();
        }

        if (RETENTION_KEYS.some(key => settings[key] !== previous[key])) {
            void cleanupAsync().catch(error => logger.warn('store', 'cleanup failed', error));
        }

        outgoing.pump();
        events.emit('settings', settings);

        return settings;
    };

    const client: Client = {
        get deviceId() {
            return deviceId;
        },
        get settings() {
            return settings;
        },
        get state() {
            return connection.state;
        },
        get peer() {
            return connection.peer;
        },
        get activeTestTools() {
            return [...activeTools];
        },

        inspectCode: codeOrUrl => {
            try {
                const summary = inspectCode(codeOrUrl);

                return {
                    kind: summary.kind,
                    code: summary.code,
                    expired: summary.createdAt != null && now() - summary.createdAt > settings.codeExpiryMs,
                };
            } catch {
                return undefined;
            }
        },
        startPairingAsync: () => connection.startPairingAsync(),
        joinWithCodeAsync: codeOrUrl => connection.joinWithCodeAsync(codeOrUrl),
        completePairingAsync: answerCodeOrUrl => connection.completePairingAsync(answerCodeOrUrl),
        cancelPairing: () => connection.cancelPairing(),
        disconnectAsync: () => connection.disconnectAsync(),
        renameAsync: async name => {
            const trimmed = name.trim();
            const length = [...trimmed].length;
            if (length < 1 || length > MAX_NAME_CHARACTERS) {
                throw new ClientError('invalid-argument', `Use 1–${MAX_NAME_CHARACTERS} characters.`);
            }

            await configureAsync({ deviceName: trimmed });
        },

        sendFilesAsync: async (files, sendOptions) => {
            if (files.length === 0) {
                throw new ClientError('invalid-argument', 'No files to send');
            }

            return outgoing.enqueueAsync(files, {
                sessionId: requireSessionId(),
                ...(sendOptions?.relativePaths ? { relativePaths: sendOptions.relativePaths } : {}),
            });
        },
        pauseAsync: async file => {
            if (await sideOfAsync(file) === 'out') {
                await outgoing.pauseAsync(file.sessionId, file.fileId);

                return;
            }

            await incoming.pauseAsync(file.sessionId, file.fileId);
        },
        resumeAsync: async file => {
            const side = await sideOfAsync(file);
            const held = side === 'out' ? outgoing.heldFile(file.sessionId, file.fileId)?.record : undefined;
            const record = held ?? await storage.getFileAsync(file.sessionId, file.fileId, side);
            // A stopped file resumes on both devices, from the receiver's saved pages.
            if (isStoppedRecord(record) && record?.batchId != null) {
                await resumeStoppedAsync(file.sessionId, record.batchId, side, [file.fileId]);

                return;
            }

            if (side === 'out') {
                await outgoing.resumeAsync(file.sessionId, file.fileId);

                return;
            }

            // The sender re-offers what the receiver's sync shows as resumable; only that device's own link carries it.
            const isResumable = await incoming.resumeAsync(file.sessionId, file.fileId);
            if (isResumable && connection.link?.sessionId === file.sessionId) {
                await connection.sendSyncAsync();
            }
        },
        cancelAsync: async file => {
            if (await sideOfAsync(file) === 'out') {
                await outgoing.cancelAsync(file.sessionId, file.fileId);

                return;
            }

            await incoming.cancelAsync(file.sessionId, file.fileId);
        },
        cancelBatchAsync: async (sessionId, batchId, direction) => {
            // Nothing starts from the moment it is pressed; the peer is told only once the batch is known to be ours.
            const halting = haltBatchAsync(sessionId, batchId, direction);
            const batch = await batches.getAsync(sessionId, batchId);
            if (batch?.direction !== direction) {
                await halting;
                if (direction === 'in') {
                    incoming.releaseBatch(sessionId, batchId);
                }

                throw new ClientError('file-not-found', 'This device has no such batch');
            }

            return completeCancelAsync(sessionId, batchId, direction, halting, false);
        },
        stopBatchAsync: async (sessionId, batchId, direction) => {
            // Nothing starts from the moment Stop is pressed; the peer is told once the batch is known to be ours.
            const halting = stopHereAsync(sessionId, batchId, direction);
            const batch = await batches.getAsync(sessionId, batchId);
            if (batch?.direction !== direction) {
                await halting;
                if (direction === 'in') {
                    incoming.releaseBatch(sessionId, batchId);
                }

                throw new ClientError('file-not-found', 'This device has no such batch');
            }

            const link = linkTo(sessionId);
            link?.send(SLOT_MESSAGE_CHANNEL, { t: 'stop-batch', batchId, direction });
            const stopped = await halting;
            // An older build drops stop-batch: pausing the files that were moving, as Pause does, keeps their pages
            // there and stops it waiting for them. This build takes the pause for the Stop it already made.
            for (const fileId of stopped.movingFileIds) {
                const pause = { t: 'cancel', fileId, direction, keepPartial: true, reason: 'paused' } as const;
                link?.send(SLOT_MESSAGE_CHANNEL, pause);
            }

            logger.info('xfer', `batch ${batchId.slice(0, 8)} stopped, what arrived is kept: ${stopped.count} files`);

            return stopped.count;
        },
        resumeBatchAsync: async (sessionId, batchId, direction) => {
            await requireBatchAsync(sessionId, batchId, direction);

            return resumeStoppedAsync(sessionId, batchId, direction);
        },
        resumeWithFilesAsync: (files, resumeOptions) => outgoing.resumeWithFilesAsync(files, resumeOptions?.sessionId),
        sendAgainAsync: async file => {
            await sideOfAsync({ ...file, direction: 'out' });
            await outgoing.sendAgainAsync(file.sessionId, file.fileId);
        },
        retryFailedAsync: async (sessionId, batchId) => {
            if (!await storage.getBatchAsync(sessionId, batchId)) {
                throw new ClientError('file-not-found', 'This device has no such batch');
            }

            await outgoing.retryFailedAsync(sessionId, batchId);
        },
        listUnfinishedElsewhereAsync: async () => {
            const sessionId = connection.link?.sessionId;

            return sessionId == null ? [] : outgoing.listUnfinishedElsewhereAsync(sessionId);
        },
        sendUnfinishedHereAsync: async sessionIds => {
            const sessionId = connection.link?.sessionId;
            if (sessionId == null) {
                throw new ClientError('not-connected', 'Pair with the device to send to first');
            }

            return outgoing.moveUnfinishedAsync(sessionIds, sessionId);
        },

        acceptIncomingAsync: async file => {
            await findReceivedAsync(file.sessionId, file.fileId);
            await incoming.acceptIncomingAsync(file.sessionId, file.fileId);
        },
        rejectIncomingAsync: async (file, reason) => {
            await findReceivedAsync(file.sessionId, file.fileId);
            await incoming.rejectIncomingAsync(file.sessionId, file.fileId, reason);
        },
        acceptBatchAsync: (batchId, acceptOptions) => incoming.acceptBatchAsync(batchId, acceptOptions.mode),
        declineBatchAsync: batchId => incoming.declineBatchAsync(batchId),
        getReceivedFileAsync: async file => {
            const record = await findReceivedAsync(file.sessionId, file.fileId);

            return withDamageCheckAsync(() => assembleFileAsync(storage, record));
        },
        getThumbnailAsync: async file => {
            await sideOfAsync(file);

            return (await storage.getThumbAsync(file.sessionId, file.fileId))?.data;
        },
        buildZipAsync: async (sessionId, fileIds) => {
            const records = await Promise.all(fileIds.map(fileId => findReceivedAsync(sessionId, fileId)));

            return withDamageCheckAsync(() => buildZipAsync(storage, records));
        },
        markSavedAsync: async (sessionId, fileIds) => {
            const records = await Promise.all(fileIds.map(fileId => findReceivedAsync(sessionId, fileId)));
            await markSavedRecordsAsync(records);
        },
        computeSha256Async,
        deleteReceivedAsync: async file => {
            await deleteReceivedRecordAsync(await findReceivedAsync(file.sessionId, file.fileId));
        },
        deleteReceivedManyAsync: async (sessionId, fileIds) => {
            const records = await Promise.all(fileIds.map(fileId => findReceivedAsync(sessionId, fileId)));
            for (const record of records) {
                await deleteReceivedRecordAsync(record);
            }
        },
        deletePartialAsync: async file => {
            if (await sideOfAsync(file) === 'out') {
                await outgoing.deletePartialAsync(file.sessionId, file.fileId);

                return;
            }

            await incoming.deletePartialAsync(file.sessionId, file.fileId);
        },

        listSessionsAsync: async () => {
            const all = await storage.listSessionsAsync();
            const summaries = await Promise.all(all.map(toSummaryAsync));

            return summaries.sort((first, second) => second.lastConnectedAt - first.lastConnectedAt);
        },
        getSessionAsync: async sessionId => {
            const session = await storage.getSessionAsync(sessionId);

            return session ? toSummaryAsync(session) : undefined;
        },
        listFilesAsync: async listOptions => {
            const files = await storage.listFilesAsync(listOptions.sessionId);

            return files
                .filter(file => listOptions.direction == null || file.direction === listOptions.direction)
                .filter(file => listOptions.states == null || listOptions.states.includes(file.state))
                .map(toFileRecord);
        },
        listBatchesAsync: async sessionId => (await storage.listBatchesAsync(sessionId)).map(toBatchRecord),
        listGalleryAsync: async galleryOptions => {
            const files: FileRecord[] = (await storage.listFilesAsync(galleryOptions.sessionId)).map(toFileRecord);

            return buildGallery(files, galleryOptions);
        },
        clearSessionAsync: async sessionId => {
            if (connection.link?.sessionId === sessionId) {
                throw new ClientError('busy', 'Disconnect before clearing this device');
            }

            await storage.clearSessionAsync(sessionId);
            logger.info('store', `session ${sessionId.slice(0, 8)} cleared`);
        },
        getClearSummaryAsync,
        clearSessionFilesAsync,
        clearAllAsync: async () => {
            await connection.disconnectAsync();
            await storage.clearAllAsync();
            batches.clear();
            outgoing.clear();
            logger.info('store', 'all data cleared');
        },
        restoreSessionAsync: sessionId => connection.restoreSessionAsync(sessionId),
        startFreshAsync: sessionId => connection.startFreshAsync(sessionId),

        configureAsync,
        configureSessionAsync: async changes => {
            const sessionId = connection.link?.sessionId;
            if (sessionId == null) {
                throw new ClientError('not-connected', 'Session settings need a connection');
            }

            sessionOverrides = applySessionOverrides(sessionOverrides, changes, settings);
            const overrides = sessionOverrides;
            await sessions.updateAsync(sessionId, session => (session ? { ...session, transferSettings: overrides } : session));
            connection.configureNetwork();
            outgoing.pump();
        },
        getDiagnosticsAsync: async () => {
            const network = connection.network;
            const pairs = network ? await network.getStatsAsync().catch(() => []) : [];
            const slots = [
                ...outgoing.slots().map(slot => ({ ...slot, direction: 'out' as const })),
                ...incoming.slots().map(slot => ({ ...slot, direction: 'in' as const })),
            ].map(slot => ({ ...slot, buffered: network?.bufferedAmount(slot.slot) ?? 0 }));

            return {
                state: connection.state,
                ...(network && connection.link ? { health: network.health } : {}),
                pairs,
                slots,
                ...(network ? { maxMessageSize: network.maxMessageSize } : {}),
                ...(network?.checkCode == null ? {} : { checkCode: network.checkCode }),
            };
        },
        getStorageInfoAsync: async () => {
            const estimate = estimateAsync ? await estimateAsync().catch(() => undefined) : undefined;
            const persisted = await (browserStorage()?.persisted?.() ?? Promise.resolve(isPersisted)).catch(() => isPersisted);

            return {
                ...(estimate?.usage == null ? {} : { usedBytes: estimate.usage }),
                ...(estimate?.quota == null ? {} : { quotaBytes: estimate.quota }),
                ...(estimate?.quota == null ? {} : { freeBytes: Math.max(0, estimate.quota - (estimate.usage ?? 0)) }),
                persisted,
            };
        },
        setPeerLogs: on => {
            if (settings.peerLogs === on) {
                return;
            }

            void configureAsync({ peerLogs: on }).catch(error => logger.warn('app', 'peer log setting not saved', error));
        },
        setTestTool: (tool, on) => {
            if (on === activeTools.has(tool)) {
                return;
            }

            if (on) {
                activeTools.add(tool);
                if (ONE_SHOT_TOOLS.includes(tool)) {
                    armedTools.add(tool);
                }
            } else {
                activeTools.delete(tool);
                armedTools.delete(tool);
            }

            if (tool === 'fill-storage') {
                storage.failDataWrites = on;
            }

            logger.warn('app', `test tool ${tool} ${on ? 'on' : 'off'}`);
            events.emit('test-tools', [...activeTools]);
        },
        dropConnectionForTest: () => connection.dropForTest(),

        on: (name, handler) => events.on(name, handler),
        dispose: () => {
            connection.dispose();
            outgoing.dispose();
            progress.dispose();
            events.clear();
        },
    };

    return client;
}
