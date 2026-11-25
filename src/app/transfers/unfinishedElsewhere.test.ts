import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { createFileRecord, createPeer, createSession, createUnfinishedElsewhere } from '../testing/fakeClient.js';
import { openRowMenu } from '../gallery/rowMenu.js';
import { createFileActions } from './fileActions.js';
import { lineStatus } from './progressLine.js';

let harness: TestApp | undefined;

async function connectAsync(options: TestAppOptions = {}): Promise<TestApp> {
    harness = createTestApp({ ...options, client: { sessions: [createSession()], ...options.client } });
    await harness.app.startAsync();
    harness.client.connect();
    await settleAsync();

    return harness;
}

function card(): HTMLElement | null {
    return document.querySelector('#panel-send .unfinished-elsewhere .prompt-card');
}

describe('unfinished files from other devices', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('offers to send one old device’s unfinished files to the connected peer, and reports the result', async () => {
        // Arrange
        const { client } = await connectAsync();
        client.unfinishedElsewhere = [createUnfinishedElsewhere()];

        // Act
        client.emit('unfinished-elsewhere', client.unfinishedElsewhere);
        const text = card()?.querySelector('.prompt-text')?.textContent;
        card()?.querySelector<HTMLButtonElement>('[data-action="send-unfinished"]')?.click();
        await settleAsync();

        // Assert
        expect(text).toBe('3 unfinished files from iPhone · Old Fox (12.0 MB). Send them to Pixel 8 · Blue Otter?');
        expect(client.callsTo('sendUnfinishedHereAsync')).toEqual([[['session-old']]]);
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent).toBe('2 sent, 1 to pick again');
        expect(card()).toBeNull();
    });

    it('lists them when the connected session opens, combined for several old devices', async () => {
        // Arrange
        const groups = [
            createUnfinishedElsewhere({ sessionId: 'old-1', peerName: 'iPhone · Old Fox', fileCount: 3, totalBytes: 12_000_000 }),
            createUnfinishedElsewhere({ sessionId: 'old-2', peerName: 'iPad · Calm Heron', fileCount: 2, totalBytes: 3_000_000, readyCount: 2 }),
        ];

        // Act
        const { client } = await connectAsync({ client: { unfinishedElsewhere: groups } });
        card()?.querySelector<HTMLButtonElement>('[data-action="send-unfinished"]')?.click();
        const text = card()?.querySelector('.prompt-text')?.textContent;
        const rows = [...(card()?.querySelectorAll('.unfinished-elsewhere-list li') ?? [])].map(row => row.textContent);
        await settleAsync();

        // Assert
        expect(text).toBe('5 unfinished files from 2 other devices (15.0 MB). Send them to Pixel 8 · Blue Otter?');
        expect(rows).toEqual(['iPhone · Old Fox: 3 files (12.0 MB)', 'iPad · Calm Heron: 2 files (3.0 MB)']);
        expect(client.callsTo('sendUnfinishedHereAsync')).toEqual([[['old-1', 'old-2']]]);
    });

    it('keeps Not now for this connection only', async () => {
        // Arrange
        const { client } = await connectAsync({ client: { unfinishedElsewhere: [createUnfinishedElsewhere()] } });
        await settleAsync();

        // Act
        card()?.querySelector<HTMLButtonElement>('[data-action="dismiss-unfinished"]')?.click();
        client.emit('unfinished-elsewhere', client.unfinishedElsewhere);
        const isHiddenAfterDismiss = card() == null;
        client.setState('lost');
        client.connect({ connectionId: 'connection-2' });
        await settleAsync();

        // Assert
        expect(isHiddenAfterDismiss).toBe(true);
        expect(card()?.querySelector('.prompt-text')?.textContent).toContain('3 unfinished files');
        expect(client.callsTo('sendUnfinishedHereAsync')).toEqual([]);
    });

    it('shows a moved record as Moved, its row sheet saying where it went, without actions', async () => {
        // Arrange
        const { app } = await connectAsync();
        const record = createFileRecord({ sessionId: 'session-old', state: 'canceled', note: 'moved' });

        // Act
        openRowMenu({ context: app.context, actions: createFileActions(app.context), record: () => record, onDetails: () => undefined });
        const sheet = document.querySelector('.files-row-menu');

        // Assert
        expect(lineStatus(record, 'iPhone · Old Fox').text).toBe('Moved');
        expect(sheet?.querySelector('.files-note')?.textContent).toBe('Moved to Pixel 8 · Blue Otter');
        expect(sheet?.querySelectorAll('[data-action]')).toHaveLength(0);
    });
});

describe('the peer closed its page', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('says Disconnected on the red peer bar, with the paused transfers and the pairing actions', async () => {
        // Arrange
        const { client, root } = await connectAsync({
            client: { files: [createFileRecord({ state: 'paused', pausedBy: 'link', name: 'IMG_2231.MOV' })] },
        });

        // Act
        client.emit('peer', 'left', createPeer());
        client.setState('closed');
        await settleAsync();

        // Assert
        const status = root.querySelector<HTMLElement>('.peer-bar');
        expect(status?.dataset.link).toBe('ended');
        expect(status?.querySelector('.peer-name')?.textContent).toBe('Pixel 8 · Blue Otter');
        expect(status?.querySelector('.status-sub')?.textContent).toBe('Disconnected · 1 paused');
        expect(status?.querySelector<HTMLElement>('.status-sub')?.title).toBe('IMG_2231.MOV');
        expect([...(status?.querySelectorAll('.status-side button:not([hidden])') ?? [])].map(button => button.textContent)).toEqual(['Reconnect', 'Use a code']);
        expect(root.querySelector('.action-bar')).toBeNull();
    });

    it('keeps Connection lost when the link drops without bye', async () => {
        // Arrange
        const { client, root } = await connectAsync();

        // Act
        client.setState('lost');
        await settleAsync();

        // Assert
        expect(root.querySelector<HTMLElement>('.peer-bar')?.dataset.link).toBe('lost');
        expect(root.querySelector('.peer-bar .status-sub')?.textContent).toBe('Connection lost');
    });
});
