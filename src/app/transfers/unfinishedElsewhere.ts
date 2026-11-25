import type { UnfinishedElsewhere } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { formatCount, formatSize } from '../format.js';
import { describeClientError } from './fileActions.js';

// Unfinished files of other paired devices can be sent to the one connected now, e.g. after a phone was replaced.
// One card per connection: Send to <peer>, or Not now until the next connection.

export interface UnfinishedElsewhereCardOptions {
    readonly context: AppContext;
    readonly sessionId: string;
}

export interface UnfinishedElsewhereCard {
    readonly element: HTMLElement;
    dispose(): void;
}

export function unfinishedElsewhereText(groups: readonly UnfinishedElsewhere[], peerName: string): string {
    const fileCount = groups.reduce((total, group) => total + group.fileCount, 0);
    const totalBytes = groups.reduce((total, group) => total + group.totalBytes, 0);
    const source = groups.length === 1 ? groups[0]?.peerName ?? 'another device' : `${groups.length} other devices`;

    return `${formatCount(fileCount, 'unfinished file')} from ${source} (${formatSize(totalBytes)}). Send them to ${peerName}?`;
}

export function sentSummaryText(result: { readonly queued: number; readonly needsFile: number }): string {
    const parts = [`${result.queued.toLocaleString('en')} sent`];
    if (result.needsFile > 0) {
        parts.push(`${result.needsFile.toLocaleString('en')} to pick again`);
    }

    return parts.join(', ');
}

export function createUnfinishedElsewhereCard(options: UnfinishedElsewhereCardOptions): UnfinishedElsewhereCard {
    const { context, sessionId } = options;
    const { client } = context;
    const element = h('div', { class: 'unfinished-elsewhere', attrs: { hidden: true } });
    const dismissedConnections = new Set<string>();
    let groups: UnfinishedElsewhere[] = [];
    let isSending = false;

    const connectionId = (): string | undefined => (client.state === 'connected' && client.peer?.sessionId === sessionId
        ? client.peer.connectionId
        : undefined);

    const sendAsync = async (button: HTMLButtonElement): Promise<void> => {
        if (isSending) {
            return;
        }

        isSending = true;
        button.disabled = true;
        try {
            const result = await client.sendUnfinishedHereAsync(groups.map(group => group.sessionId));
            context.dialogs.toast(sentSummaryText(result), { tone: 'ok' });
            groups = [];
            context.notifyDataChanged();
        } catch (error) {
            context.dialogs.toast(describeClientError(error), { tone: 'fail' });
        } finally {
            isSending = false;
            render();
        }
    };

    const render = (): void => {
        const current = connectionId();
        const peerName = client.peer?.displayName ?? 'this device';
        const visible = groups.filter(group => group.sessionId !== sessionId && group.fileCount > 0);
        if (current == null || dismissedConnections.has(current) || visible.length === 0) {
            element.replaceChildren();
            element.hidden = true;

            return;
        }

        const ready = visible.reduce((total, group) => total + group.readyCount, 0);
        const files = visible.reduce((total, group) => total + group.fileCount, 0);
        const sendButton = h('button', {
            class: 'button button-primary',
            text: `Send to ${peerName}`,
            attrs: { type: 'button' },
            dataset: { action: 'send-unfinished' },
        });
        sendButton.addEventListener('click', () => {
            void sendAsync(sendButton);
        });
        element.replaceChildren(h('section', {
            class: 'prompt-card card',
            dataset: { tone: 'info' },
            attrs: { 'aria-label': 'Unfinished files from other devices' },
            children: [
                h('p', { class: 'prompt-text', text: unfinishedElsewhereText(visible, peerName) }),
                visible.length > 1
                    ? h('ul', {
                        class: 'unfinished-elsewhere-list',
                        children: visible.map(group => h('li', {
                            text: `${group.peerName}: ${formatCount(group.fileCount, 'file')} (${formatSize(group.totalBytes)})`,
                        })),
                    })
                    : null,
                ready < files
                    ? h('p', {
                        class: 'prompt-note',
                        text: `${formatCount(files - ready, 'file')} must be picked again on this device before it can be sent.`,
                    })
                    : null,
                h('div', {
                    class: 'prompt-actions',
                    children: [
                        h('button', {
                            class: 'button',
                            text: 'Not now',
                            attrs: { type: 'button' },
                            dataset: { action: 'dismiss-unfinished' },
                            on: {
                                click: () => {
                                    dismissedConnections.add(current);
                                    render();
                                },
                            },
                        }),
                        sendButton,
                    ],
                }),
            ],
        }));
        element.hidden = false;
    };

    const loadAsync = async (): Promise<void> => {
        if (connectionId() == null) {
            render();

            return;
        }

        try {
            groups = await client.listUnfinishedElsewhereAsync();
        } catch (error) {
            context.logger.warn('resume', 'could not list unfinished files of other devices', { error });
        }

        render();
    };

    const unsubscribers = [
        client.on('unfinished-elsewhere', next => {
            groups = [...next];
            render();
        }),
        client.on('state', state => {
            if (state === 'connected') {
                void loadAsync();

                return;
            }

            render();
        }),
    ];

    void loadAsync();

    return {
        element,
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
    };
}
