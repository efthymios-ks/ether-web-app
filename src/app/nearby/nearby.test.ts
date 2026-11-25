import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError } from '../../client/clientTypes.js';
import { DiscoveryError } from '../../discovery/discoveryError.js';
import type { DiscoveryErrorCode } from '../../discovery/discoveryError.js';
import type { PairRequestOutcome, RelayAllowanceNotice } from '../../discovery/discoveryTypes.js';
import { formatTime } from '../format.js';
import { DISMISS_KEY_PREFIX, RELAY_SILENT_TEXT, RELAY_USED_UP_TEXT } from '../shell/banners.js';
import { buttonByText, createTestApp, openPairMenuAsync, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { ANSWER_CODE, createSession, FAKE_APP_URL, OFFER_CODE } from '../testing/fakeClient.js';
import { createNearbyDevice, createPairRequest, createRelayAllowanceNotice } from '../testing/fakeDiscovery.js';
import type { NearbyController, SessionPeer } from './nearbyController.js';
import { NEARBY_PROMPT_TEXT } from './nearbyPrompt.js';
import { NEARBY_EMPTY_TEXTS, NEARBY_HINT_TEXT } from './nearbySection.js';

const PIXEL = createNearbyDevice();
const LAPTOP = createNearbyDevice({
    nearbyId: 'nearby-laptop',
    name: 'Windows · Calm Heron',
    deviceType: 'desktop',
});
const IPAD = createNearbyDevice({ nearbyId: 'nearby-ipad', name: 'iPad · Quiet Lark', deviceType: 'tablet' });

// Why a request this device sent couldn't go out, and what the asker reads.
const ASK_ERRORS: ReadonlyArray<readonly [DiscoveryErrorCode, string]> = [
    ['not-listening', 'Nearby devices can’t be reached right now. Try again soon, or pair with a code.'],
    ['unknown-device', `${PIXEL.name} is no longer nearby. Check Ether is open there, or pair with a code.`],
    ['invalid-code', 'This device’s code couldn’t be sent. Try again, or pair with a code.'],
    ['request-ended', `The request to ${PIXEL.name} ended without an answer. Try again.`],
    ['send-failed', `Couldn’t reach ${PIXEL.name} through the relays. Try again, or pair with a code.`],
];

// Why an accepted request's reply couldn't go back, and what the asked device reads.
const ANSWER_ERRORS: ReadonlyArray<readonly [DiscoveryErrorCode, string]> = [
    [
        'request-ended',
        `The request from ${PIXEL.name} ended before your reply reached it. Try again from ${PIXEL.name}.`,
    ],
    [
        'send-failed',
        `Couldn’t send your reply to ${PIXEL.name}. Try again from ${PIXEL.name}, or pair with a code.`,
    ],
];

let harness: TestApp | undefined;

async function startAsync(options: TestAppOptions = {}): Promise<TestApp> {
    harness = createTestApp(options);
    await harness.app.startAsync();

    return harness;
}

async function homeWithDevicesAsync(options: TestAppOptions = {}): Promise<TestApp> {
    const app = await startAsync(options);
    app.discovery.setDevices([PIXEL, LAPTOP]);
    await settleAsync();

    return app;
}

function texts(container: ParentNode, selector: string): Array<string | null> {
    return [...container.querySelectorAll(selector)].map(element => element.textContent);
}

function hintText(root: HTMLElement): string | null | undefined {
    return root.querySelector('.nearby-hint')?.textContent;
}

// The big line and the line under it of what replaced the cards, or undefined while cards show.
function emptyState(root: HTMLElement): readonly [string | null | undefined, string | null | undefined] | undefined {
    const empty = root.querySelector<HTMLElement>('.nearby-empty');
    if (empty == null || empty.hidden) {
        return undefined;
    }

    return [empty.querySelector('.empty-title')?.textContent, empty.querySelector('.empty-text')?.textContent];
}

function card(root: HTMLElement, name: string): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>(`.nearby-connect[aria-label="Connect to ${name}"]`);
}

function row(root: HTMLElement, nearbyId: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-nearby-id="${nearbyId}"]`);
}

// The Cancel under the asked card; the other cards keep theirs hidden.
function cancelButton(root: HTMLElement): HTMLButtonElement | undefined {
    return [...root.querySelectorAll<HTMLButtonElement>('[data-action="cancel-nearby"]')]
        .find(button => button.closest('[hidden]') == null);
}

function waitText(root: HTMLElement): string | null | undefined {
    const wait = [...root.querySelectorAll<HTMLElement>('.nearby-wait')].find(element => !element.hidden);

    return wait?.textContent;
}

function noteText(root: HTMLElement): string | null | undefined {
    const note = root.querySelector<HTMLElement>('.nearby-note');

    return note?.hidden === false ? note.textContent : undefined;
}

function prompt(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-prompt="nearby"]');
}

// Focuses the card first, as a tap or a keyboard does, so the tests can follow where focus goes.
async function askAsync(app: TestApp, name: string = PIXEL.name): Promise<void> {
    const button = card(app.root, name);
    button?.focus();
    button?.click();
    await settleAsync();
}

describe('nearby devices', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('starts looking on Home with this device’s name and type, with the orbit while nobody shows', async () => {
        // Arrange
        const app = await startAsync({
            platform: 'android',
            client: { settings: { deviceName: 'Pixel 8 · Red Fox' } },
        });

        // Act
        const orbit = app.root.querySelector('.nearby-empty .orbit');

        // Assert
        expect(app.discovery.starts).toEqual([{ name: 'Pixel 8 · Red Fox', deviceType: 'phone', platform: 'Android' }]);
        expect(emptyState(app.root)).toEqual(NEARBY_EMPTY_TEXTS.empty);
        expect(orbit?.getAttribute('role')).toBe('img');
        expect(orbit?.getAttribute('aria-label')).toBe('Looking for nearby devices');
        expect(app.root.querySelector('.nearby-hint')?.getAttribute('aria-live')).toBe('polite');
    });

    it.each([
        ['listening', NEARBY_EMPTY_TEXTS.empty],
        ['starting', NEARBY_EMPTY_TEXTS.empty],
        ['offline', NEARBY_EMPTY_TEXTS.offline],
    ] as const)('says what the %s status means in place of the list', async (status, lines) => {
        // Arrange
        const app = await startAsync();

        // Act
        app.discovery.setStatus(status);

        // Assert
        expect(emptyState(app.root)).toEqual(lines);
        expect(app.root.querySelector('.nearby-list')?.hasAttribute('hidden')).toBe(true);
        expect(app.root.querySelector<HTMLElement>('.nearby-empty .orbit')?.parentElement?.hidden).toBe(status === 'offline');
    });

    it('says it is off, and Turn on starts looking', async () => {
        // Arrange
        const app = await startAsync({ client: { settings: { findNearbyDevices: false } } });
        const before = { starts: app.discovery.starts.length, lines: emptyState(app.root) };

        // Act
        buttonByText(app.root.querySelector('.nearby-empty') ?? app.root, 'Turn on')?.click();
        await settleAsync();

        // Assert
        expect(before).toEqual({ starts: 0, lines: ['Finding nearby devices is off.', 'Turn it on, or pair with a code.'] });
        expect(app.client.settings.findNearbyDevices).toBe(true);
        expect(app.discovery.starts).toHaveLength(1);
        expect(emptyState(app.root)).toEqual(NEARBY_EMPTY_TEXTS.empty);
    });

    it('stops looking when the setting is turned off', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();

        // Act
        await app.client.configureAsync({ findNearbyDevices: false });

        // Assert
        expect(app.discovery.stopCount).toBe(1);
        expect(app.root.querySelectorAll('.nearby-item')).toHaveLength(0);
        expect(emptyState(app.root)?.[0]).toBe('Finding nearby devices is off.');
    });

    it('lists each device as a card that connects on a tap, named for it, live', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        const laptopRow = row(app.root, 'nearby-laptop');

        // Act
        const before = [...app.root.querySelectorAll('.nearby-item')].map(item => item.querySelector('.device-card')?.textContent);
        app.discovery.setDevices([LAPTOP, IPAD]);

        // Assert
        expect(before).toEqual(['Pixel 8 · Blue OtterPhone', 'Windows · Calm HeronComputer']);
        expect(texts(app.root, '.nearby-name')).toEqual([LAPTOP.name, IPAD.name]);
        expect(card(app.root, IPAD.name)?.tagName).toBe('BUTTON');
        expect(app.root.querySelectorAll('.nearby-item button:not([data-action="cancel-nearby"])')).toHaveLength(2);
        expect(row(app.root, 'nearby-laptop')).toBe(laptopRow);
        expect(hintText(app.root)).toBe(NEARBY_HINT_TEXT);
        expect(app.root.querySelector('.nearby-head .orbit')?.getAttribute('aria-label')).toBe('Looking for nearby devices');
    });

    it('tags each device with its platform, or its type when an older build sends none', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        const pixelRow = row(app.root, 'nearby-pixel');

        // Act
        app.discovery.setDevices([{ ...PIXEL, platform: 'Android' }, LAPTOP, { ...IPAD, platform: 'iPad' }]);

        // Assert
        expect([...app.root.querySelectorAll('.nearby-tags')].map(tags => tags.firstElementChild?.textContent))
            .toEqual(['Android', 'Computer', 'iPad']);
        expect(row(app.root, 'nearby-pixel')).toBe(pixelRow);
    });

    it('tags a device paired before, with its unfinished files', async () => {
        // Arrange
        const app = await startAsync({ client: { sessions: [createSession({ peerName: PIXEL.name, unfinishedCount: 3 })] } });

        // Act
        app.discovery.setDevices([PIXEL, LAPTOP]);
        await settleAsync();
        const pixelTags = row(app.root, 'nearby-pixel')?.querySelectorAll<HTMLElement>('.nearby-tags .badge') ?? [];

        // Assert
        expect([...pixelTags].map(tag => tag.textContent)).toEqual(['Phone', 'Paired before', '3 unfinished']);
        expect([...pixelTags].at(-1)?.dataset.tone).toBe('warn');
        expect(texts(row(app.root, 'nearby-laptop') ?? app.root, '.nearby-tags .badge')).toEqual(['Computer']);
    });

    it('keeps cards, and the focus on them, when devices only say they are still here', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        const rows = [...app.root.querySelectorAll('.nearby-item')];
        card(app.root, LAPTOP.name)?.focus();
        const changes: string[] = [];
        const observer = new MutationObserver(records => changes.push(...records.map(record => record.type)));
        observer.observe(app.root.querySelector('.nearby-list') ?? app.root, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });

        // Act
        const presence = [PIXEL, LAPTOP].map(device => ({ ...device, lastSeenAt: device.lastSeenAt + 30_000 }));
        app.discovery.setDevices(presence);
        await settleAsync();
        observer.disconnect();

        // Assert
        expect(changes).toEqual([]);
        expect([...app.root.querySelectorAll('.nearby-item')]).toEqual(rows);
        expect(document.activeElement).toBe(card(app.root, LAPTOP.name));
    });

    it('says it is looking, not off, while the page is hidden with the setting on', async () => {
        // Arrange
        const app = await startAsync();
        app.discovery.setStatus('listening');

        // Act
        app.discovery.setStatus('off');

        // Assert
        expect(emptyState(app.root)).toEqual(NEARBY_EMPTY_TEXTS.empty);
    });

    it('moves focus to a neighbour when the focused device leaves the list', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        app.discovery.setDevices([PIXEL, LAPTOP, IPAD]);
        card(app.root, LAPTOP.name)?.focus();

        // Act
        app.discovery.setDevices([PIXEL, IPAD]);

        // Assert
        expect(document.activeElement).toBe(card(app.root, IPAD.name));
    });

    it('moves focus to the line that replaces the list when the last device leaves', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        card(app.root, LAPTOP.name)?.focus();

        // Act
        app.discovery.setDevices([]);

        // Assert
        expect(document.activeElement).toBe(app.root.querySelector('.nearby-empty .empty-title'));
    });

    it('sends this device’s code, waits on the card with Cancel under it, and pairs with the reply', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();

        // Act
        await askAsync(app);
        const pixelCard = row(app.root, PIXEL.nearbyId)?.querySelector<HTMLButtonElement>('.device-card');
        const waiting = {
            wait: waitText(app.root),
            label: pixelCard?.getAttribute('aria-label'),
            isCardDisabled: pixelCard?.disabled,
            cancelRow: cancelButton(app.root)?.closest<HTMLElement>('.nearby-item')?.dataset.nearbyId,
            cancelLabel: cancelButton(app.root)?.getAttribute('aria-label'),
            isOtherDisabled: card(app.root, LAPTOP.name)?.disabled,
            hint: hintText(app.root),
            focused: document.activeElement === cancelButton(app.root),
        };
        app.discovery.answer({ kind: 'accepted', answerCode: ANSWER_CODE });
        await settleAsync();

        // Assert
        expect(app.client.callsTo('startPairingAsync')).toHaveLength(1);
        expect(app.discovery.sent.map(({ nearbyId, offerCode }) => ({ nearbyId, offerCode }))).toEqual([
            { nearbyId: PIXEL.nearbyId, offerCode: OFFER_CODE },
        ]);
        expect(waiting).toEqual({
            wait: 'Waiting for Pixel 8 · Blue Otter to accept…',
            label: 'Waiting for Pixel 8 · Blue Otter to accept…',
            isCardDisabled: true,
            cancelRow: PIXEL.nearbyId,
            cancelLabel: 'Stop asking Pixel 8 · Blue Otter',
            isOtherDisabled: true,
            hint: '',
            focused: true,
        });
        expect(app.client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(app.root.dataset.screen).toBe('session');
        expect(app.root.querySelector('.check-code-value')?.textContent).toBe('7KQ2');
    });

    it.each([
        [{ kind: 'declined' }, 'Pixel 8 · Blue Otter declined.'],
        [{ kind: 'busy' }, 'Pixel 8 · Blue Otter is busy.'],
        [{ kind: 'no-answer' }, 'Pixel 8 · Blue Otter didn’t answer.'],
    ] as ReadonlyArray<readonly [PairRequestOutcome, string]>)('pairs nothing on %o, and says why under the list', async (
        outcome,
        text,
    ) => {
        // Arrange
        const app = await homeWithDevicesAsync();
        await askAsync(app);

        // Act
        app.discovery.answer(outcome);
        await settleAsync();

        // Assert
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(app.client.callsTo('completePairingAsync')).toEqual([]);
        expect(noteText(app.root)).toBe(text);
        expect(app.root.querySelector('.nearby-list + .nearby-empty + .nearby-note')).not.toBeNull();
        expect(app.root.dataset.screen).toBe('home');
        expect(cancelButton(app.root)).toBeUndefined();
        expect(waitText(app.root)).toBeUndefined();
        expect(card(app.root, PIXEL.name)?.disabled).toBe(false);
        expect(document.activeElement).toBe(card(app.root, PIXEL.name));
        expect(document.querySelector('.toast')).toBeNull();
    });

    it.each(ASK_ERRORS)('explains a %s error and lets go of the code', async (code, text) => {
        // Arrange
        const app = await homeWithDevicesAsync();
        app.discovery.behaviour.requestPairingAsync = async () => {
            throw new DiscoveryError(code, code);
        };

        // Act
        await askAsync(app);

        // Assert
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(noteText(app.root)).toBe(text);
        expect(card(app.root, PIXEL.name)?.disabled).toBe(false);
    });

    it('withdraws the request with Cancel and pairs nothing', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        await askAsync(app);

        // Act
        cancelButton(app.root)?.click();
        await settleAsync();

        // Assert
        expect(app.discovery.sent[0]?.signal?.aborted).toBe(true);
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(app.client.callsTo('completePairingAsync')).toEqual([]);
        expect(noteText(app.root)).toBeUndefined();
        expect(hintText(app.root)).toBe(NEARBY_HINT_TEXT);
        expect(document.activeElement).toBe(card(app.root, PIXEL.name));
    });

    it('keeps asking on Pair with a code, and withdraws the request once this device’s code shows', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        await askAsync(app);

        // Act
        await openPairMenuAsync(app.root);
        const onMenu = { isAborted: app.discovery.sent[0]?.signal?.aborted, isStarted: app.discovery.isStarted };
        app.root.querySelector<HTMLButtonElement>('[data-screen="pair"] [data-action="show-code"]')?.click();
        await settleAsync();

        // Assert
        expect(onMenu).toEqual({ isAborted: false, isStarted: true });
        expect(app.discovery.sent[0]?.signal?.aborted).toBe(true);
        expect(app.root.dataset.screen).toBe('offer');
        expect(app.client.callsTo('startPairingAsync')).toHaveLength(2);
        expect(app.discovery.isStarted).toBe(false);
        expect(document.querySelector('.toast')).toBeNull();
    });

    it('takes the other device’s request unasked when both ask each other and its offer sorts first', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        await askAsync(app);

        // Act
        app.discovery.receiveRequest(createPairRequest({ offerCode: 'OFFERAAAA0000' }));
        await settleAsync();

        // Assert
        expect(prompt()).toBeNull();
        expect(app.discovery.sent[0]?.signal?.aborted).toBe(true);
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([['OFFERAAAA0000']]);
        expect(app.discovery.accepts).toEqual([{ requestId: 'request-1', answerCode: ANSWER_CODE }]);
        expect(app.discovery.declines).toEqual([]);
        expect(app.root.dataset.screen).toBe('connecting');
    });

    it('goes on with its own request, leaving the other open, when its own offer sorts first', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        await askAsync(app);

        // Act
        app.discovery.receiveRequest(createPairRequest({ offerCode: 'OFFERZZZZ0000' }));
        await settleAsync();
        const whileAsking = {
            prompt: prompt(),
            declines: [...app.discovery.declines],
            joins: app.client.callsTo('joinWithCodeAsync'),
        };
        app.discovery.answer({ kind: 'accepted', answerCode: ANSWER_CODE });
        await settleAsync();

        // Assert
        expect(whileAsking).toEqual({ prompt: null, declines: [], joins: [] });
        expect(app.discovery.sent[0]?.signal?.aborted).toBe(false);
        expect(app.client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(app.discovery.declines).toEqual([{ requestId: 'request-1', reason: 'busy' }]);
        expect(app.root.dataset.screen).toBe('session');
    });

    it('yields to the other device while its own offer is still being prepared', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        let finishOffer: (offer: { code: string; url: string; expiresAt: number }) => void = () => undefined;
        app.client.behaviour.startPairingAsync = () => new Promise(resolve => {
            finishOffer = resolve;
        });
        await askAsync(app);

        // Act
        app.discovery.receiveRequest(createPairRequest({ offerCode: 'OFFERZZZZ0000' }));
        await settleAsync();
        finishOffer({ code: OFFER_CODE, url: `${FAKE_APP_URL}#${OFFER_CODE}`, expiresAt: Date.now() + 60_000 });
        await settleAsync();

        // Assert
        expect(app.discovery.sent).toEqual([]);
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([['OFFERZZZZ0000']]);
        expect(app.discovery.accepts).toEqual([{ requestId: 'request-1', answerCode: ANSWER_CODE }]);
    });

    it('sends one request at a time', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        await askAsync(app);

        // Act
        await app.app.context.nearby.connectAsync(LAPTOP.nearbyId);

        // Assert
        expect(app.discovery.sent).toHaveLength(1);
        expect(app.client.callsTo('startPairingAsync')).toHaveLength(1);
    });

    it('asks before pairing when another device sends a request', async () => {
        // Arrange
        const app = await startAsync();

        // Act
        app.discovery.receiveRequest(createPairRequest());
        const dialog = prompt();

        // Assert
        expect(dialog?.querySelector('.dialog-title')?.textContent).toBe(`${PIXEL.name} wants to connect`);
        expect(dialog?.querySelector('.nearby-prompt-device')?.textContent).toBe('Phone nearby');
        expect(dialog?.querySelector('.dialog-message')?.textContent).toBe(NEARBY_PROMPT_TEXT);
        expect(texts(dialog ?? document.body, 'button')).toEqual(['Decline', 'Accept']);
        expect(document.activeElement?.textContent).toBe('Accept');
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([]);
    });

    it('names the asking device’s platform when it sends one', async () => {
        // Arrange
        const app = await startAsync();

        // Act
        app.discovery.receiveRequest(createPairRequest({ from: { ...PIXEL, platform: 'Android' } }));

        // Assert
        expect(prompt()?.querySelector('.nearby-prompt-device')?.textContent).toBe('Android nearby');
    });

    it('on Accept answers the offer, sends the answer back, and connects as the joining side', async () => {
        // Arrange
        const app = await startAsync();
        app.discovery.receiveRequest(createPairRequest());

        // Act
        buttonByText(prompt() ?? document.body, 'Accept')?.click();
        await settleAsync();
        const screenWhileWaiting = app.root.dataset.screen;
        app.client.connect();
        await settleAsync();

        // Assert
        expect(prompt()).toBeNull();
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([['OFFERNEARBY1234']]);
        expect(app.discovery.accepts).toEqual([{ requestId: 'request-1', answerCode: ANSWER_CODE }]);
        expect(screenWhileWaiting).toBe('connecting');
        expect(app.root.dataset.screen).toBe('session');
        expect(app.root.querySelector('.check-code-value')?.textContent).toBe('7KQ2');
    });

    it('declines with Decline or Escape, pairing nothing', async () => {
        // Arrange
        const app = await startAsync();
        app.discovery.receiveRequest(createPairRequest());

        // Act
        buttonByText(prompt() ?? document.body, 'Decline')?.click();
        app.discovery.receiveRequest(createPairRequest({ requestId: 'request-2' }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await settleAsync();

        // Assert
        expect(app.discovery.declines).toEqual([
            { requestId: 'request-1', reason: 'declined' },
            { requestId: 'request-2', reason: 'declined' },
        ]);
        expect(prompt()).toBeNull();
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([]);
        expect(app.root.dataset.screen).toBe('home');
    });

    it('closes the prompt with a note when the asker cancels', async () => {
        // Arrange
        const app = await startAsync();
        app.discovery.receiveRequest(createPairRequest());

        // Act
        app.discovery.endRequest('request-1');

        // Assert
        expect(prompt()).toBeNull();
        expect(document.querySelector('.toast')?.textContent).toBe('Pixel 8 · Blue Otter canceled.');
        expect(app.discovery.declines).toEqual([]);
    });

    it('answers busy, without asking, a second request while the prompt is open', async () => {
        // Arrange
        const app = await startAsync();
        app.discovery.receiveRequest(createPairRequest());

        // Act
        app.discovery.receiveRequest(createPairRequest({ requestId: 'request-2', from: LAPTOP }));

        // Assert
        expect(document.querySelectorAll('[data-prompt="nearby"]')).toHaveLength(1);
        expect(prompt()?.querySelector('.dialog-title')?.textContent).toBe(`${PIXEL.name} wants to connect`);
        expect(app.discovery.declines).toEqual([{ requestId: 'request-2', reason: 'busy' }]);
    });

    it('answers busy, without asking, while connected or asking a device itself', async () => {
        // Arrange
        const app = await homeWithDevicesAsync({ client: { sessions: [createSession()] } });
        await askAsync(app);

        // Act
        app.discovery.receiveRequest(createPairRequest({ requestId: 'while-asking', from: LAPTOP }));
        app.discovery.answer({ kind: 'accepted', answerCode: ANSWER_CODE });
        await settleAsync();
        app.discovery.receiveRequest(createPairRequest({ requestId: 'while-connected', from: LAPTOP }));

        // Assert
        expect(prompt()).toBeNull();
        expect(app.discovery.declines).toEqual([
            { requestId: 'while-asking', reason: 'busy' },
            { requestId: 'while-connected', reason: 'busy' },
        ]);
    });

    it('shows a problem with the offer and declines the request', async () => {
        // Arrange
        const app = await startAsync();
        app.client.behaviour.joinWithCodeAsync = async () => {
            throw new ClientError('code-expired', 'The code expired.');
        };
        app.discovery.receiveRequest(createPairRequest());

        // Act
        buttonByText(prompt() ?? document.body, 'Accept')?.click();
        await settleAsync();

        // Assert
        expect(app.discovery.accepts).toEqual([]);
        expect(app.discovery.declines).toEqual([{ requestId: 'request-1', reason: 'declined' }]);
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(app.root.dataset.screen).toBe('home');
        const expired = `The request from ${PIXEL.name} expired. Try again from ${PIXEL.name}.`;
        expect(noteText(app.root)).toBe(expired);
    });

    it.each(ANSWER_ERRORS)('explains when the answer can’t go back (%s)', async (code, text) => {
        // Arrange
        const app = await startAsync();
        app.discovery.behaviour.acceptAsync = async () => {
            throw new DiscoveryError(code, code);
        };
        app.discovery.receiveRequest(createPairRequest());

        // Act
        buttonByText(prompt() ?? document.body, 'Accept')?.click();
        await settleAsync();

        // Assert
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(app.root.dataset.screen).toBe('home');
        expect(noteText(app.root)).toBe(text);
    });

    it('stops while connected and looks again once the connection ends', async () => {
        // Arrange
        const app = await homeWithDevicesAsync({ client: { sessions: [createSession()] } });

        // Act
        app.client.connect();
        await settleAsync();
        const whileConnected = { starts: app.discovery.starts.length, stops: app.discovery.stopCount };
        app.client.setState('closed');
        await settleAsync();

        // Assert
        expect(whileConnected).toEqual({ starts: 1, stops: 1 });
        expect(app.discovery.starts).toHaveLength(2);
        expect(app.discovery.isStarted).toBe(true);
    });

    it('pauses while this device’s code shows, says so beside it, and looks again after Other options', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();
        await openPairMenuAsync(app.root);

        // Act
        app.root.querySelector<HTMLButtonElement>('[data-screen="pair"] [data-action="show-code"]')?.click();
        await settleAsync();
        const whileShowingCode = {
            stops: app.discovery.stopCount,
            isStarted: app.discovery.isStarted,
            lines: emptyState(app.root),
        };
        app.root.querySelector<HTMLButtonElement>('.app-pane [data-action="back"]')?.click();
        await settleAsync();

        // Assert
        expect(whileShowingCode).toEqual({ stops: 1, isStarted: false, lines: NEARBY_EMPTY_TEXTS.paused });
        expect(app.root.dataset.screen).toBe('pair');
        expect(app.discovery.starts).toHaveLength(2);
        expect(texts(app.root, '.nearby-name')).toEqual([]);
    });

    it('goes on under the new name after a rename', async () => {
        // Arrange
        const app = await homeWithDevicesAsync();

        // Act
        await app.client.renameAsync('Kitchen tablet');

        // Assert
        expect(app.discovery.starts.map(identity => identity.name)).toEqual(['Device', 'Kitchen tablet']);
        expect(app.discovery.stopCount).toBe(0);
    });
});

describe('nearby relay allowance banner', () => {
    const NOW = Date.parse('2026-11-25T18:48:00Z');
    const RESETS_AT = NOW + ((5 * 60) + 12) * 60_000;
    const NEXT_RESET = RESETS_AT + 86_400_000;
    const REST = 'Nearby devices still show through public relays, and the QR code always works.';

    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        vi.useRealTimers();
        localStorage.clear();
    });

    // The clock is fixed once the app runs, so the countdown and the reset can be stepped through.
    async function startWithNoticeAsync(
        notice: RelayAllowanceNotice = createRelayAllowanceNotice({ resetsAt: RESETS_AT }),
        options: TestAppOptions = {},
    ): Promise<TestApp> {
        const app = await startAsync(options);
        vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        app.discovery.setRelayAllowance(notice);

        return app;
    }

    function bannerText(root: HTMLElement): string | null | undefined {
        return root.querySelector('[data-banner="relay-allowance"] .banner-text')?.textContent;
    }

    function dismissButton(root: HTMLElement): HTMLButtonElement | null {
        return root.querySelector<HTMLButtonElement>('[data-banner="relay-allowance"] [aria-label="Dismiss"]');
    }

    it.each([
        [true, RELAY_USED_UP_TEXT],
        [false, RELAY_SILENT_TEXT],
    ])('says when the relay starts again, in local time (certain: %s)', async (isCertain, title) => {
        // Arrange
        const notice = createRelayAllowanceNotice({ isCertain, resetsAt: RESETS_AT });

        // Act
        const { root } = await startWithNoticeAsync(notice);

        // Assert
        expect(root.querySelector('[data-banner="relay-allowance"] .banner-title')?.textContent).toBe(title);
        const reset = `It starts again at ${formatTime(RESETS_AT)} (in 5 h 12 min).`;
        expect(bannerText(root)).toBe(`${title} ${reset} ${REST}`);
        expect(root.querySelector('[data-banner="relay-allowance"]')?.getAttribute('data-tone')).toBe('info');
    });

    it('counts down by the minute and goes away by itself once the relay works again', async () => {
        // Arrange
        const app = await startWithNoticeAsync();

        // Act
        vi.advanceTimersByTime(60_000);
        const later = bannerText(app.root);
        app.discovery.setRelayAllowance(undefined);

        // Assert
        expect(later).toContain('(in 5 h 11 min)');
        expect(app.root.querySelector('[data-banner="relay-allowance"]')).toBeNull();
    });

    it('stays dismissed until the reset, also after a reload', async () => {
        // Arrange
        const first = await startWithNoticeAsync();

        // Act
        dismissButton(first.root)?.click();
        const afterDismiss = first.root.querySelector('[data-banner="relay-allowance"]');
        first.dispose();
        vi.useRealTimers();
        const second = await startWithNoticeAsync();

        // Assert
        expect(afterDismiss).toBeNull();
        expect(localStorage.getItem(`${DISMISS_KEY_PREFIX}relay-allowance`)).toBe(String(RESETS_AT));
        expect(second.root.querySelector('[data-banner="relay-allowance"]')).toBeNull();
    });

    it('shows again after the reset while the notice still stands', async () => {
        // Arrange
        const app = await startWithNoticeAsync();
        dismissButton(app.root)?.click();

        // Act
        vi.advanceTimersByTime(RESETS_AT - NOW);
        const atReset = bannerText(app.root);
        app.discovery.setRelayAllowance(createRelayAllowanceNotice({ resetsAt: NEXT_RESET }));

        // Assert
        expect(atReset).toBe(`${RELAY_USED_UP_TEXT} It should start again any minute now. ${REST}`);
        expect(bannerText(app.root)).toContain(`It starts again at ${formatTime(NEXT_RESET)} (in 24 h)`);
    });

    it('shows nothing while nearby devices are turned off', async () => {
        // Arrange
        const options: TestAppOptions = { client: { settings: { findNearbyDevices: false } } };
        const app = await startWithNoticeAsync(undefined, options);

        // Act
        const whileOff = app.root.querySelector('[data-banner="relay-allowance"]');
        await app.client.configureAsync({ findNearbyDevices: true });

        // Assert
        expect(whileOff).toBeNull();
        expect(app.root.querySelector('[data-banner="relay-allowance"]')).not.toBeNull();
    });
});

describe('nearby devices with a PIN', () => {
    const ATHENA = createNearbyDevice({
        nearbyId: 'nearby-athena',
        name: 'Calm Athena',
        deviceType: 'tablet',
        platform: 'iPad',
        hasPin: true,
    });

    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    async function homeWithAthenaAsync(options: TestAppOptions = {}): Promise<TestApp> {
        const app = await startAsync(options);
        app.discovery.setDevices([PIXEL, ATHENA]);
        await settleAsync();

        return app;
    }

    function pinEntry(): HTMLElement | null {
        return document.querySelector<HTMLElement>('[role="dialog"][data-sheet="pin-entry"]');
    }

    function pinInput(): HTMLInputElement | null | undefined {
        return pinEntry()?.querySelector<HTMLInputElement>('input[data-role="pin"]');
    }

    function pinError(): string | null | undefined {
        return pinEntry()?.querySelector('.form-error')?.textContent;
    }

    function type(text: string): void {
        const input = pinInput();
        if (input != null) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    async function submitPinAsync(pin?: string): Promise<void> {
        if (pin != null) {
            type(pin);
        }

        pinEntry()?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await settleAsync();
    }

    it('tags a device that has a PIN, beside its platform, and redraws a row only when that changes', async () => {
        // Arrange
        const app = await homeWithAthenaAsync();
        const pixelRow = app.root.querySelector('[data-nearby-id="nearby-pixel"]');
        const athenaRow = app.root.querySelector('[data-nearby-id="nearby-athena"]');
        const tags = (row: Element | null): Array<string | null> => texts(row ?? app.root, '.nearby-tags > *');
        const before = { pixel: tags(pixelRow), athena: tags(athenaRow) };

        // Act
        app.discovery.setDevices([{ ...PIXEL, hasPin: true }, { ...ATHENA, lastSeenAt: ATHENA.lastSeenAt + 30_000 }]);

        // Assert
        expect(before).toEqual({ pixel: ['Phone'], athena: ['iPad', 'PIN'] });
        expect(athenaRow?.querySelector('.nearby-pin .icon')).not.toBeNull();
        expect(tags(pixelRow)).toEqual(['Phone', 'PIN']);
        expect(app.root.querySelector('[data-nearby-id="nearby-pixel"]')).toBe(pixelRow);
        expect(app.root.querySelector('[data-nearby-id="nearby-athena"]')).toBe(athenaRow);
    });

    it('asks for the PIN on a numeric keypad first, then sends it and connects without an Accept there', async () => {
        // Arrange
        const app = await homeWithAthenaAsync();

        // Act
        await askAsync(app, ATHENA.name);
        const sheet = {
            title: pinEntry()?.querySelector('.dialog-title')?.textContent,
            text: pinEntry()?.querySelector('.dialog-message')?.textContent,
            inputMode: pinInput()?.getAttribute('inputmode'),
            pattern: pinInput()?.getAttribute('pattern'),
            isFocused: document.activeElement === pinInput(),
            sentBefore: app.discovery.sent.length,
        };
        await submitPinAsync('2468');
        const waiting = waitText(app.root);
        app.discovery.answer({ kind: 'accepted', answerCode: ANSWER_CODE });
        await settleAsync();

        // Assert
        expect(sheet).toEqual({
            title: 'Enter Calm Athena’s PIN',
            text: 'Calm Athena has a PIN. With it, you connect straight away.',
            inputMode: 'numeric',
            pattern: '[0-9]*',
            isFocused: true,
            sentBefore: 0,
        });
        expect(pinEntry()).toBeNull();
        expect(app.discovery.sent.map(({ nearbyId, offerCode, pin }) => ({ nearbyId, offerCode, pin }))).toEqual([
            { nearbyId: ATHENA.nearbyId, offerCode: OFFER_CODE, pin: '2468' },
        ]);
        expect(waiting).toBe('Connecting to Calm Athena…');
        expect(app.client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(app.root.dataset.screen).toBe('session');
    });

    it('keeps digits only, and checks there are 4 to 8 of them before sending anything', async () => {
        // Arrange
        const app = await homeWithAthenaAsync();
        await askAsync(app, ATHENA.name);

        // Act
        type('12a-3');
        const typed = pinInput()?.value;
        await submitPinAsync();
        const tooShort = pinError();
        await submitPinAsync('');
        const empty = pinError();
        type('1234 5678 9');

        // Assert
        expect(typed).toBe('123');
        expect(tooShort).toBe('Use 4 to 8 digits.');
        expect(empty).toBe('Enter the PIN.');
        expect(pinInput()?.value).toBe('12345678');
        expect(pinError()).toBe('');
        expect(app.discovery.sent).toEqual([]);
        expect(app.client.callsTo('startPairingAsync')).toEqual([]);
    });

    it('opens the PIN sheet again with "Wrong PIN. Try again." when the PIN was wrong', async () => {
        // Arrange
        const app = await homeWithAthenaAsync();
        await askAsync(app, ATHENA.name);
        await submitPinAsync('1111');

        // Act
        app.discovery.answer({ kind: 'wrong-pin' });
        await settleAsync();
        const reopened = { error: pinError(), value: pinInput()?.value, note: noteText(app.root) };
        await submitPinAsync('2468');

        // Assert
        expect(reopened).toEqual({ error: 'Wrong PIN. Try again.', value: '', note: undefined });
        expect(app.client.callsTo('cancelPairing')).toHaveLength(1);
        expect(app.discovery.sent.map(request => request.pin)).toEqual(['1111', '2468']);
    });

    it('asks for the PIN when a device without the PIN tag says it needs one', async () => {
        // Arrange
        const app = await homeWithAthenaAsync();
        await askAsync(app, PIXEL.name);

        // Act
        app.discovery.answer({ kind: 'pin-required' });
        await settleAsync();

        // Assert
        expect(app.discovery.sent[0]?.pin).toBeUndefined();
        expect(pinEntry()?.querySelector('.dialog-title')?.textContent).toBe(`Enter ${PIXEL.name}’s PIN`);
        expect(pinError()).toBe('');
        expect(noteText(app.root)).toBeUndefined();
    });

    it('sends nothing on Cancel or Escape, and answers busy while the PIN sheet is open', async () => {
        // Arrange
        const app = await homeWithAthenaAsync();
        await askAsync(app, ATHENA.name);

        // Act
        app.discovery.receiveRequest(createPairRequest({ requestId: 'meanwhile', from: LAPTOP }));
        buttonByText(pinEntry() ?? document.body, 'Cancel')?.click();
        await askAsync(app, ATHENA.name);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await settleAsync();

        // Assert
        expect(prompt()).toBeNull();
        expect(app.discovery.declines).toEqual([{ requestId: 'meanwhile', reason: 'busy' }]);
        expect(pinEntry()).toBeNull();
        expect(app.discovery.sent).toEqual([]);
        expect(card(app.root, ATHENA.name)?.disabled).toBe(false);
    });

    it('takes a request from the device whose PIN is being typed, without asking', async () => {
        // Arrange
        const app = await homeWithAthenaAsync();
        await askAsync(app, ATHENA.name);

        // Act
        app.discovery.receiveRequest(createPairRequest({ from: ATHENA }));
        await settleAsync();

        // Assert
        expect(pinEntry()).toBeNull();
        expect(prompt()).toBeNull();
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([['OFFERNEARBY1234']]);
        expect(app.discovery.accepts).toEqual([{ requestId: 'request-1', answerCode: ANSWER_CODE }]);
    });

    it('closes the PIN sheet when a connection takes over', async () => {
        // Arrange
        const app = await homeWithAthenaAsync({ client: { sessions: [createSession()] } });
        await askAsync(app, ATHENA.name);

        // Act
        app.client.connect();
        await settleAsync();

        // Assert
        expect(pinEntry()).toBeNull();
        expect(app.discovery.sent).toEqual([]);
    });

    it('connects without asking when the asker entered this device’s PIN, and says so', async () => {
        // Arrange
        const app = await startAsync({ client: { settings: { pin: '2468' } } });

        // Act
        app.discovery.receiveRequest(createPairRequest({ isPinVerified: true }));
        await settleAsync();

        // Assert
        expect(prompt()).toBeNull();
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([['OFFERNEARBY1234']]);
        expect(app.discovery.accepts).toEqual([{ requestId: 'request-1', answerCode: ANSWER_CODE }]);
        expect(app.root.dataset.screen).toBe('connecting');
        expect(document.querySelector('.toast')?.textContent).toBe(`${PIXEL.name} entered your PIN.`);
    });

    it('still answers busy, without connecting, a request with the PIN while another is shown', async () => {
        // Arrange
        const app = await startAsync({ client: { settings: { pin: '2468' } } });
        app.discovery.receiveRequest(createPairRequest({ from: LAPTOP }));

        // Act
        app.discovery.receiveRequest(createPairRequest({ requestId: 'request-2', isPinVerified: true }));
        await settleAsync();

        // Assert
        expect(app.discovery.declines).toEqual([{ requestId: 'request-2', reason: 'busy' }]);
        expect(app.client.callsTo('joinWithCodeAsync')).toEqual([]);
    });

    it('looks with this device’s PIN, and tells discovery when it changes or goes', async () => {
        // Arrange
        const app = await startAsync({ client: { settings: { pin: '2468' } } });

        // Act
        await app.client.configureAsync({ pin: '13579' });
        await app.client.configureAsync({ askBeforeReceiving: false });
        await app.client.configureAsync({ pin: null });

        // Assert
        expect(app.discovery.starts.map(identity => identity.pin)).toEqual(['2468', '13579', undefined]);
        expect(app.discovery.stopCount).toBe(0);
    });
});

describe('waiting for a session’s peer to show up nearby (Reconnect)', () => {
    const PEER: SessionPeer = Object.freeze({ sessionId: 'session-1', names: [PIXEL.name] });

    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    // Home with the session's peer away, and the controller Reconnect goes through.
    async function awayAsync(options: TestAppOptions = {}): Promise<{ app: TestApp; nearby: NearbyController }> {
        const app = await startAsync({ ...options, client: { sessions: [createSession()], ...options.client } });
        app.discovery.setDevices([LAPTOP]);
        await settleAsync();

        return { app, nearby: app.app.context.nearby };
    }

    it('asks a listed peer at once, the most recently seen device when several have its name', async () => {
        // Arrange
        const { app, nearby } = await awayAsync();
        const older = { ...PIXEL, nearbyId: 'nearby-old-pixel', lastSeenAt: PIXEL.lastSeenAt - 60_000 };
        app.discovery.setDevices([older, PIXEL, LAPTOP]);

        // Act
        nearby.reconnect(PEER);
        await settleAsync();

        // Assert
        expect(app.discovery.sent.map(request => request.nearbyId)).toEqual([PIXEL.nearbyId]);
        expect(nearby.view.awaited).toBeUndefined();
        expect(nearby.view.asking?.nearbyId).toBe(PIXEL.nearbyId);
    });

    it('waits for a peer that isn’t listed, and asks it as a tap on its card would once it shows up', async () => {
        // Arrange
        const { app, nearby } = await awayAsync();

        // Act
        nearby.reconnect(PEER);
        const waiting = { awaited: nearby.view.awaited, sent: app.discovery.sent.length };
        app.discovery.setDevices([LAPTOP, PIXEL]);
        await settleAsync();

        // Assert
        expect(waiting).toEqual({ awaited: PEER, sent: 0 });
        expect(nearby.view.awaited).toBeUndefined();
        expect(app.discovery.sent.map(request => request.nearbyId)).toEqual([PIXEL.nearbyId]);
        expect(waitText(app.root)).toBe(`Waiting for ${PIXEL.name} to accept…`);
        expect(cancelButton(app.root)?.closest<HTMLElement>('.nearby-item')?.dataset.nearbyId).toBe(PIXEL.nearbyId);
    });

    it.each([
        ['nearby devices are off', { settings: { findNearbyDevices: false } }, (): void => undefined],
        ['offline', {}, (app: TestApp): void => app.discovery.setStatus('offline')],
        ['connected', {}, (app: TestApp): void => void app.client.connect()],
    ] as const)('neither asks nor waits while %s', async (_, client, arrange) => {
        // Arrange
        const { app, nearby } = await awayAsync({ client });
        arrange(app);
        await settleAsync();

        // Act
        nearby.reconnect(PEER);
        await settleAsync();

        // Assert
        expect(nearby.view.awaited).toBeUndefined();
        expect(app.discovery.sent).toEqual([]);
    });

    it('waits on while another device’s request is shown, and asks the peer once that one is declined', async () => {
        // Arrange
        const { app, nearby } = await awayAsync();
        nearby.reconnect(PEER);
        app.discovery.receiveRequest(createPairRequest({ from: LAPTOP }));

        // Act
        app.discovery.setDevices([LAPTOP, PIXEL]);
        await settleAsync();
        const whilePrompted = { awaited: nearby.view.awaited, sent: app.discovery.sent.length };
        buttonByText(prompt() ?? document.body, 'Decline')?.click();
        await settleAsync();

        // Assert
        expect(whilePrompted).toEqual({ awaited: PEER, sent: 0 });
        expect(app.discovery.declines).toEqual([{ requestId: 'request-1', reason: 'declined' }]);
        expect(app.discovery.sent.map(request => request.nearbyId)).toEqual([PIXEL.nearbyId]);
    });

    it('lets the awaited peer’s own request take the wait’s place, asking first as any request does', async () => {
        // Arrange
        const { app, nearby } = await awayAsync();
        nearby.reconnect(PEER);

        // Act
        app.discovery.receiveRequest(createPairRequest());
        const title = prompt()?.querySelector('.dialog-title')?.textContent;
        app.discovery.setDevices([LAPTOP, PIXEL]);
        await settleAsync();

        // Assert
        expect(title).toBe(`${PIXEL.name} wants to connect again`);
        expect(nearby.view.awaited).toBeUndefined();
        expect(app.discovery.sent).toEqual([]);
    });

    it('keeps one wait or request at a time: a tap on a card ends the wait, and a new Reconnect replaces it', async () => {
        // Arrange
        const { app, nearby } = await awayAsync();
        const other: SessionPeer = { sessionId: 'session-2', names: [IPAD.name] };
        nearby.reconnect(PEER);

        // Act
        nearby.reconnect(other);
        const replaced = nearby.view.awaited;
        await askAsync(app, LAPTOP.name);
        app.discovery.setDevices([LAPTOP, PIXEL, IPAD]);
        await settleAsync();

        // Assert
        expect(replaced).toEqual(other);
        expect(nearby.view.awaited).toBeUndefined();
        expect(app.discovery.sent.map(request => request.nearbyId)).toEqual([LAPTOP.nearbyId]);
    });

    it('stops waiting with cancelRequest, and asks nothing when the peer shows up', async () => {
        // Arrange
        const { app, nearby } = await awayAsync();
        nearby.reconnect(PEER);
        let changes = 0;
        nearby.onChange(() => changes++);

        // Act
        nearby.cancelRequest();
        app.discovery.setDevices([PIXEL]);
        await settleAsync();

        // Assert
        expect(changes).toBeGreaterThan(0);
        expect(nearby.view.awaited).toBeUndefined();
        expect(app.discovery.sent).toEqual([]);
        expect(app.client.callsTo('cancelPairing')).toEqual([]);
    });

    it.each([
        ['Reset this device…', async (app: TestApp): Promise<void> => {
            await app.client.clearSessionFilesAsync('session-1', { scope: 'all', includeUnfinished: true });
        }],
        ['the peer’s Start fresh', async (app: TestApp): Promise<void> => {
            app.client.emit('session-reset', { sessionId: 'session-1', peerName: PIXEL.name, removed: 2 });
        }],
        ['clearing the session', async (app: TestApp): Promise<void> => {
            await app.app.context.sessions.clearAsync('session-1');
        }],
    ] as const)('stops waiting after %s', async (_, endAsync) => {
        // Arrange
        const { app, nearby } = await awayAsync();
        nearby.reconnect(PEER);

        // Act
        await endAsync(app);
        await settleAsync();
        app.discovery.setDevices([PIXEL]);
        await settleAsync();

        // Assert
        expect(nearby.view.awaited).toBeUndefined();
        expect(app.discovery.sent).toEqual([]);
    });

    it('keeps waiting when only sent or received files of the session are cleared', async () => {
        // Arrange
        const { app, nearby } = await awayAsync();
        nearby.reconnect(PEER);

        // Act
        await app.client.clearSessionFilesAsync('session-1', { scope: 'sent', includeUnfinished: false });
        await settleAsync();

        // Assert
        expect(nearby.view.awaited).toEqual(PEER);
    });
});
