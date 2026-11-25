import { afterEach, describe, expect, it } from 'vitest';
import type { SessionKnown } from '../../client/clientTypes.js';
import { formatRelative } from '../format.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createFileRecord, createSession } from '../testing/fakeClient.js';
import { restoreSummary } from './restorePrompt.js';

// The Restore prompt (UI plan §4.6): shown over the session when a device with history connects again.

const PEER = 'Pixel 8 · Blue Otter';
const LAST_CONNECTED = Date.parse('2026-11-23T20:07:00');

let harness: TestApp | undefined;

function known(overrides: Partial<SessionKnown> = {}): SessionKnown {
    return {
        sessionId: 'session-1',
        peerName: PEER,
        lastConnectedAt: LAST_CONNECTED,
        receivedCount: 13,
        sentCount: 8,
        unfinishedCount: 3,
        ...overrides,
    };
}

async function askedAsync(): Promise<TestApp> {
    harness = createTestApp({
        client: {
            sessions: [createSession()],
            files: [createFileRecord({ direction: 'in', state: 'done', hasData: true })],
        },
    });
    await harness.app.startAsync();
    harness.client.connect();
    await settleAsync();
    harness.client.emit('session-known', known());
    await settleAsync();

    return harness;
}

function prompt(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.dialog:has(.restore-prompt)');
}

function toasts(): Array<string | null> {
    return [...document.querySelectorAll('.toast')].map(toast => toast.textContent);
}

describe('the Restore prompt', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('asks to restore the session with the last connection and its counts, Restore first', async () => {
        // Arrange
        const app = await askedAsync();

        // Act
        const dialog = prompt();

        // Assert
        expect(dialog?.querySelector('.dialog-title')?.textContent).toBe(`Restore your session with ${PEER}?`);
        expect(dialog?.querySelector('.restore-summary')?.textContent)
            .toBe(`Last connected ${formatRelative(LAST_CONNECTED)} · 13 received, 8 sent · 3 unfinished resume.`);
        expect(dialog?.querySelector('.restore-summary strong')?.textContent).toBe('3 unfinished');
        expect(dialog?.querySelector('.restore-note')?.textContent)
            .toBe(`Start fresh clears your history with ${PEER} on both devices.`);
        expect([...(dialog?.querySelectorAll('.dialog-actions button') ?? [])].map(button => button.textContent))
            .toEqual(['Start fresh', 'Restore']);
        expect(document.activeElement?.textContent).toBe('Restore');
        expect(app.root.dataset.screen).toBe('session');
    });

    it('restores the session on Restore', async () => {
        // Arrange
        const app = await askedAsync();

        // Act
        buttonByText(document.body, 'Restore')?.click();
        await settleAsync();

        // Assert
        expect(app.client.callsTo('restoreSessionAsync')).toEqual([['session-1']]);
        expect(app.client.callsTo('startFreshAsync')).toEqual([]);
        expect(prompt()).toBeNull();
    });

    it('keeps the history when the prompt is dismissed', async () => {
        // Arrange
        const app = await askedAsync();

        // Act
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settleAsync();

        // Assert
        expect(app.client.callsTo('restoreSessionAsync')).toEqual([['session-1']]);
        expect(prompt()).toBeNull();
    });

    it('starts fresh on Start fresh and says both devices were cleared', async () => {
        // Arrange
        const app = await askedAsync();

        // Act
        buttonByText(document.body, 'Start fresh')?.click();
        await settleAsync();

        // Assert
        expect(app.client.callsTo('startFreshAsync')).toEqual([['session-1']]);
        expect(app.client.files).toEqual([]);
        expect(toasts()).toContain('Started fresh. History cleared on both devices.');
        expect(prompt()).toBeNull();
    });

    it('stays open when the link drops, and a later Start fresh says the peer clears its copy next time', async () => {
        // Arrange
        const app = await askedAsync();

        // Act
        app.client.setState('lost');
        await settleAsync();
        const isOpenAfterLoss = prompt() != null;
        buttonByText(document.body, 'Start fresh')?.click();
        await settleAsync();

        // Assert
        expect(isOpenAfterLoss).toBe(true);
        expect(toasts()).toContain(`Started fresh. ${PEER} clears its copy when you next connect.`);
    });

    it('closes with a toast when the peer starts fresh first', async () => {
        // Arrange
        const app = await askedAsync();

        // Act
        app.client.emit('session-reset', { sessionId: 'session-1', peerName: PEER, removed: 2 });
        await settleAsync();

        // Assert
        expect(prompt()).toBeNull();
        expect(toasts()).toContain(`${PEER} started fresh. Your history with it was cleared.`);
        expect(app.client.callsTo('restoreSessionAsync')).toEqual([]);
        expect(app.client.callsTo('startFreshAsync')).toEqual([]);
    });

    it('updates the open prompt in place when the same session asks again', async () => {
        // Arrange
        const app = await askedAsync();
        const before = prompt();

        // Act
        app.client.emit('session-known', known({ unfinishedCount: 1 }));
        await settleAsync();

        // Assert
        expect(prompt()).toBe(before);
        expect(document.querySelectorAll('.restore-prompt')).toHaveLength(1);
        expect(before?.querySelector('.restore-summary')?.textContent).toContain('· 1 unfinished resumes.');
    });
});

describe('restoreSummary', () => {
    it('leaves out counts that are zero', () => {
        // Arrange
        const info = known({ receivedCount: 0, sentCount: 2, unfinishedCount: 0 });

        // Act
        const text = restoreSummary(info).map(part => (typeof part === 'string' ? part : part.textContent)).join('');

        // Assert
        expect(text).toBe(`Last connected ${formatRelative(LAST_CONNECTED)} · 2 sent.`);
    });
});
