import { UNFINISHED_STATES } from '../../client/clientTypes.js';
import type { FileRecord, FileState, ProgressInfo } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { categoryOf, createFileIcon, createThumbImage } from '../fileIcon.js';
import { formatLiveRate, formatPercent, formatSize } from '../format.js';
import { hasRowMenu, openRowMenu } from '../gallery/rowMenu.js';
import type { FileActions } from './fileActions.js';
import { peerNameFor } from './fileErrors.js';
import { fileRef } from './fileRef.js';
import { NAME_LENGTH, needsFileHint, pausedText, progressOf } from './fileRow.js';
import { createProgressMemory, isSkipped, percentOf, skippedText } from './fileStatus.js';
import type { StatusTone } from './fileStatus.js';
import { recordKey } from './transferTracker.js';

// One file of the progress view (§4.5), LocalSend-plain: a 40 px thumbnail or icon, "name (size)" on one line
// (UI-09), and under it Done, Queue, "Resuming from 64%", Checking…, "Skipped · already on <peer>", Stopped and the
// other exceptions in their colours, or the file's own bar with its percent while it moves, with page X of Y, its
// speed and time left after it (TR-10);
// only moving files say this much, so the list stays calm. The whole line is one button that opens the file's
// actions as the row ⋯ sheet (gallery/rowMenu.ts). Every part is updated in place, so a line never changes under
// a finger.

// The fixed height of a line, also the virtualised height; the stylesheet's .progress-line matches it.
export const PROGRESS_LINE_HEIGHT = 56;

export interface LineStatus {
    readonly text: string;
    readonly tone: StatusTone;
    // Pages are moving: the line shows its bar and percent; the text is for screen readers.
    readonly isMoving: boolean;
    // A spinner before the words, while the other device's copy is checked.
    readonly isChecking: boolean;
}

const QUEUED_STATES: readonly FileState[] = Object.freeze(['queued', 'offered']);

function status(
    text: string,
    tone: StatusTone,
    flags: Partial<Pick<LineStatus, 'isMoving' | 'isChecking'>> = {},
): LineStatus {
    return { text, tone, isMoving: flags.isMoving === true, isChecking: flags.isChecking === true };
}

// Canceled, or thrown away with Delete what arrived: nothing of it is kept.
function canceledStatus(record: FileRecord, peerName: string): LineStatus {
    const reasons: Readonly<Partial<Record<NonNullable<FileRecord['note']>, string>>> = {
        'declined': `Declined by ${peerName}`,
        'no-space': `No space on ${peerName}`,
    };

    return status(record.note == null ? 'Cancelled' : reasons[record.note] ?? 'Cancelled', 'muted');
}

// A queued file with pages already saved continues from them ("Resuming from 64%"), e.g. after a Stop or when picked
// again. MD-08: a queued file that carries GPS says so.
function queuedText(record: FileRecord): string {
    const pagination = record.pagination;
    if (pagination != null && pagination.pagesDone > 0 && pagination.totalPages > 0) {
        return `Resuming from ${Math.floor((pagination.pagesDone / pagination.totalPages) * 100)}%`;
    }

    return record.direction === 'out' && record.metadata?.latitude != null ? 'Queue · Location included' : 'Queue';
}

// What a line says about its file; the plain words of the progress view rather than the lists' statuses.
export function lineStatus(record: FileRecord, peerName: string): LineStatus {
    if (record.note === 'moved') {
        return status('Moved', 'muted');
    }

    if (isSkipped(record)) {
        return status(skippedText(peerName), 'muted');
    }

    const isUnfinished = UNFINISHED_STATES.includes(record.state);
    if (isUnfinished && record.note === 'check-waiting') {
        return status('Waiting to check', 'muted');
    }

    if (isUnfinished && record.note === 'checking') {
        return status('Checking…', 'accent', { isChecking: true });
    }

    if (QUEUED_STATES.includes(record.state)) {
        return status(queuedText(record), 'muted');
    }

    const isOut = record.direction === 'out';
    const states: Readonly<Record<Exclude<FileState, 'queued' | 'offered'>, () => LineStatus>> = {
        'incoming': () => status('Waiting for you to accept', 'muted'),
        'active': () => status(isOut ? 'Sending' : 'Receiving', 'accent', { isMoving: true }),
        'verifying': () => status(isOut ? 'Sending' : 'Receiving', 'accent', { isMoving: true }),
        'paused': () => status(pausedText(record, peerName), 'warn'),
        'needs-file': () => status('Needs picking again', 'warn'),
        'done': () => (record.note === 'damaged' ? status('Damaged', 'fail') : status('Done', 'ok')),
        'failed': () => status('Failed', 'fail'),
        'canceled': () => canceledStatus(record, peerName),
    };

    return states[record.state as Exclude<FileState, 'queued' | 'offered'>]();
}

export interface ProgressLineOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    // Needs picking again: the line says where the file resumes and has its own Pick button.
    readonly isNeedsPick?: boolean;
}

export interface ProgressLine {
    readonly element: HTMLElement;
    update(record: FileRecord, progress?: ProgressInfo): void;
    // Live progress for the file the line already shows.
    setProgress(progress: ProgressInfo): void;
    dispose(): void;
}

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

function setAttribute(element: HTMLElement, name: string, value: string): void {
    if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
    }
}

export function createProgressLine(options: ProgressLineOptions): ProgressLine {
    const { context, actions } = options;
    const thumb = h('span', { class: 'file-thumb', attrs: { 'aria-hidden': 'true' } });
    const name = h('span', { class: 'line-name' });
    const size = h('span', { class: 'line-size' });
    const spinner = h('span', { class: 'spinner-small', attrs: { 'aria-hidden': 'true', 'hidden': true } });
    const words = h('span', { class: 'line-words' });
    const statusText = h('span', { class: 'line-status', children: [spinner, words] });
    const fill = h('span', { class: 'progress-fill' });
    const bar = h('span', {
        class: 'progress-bar',
        attrs: { 'role': 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'hidden': true },
        children: [fill],
    });
    const detail = h('span', { class: 'line-detail', attrs: { hidden: true } });
    const open = h('button', {
        class: 'line-open',
        attrs: { 'type': 'button', 'aria-haspopup': 'dialog' },
        children: [
            thumb,
            h('span', {
                class: 'line-text',
                children: [
                    h('span', { class: 'line-title', children: [name, size] }),
                    h('span', { class: 'line-state', children: [statusText, bar, detail] }),
                ],
            }),
        ],
        on: { click: () => openMenu() },
    });
    const pick = options.isNeedsPick === true
        ? h('button', {
            class: 'button button-small line-pick',
            text: 'Pick',
            dataset: { action: 'pick-again' },
            attrs: { type: 'button' },
            on: { click: () => actions.pickAgain() },
        })
        : null;
    const element = h('li', { class: 'progress-line', children: [open, pick] });
    const memory = createProgressMemory();
    let current: FileRecord | undefined;
    let lastProgress: ProgressInfo | undefined;
    let thumbFor = '';
    let thumbUrl: string | undefined;
    // Whether this file's thumbnail was asked for at all, and since its record said it has one.
    let isThumbAsked = false;
    let isFlaggedThumbAsked = false;
    let isDisposed = false;

    const releaseThumb = (): void => {
        if (thumbUrl != null) {
            URL.revokeObjectURL(thumbUrl);
            thumbUrl = undefined;
        }
    };

    const loadThumbAsync = async (record: FileRecord, key: string): Promise<void> => {
        const blob = await context.client.getThumbnailAsync(fileRef(record)).catch(() => undefined);
        if (blob == null || isDisposed || key !== thumbFor) {
            return;
        }

        releaseThumb();
        thumbUrl = URL.createObjectURL(blob);
        thumb.replaceChildren(createThumbImage({
            src: thumbUrl,
            className: 'file-thumb-image',
            onBroken: () => showIcon(record),
        }));
    };

    // The category's fixed icon, for a file without a thumbnail or one this browser can't draw.
    const showIcon = (record: FileRecord): void => {
        releaseThumb();
        thumb.replaceChildren(createFileIcon(categoryOf(record)));
    };

    // The file-type icon until the thumbnail is ready, which may be after the line was drawn. A photo or video is
    // asked for its thumbnail once even when its record doesn't say it has one: the client flags a thumbnail made
    // after the file's last change with a 'thumb' event, not a record change, so a line drawn after that event
    // would otherwise keep the icon. It is asked again once its record says it has one.
    const showThumb = (record: FileRecord): void => {
        const key = `${record.sessionId}/${record.direction}/${record.fileId}`;
        if (key !== thumbFor) {
            thumbFor = key;
            isThumbAsked = false;
            isFlaggedThumbAsked = false;
            showIcon(record);
        }

        if (thumbUrl != null) {
            return;
        }

        const category = categoryOf(record);
        const isVisual = category === 'image' || category === 'video';
        const shouldAsk = record.hasThumbnail ? !isFlaggedThumbAsked : isVisual && !isThumbAsked;
        if (shouldAsk) {
            isThumbAsked = true;
            isFlaggedThumbAsked = record.hasThumbnail;
            void loadThumbAsync(record, key);
        }
    };

    // A received file's thumbnail may be made after its last change, e.g. by this device once the file is whole:
    // it still replaces the icon.
    const unsubscribeThumb = context.client.on('thumb', (fileId, sessionId) => {
        const record = current;
        if (record != null && thumbUrl == null && record.direction === 'in' && record.fileId === fileId
            && record.sessionId === sessionId) {
            void loadThumbAsync(record, thumbFor);
        }
    });

    const openMenu = (): void => {
        const record = current;
        if (record == null || !hasRowMenu(record, context)) {
            return;
        }

        openRowMenu({ context, actions, record: () => current ?? record, onDetails: shown => actions.details(shown) });
    };

    // "42% · page 1312 of 2048 · 2.0 MB/s · 1 min left" beside a moving file's bar.
    const detailText = (percent: number, moving: ReturnType<typeof progressOf>): string => {
        const parts = [formatPercent(percent)];
        if (moving != null && moving.totalPages > 0) {
            parts.push(`page ${moving.pagesDone} of ${moving.totalPages}`);
        }

        if (lastProgress != null) {
            parts.push(...formatLiveRate(lastProgress));
        }

        return parts.join(' · ');
    };

    const update = (record: FileRecord, progress?: ProgressInfo): void => {
        const peer = peerNameFor(context, record.sessionId);
        const shown = lineStatus(record, peer);
        // A rate belongs to one run of one file.
        if (!shown.isMoving || (current != null && recordKey(current) !== recordKey(record))) {
            lastProgress = undefined;
        }

        current = record;
        if (progress != null && shown.isMoving) {
            lastProgress = progress;
        }

        setData(element, 'state', record.state);
        setData(element, 'tone', shown.tone);
        showThumb(record);
        setText(name, context.services.truncateMiddle(record.name, NAME_LENGTH));
        setText(size, ` (${formatSize(record.size)})`);
        setAttribute(open, 'title', record.relativePath ?? record.name);

        const moving = memory.show(record, progressOf(record, progress));
        const percent = moving == null ? 0 : percentOf(moving);
        const text = options.isNeedsPick === true ? needsFileHint(record) : shown.text;
        setText(words, text);
        setHidden(spinner, !shown.isChecking);
        setHidden(statusText, shown.isMoving);
        setHidden(bar, !shown.isMoving);
        setHidden(detail, !shown.isMoving);
        setData(element, 'moving', String(shown.isMoving));
        if (shown.isMoving) {
            fill.style.setProperty('--progress', `${percent}%`);
            setAttribute(bar, 'aria-valuenow', String(Math.round(percent)));
            setAttribute(bar, 'aria-label', `${record.name}: ${formatPercent(percent)}`);
            setText(detail, detailText(percent, moving));
        }

        // The visible name may be cut short: screen readers get it whole with its folder, its status and what a
        // tap does.
        const said = shown.isMoving ? `${shown.text} ${formatPercent(percent)}` : text;
        const tap = hasRowMenu(record, context) ? '. Actions' : '';
        const fullName = record.relativePath ?? record.name;
        setAttribute(open, 'aria-label', `${fullName} (${formatSize(record.size)}), ${said}${tap}`);
        if (pick != null) {
            setAttribute(pick, 'aria-label', `Pick ${record.name} again`);
        }
    };

    return {
        element,
        update,
        setProgress: progress => {
            const shown = current;
            if (shown != null && shown.sessionId === progress.sessionId && shown.direction === progress.direction
                && shown.fileId === progress.fileId) {
                update(context.tracker.getRecord(shown) ?? shown, progress);
            }
        },
        dispose: () => {
            isDisposed = true;
            unsubscribeThumb();
            releaseThumb();
        },
    };
}
