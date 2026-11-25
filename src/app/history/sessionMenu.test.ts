import { afterEach, describe, expect, it } from 'vitest';
import type { FileRecord, GalleryItem } from '../../client/clientTypes.js';
import { FILES_GROUP_BY_KEY, FILES_VIEW_KEY } from '../gallery/filesPanel.js';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { createFileRecord, createSession } from '../testing/fakeClient.js';
import { clearPlan } from './sessionMenu.js';

// §7.6: the peer bar's ⋯ disconnects, and clears one session's files, confirmed with the client's counts.

let harness: TestApp | undefined;

function received(fileId: string, overrides: Partial<FileRecord> = {}): FileRecord {
    return createFileRecord({ fileId, direction: 'in', state: 'done', hasData: true, size: 1_000_000, ...overrides });
}

function galleryItem(fileId: string): GalleryItem {
    return {
        fileId,
        sessionId: 'session-1',
        direction: 'in',
        name: `${fileId}.jpg`,
        mime: 'image/jpeg',
        size: 1_000_000,
        kind: 'image',
        status: 'received',
        hasThumbnail: false,
        hasData: true,
    };
}

async function openSessionAsync(options: TestAppOptions, tab: 'send' | 'received' = 'received'): Promise<TestApp> {
    harness = createTestApp({
        ...options,
        client: {
            sessions: [createSession(), createSession({ sessionId: 'session-2', peerName: 'iPhone · Old Fox', peerDeviceId: 'device-2222' })],
            ...options.client,
        },
    });
    await harness.app.startAsync();
    harness.app.navigate({ name: 'session', sessionId: 'session-1', tab });
    await settleAsync(300);

    return harness;
}

function dialog(): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1) ?? null;
}

function menuLabels(): string[] {
    return [...(dialog()?.querySelectorAll<HTMLButtonElement>('[data-layout="menu"] button') ?? [])].map(button => button.textContent ?? '');
}

async function chooseAsync(label: string): Promise<void> {
    const target = dialog();
    if (target != null) {
        buttonByText(target, label)?.click();
    }

    await settleAsync();
}

async function openMenuAsync(root: HTMLElement): Promise<void> {
    root.querySelector<HTMLButtonElement>('[data-action="session-menu"]')?.click();
    await settleAsync();
}

describe('clear session data', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        document.querySelectorAll('.dialog-layer, .toast-region').forEach(layer => layer.replaceChildren());
        localStorage.clear();
    });

    it('words the confirmation from the counts, with the in-progress option unchecked', () => {
        // Act
        const plan = clearPlan('received', { finished: 120, unfinished: 3, notDownloaded: 8, bytes: 1_200_000_000 }, 'Pixel 8');
        const single = clearPlan('received', { finished: 1, unfinished: 0, notDownloaded: 1, bytes: 2_000_000 }, 'Pixel 8');

        // Assert
        expect(plan.title).toBe('Clear 120 received files (1.2 GB)?');
        expect(plan.message).toBe('8 haven’t been downloaded yet. Downloaded ZIPs keep their copies.');
        expect(plan.unfinishedOption).toBe('Also cancel and clear the 3 transfers in progress');
        expect(plan.includesUnfinished).toBe(false);
        expect(single.message).toBe('1 hasn’t been downloaded yet. Downloaded ZIPs keep their copies.');
        expect(single.unfinishedOption).toBeUndefined();
    });

    it('always includes transfers in progress when resetting, and says the peer stays paired', () => {
        // Act
        const plan = clearPlan('all', { finished: 40, unfinished: 2, notDownloaded: 0, bytes: 5_000_000 }, 'Pixel 8');

        // Assert
        expect(plan.title).toBe('Reset this device for Pixel 8?');
        expect(plan.message).toBe('Clears 40 sent and received files (5.0 MB) and cancels the 2 transfers in progress. Pixel 8 stays paired; you can send again right away.');
        expect(plan.includesUnfinished).toBe(true);
        expect(plan.confirmLabel).toBe('Reset');
    });

    it('offers only what there is to clear, from a 44 px ⋯ named More actions on the peer bar', async () => {
        // Arrange
        const { root } = await openSessionAsync({ client: { files: [received('a')] } });
        const button = root.querySelector<HTMLButtonElement>('.peer-bar [data-action="session-menu"]');

        // Act
        await openMenuAsync(root);

        // Assert
        expect(button?.getAttribute('aria-label')).toBe('More actions');
        expect(button?.classList.contains('icon-button')).toBe(true);
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('Pixel 8 · Blue Otter');
        expect(menuLabels()).toEqual(['Clear received…', 'Reset this device…']);
    });

    it('offers Disconnect first while connected, and disconnects after a confirm', async () => {
        // Arrange
        harness = createTestApp({ client: { sessions: [createSession()], files: [received('a')] } });
        await harness.app.startAsync();
        harness.client.connect();
        await settleAsync(300);

        // Act
        await openMenuAsync(harness.root);
        const labels = menuLabels();
        await chooseAsync('Disconnect');
        const title = dialog()?.querySelector('h2')?.textContent;
        await chooseAsync('Disconnect');

        // Assert
        expect(labels).toEqual(['Disconnect', 'Clear received…', 'Reset this device…']);
        expect(title).toBe('Disconnect?');
        expect(harness.client.callsTo('disconnectAsync')).toHaveLength(1);
    });

    it('says when there is nothing to clear, with only the close button', async () => {
        // Arrange
        const { root } = await openSessionAsync({});

        // Act
        await openMenuAsync(root);

        // Assert
        expect(dialog()?.textContent).toContain('Nothing to clear with Pixel 8 · Blue Otter yet.');
        expect(menuLabels()).toEqual([]);
        expect(dialog()?.querySelector<HTMLButtonElement>('.sheet-close')?.getAttribute('aria-label')).toBe('Close');
    });

    it('clears this session’s received files after a danger confirm, reloads the list and leaves other sessions alone', async () => {
        // Arrange
        const { root, client } = await openSessionAsync({
            client: {
                files: [
                    received('a', { savedAt: undefined }),
                    received('b', { savedAt: 1 }),
                    received('a', { sessionId: 'session-2' }),
                    createFileRecord({ fileId: 'moving', direction: 'in', state: 'active' }),
                ],
            },
        });
        const rowsBefore = root.querySelectorAll('#panel-received .file-row').length;

        // Act
        await openMenuAsync(root);
        await chooseAsync('Clear received…');
        const confirm = {
            title: dialog()?.querySelector('h2')?.textContent,
            message: dialog()?.querySelector('.dialog-message')?.textContent,
            option: dialog()?.querySelector('.clear-unfinished')?.textContent,
            isChecked: dialog()?.querySelector<HTMLInputElement>('.clear-unfinished input')?.checked,
            isDanger: dialog()?.querySelector('[data-choice="confirm"]')?.classList.contains('button-danger'),
        };
        await chooseAsync('Clear');
        await settleAsync(450);

        // Assert
        expect(rowsBefore).toBe(3);
        expect(confirm).toEqual({
            title: 'Clear 2 received files (2.0 MB)?',
            message: '1 hasn’t been downloaded yet. Downloaded ZIPs keep their copies.',
            option: 'Also cancel and clear the 1 transfer in progress',
            isChecked: false,
            isDanger: true,
        });
        expect(client.callsTo('clearSessionFilesAsync')).toEqual([['session-1', { scope: 'received', includeUnfinished: false }]]);
        expect(document.querySelector('.toast')?.textContent).toBe('Cleared 2 files.');
        expect([...root.querySelectorAll<HTMLElement>('#panel-received .file-row')].map(row => row.dataset.fileId)).toEqual(['moving']);
        expect(client.files.filter(file => file.sessionId === 'session-2')).toHaveLength(1);
        expect(client.files.some(file => file.fileId === 'moving')).toBe(true);
    });

    it('cancels and clears transfers in progress only when the box is ticked', async () => {
        // Arrange
        const { root, client } = await openSessionAsync({
            client: { files: [received('a'), createFileRecord({ fileId: 'moving', direction: 'in', state: 'active' })] },
        });

        // Act
        await openMenuAsync(root);
        await chooseAsync('Clear received…');
        dialog()?.querySelector<HTMLInputElement>('.clear-unfinished input')?.click();
        await chooseAsync('Clear');

        // Assert
        expect(client.callsTo('clearSessionFilesAsync')).toEqual([['session-1', { scope: 'received', includeUnfinished: true }]]);
        expect(client.files).toHaveLength(0);
    });

    it('resets the Received tiles and their selection after a reset', async () => {
        // Arrange
        localStorage.setItem(FILES_VIEW_KEY, 'tiles');
        localStorage.setItem(FILES_GROUP_BY_KEY, 'day');
        const { root, client } = await openSessionAsync({
            client: { files: [received('a'), received('b')], gallery: [{ day: '2026-11-23', items: [galleryItem('a'), galleryItem('b')] }] },
        });
        buttonByText(root, 'Select day')?.click();
        const selectedBefore = root.querySelector('.selection-count')?.textContent;

        // Act
        await openMenuAsync(root);
        await chooseAsync('Reset this device…');
        const message = dialog()?.querySelector('.dialog-message')?.textContent;
        await chooseAsync('Reset');
        await settleAsync(450);

        // Assert
        expect(selectedBefore).toBe('2 selected');
        expect(message).toContain('Pixel 8 · Blue Otter stays paired; you can send again right away.');
        expect(client.callsTo('clearSessionFilesAsync')).toEqual([['session-1', { scope: 'all', includeUnfinished: true }]]);
        expect(root.querySelectorAll('#panel-received .gallery-cell')).toHaveLength(0);
        expect(root.querySelector<HTMLElement>('#panel-received .selection-bar')?.hidden).toBe(true);
    });
});
