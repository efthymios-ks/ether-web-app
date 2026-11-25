import { isValidPin, PIN_FORMAT_TEXT } from '../../core/pin.js';
import type { NearbyDevice } from '../../discovery/discoveryTypes.js';
import { dialogIcon } from '../dialogs.js';
import type { Dialogs, ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import { createPinInput } from '../settings/pinInput.js';

// "Enter X's PIN": asked before a request to a nearby device that has a PIN (SP-10). Connect sends the request
// with a proof of the PIN, and a right one connects without an Accept there.
// Cancel, Escape and the backdrop send nothing.

export const WRONG_PIN_TEXT = 'Wrong PIN. Try again.';

export interface PinEntryOptions {
    readonly device: NearbyDevice;
    // Shown at once, e.g. WRONG_PIN_TEXT after the device turned the last PIN down.
    readonly error?: string;
    readonly onSubmit: (pin: string) => void;
    readonly onCancel: () => void;
}

export function openPinEntrySheet(dialogs: Dialogs, options: PinEntryOptions): ModalHandle {
    const { name } = options.device;
    let handle: ModalHandle | undefined;

    const error = h('p', {
        class: 'form-error',
        text: options.error ?? '',
        attrs: { id: 'pin-entry-error', role: 'alert' },
    });
    const input = createPinInput({
        label: 'PIN',
        placeholder: 'PIN',
        autocomplete: 'one-time-code',
        describedBy: 'pin-entry-help pin-entry-error',
        onInput: () => {
            error.textContent = '';
        },
    });

    const submit = (): void => {
        const pin = input.value;
        if (!isValidPin(pin)) {
            error.textContent = pin === '' ? 'Enter the PIN.' : PIN_FORMAT_TEXT;
            input.focus();

            return;
        }

        handle?.close();
        options.onSubmit(pin);
    };

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
                    h('button', {
                        class: 'button',
                        text: 'Cancel',
                        dataset: { action: 'cancel' },
                        attrs: { type: 'button' },
                        on: {
                            click: () => {
                                handle?.close();
                                options.onCancel();
                            },
                        },
                    }),
                    h('button', {
                        class: 'button button-primary',
                        text: 'Connect',
                        dataset: { action: 'connect-with-pin' },
                        attrs: { type: 'submit' },
                    }),
                ],
            }),
        ],
        on: {
            submit: event => {
                event.preventDefault();
                submit();
            },
        },
    });
    const content = h('div', {
        class: 'dialog-body',
        children: [
            h('p', {
                class: 'dialog-message',
                text: `${name} has a PIN. With it, you connect straight away.`,
                attrs: { id: 'pin-entry-help' },
            }),
            form,
        ],
    });

    handle = dialogs.openModal({
        title: `Enter ${name}’s PIN`,
        icon: dialogIcon(ICONS.lock),
        content,
        variant: 'sheet',
        onDismiss: options.onCancel,
        initialFocus: input,
    });
    handle.element.dataset.sheet = 'pin-entry';

    return handle;
}
