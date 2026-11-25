import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, openPairMenuAsync, settleAsync, showMyCodeAsync } from '../testing/appHarness.js';
import type { TestApp, TestAppOptions } from '../testing/appHarness.js';
import { ANSWER_CODE, FAKE_APP_URL, OFFER_CODE } from '../testing/fakeClient.js';
import { COPIED_LABEL_MS, COPY_LABEL } from './qrPanel.js';

let harness: TestApp | undefined;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

interface FakeClipboard {
    readText?: () => Promise<string>;
    writeText?: (text: string) => Promise<void>;
}

function useClipboard(clipboard: FakeClipboard | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

async function startAsync(options: TestAppOptions = {}): Promise<TestApp> {
    harness = createTestApp(options);
    await harness.app.startAsync();

    return harness;
}

async function showOfferAsync(options: TestAppOptions = {}): Promise<TestApp> {
    const app = await startAsync(options);
    await showMyCodeAsync(app.root);

    return app;
}

// Pair with a code, then Paste a code.
async function pasteFromMenuAsync(root: HTMLElement): Promise<void> {
    await openPairMenuAsync(root);
    root.querySelector<HTMLButtonElement>('[data-screen="pair"] [data-action="paste-code"]')?.click();
    await settleAsync();
}

function visibleMessage(root: HTMLElement): string | null | undefined {
    return [...root.querySelectorAll<HTMLElement>('.code-message')].find(element => !element.hidden)?.textContent;
}

describe('Copy and Paste', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        vi.useRealTimers();
        vi.unstubAllGlobals();
        if (originalClipboard != null) {
            Object.defineProperty(navigator, 'clipboard', originalClipboard);
        }
    });

    it('copies the bare code from Copy code under the QR and confirms it, never showing it', async () => {
        // Arrange
        const copied: string[] = [];
        useClipboard({ writeText: async text => {
            copied.push(text);
        } });
        const { root } = await showOfferAsync();
        const button = root.querySelector<HTMLButtonElement>('.qr-figure [data-action="copy-code"]');

        // Act
        button?.click();
        await settleAsync();

        // Assert
        expect(copied).toEqual([OFFER_CODE]);
        expect(root.querySelector('.qr-code svg')?.getAttribute('data-qr')).toBe(`${FAKE_APP_URL}#${OFFER_CODE}`);
        expect(root.textContent).not.toContain(OFFER_CODE);
        expect(button?.textContent).toBe('Copied');
    });

    it('puts the label back after a moment', async () => {
        // Arrange
        vi.useFakeTimers({ shouldAdvanceTime: true });
        useClipboard({ writeText: async () => undefined });
        const { root } = await showOfferAsync();
        const button = root.querySelector<HTMLButtonElement>('[data-action="copy-code"]');
        button?.click();
        await vi.advanceTimersByTimeAsync(10);

        // Act
        await vi.advanceTimersByTimeAsync(COPIED_LABEL_MS);

        // Assert
        expect(button?.textContent).toBe(COPY_LABEL);
    });

    it('falls back to the copy command, and says to scan when copying isn’t allowed at all', async () => {
        // Arrange
        useClipboard({ writeText: async () => {
            throw new DOMException('denied', 'NotAllowedError');
        } });
        const commands: string[] = [];
        let isCopyAllowed = true;
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            value: (command: string) => {
                commands.push(command);

                return isCopyAllowed;
            },
        });
        const { root } = await showOfferAsync();
        const button = root.querySelector<HTMLButtonElement>('[data-action="copy-code"]');

        // Act
        button?.click();
        await settleAsync();
        const firstLabel = button?.textContent;
        isCopyAllowed = false;
        button?.click();
        await settleAsync();

        // Assert
        expect(commands).toEqual(['copy', 'copy']);
        expect(firstLabel).toBe('Copied');
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent).toContain('Scan the QR with the other device');
        expect(document.querySelector('.copy-buffer')).toBeNull();
    });

    it('pastes a code from Pair with a code and shows the reply in one tap, normalising a full link', async () => {
        // Arrange
        useClipboard({ readText: async () => `  https://ether.test/#offer-aaaa bbbb-cccc ` });
        const { root, client } = await startAsync();

        // Act
        await pasteFromMenuAsync(root);

        // Assert
        expect(client.callsTo('joinWithCodeAsync')).toEqual([[OFFER_CODE]]);
        expect(root.dataset.screen).toBe('answer');
    });

    it('pastes the reply under this device’s code and connects', async () => {
        // Arrange
        useClipboard({ readText: async () => ANSWER_CODE });
        const { root, client } = await showOfferAsync();

        // Act
        root.querySelector<HTMLButtonElement>('.pairing-next [data-action="paste-code"]')?.click();
        await settleAsync();

        // Assert
        expect(client.callsTo('completePairingAsync')).toEqual([[ANSWER_CODE]]);
        expect(root.dataset.screen).toBe('session');
    });

    it('quietly takes a pasted link as well as a bare code', async () => {
        // Arrange
        useClipboard({ readText: async () => `  ${FAKE_APP_URL}#${ANSWER_CODE}
` });
        const { root, client } = await showOfferAsync();

        // Act
        root.querySelector<HTMLButtonElement>('.pairing-next [data-action="paste-code"]')?.click();
        await settleAsync();

        // Assert
        expect(client.callsTo('completePairingAsync')).toHaveLength(1);
        expect(String(client.callsTo('completePairingAsync')[0]?.[0])).toContain(ANSWER_CODE);
        expect(root.dataset.screen).toBe('session');
    });

    it('tells desktop users to allow clipboard access or press Ctrl+V', async () => {
        // Arrange
        useClipboard(undefined);
        const { root } = await startAsync();

        // Act
        await pasteFromMenuAsync(root);

        // Assert
        expect(visibleMessage(root)).toBe('Allow clipboard access, or press Ctrl+V.');
    });

    it('says Cmd+V on a Mac, and to allow pasting on phones, when reading is refused', async () => {
        // Arrange
        useClipboard({ readText: async () => {
            throw new DOMException('denied', 'NotAllowedError');
        } });
        const mac = await startAsync({ device: { os: 'macOS' } });
        await pasteFromMenuAsync(mac.root);
        const macHint = visibleMessage(mac.root);
        mac.dispose();

        // Act
        const phone = await startAsync({ platform: 'android' });
        await pasteFromMenuAsync(phone.root);

        // Assert
        expect(macHint).toBe('Allow clipboard access, or press Cmd+V.');
        expect(visibleMessage(phone.root)).toBe('Allow pasting when your browser asks.');
    });

    it('labels Copy and Paste with text and keeps them in the keyboard order', async () => {
        // Act
        const { root } = await showOfferAsync();

        // Assert
        const copy = root.querySelector<HTMLButtonElement>('[data-action="copy-code"]');
        const paste = root.querySelector<HTMLButtonElement>('.pairing-next [data-action="paste-code"]');
        expect(copy?.textContent).toBe('Copy code');
        expect(paste?.textContent).toBe('Paste reply');
        expect(copy?.tabIndex).toBe(0);
        expect(paste?.tabIndex).toBe(0);
    });
});

describe('without a camera', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('offers Show my code and Paste a code as the two choices (HS-09, test 4)', async () => {
        // Arrange
        const { root, services } = await startAsync({ services: { camera: 'none' } });

        // Act
        await openPairMenuAsync(root);
        const menu = root.querySelector<HTMLElement>('[data-screen="pair"]');

        // Assert
        expect([...(menu?.querySelectorAll('.pair-tile') ?? [])].map(tile => tile.textContent)).toEqual(['Show my code', 'Paste a code']);
        expect(menu?.querySelector('[data-action="scan-code"]')).toBeNull();
        expect(menu?.querySelector('.link-button')).toBeNull();
        expect(services.cameraOpens).toEqual([]);
    });

    it('asks for the reply with Paste reply only while the code waits', async () => {
        // Act
        const { root } = await showOfferAsync({ services: { camera: 'none' } });

        // Assert
        expect(root.querySelector('[data-action="scan-reply"]')).toBeNull();
        expect(root.querySelector('.pairing-next [data-action="paste-code"]')?.className).toContain('button-primary');
    });

    it('shows Paste instead without trying the camera on the scan screen', async () => {
        // Arrange
        const { app, root, services } = await startAsync({ services: { camera: 'none' } });

        // Act
        app.navigate({ name: 'scan', purpose: 'offer' });
        await settleAsync();

        // Assert
        expect(root.querySelector('.scan-frame')?.getAttribute('data-state')).toBe('unavailable');
        expect(root.querySelector('.scan-status')?.textContent).toBe('No camera on this device. Use Paste instead.');
        expect(services.cameraOpens).toEqual([]);
        expect(document.activeElement).toBe(root.querySelector('[data-screen="scan"] [data-action="paste-code"]'));
        expect(document.activeElement?.textContent).toBe('Paste instead');
    });
});
