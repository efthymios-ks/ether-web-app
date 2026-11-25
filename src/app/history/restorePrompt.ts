import type { SessionKnown } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import type { ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { formatRelative } from '../format.js';
import { describeClientError } from '../transfers/fileActions.js';
import { peerAvatar } from './sessionStatus.js';

// UI plan §4.6, §6: connecting to a device this one has history with asks whether to restore the session or start
// fresh. The client holds this device's transfers until the answer, and the prompt shows on both devices.
// Start fresh from either side wins: the peer's `session-reset` closes this prompt with a toast. Escape or a tap
// outside keeps the history, as Restore does. The prompt stays open when the link drops: Start fresh still clears
// this device and reaches the peer at the next connection.

export interface RestorePrompt {
    // The session whose prompt is open.
    readonly sessionId: string | undefined;
    dispose(): void;
}

interface OpenPrompt {
    readonly sessionId: string;
    readonly peerName: string;
    readonly handle: ModalHandle;
    readonly summary: HTMLElement;
}

// "Last connected Yesterday 20:07 · 13 received, 8 sent · 3 unfinished resume.", with the unfinished part in bold.
export function restoreSummary(info: SessionKnown, now: number = Date.now()): Array<Node | string> {
    const counts = [
        info.receivedCount > 0 ? `${info.receivedCount.toLocaleString('en')} received` : null,
        info.sentCount > 0 ? `${info.sentCount.toLocaleString('en')} sent` : null,
    ].filter((part): part is string => part != null);
    const parts: Array<Node | string> = [`Last connected ${formatRelative(info.lastConnectedAt, now)}`];
    if (counts.length > 0) {
        parts.push(` · ${counts.join(', ')}`);
    }

    if (info.unfinishedCount > 0) {
        const verb = info.unfinishedCount === 1 ? 'resumes' : 'resume';
        const unfinished = h('strong', { text: `${info.unfinishedCount.toLocaleString('en')} unfinished` });
        parts.push(' · ', unfinished, ` ${verb}`);
    }

    parts.push('.');

    return parts;
}

export function createRestorePrompt(context: AppContext): RestorePrompt {
    const { client, dialogs, logger } = context;
    let current: OpenPrompt | undefined;

    const closeCurrent = (): void => {
        const open = current;
        current = undefined;
        open?.handle.close();
    };

    const answerAsync = async (open: OpenPrompt, choice: 'restore' | 'fresh'): Promise<void> => {
        if (current !== open) {
            return;
        }

        closeCurrent();
        logger.info('app', 'restore prompt answered', { choice });
        try {
            if (choice === 'restore') {
                await client.restoreSessionAsync(open.sessionId);

                return;
            }

            const result = await client.startFreshAsync(open.sessionId);
            dialogs.toast(result.isPeerNotified
                ? 'Started fresh. History cleared on both devices.'
                : `Started fresh. ${open.peerName} clears its copy when you next connect.`, { tone: 'ok' });
        } catch (error) {
            dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    };

    const show = (info: SessionKnown): void => {
        if (current?.sessionId === info.sessionId) {
            current.summary.replaceChildren(...restoreSummary(info));

            return;
        }

        closeCurrent();
        let open: OpenPrompt | undefined;
        const answer = (choice: 'restore' | 'fresh'): void => {
            if (open != null) {
                void answerAsync(open, choice);
            }
        };
        const summary = h('p', { class: 'dialog-message restore-summary', children: restoreSummary(info) });
        const restoreButton = h('button', {
            class: 'button button-primary',
            text: 'Restore',
            dataset: { choice: 'restore' },
            attrs: { type: 'button' },
            on: { click: () => answer('restore') },
        });
        const content = h('div', {
            class: 'dialog-body restore-prompt',
            children: [
                summary,
                h('p', {
                    class: 'restore-note',
                    text: `Start fresh clears your history with ${info.peerName} on both devices.`,
                }),
                h('div', {
                    class: 'dialog-actions',
                    dataset: { layout: 'row' },
                    children: [
                        h('button', {
                            class: 'button',
                            text: 'Start fresh',
                            dataset: { choice: 'fresh' },
                            attrs: { type: 'button' },
                            on: { click: () => answer('fresh') },
                        }),
                        restoreButton,
                    ],
                }),
            ],
        });
        const handle = dialogs.openModal({
            title: `Restore your session with ${info.peerName}?`,
            icon: peerAvatar(info.peerName, client.peer?.platform),
            content,
            onDismiss: () => answer('restore'),
            initialFocus: restoreButton,
        });
        open = { sessionId: info.sessionId, peerName: info.peerName, handle, summary };
        current = open;
    };

    const unsubscribers = [
        client.on('session-known', show),
        client.on('session-reset', reset => {
            const wasOpen = current?.sessionId === reset.sessionId;
            if (wasOpen) {
                closeCurrent();
            }

            if (wasOpen || reset.removed > 0) {
                dialogs.toast(`${reset.peerName} started fresh. Your history with it was cleared.`);
            }
        }),
    ];

    return {
        get sessionId() {
            return current?.sessionId;
        },
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            closeCurrent();
        },
    };
}
