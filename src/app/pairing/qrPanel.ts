import type { AppContext } from '../appContext.js';
import { copyTextAsync } from '../clipboard.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import type { CodeKind } from './codeIntake.js';

// UI-03: a big QR, black on white in every theme, framed in the accent colour for this device's code and in the
// ok colour for a reply, with Copy code right under it, which copies the bare code. The code itself is never shown
// as text: nobody types it.

export const COPIED_LABEL_MS = 2000;

export interface QrPanelOptions {
    // `${appUrl}#${code}`: what the QR holds, so the system camera can open the app with it (HS-06).
    readonly url: string;
    // What Copy copies.
    readonly code: string;
    readonly kind: CodeKind;
    // Shown beside Copy code, e.g. "Expires in 4:59 · works once".
    readonly note?: HTMLElement;
}

export const COPY_LABEL = 'Copy code';
const BRIGHTNESS_HINT = 'Can’t scan it? Turn up the screen brightness.';

const QR_LABELS: Readonly<Record<CodeKind, string>> = Object.freeze({
    offer: 'Your pairing code as a QR code',
    reply: 'Your reply as a QR code',
});

export function createQrPanel(context: AppContext, options: QrPanelOptions): HTMLElement {
    const label = COPY_LABEL;
    const copyLabel = h('span', { text: label, attrs: { 'aria-live': 'polite' } });
    const copyButton = h('button', {
        class: 'button button-quiet qr-copy',
        dataset: { action: 'copy-code', kind: options.kind },
        attrs: { type: 'button' },
        children: [h('span', { class: 'button-icon', html: ICONS.copy }), copyLabel],
    });
    let resetTimer: ReturnType<typeof setTimeout> | undefined;

    const confirm = (): void => {
        copyLabel.textContent = 'Copied';
        copyButton.dataset.state = 'copied';
        if (resetTimer != null) {
            clearTimeout(resetTimer);
        }

        resetTimer = setTimeout(() => {
            copyLabel.textContent = label;
            delete copyButton.dataset.state;
        }, COPIED_LABEL_MS);
    };

    const copyAsync = async (): Promise<void> => {
        if (await copyTextAsync(options.code)) {
            confirm();

            return;
        }

        context.dialogs.toast('This browser won’t copy here. Scan the QR with the other device instead.', { tone: 'warn' });
    };

    copyButton.addEventListener('click', () => {
        void copyAsync();
    });

    return h('figure', {
        class: 'qr-figure',
        dataset: { kind: options.kind },
        children: [
            h('div', {
                class: 'qr-code',
                html: context.services.renderQrSvg(options.url),
                attrs: { 'role': 'img', 'aria-label': QR_LABELS[options.kind] },
            }),
            h('figcaption', {
                class: 'qr-caption',
                children: [
                    h('span', { class: 'qr-copy-row', children: [copyButton, options.note ?? null] }),
                    h('span', { class: 'qr-hint', text: BRIGHTNESS_HINT }),
                ],
            }),
        ],
    });
}
