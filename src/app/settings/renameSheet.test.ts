import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../core/logger.js';
import { createMemorySink } from '../../core/logSinks.js';
import { createDialogs } from '../dialogs.js';
import type { Dialogs } from '../dialogs.js';
import { createFakeAdminClient } from '../testing/adminFakes.js';
import type { FakeAdminClient } from '../testing/adminFakes.js';
import { openRenameSheet, SUGGESTION_COUNT } from './renameSheet.js';

interface Setup {
    readonly client: FakeAdminClient;
    readonly dialogs: Dialogs;
    readonly panel: HTMLElement;
    readonly input: HTMLInputElement;
    suggestions(): string[];
    submit(): void;
}

let dialogs: Dialogs | undefined;

async function settleAsync(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

// A random source that walks through the lists, so each name differs from the one before.
function steppingRandom(): () => number {
    let step = 0;

    return () => {
        step++;

        return (step * 0.137) % 1;
    };
}

function open(deviceName = 'Swift Perseus'): Setup {
    const client = createFakeAdminClient({ settings: { deviceName } });
    dialogs = createDialogs(document.body);
    const logger = createLogger({ sinks: [createMemorySink(100)] }).logger;
    const handle = openRenameSheet({ client, dialogs, logger, random: steppingRandom() });
    const panel = handle.element;
    const input = panel.querySelector<HTMLInputElement>('input[data-role="device-name"]') as HTMLInputElement;

    return {
        client,
        dialogs,
        panel,
        input,
        suggestions: () => [...panel.querySelectorAll<HTMLButtonElement>('[data-action="use-suggestion"]')]
            .filter(button => !button.hidden)
            .map(button => button.textContent ?? ''),
        submit: () => panel.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    };
}

describe('openRenameSheet', () => {
    afterEach(() => {
        dialogs?.dispose();
        dialogs = undefined;
        document.body.replaceChildren();
    });

    it('shows the name, selected and focused, with three other suggestions and More (DN-02)', () => {
        // Act
        const { panel, input, suggestions } = open();

        // Assert
        expect(panel.querySelector('.dialog-title')?.textContent).toBe('Device name');
        expect(panel.textContent).toContain('Nearby devices see this name.');
        expect(input.value).toBe('Swift Perseus');
        expect(input.maxLength).toBe(32);
        expect(document.activeElement).toBe(input);
        expect(suggestions()).toHaveLength(SUGGESTION_COUNT);
        expect(new Set(suggestions()).size).toBe(SUGGESTION_COUNT);
        expect(suggestions()).not.toContain('Swift Perseus');
        expect(panel.querySelector('[data-action="more-suggestions"]')?.getAttribute('aria-label')).toBe('More suggestions');
    });

    it('fills the field from a suggestion and saves it through the client', async () => {
        // Arrange
        const { client, input, panel, suggestions, submit } = open();
        const picked = suggestions()[1] ?? '';

        // Act
        panel.querySelectorAll<HTMLButtonElement>('[data-action="use-suggestion"]')[1]?.click();
        const filled = input.value;
        submit();
        await settleAsync();

        // Assert
        expect(filled).toBe(picked);
        expect(client.calls.rename).toEqual([picked]);
        expect(panel.isConnected).toBe(false);
        expect([...document.querySelectorAll('.toast')].map(toast => toast.textContent)).toContain('Name saved.');
    });

    it('shows other suggestions on More, in the same buttons, and keeps the focus on More', () => {
        // Arrange
        const { panel, suggestions } = open();
        const buttons = [...panel.querySelectorAll('[data-action="use-suggestion"]')];
        const before = suggestions();
        const more = panel.querySelector<HTMLButtonElement>('[data-action="more-suggestions"]');
        more?.focus();

        // Act
        more?.click();

        // Assert
        expect([...panel.querySelectorAll('[data-action="use-suggestion"]')]).toEqual(buttons);
        expect(suggestions()).toHaveLength(SUGGESTION_COUNT);
        expect(suggestions().some(name => before.includes(name))).toBe(false);
        expect(document.activeElement).toBe(more);
    });

    it('trims a typed name and refuses an empty one', async () => {
        // Arrange
        const { client, input, panel, submit } = open();
        input.value = '   ';

        // Act
        submit();
        await settleAsync();
        const error = panel.querySelector('.form-error')?.textContent;
        input.value = '  Kitchen tablet  ';
        submit();
        await settleAsync();

        // Assert
        expect(error).toBe('Enter a name.');
        expect(client.calls.rename).toEqual(['Kitchen tablet']);
    });

    it('closes without renaming on Cancel', () => {
        // Arrange
        const { client, panel } = open();

        // Act
        panel.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();

        // Assert
        expect(panel.isConnected).toBe(false);
        expect(client.calls.rename).toEqual([]);
    });

    it('closes without renaming when the name did not change', async () => {
        // Arrange
        const { client, panel, submit } = open();

        // Act
        submit();
        await settleAsync();

        // Assert
        expect(panel.isConnected).toBe(false);
        expect(client.calls.rename).toEqual([]);
    });
});
