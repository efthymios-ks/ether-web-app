import type { Client, StorageInfo } from '../../client/clientTypes.js';
import type { Logger } from '../../core/logger.js';
import { getDescriptor } from '../../core/settings.js';
import type { Settings } from '../../core/settings.js';
import type { Dialogs, ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { formatSize } from '../format.js';
import { ICONS } from '../icons.js';
import { THEME_PREFERENCES } from '../shell/themeController.js';
import type { ThemeController, ThemePreference } from '../shell/themeController.js';
import { openPinSheet } from './pinSheet.js';
import { openRenameSheet } from './renameSheet.js';

// The Settings sheet: the everyday settings only, one row each (AP-01). Every other setting in
// src/core/settings.ts keeps its default and is changed in code; test tools have no UI.
// It opens from the header at any time and never interrupts pairing or a transfer. Rows update in place
// while it is open, so a change made elsewhere (a rename, a system theme change) shows at once.

export interface SettingsSheetOptions {
    readonly client: Client;
    readonly dialogs: Dialogs;
    readonly theme: ThemeController;
    readonly logger: Logger;
    // Shown at the bottom, e.g. "0.1.0+a2d6bc91".
    readonly buildVersion: string;
    // DL-12: Clear all data also deletes the logs kept from the previous run.
    readonly clearSavedLogsAsync?: () => Promise<void>;
}

export interface SettingsSheet {
    readonly isOpen: boolean;
    open(): void;
    close(): void;
}

interface SettingsRow {
    readonly element: HTMLElement;
    // Brings the row up to date with the client, the theme and the storage use.
    update(): void;
}

interface RowContext extends SettingsSheetOptions {
    applyAsync(changes: Partial<Settings>): Promise<void>;
    readonly storage: StorageState;
}

interface StorageState {
    // False until the first read finishes; info stays undefined when the browser can't tell.
    isRead: boolean;
    info: StorageInfo | undefined;
    refreshAsync(): Promise<void>;
}

type RowFactory = (context: RowContext) => SettingsRow;

const THEME_LABELS: Readonly<Record<ThemePreference, string>> = Object.freeze({
    system: 'System',
    light: 'Light',
    dark: 'Dark',
});

const NO_PIN_TEXT = 'Anyone nearby can ask to connect; you accept each time.';

const CLEAR_ALL_MESSAGE = 'Deletes every session, all history, the files stored in the app and the saved logs. '
    + 'ZIPs already downloaded stay where they were saved. This cannot be undone.';

// The rows, top to bottom.
const ROWS: readonly RowFactory[] = Object.freeze([
    deviceNameRow,
    pinRow,
    switchRow('findNearbyDevices'),
    switchRow('askBeforeReceiving'),
    themeRow,
    storageRow,
]);

export function createSettingsSheet(options: SettingsSheetOptions): SettingsSheet {
    let handle: ModalHandle | undefined;
    let cleanUp: (() => void) | undefined;

    const finish = (): void => {
        cleanUp?.();
        cleanUp = undefined;
        handle = undefined;
    };

    const close = (): void => {
        const current = handle;
        finish();
        current?.close();
    };

    const open = (): void => {
        if (handle != null) {
            return;
        }

        const view = createSettingsView(options, close);
        cleanUp = view.dispose;
        handle = options.dialogs.openModal({
            title: 'Settings',
            content: view.content,
            variant: 'sheet',
            onDismiss: finish,
        });
        handle.element.dataset.sheet = 'settings';
    };

    return {
        get isOpen() {
            return handle != null;
        },
        open,
        close,
    };
}

function createSettingsView(
    options: SettingsSheetOptions,
    close: () => void,
): { readonly content: DocumentFragment; dispose(): void } {
    const { client, dialogs, logger } = options;
    const rows: SettingsRow[] = [];
    const updateAll = (): void => {
        for (const row of rows) {
            row.update();
        }
    };

    const storage: StorageState = {
        isRead: false,
        info: undefined,
        refreshAsync: async () => {
            storage.info = await client.getStorageInfoAsync().catch(() => undefined);
            storage.isRead = true;
            updateAll();
        },
    };
    const applyAsync = async (changes: Partial<Settings>): Promise<void> => {
        try {
            await client.configureAsync(changes);
            logger.info('app', `settings changed: ${Object.keys(changes).join(', ')}`, () => ({ changes }));
        } catch (error) {
            logger.warn('app', 'settings change failed', error);
            dialogs.toast('Could not save the change. Try again.', { tone: 'fail' });
        }

        updateAll();
    };

    const context: RowContext = { ...options, applyAsync, storage };
    rows.push(...ROWS.map(factory => factory(context)));
    const closeButton = h('button', {
        class: 'icon-button sheet-close',
        html: ICONS.close,
        dataset: { action: 'close', tooltip: 'Close' },
        attrs: { 'type': 'button', 'aria-label': 'Close settings' },
        on: { click: close },
    });
    const body = h('div', {
        class: 'settings-body',
        children: [
            h('div', { class: 'settings-list', children: rows.map(row => row.element) }),
            h('p', {
                class: 'settings-version',
                children: [
                    `Ether ${options.buildVersion} · `,
                    h('a', {
                        class: 'settings-licenses',
                        text: 'Open-source licenses',
                        attrs: { href: 'licenses.txt', target: '_blank', rel: 'noopener' },
                    }),
                ],
            }),
        ],
    });
    const content = document.createDocumentFragment();
    content.append(closeButton, body);

    const unsubscribers = [
        client.on('settings', updateAll),
        options.theme.onChange(updateAll),
    ];
    updateAll();
    void storage.refreshAsync();

    return {
        content,
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
    };
}

function rowText(label: HTMLElement, detail: HTMLElement | null): HTMLElement {
    return h('span', { class: 'settings-text', children: [label, detail] });
}

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

// DN-02: the name, and Change, which opens the rename sheet over this one.
function deviceNameRow(context: RowContext): SettingsRow {
    const { client, dialogs, logger } = context;
    const label = getDescriptor('deviceName').label;
    const value = h('span', { class: 'settings-detail settings-value', attrs: { id: 'settings-device-name' } });
    const element = h('div', {
        class: 'settings-row',
        dataset: { row: 'deviceName' },
        children: [
            rowText(
                h('span', { class: 'settings-label', text: label, attrs: { id: 'settings-device-name-label' } }),
                value,
            ),
            h('button', {
                class: 'button',
                text: 'Change',
                dataset: { action: 'rename' },
                attrs: { 'type': 'button', 'aria-describedby': 'settings-device-name-label settings-device-name' },
                on: { click: () => openRenameSheet({ client, dialogs, logger }) },
            }),
        ],
    });

    return { element, update: () => setText(value, client.settings.deviceName) };
}

// The PIN (SP-09): Set PIN while there is none, then Change and Remove. The PIN itself never shows.
// Set PIN and Change are one button, so focus stays on it when the PIN sheet closes.
function pinRow(context: RowContext): SettingsRow {
    const { client, dialogs, logger } = context;
    const descriptor = getDescriptor('pin');
    const detail = h('span', { class: 'settings-detail', attrs: { id: 'settings-pin-help' } });
    const setButton = h('button', {
        class: 'button',
        dataset: { action: 'set-pin' },
        attrs: { 'type': 'button', 'aria-describedby': 'settings-pin-label settings-pin-help' },
        on: { click: () => openPinSheet({ client, dialogs, logger }) },
    });

    const removeAsync = async (): Promise<void> => {
        await context.applyAsync({ pin: null });
        if (client.settings.pin == null) {
            dialogs.toast('PIN removed.', { tone: 'ok' });
            setButton.focus();
        }
    };

    const removeButton = h('button', {
        class: 'button',
        text: 'Remove',
        dataset: { action: 'remove-pin' },
        attrs: { 'type': 'button', 'aria-label': 'Remove PIN' },
        on: { click: () => void removeAsync() },
    });
    const element = h('div', {
        class: 'settings-row',
        dataset: { row: 'pin' },
        children: [
            rowText(
                h('span', { class: 'settings-label', text: descriptor.label, attrs: { id: 'settings-pin-label' } }),
                detail,
            ),
            h('div', { class: 'settings-actions', children: [setButton, removeButton] }),
        ],
    });

    return {
        element,
        update: () => {
            const hasPin = client.settings.pin != null;
            setText(detail, hasPin ? descriptor.help ?? '' : NO_PIN_TEXT);
            setText(setButton, hasPin ? 'Change' : 'Set PIN');
            removeButton.hidden = !hasPin;
        },
    };
}

// An on/off setting: its label and help from the descriptor, and a switch. The whole row is the target.
function switchRow(key: 'findNearbyDevices' | 'askBeforeReceiving'): RowFactory {
    return context => {
        const descriptor = getDescriptor(key);
        const id = `settings-${key}`;
        const input = h('input', {
            class: 'switch',
            attrs: {
                'type': 'checkbox',
                'role': 'switch',
                'id': id,
                'aria-labelledby': `${id}-label`,
                'aria-describedby': descriptor.help == null ? null : `${id}-help`,
            },
            dataset: { setting: key },
        });
        input.addEventListener('change', () => void context.applyAsync({ [key]: input.checked } as Partial<Settings>));
        const help = descriptor.help == null
            ? null
            : h('span', { class: 'settings-detail', text: descriptor.help, attrs: { id: `${id}-help` } });
        const element = h('label', {
            class: 'settings-row settings-row-switch',
            dataset: { row: key },
            children: [
                rowText(
                    h('span', { class: 'settings-label', text: descriptor.label, attrs: { id: `${id}-label` } }),
                    help,
                ),
                input,
            ],
        });

        return {
            element,
            update: () => {
                const isOn = context.client.settings[key];
                if (input.checked !== isOn) {
                    input.checked = isOn;
                }
            },
        };
    };
}

// UI-12: System, Light or Dark; the theme controller applies and stores the choice.
function themeRow(context: RowContext): SettingsRow {
    const { theme } = context;
    const buttons = THEME_PREFERENCES.map(preference => h('button', {
        class: 'segment',
        text: THEME_LABELS[preference],
        dataset: { theme: preference },
        attrs: { 'type': 'button', 'aria-pressed': 'false' },
        on: { click: () => theme.setPreference(preference) },
    }));
    const element = h('div', {
        class: 'settings-row',
        dataset: { row: 'theme' },
        children: [
            rowText(h('span', { class: 'settings-label', text: 'Theme', attrs: { id: 'settings-theme-label' } }), null),
            h('div', {
                class: 'segmented',
                attrs: { 'role': 'group', 'aria-labelledby': 'settings-theme-label' },
                children: buttons,
            }),
        ],
    });

    return {
        element,
        update: () => {
            for (const button of buttons) {
                const isPressed = String(button.dataset.theme === theme.preference);
                if (button.getAttribute('aria-pressed') !== isPressed) {
                    button.setAttribute('aria-pressed', isPressed);
                }
            }
        },
    };
}

// "1.2 GB used · 21.0 GB free", read each time the sheet opens, and Clear all data… (§16.2).
export function storageText(info: StorageInfo | undefined): string {
    const parts = [
        info?.usedBytes == null ? null : `${formatSize(info.usedBytes)} used`,
        info?.freeBytes == null ? null : `${formatSize(info.freeBytes)} free`,
    ].filter(part => part != null);

    return parts.length === 0 ? 'Use not known' : parts.join(' · ');
}

function storageRow(context: RowContext): SettingsRow {
    const { client, dialogs, logger, storage } = context;
    const usage = h('span', { class: 'settings-detail', text: 'Checking…', attrs: { id: 'settings-storage-use' } });

    const clearAllAsync = async (): Promise<void> => {
        const isConfirmed = await dialogs.confirmAsync({
            title: 'Clear all data?',
            message: CLEAR_ALL_MESSAGE,
            confirmLabel: 'Clear all data',
            danger: true,
        });
        if (!isConfirmed) {
            return;
        }

        try {
            await client.clearAllAsync();
            await context.clearSavedLogsAsync?.();
            logger.info('store', 'all data cleared');
            dialogs.toast('All data cleared.', { tone: 'ok' });
        } catch (error) {
            logger.warn('store', 'clearing failed', error);
            dialogs.toast('Could not clear. Try again.', { tone: 'fail' });
        }

        await storage.refreshAsync();
    };

    const element = h('div', {
        class: 'settings-row',
        dataset: { row: 'storage' },
        children: [
            rowText(h('span', { class: 'settings-label', text: 'Storage' }), usage),
            h('button', {
                class: 'button button-danger',
                text: 'Clear all data…',
                dataset: { action: 'clear-all' },
                attrs: { 'type': 'button', 'aria-describedby': 'settings-storage-use' },
                on: { click: () => void clearAllAsync() },
            }),
        ],
    });

    return {
        element,
        update: () => setText(usage, storage.isRead ? storageText(storage.info) : 'Checking…'),
    };
}
