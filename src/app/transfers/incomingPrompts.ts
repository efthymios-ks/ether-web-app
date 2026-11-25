import type { BatchIncoming, FileRecord } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import type { ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { formatCount, formatSize } from '../format.js';
import { peerAvatar } from '../history/sessionStatus.js';
import { describeClientError } from './fileActions.js';
import { fileRef } from './fileRef.js';
import type { PendingBatch } from './transferTracker.js';

// BK-03, SP-07, D7: the receive dialog, wherever the app is: "Pixel 8 wants to send you 24 items",
// "186 MB · Free: 21 GB", with Decline and Accept. When the batch is bigger than the free space:
// Decline, Accept what fits (N) and Accept all. Files offered one by one under Ask before receiving get the same
// dialog. Nothing arrives without Accept: Decline, Escape and the backdrop all say no. One dialog at a time,
// for the connected session only; the link ending closes it, since the answer goes over the link.

export interface IncomingPromptsOptions {
    readonly context: AppContext;
}

export interface IncomingPrompts {
    dispose(): void;
}

type BatchAnswer = 'all' | 'fits' | 'decline';

export interface ReceivePrompt {
    readonly title: string;
    readonly message: string;
    readonly answers: ReadonlyArray<ReceiveAnswer>;
}

interface ReceiveAnswer {
    readonly id: BatchAnswer;
    readonly label: string;
    readonly isPrimary: boolean;
}

// The words and the choices for a batch: "Accept what fits" only when part of it fits and part doesn't.
function receivePrompt(batch: BatchIncoming): ReceivePrompt {
    const free = batch.freeBytes == null ? '' : ` · Free: ${formatSize(batch.freeBytes)}`;
    const canFit = batch.spaceIsShort && batch.fitsCount > 0 && batch.fitsCount < batch.itemCount;
    const isTooBig = batch.spaceIsShort && batch.fitsCount < batch.itemCount;
    const shortfall = batch.fitsCount === 0 ? ' None of it fits.' : ' Not everything fits.';
    const fitsCount = batch.fitsCount.toLocaleString('en');

    return {
        title: `${batch.peerName} wants to send you ${formatCount(batch.itemCount, 'item')}`,
        message: `${formatSize(batch.totalBytes)}${free}.${isTooBig ? shortfall : ''}`,
        answers: [
            { id: 'decline', label: 'Decline', isPrimary: false },
            ...(canFit
                ? [{ id: 'fits' as const, label: `Accept what fits (${fitsCount})`, isPrimary: false }]
                : []),
            { id: 'all', label: isTooBig ? 'Accept all' : 'Accept', isPrimary: true },
        ],
    };
}

// Files offered one by one: "Pixel 8 wants to send you contract.pdf", or "… 3 files", with their size.
function waitingPrompt(
    peerName: string,
    records: readonly FileRecord[],
): Pick<ReceivePrompt, 'title' | 'message'> {
    const first = records[0];
    const bytes = records.reduce((sum, record) => sum + record.size, 0);

    return {
        title: records.length === 1 && first != null
            ? `${peerName} wants to send you ${first.name}`
            : `${peerName} wants to send you ${formatCount(records.length, 'file')}`,
        message: formatSize(bytes),
    };
}

interface OpenPrompt {
    readonly kind: 'batch' | 'files';
    readonly batchId?: string;
    readonly handle: ModalHandle;
    refresh?(): void;
}

export function createIncomingPrompts(options: IncomingPromptsOptions): IncomingPrompts {
    const { context } = options;
    const { client, tracker } = context;
    const waiting = new Map<string, FileRecord>();
    let open: OpenPrompt | undefined;

    const connectedSession = (): string | undefined =>
        (client.state === 'connected' ? client.peer?.sessionId : undefined);

    const peerName = (): string => client.peer?.displayName ?? 'The other device';

    // After Accept, the Send tab shows the files arriving.
    const showProgress = (sessionId: string): void => {
        context.navigate({ name: 'session', sessionId, tab: 'send' });
    };

    const closeOpen = (): void => {
        const shown = open;
        open = undefined;
        shown?.handle.close();
    };

    const dialogBody = (message: HTMLElement, buttons: readonly HTMLButtonElement[]): HTMLElement => h('div', {
        class: 'dialog-body',
        children: [message, h('div', { class: 'dialog-actions', dataset: { layout: 'row' }, children: buttons })],
    });

    const answerBatchAsync = async (batch: PendingBatch, answer: BatchAnswer): Promise<void> => {
        tracker.resolveBatch(batch.sessionId, batch.batchId);
        try {
            if (answer === 'decline') {
                await client.declineBatchAsync(batch.batchId);
                context.dialogs.toast(`Declined ${formatCount(batch.itemCount, 'item')} from ${batch.peerName}.`);

                return;
            }

            await client.acceptBatchAsync(batch.batchId, { mode: answer });
            if (answer === 'fits') {
                const fitting = formatCount(batch.fitsCount, 'item');
                context.dialogs.toast(`Receiving the ${fitting} that fit. The rest are skipped.`);
            } else if (batch.spaceIsShort && batch.fitsCount < batch.itemCount) {
                context.dialogs.toast(
                    `Receiving all ${formatCount(batch.itemCount, 'item')}. Free up space before it runs out.`,
                    { tone: 'warn' },
                );
            }

            showProgress(batch.sessionId);
        } catch (error) {
            context.dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    };

    const openBatch = (batch: PendingBatch): void => {
        const prompt = receivePrompt(batch);
        const choose = (answer: BatchAnswer): void => {
            closeOpen();
            void answerBatchAsync(batch, answer).finally(next);
        };
        const buttons = prompt.answers.map(answer => h('button', {
            class: answer.isPrimary ? 'button button-primary' : 'button',
            text: answer.label,
            dataset: { answer: answer.id },
            attrs: { type: 'button' },
            on: { click: () => choose(answer.id) },
        }));
        const handle = context.dialogs.openModal({
            title: prompt.title,
            icon: peerAvatar(batch.peerName, client.peer?.platform),
            content: dialogBody(h('p', { class: 'dialog-message', text: prompt.message }), buttons),
            // Answered once the dialog has closed, so the next prompt can't open under the closing one.
            onDismiss: () => {
                open = undefined;
                queueMicrotask(() => void answerBatchAsync(batch, 'decline').finally(next));
            },
            initialFocus: buttons.at(-1),
        });
        handle.element.dataset.prompt = 'receive';
        open = { kind: 'batch', batchId: batch.batchId, handle };
    };

    const answerFilesAsync = async (isAccepted: boolean): Promise<void> => {
        const records = [...waiting.values()];
        waiting.clear();
        for (const record of records) {
            const ref = fileRef(record);
            await (isAccepted ? client.acceptIncomingAsync(ref) : client.rejectIncomingAsync(ref, 'declined'))
                .catch(error => context.dialogs.toast(describeClientError(error), { tone: 'fail' }));
        }

        if (!isAccepted) {
            context.dialogs.toast(records.length === 1 && records[0] != null
                ? `Declined ${records[0].name}.`
                : `Declined ${formatCount(records.length, 'file')}.`);

            return;
        }

        const sessionId = records[0]?.sessionId;
        if (sessionId != null) {
            showProgress(sessionId);
        }
    };

    const openFiles = (): void => {
        const message = h('p', { class: 'dialog-message' });
        const choose = (isAccepted: boolean): void => {
            closeOpen();
            void answerFilesAsync(isAccepted).finally(next);
        };
        const answerButton = (answer: string, label: string, isAccepted: boolean): HTMLButtonElement => h('button', {
            class: isAccepted ? 'button button-primary' : 'button',
            text: label,
            dataset: { answer },
            attrs: { type: 'button' },
            on: { click: () => choose(isAccepted) },
        });
        const buttons = [answerButton('decline', 'Decline', false), answerButton('all', 'Accept', true)];
        const name = peerName();
        const texts = waitingPrompt(name, [...waiting.values()]);
        const handle = context.dialogs.openModal({
            title: texts.title,
            icon: peerAvatar(name, client.peer?.platform),
            content: dialogBody(message, buttons),
            onDismiss: () => {
                open = undefined;
                queueMicrotask(() => void answerFilesAsync(false).finally(next));
            },
            initialFocus: buttons[1],
        });
        handle.element.dataset.prompt = 'receive';
        // More files can arrive while it is open: the words change in place, the buttons stay.
        const refresh = (): void => {
            const now = waitingPrompt(peerName(), [...waiting.values()]);
            const title = handle.element.querySelector('.dialog-title');
            if (title != null && title.textContent !== now.title) {
                title.textContent = now.title;
            }

            if (message.textContent !== now.message) {
                message.textContent = now.message;
            }
        };
        refresh();
        open = { kind: 'files', handle, refresh };
    };

    // Closes what no longer waits for an answer, and opens the next prompt when none is open.
    function next(): void {
        const sessionId = connectedSession();
        const batches = sessionId == null ? [] : tracker.pendingBatchesFor(sessionId);
        if (open?.kind === 'batch' && !batches.some(batch => batch.batchId === open?.batchId)) {
            closeOpen();
        }

        if (open?.kind === 'files') {
            if (waiting.size === 0 || sessionId == null) {
                closeOpen();
            } else {
                open.refresh?.();
            }
        }

        if (open != null || sessionId == null) {
            return;
        }

        const batch = batches[0];
        if (batch != null) {
            openBatch(batch);

            return;
        }

        if (waiting.size > 0) {
            openFiles();
        }
    }

    const loadWaitingAsync = async (): Promise<void> => {
        const sessionId = connectedSession();
        if (sessionId == null) {
            return;
        }

        const records = await client.listFilesAsync({ sessionId, direction: 'in', states: ['incoming'] })
            .catch(() => []);
        for (const record of records) {
            waiting.set(record.fileId, record);
        }

        next();
    };

    const unsubscribers = [
        tracker.onBatchesChange(next),
        tracker.onChange(change => {
            const sessionId = connectedSession();
            let isChanged = false;
            for (const record of change.records) {
                if (record.sessionId !== sessionId || record.direction !== 'in') {
                    continue;
                }

                if (record.state === 'incoming' && !waiting.has(record.fileId)) {
                    waiting.set(record.fileId, record);
                    isChanged = true;
                }

                if (record.state !== 'incoming' && waiting.delete(record.fileId)) {
                    isChanged = true;
                }
            }

            if (isChanged) {
                next();
            }
        }),
        client.on('state', state => {
            if (state !== 'connected') {
                waiting.clear();
                next();

                return;
            }

            void loadWaitingAsync();
        }),
        // Cleared received files may include the ones waiting here; the store says which are left.
        client.on('session-cleared', (clearedId, scope) => {
            if (clearedId === connectedSession() && scope !== 'sent') {
                waiting.clear();
                void loadWaitingAsync();
            }
        }),
    ];

    void loadWaitingAsync();

    return {
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            closeOpen();
        },
    };
}
