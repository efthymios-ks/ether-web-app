import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../core/logger.js';
import type { LogEntry } from '../../core/logger.js';
import { createMemorySink } from '../../core/logSinks.js';
import { createDialogs } from '../dialogs.js';
import type { Dialogs } from '../dialogs.js';
import { createFakeAdminClient } from '../testing/adminFakes.js';
import type { FakeAdminClient, FakeAdminClientOptions } from '../testing/adminFakes.js';
import { openPinSheet, PIN_SHEET_TEXT } from './pinSheet.js';

interface Setup {
    readonly client: FakeAdminClient;
    readonly panel: HTMLElement;
    readonly input: HTMLInputElement;
    error(): string | null | undefined;
    type(text: string): void;
    submit(): void;
    entries(): LogEntry[];
}

let dialogs: Dialogs | undefined;

async function settleAsync(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

function toasts(): Array<string | null> {
    return [...document.querySelectorAll('.toast')].map(toast => toast.textContent);
}

function open(options: FakeAdminClientOptions = {}): Setup {
    const client = createFakeAdminClient(options);
    dialogs = createDialogs(document.body);
    const memory = createMemorySink(100);
    const logger = createLogger({ sinks: [memory] }).logger;
    const panel = openPinSheet({ client, dialogs, logger }).element;
    const input = panel.querySelector<HTMLInputElement>('input[data-role="pin"]') as HTMLInputElement;

    return {
        client,
        panel,
        input,
        error: () => panel.querySelector('.form-error')?.textContent,
        type: text => {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        },
        submit: () => panel.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        entries: () => memory.entries(),
    };
}

describe('openPinSheet', () => {
    afterEach(() => {
        dialogs?.dispose();
        dialogs = undefined;
        document.body.replaceChildren();
    });

    it('asks for a new PIN of 4 to 8 digits on a numeric keypad, with no Remove while there is none', () => {
        // Act
        const { panel, input } = open();

        // Assert
        expect(panel.dataset.sheet).toBe('pin');
        expect(panel.querySelector('.dialog-title')?.textContent).toBe('Set a PIN');
        expect(panel.querySelector('.dialog-message')?.textContent).toBe(PIN_SHEET_TEXT);
        expect(input.getAttribute('inputmode')).toBe('numeric');
        expect(input.getAttribute('pattern')).toBe('[0-9]*');
        expect(input.getAttribute('placeholder')).toBe('4–8 digits');
        expect(input.getAttribute('aria-label')).toBe('New PIN, 4 to 8 digits');
        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
        expect(panel.querySelector('[data-action="remove-pin"]')).toBeNull();
    });

    it('keeps digits only, saves the PIN and says so, and never logs it', async () => {
        // Arrange
        const { client, panel, type, submit, entries } = open();

        // Act
        type('24-68 ab');
        submit();
        await settleAsync();

        // Assert
        expect(client.calls.configure).toEqual([{ pin: '2468' }]);
        expect(client.settings.pin).toBe('2468');
        expect(panel.isConnected).toBe(false);
        expect(toasts()).toContain('PIN set.');
        expect(entries().map(entry => entry.msg)).toContain('PIN set');
        expect(JSON.stringify(entries())).not.toContain('2468');
    });

    it.each([
        ['too short', '123'],
        ['empty', ''],
    ])('refuses a PIN that is %s and says what a PIN is', async (_, pin) => {
        // Arrange
        const { client, panel, type, submit, error } = open();
        type(pin);

        // Act
        submit();
        await settleAsync();

        // Assert
        expect(error()).toBe('Use 4 to 8 digits.');
        expect(client.calls.configure).toEqual([]);
        expect(panel.isConnected).toBe(true);
    });

    it('clears the error as soon as the PIN is typed again', () => {
        // Arrange
        const { type, submit, error } = open();
        submit();

        // Act
        type('1');

        // Assert
        expect(error()).toBe('');
    });

    it('changes or removes a PIN that is set, and never shows it', async () => {
        // Arrange
        const { client, panel, input } = open({ settings: { pin: '2468' } });
        const title = panel.querySelector('.dialog-title')?.textContent;
        const shown = input.value;

        // Act
        panel.querySelector<HTMLButtonElement>('[data-action="remove-pin"]')?.click();
        await settleAsync();

        // Assert
        expect(title).toBe('Change your PIN');
        expect(shown).toBe('');
        expect(client.calls.configure).toEqual([{ pin: null }]);
        expect(client.settings.pin).toBeNull();
        expect(panel.isConnected).toBe(false);
        expect(toasts()).toContain('PIN removed.');
    });

    it('closes on Cancel without saving', () => {
        // Arrange
        const { client, panel, type } = open();
        type('2468');

        // Act
        panel.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();

        // Assert
        expect(panel.isConnected).toBe(false);
        expect(client.calls.configure).toEqual([]);
    });

    it('stays open and says so when the PIN can’t be saved', async () => {
        // Arrange
        const { panel, type, submit, error } = open({ failConfigure: true });
        type('2468');

        // Act
        submit();
        await settleAsync();

        // Assert
        expect(error()).toBe('Could not save the PIN. Try again.');
        expect(panel.isConnected).toBe(true);
    });
});
