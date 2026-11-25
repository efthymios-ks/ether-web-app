import type { FileRecord } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import type { FileActions } from '../transfers/fileActions.js';
import { peerNameFor } from '../transfers/fileErrors.js';
import { noteFor, rowActionsFor } from '../transfers/fileRow.js';
import { openFilesSheet } from './filesSheet.js';

// A list row's ⋯ sheet: the same action table as the full rows (Accept, Decline, Resume, Pause, Cancel,
// Delete partial, Send again, Details and the rest, as the file's state allows) plus Download ZIP for that one
// file, with Delete and Delete partial last, and the row's note above them, e.g. a damaged copy.

export interface RowMenuItem {
    readonly id: string;
    readonly label: string;
    readonly isDanger: boolean;
}

const ACTION_ICONS: Readonly<Record<string, string>> = Object.freeze({
    'download-zip': ICONS.download,
    'accept': ICONS.check,
    'decline': ICONS.close,
    'pick-again': ICONS.folder,
    'resume': ICONS.play,
    'pause': ICONS.pause,
    'cancel': ICONS.stop,
    'delete': ICONS.trash,
    'delete-partial': ICONS.trash,
    'send-again': ICONS.retry,
    'details': ICONS.info,
});

export function canDownloadZip(record: FileRecord): boolean {
    return record.direction === 'in' && record.state === 'done' && record.hasData && record.note !== 'damaged';
}

function rowMenuItems(record: FileRecord, context: AppContext): RowMenuItem[] {
    const download: RowMenuItem[] = canDownloadZip(record)
        ? [{ id: 'download-zip', label: 'Download ZIP', isDanger: false }]
        : [];
    const table = rowActionsFor(record, context).map(action => ({
        id: action.id,
        label: action.label,
        isDanger: action.tone === 'danger',
    }));

    return [...download, ...table.filter(item => !item.isDanger), ...table.filter(item => item.isDanger)];
}

// What the sheet would show: actions, or at least a note.
export function hasRowMenu(record: FileRecord, context: AppContext): boolean {
    return rowMenuItems(record, context).length > 0
        || noteFor(record, peerNameFor(context, record.sessionId), context) != null;
}

export interface RowMenuOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    // The row's record as it is now, read again when an action is chosen.
    readonly record: () => FileRecord;
    readonly onDetails: (record: FileRecord) => void;
}

export function openRowMenu(options: RowMenuOptions): void {
    const { context, actions } = options;
    const record = options.record();
    const note = noteFor(record, peerNameFor(context, record.sessionId), context);
    const isTrouble = record.state === 'failed' || record.note === 'damaged';

    const run = (id: string): void => {
        const latest = options.record();
        if (id === 'download-zip') {
            void actions.downloadZipAsync([latest.fileId], latest.sessionId);

            return;
        }

        if (id === 'details') {
            options.onDetails(latest);

            return;
        }

        rowActionsFor(latest, context).find(action => action.id === id)?.run(latest, actions);
    };

    const buttons = rowMenuItems(record, context).map(item => h('button', {
        class: 'menu-item',
        dataset: { action: item.id, ...(item.isDanger ? { tone: 'danger' } : {}) },
        attrs: { 'type': 'button', 'aria-label': `${item.label}: ${record.name}` },
        children: [h('span', { class: 'menu-icon', html: ACTION_ICONS[item.id] ?? ICONS.file }), item.label],
        on: {
            click: () => {
                // The sheet closes first, so a confirmation opens over the list and focus returns to the row.
                sheet.close();
                run(item.id);
            },
        },
    }));
    const sheet = openFilesSheet({
        context,
        title: record.name,
        className: 'files-row-menu',
        children: [
            note == null
                ? null
                : h('p', { class: 'files-note', text: note, dataset: { tone: isTrouble ? 'fail' : 'info' } }),
            buttons.length === 0
                ? null
                : h('div', {
                    class: 'menu-list',
                    attrs: { 'role': 'group', 'aria-label': 'Actions' },
                    children: buttons,
                }),
        ],
        ...(buttons[0] == null ? {} : { initialFocus: buttons[0] }),
    });
}
