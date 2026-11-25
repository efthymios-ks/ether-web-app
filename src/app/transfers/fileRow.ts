import { UNFINISHED_STATES } from '../../client/clientTypes.js';
import type { FileNote, FileRecord, FileState, PausedBy, ProgressInfo } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import type { FileActions } from './fileActions.js';
import { damagedText } from './fileErrors.js';
import { isStoppedFile, skippedText } from './fileStatus.js';

// What every file row shares (§7.6): the actions a file's state allows, from one table, the notes that say why a
// file stopped, and the checkbox of a selectable row. The progress view's lines (progressLine.ts) and the Sent and
// Received rows (gallery/galleryRow.ts) show them, the actions behind one ⋯ sheet (gallery/rowMenu.ts).

// Names are truncated in the middle past this length, keeping the extension (UI-09).
export const NAME_LENGTH = 44;

export interface RowSelectable {
    pick(record: FileRecord, isShift: boolean): void;
}

// A row of the Sent and Received lists.
export interface FileRow {
    readonly element: HTMLElement;
    update(record: FileRecord, progress?: ProgressInfo): void;
    // Live progress for the record the row already shows, also when no state event has arrived for it yet.
    setProgress(progress: ProgressInfo): void;
    // Shows the checkbox while selecting, ticked or not.
    setSelection(isSelecting: boolean, isSelected: boolean): void;
    // A thumbnail became ready after the row was drawn.
    refreshThumbnail?(): void;
    // Frees what the row holds, such as a thumbnail's object URL.
    dispose(): void;
}

export interface RowCheck {
    readonly element: HTMLElement;
    readonly isSelecting: boolean;
    set(isSelecting: boolean, isSelected: boolean, name: string): void;
}

// A 44 px checkbox at the start of a selectable row. Its own click picks the row, with Shift for a range.
export function createRowCheck(onPick: (isShift: boolean) => void): RowCheck {
    const box = h('input', { class: 'file-check-box', attrs: { type: 'checkbox' } });
    const element = h('label', { class: 'file-check', attrs: { hidden: true }, children: [box] });
    let isSelecting = false;
    box.addEventListener('click', event => {
        event.stopPropagation();
        onPick(event.shiftKey);
    });
    // A click on the label's padding reaches the box as its own click; the row must not take it as well.
    element.addEventListener('click', event => event.stopPropagation());

    return {
        element,
        get isSelecting() {
            return isSelecting;
        },
        set: (nextSelecting, isSelected, name) => {
            isSelecting = nextSelecting;
            element.hidden = !nextSelecting;
            box.checked = isSelected;
            box.setAttribute('aria-label', `Select ${name}`);
        },
    };
}

const PAUSED_TEXT: Readonly<Record<PausedBy, (peer: string) => string>> = Object.freeze({
    user: () => 'Paused',
    peer: (peer: string) => `Paused by ${peer}`,
    link: () => 'Paused: connection lost',
    storage: () => 'Paused: storage full',
    stop: () => 'Stopped',
});

// Why a paused file waits, e.g. "Paused by Pixel 8".
export function pausedText(record: FileRecord, peerName: string): string {
    return PAUSED_TEXT[record.pausedBy ?? 'link'](peerName);
}

const NOTE_TEXT: Readonly<Record<FileNote, (peer: string, record: FileRecord) => string>> = Object.freeze({
    'check-waiting': (peer: string) => `Waiting to check whether ${peer} already has it`,
    'checking': (peer: string) => `Checking whether ${peer} already has it…`,
    'already-on-peer': (peer: string) => skippedText(peer),
    'data-lost': () => 'Partial data was lost, restarting',
    'adopted': () => 'Picked up an earlier partial',
    'restarted': () => 'Restarted from the beginning',
    'storage-full': () => 'Storage full',
    'partial-expired': () => 'The partial file expired and was deleted',
    'declined': (peer: string) => `Declined by ${peer}`,
    'no-space': (peer: string) => `Not enough space on ${peer}`,
    'moved': (peer: string) => `Moved to ${peer}`,
    'damaged': (peer: string, record: FileRecord) => damagedText(record.name, peer),
});

export interface RowAction {
    readonly id: string;
    readonly label: string;
    readonly tone?: 'primary' | 'danger';
    when(record: FileRecord, context: AppContext): boolean;
    run(record: FileRecord, actions: FileActions): void;
}

// Where what arrived of a file can be deleted: on the receiver, a file not moving that holds pages; on the sender,
// one resting with pages acknowledged.
const PARTIAL_STATES: Readonly<Record<FileRecord['direction'], readonly FileState[]>> = {
    in: ['paused', 'canceled', 'failed'],
    out: ['paused', 'needs-file'],
};

function hasPartial(record: FileRecord): boolean {
    return PARTIAL_STATES[record.direction].includes(record.state) && (record.pagination?.pagesDone ?? 0) > 0;
}

// Order is the order of the sheet's items.
const ROW_ACTIONS: readonly RowAction[] = [
    { id: 'accept', label: 'Accept', tone: 'primary', when: record => record.state === 'incoming', run: (record, actions) => void actions.acceptAsync(record) },
    { id: 'decline', label: 'Decline', when: record => record.state === 'incoming', run: (record, actions) => void actions.declineAsync(record) },
    {
        id: 'pick-again',
        label: 'Pick file again',
        tone: 'primary',
        when: record => record.direction === 'out' && record.state === 'needs-file',
        run: (_, actions) => actions.pickAgain(),
    },
    {
        id: 'resume',
        label: 'Resume',
        tone: 'primary',
        when: (record, context) => record.state === 'paused' && context.client.state === 'connected',
        run: (record, actions) => void actions.resumeAsync(record),
    },
    {
        id: 'pause',
        label: 'Pause',
        when: record => record.state === 'active' || record.state === 'queued',
        run: (record, actions) => void actions.pauseAsync(record),
    },
    // A stopped file with a partial offers Delete partial instead, which does the same.
    {
        id: 'cancel',
        label: 'Cancel',
        when: record => UNFINISHED_STATES.includes(record.state)
            && record.state !== 'incoming'
            && !(isStoppedFile(record) && hasPartial(record)),
        run: (record, actions) => void actions.cancelAsync(record),
    },
    {
        id: 'delete',
        label: 'Delete',
        tone: 'danger',
        when: record => record.direction === 'in' && record.state === 'done' && record.hasData,
        run: (record, actions) => void actions.deleteReceivedAsync(record),
    },
    {
        id: 'delete-partial',
        label: 'Delete partial',
        tone: 'danger',
        when: hasPartial,
        run: (record, actions) => void actions.deletePartialAsync(record),
    },
    {
        id: 'send-again',
        label: 'Send again',
        when: (record, context) => record.direction === 'out' && record.state === 'done' && context.client.state === 'connected',
        run: (record, actions) => void actions.sendAgainAsync(record),
    },
    {
        id: 'details',
        label: 'Details',
        when: record => record.state === 'done',
        run: (record, actions) => actions.details(record),
    },
];

// The actions a record's state allows; a file moved to another device has none, its old record only tells where it went.
export function rowActionsFor(record: FileRecord, context: AppContext): RowAction[] {
    return record.note === 'moved' ? [] : ROW_ACTIONS.filter(action => action.when(record, context));
}

export function progressOf(record: FileRecord, progress?: ProgressInfo): { pagesDone: number; totalPages: number; percent: number } | undefined {
    if (progress != null) {
        return { pagesDone: progress.pagesDone, totalPages: progress.totalPages, percent: progress.percent };
    }

    const pagination = record.pagination;
    if (pagination == null) {
        return undefined;
    }

    const percent = pagination.totalPages === 0 ? 100 : (pagination.pagesDone / pagination.totalPages) * 100;

    return { pagesDone: pagination.pagesDone, totalPages: pagination.totalPages, percent };
}

// The whole percent of a file's pages that are done; a file without pages is all there.
function wholePercent(pagination: { readonly pagesDone: number; readonly totalPages: number }): number {
    return pagination.totalPages === 0 ? 100 : Math.floor((pagination.pagesDone / pagination.totalPages) * 100);
}

function resumePoint(record: FileRecord): string {
    const pagination = record.pagination;
    if (pagination == null) {
        return '';
    }

    const percent = wholePercent(pagination);

    return ` from page ${pagination.pagesDone} of ${pagination.totalPages} (${percent}%)`;
}

// "Stopped at page 1312 of 2048 (64%). What arrived is kept; Resume continues from there."
function stoppedText(record: FileRecord): string {
    const pagination = record.pagination;
    if (pagination == null || pagination.pagesDone === 0) {
        return 'Stopped before any of it arrived. Resume sends it.';
    }

    const percent = wholePercent(pagination);

    return `Stopped at page ${pagination.pagesDone} of ${pagination.totalPages} (${percent}%). `
        + 'What arrived is kept; Resume continues from there.';
}

// §7.4 step 5: "Pick IMG_2231.MOV again to resume from page 1312 of 2048 (64%)."
export function needsFileText(record: FileRecord): string {
    return `Pick ${record.name} again to resume${resumePoint(record)}.`;
}

// The same under the file's own name in Needs picking again: "Pick it again to resume from page 1312 of 2048 (64%)."
export function needsFileHint(record: FileRecord): string {
    return `Pick it again to resume${resumePoint(record)}.`;
}

// The old session's records after a move name the device connected now, which received them.
function movedToName(record: FileRecord, context: AppContext): string {
    const peer = context.client.peer;

    return peer != null && peer.sessionId !== record.sessionId ? peer.displayName : 'another device';
}

// Why a file stands where it does, for the row's ⋯ sheet, e.g. a damaged copy or the reason it failed.
export function noteFor(record: FileRecord, peer: string, context: AppContext): string | undefined {
    if (record.note === 'moved') {
        return NOTE_TEXT.moved(movedToName(record, context), record);
    }

    if (record.state === 'needs-file') {
        return needsFileText(record);
    }

    if (isStoppedFile(record)) {
        return stoppedText(record);
    }

    if (record.note != null && record.note !== 'already-on-peer') {
        return NOTE_TEXT[record.note](peer, record);
    }

    if (record.state === 'failed') {
        return context.tracker.getError(record)?.message ?? record.lastError ?? 'The file could not be verified.';
    }

    return undefined;
}
