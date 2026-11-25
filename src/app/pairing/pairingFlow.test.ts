import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError } from '../../client/clientTypes.js';
import { buttonByText, createTestApp, openPairMenuAsync, settleAsync, showMyCodeAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { ANSWER_CODE, createPeer, createSession, OFFER_CODE } from '../testing/fakeClient.js';
import {
    EXPIRED_TEXT,
    NOT_A_CODE_TEXT,
    OFFER_WHERE_REPLY_TEXT,
    REPLY_PASTED_TEXT,
    REPLY_SCANNED_TEXT,
} from './pairingFlow.js';
import { PAIR_LEAD } from './pairingScreens.js';

let harness: TestApp | undefined;

function start(options: TestAppOptions = {}): TestApp {
    harness = createTestApp(options);

    return harness;
}

// Ctrl/Cmd+V anywhere on a pairing screen: no input field is needed.
async function pasteAsync(text: string): Promise<ClipboardEvent> {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    document.body.dispatchEvent(event);
    await settleAsync();

    return event;
}

function message(root: HTMLElement): string | null | undefined {
    return [...root.querySelectorAll<HTMLElement>('.code-message')].find(element => !element.hidden)?.textContent;
}

function texts(container: ParentNode, selector: string): Array<string | null> {
    return [...container.querySelectorAll(selector)].map(element => element.textContent);
}

function screenElement(root: HTMLElement, name: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`.pairing-screen[data-screen="${name}"]`);
}

function action(root: HTMLElement, name: string): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>(`.app-pane [data-action="${name}"]`);
}

async function showOfferAsync(options: TestAppOptions = {}): Promise<TestApp> {
    const app = start(options);
    await app.app.startAsync();
    await showMyCodeAsync(app.root);

    return app;
}

async function tapAsync(button: HTMLButtonElement | null | undefined): Promise<void> {
    button?.click();
    await settleAsync();
}

describe('pairing screens', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        vi.useRealTimers();
    });

    it('opens Pair with a code from Home: Show my code, Scan a code and Paste a code, and no code box (R7)', async () => {
        // Arrange
        const { app, root } = start();
        await app.startAsync();
        const link = root.querySelector('[data-action="pair-with-code"]');

        // Act
        await openPairMenuAsync(root);
        const menu = screenElement(root, 'pair');

        // Assert
        expect(link?.textContent).toBe('Can’t see it? Pair with a code');
        expect(root.dataset.screen).toBe('pair');
        expect(menu?.querySelector('h1')?.textContent).toBe('Pair with a code');
        expect(menu?.querySelector('.screen-lead')?.textContent).toBe(PAIR_LEAD);
        expect(texts(menu ?? root, '.pair-tile')).toEqual(['Show my code', 'Scan a code']);
        expect(texts(menu ?? root, '.link-button')).toEqual(['Paste a code']);
        expect(menu?.querySelector('[data-action="back"]')?.textContent).toBe('Back');
        expect(root.querySelector('textarea, input[type="text"]')).toBeNull();
        expect(root.textContent).not.toMatch(/\boffer\b|OFFER|REPLY/);
    });

    it('shows this device’s code as a QR under "Step 1 of 2" with Copy code, never as text (HS-04, UI-03)', async () => {
        // Act
        const { root, client, wakeLock } = await showOfferAsync();
        const offer = screenElement(root, 'offer');

        // Assert
        expect(root.dataset.screen).toBe('offer');
        expect(client.callsTo('startPairingAsync')).toHaveLength(1);
        expect(offer?.querySelector('.pairing-header .pairing-step')?.textContent).toBe('Step 1 of 2');
        expect(offer?.querySelector('h1')?.textContent).toBe('Scan this on the other device');
        expect(offer?.querySelector('[data-action="back"]')?.textContent).toBe('Other options');
        expect(root.querySelector('.qr-figure')?.getAttribute('data-kind')).toBe('offer');
        expect(root.querySelector('.qr-code')?.getAttribute('aria-label')).toBe('Your pairing code as a QR code');
        expect(root.querySelector('[data-qr]')?.getAttribute('data-qr')).toBe(`https://ether.test/#${OFFER_CODE}`);
        expect(root.querySelector('[data-action="copy-code"]')?.textContent).toBe('Copy code');
        expect(root.textContent).not.toContain(OFFER_CODE);
        expect(root.querySelector('.qr-copy-row .pairing-expiry')?.textContent).toMatch(/^Expires in (5:00|4:59) · works once$/);
        expect(wakeLock.isWanted).toBe(true);
    });

    it('asks for the reply on the same screen: "Step 2 of 2 · Then get its reply", Scan reply and Paste reply', async () => {
        // Act
        const { root } = await showOfferAsync();

        // Assert
        expect(root.querySelector('.pairing-next .pairing-step')?.textContent).toBe('Step 2 of 2');
        expect(root.querySelector('.pairing-next-title')?.textContent).toBe('Then get its reply');
        expect(texts(root.querySelector('.pairing-next') ?? root, 'button')).toEqual(['Scan reply', 'Paste reply']);
        expect(root.querySelector('[data-action="scan-reply"]')?.className).toContain('button-primary');
        expect(root.querySelector('.action-bar')).toBeNull();
    });

    it('scans the reply with the camera, can show the code again, and connects on the reply', async () => {
        // Arrange
        const { root, services, client } = await showOfferAsync();

        // Act
        await tapAsync(action(root, 'scan-reply'));
        const scan = {
            screen: root.dataset.screen,
            title: root.querySelector('.app-pane h1')?.textContent,
            buttons: texts(screenElement(root, 'scan')?.querySelector('.pairing-actions') ?? root, 'button'),
        };
        await tapAsync(action(root, 'show-code-again'));
        const isQrAgain = root.querySelector('.qr-figure[data-kind="offer"]') != null;
        await tapAsync(action(root, 'scan-reply'));
        services.scanners.read(`https://ether.test/#${ANSWER_CODE}`);
        await settleAsync();

        // Assert
        expect(scan).toEqual({ screen: 'scan', title: 'Scan the reply', buttons: ['Paste instead', 'Show my code again'] });
        expect(isQrAgain).toBe(true);
        expect(client.callsTo('startPairingAsync')).toHaveLength(1);
        expect(client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(root.dataset.screen).toBe('session');
    });

    it('connects when the reply is pasted with Ctrl/Cmd+V, then shows the check code (test 4, SP-02)', async () => {
        // Arrange
        const { root, client } = await showOfferAsync();

        // Act
        const event = await pasteAsync(`  https://ether.test/#answer-dddd eeee ffff `);

        // Assert
        expect(event.defaultPrevented).toBe(true);
        expect(client.callsTo('completePairingAsync')).toEqual([['ANSWERDDDDEEEEFFFF']]);
        expect(root.dataset.screen).toBe('session');
        expect(root.querySelector('.check-code-value')?.textContent).toBe('7KQ2');
    });

    it('shows the reply, "Step 2 of 2 · Show this to the first device", when a code is pasted at home', async () => {
        // Arrange
        const { app, root, client } = start();
        await app.startAsync();

        // Act
        await pasteAsync(OFFER_CODE);
        const answer = screenElement(root, 'answer');

        // Assert
        expect(client.callsTo('joinWithCodeAsync')).toEqual([[OFFER_CODE]]);
        expect(root.dataset.screen).toBe('answer');
        expect(answer?.querySelector('.pairing-step')?.textContent).toBe('Step 2 of 2');
        expect(answer?.querySelector('h1')?.textContent).toBe('Show this to the first device');
        expect(root.querySelector('.qr-figure')?.getAttribute('data-kind')).toBe('reply');
        expect(root.querySelector('[data-action="copy-code"]')?.textContent).toBe('Copy code');
        expect(root.querySelector<HTMLElement>('.pairing-waiting')?.hidden).toBe(false);
        expect(root.querySelector('.pairing-waiting')?.textContent).toBe('Waiting for the first device to read it…');
    });

    it('explains a reply pasted at home, under the nearby devices', async () => {
        // Arrange
        const { app, root, client } = start();
        await app.startAsync();

        // Act
        await pasteAsync(ANSWER_CODE);

        // Assert
        expect(root.dataset.screen).toBe('home');
        expect(message(root)).toBe(REPLY_PASTED_TEXT);
        expect(root.querySelector('.home-panel .home-message .code-message')).not.toBeNull();
        expect(client.callsTo('completePairingAsync')).toEqual([]);
    });

    it('explains a code pasted where a reply is expected, and keeps this device’s code', async () => {
        // Arrange
        const { root, client } = await showOfferAsync();

        // Act
        await pasteAsync('OFFERZZZZYYYY');

        // Assert
        expect(root.dataset.screen).toBe('offer');
        expect(message(root)).toBe(OFFER_WHERE_REPLY_TEXT);
        expect(client.callsTo('joinWithCodeAsync')).toEqual([]);
    });

    it('says text that isn’t a code is not an Ether code', async () => {
        // Arrange
        const { app, root } = start();
        await app.startAsync();
        await openPairMenuAsync(root);

        // Act
        await pasteAsync('hello');

        // Assert
        expect(message(root)).toBe(NOT_A_CODE_TEXT);
    });

    it('explains a code that fails to pair on Pair with a code, where it was pasted', async () => {
        // Arrange
        const { app, root, client } = start();
        await app.startAsync();
        await openPairMenuAsync(root);
        client.behaviour.joinWithCodeAsync = async () => {
            throw new ClientError('code-invalid', 'bad');
        };

        // Act
        await pasteAsync(OFFER_CODE);

        // Assert
        expect(root.dataset.screen).toBe('pair');
        expect(message(root)).toBe('That code isn’t valid. Check it and try again.');
    });

    it('shows the reply when a scanned code is read, keeping the camera open for gathering (HS-05)', async () => {
        // Arrange
        const { app, root, client, services } = start({ platform: 'android' });
        await app.startAsync();
        await openPairMenuAsync(root);
        await tapAsync(action(root, 'scan-code'));
        const heading = root.querySelector('.app-pane h1')?.textContent;

        // Act
        services.scanners.read(`https://ether.test/#${OFFER_CODE}`);
        await settleAsync();

        // Assert
        expect(heading).toBe('Scan the other device’s code');
        expect(services.cameraOpens[0]).toEqual({ facingMode: { ideal: 'environment' } });
        expect(client.callsTo('joinWithCodeAsync')).toEqual([[OFFER_CODE]]);
        expect(root.dataset.screen).toBe('answer');
        expect(services.cameraStops).toEqual([1]);
    });

    it('says a scanned reply belongs to the first device', async () => {
        // Arrange
        const { app, root, services } = start();
        await app.startAsync();
        await openPairMenuAsync(root);
        await tapAsync(action(root, 'scan-code'));

        // Act
        services.scanners.read(ANSWER_CODE);
        await settleAsync();

        // Assert
        expect(message(root)).toBe(REPLY_SCANNED_TEXT);
    });

    it('says "This code expired, show a new one" for a pasted old code (HS-08)', async () => {
        // Arrange
        const { app, root, client } = start();
        await app.startAsync();

        // Act
        await pasteAsync('OLDCODE');

        // Assert
        expect(root.dataset.screen).toBe('home');
        expect(message(root)).toBe(EXPIRED_TEXT);
        expect(client.callsTo('joinWithCodeAsync')).toEqual([]);
    });

    it('shows the expired screen, with Show my code, Scan a code and Done, for an old code from a link (HS-08)', async () => {
        // Arrange
        const { app, root } = start();

        // Act
        await app.startAsync({ hashCode: 'OLDCODE' });
        const expired = screenElement(root, 'expired');

        // Assert
        expect(root.dataset.screen).toBe('expired');
        expect(root.querySelector('.app-pane h1')?.textContent).toBe('This code expired, show a new one');
        expect(texts(expired?.querySelector('.pairing-actions') ?? root, 'button')).toEqual(['Show my code', 'Scan a code', 'Done']);
    });

    it('expires the code when its countdown ends', async () => {
        // Arrange
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { app, root, client } = start();
        client.behaviour.startPairingAsync = async () => ({ code: OFFER_CODE, url: `https://ether.test/#${OFFER_CODE}`, expiresAt: Date.now() + 2000 });
        await app.startAsync();
        root.querySelector<HTMLButtonElement>('[data-action="pair-with-code"]')?.click();
        await vi.advanceTimersByTimeAsync(10);
        action(root, 'show-code')?.click();
        await vi.advanceTimersByTimeAsync(10);

        // Act
        await vi.advanceTimersByTimeAsync(3000);

        // Assert
        expect(root.dataset.screen).toBe('expired');
        expect(client.callsTo('cancelPairing').length).toBeGreaterThan(0);
    });

    it('shows the failure screen with the platform’s causes, a link to the timeline and a new start (HS-10, test 2)', async () => {
        // Arrange
        let timelineOpened = 0;
        const { root, client } = await showOfferAsync({
            app: { logViewer: { open: () => undefined, showTimeline: () => timelineOpened++ } },
        });
        client.behaviour.completePairingAsync = async () => {
            throw new ClientError('connect-timeout', 'Not connected after 15 s');
        };

        // Act
        await pasteAsync(ANSWER_CODE);
        buttonByText(root, 'Show the connection timeline')?.click();
        const failure = screenElement(root, 'failure');

        // Assert
        expect(root.dataset.screen).toBe('failure');
        expect(root.textContent).toContain('Guest Wi‑Fi or client isolation');
        expect(root.textContent).toContain('Firewall');
        expect(failure?.querySelector('.screen-lead')?.textContent)
            .toBe('They read each other’s codes but found no way to reach each other. The usual causes:');
        expect(texts(failure?.querySelector('.pairing-actions') ?? root, 'button')).toEqual(['Show my code', 'Scan a code', 'Done']);
        expect(timelineOpened).toBe(1);
    });

    it('leaves the timeline link out without ?debug=1, when there is no log viewer (DL-01)', async () => {
        // Arrange
        const { root, client } = await showOfferAsync();
        client.behaviour.completePairingAsync = async () => {
            throw new ClientError('connect-timeout', 'Not connected after 15 s');
        };

        // Act
        await pasteAsync(ANSWER_CODE);

        // Assert
        expect(root.dataset.screen).toBe('failure');
        expect(buttonByText(root, 'Show the connection timeline')).toBeUndefined();
    });

    it('creates the reply automatically from a #code link and shows the system Camera note (HS-06, test 3)', async () => {
        // Arrange
        const { app, root, client } = start({ platform: 'ios', device: { installed: true } });

        // Act
        await app.startAsync({ hashCode: `https://ether.test/#${OFFER_CODE}` });
        await settleAsync();

        // Assert
        expect(client.callsTo('joinWithCodeAsync')).toHaveLength(1);
        expect(root.dataset.screen).toBe('answer');
        expect(root.querySelector('.pairing-screen .notice')?.textContent).toContain('Camera app opens Safari');
    });

    it('passes a #reply link to the tab with the pending code (HS-07)', async () => {
        // Arrange
        const forwarded: string[] = [];
        const { app, dialogs } = start({
            relay: {
                forwardAsync: async code => {
                    forwarded.push(code);

                    return true;
                },
                dispose: () => undefined,
            },
        });

        // Act
        await app.startAsync({ hashCode: ANSWER_CODE });

        // Assert
        expect(forwarded).toEqual([ANSWER_CODE]);
        expect(dialogs.openCount).toBe(1);
        expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Pairing continued in the other tab');
    });

    it('asks to read the reply inside the app when no tab takes it (HS-07)', async () => {
        // Arrange
        const { app } = start();

        // Act
        void app.startAsync({ hashCode: ANSWER_CODE });
        await settleAsync();

        // Assert
        expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Scan the reply from inside the app');
        expect(document.querySelector('[role="dialog"] .dialog-message')?.textContent).toContain('tap Show my code again');
    });

    it('takes a reply forwarded from another tab while its code is pending (HS-07)', async () => {
        // Arrange
        const { app, root, client, relayCode } = start();
        await app.startAsync();
        const isTakenWithoutOffer = relayCode(ANSWER_CODE);
        await showMyCodeAsync(root);

        // Act
        const isTaken = relayCode(ANSWER_CODE);
        await settleAsync();

        // Assert
        expect(isTakenWithoutOffer).toBe(false);
        expect(isTaken).toBe(true);
        expect(client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(root.dataset.screen).toBe('session');
    });

    it('goes back from a step to Pair with a code with Other options, and from there to where it was opened', async () => {
        // Arrange
        const { app, root, client } = start({ client: { sessions: [createSession()] } });
        await app.startAsync();
        app.navigate({ name: 'session', sessionId: 'session-1' });
        await settleAsync();
        await tapAsync(root.querySelector<HTMLButtonElement>('.peer-bar [data-action="use-code"]'));
        await tapAsync(action(root, 'scan-code'));

        // Act
        await tapAsync(action(root, 'back'));
        const afterOtherOptions = { screen: root.dataset.screen, cancels: client.callsTo('cancelPairing').length };
        await tapAsync(action(root, 'back'));

        // Assert
        expect(afterOtherOptions).toEqual({ screen: 'pair', cancels: 1 });
        expect(app.route).toEqual({ name: 'session', sessionId: 'session-1' });
    });

    it('goes Home from the logo at any step, leaving the code (R9)', async () => {
        // Arrange
        const { root, client } = await showOfferAsync();
        const cancelsBefore = client.callsTo('cancelPairing').length;

        // Act
        await tapAsync(root.querySelector<HTMLButtonElement>('.app-header [data-role="home"]'));

        // Assert
        expect(root.dataset.screen).toBe('home');
        expect(client.callsTo('cancelPairing')).toHaveLength(cancelsBefore + 1);
        expect(root.querySelector('.qr-figure')).toBeNull();
        expect(document.activeElement?.id).toBe('home-title');
    });

    it('cancels while connecting, back to where pairing started', async () => {
        // Arrange
        const { root, client } = await showOfferAsync();
        client.behaviour.completePairingAsync = () => new Promise(() => undefined);
        await pasteAsync(ANSWER_CODE);
        const connecting = { screen: root.dataset.screen, title: root.querySelector('.app-pane h1')?.textContent };

        // Act
        await tapAsync(action(root, 'cancel'));

        // Assert
        expect(connecting).toEqual({ screen: 'connecting', title: 'Connecting…' });
        expect(root.dataset.screen).toBe('home');
        expect(client.callsTo('cancelPairing').length).toBeGreaterThan(0);
    });

    it('goes to the session when the peer connects while the reply is shown', async () => {
        // Arrange
        const { app, root, client } = start();
        await app.startAsync();
        await pasteAsync(OFFER_CODE);

        // Act
        client.connect(createPeer({ sessionId: 'session-7' }));
        await settleAsync();

        // Assert
        expect(root.dataset.screen).toBe('session');
        expect(app.route).toEqual({ name: 'session', sessionId: 'session-7' });
    });
});
