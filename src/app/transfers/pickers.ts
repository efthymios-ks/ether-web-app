import type { PickerButton, PickerKind, Platform } from '../../platform/platform.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';

// §5: the platform's pickers (PK-01…PK-03) as tiles on the Send tab, and the hidden inputs behind them.
// Folder picks keep webkitRelativePath.

export interface PickedFiles {
    readonly files: File[];
    readonly relativePaths: (string | undefined)[];
}

export interface PickersOptions {
    readonly platform: Platform;
    readonly onPick: (picked: PickedFiles) => void;
    // PK-05: files picked again for needs-file items.
    readonly onResumePick: (files: File[]) => void;
}

export interface Pickers {
    // Hidden inputs; the shell keeps them in the page.
    readonly inputs: HTMLElement;
    open(kind: PickerKind): void;
    openResume(): void;
}

const PICKER_ICONS: Readonly<Record<PickerKind, string>> = Object.freeze({
    media: ICONS.photo,
    files: ICONS.file,
    folder: ICONS.folder,
});

export function filesFromInput(input: HTMLInputElement): PickedFiles {
    const files = [...(input.files ?? [])];
    const relativePaths = files.map(file => {
        const path = (file as { webkitRelativePath?: string }).webkitRelativePath ?? '';

        return path.length > 0 ? path : undefined;
    });

    return { files, relativePaths };
}

// One tile per picker the platform offers, in its order: Photos & videos and Files on phones, Files and Folder
// on desktop. Every tile is an equal choice, so they share one look.
export function createPickerTiles(platform: Platform, onPick: (kind: PickerKind) => void): HTMLButtonElement[] {
    return platform.pickerButtons().map(button => h('button', {
        class: 'picker-tile',
        dataset: { action: `pick-${button.kind}` },
        attrs: { type: 'button' },
        children: [
            h('span', { class: 'picker-tile-icon', html: PICKER_ICONS[button.kind], attrs: { 'aria-hidden': 'true' } }),
            h('span', { text: button.label }),
        ],
        on: { click: () => onPick(button.kind) },
    }));
}

export function createPickers(options: PickersOptions): Pickers {
    const buttons = options.platform.pickerButtons();
    const inputs = new Map<PickerKind, HTMLInputElement>();
    const container = h('div', { class: 'picker-inputs', attrs: { hidden: true } });

    const createInput = (button: PickerButton): HTMLInputElement => {
        const input = h('input', {
            dataset: { picker: button.kind },
            attrs: {
                'type': 'file',
                'multiple': button.multiple,
                'accept': button.accept.length > 0 ? button.accept : null,
                'webkitdirectory': button.directory,
                'tabindex': '-1',
                'aria-hidden': 'true',
            },
        });
        input.addEventListener('change', () => {
            const picked = filesFromInput(input);
            input.value = '';
            if (picked.files.length > 0) {
                options.onPick(picked);
            }
        });

        return input;
    };

    for (const button of buttons) {
        const input = createInput(button);
        inputs.set(button.kind, input);
        container.append(input);
    }

    const resumeInput = h('input', {
        dataset: { picker: 'resume' },
        attrs: { 'type': 'file', 'multiple': true, 'tabindex': '-1', 'aria-hidden': 'true' },
    });
    resumeInput.addEventListener('change', () => {
        const files = [...(resumeInput.files ?? [])];
        resumeInput.value = '';
        if (files.length > 0) {
            options.onResumePick(files);
        }
    });
    container.append(resumeInput);

    return {
        inputs: container,
        open: kind => {
            inputs.get(kind)?.click();
        },
        openResume: () => resumeInput.click(),
    };
}
