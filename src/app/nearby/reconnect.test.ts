import { afterEach, describe, expect, it } from 'vitest';
import type { PairRequestOutcome } from '../../discovery/discoveryTypes.js';
import { NOT_NEARBY_TEXT, showUpText } from '../history/sessionStatus.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { ANSWER_CODE, createSession, OFFER_CODE } from '../testing/fakeClient.js';
import { createNearbyDevice, createPairRequest } from '../testing/fakeDiscovery.js';
import { NEARBY_EMPTY_TEXTS } from './nearbySection.js';

// Reconnect on the peer bar: the peer of a lost, ended or offline session, asked as a nearby device at once,
// or as soon as it shows up nearby.

const PIXEL = createNearbyDevice();
const OTHER = createNearbyDevice({
    nearbyId: 'nearby-other',
    name: 'Windows · Calm Heron',
    deviceType: 'desktop',
});

let harness: TestApp | undefined;

// A session whose peer closed Ether: the bar reads "Disconnected".
async function endedSessionAsync(options: TestAppOptions = {}): Promise<TestApp> {
    harness = createTestApp({ ...options, client: { sessions: [createSession()], ...options.client } });
    await harness.app.startAsync();
    const peer = harness.client.connect();
    await settleAsync();
    harness.client.emit('peer', 'left', peer);
    harness.client.setState('closed');
    await settleAsync();

    return harness;
}

function card(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>('.session-status');
}

function visibleButtons(root: HTMLElement): Array<string | null> {
    return [...(card(root)?.querySelectorAll<HTMLButtonElement>('.status-side button:not([hidden])') ?? [])]
        .map(button => button.textContent);
}

function isCodeFirst(root: HTMLElement): boolean | undefined {
    return card(root)?.querySelector('[data-action="use-code"]')?.classList.contains('button-primary');
}

// The primary buttons on screen, by their words: hidden ones don't count.
function primaries(root: HTMLElement): Array<string | undefined> {
    return [...root.querySelectorAll<HTMLElement>('.button-primary')]
        .filter(button => button.closest('[hidden]') == null)
        .map(button => button.textContent?.trim());
}

function reconnectButton(root: HTMLElement): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>('.session-status [data-action="reconnect"]');
}

function visibleText(root: HTMLElement, selector: string): string | null | undefined {
    const found = card(root)?.querySelector<HTMLElement>(selector);

    return found?.hidden === false ? found.textContent : undefined;
}

async function reconnectAsync(app: TestApp): Promise<void> {
    const button = reconnectButton(app.root);
    button?.focus();
    button?.click();
    await settleAsync();
}

function cancelButton(root: HTMLElement): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>('.session-status [data-action="cancel-reconnect"]');
}

function pinSheet(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-sheet="pin-entry"]');
}

// What the bar shows while it waits: the line, the buttons and whether Cancel has the focus.
function waitingState(root: HTMLElement): Record<string, unknown> {
    return {
        text: visibleText(root, '.status-waiting'),
        buttons: visibleButtons(root),
        isCancelFocused: document.activeElement === cancelButton(root),
    };
}

// An ended session whose peer isn't nearby, with Reconnect tapped: the bar waits for the peer to show up.
async function waitingSessionAsync(options: TestAppOptions = {}): Promise<TestApp> {
    const app = await endedSessionAsync(options);
    app.discovery.setDevices([OTHER]);
    await reconnectAsync(app);

    return app;
}

describe('reconnect on the peer bar', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('offers Reconnect first while the peer is nearby, with Use a code after it', async () => {
        // Arrange
        const app = await endedSessionAsync();

        // Act
        app.discovery.setDevices([OTHER, PIXEL]);

        // Assert
        expect(card(app.root)?.dataset.link).toBe('ended');
        expect(visibleButtons(app.root)).toEqual(['Reconnect', 'Use a code']);
        expect(reconnectButton(app.root)?.classList.contains('button-primary')).toBe(true);
        expect(isCodeFirst(app.root)).toBe(false);
    });

    it('offers Reconnect on the bar of a session that isn’t connected, too', async () => {
        // Arrange
        harness = createTestApp({ client: { sessions: [createSession()] } });
        await harness.app.startAsync();
        harness.app.navigate({ name: 'session', sessionId: 'session-1' });
        await settleAsync();

        // Act
        harness.discovery.setDevices([PIXEL]);

        // Assert
        expect(card(harness.root)?.dataset.link).toBe('offline');
        expect(visibleButtons(harness.root)).toEqual(['Reconnect', 'Use a code']);
    });

    it('keeps Reconnect while the peer is away, and takes it away while nearby devices are offline or off', async () => {
        // Arrange
        const app = await endedSessionAsync();
        app.discovery.setDevices([PIXEL]);

        // Act
        app.discovery.setDevices([OTHER]);
        const afterLeaving = visibleButtons(app.root);
        app.discovery.setStatus('offline');
        const offline = { buttons: visibleButtons(app.root), line: visibleText(app.root, '.status-nearby') };
        app.discovery.setDevices([PIXEL]);
        const afterComingBack = visibleButtons(app.root);
        await app.client.configureAsync({ findNearbyDevices: false });

        // Assert
        expect(afterLeaving).toEqual(['Reconnect', 'Use a code']);
        expect(offline).toEqual({ buttons: ['Use a code'], line: NEARBY_EMPTY_TEXTS.offline[0] });
        expect(afterComingBack).toEqual(['Reconnect', 'Use a code']);
        expect(visibleButtons(app.root)).toEqual(['Use a code']);
        expect(visibleText(app.root, '.status-nearby')).toBe(NEARBY_EMPTY_TEXTS.off[0]);
        expect(isCodeFirst(app.root)).toBe(true);
    });

    it('offers Reconnect while nearby search starts, before the list comes up', async () => {
        // Arrange
        const app = await endedSessionAsync();

        // Act
        const status = app.app.context.nearby.view.status;

        // Assert
        expect(status).toBe('starting');
        expect(visibleButtons(app.root)).toEqual(['Reconnect', 'Use a code']);
        expect(visibleText(app.root, '.status-nearby')).toBeUndefined();
        expect(reconnectButton(app.root)?.getAttribute('aria-label')).toBe(`Reconnect to ${PIXEL.name}`);
    });

    it('says the peer isn’t nearby while looking without it, and that finding nearby devices is off', async () => {
        // Arrange
        const app = await endedSessionAsync();

        // Act
        app.discovery.setDevices([OTHER]);
        const looking = visibleText(app.root, '.status-nearby');
        harness?.dispose();
        const off = await endedSessionAsync({ client: { settings: { findNearbyDevices: false } } });

        // Assert
        expect(looking).toBe(NOT_NEARBY_TEXT);
        expect(visibleText(off.root, '.status-nearby')).toBe(NEARBY_EMPTY_TEXTS.off[0]);
        expect(off.root.querySelector('.session-status .status-sub')?.textContent).toBe('Disconnected');
        expect(visibleButtons(off.root)).toEqual(['Use a code']);
    });

    it('asks the peer on Reconnect, waits on the card with Cancel, and pairs with the answer', async () => {
        // Arrange
        const app = await endedSessionAsync();
        app.discovery.setDevices([PIXEL]);

        // Act
        await reconnectAsync(app);
        const waiting = {
            text: visibleText(app.root, '.status-waiting'),
            buttons: visibleButtons(app.root),
            isCancelFocused: document.activeElement?.textContent === 'Cancel',
        };
        app.discovery.answer({ kind: 'accepted', answerCode: ANSWER_CODE });
        await settleAsync();

        // Assert
        expect(app.client.callsTo('startPairingAsync')).toHaveLength(1);
        expect(app.discovery.sent.map(({ nearbyId, offerCode }) => ({ nearbyId, offerCode }))).toEqual([
            { nearbyId: PIXEL.nearbyId, offerCode: OFFER_CODE },
        ]);
        expect(waiting).toEqual({
            text: `Waiting for ${PIXEL.name} to accept…`,
            buttons: ['Cancel', 'Use a code'],
            isCancelFocused: true,
        });
        expect(app.client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(card(app.root)?.dataset.link).toBe('connected');
        expect(app.root.querySelector('.check-code-value')?.textContent).toBe('7KQ2');
    });

    it.each([
        [{ kind: 'declined' }, `${PIXEL.name} declined.`],
        [{ kind: 'busy' }, `${PIXEL.name} is busy.`],
        [{ kind: 'no-answer' }, `${PIXEL.name} didn’t answer.`],
    ] as ReadonlyArray<readonly [PairRequestOutcome, string]>)('pairs nothing on %o, saying why on the bar', async (
        outcome,
        text,
    ) => {
        // Arrange
        const app = await endedSessionAsync();
        app.discovery.setDevices([PIXEL]);
        await reconnectAsync(app);

        // Act
        app.discovery.answer(outcome);
        await settleAsync();

        // Assert
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(visibleText(app.root, '.status-note')).toBe(text);
        expect([...document.querySelectorAll('.toast')].map(toast => toast.textContent)).not.toContain(text);
        expect(visibleButtons(app.root)).toEqual(['Reconnect', 'Use a code']);
        expect(document.activeElement).toBe(reconnectButton(app.root));
    });

    it('withdraws the request with Cancel', async () => {
        // Arrange
        const app = await endedSessionAsync();
        app.discovery.setDevices([PIXEL]);
        await reconnectAsync(app);

        // Act
        buttonByText(card(app.root) ?? app.root, 'Cancel')?.click();
        await settleAsync();

        // Assert
        expect(app.discovery.sent[0]?.signal?.aborted).toBe(true);
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(visibleText(app.root, '.status-note')).toBeUndefined();
        expect(visibleButtons(app.root)).toEqual(['Reconnect', 'Use a code']);
        expect(document.activeElement).toBe(reconnectButton(app.root));
    });

    it('makes Reconnect the one primary button while it shows, and Use a code once it hides, with no action bar', async () => {
        // Arrange
        const app = await endedSessionAsync();
        const before = primaries(app.root);

        // Act
        app.discovery.setDevices([OTHER]);
        const whileAway = primaries(app.root);
        await app.client.configureAsync({ findNearbyDevices: false });

        // Assert
        expect(before).toEqual(['Reconnect']);
        expect(whileAway).toEqual(['Reconnect']);
        expect(primaries(app.root)).toEqual(['Use a code']);
        expect(app.root.querySelector('.action-bar')).toBeNull();
    });

    it('says it is connecting, not waiting for an Accept, when Reconnect sends the peer’s PIN (SP-11)', async () => {
        // Arrange
        const app = await endedSessionAsync();
        app.discovery.setDevices([{ ...PIXEL, hasPin: true }]);
        await reconnectAsync(app);
        const sheet = document.querySelector<HTMLElement>('[data-sheet="pin-entry"]');
        const input = sheet?.querySelector<HTMLInputElement>('input[data-role="pin"]');
        if (input != null) {
            input.value = '2468';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Act
        sheet?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await settleAsync();

        // Assert
        expect(app.discovery.sent.map(request => request.pin)).toEqual(['2468']);
        expect(visibleText(app.root, '.status-waiting')).toBe(`Connecting to ${PIXEL.name}…`);
        expect(visibleButtons(app.root)).toEqual(['Cancel', 'Use a code']);
    });

    it('opens Pair with a code from Use a code, whose Back comes back to the session', async () => {
        // Arrange
        const app = await endedSessionAsync();

        // Act
        card(app.root)?.querySelector<HTMLButtonElement>('[data-action="use-code"]')?.click();
        await settleAsync();
        const screen = app.root.dataset.screen;
        app.root.querySelector<HTMLButtonElement>('[data-screen="pair"] [data-action="back"]')?.click();
        await settleAsync();

        // Assert
        expect(screen).toBe('pair');
        expect(app.root.dataset.screen).toBe('session');
        expect(app.client.callsTo('startPairingAsync')).toEqual([]);
    });

    it('leaves the card and its focus alone when the peer only says it is still here', async () => {
        // Arrange
        const app = await endedSessionAsync();
        app.discovery.setDevices([PIXEL]);
        const button = reconnectButton(app.root);
        button?.focus();
        const changes: string[] = [];
        const observer = new MutationObserver(records => {
            changes.push(...records.map(record => `${record.type}:${(record.target as Element).className}`));
        });
        const target = card(app.root);
        if (target != null) {
            observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
        }

        // Act
        for (let presence = 1; presence <= 3; presence++) {
            app.discovery.setDevices([{ ...PIXEL, lastSeenAt: PIXEL.lastSeenAt + presence * 30_000 }]);
        }

        await settleAsync();
        observer.disconnect();

        // Assert
        expect(changes).toEqual([]);
        expect(reconnectButton(app.root)).toBe(button);
        expect(document.activeElement).toBe(button);
    });
});

describe('Reconnect while the peer isn’t nearby', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('waits for the peer with Cancel in Reconnect’s place, and asks it as soon as it shows up', async () => {
        // Arrange
        const app = await waitingSessionAsync();
        const waiting = {
            ...waitingState(app.root),
            line: visibleText(app.root, '.status-nearby'),
            cancelLabel: cancelButton(app.root)?.getAttribute('aria-label'),
            sent: app.discovery.sent.length,
        };

        // Act
        app.discovery.setDevices([OTHER, PIXEL]);
        await settleAsync();
        const asking = waitingState(app.root);
        app.discovery.answer({ kind: 'accepted', answerCode: ANSWER_CODE });
        await settleAsync();

        // Assert
        expect(waiting).toEqual({
            text: showUpText(PIXEL.name),
            buttons: ['Cancel', 'Use a code'],
            isCancelFocused: true,
            line: undefined,
            cancelLabel: `Cancel reconnecting to ${PIXEL.name}`,
            sent: 0,
        });
        expect(app.discovery.sent.map(({ nearbyId, offerCode }) => ({ nearbyId, offerCode }))).toEqual([
            { nearbyId: PIXEL.nearbyId, offerCode: OFFER_CODE },
        ]);
        expect(asking).toEqual({
            text: `Waiting for ${PIXEL.name} to accept…`,
            buttons: ['Cancel', 'Use a code'],
            isCancelFocused: true,
        });
        expect(app.client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(card(app.root)?.dataset.link).toBe('connected');
    });

    it('stops waiting on Cancel, with focus back on Reconnect, and sends nothing when the peer shows up', async () => {
        // Arrange
        const app = await waitingSessionAsync();

        // Act
        cancelButton(app.root)?.click();
        await settleAsync();
        const canceled = {
            buttons: visibleButtons(app.root),
            line: visibleText(app.root, '.status-nearby'),
            isReconnectFocused: document.activeElement === reconnectButton(app.root),
        };
        app.discovery.setDevices([PIXEL]);
        await settleAsync();

        // Assert
        expect(canceled).toEqual({ buttons: ['Reconnect', 'Use a code'], line: NOT_NEARBY_TEXT, isReconnectFocused: true });
        expect(visibleText(app.root, '.status-waiting')).toBeUndefined();
        expect(app.discovery.sent).toEqual([]);
        expect(app.client.callsTo('startPairingAsync')).toEqual([]);
    });

    it.each([
        ['are turned off', NEARBY_EMPTY_TEXTS.off[0], async (app: TestApp): Promise<void> => {
            await app.client.configureAsync({ findNearbyDevices: false });
        }],
        ['go offline', NEARBY_EMPTY_TEXTS.offline[0], async (app: TestApp): Promise<void> => {
            app.discovery.setStatus('offline');
        }],
    ] as const)('stops waiting when nearby devices %s, and says why', async (_, text, endAsync) => {
        // Arrange
        const app = await waitingSessionAsync();

        // Act
        await endAsync(app);
        await settleAsync();
        const ended = {
            waiting: visibleText(app.root, '.status-waiting'),
            line: visibleText(app.root, '.status-nearby'),
            buttons: visibleButtons(app.root),
            isCodeFocused: document.activeElement === card(app.root)?.querySelector('[data-action="use-code"]'),
        };
        await app.client.configureAsync({ findNearbyDevices: true });
        app.discovery.setDevices([PIXEL]);
        await settleAsync();

        // Assert
        expect(ended).toEqual({ waiting: undefined, line: text, buttons: ['Use a code'], isCodeFocused: true });
        expect(app.app.context.nearby.view.awaited).toBeUndefined();
        expect(app.discovery.sent).toEqual([]);
        expect(visibleButtons(app.root)).toEqual(['Reconnect', 'Use a code']);
    });

    it('opens the PIN sheet as soon as an awaited peer with a PIN shows up, and sends the PIN with the request', async () => {
        // Arrange
        const app = await waitingSessionAsync();

        // Act
        app.discovery.setDevices([{ ...PIXEL, hasPin: true }]);
        await settleAsync();
        const sheet = pinSheet();
        const behindSheet = { buttons: visibleButtons(app.root), sent: app.discovery.sent.length };
        const input = sheet?.querySelector<HTMLInputElement>('input[data-role="pin"]');
        if (input != null) {
            input.value = '2468';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        sheet?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await settleAsync();

        // Assert
        expect(sheet).not.toBeNull();
        expect(behindSheet).toEqual({ buttons: ['Reconnect', 'Use a code'], sent: 0 });
        expect(app.discovery.sent.map(request => request.pin)).toEqual(['2468']);
        expect(visibleText(app.root, '.status-waiting')).toBe(`Connecting to ${PIXEL.name}…`);
        expect(visibleButtons(app.root)).toEqual(['Cancel', 'Use a code']);
    });

    it('brings focus back to Reconnect when the PIN sheet that opened by itself is canceled', async () => {
        // Arrange
        const app = await waitingSessionAsync();
        app.discovery.setDevices([{ ...PIXEL, hasPin: true }]);
        await settleAsync();

        // Act
        const sheet = pinSheet();
        if (sheet != null) {
            buttonByText(sheet, 'Cancel')?.click();
        }

        await settleAsync();

        // Assert
        expect(pinSheet()).toBeNull();
        expect(app.discovery.sent).toEqual([]);
        expect(visibleButtons(app.root)).toEqual(['Reconnect', 'Use a code']);
        expect(document.activeElement).toBe(reconnectButton(app.root));
    });

    it('keeps waiting across a trip to Home and back, and asks the peer once it shows up', async () => {
        // Arrange
        const app = await waitingSessionAsync();

        // Act
        app.app.navigate({ name: 'home' });
        await settleAsync();
        const onHome = app.app.context.nearby.view.awaited?.sessionId;
        app.app.navigate({ name: 'session', sessionId: 'session-1' });
        await settleAsync();
        const back = { text: visibleText(app.root, '.status-waiting'), buttons: visibleButtons(app.root) };
        app.discovery.setDevices([PIXEL]);
        await settleAsync();

        // Assert
        expect(onHome).toBe('session-1');
        expect(back).toEqual({ text: showUpText(PIXEL.name), buttons: ['Cancel', 'Use a code'] });
        expect(app.discovery.sent.map(request => request.nearbyId)).toEqual([PIXEL.nearbyId]);
        expect(visibleText(app.root, '.status-waiting')).toBe(`Waiting for ${PIXEL.name} to accept…`);
    });

    it('keeps waiting while pairing with a code, and stops once the code connects', async () => {
        // Arrange
        const app = await waitingSessionAsync();
        card(app.root)?.querySelector<HTMLButtonElement>('[data-action="use-code"]')?.click();
        await settleAsync();
        app.root.querySelector<HTMLButtonElement>('[data-screen="pair"] [data-action="show-code"]')?.click();
        await settleAsync();
        const whilePairing = app.app.context.nearby.view.awaited?.sessionId;

        // Act
        app.relayCode(ANSWER_CODE);
        await settleAsync();
        const afterConnecting = app.app.context.nearby.view.awaited;
        const peer = app.client.peer;
        if (peer != null) {
            app.client.emit('peer', 'left', peer);
        }

        app.client.setState('closed');
        await settleAsync();
        app.discovery.setDevices([PIXEL]);
        await settleAsync();

        // Assert
        expect(whilePairing).toBe('session-1');
        expect(afterConnecting).toBeUndefined();
        expect(app.client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(app.discovery.sent).toEqual([]);
        expect(visibleButtons(app.root)).toEqual(['Reconnect', 'Use a code']);
    });
});

describe('a request from a device paired before', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('asks to connect again and says it was paired before', async () => {
        // Arrange
        harness = createTestApp({ client: { sessions: [createSession()] } });
        await harness.app.startAsync();

        // Act
        harness.discovery.receiveRequest(createPairRequest());
        const dialog = document.querySelector('[data-prompt="nearby"]');

        // Assert
        const title = dialog?.querySelector('.dialog-title')?.textContent;
        expect(title).toBe(`${PIXEL.name} wants to connect again`);
        expect(dialog?.querySelector('.nearby-prompt-device .badge')?.textContent).toBe('Paired before');
    });

    it('keeps the first-time wording for a device never paired', async () => {
        // Arrange
        harness = createTestApp({ client: { sessions: [createSession({ peerName: 'iPhone · Old Fox' })] } });
        await harness.app.startAsync();

        // Act
        harness.discovery.receiveRequest(createPairRequest());
        const dialog = document.querySelector('[data-prompt="nearby"]');

        // Assert
        expect(dialog?.querySelector('.dialog-title')?.textContent).toBe(`${PIXEL.name} wants to connect`);
        expect(dialog?.querySelector('.nearby-prompt-device .badge')).toBeNull();
    });
});
