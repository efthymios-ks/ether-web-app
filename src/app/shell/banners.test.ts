import { beforeEach, describe, expect, it } from 'vitest';
import { createBanners, DISMISS_KEY_PREFIX } from './banners.js';
import type { BannerHandlers, BannerState } from './banners.js';

const IDLE: BannerState = {
    updateReady: false,
    isTransferring: false,
    testTools: [],
    wakeUnsupported: false,
};

function createHandlers(): BannerHandlers & { calls: string[] } {
    const calls: string[] = [];

    return {
        calls,
        applyUpdate: () => calls.push('applyUpdate'),
        turnOffTestTools: () => calls.push('turnOffTestTools'),
        promptInstall: () => calls.push('promptInstall'),
        showInstallSteps: () => calls.push('showInstallSteps'),
        copyLink: () => calls.push('copyLink'),
    };
}

describe('createBanners', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('shows nothing when there is nothing to say', () => {
        // Arrange
        const banners = createBanners(createHandlers());

        // Act
        banners.update(IDLE);

        // Assert
        expect(banners.visibleIds()).toEqual([]);
        expect(banners.element.hidden).toBe(true);
    });

    it('offers the update only when no transfer runs (PW-03)', () => {
        // Arrange
        const handlers = createHandlers();
        const banners = createBanners(handlers);

        // Act
        banners.update({ ...IDLE, updateReady: true, isTransferring: true });
        const buttonsDuringTransfer = banners.element.querySelectorAll('button').length;
        banners.update({ ...IDLE, updateReady: true });
        banners.element.querySelector<HTMLButtonElement>('[data-banner="update"] button')?.click();

        // Assert
        expect(buttonsDuringTransfer).toBe(0);
        expect(handlers.calls).toEqual(['applyUpdate']);
    });

    it('shows Keep the app open only during a transfer on platforms that suspend (WL-04)', () => {
        // Arrange
        const banners = createBanners(createHandlers());
        const warning = 'Keep the app open until done.';

        // Act
        banners.update({ ...IDLE, backgroundWarning: warning });
        const idle = banners.visibleIds();
        banners.update({ ...IDLE, backgroundWarning: warning, isTransferring: true });

        // Assert
        expect(idle).toEqual([]);
        expect(banners.visibleIds()).toEqual(['keep-open']);
    });

    it('flags active test tools with a way to turn them off (§16.3)', () => {
        // Arrange
        const handlers = createHandlers();
        const banners = createBanners(handlers);

        // Act
        banners.update({ ...IDLE, testTools: ['corrupt-pages', 'drop-ack'] });
        banners.element.querySelector<HTMLButtonElement>('[data-banner="test-tools"] button')?.click();

        // Assert
        expect(banners.element.textContent).toContain('corrupt pages, drop acks');
        expect(handlers.calls).toEqual(['turnOffTestTools']);
    });

    it('remembers a dismissed install banner across visits (PW-05)', () => {
        // Arrange
        const state: BannerState = { ...IDLE, install: { method: 'instructions', canPrompt: false } };
        const first = createBanners(createHandlers());
        first.update(state);

        // Act
        first.element.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')?.click();
        const second = createBanners(createHandlers());
        second.update(state);

        // Assert
        expect(first.visibleIds()).toEqual([]);
        expect(second.visibleIds()).toEqual([]);
        expect(localStorage.getItem(`${DISMISS_KEY_PREFIX}install`)).toBe('1');
    });

    it('keeps this screen open where Wake Lock is missing, and warns in in-app browsers first (WL-03, DD-08)', () => {
        // Arrange
        const handlers = createHandlers();
        const banners = createBanners(handlers);

        // Act
        banners.update({ ...IDLE, wakeUnsupported: true, inAppNote: 'Open this page in Safari.' });
        banners.element.querySelector<HTMLButtonElement>('[data-banner="in-app"] button')?.click();
        const first = banners.visibleIds();
        banners.update({ ...IDLE, wakeUnsupported: true });

        // Assert
        expect(first).toEqual(['in-app']);
        expect(handlers.calls).toEqual(['copyLink']);
        expect(banners.visibleIds()).toEqual(['wake']);
    });

    it('shows one notice at a time, by priority, and the next once the first is dismissed', () => {
        // Arrange
        const banners = createBanners(createHandlers());
        const state: BannerState = {
            ...IDLE,
            updateReady: true,
            install: { method: 'instructions', canPrompt: false },
            identityNote: 'Safari and the Home Screen app keep separate history.',
        };
        banners.update({ ...state, updateReady: false });
        const installFirst = banners.visibleIds();

        // Act
        banners.update(state);
        const updateFirst = banners.visibleIds();
        banners.update({ ...state, updateReady: false });
        banners.element.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')?.click();

        // Assert
        expect(installFirst).toEqual(['install']);
        expect(updateFirst).toEqual(['update']);
        expect(banners.visibleIds()).toEqual(['identity']);
        expect(banners.element.querySelectorAll('.banner')).toHaveLength(1);
    });

    it('keeps the notice and its buttons in place while nothing it says changes', () => {
        // Arrange
        const banners = createBanners(createHandlers());
        banners.update({ ...IDLE, updateReady: true });
        const button = banners.element.querySelector('[data-banner="update"] button');

        // Act
        banners.update({ ...IDLE, updateReady: true });
        banners.update({ ...IDLE, updateReady: true, testTools: [] });
        const kept = banners.element.querySelector('[data-banner="update"] button');
        banners.update({ ...IDLE, updateReady: true, isTransferring: true });

        // Assert
        expect(kept).toBe(button);
        expect(banners.element.querySelector('[data-banner="update"] button')).toBeNull();
        expect(banners.element.textContent).toContain('once the transfer finishes');
    });
});
