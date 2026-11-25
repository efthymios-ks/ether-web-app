import { UNFINISHED_STATES } from '../../client/clientTypes.js';
import type {
    BatchIncoming,
    BatchProgress,
    ClearScope,
    Client,
    ClientError,
    Direction,
    FileRecord,
    FileState,
    ProgressInfo,
} from '../../client/clientTypes.js';
import { createThrottle } from '../throttle.js';

// Collects the client's transfer events in one place, so every list redraws from the same state
// at most 10 times a second (TR-10), and the shell knows when a transfer runs (WL-01, PW-03).
// Everything is keyed by session (and direction and file), so two paired devices never share state,
// even for the same file; what only means something while connected is dropped when the link ends.

export const MOVING_STATES: readonly FileState[] = Object.freeze(['offered', 'active', 'verifying']);
export const REDRAW_INTERVAL_MS = 100;

const CLEARED_DIRECTIONS: Readonly<Record<ClearScope, readonly Direction[]>> = Object.freeze({
    sent: ['out'],
    received: ['in'],
    all: ['out', 'in'],
});

export interface TrackerChange {
    readonly records: readonly FileRecord[];
    readonly progress: readonly ProgressInfo[];
    readonly batches: readonly BatchProgress[];
    // A file was added or changed state, so lists that filter by state should reload.
    readonly isStructural: boolean;
}

// BK-03: a batch prompt belongs to the connection it arrived on.
export interface PendingBatch extends BatchIncoming {
    readonly sessionId: string;
}

export interface TransferTracker {
    // Only files of the connected session move.
    readonly isTransferring: boolean;
    pendingBatchesFor(sessionId: string): readonly PendingBatch[];
    getRecord(record: Pick<FileRecord, 'sessionId' | 'direction' | 'fileId'>): FileRecord | undefined;
    getProgress(record: Pick<FileRecord, 'sessionId' | 'direction' | 'fileId'>): ProgressInfo | undefined;
    getBatchProgress(sessionId: string, batchId: string): BatchProgress | undefined;
    getError(record: Pick<FileRecord, 'sessionId' | 'direction' | 'fileId'>): ClientError | undefined;
    // TR-09: cancels started on this device, so the keep-or-delete question isn't asked twice.
    noteLocalCancel(record: Pick<FileRecord, 'sessionId' | 'direction' | 'fileId'>): void;
    wasCanceledHere(record: Pick<FileRecord, 'sessionId' | 'direction' | 'fileId'>): boolean;
    resolveBatch(sessionId: string, batchId: string): void;
    // The Send tab keeps a batch that ran during this page run on screen until Done, also when the screen is
    // built again: when this page first saw it run, undefined when it never did.
    batchStartedAt(sessionId: string, batchId: string): number | undefined;
    // Notes a batch as running now unless it already was; returns when this page first saw it run.
    markBatchStarted(sessionId: string, batchId: string): number;
    // Done on the Send tab: these finished batches leave it.
    dismissBatches(sessionId: string, batchIds: readonly string[]): void;
    isBatchDismissed(sessionId: string, batchId: string): boolean;
    onChange(handler: (change: TrackerChange) => void): () => void;
    // The peer asked for a batch, or a batch was answered.
    onBatchesChange(handler: () => void): () => void;
    dispose(): void;
}

export function recordKey(record: Pick<FileRecord, 'sessionId' | 'direction' | 'fileId'>): string {
    return `${record.sessionId}:${record.direction}:${record.fileId}`;
}

export function batchKey(sessionId: string, batchId: string): string {
    return `${sessionId}:${batchId}`;
}

export function createTransferTracker(client: Client): TransferTracker {
    const records = new Map<string, FileRecord>();
    const progress = new Map<string, ProgressInfo>();
    const batches = new Map<string, BatchProgress>();
    const errors = new Map<string, ClientError>();
    const localCancels = new Set<string>();
    const batchStarts = new Map<string, number>();
    const dismissedBatches = new Set<string>();
    const handlers = new Set<(change: TrackerChange) => void>();
    const batchHandlers = new Set<() => void>();
    let pendingBatches: PendingBatch[] = [];
    let changedRecords = new Map<string, FileRecord>();
    let changedProgress = new Map<string, ProgressInfo>();
    let changedBatches = new Map<string, BatchProgress>();
    let isStructural = false;

    const throttle = createThrottle(() => {
        const change: TrackerChange = {
            records: [...changedRecords.values()],
            progress: [...changedProgress.values()],
            batches: [...changedBatches.values()],
            isStructural,
        };
        changedRecords = new Map();
        changedProgress = new Map();
        changedBatches = new Map();
        isStructural = false;
        for (const handler of handlers) {
            handler(change);
        }
    }, REDRAW_INTERVAL_MS);

    const markBatchStarted = (sessionId: string, batchId: string): number => {
        const key = batchKey(sessionId, batchId);
        const startedAt = batchStarts.get(key) ?? Date.now();
        batchStarts.set(key, startedAt);

        return startedAt;
    };

    // A batch seen moving again, e.g. after Retry failed, comes back to the Send tab until the next Done.
    const noteBatchMoving = (sessionId: string, batchId: string): void => {
        markBatchStarted(sessionId, batchId);
        dismissedBatches.delete(batchKey(sessionId, batchId));
    };

    const upsert = (record: FileRecord): void => {
        const key = recordKey(record);
        const previous = records.get(key);
        records.set(key, record);
        changedRecords.set(key, record);
        if (previous?.state !== record.state) {
            isStructural = true;
        }

        if (record.batchId != null && (MOVING_STATES.includes(record.state) || record.state === 'queued')) {
            noteBatchMoving(record.sessionId, record.batchId);
        }

        if (!MOVING_STATES.includes(record.state)) {
            progress.delete(key);
        }

        throttle.schedule();
    };

    const notifyBatches = (): void => {
        for (const handler of batchHandlers) {
            handler();
        }
    };

    const reseedAsync = async (sessionId: string, directions: readonly Direction[]): Promise<void> => {
        const left = await client.listFilesAsync({ sessionId, states: UNFINISHED_STATES }).catch(() => []);
        for (const record of left.filter(item => directions.includes(item.direction))) {
            if (!records.has(recordKey(record))) {
                upsert(record);
            }
        }

        isStructural = true;
        throttle.schedule();
    };

    const unsubscribers = [
        client.on('file-queued', upsert),
        client.on('file-incoming', upsert),
        client.on('file-state', upsert),
        client.on('file-done', upsert),
        client.on('needs-file', upsert),
        client.on('file-failed', (record, error) => {
            errors.set(recordKey(record), error);
            upsert(record);
        }),
        client.on('progress', items => {
            for (const item of items) {
                const key = recordKey(item);
                progress.set(key, item);
                changedProgress.set(key, item);
            }

            throttle.schedule();
        }),
        client.on('batch-progress', item => {
            const key = batchKey(item.sessionId, item.batchId);
            batches.set(key, item);
            changedBatches.set(key, item);
            // Progress of a batch that already ended says nothing about it running now.
            if (item.done + item.failed + item.canceled < item.total) {
                noteBatchMoving(item.sessionId, item.batchId);
            }

            throttle.schedule();
        }),
        client.on('batch-incoming', info => {
            const sessionId = (info as { sessionId?: string }).sessionId ?? client.peer?.sessionId;
            if (sessionId == null) {
                return;
            }

            const pending: PendingBatch = { ...info, sessionId };
            pendingBatches = [...pendingBatches.filter(item => batchKey(item.sessionId, item.batchId) !== batchKey(sessionId, info.batchId)), pending];
            notifyBatches();
        }),
        // A cleared scope forgets its records, rates and errors; files left unfinished come back from the store
        // at once, so a running transfer still counts for the wake lock.
        client.on('session-cleared', (sessionId, scope) => {
            const directions = CLEARED_DIRECTIONS[scope];
            const isCleared = (key: string): boolean => directions.some(direction => key.startsWith(`${sessionId}:${direction}:`));
            for (const map of [records, progress, errors]) {
                for (const key of [...map.keys()].filter(isCleared)) {
                    map.delete(key);
                }
            }

            for (const key of [...localCancels].filter(isCleared)) {
                localCancels.delete(key);
            }

            for (const [key, item] of [...batches]) {
                if (item.sessionId === sessionId && directions.includes(item.direction)) {
                    batches.delete(key);
                }
            }

            void reseedAsync(sessionId, directions);
        }),
        // Rates and unanswered prompts mean nothing once the link has ended.
        client.on('state', state => {
            if (state === 'connected') {
                return;
            }

            progress.clear();
            if (pendingBatches.length > 0) {
                pendingBatches = [];
                notifyBatches();
            }
        }),
    ];

    return {
        get isTransferring() {
            const sessionId = client.peer?.sessionId;
            if (client.state !== 'connected' || sessionId == null) {
                return false;
            }

            for (const record of records.values()) {
                if (record.sessionId === sessionId && (MOVING_STATES.includes(record.state) || record.state === 'queued')) {
                    return true;
                }
            }

            return false;
        },
        pendingBatchesFor: sessionId => pendingBatches.filter(item => item.sessionId === sessionId),
        getRecord: record => records.get(recordKey(record)),
        getProgress: record => progress.get(recordKey(record)),
        getBatchProgress: (sessionId, batchId) => batches.get(batchKey(sessionId, batchId)),
        getError: record => errors.get(recordKey(record)),
        noteLocalCancel: record => {
            localCancels.add(recordKey(record));
        },
        wasCanceledHere: record => localCancels.has(recordKey(record)),
        resolveBatch: (sessionId, batchId) => {
            pendingBatches = pendingBatches.filter(item => batchKey(item.sessionId, item.batchId) !== batchKey(sessionId, batchId));
            notifyBatches();
        },
        batchStartedAt: (sessionId, batchId) => batchStarts.get(batchKey(sessionId, batchId)),
        markBatchStarted,
        dismissBatches: (sessionId, batchIds) => {
            for (const batchId of batchIds) {
                dismissedBatches.add(batchKey(sessionId, batchId));
            }
        },
        isBatchDismissed: (sessionId, batchId) => dismissedBatches.has(batchKey(sessionId, batchId)),
        onChange: handler => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
        onBatchesChange: handler => {
            batchHandlers.add(handler);

            return () => {
                batchHandlers.delete(handler);
            };
        },
        dispose: () => {
            throttle.cancel();
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            handlers.clear();
            batchHandlers.clear();
        },
    };
}
