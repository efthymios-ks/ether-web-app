import type { Client } from '../../client/clientTypes.js';
import type { Logger } from '../../core/logger.js';
import { isValidPin, PIN_FORMAT_TEXT } from '../../core/pin.js';
import { dialogIcon } from '../dialogs.js';
import type { Dialogs, ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import { createPinInput } from './pinInput.js';

// The Set a PIN sheet (SP-09): 4 to 8 digits, and Remove PIN once there is one. Nearby devices must then enter
// the PIN to connect, and a right one connects without an Accept here. It opens from the Settings row, and is
// exported for Home's PIN beside the name. The PIN is saved as a setting and never shown or logged.

export interface PinSheetOptions {
    readonly client: Client;
    readonly dialogs: Dialogs;
    readonly logger: Logger;
}

export const PIN_SHEET_TEXT = 'Devices must enter it to connect to you. '
    + 'With a PIN, you don’t need to accept each request.';

export function openPinSheet(options: PinSheetOptions): ModalHandle {
    const { client, dialogs, logger } = options;
    const hasPin = client.settings.pin != null;
    let handle: ModalHandle | undefined;
    let isSaving = false;

    const error = h('p', { class: 'form-error', attrs: { id: 'pin-sheet-error', role: 'alert' } });
    const input = createPinInput({
        label: 'New PIN, 4 to 8 digits',
        placeholder: '4–8 digits',
        autocomplete: 'off',
        describedBy: 'pin-sheet-help pin-sheet-error',
        onInput: () => {
            error.textContent = '';
        },
    });

    const applyAsync = async (pin: string | null): Promise<void> => {
        isSaving = true;
        try {
            await client.configureAsync({ pin });
            logger.info('app', pin == null ? 'PIN removed' : 'PIN set');
            handle?.close();
            dialogs.toast(pin == null ? 'PIN removed.' : 'PIN set.', { tone: 'ok' });
        } catch (failure) {
            logger.warn('app', 'PIN not saved', failure);
            error.textContent = 'Could not save the PIN. Try again.';
        } finally {
            isSaving = false;
        }
    };

    const save = (): void => {
        const pin = input.value;
        if (!isValidPin(pin)) {
            error.textContent = PIN_FORMAT_TEXT;
            input.focus();

            return;
        }

        void applyAsync(pin);
    };

    const removeButton = hasPin
        ? h('button', {
            class: 'button button-danger',
            text: 'Remove PIN',
            dataset: { action: 'remove-pin' },
            attrs: { type: 'button' },
            on: {
                click: () => {
                    if (!isSaving) {
                        void applyAsync(null);
                    }
                },
            },
        })
        : null;
    const form = h('form', {
        class: 'pin-form',
        attrs: { novalidate: true },
        children: [
            input,
            error,
            h('div', {
                class: 'dialog-actions',
                dataset: { layout: 'row' },
                children: [
                    removeButton,
                    h('button', {
                        class: 'button',
                        text: 'Cancel',
                        dataset: { action: 'cancel' },
                        attrs: { type: 'button' },
                        on: { click: () => handle?.close() },
                    }),
                    h('button', { class: 'button button-primary', text: 'Save', attrs: { type: 'submit' } }),
                ],
            }),
        ],
        on: {
            submit: event => {
                event.preventDefault();
                if (!isSaving) {
                    save();
                }
            },
        },
    });
    const content = h('div', {
        class: 'dialog-body',
        children: [
            h('p', { class: 'dialog-message', text: PIN_SHEET_TEXT, attrs: { id: 'pin-sheet-help' } }),
            form,
        ],
    });

    handle = dialogs.openModal({
        title: hasPin ? 'Change your PIN' : 'Set a PIN',
        icon: dialogIcon(ICONS.lock),
        content,
        variant: 'sheet',
        initialFocus: input,
    });
    handle.element.dataset.sheet = 'pin';

    return handle;
}
