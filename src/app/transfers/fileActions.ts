import { ClientError } from '../../client/clientTypes.js';
import type { FileRecord } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { openFileDetails } from '../history/fileDetails.js';
import { downloadZipAsync } from '../saving/zipDownload.js';
import { peerNameFor } from './fileErrors.js';
import { fileRef } from './fileRef.js';

// Row actions (§7.6) with their confirmations, and errors turned into toasts (CL-07).

export interface FileActions {
    acceptAsync(record: FileRecord): Promise<void>;
    declineAsync(record: FileRecord): Promise<void>;
    pauseAsync(record: FileRecord): Promise<void>;
    resumeAsync(record: FileRecord): Promise<void>;
    cancelAsync(record: FileRecord): Promise<void>;
    deletePartialAsync(record: FileRecord): Promise<void>;
    deleteReceivedAsync(record: FileRecord): Promise<boolean>;
    sendAgainAsync(record: FileRecord): Promise<void>;
    retryFailedAsync(sessionId: string, batchId: string): Promise<void>;
    // The only way files leave the app: one ZIP that keeps their dates.
    downloadZipAsync(fileIds: readonly string[], sessionId: string): Promise<boolean>;
    pickAgain(): void;
    details(record: FileRecord): void;
}

const ERROR_TEXT: ReadonlyArray<{ readonly code: ClientError['code']; readonly text: string }> = [
    { code: 'not-connected', text: 'Not connected. Pair the devices again to continue.' },
    { code: 'no-space', text: 'Not enough free space on this device.' },
    { code: 'storage-full', text: 'Storage is full. Free some space and resume.' },
    { code: 'file-not-found', text: 'That file is no longer in the app.' },
    { code: 'file-unreadable', text: 'The file could not be read. Pick it again.' },
    { code: 'verify-failed', text: 'The stored copy is damaged. Ask the other device to send it again.' },
];

export function describeClientError(error: unknown): string {
    if (error instanceof ClientError) {
        return ERROR_TEXT.find(item => item.code === error.code)?.text ?? error.message;
    }

    return error instanceof Error ? error.message : 'Something went wrong.';
}

export function createFileActions(context: AppContext): FileActions {
    const { client, dialogs, tracker } = context;

    const runAsync = async (task: () => Promise<void>): Promise<void> => {
        try {
            await task();
        } catch (error) {
            context.logger.warn('xfer', 'file action failed', { error });
            dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    };

    const peerName = (record: FileRecord): string => peerNameFor(context, record.sessionId);

    const actions: FileActions = {
        acceptAsync: record => runAsync(() => client.acceptIncomingAsync(fileRef(record))),
        declineAsync: record => runAsync(() => client.rejectIncomingAsync(fileRef(record), 'declined')),
        pauseAsync: record => runAsync(() => client.pauseAsync(fileRef(record))),
        resumeAsync: record => runAsync(() => client.resumeAsync(fileRef(record))),
        // Stopping a file deletes what arrived of it on both devices; there is nothing to keep or to decide.
        cancelAsync: async record => {
            const isOut = record.direction === 'out';
            const isConfirmed = await dialogs.confirmAsync({
                title: isOut ? 'Stop sending?' : 'Stop receiving?',
                message: isOut
                    ? `${record.name} stops here, and what ${peerName(record)} received of it so far is deleted.`
                    : `${record.name} stops here, and what arrived of it so far is deleted.`,
                confirmLabel: 'Stop',
                cancelLabel: isOut ? 'Keep sending' : 'Keep receiving',
                danger: true,
            });
            if (!isConfirmed) {
                return;
            }

            tracker.noteLocalCancel(record);
            await runAsync(() => client.cancelAsync(fileRef(record)));
        },
        // Throws away what arrived of a file that isn't moving, on both devices.
        deletePartialAsync: async record => {
            const arrived = record.direction === 'out' ? `What ${peerName(record)} received` : 'What arrived';
            const isConfirmed = await dialogs.confirmAsync({
                title: 'Delete the partial file?',
                message: `${arrived} of ${record.name} is deleted. Sending it again starts from the beginning.`,
                confirmLabel: 'Delete',
                danger: true,
            });
            if (isConfirmed) {
                await runAsync(() => client.deletePartialAsync(fileRef(record)));
            }
        },
        deleteReceivedAsync: async record => {
            const isConfirmed = await dialogs.confirmAsync({
                title: 'Delete from Ether?',
                message: record.savedAt == null
                    ? `${record.name} is not downloaded yet. Deleting removes it from this device.`
                    : `The ZIP you downloaded keeps ${record.name}; only the copy in Ether is removed.`,
                confirmLabel: 'Delete',
                danger: true,
            });
            if (!isConfirmed) {
                return false;
            }

            await runAsync(() => client.deleteReceivedAsync(fileRef(record)));

            return true;
        },
        sendAgainAsync: record => runAsync(async () => {
            await client.sendAgainAsync(fileRef(record));
            dialogs.toast(`Sending ${record.name} again.`);
        }),
        retryFailedAsync: (sessionId, batchId) => runAsync(() => client.retryFailedAsync(sessionId, batchId)),
        downloadZipAsync: (fileIds, sessionId) => downloadZipAsync(context, { fileIds, sessionId }),
        pickAgain: () => context.pickFilesToResume(),
        details: record => openFileDetails({ context, actions, record }),
    };

    return actions;
}
