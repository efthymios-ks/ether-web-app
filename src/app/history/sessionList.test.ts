import { afterEach, describe, expect, it } from 'vitest';
import { formatRelative } from '../format.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { OFFER_CODE, createSession } from '../testing/fakeClient.js';
import { createNearbyDevice } from '../testing/fakeDiscovery.js';
import { NOT_NEARBY_HINT } from './sessionList.js';

// The Previous sessions drawer (UI plan §4.8, §7.6), opened from the clock button in the header.

const PIXEL = createSession({ sessionId: 'session-1', lastConnectedAt: Date.parse('2026-11-23T09:00:00Z'), unfinishedCount: 2 });
const LAPTOP = createSession({
    sessionId: 'session-2',
    peerName: 'Windows · Calm Heron',
    peerDeviceId: 'device-laptop-5678',
    lastConnectedAt: Date.parse('2026-11-20T09:00:00Z'),
});
const PIXEL_NEARBY = createNearbyDevice();

let harness: TestApp | undefined;

async function startAsync(options: TestAppOptions = {}): Promise<TestApp> {
    harness = createTestApp({ ...options, client: { sessions: [LAPTOP, PIXEL], ...options.client } });
    await harness.app.startAsync();

    return harness;
}

function historyButton(app: TestApp): HTMLButtonElement | null {
    return app.root.querySelector<HTMLButtonElement>('[data-role="history-toggle"]');
}

function drawer(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.dialog[data-variant="drawer"]');
}

function row(sessionId: string): HTMLElement | null {
    return drawer()?.querySelector<HTMLElement>(`.session-row[data-session-id="${sessionId}"]`) ?? null;
}

function visibleTags(sessionId: string): Array<string | null> {
    return [...(row(sessionId)?.querySelectorAll<HTMLElement>('.badge:not([hidden])') ?? [])].map(tag => tag.textContent);
}

// As a tap does, the button takes focus first.
async function tapAsync(sessionId: string): Promise<void> {
    const button = row(sessionId)?.querySelector<HTMLButtonElement>('[data-action="open-session"]');
    button?.focus();
    button?.click();
    await settleAsync();
}

function choices(): Array<string | null> {
    const dialogs = [...document.querySelectorAll<HTMLElement>('.dialog')];

    return [...(dialogs.at(-1)?.querySelectorAll('[data-choice]') ?? [])].map(button => button.textContent);
}

describe('the Previous sessions drawer', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('opens from the clock button with every session, last connected first', async () => {
        // Arrange
        const app = await startAsync();

        // Act
        historyButton(app)?.click();

        // Assert
        expect(historyButton(app)?.getAttribute('aria-label')).toBe('Previous sessions');
        expect(historyButton(app)?.getAttribute('aria-expanded')).toBe('true');
        expect(drawer()?.querySelector('.dialog-title')?.textContent).toBe('Previous sessions');
        expect([...(drawer()?.querySelectorAll('.session-name') ?? [])].map(name => name.textContent))
            .toEqual(['Pixel 8 · Blue Otter', 'Windows · Calm Heron']);
        expect(row('session-1')?.querySelector('.session-meta')?.textContent)
            .toBe(`Last connected ${formatRelative(PIXEL.lastConnectedAt)}`);
        expect(visibleTags('session-1')).toEqual(['2 unfinished']);
        expect(visibleTags('session-2')).toEqual([]);
        expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    });

    it('shows each device’s platform with when it was last connected, and its kind of device as the avatar (§4.8)', async () => {
        // Arrange
        const app = await startAsync({ client: { sessions: [{ ...PIXEL, peerPlatform: 'Android' }, LAPTOP] } });

        // Act
        historyButton(app)?.click();

        // Assert
        expect(row('session-1')?.querySelector('.session-meta')?.textContent)
            .toBe(`Android · Last connected ${formatRelative(PIXEL.lastConnectedAt)}`);
        expect(row('session-1')?.querySelector('.session-avatar .icon')).not.toBeNull();
        expect(row('session-2')?.querySelector('.session-avatar')?.textContent).toBe('W');
    });

    it('says when there are no previous sessions', async () => {
        // Arrange
        const app = await startAsync({ client: { sessions: [] } });

        // Act
        historyButton(app)?.click();

        // Assert
        expect(drawer()?.querySelector('.empty-note')?.textContent).toBe('No previous sessions.');
        expect(drawer()?.querySelector<HTMLElement>('.sessions-list')?.hidden).toBe(true);
    });

    it('tags a nearby device and changes its row in place as presence comes and goes', async () => {
        // Arrange
        const app = await startAsync();
        historyButton(app)?.click();
        const before = row('session-1');

        // Act
        app.discovery.setDevices([PIXEL_NEARBY]);
        const whileNearby = visibleTags('session-1');
        app.discovery.setDevices([]);

        // Assert
        expect(whileNearby).toEqual(['Nearby', '2 unfinished']);
        expect(visibleTags('session-1')).toEqual(['2 unfinished']);
        expect(row('session-1')).toBe(before);
    });

    it('connects through nearby when the device is listed there', async () => {
        // Arrange
        const app = await startAsync();
        app.discovery.setDevices([PIXEL_NEARBY]);
        historyButton(app)?.click();

        // Act
        await tapAsync('session-1');

        // Assert
        expect(drawer()).toBeNull();
        expect(historyButton(app)?.getAttribute('aria-expanded')).toBe('false');
        expect(app.root.dataset.screen).toBe('home');
        expect(app.discovery.sent.map(({ nearbyId, offerCode }) => ({ nearbyId, offerCode })))
            .toEqual([{ nearbyId: PIXEL_NEARBY.nearbyId, offerCode: OFFER_CODE }]);
    });

    it('offers Pair with a code when the device isn’t nearby', async () => {
        // Arrange
        const app = await startAsync();
        historyButton(app)?.click();

        // Act
        await tapAsync('session-2');
        const sheet = [...document.querySelectorAll<HTMLElement>('.dialog')].at(-1);
        const sheetText = {
            title: sheet?.querySelector('.dialog-title')?.textContent,
            message: sheet?.querySelector('.dialog-message')?.textContent,
        };
        const offered = choices();
        buttonByText(document.body, 'Pair with a code')?.click();
        await settleAsync();

        // Assert
        expect(sheetText).toEqual({ title: 'Windows · Calm Heron isn’t nearby', message: NOT_NEARBY_HINT });
        expect(offered).toEqual(['Close', 'See files', 'Pair with a code']);
        expect(document.querySelector('.dialog')).toBeNull();
        expect(app.root.dataset.screen).toBe('pair');
        expect(app.client.callsTo('startPairingAsync')).toEqual([]);
    });

    it('goes back to the drawer when the sheet is closed', async () => {
        // Arrange
        const app = await startAsync();
        historyButton(app)?.click();
        await tapAsync('session-2');

        // Act
        buttonByText(document.body, 'Close')?.click();
        await settleAsync();

        // Assert
        expect(drawer()).not.toBeNull();
        expect(document.activeElement).toBe(row('session-2')?.querySelector('[data-action="open-session"]'));
        expect(app.root.dataset.screen).toBe('home');
    });

    it('opens the live session, and keeps it from being cleared', async () => {
        // Arrange
        const app = await startAsync({ client: { sessions: [{ ...PIXEL, connected: true }, LAPTOP] } });
        app.client.connect();
        await settleAsync();
        app.app.navigate({ name: 'home' });
        historyButton(app)?.click();
        const meta = row('session-1')?.querySelector('.session-meta')?.textContent;
        const isClearDisabled = row('session-1')?.querySelector<HTMLButtonElement>('[data-action="clear-session"]')?.disabled;

        // Act
        await tapAsync('session-1');

        // Assert
        expect(meta).toBe('Connected now');
        expect(isClearDisabled).toBe(true);
        expect(drawer()).toBeNull();
        expect(app.app.route).toEqual({ name: 'session', sessionId: 'session-1' });
    });

    it('says to disconnect first when another device is connected, and still opens the files', async () => {
        // Arrange
        const app = await startAsync({ client: { sessions: [{ ...PIXEL, connected: true }, LAPTOP] } });
        app.client.connect();
        await settleAsync();
        historyButton(app)?.click();

        // Act
        await tapAsync('session-2');
        const title = [...document.querySelectorAll('.dialog-title')].at(-1)?.textContent;
        const offered = choices();
        buttonByText(document.body, 'See files')?.click();
        await settleAsync();

        // Assert
        expect(title).toBe('Connected to Pixel 8 · Blue Otter');
        expect(offered).toEqual(['See files', 'OK']);
        expect(app.app.route).toEqual({ name: 'session', sessionId: 'session-2' });
        expect(app.client.callsTo('startPairingAsync')).toEqual([]);
    });

    it('clears one session after a confirm, and moves focus to the next row', async () => {
        // Arrange
        const app = await startAsync();
        historyButton(app)?.click();
        const clear = row('session-1')?.querySelector<HTMLButtonElement>('[data-action="clear-session"]');
        const label = clear?.getAttribute('aria-label');
        clear?.focus();

        // Act
        clear?.click();
        await settleAsync();
        const title = [...document.querySelectorAll('.dialog-title')].at(-1)?.textContent;
        document.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();
        await settleAsync();

        // Assert
        expect(label).toBe('Clear session with Pixel 8 · Blue Otter');
        expect(title).toBe('Clear session with Pixel 8 · Blue Otter?');
        expect(app.client.callsTo('clearSessionAsync')).toEqual([['session-1']]);
        expect(row('session-1')).toBeNull();
        expect([...document.querySelectorAll('.toast')].map(toast => toast.textContent)).toContain('Cleared Pixel 8 · Blue Otter.');
        expect(document.activeElement).toBe(row('session-2')?.querySelector('[data-action="open-session"]'));
    });

    it('leaves the session screen of a session it clears', async () => {
        // Arrange
        const app = await startAsync();
        app.app.navigate({ name: 'session', sessionId: 'session-2' });
        historyButton(app)?.click();

        // Act
        row('session-2')?.querySelector<HTMLButtonElement>('[data-action="clear-session"]')?.click();
        await settleAsync();
        document.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();
        await settleAsync();

        // Assert
        expect(app.app.route).toEqual({ name: 'home' });
        expect(app.app.context.sessions.sessions.map(session => session.sessionId)).toEqual(['session-1']);
    });
});
