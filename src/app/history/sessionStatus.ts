import { UNFINISHED_STATES } from '../../client/clientTypes.js';
import type { FileRecord, HealthInfo, HealthStatus } from '../../client/clientTypes.js';
import type { DevicePlatform } from '../../core/deviceInfo.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { formatRelative } from '../format.js';
import { ICONS } from '../icons.js';
import type { NearbyStatus } from '../nearby/nearbyController.js';
import { askingText, NEARBY_EMPTY_TEXTS } from '../nearby/nearbySection.js';
import type { PairingFlow } from '../pairing/pairingFlow.js';
import { isStoppedFile } from '../transfers/fileStatus.js';
import { createSessionMenu } from './sessionMenu.js';

// The peer bar on top of a session (§4.5, D8): one compact row on every layout, across the full width.
// Connected: the peer's avatar, name and platform, "● Connected · 12 ms" (or Weak), the Check BXWU chip (SP-02)
// and ⋯ (Disconnect, Clear sent…, Clear received…, Reset this device…). Lost or ended, the bar turns red with
// "Connection lost · 2 paused" (HC-05, HC-06). Not connected, it offers Reconnect while nearby search can run,
// which asks that device when it is listed or waits for it to show up nearby, and Use a code, which opens
// "Pair with a code". A line says when the device isn't nearby, or why nearby search can't find it.
// The nearby part is changed in place, since presence repeats about every half minute.

// 'ended': the peer closed Ether and said bye (HC-06); 'lost': the link dropped without one.
export type SessionLinkState = 'connected' | 'lost' | 'ended' | 'offline';

const LINK_END_STATES: readonly SessionLinkState[] = ['lost', 'ended'];

export interface SessionStatus {
    readonly element: HTMLElement;
    dispose(): void;
}

const HEALTH_TEXT: Readonly<Record<HealthStatus, string>> = Object.freeze({
    good: 'Connected',
    weak: 'Weak',
    lost: 'Lost',
});

const NAME_LENGTH = 32;
// Reconnect and Use a code sit beside it, so the line says only how to make the device show up.
export const NOT_NEARBY_TEXT = 'Not nearby right now. Open Ether on it on the same Wi‑Fi.';

// Why Reconnect isn't offered, in Home's words; Use a code sits beside it.
const NEARBY_LINES: Readonly<Partial<Record<NearbyStatus, string>>> = Object.freeze({
    disabled: NEARBY_EMPTY_TEXTS.off[0],
    offline: NEARBY_EMPTY_TEXTS.offline[0],
});

// Reconnect waiting for the device to appear among nearby devices; the request goes out once it does.
export function showUpText(name: string): string {
    return `Waiting for ${name} to show up nearby…`;
}

// SP-02: what the check code is for, shown when the chip is tapped and read with it.
export function checkHint(code: string): string {
    return `Both screens must show ${code}. If not, disconnect.`;
}

// "Connected · 12 ms", "Weak · 42 ms" or "Lost", and " · other screen off" while the peer's page is hidden.
export function healthLabel(health: HealthInfo | undefined): string {
    if (health == null) {
        return 'Connected';
    }

    const rtt = health.rttMs == null || health.status === 'lost' ? '' : ` · ${Math.round(health.rttMs)} ms`;
    const hidden = health.peerHidden ? ' · other screen off' : '';

    return `${HEALTH_TEXT[health.status]}${rtt}${hidden}`;
}

const PLATFORM_ICONS: Readonly<Partial<Record<DevicePlatform, string>>> = Object.freeze({
    iPad: ICONS.tablet,
    Tablet: ICONS.tablet,
    Windows: ICONS.desktop,
    Mac: ICONS.desktop,
    Linux: ICONS.desktop,
    ChromeOS: ICONS.desktop,
    Computer: ICONS.desktop,
    Android: ICONS.phone,
    iPhone: ICONS.phone,
    Phone: ICONS.phone,
});

// The icon of a platform's kind of device: phone, tablet or computer.
export function platformIcon(platform: DevicePlatform | undefined): string | undefined {
    return platform == null ? undefined : PLATFORM_ICONS[platform];
}

// The peer's avatar: its kind of device when it said its platform, otherwise the first letter of its name.
export function peerAvatar(name: string, platform: DevicePlatform | undefined): HTMLElement {
    const icon = platformIcon(platform);

    const hidden = { 'aria-hidden': 'true' };

    return icon == null
        ? h('span', { class: 'peer-avatar', text: [...name][0]?.toUpperCase() ?? '?', attrs: hidden })
        : h('span', { class: 'peer-avatar', html: icon, attrs: hidden });
}

function replaceWith(element: HTMLElement, children: ReadonlyArray<Node | null>): void {
    element.replaceChildren(...children.filter((child): child is Node => child != null));
}

// These touch the element only when the value changes, so presence updates leave the bar alone.
function setHidden(element: HTMLElement, isHidden: boolean): void {
    if (element.hidden !== isHidden) {
        element.hidden = isHidden;
    }
}

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
    if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
    }
}

export function createSessionStatus(context: AppContext, flow: PairingFlow, sessionId: string): SessionStatus {
    const { client } = context;
    const element = h('section', { class: 'session-status peer-bar', attrs: { 'aria-label': 'Connection' } });
    const menu = createSessionMenu({ context, sessionId });
    let health: HealthInfo | undefined;
    let linkState: SessionLinkState = 'offline';
    let lastPeerSession: string | undefined = client.peer?.sessionId;
    let lastPlatform: DevicePlatform | undefined = client.peer?.sessionId === sessionId
        ? client.peer.platform
        : undefined;
    let paused: FileRecord[] = [];
    let healthText: HTMLElement | undefined;

    const computeState = (): SessionLinkState => {
        const isThisPeer = client.peer?.sessionId === sessionId || lastPeerSession === sessionId;
        if (client.state === 'connected' && client.peer?.sessionId === sessionId) {
            return 'connected';
        }

        const end = context.lastLinkEnd;
        if (end?.sessionId === sessionId && end.byPeer) {
            return 'ended';
        }

        return client.state === 'lost' && isThisPeer ? 'lost' : 'offline';
    };

    // The peer's names to look for among nearby devices: the name it last used here, and the session's.
    const peerNames = (): string[] => {
        const end = context.lastLinkEnd;
        const lastUsed = end?.sessionId === sessionId ? end.peerName : undefined;

        const names = [lastUsed, context.sessions.find(sessionId)?.peerName];

        return names.filter((name): name is string => name != null);
    };

    // The name Reconnect, its wait and Cancel are announced with.
    const reconnectName = (): string => peerNames()[0] ?? peerName();

    const reconnect = (): void => {
        note.hidden = true;
        context.nearby.reconnect({ sessionId, names: peerNames() });
    };

    // Kept across renders, so the nearby part changes in place.
    const reconnectButton = h('button', {
        class: 'button button-small button-primary',
        dataset: { action: 'reconnect' },
        attrs: { type: 'button', hidden: true },
        children: [h('span', { class: 'button-icon', html: ICONS.retry }), 'Reconnect'],
        on: { click: reconnect },
    });
    const waitingText = h('span');
    const waiting = h('p', {
        class: 'status-waiting',
        attrs: { role: 'status', hidden: true },
        children: [h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), waitingText],
    });
    const cancelButton = h('button', {
        class: 'button button-small',
        text: 'Cancel',
        dataset: { action: 'cancel-reconnect' },
        attrs: { type: 'button', hidden: true },
        on: { click: () => context.nearby.cancelRequest() },
    });
    // "Pair with a code": Show my code, Scan a code or Paste a code; its Back comes back here.
    const codeButton = h('button', {
        class: 'button button-small button-primary',
        dataset: { action: 'use-code' },
        attrs: { type: 'button' },
        children: [h('span', { class: 'button-icon', html: ICONS.qr }), 'Use a code'],
        on: { click: () => flow.openMenu() },
    });
    const pairSide = h('div', {
        class: 'status-side',
        children: [reconnectButton, cancelButton, codeButton],
    });
    const nearbyLine = h('p', { class: 'status-sub status-nearby', attrs: { hidden: true } });
    const note = h('p', { class: 'notice status-note', attrs: { role: 'alert', hidden: true } });

    const isUsable = (target: Element | null): boolean => target instanceof HTMLElement
        && element.contains(target)
        && target.closest('[hidden]') == null
        && !(target instanceof HTMLButtonElement && target.disabled);

    // The line under the state: why Reconnect isn't offered, or that the peer isn't among the devices listed.
    const nearbyLineText = (status: NearbyStatus, isListed: boolean): string => {
        const reason = NEARBY_LINES[status];
        if (reason != null) {
            return reason;
        }

        return status === 'listening' && !isListed ? NOT_NEARBY_TEXT : '';
    };

    // Reconnect while nearby search can run, or Cancel while it waits for the peer to show up or to answer, and a
    // line saying it isn't nearby or why it can't be found; one primary button at a time, so Use a code steps back
    // while Reconnect shows. Focus that was on the bar moves with what replaced its button.
    const updateNearby = (): void => {
        if (linkState === 'connected') {
            return;
        }

        const hadFocus = element.contains(document.activeElement);
        const view = context.nearby.view;
        const { asking, awaited, status } = view;
        const names = peerNames();
        const name = reconnectName();
        const isAskingPeer = asking != null && names.includes(asking.name);
        const isAwaitingPeer = awaited?.sessionId === sessionId;
        const isWaiting = isAskingPeer || isAwaitingPeer;
        // With its PIN, the peer connects without an Accept, so the line says it is connecting.
        const waitingLabel = isAskingPeer ? askingText(view) : (isAwaitingPeer ? showUpText(name) : '');
        setText(waitingText, waitingLabel);
        setHidden(waiting, !isWaiting);
        setHidden(cancelButton, !isWaiting);
        setAttribute(cancelButton, 'aria-label', `Cancel reconnecting to ${name}`);
        const canReconnect = status === 'starting' || status === 'listening';
        setHidden(reconnectButton, !canReconnect || isWaiting);
        setAttribute(reconnectButton, 'aria-label', `Reconnect to ${name}`);
        if (reconnectButton.disabled !== (asking != null)) {
            reconnectButton.disabled = asking != null;
        }

        const isCodeFirst = reconnectButton.hidden && !isWaiting;
        if (codeButton.classList.contains('button-primary') !== isCodeFirst) {
            codeButton.classList.toggle('button-primary', isCodeFirst);
        }

        const lineText = isWaiting ? '' : nearbyLineText(status, context.nearby.deviceNamed(names) != null);
        setText(nearbyLine, lineText);
        setHidden(nearbyLine, lineText === '');
        if (hadFocus && !isUsable(document.activeElement)) {
            [cancelButton, reconnectButton, codeButton].find(isUsable)?.focus();
        }
    };

    const peerName = (): string => context.lastLinkEnd?.peerName
        ?? context.sessions.find(sessionId)?.peerName
        ?? client.peer?.displayName
        ?? 'the other device';

    const nameHeading = (name: string): HTMLElement => h('h1', {
        class: 'peer-name',
        text: context.services.truncateMiddle(name, NAME_LENGTH),
        attrs: { id: 'session-title', tabindex: '-1', title: name },
    });

    // The avatar and the name, with one small line under it: the health, or what happened to the link.
    const peerMain = (name: string, line: HTMLElement): HTMLElement[] => [
        peerAvatar(name, lastPlatform),
        h('div', {
            class: 'peer-text',
            children: [nameHeading(name), line, ...(linkState === 'connected' ? [] : [waiting, nearbyLine])],
        }),
    ];

    // SP-02: the code stays on screen while connected; "Check" hides on narrow phones. The explanation is the
    // chip's tooltip and description, and a tap shows it too, since touch screens have no hover.
    const checkChip = (code: string): HTMLElement => {
        const hint = checkHint(code);

        return h('button', {
            class: 'check-chip',
            dataset: { action: 'check-code' },
            attrs: {
                'type': 'button',
                'title': hint,
                'aria-label': `Check code ${[...code].join(' ')}. ${hint}`,
            },
            children: [
                h('span', { class: 'check-chip-label', text: 'Check' }),
                h('span', { class: 'check-code-value', text: code }),
            ],
            on: { click: () => context.dialogs.toast(hint) },
        });
    };

    const renderConnected = (): void => {
        const peer = client.peer;
        const name = peer?.displayName ?? 'Connected';
        healthText = h('span', { class: 'health-text', text: healthLabel(health) });
        const healthLine = h('p', {
            class: 'peer-health',
            dataset: { health: health?.status ?? 'good' },
            children: [
                h('span', { class: 'health-dot', attrs: { 'aria-hidden': 'true' } }),
                healthText,
                // The peer's platform as a tag, e.g. "iPad"; a peer on an older build sends none.
                peer?.platform == null ? null : h('span', { class: 'badge peer-platform', text: peer.platform }),
            ],
        });
        replaceWith(element, [
            ...peerMain(name, healthLine),
            h('div', { class: 'status-side', children: peer?.checkCode == null ? [] : [checkChip(peer.checkCode)] }),
            menu,
        ]);
    };

    // HC-05, HC-06: what happened and how many transfers wait for the link, with every paused file in its tooltip.
    const renderLinkEnd = (what: string): void => {
        const names = paused.map(record => record.name);
        const text = names.length === 0 ? what : `${what} · ${names.length.toLocaleString('en')} paused`;
        const line = h('p', {
            class: 'status-sub',
            attrs: { title: names.join(', ') || null },
            children: [h('span', { class: 'health-dot', attrs: { 'aria-hidden': 'true' } }), text],
        });
        replaceWith(element, [...peerMain(peerName(), line), pairSide, menu, note]);
    };

    const renderOffline = (): void => {
        const session = context.sessions.find(sessionId);
        const name = session == null ? 'This device' : context.sessions.displayName(session);
        const line = h('p', {
            class: 'status-sub status-meta',
            text: session == null
                ? 'Not connected'
                : `Not connected · last connected ${formatRelative(session.lastConnectedAt)}`,
        });
        replaceWith(element, [...peerMain(name, line), pairSide, menu, note]);
    };

    const RENDERERS: Readonly<Record<SessionLinkState, () => void>> = {
        connected: renderConnected,
        lost: () => renderLinkEnd('Connection lost'),
        ended: () => renderLinkEnd('Disconnected'),
        offline: renderOffline,
    };

    const render = (): void => {
        linkState = computeState();
        element.dataset.link = linkState;
        RENDERERS[linkState]();
        updateNearby();
    };

    const loadPausedAsync = async (): Promise<void> => {
        // A stopped file waits for Resume, not for the link.
        const unfinished = await client.listFilesAsync({ sessionId, states: UNFINISHED_STATES }).catch(() => []);
        paused = unfinished.filter(record => !isStoppedFile(record));
        if (LINK_END_STATES.includes(linkState)) {
            render();
        }
    };

    const unsubscribers = [
        client.on('state', () => {
            render();
            if (LINK_END_STATES.includes(linkState)) {
                void loadPausedAsync();
            }
        }),
        client.on('peer', (kind, peer) => {
            // A new connection starts without the last one's health.
            if (kind === 'connected') {
                health = undefined;
            }

            lastPeerSession = peer.sessionId;
            if (peer.sessionId === sessionId && peer.platform != null) {
                lastPlatform = peer.platform;
            }

            render();
            if (LINK_END_STATES.includes(linkState)) {
                void loadPausedAsync();
            }
        }),
        client.on('health', next => {
            health = next;
            if (healthText != null && linkState === 'connected') {
                healthText.textContent = healthLabel(next);
                healthText.parentElement?.setAttribute('data-health', next.status);
            }
        }),
        context.sessions.subscribe(() => {
            if (linkState !== 'connected') {
                render();
            }
        }),
        context.nearby.onChange(updateNearby),
        // Notes about this peer, e.g. "Pixel 8 declined.", show on the bar instead of as a toast.
        context.nearby.onNote(next => {
            if (linkState === 'connected' || next.name == null || !peerNames().includes(next.name)) {
                return false;
            }

            note.textContent = next.text;
            note.dataset.tone = next.tone;
            note.hidden = false;

            return true;
        }),
    ];

    render();
    if (LINK_END_STATES.includes(computeState())) {
        void loadPausedAsync();
    }

    return {
        element,
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
    };
}
