import { UNFINISHED_STATES } from '../../client/clientTypes.js';
import type { BatchProgress, BatchRecord, FileRecord, ProgressInfo } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import type { DialogChoice } from '../dialogs.js';
import { h } from '../dom.js';
import type { LiveRate } from '../format.js';
import { formatCount } from '../format.js';
import { createVirtualList } from '../history/virtualList.js';
import type { VirtualList } from '../history/virtualList.js';
import { ICONS } from '../icons.js';
import { describeClientError } from './fileActions.js';
import type { FileActions } from './fileActions.js';
import { peerNameFor } from './fileErrors.js';
import { isSkipped, isStoppedFile } from './fileStatus.js';
import { createProgressLine, PROGRESS_LINE_HEIGHT } from './progressLine.js';
import type { ProgressLine } from './progressLine.js';
import { recordKey } from './transferTracker.js';

// BK-01: one selection is one batch, shown in the progress view as a header, "Sending to Pixel 8 · 2 of 6" with
// its ⋯ (Stop this batch or Resume this batch, Retry failed, Show in Sent or Received, Delete what arrived), over a
// flat list of its files, one line each (progressLine.ts). The list is virtualised; lines change in place, and only
// files new to the batch redraw it. The counts, bytes, speed and time left go to the Total progress card through
// totals(). Stop keeps what arrived on both devices; Delete what arrived throws it away.

export interface BatchCardOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    readonly batch: BatchRecord;
    readonly scroller: HTMLElement;
    // Show in Received / Sent: that tab, filtered to this batch.
    readonly onShowBatch: (batch: BatchRecord) => void;
}

export interface BatchTotals {
    readonly total: number;
    readonly done: number;
    readonly saved: number;
    readonly failed: number;
    readonly canceled: number;
    // Stopped with what arrived kept, waiting for Resume.
    readonly stopped: number;
    // Done without moving: the other device already had them.
    readonly skipped: number;
    readonly bytesDone: number;
    readonly totalBytes: number;
    // While the batch moves, from its live progress.
    readonly rate?: LiveRate;
}

export interface BatchCard {
    readonly element: HTMLElement;
    readonly batchId: string;
    readonly batch: BatchRecord;
    // Files still to move, other than those waiting to be picked again or for Resume.
    readonly isRunning: boolean;
    // Nothing moves or waits, and some files wait for Resume.
    readonly isStopped: boolean;
    readonly unfinished: readonly FileRecord[];
    totals(): BatchTotals;
    update(batch: BatchRecord): void;
    // The batch's files from the store; lines already drawn stay and only files new to the batch redraw the list.
    setFiles(records: readonly FileRecord[]): void;
    updateProgress(progress: BatchProgress): void;
    // Files of the session that changed; the card keeps those of its batch.
    updateFiles(records: readonly FileRecord[]): void;
    updateProgressOf(items: readonly ProgressInfo[]): void;
    dispose(): void;
}

// A stopped file waits for Resume, not for its turn, so it doesn't keep its batch running.
export function isMovingOrWaiting(record: FileRecord): boolean {
    return UNFINISHED_STATES.includes(record.state) && record.state !== 'needs-file' && !isStoppedFile(record);
}

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

// Pages that arrived so far, from the records, for a batch without live progress.
function bytesOf(record: FileRecord): number {
    if (record.state === 'done') {
        return record.size;
    }

    const pagination = record.pagination;
    if (pagination == null || pagination.totalPages === 0) {
        return 0;
    }

    return Math.min(record.size, (pagination.pagesDone / pagination.totalPages) * record.size);
}

// "2 files that haven’t finished stop", "1 file that hasn’t finished stops".
function unfinishedStop(count: number): string {
    return count === 1
        ? '1 file that hasn’t finished stops'
        : `${formatCount(count, 'file')} that haven’t finished stop`;
}

// Each batch in turn, a failure said in a toast without stopping the others.
async function forEachBatchAsync(
    context: AppContext,
    cards: readonly BatchCard[],
    act: (batch: BatchRecord) => Promise<unknown>,
): Promise<void> {
    for (const card of cards) {
        try {
            await act(card.batch);
        } catch (error) {
            context.dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    }
}

// Stops every file of these batches that hasn't finished, here and on the other device, keeping what arrived.
export function stopBatchesAsync(context: AppContext, cards: readonly BatchCard[]): Promise<void> {
    return forEachBatchAsync(context, cards, batch => (
        context.client.stopBatchAsync(batch.sessionId, batch.batchId, batch.direction)
    ));
}

// The stopped files of these batches continue on both devices from what arrived.
export function resumeBatchesAsync(context: AppContext, cards: readonly BatchCard[]): Promise<void> {
    return forEachBatchAsync(context, cards, batch => (
        context.client.resumeBatchAsync(batch.sessionId, batch.batchId, batch.direction)
    ));
}

// Cancels every unfinished file of these batches and deletes what arrived of them, here and on the other device.
function deleteBatchesAsync(context: AppContext, cards: readonly BatchCard[]): Promise<void> {
    for (const card of cards) {
        for (const record of card.unfinished) {
            context.tracker.noteLocalCancel(record);
        }
    }

    return forEachBatchAsync(context, cards, batch => (
        context.client.cancelBatchAsync(batch.sessionId, batch.batchId, batch.direction)
    ));
}

let titleCounter = 0;

export function createBatchCard(options: BatchCardOptions): BatchCard {
    const { context, actions } = options;
    const titleId = `batch-title-${++titleCounter}`;
    const title = h('h3', { class: 'batch-title', attrs: { id: titleId } });
    const count = h('span', { class: 'batch-count' });
    const menuButton = h('button', {
        class: 'icon-button batch-menu',
        html: ICONS.more,
        dataset: { action: 'batch-menu' },
        attrs: { 'type': 'button', 'aria-label': 'Batch actions', 'aria-haspopup': 'dialog', 'data-tooltip': 'Batch actions' },
    });
    const lines = new Map<string, ProgressLine>();
    const element = h('section', {
        class: 'batch-card',
        dataset: { direction: options.batch.direction, batchId: options.batch.batchId },
        attrs: { 'aria-labelledby': titleId },
        children: [h('header', { class: 'batch-head', children: [title, count, menuButton] })],
    });
    let batch = options.batch;
    let progress: BatchProgress | undefined = context.tracker.getBatchProgress(batch.sessionId, batch.batchId);
    let files: FileRecord[] = [];

    const isMine = (record: FileRecord): boolean => record.sessionId === batch.sessionId
        && record.direction === batch.direction
        && record.batchId === batch.batchId;

    const latest = (record: FileRecord): FileRecord => context.tracker.getRecord(record) ?? record;

    const isRunning = (): boolean => files.some(isMovingOrWaiting);

    const stoppedFiles = (): FileRecord[] => files.map(latest).filter(isStoppedFile);

    const unfinishedFiles = (): FileRecord[] => files.map(latest)
        .filter(record => UNFINISHED_STATES.includes(record.state));

    const renderLine = (record: FileRecord): HTMLElement => {
        const line = createProgressLine({ context, actions });
        const shown = latest(record);
        line.update(shown, context.tracker.getProgress(shown));
        lines.set(recordKey(record), line);

        return line.element;
    };

    const fileList: VirtualList<FileRecord> = createVirtualList<FileRecord>({
        scroller: options.scroller,
        className: 'batch-files',
        role: 'list',
        label: 'Files in this batch',
        rowHeight: () => PROGRESS_LINE_HEIGHT,
        renderRow: renderLine,
        releaseRow: (_, record) => {
            lines.get(recordKey(record))?.dispose();
            lines.delete(recordKey(record));
        },
    });
    element.append(fileList.element);

    const totals = (): BatchTotals => {
        const running = isRunning();
        const totalBytes = progress?.totalBytes ?? batch.totalBytes;
        const fromFiles = files.reduce((sum, record) => sum + bytesOf(record), 0);

        return {
            total: progress?.total ?? batch.itemCount,
            done: progress?.done ?? batch.received,
            saved: progress?.saved ?? batch.saved,
            failed: progress?.failed ?? batch.failed,
            canceled: progress?.canceled ?? batch.canceled ?? 0,
            stopped: stoppedFiles().length,
            skipped: files.filter(isSkipped).length,
            bytesDone: progress?.bytesDone ?? (files.length === 0 && !running ? totalBytes : fromFiles),
            totalBytes,
            ...(running && progress != null ? { rate: progress } : {}),
        };
    };

    const setData = (name: string, value: string): void => {
        if (element.dataset[name] !== value) {
            element.dataset[name] = value;
        }
    };

    // "Sending to Pixel 8 · 2 of 6", with the exceptions after it: "· 1 failed", "· 1 cancelled", "· 3 stopped".
    // A stopped batch hasn't been sent yet, so it keeps saying Sending to.
    const render = (): void => {
        const isOut = batch.direction === 'out';
        const sum = totals();
        const isUnfinished = isRunning() || sum.stopped > 0;
        const peer = peerNameFor(context, batch.sessionId);
        const verbs = isOut ? ['Sending to', 'Sent to'] : ['Receiving from', 'Received from'];
        setText(title, `${isUnfinished ? verbs[0] : verbs[1]} ${peer}`);
        const parts = [`${sum.done.toLocaleString('en')} of ${sum.total.toLocaleString('en')}`];
        const extras: ReadonlyArray<readonly [number, string]> = [
            [sum.failed, 'failed'],
            [sum.canceled, 'cancelled'],
            [sum.stopped, 'stopped'],
        ];
        for (const [extra, label] of extras) {
            if (extra > 0) {
                parts.push(`${extra.toLocaleString('en')} ${label}`);
            }
        }

        setText(count, parts.join(' · '));
        setData('finished', String(!isUnfinished));
        setData('stopped', String(!isRunning() && sum.stopped > 0));
    };

    const indexFiles = (next: readonly FileRecord[]): void => {
        files = [...next].sort((left, right) => left.queueIndex - right.queueIndex);
        fileList.setRows(files);
    };

    // Stop keeps what arrived, so it asks without the danger colour.
    const confirmStopAsync = async (): Promise<void> => {
        const unfinished = unfinishedFiles().filter(record => !isStoppedFile(record));
        if (unfinished.length === 0) {
            return;
        }

        const isConfirmed = await context.dialogs.confirmAsync({
            title: 'Stop this batch?',
            message: `${unfinishedStop(unfinished.length)} here and on ${peerNameFor(context, batch.sessionId)}. `
                + `What arrived is kept, so you can resume ${unfinished.length === 1 ? 'it' : 'them'} later.`,
            confirmLabel: 'Stop',
            cancelLabel: 'Keep going',
        });
        if (isConfirmed) {
            await stopBatchesAsync(context, [card]);
        }
    };

    const confirmDeleteAsync = async (): Promise<void> => {
        const unfinished = unfinishedFiles();
        if (unfinished.length === 0) {
            return;
        }

        const arrivedOf = unfinished.length === 1 ? 'it' : 'them';
        const isConfirmed = await context.dialogs.confirmAsync({
            title: 'Delete what arrived?',
            message: `${unfinishedStop(unfinished.length)}, and what arrived of ${arrivedOf} `
                + `is deleted here and on ${peerNameFor(context, batch.sessionId)}. Finished files stay.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Keep',
            danger: true,
        });
        if (isConfirmed) {
            await deleteBatchesAsync(context, [card]);
        }
    };

    const openMenuAsync = async (): Promise<void> => {
        const isOut = batch.direction === 'out';
        const sum = totals();
        const isConnected = context.client.state === 'connected';
        const choices: DialogChoice[] = [
            ...(isRunning()
                ? [{ id: 'stop', label: 'Stop this batch', icon: ICONS.stop }]
                : []),
            ...(sum.stopped > 0 && isConnected
                ? [{ id: 'resume', label: 'Resume this batch', tone: 'primary' as const, icon: ICONS.play }]
                : []),
            ...(isOut && sum.failed > 0 && isConnected
                ? [{ id: 'retry', label: 'Retry failed', icon: ICONS.retry }]
                : []),
            { id: 'show', label: isOut ? 'Show in Sent' : 'Show in Received', icon: ICONS.select },
            ...(unfinishedFiles().length > 0
                ? [{ id: 'delete', label: 'Delete what arrived', tone: 'danger' as const, icon: ICONS.trash }]
                : []),
        ];
        const choice = await context.dialogs.chooseAsync({
            title: `${isOut ? 'Sending' : 'Receiving'} · ${formatCount(sum.total, 'item')}`,
            choices,
            asMenu: true,
        });
        if (choice === 'stop') {
            await confirmStopAsync();
        } else if (choice === 'resume') {
            await resumeBatchesAsync(context, [card]);
        } else if (choice === 'retry') {
            await actions.retryFailedAsync(batch.sessionId, batch.batchId);
        } else if (choice === 'show') {
            options.onShowBatch(batch);
        } else if (choice === 'delete') {
            await confirmDeleteAsync();
        }
    };

    menuButton.addEventListener('click', () => {
        void openMenuAsync();
    });

    const card: BatchCard = {
        element,
        batchId: batch.batchId,
        get batch() {
            return batch;
        },
        get isRunning() {
            return isRunning();
        },
        get isStopped() {
            return !isRunning() && stoppedFiles().length > 0;
        },
        get unfinished() {
            return unfinishedFiles();
        },
        totals,
        update: next => {
            batch = next;
            render();
        },
        setFiles: records => {
            const mine = records.filter(isMine).map(latest);
            const sorted = [...mine].sort((left, right) => left.queueIndex - right.queueIndex);
            const isSameFiles = sorted.length === files.length
                && sorted.every((record, index) => recordKey(record) === recordKey(files[index] as FileRecord));
            if (!isSameFiles) {
                indexFiles(sorted);
                render();

                return;
            }

            files = sorted;
            for (const record of sorted) {
                lines.get(recordKey(record))?.update(record, context.tracker.getProgress(record));
            }

            render();
        },
        updateProgress: next => {
            progress = next;
            render();
        },
        updateFiles: records => {
            const mine = records.filter(isMine);
            if (mine.length === 0) {
                return;
            }

            const known = new Map(files.map((record, index) => [recordKey(record), index]));
            const added: FileRecord[] = [];
            for (const record of mine) {
                const index = known.get(recordKey(record));
                if (index == null) {
                    added.push(record);
                    continue;
                }

                files[index] = record;
                lines.get(recordKey(record))?.update(record, context.tracker.getProgress(record));
            }

            if (added.length > 0) {
                indexFiles([...files, ...added]);
            }

            render();
        },
        updateProgressOf: items => {
            for (const item of items) {
                lines.get(recordKey(item))?.setProgress(item);
            }
        },
        dispose: () => {
            fileList.dispose();
            lines.clear();
        },
    };

    render();

    return card;
}
