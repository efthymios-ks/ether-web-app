import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDialogs, dialogIcon } from './dialogs.js';
import { ICONS } from './icons.js';
import { settleAsync } from './testing/appHarness.js';

function setUp() {
    document.body.replaceChildren();
    const app = document.createElement('div');
    app.className = 'app';
    const opener = document.createElement('button');
    app.append(opener);
    document.body.append(app);
    opener.focus();

    return { app, opener, dialogs: createDialogs(document.body) };
}

describe('createDialogs', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves confirmAsync with the choice and returns focus to the opener', async () => {
        // Arrange
        const { opener, dialogs } = setUp();

        // Act
        const answer = dialogs.confirmAsync({ title: 'Delete?', message: 'Gone for good.', confirmLabel: 'Delete', danger: true });
        await settleAsync();
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        dialog?.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();

        // Assert
        expect(dialog?.getAttribute('aria-modal')).toBe('true');
        expect(dialog?.querySelector('[data-choice="confirm"]')?.className).toContain('button-danger');
        expect(await answer).toBe(true);
        expect(document.activeElement).toBe(opener);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('treats Escape as cancel', async () => {
        // Arrange
        const { dialogs } = setUp();
        const answer = dialogs.confirmAsync({ title: 'Leave?', message: '' });
        await settleAsync();

        // Act
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // Assert
        expect(await answer).toBe(false);
    });

    it('keeps the page behind the dialog inert until it closes', async () => {
        // Arrange
        const { app, dialogs } = setUp();

        // Act
        const choice = dialogs.chooseAsync({ title: 'Pick', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', tone: 'primary' }] });
        await settleAsync();
        const isInertWhileOpen = app.hasAttribute('inert');
        const focusedLabel = (document.activeElement as HTMLElement | null)?.textContent;
        document.querySelector<HTMLButtonElement>('[data-choice="a"]')?.click();

        // Assert
        expect(isInertWhileOpen).toBe(true);
        expect(focusedLabel).toBe('B');
        expect(await choice).toBe('a');
        expect(app.hasAttribute('inert')).toBe(false);
    });

    it('puts a dialog’s icon above its title', () => {
        // Arrange
        const { dialogs } = setUp();
        const content = document.createElement('p');

        // Act
        const handle = dialogs.openModal({ title: 'Set a PIN', icon: dialogIcon(ICONS.lock), content });

        // Assert
        expect([...handle.element.children].map(child => child.className)).toEqual(['dialog-icon', 'dialog-title', '']);
        expect(handle.element.querySelector('.dialog-icon')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('lists a menu’s choices as rows with their icons and closes it with the button beside the title', async () => {
        // Arrange
        const { dialogs } = setUp();
        const choice = dialogs.chooseAsync({
            title: 'Pixel 8',
            choices: [
                { id: 'disconnect', label: 'Disconnect', icon: ICONS.disconnect },
                { id: 'all', label: 'Reset this device…', tone: 'danger', icon: ICONS.trash },
            ],
            asMenu: true,
        });
        await settleAsync();
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const rows = [...(dialog?.querySelectorAll<HTMLButtonElement>('[data-layout="menu"] .menu-item') ?? [])];
        const shape = rows.map(row => `${row.textContent}:${row.dataset.tone ?? ''}:${row.querySelector('svg') != null}`);

        // Act
        dialog?.querySelector<HTMLButtonElement>('.sheet-close')?.click();

        // Assert
        expect(shape).toEqual(['Disconnect::true', 'Reset this device…:danger:true']);
        expect(await choice).toBeUndefined();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('wraps Tab inside the dialog', async () => {
        // Arrange
        const { dialogs } = setUp();
        void dialogs.chooseAsync({ title: 'Pick', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
        await settleAsync();
        const last = document.querySelector<HTMLButtonElement>('[data-choice="b"]');
        last?.focus();

        // Act
        last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

        // Assert
        expect((document.activeElement as HTMLElement | null)?.dataset.choice).toBe('a');
    });

    it('shows toasts in a polite live region and removes them after a while', () => {
        // Arrange
        vi.useFakeTimers();
        const { dialogs } = setUp();

        // Act
        dialogs.toast('Code copied.', { tone: 'ok', durationMs: 1000 });
        const region = document.querySelector('.toast-region');
        const shown = region?.textContent;
        vi.advanceTimersByTime(1001);

        // Assert
        expect(region?.getAttribute('aria-live')).toBe('polite');
        expect(shown).toBe('Code copied.');
        expect(region?.childElementCount).toBe(0);
    });
});
