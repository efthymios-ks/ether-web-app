import { UNFINISHED_STATES } from '../../client/clientTypes.js';
import type { FileRecord, FileState, ProgressInfo } from '../../client/clientTypes.js';

// Every file's status as a word with a status colour, never colour alone: Not sent yet → Sending → Sent on the
// sending side, Waiting → Receiving → Received on the receiving side, and Paused, Stopped, Needs picking again,
// Failed and Cancelled where they apply. A re-sent file the other device already has is checked by its full
// hash ("Waiting to check", then "Checking…" one file at a time) and then skipped ("Skipped · already on <peer>", note 'already-on-peer').
// The Sent and Received lists show only the exceptions (exceptionStatus): the plain end of a transfer goes unsaid.

export type StatusTone = 'muted' | 'accent' | 'ok' | 'warn' | 'fail';

export interface FileStatus {
    readonly text: string;
    readonly tone: StatusTone;
    // Pages are moving: the row shows its own bar.
    readonly isMoving: boolean;
}

// Stopped with its batch, on either device: what arrived is kept, and only Resume moves it again.
export function isStoppedFile(record: Pick<FileRecord, 'state' | 'pausedBy'>): boolean {
    return record.state === 'paused' && record.pausedBy === 'stop';
}

export function isSkipped(record: FileRecord): boolean {
    return record.state === 'done' && record.note === 'already-on-peer';
}

export function skippedText(peerName: string): string {
    return `Skipped · already on ${peerName}`;
}

export function fileStatus(record: FileRecord, peerName: string): FileStatus {
    const isOut = record.direction === 'out';
    if (record.note === 'moved') {
        return { text: 'Moved', tone: 'muted', isMoving: false };
    }

    if (isSkipped(record)) {
        return { text: skippedText(peerName), tone: 'muted', isMoving: false };
    }

    if (record.note === 'check-waiting' && UNFINISHED_STATES.includes(record.state)) {
        return { text: 'Waiting to check', tone: 'muted', isMoving: false };
    }

    if (record.note === 'checking' && UNFINISHED_STATES.includes(record.state)) {
        return { text: 'Checking…', tone: 'accent', isMoving: false };
    }

    const states: Readonly<Record<FileState, FileStatus>> = {
        'queued': { text: isOut ? 'Not sent yet' : 'Waiting', tone: 'muted', isMoving: false },
        'offered': { text: isOut ? 'Not sent yet' : 'Waiting', tone: 'muted', isMoving: false },
        'incoming': { text: 'Waiting', tone: 'muted', isMoving: false },
        'active': { text: isOut ? 'Sending' : 'Receiving', tone: 'accent', isMoving: true },
        'verifying': { text: isOut ? 'Sending' : 'Receiving', tone: 'accent', isMoving: true },
        'paused': { text: isStoppedFile(record) ? 'Stopped' : 'Paused', tone: 'warn', isMoving: false },
        'needs-file': { text: 'Needs picking again', tone: 'warn', isMoving: false },
        'done': isOut
            ? { text: 'Sent', tone: 'ok', isMoving: false }
            : { text: record.note === 'damaged' ? 'Damaged' : 'Received', tone: record.note === 'damaged' ? 'fail' : 'ok', isMoving: false },
        'failed': { text: 'Failed', tone: 'fail', isMoving: false },
        'canceled': { text: 'Cancelled', tone: 'muted', isMoving: false },
    };

    return states[record.state];
}

// A finished file in the Sent and Received lists: Sent or Skipped on the sending side, and on the receiving
// side whether it was downloaded yet.
function finishedStatus(record: FileRecord, peerName: string): Pick<FileStatus, 'text' | 'tone'> {
    if (record.note === 'moved') {
        return { text: 'Moved', tone: 'muted' };
    }

    if (record.state === 'failed') {
        return { text: 'Failed', tone: 'fail' };
    }

    if (record.state === 'canceled') {
        return { text: 'Cancelled', tone: 'muted' };
    }

    if (record.direction === 'out') {
        return isSkipped(record)
            ? { text: skippedText(peerName), tone: 'muted' }
            : { text: 'Sent', tone: 'ok' };
    }

    if (record.note === 'damaged') {
        return { text: 'Damaged', tone: 'fail' };
    }

    if (!record.hasData) {
        return { text: 'Deleted from app', tone: 'muted' };
    }

    return record.savedAt == null
        ? { text: 'Not downloaded yet', tone: 'warn' }
        : { text: 'Downloaded', tone: 'ok' };
}

// What the Sent and Received lists, rows and tiles alike, say about a file: its transfer while unfinished,
// what became of it once finished.
export function listStatus(record: FileRecord, peerName: string): Pick<FileStatus, 'text' | 'tone'> {
    return UNFINISHED_STATES.includes(record.state)
        ? fileStatus(record, peerName)
        : finishedStatus(record, peerName);
}

// The plain end of a transfer, which the lists leave unsaid: Sent on the sending side, and Not downloaded yet
// on the receiving side.
export function isPlainFinish(record: FileRecord): boolean {
    if (record.state !== 'done' || record.note === 'moved') {
        return false;
    }

    return record.direction === 'out'
        ? !isSkipped(record)
        : record.hasData && record.note !== 'damaged' && record.savedAt == null;
}

// A received file still in the app that was downloaded in a ZIP: a ✓ on its tile.
export function isDownloaded(record: FileRecord): boolean {
    return record.direction === 'in'
        && record.state === 'done'
        && record.hasData
        && record.note !== 'damaged'
        && record.note !== 'moved'
        && record.savedAt != null;
}

// The status a Sent or Received row shows: only the exceptions, so Failed, Damaged, Skipped, Paused, Stopped or
// Not sent yet stand out, and nothing at the plain end of a transfer.
export function exceptionStatus(record: FileRecord, peerName: string): Pick<FileStatus, 'text' | 'tone'> | undefined {
    return isPlainFinish(record) ? undefined : listStatus(record, peerName);
}

export interface ShownProgress {
    readonly pagesDone: number;
    readonly totalPages: number;
    readonly percent: number;
}

// The bar never goes backwards: after a resume the first events may count from an older page, so a row keeps
// the furthest it has shown for the same file. Only a real restart (`restarted`, `data-lost`) starts over.
export function createProgressMemory(): { show(record: FileRecord, next: ShownProgress | undefined): ShownProgress | undefined } {
    let key = '';
    let note: FileRecord['note'];
    let furthest: ShownProgress | undefined;

    return {
        show: (record, next) => {
            const recordKey = `${record.sessionId}:${record.direction}:${record.fileId}`;
            const isNewRestart = record.note !== note && (record.note === 'restarted' || record.note === 'data-lost');
            if (recordKey !== key || isNewRestart) {
                key = recordKey;
                furthest = undefined;
            }

            note = record.note;

            if (next == null) {
                return furthest;
            }

            if (furthest == null || next.percent >= furthest.percent) {
                furthest = next;
            }

            return furthest;
        },
    };
}

export function percentOf(progress: Pick<ProgressInfo, 'percent'>): number {
    return Math.min(100, Math.max(0, progress.percent));
}
