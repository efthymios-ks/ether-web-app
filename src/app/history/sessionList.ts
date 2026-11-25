import type { SessionSummary } from '../../client/clientTypes.js';
import type { NearbyDevice } from '../../discovery/discoveryTypes.js';
import type { AppContext } from '../appContext.js';
import type { ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { formatRelative } from '../format.js';
import { ICONS } from '../icons.js';
import type { PairingFlow } from '../pairing/pairingFlow.js';
import { describeClientError } from '../transfers/fileActions.js';
import { syncChildren } from '../transfers/syncChildren.js';
import { platformIcon } from './sessionStatus.js';

// UI plan §4.8, §7.6: the Previous sessions drawer, opened from the clock button in the header.
// One row per paired device, last connected first: its name, its platform and when it was last connected, and the
// Nearby and "N unfinished" tags. A tap connects through nearby when the device is listed there, and Ether then
// offers to restore its session; otherwise a sheet says it isn't nearby and offers Pair with a code, or its files.
// The bin clears that session on this device. Rows are kept and changed in place while the drawer is open,
// so presence and file events never replace a row under a finger.

export interface SessionsDrawerOptions {
    readonly context: AppContext;
    readonly flow: PairingFlow;
    // Follows the drawer opening and closing, e.g. for the header button's aria-expanded.
    readonly onOpenChange?: (isOpen: boolean) => void;
}

export interface SessionsDrawer {
    readonly isOpen: boolean;
    // The drawer's own element, kept between openings.
    readonly element: HTMLElement;
    open(): void;
    close(): void;
    dispose(): void;
}

interface Row {
    readonly element: HTMLLIElement;
    readonly open: HTMLButtonElement;
    readonly avatar: HTMLElement;
    readonly name: HTMLElement;
    readonly meta: HTMLElement;
    readonly nearbyTag: HTMLElement;
    readonly unfinishedTag: HTMLElement;
    readonly clear: HTMLButtonElement;
    // The platform icon or the letter the avatar was drawn with.
    avatarKey: string;
}

const DRAWER_LEAD = 'Connect to one of these devices and Ether offers to restore its session.';
export const NOT_NEARBY_HINT = 'Open Ether on it on the same Wi‑Fi and it shows up on Home, or pair with a code.';

// Touches the DOM only when the value changes, so repeated presence and file events leave the rows alone.
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

function setAttribute(element: HTMLElement, name: string, value: string): void {
    if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
    }
}

export function createSessionsDrawer(options: SessionsDrawerOptions): SessionsDrawer {
    const { context, flow } = options;
    const { client, dialogs } = context;
    const rows = new Map<string, Row>();
    const list = h('ul', { class: 'sessions-list', attrs: { role: 'list' } });
    const empty = h('p', { class: 'empty-note', text: 'No previous sessions.', attrs: { hidden: true } });
    const closeButton = h('button', {
        class: 'icon-button sessions-close',
        html: ICONS.close,
        dataset: { action: 'close-drawer' },
        attrs: { 'type': 'button', 'aria-label': 'Close' },
        on: { click: () => close() },
    });
    const element = h('div', {
        class: 'sessions-drawer',
        children: [closeButton, h('p', { class: 'sessions-lead', text: DRAWER_LEAD }), list, empty],
    });
    let handle: ModalHandle | undefined;

    // The live session: connected now, or its link just dropped.
    const isLive = (sessionId: string): boolean => client.peer?.sessionId === sessionId
        && (client.state === 'connected' || client.state === 'lost');

    const nearbyDevice = (session: SessionSummary): NearbyDevice | undefined =>
        context.nearby.deviceNamed([session.peerName]);

    // "Android · Last connected Yesterday 20:07"; a peer that never said its platform shows the time alone.
    const metaText = (session: SessionSummary): string => {
        const when = isLive(session.sessionId)
            ? (client.state === 'connected' ? 'Connected now' : 'Connection lost')
            : `Last connected ${formatRelative(session.lastConnectedAt)}`;

        return session.peerPlatform == null ? when : `${session.peerPlatform} · ${when}`;
    };

    const createRow = (sessionId: string): Row => {
        const avatar = h('span', { class: 'session-avatar', attrs: { 'aria-hidden': 'true' } });
        const name = h('span', { class: 'session-name' });
        const meta = h('span', { class: 'session-meta' });
        const nearbyTag = h('span', {
            class: 'badge',
            text: 'Nearby',
            dataset: { tone: 'ok' },
            attrs: { hidden: true },
        });
        const unfinishedTag = h('span', { class: 'badge', dataset: { tone: 'warn' }, attrs: { hidden: true } });
        const open = h('button', {
            class: 'session-open',
            dataset: { action: 'open-session', sessionId },
            attrs: { type: 'button' },
            children: [
                avatar,
                h('span', {
                    class: 'session-text',
                    children: [name, meta, h('span', { class: 'session-tags', children: [nearbyTag, unfinishedTag] })],
                }),
            ],
            on: { click: () => void openSessionAsync(sessionId) },
        });
        const clear = h('button', {
            class: 'icon-button session-clear',
            html: ICONS.trash,
            dataset: { action: 'clear-session', sessionId },
            attrs: { type: 'button' },
            on: { click: () => void clearSessionAsync(sessionId) },
        });

        return {
            element: h('li', { class: 'session-row', dataset: { sessionId }, children: [open, clear] }),
            open,
            avatar,
            name,
            meta,
            nearbyTag,
            unfinishedTag,
            clear,
            avatarKey: '',
        };
    };

    // The kind of device when the peer said its platform, otherwise the first letter of its name.
    const updateAvatar = (row: Row, session: SessionSummary, displayName: string): void => {
        const icon = platformIcon(session.peerPlatform);
        const letter = [...displayName][0]?.toUpperCase() ?? '?';
        const key = icon == null ? `letter:${letter}` : `platform:${session.peerPlatform ?? ''}`;
        if (row.avatarKey === key) {
            return;
        }

        row.avatarKey = key;
        if (icon == null) {
            row.avatar.textContent = letter;
        } else {
            row.avatar.innerHTML = icon;
        }
    };

    const updateRow = (row: Row, session: SessionSummary): void => {
        const displayName = context.sessions.displayName(session);
        const isNearby = !isLive(session.sessionId) && nearbyDevice(session) != null;
        updateAvatar(row, session, displayName);
        setText(row.name, displayName);
        setAttribute(row.name, 'title', displayName);
        setText(row.meta, metaText(session));
        setHidden(row.nearbyTag, !isNearby);
        setText(row.unfinishedTag, `${session.unfinishedCount.toLocaleString('en')} unfinished`);
        setHidden(row.unfinishedTag, session.unfinishedCount === 0);
        setAttribute(row.clear, 'aria-label', `Clear session with ${displayName}`);
        // The client refuses to clear the session it is connected to; Reset this device on its screen does that.
        if (row.clear.disabled !== session.connected) {
            row.clear.disabled = session.connected;
        }

        row.element.dataset.live = String(isLive(session.sessionId));
    };

    const render = (): void => {
        if (handle == null) {
            return;
        }

        const sessions = context.sessions.sessions;
        const focused = document.activeElement;
        const focusedIndex = [...rows.values()].findIndex(row => row.element.contains(focused));
        for (const sessionId of [...rows.keys()]) {
            if (!sessions.some(session => session.sessionId === sessionId)) {
                rows.delete(sessionId);
            }
        }

        const ordered = sessions.map(session => {
            const row = rows.get(session.sessionId) ?? createRow(session.sessionId);
            rows.set(session.sessionId, row);
            updateRow(row, session);

            return row;
        });
        syncChildren(list, ordered.map(row => row.element));
        setHidden(list, ordered.length === 0);
        setHidden(empty, ordered.length > 0 || !context.sessions.isLoaded);
        // A cleared row took focus with it: the next row, or the close button, gets it.
        const isFocusLost = focusedIndex >= 0 && focused instanceof HTMLElement && !focused.isConnected;
        if (isFocusLost) {
            const next = ordered[Math.min(focusedIndex, ordered.length - 1)];
            (next?.open ?? closeButton).focus();
        }
    };

    const close = (): void => {
        const current = handle;
        handle = undefined;
        current?.close();
        options.onOpenChange?.(false);
    };

    const notNearbyAsync = async (session: SessionSummary): Promise<void> => {
        const name = context.sessions.displayName(session);
        const peer = client.peer;
        const isConnectedElsewhere = client.state === 'connected' && peer != null;
        const choice = await dialogs.chooseAsync(isConnectedElsewhere
            ? {
                title: `Connected to ${peer.displayName}`,
                message: `Disconnect from ${peer.displayName} to connect to ${name}.`,
                choices: [
                    { id: 'files', label: 'See files' },
                    { id: 'close', label: 'OK', tone: 'primary' },
                ],
            }
            : {
                title: `${name} isn’t nearby`,
                message: NOT_NEARBY_HINT,
                choices: [
                    { id: 'close', label: 'Close' },
                    { id: 'files', label: 'See files' },
                    { id: 'code', label: 'Pair with a code', tone: 'primary' },
                ],
            });
        if (choice === 'files') {
            close();
            context.navigate({ name: 'session', sessionId: session.sessionId });

            return;
        }

        if (choice === 'code') {
            close();
            flow.openMenu();
        }
    };

    const openSessionAsync = async (sessionId: string): Promise<void> => {
        const session = context.sessions.find(sessionId);
        if (session == null) {
            return;
        }

        if (isLive(sessionId)) {
            close();
            context.navigate({ name: 'session', sessionId });

            return;
        }

        const device = client.state === 'connected' ? undefined : nearbyDevice(session);
        if (device == null) {
            await notNearbyAsync(session);

            return;
        }

        // Home shows the request waiting for that device's answer, with Cancel.
        close();
        context.navigate({ name: 'home' });
        await context.nearby.connectAsync(device.nearbyId);
    };

    const clearSessionAsync = async (sessionId: string): Promise<void> => {
        const session = context.sessions.find(sessionId);
        if (session == null) {
            return;
        }

        const name = context.sessions.displayName(session);
        const isConfirmed = await dialogs.confirmAsync({
            title: `Clear session with ${name}?`,
            message: 'Its history and unfinished files on this device go. Downloaded ZIPs keep their copies.',
            confirmLabel: 'Clear',
            danger: true,
        });
        if (!isConfirmed) {
            return;
        }

        try {
            await context.sessions.clearAsync(sessionId);
            context.logger.info('store', 'session cleared from the drawer');
            dialogs.toast(`Cleared ${name}.`, { tone: 'ok' });
            if (context.route.name === 'session' && context.route.sessionId === sessionId) {
                context.navigate({ name: 'home' });
            }
        } catch (error) {
            dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    };

    const unsubscribers = [
        context.sessions.subscribe(render),
        context.nearby.onChange(render),
        client.on('state', render),
        client.on('peer', render),
    ];

    return {
        get isOpen() {
            return handle != null;
        },
        element,
        open: () => {
            if (handle != null) {
                return;
            }

            handle = dialogs.openModal({
                title: 'Previous sessions',
                content: element,
                variant: 'drawer',
                onDismiss: () => {
                    handle = undefined;
                    options.onOpenChange?.(false);
                },
                initialFocus: closeButton,
            });
            options.onOpenChange?.(true);
            render();
            context.sessions.refreshSoon();
        },
        close,
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            close();
        },
    };
}
