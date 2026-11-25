import { afterEach, describe, expect, it } from 'vitest';
import { buttonByText, createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createFileRecord, createSession } from '../testing/fakeClient.js';
import { checkHint } from './sessionStatus.js';

// The peer bar: one compact row on every layout, red with the pairing actions once the link is gone.

let harness: TestApp | undefined;

async function openAsync(isConnected: boolean): Promise<TestApp> {
    harness = createTestApp({
        client: {
            sessions: [createSession()],
            files: [
                createFileRecord({ fileId: 'a', name: 'IMG_2231.MOV', state: 'paused' }),
                createFileRecord({ fileId: 'b', name: 'IMG_2232.MOV', state: 'paused' }),
            ],
        },
    });
    await harness.app.startAsync();
    if (isConnected) {
        harness.client.connect();
    }

    harness.app.navigate({ name: 'session', sessionId: 'session-1', tab: 'send' });
    await settleAsync(200);

    return harness;
}

function bar(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>('.peer-bar');
}

function visibleButtons(root: HTMLElement): Array<string | undefined> {
    return [...(bar(root)?.querySelectorAll<HTMLButtonElement>('.status-side button:not([hidden])') ?? [])]
        .map(button => button.textContent?.trim());
}

describe('peer bar', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        document.querySelectorAll('.toast-region, .dialog-layer').forEach(layer => layer.replaceChildren());
    });

    it('shows the check code as a chip whose tap says what both screens must show (SP-02)', async () => {
        // Arrange
        const { root } = await openAsync(true);
        const chip = bar(root)?.querySelector<HTMLButtonElement>('.check-chip');

        // Act
        chip?.click();

        // Assert
        expect(checkHint('7KQ2')).toBe('Both screens must show 7KQ2. If not, disconnect.');
        expect(chip?.querySelector('.check-chip-label')?.textContent).toBe('Check');
        expect(chip?.querySelector('.check-code-value')?.textContent).toBe('7KQ2');
        expect(chip?.getAttribute('aria-label')).toBe('Check code 7 K Q 2. Both screens must show 7KQ2. If not, disconnect.');
        expect(chip?.title).toBe(checkHint('7KQ2'));
        expect([...document.querySelectorAll('.toast')].map(toast => toast.textContent)).toContain(checkHint('7KQ2'));
    });

    it('puts the avatar, the name and "Connected", the chip and ⋯ in one row, with Disconnect behind ⋯', async () => {
        // Act
        const { root } = await openAsync(true);

        // Assert
        expect([...(bar(root)?.children ?? [])].map(child => child.className))
            .toEqual(['peer-avatar', 'peer-text', 'status-side', 'icon-button session-menu']);
        expect(bar(root)?.querySelector('.peer-avatar')?.textContent).toBe('P');
        expect(bar(root)?.querySelector('.peer-name')?.textContent).toBe('Pixel 8 · Blue Otter');
        expect(bar(root)?.querySelector('.health-text')?.textContent).toBe('Connected');
        expect(buttonByText(bar(root) ?? root, 'Disconnect')).toBeUndefined();
    });

    it('tags the connected peer with its platform and its kind of device, and shows no tag when it sent none', async () => {
        // Arrange
        const { root, client } = await openAsync(true);
        const withoutTag = bar(root)?.querySelector('.peer-platform');

        // Act
        client.connect({ platform: 'iPad' });
        await settleAsync();

        // Assert
        expect(withoutTag).toBeNull();
        expect(bar(root)?.querySelector('.peer-health .peer-platform')?.textContent).toBe('iPad');
        expect(bar(root)?.querySelector('.peer-avatar svg')).not.toBeNull();
        expect(bar(root)?.querySelector('.health-text')?.textContent).toBe('Connected');
    });

    it('turns red when the link is lost: "Connection lost · 2 paused" with Reconnect first, every paused file in its tooltip', async () => {
        // Arrange
        const { root, client } = await openAsync(true);

        // Act
        client.setState('lost');
        await settleAsync(200);

        // Assert
        expect(bar(root)?.dataset.link).toBe('lost');
        expect(bar(root)?.querySelector('.peer-name')?.textContent).toBe('Pixel 8 · Blue Otter');
        expect(bar(root)?.querySelector('.status-sub')?.textContent).toBe('Connection lost · 2 paused');
        expect(bar(root)?.querySelector<HTMLElement>('.status-sub')?.title).toBe('IMG_2231.MOV, IMG_2232.MOV');
        expect(visibleButtons(root)).toEqual(['Reconnect', 'Use a code']);
        expect(bar(root)?.querySelector('[data-action="use-code"]')?.classList.contains('button-primary')).toBe(false);
        expect(bar(root)?.querySelector('.check-chip')).toBeNull();
    });

    it('shows the last connection in one small line when not connected', async () => {
        // Act
        const { root } = await openAsync(false);

        // Assert
        expect(bar(root)?.dataset.link).toBe('offline');
        expect(bar(root)?.querySelector('.peer-name')?.textContent).toBe('Pixel 8 · Blue Otter');
        expect(bar(root)?.querySelector('.status-sub')?.textContent).toMatch(/^Not connected · last connected /);
        expect(visibleButtons(root)).toEqual(['Reconnect', 'Use a code']);
    });

    it('pairs with a code from Use a code: Pair with a code opens, and Show my code shows this device’s code', async () => {
        // Arrange
        const { root, client } = await openAsync(false);

        // Act
        bar(root)?.querySelector<HTMLButtonElement>('[data-action="use-code"]')?.click();
        await settleAsync();
        const screen = root.dataset.screen;
        root.querySelector<HTMLButtonElement>('[data-screen="pair"] [data-action="show-code"]')?.click();
        await settleAsync();

        // Assert
        expect(screen).toBe('pair');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(client.callsTo('startPairingAsync')).toHaveLength(1);
        expect(root.dataset.screen).toBe('offer');
    });

    it('has no action bar: picking is on the Send tab, and pairing again on the bar', async () => {
        // Arrange
        const { root, client } = await openAsync(true);
        const whileConnected = root.querySelector('.action-bar');

        // Act
        client.setState('lost');
        await settleAsync();

        // Assert
        expect(whileConnected).toBeNull();
        expect(root.querySelector('.action-bar')).toBeNull();
        expect(visibleButtons(root)).toEqual(['Reconnect', 'Use a code']);
    });
});
