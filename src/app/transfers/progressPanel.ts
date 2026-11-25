import type { BatchRecord, FileRecord } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { formatClock, formatPercent, formatSize, formatSpeed, formatTimeLeft } from '../format.js';
import type { LiveRate } from '../format.js';
import { ICONS } from '../icons.js';
import { createDebounce } from '../throttle.js';
import { createBatchCard, isMovingOrWaiting, resumeBatchesAsync, stopBatchesAsync } from './batchCard.js';
import type { BatchCard, BatchTotals } from './batchCard.js';
import type { FileActions } from './fileActions.js';
import { peerNameFor } from './fileErrors.js';
import { isStoppedFile } from './fileStatus.js';
import { createPickerTiles } from './pickers.js';
import { createProgressLine } from './progressLine.js';
import type { ProgressLine } from './progressLine.js';
import { syncChildren } from './syncChildren.js';
import { recordKey } from './transferTracker.js';
import { createUnfinishedElsewhereCard } from './unfinishedElsewhere.js';

// The Send tab (§4.5). On top, the unfinished files of other devices. Idle, it shows the platform's picker tiles
// and "Files go straight to <peer>, encrypted. Received files download as one ZIP." Busy, it is the progress view:
// each batch with its flat list of files (batchCard.ts), any unfinished file outside them, the files that need
// picking again with Pick, and a sticky Total progress card: elapsed time, one bar, then three lines (the counts,
// bytes and speed, time left), always shown, with Stop beside them; Stopped with Resume and Done once nothing moves
// and some files wait for Resume; or Finished with Send more and Done. Stop keeps what arrived on both devices.
// A batch that ran during this page run stays until Done (the tracker remembers which), and so does a stopped one,
// also after a reload, so its outcome can be read after the fact; received files are downloaded from Received,
// never from here.

export interface ProgressPanelOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    readonly sessionId: string;
    readonly scroller: HTMLElement;
    // A batch's Show in Received / Sent: that tab, filtered to the batch.
    readonly onShowBatch: (batch: BatchRecord) => void;
}

export interface ProgressPanel {
    readonly element: HTMLElement;
    reloadAsync(): Promise<void>;
    dispose(): void;
}

interface Totals extends Omit<BatchTotals, 'rate'> {
    readonly rate?: LiveRate;
}

// What the card shows: files moving or waiting, nothing moving with some files stopped, or everything ended.
type TotalMode = 'moving' | 'stopped' | 'finished';

const TOTAL_TITLES: Readonly<Record<TotalMode, string>> = Object.freeze({
    moving: 'Total progress',
    stopped: 'Stopped',
    finished: 'Finished',
});

const CLOCK_INTERVAL_MS = 1000;

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

function setHidden(element: HTMLElement, isHidden: boolean): void {
    if (element.hidden !== isHidden) {
        element.hidden = isHidden;
    }
}

function setData(element: HTMLElement, name: string, value: string): void {
    if (element.dataset[name] !== value) {
        element.dataset[name] = value;
    }
}

function batchFilesKey(direction: string, batchId: string): string {
    return `${direction}:${batchId}`;
}

// Several batches moving at once share the link: their rates add up, and the time left follows from the sum.
function combinedRate(rates: readonly LiveRate[], bytesLeft: number): LiveRate | undefined {
    if (rates.length <= 1) {
        return rates[0];
    }

    const bytesPerSecond = rates.reduce((sum, rate) => sum + rate.bytesPerSecond, 0);

    return {
        bytesPerSecond,
        ...(bytesPerSecond > 0 ? { secondsLeft: bytesLeft / bytesPerSecond } : {}),
        stalled: rates.every(rate => rate.stalled === true),
    };
}

function combine(list: readonly BatchTotals[]): Totals {
    const sum = (pick: (totals: BatchTotals) => number): number => list.reduce((total, item) => total + pick(item), 0);
    const bytesDone = sum(item => item.bytesDone);
    const totalBytes = sum(item => item.totalBytes);
    const rate = combinedRate(list.flatMap(item => (item.rate == null ? [] : [item.rate])), totalBytes - bytesDone);

    return {
        total: sum(item => item.total),
        done: sum(item => item.done),
        saved: sum(item => item.saved),
        failed: sum(item => item.failed),
        canceled: sum(item => item.canceled),
        stopped: sum(item => item.stopped),
        skipped: sum(item => item.skipped),
        bytesDone,
        totalBytes,
        ...(rate == null ? {} : { rate }),
    };
}

// "12 of 24 done · 2 skipped · 3 downloaded · 1 failed · 1 cancelled · 2 stopped": the counts that apply.
function countsText(totals: Totals, downloaded: number | undefined): string {
    const parts = [`${totals.done.toLocaleString('en')} of ${totals.total.toLocaleString('en')} done`];
    const extras: ReadonlyArray<readonly [number | undefined, string]> = [
        [totals.skipped, 'skipped'],
        [downloaded, 'downloaded'],
        [totals.failed, 'failed'],
        [totals.canceled, 'cancelled'],
        [totals.stopped, 'stopped'],
    ];
    for (const [count, label] of extras) {
        if (count != null && count > 0) {
            parts.push(`${count.toLocaleString('en')} ${label}`);
        }
    }

    return parts.join(' · ');
}

function section(title: string, list: HTMLElement): HTMLElement {
    return h('section', {
        class: 'progress-section',
        attrs: { hidden: true },
        children: [
            h('header', { class: 'batch-head', children: [h('h3', { class: 'batch-title', text: title })] }),
            list,
        ],
    });
}

export function createProgressPanel(options: ProgressPanelOptions): ProgressPanel {
    const { context, actions, sessionId } = options;
    const { client, tracker } = context;
    const elsewhere = createUnfinishedElsewhereCard({ context, sessionId });
    const tiles = createPickerTiles(context.platform, kind => {
        if (isConnectedHere()) {
            context.pickFiles(kind);

            return;
        }

        const peerName = peerNameFor(context, sessionId);
        context.dialogs.toast(`Connect to ${peerName} first, then pick the files.`, { tone: 'warn' });
    });
    const hint = h('p', { class: 'send-hint' });
    const idle = h('div', {
        class: 'send-idle',
        children: [
            h('div', {
                class: 'picker-tiles',
                attrs: { 'role': 'group', 'aria-label': 'Pick files to send' },
                children: tiles,
            }),
            hint,
        ],
    });
    const batchList = h('div', { class: 'batch-list' });
    const looseList = h('ul', { class: 'progress-lines' });
    const looseSection = section('Unfinished', looseList);
    const needsList = h('ul', { class: 'progress-lines' });
    const needsSection = section('Needs picking again', needsList);

    const totalTitle = h('span', { class: 'total-title' });
    const totalClock = h('span', { class: 'total-clock' });
    const totalPercent = h('span', { class: 'total-percent' });
    const totalFill = h('span', { class: 'progress-fill' });
    const totalBar = h('span', {
        class: 'progress-bar',
        attrs: { 'role': 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Total progress' },
        children: [totalFill],
    });
    const totalCounts = h('p', { class: 'total-counts' });
    const totalBytes = h('p', { class: 'total-bytes' });
    const totalLeft = h('p', { class: 'total-left' });
    const totalDetails = h('div', { class: 'total-details', children: [totalCounts, totalBytes, totalLeft] });
    const actionButton = (action: string, label: string, icon: string, className = 'button'): HTMLButtonElement =>
        h('button', {
            class: className,
            dataset: { action },
            attrs: { type: 'button' },
            children: [
                h('span', { class: 'button-icon', html: icon, attrs: { 'aria-hidden': 'true' } }),
                h('span', { class: 'button-label', text: label }),
            ],
        });
    const stopButton = actionButton('stop-all', 'Stop', ICONS.stop);
    const resumeButton = actionButton('resume-all', 'Resume', ICONS.play, 'button button-primary');
    const moreButton = actionButton('send-more', 'Send more', ICONS.plus);
    const doneButton = actionButton('done-batches', 'Done', ICONS.check, 'button button-quiet total-done');
    const totalActions = h('div', {
        class: 'total-actions',
        children: [stopButton, resumeButton, moreButton, doneButton],
    });
    // Screen readers hear when the transfer finishes, not every percent on the way.
    const totalStatus = h('p', { class: 'total-status', attrs: { role: 'status' } });
    const totalCard = h('section', {
        class: 'transfer-total',
        attrs: { 'aria-label': 'Total progress', 'hidden': true },
        children: [
            h('div', {
                class: 'total-head',
                children: [
                    h('span', { class: 'total-heading', children: [totalTitle, ' ', totalClock] }),
                    totalPercent,
                ],
            }),
            totalBar,
            h('div', { class: 'total-body', children: [totalDetails, totalActions] }),
            totalStatus,
        ],
    });
    const element = h('div', {
        class: 'send-panel',
        children: [elsewhere.element, idle, batchList, looseSection, needsSection, totalCard],
    });

    const cards = new Map<string, BatchCard>();
    const looseLines = new Map<string, ProgressLine>();
    const needsLines = new Map<string, ProgressLine>();
    // When each shown batch stopped running, for the Finished and Stopped durations; set again if it runs again.
    const endedAt = new Map<string, number>();
    // What the card last showed: only a transfer seen moving here is announced as finished or stopped.
    let lastMode: TotalMode = 'finished';
    let isDisposed = false;
    let clock: ReturnType<typeof setInterval> | undefined;

    function isConnectedHere(): boolean {
        return client.state === 'connected' && client.peer?.sessionId === sessionId;
    }

    const renderIdle = (): void => {
        const peer = peerNameFor(context, sessionId);
        const isConnected = isConnectedHere();
        setText(hint, isConnected
            ? `Files go straight to ${peer}, encrypted. Received files download as one ZIP.`
            : `Connect to ${peer} again to send files.`);
        for (const tile of tiles) {
            const disabled = String(!isConnected);
            if (tile.getAttribute('aria-disabled') !== disabled) {
                tile.setAttribute('aria-disabled', disabled);
            }
        }
    };

    const startClock = (): void => {
        clock ??= setInterval(() => renderTotal(), CLOCK_INTERVAL_MS);
    };

    const stopClock = (): void => {
        if (clock != null) {
            clearInterval(clock);
            clock = undefined;
        }
    };

    const elapsedSeconds = (considered: readonly BatchCard[], isFinished: boolean): number => {
        const starts = considered.map(card => tracker.markBatchStarted(sessionId, card.batchId));
        const start = Math.min(...starts);
        const end = isFinished
            ? Math.max(...considered.map(card => endedAt.get(card.batchId) ?? Date.now()))
            : Date.now();

        return Math.max(0, (end - start) / 1000);
    };

    // The card follows the batches still moving, or, once none is, all the shown ones as Stopped or Finished.
    function renderTotal(): void {
        const shown = [...cards.values()];
        setHidden(totalCard, shown.length === 0);
        setHidden(idle, shown.length > 0);
        if (shown.length === 0) {
            stopClock();

            return;
        }

        for (const card of shown) {
            if (card.isRunning) {
                endedAt.delete(card.batchId);
            } else if (!endedAt.has(card.batchId)) {
                endedAt.set(card.batchId, card.batch.finishedAt ?? Date.now());
            }
        }

        const running = shown.filter(card => card.isRunning);
        const isStopped = running.length === 0 && shown.some(card => card.isStopped);
        const mode: TotalMode = running.length > 0 ? 'moving' : isStopped ? 'stopped' : 'finished';
        const isMoving = mode === 'moving';
        const considered = isMoving ? running : shown;
        const totals = combine(considered.map(card => card.totals()));
        const percent = totals.totalBytes === 0
            ? (mode === 'finished' ? 100 : 0)
            : (totals.bytesDone / totals.totalBytes) * 100;
        const receiving = considered.filter(card => card.batch.direction === 'in');
        const downloaded = receiving.length === 0
            ? undefined
            : receiving.reduce((sum, card) => sum + card.totals().saved, 0);
        const isConnected = isConnectedHere();

        setText(totalTitle, TOTAL_TITLES[mode]);
        setText(totalClock, `(${formatClock(elapsedSeconds(considered, !isMoving))})`);
        setText(totalPercent, mode === 'finished' ? '' : formatPercent(percent));
        totalFill.style.setProperty('--progress', `${Math.min(100, percent)}%`);
        totalBar.setAttribute('aria-valuenow', String(Math.floor(percent)));
        setText(totalCounts, countsText(totals, downloaded));
        const bytes = `${formatSize(totals.bytesDone)} of ${formatSize(totals.totalBytes)}`;
        const rate = totals.rate ?? { bytesPerSecond: 0 };
        const isWaiting = !isConnected || rate.stalled === true;
        const isMeasured = isMoving && !isWaiting && rate.bytesPerSecond > 0;
        setText(totalBytes, isMeasured ? `${bytes} · ${formatSpeed(rate.bytesPerSecond)}` : bytes);
        setText(totalLeft, leftText(mode, rate, isMeasured));
        setHidden(totalLeft, mode === 'finished');
        setHidden(stopButton, !isMoving);
        setHidden(resumeButton, mode !== 'stopped' || !isConnected);
        setHidden(moreButton, mode !== 'finished');
        setHidden(doneButton, isMoving);
        setData(totalCard, 'finished', String(mode === 'finished'));
        setData(totalCard, 'stopped', String(mode === 'stopped'));
        if (mode !== lastMode) {
            const announced = `${TOTAL_TITLES[mode]}. ${countsText(totals, downloaded)}.`;
            setText(totalStatus, lastMode === 'moving' ? announced : '');
        }

        lastMode = mode;

        if (isMoving) {
            startClock();
        } else {
            stopClock();
        }
    }

    // The third line: time left while files move, or how to go on once they are stopped.
    function leftText(mode: TotalMode, rate: LiveRate, isMeasured: boolean): string {
        const isConnected = isConnectedHere();
        if (mode === 'finished') {
            return '';
        }

        if (mode === 'stopped') {
            return isConnected
                ? 'What arrived is kept. Resume continues from there.'
                : `What arrived is kept. Connect to ${peerNameFor(context, sessionId)} again to resume.`;
        }

        if (!isConnected || rate.stalled === true) {
            return 'Waiting for the connection…';
        }

        return isMeasured ? formatTimeLeft(rate.secondsLeft) : 'Estimating time left…';
    }

    const renderLines = (
        list: HTMLElement,
        lines: Map<string, ProgressLine>,
        records: readonly FileRecord[],
        isNeedsPick: boolean,
    ): void => {
        const wanted = new Set(records.map(recordKey));
        for (const [key, line] of lines) {
            if (!wanted.has(key)) {
                line.dispose();
                lines.delete(key);
            }
        }

        syncChildren(list, records.map(record => {
            const key = recordKey(record);
            const line = lines.get(key) ?? createProgressLine({ context, actions, isNeedsPick });
            line.update(record, tracker.getProgress(record));
            lines.set(key, line);

            return line.element;
        }));
    };

    const renderCards = (batches: readonly BatchRecord[], filesOf: ReadonlyMap<string, FileRecord[]>): void => {
        const wanted = new Set(batches.map(batch => batch.batchId));
        for (const [batchId, card] of cards) {
            if (!wanted.has(batchId)) {
                card.dispose();
                card.element.remove();
                cards.delete(batchId);
                endedAt.delete(batchId);
            }
        }

        // In place: a batch already shown keeps its element, so the page doesn't jump on a reload.
        syncChildren(batchList, batches.map(batch => {
            const files = filesOf.get(batchFilesKey(batch.direction, batch.batchId)) ?? [];
            const existing = cards.get(batch.batchId);
            if (existing != null) {
                existing.update(batch);
                existing.setFiles(files);

                return existing.element;
            }

            const card = createBatchCard({
                context,
                actions,
                batch,
                scroller: options.scroller,
                onShowBatch: options.onShowBatch,
            });
            card.setFiles(files);
            cards.set(batch.batchId, card);

            return card.element;
        }));
    };

    const reloadAsync = async (): Promise<void> => {
        const [batches, stored] = await Promise.all([
            client.listBatchesAsync(sessionId),
            client.listFilesAsync({ sessionId }),
        ]);
        if (isDisposed) {
            return;
        }

        const records = stored.map(record => tracker.getRecord(record) ?? record);
        const filesOf = new Map<string, FileRecord[]>();
        for (const record of records) {
            if (record.batchId != null) {
                const key = batchFilesKey(record.direction, record.batchId);
                filesOf.set(key, [...(filesOf.get(key) ?? []), record]);
            }
        }

        // A batch waiting for this device's answer has nothing to show yet: the receive dialog asks first.
        const pending = new Set(tracker.pendingBatchesFor(sessionId).map(batch => batch.batchId));
        const shown = batches
            .filter(batch => {
                if (pending.has(batch.batchId)) {
                    return false;
                }

                const files = filesOf.get(batchFilesKey(batch.direction, batch.batchId)) ?? [];
                if (files.some(isMovingOrWaiting)) {
                    tracker.markBatchStarted(sessionId, batch.batchId);

                    return true;
                }

                // A stopped batch stays, also after a reload, until Done, so it can be resumed from here.
                if (files.some(isStoppedFile) && !tracker.isBatchDismissed(sessionId, batch.batchId)) {
                    tracker.markBatchStarted(sessionId, batch.batchId);

                    return true;
                }

                return tracker.batchStartedAt(sessionId, batch.batchId) != null
                    && !tracker.isBatchDismissed(sessionId, batch.batchId);
            })
            .sort((left, right) => left.createdAt - right.createdAt);
        renderCards(shown, filesOf);

        const shownKeys = new Set(shown.map(batch => batchFilesKey(batch.direction, batch.batchId)));
        const byQueue = (left: FileRecord, right: FileRecord): number => left.queueIndex - right.queueIndex;
        const loose = records
            .filter(record => isMovingOrWaiting(record)
                && (record.batchId == null || !shownKeys.has(batchFilesKey(record.direction, record.batchId))))
            .sort(byQueue);
        renderLines(looseList, looseLines, loose, false);
        setHidden(looseSection, loose.length === 0);
        const needs = records.filter(record => record.state === 'needs-file').sort(byQueue);
        renderLines(needsList, needsLines, needs, true);
        setHidden(needsSection, needs.length === 0);
        renderIdle();
        renderTotal();
    };

    const reloadSafelyAsync = (): Promise<void> => reloadAsync()
        .catch(error => context.logger.warn('xfer', 'could not load the progress view', { error }));

    const reload = createDebounce(() => {
        void reloadSafelyAsync();
    }, 300);

    // Send more and Done take the batches that don't move away, stopped ones too; the tiles come back for the next
    // pick.
    const dismissFinished = (): void => {
        const finished = [...cards.values()].filter(card => !card.isRunning);
        tracker.dismissBatches(sessionId, finished.map(card => card.batchId));
        for (const card of finished) {
            card.dispose();
            card.element.remove();
            cards.delete(card.batchId);
            endedAt.delete(card.batchId);
        }

        renderTotal();
        tiles[0]?.focus();
    };

    const confirmStopAsync = async (): Promise<void> => {
        const running = [...cards.values()].filter(card => card.isRunning);
        if (running.length === 0) {
            return;
        }

        const directions = new Set(running.map(card => card.batch.direction));
        const titles: Readonly<Record<string, string>> = { out: 'Stop sending?', in: 'Stop receiving?' };
        // Nothing is lost, so the question has no danger colour.
        const isConfirmed = await context.dialogs.confirmAsync({
            title: directions.size > 1
                ? 'Stop all transfers?'
                : titles[running[0]?.batch.direction ?? 'out'] ?? 'Stop sending?',
            message: `Finished files stay. Files still moving stop here and on ${peerNameFor(context, sessionId)}; `
                + 'what arrived is kept, so you can resume them later.',
            confirmLabel: 'Stop',
            cancelLabel: 'Keep going',
        });
        if (!isConfirmed) {
            return;
        }

        stopButton.disabled = true;
        await stopBatchesAsync(context, running);
        stopButton.disabled = false;
    };

    // Every shown batch with stopped files continues on both devices from what arrived.
    const resumeAllAsync = async (): Promise<void> => {
        resumeButton.disabled = true;
        await resumeBatchesAsync(context, [...cards.values()].filter(card => card.totals().stopped > 0));
        resumeButton.disabled = false;
    };

    stopButton.addEventListener('click', () => {
        void confirmStopAsync();
    });
    resumeButton.addEventListener('click', () => {
        void resumeAllAsync();
    });
    moreButton.addEventListener('click', dismissFinished);
    doneButton.addEventListener('click', dismissFinished);

    const unsubscribers = [
        tracker.onChange(change => {
            const mine = change.records.filter(record => record.sessionId === sessionId);
            for (const card of cards.values()) {
                card.updateFiles(mine);
            }

            for (const record of mine) {
                const key = recordKey(record);
                looseLines.get(key)?.update(record, tracker.getProgress(record));
                needsLines.get(key)?.update(record);
            }

            const progressHere = change.progress.filter(item => item.sessionId === sessionId);
            for (const card of cards.values()) {
                card.updateProgressOf(progressHere);
            }

            for (const item of progressHere) {
                looseLines.get(recordKey(item))?.setProgress(item);
            }

            let hasNewBatch = false;
            for (const batch of change.batches.filter(item => item.sessionId === sessionId)) {
                const card = cards.get(batch.batchId);
                card?.updateProgress(batch);
                hasNewBatch ||= card == null;
            }

            renderTotal();
            if ((change.isStructural && mine.length > 0) || hasNewBatch) {
                reload.schedule();
            }
        }),
        tracker.onBatchesChange(() => reload.schedule()),
        client.on('state', () => {
            renderIdle();
            renderTotal();
            reload.schedule();
        }),
        client.on('peer', () => renderIdle()),
        context.onDataChanged(() => reload.schedule()),
    ];

    renderIdle();
    void reloadSafelyAsync();

    return {
        element,
        reloadAsync,
        dispose: () => {
            isDisposed = true;
            reload.cancel();
            stopClock();
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            elsewhere.dispose();
            for (const card of cards.values()) {
                card.dispose();
            }

            for (const line of [...looseLines.values(), ...needsLines.values()]) {
                line.dispose();
            }
        },
    };
}
