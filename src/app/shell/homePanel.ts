import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { peerAvatar } from '../history/sessionStatus.js';
import { ICONS } from '../icons.js';
import { createNearbySection } from '../nearby/nearbySection.js';
import type { PairingFlow } from '../pairing/pairingFlow.js';
import { openPinSheet } from '../settings/pinSheet.js';
import { openRenameSheet } from '../settings/renameSheet.js';

// Home (§4.2): "You are Swift Perseus | PIN none", centred, where a tap on the name renames this device and a tap
// on the PIN sets it (R10); then the nearby devices and "Can't see it? Pair with a code". While connected, the
// Connected card that opens the session takes their place, and nearby search is paused. On wide screens and
// landscape phones this is the sidebar beside the pane (§4.9). It lives as long as the app, and every part of it
// changes in place.

export interface HomePanelOptions {
    readonly context: AppContext;
    readonly flow: PairingFlow;
    // True while the panel is on screen: Home, or the sidebar beside pairing by code.
    readonly isShown: () => boolean;
}

export interface HomePanel {
    readonly element: HTMLElement;
    // Holds the Home screen's paste message while Home is open.
    readonly messageSlot: HTMLElement;
    // Moves focus to the panel's heading, e.g. on arriving at Home.
    focus(): void;
    dispose(): void;
}

export const PAUSED_TEXT = 'Nearby search is paused while you’re connected. Disconnect to connect to another device.';
const PAIR_WITH_CODE_TEXT = 'Can’t see it? Pair with a code';
const NO_PIN_TEXT = 'none';
const PIN_DOTS = '••••';

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

export function createHomePanel(options: HomePanelOptions): HomePanel {
    const { context, flow } = options;
    const { client, dialogs, logger, tracker } = context;
    const heading = h('h1', {
        class: 'home-heading',
        text: 'Home',
        attrs: { id: 'home-title', tabindex: '-1' },
    });

    const nameValue = h('strong', { class: 'me-value' });
    const pinValue = h('strong', { class: 'me-value' });
    const nameButton = h('button', {
        class: 'me-button',
        dataset: { action: 'rename' },
        attrs: { 'type': 'button', 'aria-haspopup': 'dialog' },
        children: [h('span', { class: 'me-label', text: 'You are' }), nameValue],
        on: { click: () => openRenameSheet({ client, dialogs, logger }) },
    });
    const pinButton = h('button', {
        class: 'me-button',
        dataset: { action: 'set-pin' },
        attrs: { 'type': 'button', 'aria-haspopup': 'dialog' },
        children: [h('span', { class: 'me-label', text: 'PIN' }), pinValue],
        on: { click: () => openPinSheet({ client, dialogs, logger }) },
    });
    const identity = h('section', {
        class: 'me',
        attrs: { 'aria-label': 'This device' },
        children: [
            nameButton,
            h('span', { class: 'me-separator', attrs: { 'aria-hidden': 'true' } }),
            pinButton,
        ],
    });

    const avatarSlot = h('span', { class: 'connected-avatar' });
    const peerName = h('span', { class: 'device-name' });
    const linkTag = h('span', { class: 'badge' });
    const movingTag = h('span', {
        class: 'badge',
        text: 'Transferring',
        dataset: { tone: 'info' },
        attrs: { hidden: true },
    });
    // The tags describe the card for screen readers, after its name says what a tap does.
    const tags = h('span', {
        class: 'device-tags',
        attrs: { id: 'home-connected-tags' },
        children: [linkTag, movingTag],
    });
    const connectedCard = h('button', {
        class: 'device-card connected-card',
        dataset: { action: 'open-session' },
        attrs: { 'type': 'button', 'aria-describedby': 'home-connected-tags' },
        children: [
            avatarSlot,
            h('span', { class: 'device-text', children: [peerName, tags] }),
            h('span', { class: 'device-chevron', html: ICONS.chevronRight, attrs: { 'aria-hidden': 'true' } }),
        ],
        on: {
            click: () => {
                const sessionId = client.peer?.sessionId;
                if (sessionId != null) {
                    context.navigate({ name: 'session', sessionId });
                }
            },
        },
    });
    const pausedNote = h('p', { class: 'home-paused', text: PAUSED_TEXT });
    const connected = h('section', {
        class: 'home-connected',
        attrs: { 'aria-labelledby': 'home-connected-title', 'hidden': true },
        children: [
            h('h2', { class: 'section-title', text: 'Connected', attrs: { id: 'home-connected-title' } }),
            connectedCard,
            pausedNote,
        ],
    });

    const nearby = createNearbySection(context, { isShown: options.isShown });
    const messageSlot = h('div', { class: 'home-message' });
    const pairLink = h('button', {
        class: 'link-button',
        dataset: { action: 'pair-with-code' },
        attrs: { type: 'button' },
        children: [
            h('span', { class: 'button-icon', html: ICONS.qr, attrs: { 'aria-hidden': 'true' } }),
            PAIR_WITH_CODE_TEXT,
        ],
        on: { click: () => flow.openMenu() },
    });
    const footer = h('div', { class: 'home-foot', children: [pairLink] });
    const element = h('div', {
        class: 'home-panel',
        attrs: { 'role': 'region', 'aria-labelledby': 'home-title' },
        children: [heading, identity, connected, nearby.element, messageSlot, footer],
    });
    // The avatar is drawn again only when the peer's name or platform changes.
    let avatarKey = '';

    const renderIdentity = (): void => {
        const { deviceName, pin } = client.settings;
        setText(nameValue, deviceName);
        setAttribute(nameButton, 'aria-label', `Device name: ${deviceName}, change it`);
        setText(pinValue, pin == null ? NO_PIN_TEXT : PIN_DOTS);
        setAttribute(pinButton, 'aria-label', pin == null ? 'PIN: none, set one' : 'PIN: set, change it');
    };

    const renderConnection = (): void => {
        const peer = client.peer;
        const isLinked = peer != null && (client.state === 'connected' || client.state === 'lost');
        const isConnected = isLinked && client.state === 'connected';
        setHidden(connected, !isLinked);
        // The link dropped: nearby devices show again below, so a device can be asked again.
        setHidden(nearby.element, isConnected);
        setHidden(footer, isConnected);
        setHidden(pausedNote, !isConnected);
        if (element.dataset.connected !== String(isConnected)) {
            element.dataset.connected = String(isConnected);
        }

        if (peer == null || !isLinked) {
            return;
        }

        const key = `${peer.displayName}:${peer.platform ?? ''}`;
        if (avatarKey !== key) {
            avatarKey = key;
            avatarSlot.replaceChildren(peerAvatar(peer.displayName, peer.platform));
        }

        setText(peerName, peer.displayName);
        setAttribute(peerName, 'title', peer.displayName);
        setAttribute(connectedCard, 'aria-label', `Open session with ${peer.displayName}`);
        setText(linkTag, isConnected ? 'Connected' : 'Connection lost');
        if (linkTag.dataset.tone !== (isConnected ? 'ok' : 'fail')) {
            linkTag.dataset.tone = isConnected ? 'ok' : 'fail';
        }

        setHidden(movingTag, !(isConnected && tracker.isTransferring));
    };

    const unsubscribers = [
        client.on('settings', renderIdentity),
        client.on('state', renderConnection),
        client.on('peer', renderConnection),
        tracker.onChange(() => setHidden(movingTag, !(client.state === 'connected' && tracker.isTransferring))),
    ];
    renderIdentity();
    renderConnection();

    return {
        element,
        messageSlot,
        focus: () => heading.focus({ preventScroll: true }),
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            nearby.dispose();
        },
    };
}
