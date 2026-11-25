import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';

// The sheets of the Sent and Received tabs (View & filter, a row's ⋯ and Details): a heading with a close
// button, then the content. A bottom sheet on portrait phones and a centred dialog elsewhere (_dialogs.scss);
// Escape, the backdrop and the close button dismiss it, and focus goes back to what opened it.

export interface FilesSheetOptions {
    readonly context: AppContext;
    readonly title: string;
    readonly children: ReadonlyArray<Node | null | undefined>;
    readonly className?: string;
    // Called once, however the sheet closes.
    readonly onClose?: () => void;
    readonly initialFocus?: HTMLElement;
}

export interface FilesSheet {
    readonly element: HTMLElement;
    close(): void;
}

export function openFilesSheet(options: FilesSheetOptions): FilesSheet {
    let isClosed = false;
    const finish = (): void => {
        if (isClosed) {
            return;
        }

        isClosed = true;
        options.onClose?.();
    };
    const closeButton = h('button', {
        class: 'icon-button files-sheet-close',
        html: ICONS.close,
        attrs: { 'type': 'button', 'aria-label': 'Close' },
    });
    const content = h('div', {
        class: options.className == null ? 'files-sheet' : `files-sheet ${options.className}`,
        children: [
            h('div', {
                class: 'files-sheet-head',
                children: [h('h2', { class: 'files-sheet-title', text: options.title }), closeButton],
            }),
            ...options.children,
        ],
    });
    const handle = options.context.dialogs.openModal({
        title: options.title,
        hideTitle: true,
        content,
        variant: 'sheet',
        onDismiss: finish,
        ...(options.initialFocus == null ? {} : { initialFocus: options.initialFocus }),
    });
    const close = (): void => {
        finish();
        handle.close();
    };
    closeButton.addEventListener('click', close);

    return { element: handle.element, close };
}
