import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../core/logger.js';
import { createMemorySink } from '../../core/logSinks.js';
import { createDialogs } from '../dialogs.js';
import type { Dialogs } from '../dialogs.js';
import { createThemeController } from '../shell/themeController.js';
import type { ThemeController } from '../shell/themeController.js';
import { createFakeAdminClient } from '../testing/adminFakes.js';
import type { FakeAdminClient, FakeAdminClientOptions } from '../testing/adminFakes.js';
import { createSettingsSheet, storageText } from './settingsSheet.js';
import type { SettingsSheet } from './settingsSheet.js';

interface Setup {
    readonly client: FakeAdminClient;
    readonly dialogs: Dialogs;
    readonly theme: ThemeController;
    readonly sheet: SettingsSheet;
    readonly clearSavedLogsAsync: ReturnType<typeof vi.fn>;
    panel(): HTMLElement | null;
    row(name: string): HTMLElement | null;
}

let current: Setup | undefined;

async function settleAsync(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

function setup(options: { readonly client?: FakeAdminClientOptions } = {}): Setup {
    const client = createFakeAdminClient(options.client);
    const dialogs = createDialogs(document.body);
    const storage = new Map<string, string>();
    const theme = createThemeController({
        root: document.createElement('div'),
        storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        matchMedia: () => ({
            matches: false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    });
    const logger = createLogger({ sinks: [createMemorySink(100)] }).logger;
    const clearSavedLogsAsync = vi.fn(async () => undefined);
    const sheet = createSettingsSheet({ client, dialogs, theme, logger, buildVersion: '0.1.0+abcd1234', clearSavedLogsAsync });
    const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"][data-sheet="settings"]');
    current = {
        client,
        dialogs,
        theme,
        sheet,
        clearSavedLogsAsync,
        panel,
        row: name => panel()?.querySelector<HTMLElement>(`.settings-row[data-row="${name}"]`) ?? null,
    };

    return current;
}

function confirmDialog(): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .find(dialog => dialog.querySelector('[data-choice="confirm"]') != null);
}

describe('createSettingsSheet', () => {
    afterEach(() => {
        current?.sheet.close();
        current?.dialogs.dispose();
        current?.theme.dispose();
        current = undefined;
        document.body.replaceChildren();
    });

    it('shows the everyday settings only, in order, with the version at the bottom (§4.7)', async () => {
        // Arrange
        const { sheet, panel } = setup();

        // Act
        sheet.open();
        await settleAsync();
        const rows = [...(panel()?.querySelectorAll<HTMLElement>('.settings-row') ?? [])].map(row => row.dataset.row);
        const text = panel()?.textContent ?? '';

        // Assert
        expect(sheet.isOpen).toBe(true);
        expect(panel()?.querySelector('.dialog-title')?.textContent).toBe('Settings');
        expect(rows).toEqual(['deviceName', 'pin', 'findNearbyDevices', 'askBeforeReceiving', 'theme', 'storage']);
        expect(panel()?.querySelector('.settings-version')?.textContent).toBe('Ether 0.1.0+abcd1234 · Open-source licenses');
        expect(panel()?.querySelector('.settings-licenses')?.getAttribute('href')).toBe('licenses.txt');
        for (const hidden of ['Advanced', 'This session', 'Device info', 'Test tools', 'Reset all', 'log viewer', 'Page size']) {
            expect(text).not.toContain(hidden);
        }
    });

    it('shows the device name and follows a rename made elsewhere, in place', async () => {
        // Arrange
        const { client, sheet, row } = setup({ client: { settings: { deviceName: 'Swift Perseus' } } });
        sheet.open();
        const value = row('deviceName')?.querySelector('.settings-value');
        const before = value?.textContent;

        // Act
        await client.renameAsync('Calm Athena');

        // Assert
        expect(before).toBe('Swift Perseus');
        expect(row('deviceName')?.querySelector('.settings-value')).toBe(value);
        expect(value?.textContent).toBe('Calm Athena');
    });

    it('opens the rename sheet over Settings from Change', () => {
        // Arrange
        const { sheet, row } = setup();
        sheet.open();

        // Act
        row('deviceName')?.querySelector<HTMLButtonElement>('[data-action="rename"]')?.click();

        // Assert
        expect(document.querySelector('[role="dialog"][data-sheet="rename"]')).not.toBeNull();
        expect(sheet.isOpen).toBe(true);
    });

    it('offers Set PIN while there is none, and opens the PIN sheet over Settings', () => {
        // Arrange
        const { sheet, row } = setup();
        sheet.open();
        const pin = row('pin');
        const buttons = (): string[] => [...(pin?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
            .filter(button => !button.hidden)
            .map(button => button.textContent ?? '');
        const shown = { buttons: buttons(), text: pin?.querySelector('.settings-detail')?.textContent };

        // Act
        pin?.querySelector<HTMLButtonElement>('[data-action="set-pin"]')?.click();

        // Assert
        expect(shown).toEqual({
            buttons: ['Set PIN'],
            text: 'Anyone nearby can ask to connect; you accept each time.',
        });
        expect(pin?.querySelector('.settings-label')?.textContent).toBe('PIN');
        const pinSheet = document.querySelector('[role="dialog"][data-sheet="pin"]');
        expect(pinSheet?.querySelector('.dialog-title')?.textContent).toBe('Set a PIN');
        expect(sheet.isOpen).toBe(true);
    });

    it('offers Change and Remove once a PIN is set, never the PIN, and removes it in place', async () => {
        // Arrange
        const { client, sheet, row } = setup({ client: { settings: { pin: '2468' } } });
        sheet.open();
        const pin = row('pin');
        const setButton = pin?.querySelector<HTMLButtonElement>('[data-action="set-pin"]');
        const removeButton = pin?.querySelector<HTMLButtonElement>('[data-action="remove-pin"]');
        const before = {
            change: setButton?.textContent,
            isRemoveShown: removeButton?.hidden === false,
            text: pin?.querySelector('.settings-detail')?.textContent,
        };

        // Act
        removeButton?.click();
        await settleAsync();

        // Assert
        expect(before).toEqual({
            change: 'Change',
            isRemoveShown: true,
            text: 'Devices must enter it to connect to you.',
        });
        expect(pin?.textContent).not.toContain('2468');
        expect(removeButton?.getAttribute('aria-label')).toBe('Remove PIN');
        expect(client.calls.configure).toEqual([{ pin: null }]);
        expect(row('pin')).toBe(pin);
        expect(setButton?.textContent).toBe('Set PIN');
        expect(removeButton?.hidden).toBe(true);
        expect(document.activeElement).toBe(setButton);
        expect([...document.querySelectorAll('.toast')].map(toast => toast.textContent)).toContain('PIN removed.');
    });

    it('follows a PIN set in its sheet, in place, with the focus back on the same button', async () => {
        // Arrange
        const { sheet, row } = setup();
        sheet.open();
        const setButton = row('pin')?.querySelector<HTMLButtonElement>('[data-action="set-pin"]');
        setButton?.focus();
        setButton?.click();
        const pinSheet = document.querySelector<HTMLElement>('[role="dialog"][data-sheet="pin"]');
        const input = pinSheet?.querySelector<HTMLInputElement>('input[data-role="pin"]');

        // Act
        if (input != null) {
            input.value = '13579';
        }

        pinSheet?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await settleAsync();

        // Assert
        expect(setButton?.textContent).toBe('Change');
        expect(row('pin')?.querySelector<HTMLButtonElement>('[data-action="remove-pin"]')?.hidden).toBe(false);
        expect(document.activeElement).toBe(setButton);
    });

    it('asks before receiving by default and switches it off at once (SP-07)', async () => {
        // Arrange
        const { client, sheet, row } = setup();
        sheet.open();
        const input = row('askBeforeReceiving')?.querySelector<HTMLInputElement>('input[role="switch"]');
        const wasOn = input?.checked;

        // Act
        input?.click();
        await settleAsync();

        // Assert
        expect(wasOn).toBe(true);
        expect(client.calls.configure).toEqual([{ askBeforeReceiving: false }]);
        expect(client.settings.askBeforeReceiving).toBe(false);
        expect(input?.checked).toBe(false);
        expect(row('askBeforeReceiving')?.textContent).toContain('Review each batch before it arrives.');
    });

    it('turns Find nearby devices off and follows a change made elsewhere', async () => {
        // Arrange
        const { client, sheet, row } = setup();
        sheet.open();
        const input = row('findNearbyDevices')?.querySelector<HTMLInputElement>('input[role="switch"]');

        // Act
        input?.click();
        await settleAsync();
        const afterClick = input?.checked;
        await client.configureAsync({ findNearbyDevices: true });

        // Assert
        expect(afterClick).toBe(false);
        expect(client.calls.configure[0]).toEqual({ findNearbyDevices: false });
        expect(input?.checked).toBe(true);
        expect(input?.getAttribute('aria-labelledby')).toBe('settings-findNearbyDevices-label');
        expect(document.getElementById('settings-findNearbyDevices-label')?.textContent).toBe('Find nearby devices');
    });

    it('sets the theme to System, Light or Dark through the theme controller (UI-12)', () => {
        // Arrange
        const { sheet, theme, row } = setup();
        sheet.open();
        const pressed = (): string[] => [...(row('theme')?.querySelectorAll<HTMLElement>('[aria-pressed="true"]') ?? [])]
            .map(button => button.textContent ?? '');
        const before = pressed();

        // Act
        row('theme')?.querySelector<HTMLButtonElement>('[data-theme="dark"]')?.click();

        // Assert
        expect(before).toEqual(['System']);
        expect(theme.preference).toBe('dark');
        expect(theme.mode).toBe('dark');
        expect(pressed()).toEqual(['Dark']);
    });

    it('shows storage used and free', async () => {
        // Arrange
        const { sheet, row } = setup();

        // Act
        sheet.open();
        await settleAsync();

        // Assert
        expect(row('storage')?.querySelector('.settings-detail')?.textContent).toBe('1.3 GB used · 62.8 GB free');
    });

    it('clears all data and the saved logs only after a confirmation', async () => {
        // Arrange
        const { client, sheet, row, clearSavedLogsAsync } = setup();
        sheet.open();
        const clear = row('storage')?.querySelector<HTMLButtonElement>('[data-action="clear-all"]');

        // Act
        clear?.click();
        await settleAsync();
        const dialog = confirmDialog();
        const title = dialog?.querySelector('.dialog-title')?.textContent;
        dialog?.querySelector<HTMLButtonElement>('[data-choice="cancel"]')?.click();
        await settleAsync();
        const afterCancel = client.calls.clearAllCount;
        clear?.click();
        await settleAsync();
        confirmDialog()?.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();
        await settleAsync();

        // Assert
        expect(clear?.textContent).toBe('Clear all data…');
        expect(title).toBe('Clear all data?');
        expect(afterCancel).toBe(0);
        expect(client.calls.clearAllCount).toBe(1);
        expect(clearSavedLogsAsync).toHaveBeenCalledOnce();
        expect([...document.querySelectorAll('.toast')].map(toast => toast.textContent)).toContain('All data cleared.');
    });

    it('closes from its close button and with Escape, giving the focus back', () => {
        // Arrange
        const { sheet, panel } = setup();
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        sheet.open();
        panel()?.querySelector<HTMLButtonElement>('.sheet-close')?.click();
        const afterClose = { isOpen: sheet.isOpen, focus: document.activeElement };
        sheet.open();

        // Act
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // Assert
        expect(afterClose).toEqual({ isOpen: false, focus: opener });
        expect(sheet.isOpen).toBe(false);
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('opens once, however often the button is pressed', () => {
        // Arrange
        const { sheet } = setup();

        // Act
        sheet.open();
        sheet.open();

        // Assert
        expect(document.querySelectorAll('[data-sheet="settings"]')).toHaveLength(1);
    });
});

describe('storageText', () => {
    it('reads used and free, whichever the browser tells', () => {
        // Act & Assert
        expect(storageText({ usedBytes: 1_200_000_000, freeBytes: 21_000_000_000, persisted: false }))
            .toBe('1.2 GB used · 21.0 GB free');
        expect(storageText({ usedBytes: 5_000_000, persisted: false })).toBe('5.0 MB used');
        expect(storageText(undefined)).toBe('Use not known');
    });
});
