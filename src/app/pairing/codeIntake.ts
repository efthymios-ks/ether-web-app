import { h } from '../dom.js';
import { ICONS } from '../icons.js';

// HS-09: codes are never typed. They come in by scanning, by Paste a code / Paste reply (one tap reads the
// clipboard), by Ctrl/Cmd+V anywhere on a pairing screen, or by the #code link. Problems show in one line.

export type CodeKind = 'offer' | 'reply';

export interface CodeIntakeOptions {
    readonly kind: CodeKind;
    // What to do by hand when the clipboard can't be read.
    readonly pasteHint: string;
    // Resolves to a message to show, or undefined when the code was taken.
    readonly onCodeAsync: (text: string) => Promise<string | undefined>;
    readonly clipboard?: { readText?: () => Promise<string> };
}

export interface PasteButtonOptions {
    // "Paste a code", "Paste reply" or "Paste instead".
    readonly label: string;
    // The button's look, e.g. 'button button-primary' or 'link-button'.
    readonly className: string;
}

export interface CodeIntake {
    // The inline status line under the paste and scan buttons.
    readonly message: HTMLElement;
    pasteFromClipboardAsync(): Promise<void>;
    // Text that arrived some other way, e.g. a paste event or a scanned QR.
    pasteAsync(text: string): Promise<void>;
    setMessage(text: string | undefined): void;
    // A paste button for the screen's own content; it reads the clipboard in one tap.
    createButton(options: PasteButtonOptions): HTMLButtonElement;
    focus(): void;
}

export function createCodeIntake(options: CodeIntakeOptions): CodeIntake {
    const message = h('p', { class: 'code-message', attrs: { role: 'alert', hidden: true } });
    const buttons: HTMLButtonElement[] = [];
    let isBusy = false;

    const setMessage = (text: string | undefined): void => {
        message.textContent = text ?? '';
        message.hidden = text == null;
    };

    const setBusy = (isOn: boolean): void => {
        isBusy = isOn;
        for (const button of buttons) {
            button.disabled = isOn;
        }
    };

    const pasteAsync = async (text: string): Promise<void> => {
        const trimmed = text.trim();
        if (trimmed.length === 0 || isBusy) {
            return;
        }

        setBusy(true);
        setMessage(undefined);
        try {
            setMessage(await options.onCodeAsync(trimmed));
        } finally {
            setBusy(false);
        }
    };

    const pasteFromClipboardAsync = async (): Promise<void> => {
        const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
        if (clipboard?.readText == null) {
            setMessage(options.pasteHint);

            return;
        }

        try {
            await pasteAsync(await clipboard.readText());
        } catch {
            setMessage(options.pasteHint);
        }
    };

    return {
        message,
        pasteFromClipboardAsync,
        pasteAsync,
        setMessage,
        createButton: buttonOptions => {
            const button = h('button', {
                class: `${buttonOptions.className} code-paste`,
                dataset: { action: 'paste-code', kind: options.kind },
                attrs: { type: 'button' },
                children: [h('span', { class: 'button-icon', html: ICONS.paste }), buttonOptions.label],
                on: {
                    click: () => {
                        void pasteFromClipboardAsync();
                    },
                },
            });
            buttons.push(button);

            return button;
        },
        focus: () => buttons[0]?.focus(),
    };
}
