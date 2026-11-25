import type { Direction, ProgressInfo } from './clientTypes.js';
import { createRateEstimator, secondsLeftAt } from './rateEstimator.js';
import type { RateEstimator } from './rateEstimator.js';

// Per-file progress, emitted at most 10 times a second as one batched event (CL-08, TR-10),
// plus the one-line-per-second summary for the log (DL-09).
// The bar counts acknowledged (sender) or saved (receiver) bytes. Speed and time left come from
// the live position of each transfer, sampled twice a second, so they keep moving between pages
// and on slow links (see rateEstimator.ts). Each batch has its own rate as well, measured across
// its files, so a batch of many small files gets a steady estimate too.

export interface ProgressUpdate {
    readonly fileId: string;
    readonly sessionId: string;
    readonly direction: Direction;
    readonly batchId?: string;
    readonly name: string;
    readonly pagesDone: number;
    readonly totalPages: number;
    readonly bytesDone: number;
    readonly size: number;
}

export interface ProgressSummary extends ProgressInfo {
    readonly name: string;
}

export interface BatchLive {
    // Acknowledged or saved bytes of the batch's files in progress.
    readonly bytesDone: number;
    // Bytes of those files that have crossed the link, for the time left.
    readonly position: number;
    readonly bytesPerSecond: number;
    readonly isStalled: boolean;
}

export interface ProgressTrackerOptions {
    readonly now: () => number;
    readonly emit: (items: readonly ProgressInfo[], batchIds: ReadonlySet<string>) => void;
    readonly summarize?: (summary: ProgressSummary) => void;
    readonly intervalMs?: number;
    readonly summaryMs?: number;
    readonly sampleMs?: number;
}

export interface ProgressTracker {
    update(update: ProgressUpdate): void;
    // How far a file has crossed the link, in bytes from its start: the sender's bytes handed to the
    // channel and no longer buffered, the receiver's bytes received. Read on every sample.
    trackPosition(sessionId: string, direction: Direction, fileId: string, read: () => number): void;
    remove(sessionId: string, direction: Direction, fileId: string): void;
    get(sessionId: string, direction: Direction, fileId: string): ProgressInfo | undefined;
    batchLive(batchId: string): BatchLive;
    // The batch has finished: its estimate is no longer sampled or emitted.
    closeBatch(batchId: string): void;
    // Emits pending changes now instead of on the next tick.
    flush(): void;
    dispose(): void;
}

interface Tracked {
    update: ProgressUpdate;
    read: (() => number) | undefined;
    position: number;
    readonly estimator: RateEstimator;
    isDirty: boolean;
    lastSummaryAt: number;
}

interface BatchRate {
    // Bytes moved by every file of the batch since it started moving, finished files included.
    moved: number;
    activeFiles: number;
    // When the last file of the batch stopped; the next file usually starts right after.
    idleSince: number | undefined;
    estimator: RateEstimator;
    isClosed: boolean;
    lastIdleEmitAt: number;
}

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_SUMMARY_MS = 1000;
const DEFAULT_SAMPLE_MS = 500;
// A batch idle for longer than this (a pause, a re-pairing) measures its rate afresh when it moves again.
const BATCH_RESTART_MS = 5000;
// An unfinished batch with nothing moving keeps being sampled and emitted this long, so its rate decays and it
// reads as stalled instead of freezing at its last speed.
const IDLE_BATCH_SAMPLE_MS = 60_000;

export function createProgressTracker(options: ProgressTrackerOptions): ProgressTracker {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const summaryMs = options.summaryMs ?? DEFAULT_SUMMARY_MS;
    const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
    const tracked = new Map<string, Tracked>();
    const probes = new Map<string, () => number>();
    const batches = new Map<string, BatchRate>();
    let lastSampleAt = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setInterval> | undefined;

    // The same file can move to or from several devices: each session keeps its own entry.
    const keyOf = (sessionId: string, direction: Direction, fileId: string): string => `${sessionId}:${direction}:${fileId}`;

    const readPosition = (entry: Tracked): number => {
        const { update } = entry;
        let probed = update.bytesDone;
        try {
            probed = entry.read?.() ?? update.bytesDone;
        } catch {
            // A probe of a closed link reads as no movement.
        }

        return Math.min(update.size, Math.max(entry.position, update.bytesDone, probed));
    };

    const sample = (now: number): void => {
        lastSampleAt = now;
        for (const entry of tracked.values()) {
            const position = readPosition(entry);
            const moved = position - entry.position;
            entry.position = position;
            entry.estimator.record(position, now);
            entry.isDirty = true;
            const batch = entry.update.batchId == null ? undefined : batches.get(entry.update.batchId);
            if (batch) {
                batch.moved += moved;
            }
        }

        for (const batch of batches.values()) {
            if (batch.activeFiles > 0 || batch.idleSince != null) {
                batch.estimator.record(batch.moved, now);
            }
        }
    };

    const toInfo = (entry: Tracked, now: number): ProgressInfo => {
        const { update } = entry;
        const bytesPerSecond = entry.estimator.bytesPerSecondAt(now);
        const secondsLeft = secondsLeftAt(update.size - entry.position, bytesPerSecond);

        return {
            fileId: update.fileId,
            sessionId: update.sessionId,
            direction: update.direction,
            ...(update.batchId == null ? {} : { batchId: update.batchId }),
            pagesDone: update.pagesDone,
            totalPages: update.totalPages,
            bytesDone: update.bytesDone,
            size: update.size,
            percent: update.size === 0 ? 100 : Math.min(100, (update.bytesDone / update.size) * 100),
            bytesPerSecond,
            ...(secondsLeft == null ? {} : { secondsLeft }),
            ...(entry.estimator.isStalled(now) ? { stalled: true } : {}),
        };
    };

    const joinBatch = (batchId: string, now: number): void => {
        const existing = batches.get(batchId);
        const isContinuing = existing != null
            && (existing.activeFiles > 0 || now - (existing.idleSince ?? now) <= BATCH_RESTART_MS);
        if (existing && isContinuing) {
            existing.activeFiles++;
            existing.idleSince = undefined;

            return;
        }

        const estimator = createRateEstimator();
        const moved = existing?.moved ?? 0;
        estimator.record(moved, now);
        batches.set(batchId, { moved, activeFiles: 1, idleSince: undefined, estimator, isClosed: false, lastIdleEmitAt: now });
    };

    const isSamplingIdle = (batch: BatchRate, now: number): boolean => (
        !batch.isClosed
        && batch.activeFiles === 0
        && batch.idleSince != null
        && now - batch.idleSince <= IDLE_BATCH_SAMPLE_MS
    );

    const leaveBatch = (batchId: string, now: number): void => {
        const batch = batches.get(batchId);
        if (!batch) {
            return;
        }

        batch.activeFiles = Math.max(0, batch.activeFiles - 1);
        if (batch.activeFiles === 0) {
            batch.idleSince = now;
        }
    };

    const stopIfIdle = (): void => {
        const now = options.now();
        if (tracked.size > 0 || timer === undefined || [...batches.values()].some(batch => isSamplingIdle(batch, now))) {
            return;
        }

        clearInterval(timer);
        timer = undefined;
    };

    const tick = (): void => {
        const now = options.now();
        if (now - lastSampleAt >= sampleMs) {
            sample(now);
        }

        const items: ProgressInfo[] = [];
        const batchIds = new Set<string>();
        for (const entry of tracked.values()) {
            if (entry.isDirty) {
                entry.isDirty = false;
                items.push(toInfo(entry, now));
                if (entry.update.batchId != null) {
                    batchIds.add(entry.update.batchId);
                }
            }

            if (options.summarize && now - entry.lastSummaryAt >= summaryMs) {
                entry.lastSummaryAt = now;
                options.summarize({ ...toInfo(entry, now), name: entry.update.name });
            }
        }

        for (const [batchId, batch] of batches) {
            if (isSamplingIdle(batch, now) && now - batch.lastIdleEmitAt >= sampleMs) {
                batch.lastIdleEmitAt = now;
                batchIds.add(batchId);
            }
        }

        if (items.length > 0 || batchIds.size > 0) {
            options.emit(items, batchIds);
        }

        stopIfIdle();
    };

    const ensureTimer = (): void => {
        if (timer !== undefined) {
            return;
        }

        timer = setInterval(tick, intervalMs);
    };

    return {
        update: update => {
            const key = keyOf(update.sessionId, update.direction, update.fileId);
            const now = options.now();
            const existing = tracked.get(key);
            if (existing) {
                existing.update = update;
                existing.isDirty = true;
                ensureTimer();

                return;
            }

            const estimator = createRateEstimator();
            estimator.record(update.bytesDone, now);
            tracked.set(key, {
                update,
                read: probes.get(key),
                position: update.bytesDone,
                estimator,
                isDirty: true,
                lastSummaryAt: now,
            });
            if (update.batchId != null) {
                joinBatch(update.batchId, now);
            }

            ensureTimer();
        },
        trackPosition: (sessionId, direction, fileId, read) => {
            const key = keyOf(sessionId, direction, fileId);
            probes.set(key, read);
            const entry = tracked.get(key);
            if (entry) {
                entry.read = read;
            }
        },
        remove: (sessionId, direction, fileId) => {
            const key = keyOf(sessionId, direction, fileId);
            const entry = tracked.get(key);
            probes.delete(key);
            if (!entry) {
                return;
            }

            if (entry.isDirty) {
                entry.isDirty = false;
                const batchIds = new Set(entry.update.batchId == null ? [] : [entry.update.batchId]);
                options.emit([toInfo(entry, options.now())], batchIds);
            }

            if (entry.update.batchId != null) {
                // What moved since the last sample still counts for the batch; a paused file adds little.
                const batch = batches.get(entry.update.batchId);
                if (batch) {
                    batch.moved += readPosition(entry) - entry.position;
                }

                leaveBatch(entry.update.batchId, options.now());
            }

            tracked.delete(key);
            stopIfIdle();
        },
        get: (sessionId, direction, fileId) => {
            const entry = tracked.get(keyOf(sessionId, direction, fileId));

            return entry ? toInfo(entry, options.now()) : undefined;
        },
        batchLive: batchId => {
            const now = options.now();
            let bytesDone = 0;
            let position = 0;
            for (const entry of tracked.values()) {
                if (entry.update.batchId === batchId) {
                    bytesDone += entry.update.bytesDone;
                    position += entry.position;
                }
            }

            const batch = batches.get(batchId);

            return {
                bytesDone,
                position,
                bytesPerSecond: batch?.estimator.bytesPerSecondAt(now) ?? 0,
                isStalled: batch?.estimator.isStalled(now) ?? false,
            };
        },
        closeBatch: batchId => {
            const batch = batches.get(batchId);
            if (batch) {
                batch.isClosed = true;
            }
        },
        flush: tick,
        dispose: () => {
            tracked.clear();
            probes.clear();
            batches.clear();
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        },
    };
}
