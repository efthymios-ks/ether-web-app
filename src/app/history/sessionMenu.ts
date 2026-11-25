import type { ClearScope, ClearSummary } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { formatCount, formatSize } from '../format.js';
import { ICONS } from '../icons.js';
import { describeClientError } from '../transfers/fileActions.js';
import { peerNameFor } from '../transfers/fileErrors.js';

// §7.6: the peer bar's ⋯ (More actions): Disconnect while connected, then Clear sent…, Clear received… and
// Reset this device…, each confirmed with the client's counts. Only this session's files go; the peer stays
// paired, and the 'session-cleared' event makes the screen reload what it shows.

export interface SessionMenuOptions {
    readonly context: AppContext;
    readonly sessionId: string;
}

export interface ClearPlan {
    readonly title: string;
    readonly message: string;
    readonly confirmLabel: string;
    // The "Also cancel and clear…" checkbox, when there are transfers in progress to opt into.
    readonly unfinishedOption?: string;
    // Whether the transfers in progress go without asking: always for Reset, and when nothing else is left.
    readonly includesUnfinished: boolean;
}

const MENU_LABELS: Readonly<Record<ClearScope, string>> = Object.freeze({
    sent: 'Clear sent…',
    received: 'Clear received…',
    all: 'Reset this device…',
});

const SCOPES: readonly ClearScope[] = Object.freeze(['sent', 'received', 'all']);

function hasAnything(summary: ClearSummary): boolean {
    return summary.finished + summary.unfinished > 0;
}

function notDownloadedText(summary: ClearSummary): string {
    if (summary.notDownloaded <= 0) {
        return '';
    }

    const count = summary.notDownloaded.toLocaleString('en');

    return summary.notDownloaded === 1 ? `${count} hasn’t been downloaded yet.` : `${count} haven’t been downloaded yet.`;
}

function inProgressText(count: number): string {
    return `the ${formatCount(count, 'transfer')} in progress`;
}

// The confirmation for one scope, e.g. "Clear 120 received files (1.2 GB)?" "8 haven't been downloaded yet."
export function clearPlan(scope: ClearScope, summary: ClearSummary, peerName: string): ClearPlan {
    if (scope === 'all') {
        const cancels = summary.unfinished > 0 ? ` and cancels ${inProgressText(summary.unfinished)}` : '';

        return {
            title: `Reset this device for ${peerName}?`,
            message: [
                `Clears ${formatCount(summary.finished, 'sent and received file', 'sent and received files')} (${formatSize(summary.bytes)})${cancels}.`,
                notDownloadedText(summary),
                `${peerName} stays paired; you can send again right away.`,
            ].filter(part => part !== '').join(' '),
            confirmLabel: 'Reset',
            includesUnfinished: true,
        };
    }

    const noun = scope === 'sent' ? 'sent file' : 'received file';
    const keeps = scope === 'sent' ? `${peerName} keeps what it received.` : 'Downloaded ZIPs keep their copies.';
    if (summary.finished === 0) {
        return {
            title: `Cancel and clear ${inProgressText(summary.unfinished)}?`,
            message: `They stop now and leave this device. ${peerName} stays paired.`,
            confirmLabel: 'Clear',
            includesUnfinished: true,
        };
    }

    return {
        title: `Clear ${formatCount(summary.finished, noun)} (${formatSize(summary.bytes)})?`,
        message: [notDownloadedText(summary), keeps].filter(part => part !== '').join(' '),
        confirmLabel: 'Clear',
        unfinishedOption: summary.unfinished > 0 ? `Also cancel and clear ${inProgressText(summary.unfinished)}` : undefined,
        includesUnfinished: false,
    };
}

export function createSessionMenu(options: SessionMenuOptions): HTMLButtonElement {
    const { context, sessionId } = options;
    const button = h('button', {
        class: 'icon-button session-menu',
        html: ICONS.more,
        dataset: { action: 'session-menu' },
        attrs: { 'type': 'button', 'aria-label': 'More actions', 'aria-haspopup': 'dialog', 'data-tooltip': 'More actions' },
    });

    const confirmAsync = async (scope: ClearScope, summary: ClearSummary): Promise<void> => {
        const plan = clearPlan(scope, summary, peerNameFor(context, sessionId));
        const checkbox = h('input', { class: 'clear-unfinished-box', attrs: { type: 'checkbox' } });
        const choice = await context.dialogs.chooseAsync({
            title: plan.title,
            message: plan.message,
            body: plan.unfinishedOption == null
                ? undefined
                : h('label', { class: 'check-row clear-unfinished', children: [checkbox, h('span', { text: plan.unfinishedOption })] }),
            choices: [
                { id: 'cancel', label: 'Cancel' },
                { id: 'confirm', label: plan.confirmLabel, tone: 'danger' },
            ],
        });
        if (choice !== 'confirm') {
            return;
        }

        try {
            const includeUnfinished = plan.includesUnfinished || checkbox.checked;
            const { removed } = await context.client.clearSessionFilesAsync(sessionId, { scope, includeUnfinished });
            context.logger.info('store', 'session files cleared', { scope, includeUnfinished, removed });
            context.dialogs.toast(`Cleared ${formatCount(removed, 'file')}.`, { tone: 'ok' });
        } catch (error) {
            context.dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    };

    const disconnectAsync = async (): Promise<void> => {
        const isConfirmed = await context.dialogs.confirmAsync({
            title: 'Disconnect?',
            message: 'Running transfers pause. Pair again later and they resume where they stopped.',
            confirmLabel: 'Disconnect',
        });
        if (isConfirmed) {
            await context.client.disconnectAsync().catch(() => undefined);
        }
    };

    // A guard instead of disabling the button, so focus can come back to it when the dialogs close.
    let isOpen = false;

    const openAsync = async (): Promise<void> => {
        if (isOpen) {
            return;
        }

        isOpen = true;
        try {
            const summaries = await Promise.all(SCOPES.map(scope => context.client.getClearSummaryAsync(sessionId, scope)
                .catch(() => ({ finished: 0, unfinished: 0, notDownloaded: 0, bytes: 0 }))));
            const available = SCOPES.filter((_, index) => {
                const summary = summaries[index];

                return summary != null && hasAnything(summary);
            });
            const peerName = peerNameFor(context, sessionId);
            const isConnected = context.client.state === 'connected' && context.client.peer?.sessionId === sessionId;
            const choice = await context.dialogs.chooseAsync({
                title: peerName,
                message: available.length === 0 ? `Nothing to clear with ${peerName} yet.` : undefined,
                choices: [
                    ...(isConnected ? [{ id: 'disconnect', label: 'Disconnect', icon: ICONS.disconnect }] : []),
                    ...available.map(scope => ({
                        id: scope,
                        label: MENU_LABELS[scope],
                        tone: scope === 'all' ? 'danger' as const : 'default' as const,
                        icon: ICONS.trash,
                    })),
                ],
                asMenu: true,
            });
            if (choice === 'disconnect') {
                await disconnectAsync();

                return;
            }

            const index = SCOPES.findIndex(scope => scope === choice);
            const summary = summaries[index];
            if (index >= 0 && summary != null) {
                await confirmAsync(SCOPES[index] as ClearScope, summary);
            }
        } finally {
            isOpen = false;
        }
    };

    button.addEventListener('click', () => {
        void openAsync();
    });

    return button;
}
