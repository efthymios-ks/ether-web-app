import type { Client } from '../../client/clientTypes.js';
import { suggestDeviceNames } from '../../core/deviceInfo.js';
import type { Logger } from '../../core/logger.js';
import { getDescriptor } from '../../core/settings.js';
import type { TextDescriptor } from '../../core/settings.js';
import type { Dialogs, ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';

// DN-02: the device name, typed or picked from three default-style suggestions; More shows three others.
// Saving renames through the client, which also tells a connected peer. The suggestions keep their buttons
// when More changes them, so More stays under the finger and keeps the focus.

export interface RenameSheetOptions {
    readonly client: Client;
    readonly dialogs: Dialogs;
    readonly logger: Logger;
    // Test seam for the suggestions.
    readonly random?: () => number;
}

export const SUGGESTION_COUNT = 3;

export function openRenameSheet(options: RenameSheetOptions): ModalHandle {
    const { client, dialogs, logger } = options;
    const descriptor = getDescriptor('deviceName') as TextDescriptor;
    const currentName = client.settings.deviceName;
    let handle: ModalHandle | undefined;
    let isSaving = false;

    const input = h('input', {
        class: 'text-input',
        attrs: {
            'type': 'text',
            'value': currentName,
            'maxlength': descriptor.maxLength,
            'autocomplete': 'off',
            'autocapitalize': 'words',
            'spellcheck': 'false',
            'enterkeyhint': 'done',
            'aria-label': descriptor.label,
            'aria-describedby': 'rename-help rename-error',
        },
        dataset: { role: 'device-name' },
    });
    const error = h('p', { class: 'form-error', attrs: { id: 'rename-error', role: 'alert' } });

    const showSuggestion = (button: HTMLButtonElement, name: string | undefined): void => {
        button.hidden = name == null;
        button.textContent = name ?? '';
        button.dataset.name = name ?? '';
    };

    const suggestionButtons = Array.from({ length: SUGGESTION_COUNT }, () => h('button', {
        class: 'name-suggestion',
        attrs: { type: 'button' },
        dataset: { action: 'use-suggestion' },
        on: {
            click: event => {
                input.value = (event.currentTarget as HTMLButtonElement).dataset.name ?? '';
                error.textContent = '';
                input.focus();
            },
        },
    }));

    const suggest = (): void => {
        const shown = suggestionButtons.map(button => button.dataset.name ?? '').filter(name => name !== '');
        const names = suggestDeviceNames(SUGGESTION_COUNT, {
            exclude: [currentName, input.value, ...shown],
            ...(options.random == null ? {} : { random: options.random }),
        });
        suggestionButtons.forEach((button, index) => showSuggestion(button, names[index]));
    };

    const moreButton = h('button', {
        class: 'name-suggestion',
        attrs: { 'type': 'button', 'aria-label': 'More suggestions' },
        dataset: { action: 'more-suggestions' },
        children: [h('span', { class: 'name-suggestion-icon', html: ICONS.retry }), 'More'],
        on: { click: () => suggest() },
    });

    const saveAsync = async (): Promise<void> => {
        const name = input.value.trim();
        const length = [...name].length;
        if (length < descriptor.minLength) {
            error.textContent = 'Enter a name.';
            input.focus();

            return;
        }

        if (length > descriptor.maxLength) {
            error.textContent = `Use ${descriptor.minLength}–${descriptor.maxLength} characters.`;
            input.focus();

            return;
        }

        if (name === client.settings.deviceName) {
            handle?.close();

            return;
        }

        isSaving = true;
        try {
            await client.renameAsync(name);
            logger.info('app', 'device renamed');
            handle?.close();
            dialogs.toast('Name saved.', { tone: 'ok' });
        } catch (failure) {
            logger.warn('app', 'rename failed', failure);
            error.textContent = 'Could not save the name. Try again.';
        } finally {
            isSaving = false;
        }
    };

    const form = h('form', {
        class: 'rename-form',
        attrs: { novalidate: true },
        children: [
            input,
            h('div', {
                class: 'name-suggestions',
                attrs: { 'role': 'group', 'aria-label': 'Suggestions' },
                children: [...suggestionButtons, moreButton],
            }),
            error,
            h('div', {
                class: 'dialog-actions',
                dataset: { layout: 'row' },
                children: [
                    h('button', {
                        class: 'button',
                        text: 'Cancel',
                        attrs: { type: 'button' },
                        dataset: { action: 'cancel' },
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
                    void saveAsync();
                }
            },
        },
    });
    input.addEventListener('input', () => {
        error.textContent = '';
    });

    suggest();
    const content = h('div', {
        class: 'dialog-body',
        children: [
            descriptor.help == null
                ? null
                : h('p', { class: 'dialog-message', text: descriptor.help, attrs: { id: 'rename-help' } }),
            form,
        ],
    });
    handle = dialogs.openModal({ title: descriptor.label, content, variant: 'sheet', initialFocus: input });
    handle.element.dataset.sheet = 'rename';
    input.select();

    return handle;
}
