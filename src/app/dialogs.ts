import type { ConfirmAsync, ConfirmOptions } from './appTypes.js';
import { h } from './dom.js';
import { ICONS } from './icons.js';

export type Tone = 'info' | 'ok' | 'warn' | 'fail';

export interface DialogChoice {
    readonly id: string;
    readonly label: string;
    readonly tone?: 'primary' | 'danger' | 'default';
    // A menu row's icon: trusted markup from ICONS.
    readonly icon?: string;
}

export interface ChooseOptions {
    readonly title: string;
    readonly message?: string;
    // Extra content under the message, e.g. a list of steps.
    readonly body?: Node;
    readonly choices: readonly DialogChoice[];
    // An action menu: one row per choice with its icon, and a close button beside the title.
    readonly asMenu?: boolean;
}

export interface ModalOptions {
    // The accessible name; also the visible title unless `hideTitle` is set.
    readonly title: string;
    readonly hideTitle?: boolean;
    // A round icon above the title, e.g. the device that asks or a lock.
    readonly icon?: Node;
    readonly content: Node;
    // A drawer slides in from the inline end at full height, e.g. Previous sessions.
    readonly variant?: 'dialog' | 'sheet' | 'drawer' | 'fullscreen';
    // Escape, the backdrop and the close button call it; the modal closes afterwards.
    readonly onDismiss?: () => void;
    readonly initialFocus?: HTMLElement;
}

export interface ModalHandle {
    readonly element: HTMLElement;
    close(): void;
}

export interface ToastOptions {
    readonly tone?: Tone;
    readonly durationMs?: number;
}

export interface Dialogs {
    confirmAsync: ConfirmAsync;
    // Resolves to the chosen id, or undefined when dismissed.
    chooseAsync(options: ChooseOptions): Promise<string | undefined>;
    alertAsync(options: { title: string; message?: string; body?: Node }): Promise<void>;
    openModal(options: ModalOptions): ModalHandle;
    toast(message: string, options?: ToastOptions): void;
    readonly openCount: number;
    dispose(): void;
}

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

const TOAST_LIMIT = 3;
let titleCounter = 0;

// The round icon above a dialog's title, from trusted ICONS markup, e.g. a lock.
export function dialogIcon(icon: string): HTMLElement {
    return h('span', { class: 'dialog-icon', html: icon, attrs: { 'aria-hidden': 'true' } });
}

export function focusableWithin(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => !element.closest('[hidden], [inert]'));
}

// Keeps Tab and Shift+Tab inside the container; returns the remover.
export function trapFocus(container: HTMLElement): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Tab') {
            return;
        }

        const items = focusableWithin(container);
        const first = items[0];
        const last = items.at(-1);
        if (first == null || last == null) {
            event.preventDefault();

            return;
        }

        const active = document.activeElement;
        if (event.shiftKey && (active === first || !container.contains(active))) {
            event.preventDefault();
            last.focus();

            return;
        }

        if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    };

    container.addEventListener('keydown', onKeyDown);

    return () => container.removeEventListener('keydown', onKeyDown);
}

export function createDialogs(host: HTMLElement = document.body): Dialogs {
    const layer = h('div', { class: 'dialog-layer' });
    const toastRegion = h('div', {
        class: 'toast-region',
        attrs: { 'role': 'status', 'aria-live': 'polite' },
    });
    const stack: Array<{ element: HTMLElement; dismiss(): void }> = [];
    const inerted = new Set<Element>();

    host.append(layer, toastRegion);

    const setBackgroundInert = (isInert: boolean): void => {
        if (!isInert) {
            for (const element of inerted) {
                element.removeAttribute('inert');
            }

            inerted.clear();

            return;
        }

        for (const element of [...host.children]) {
            if (element === layer || element === toastRegion || element.hasAttribute('inert')) {
                continue;
            }

            element.setAttribute('inert', '');
            inerted.add(element);
        }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') {
            return;
        }

        const top = stack.at(-1);
        if (top == null) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        top.dismiss();
    };

    document.addEventListener('keydown', onKeyDown, true);

    const openModal = (options: ModalOptions): ModalHandle => {
        const titleId = `dialog-title-${++titleCounter}`;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const title = h('h2', { class: 'dialog-title', text: options.title, attrs: { id: titleId, hidden: options.hideTitle === true } });
        const panel = h('div', {
            class: 'dialog',
            dataset: { variant: options.variant ?? 'dialog' },
            attrs: { 'role': 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'tabindex': '-1' },
            children: [options.icon ?? null, title, options.content],
        });
        const backdrop = h('div', { class: 'dialog-backdrop', children: [panel] });
        let isClosed = false;

        const close = (): void => {
            if (isClosed) {
                return;
            }

            isClosed = true;
            removeTrap();
            backdrop.remove();
            const index = stack.findIndex(item => item.element === panel);
            if (index >= 0) {
                stack.splice(index, 1);
            }

            if (stack.length === 0) {
                setBackgroundInert(false);
            }

            if (previousFocus?.isConnected === true) {
                previousFocus.focus();
            }
        };

        const dismiss = (): void => {
            options.onDismiss?.();
            close();
        };

        backdrop.addEventListener('click', event => {
            if (event.target === backdrop) {
                dismiss();
            }
        });

        const removeTrap = trapFocus(panel);
        stack.push({ element: panel, dismiss });
        setBackgroundInert(true);
        layer.append(backdrop);
        const target = options.initialFocus ?? focusableWithin(panel)[0] ?? panel;
        target.focus();

        return { element: panel, close };
    };

    const chooseAsync = (options: ChooseOptions): Promise<string | undefined> => new Promise(resolve => {
        let handle: ModalHandle | undefined;
        const finish = (id: string | undefined): void => {
            resolve(id);
            handle?.close();
        };
        const isMenu = options.asMenu === true;
        // A menu's rows carry their icons; a dialog's buttons share one row.
        const buttons = options.choices.map(choice => (isMenu
            ? h('button', {
                class: 'menu-item',
                attrs: { type: 'button' },
                dataset: { choice: choice.id, ...(choice.tone === 'danger' ? { tone: 'danger' } : {}) },
                children: [
                    h('span', { class: 'menu-icon', html: choice.icon ?? '', attrs: { 'aria-hidden': 'true' } }),
                    choice.label,
                ],
                on: { click: () => finish(choice.id) },
            })
            : h('button', {
                class: `button button-${choice.tone ?? 'default'}`,
                text: choice.label,
                attrs: { type: 'button' },
                dataset: { choice: choice.id },
                on: { click: () => finish(choice.id) },
            })));
        const content = document.createDocumentFragment();
        if (isMenu) {
            content.append(h('button', {
                class: 'icon-button sheet-close',
                html: ICONS.close,
                dataset: { tooltip: 'Close' },
                attrs: { 'type': 'button', 'aria-label': 'Close' },
                on: { click: () => finish(undefined) },
            }));
        }

        content.append(h('div', {
            class: 'dialog-body',
            children: [
                options.message == null ? null : h('p', { class: 'dialog-message', text: options.message }),
                options.body ?? null,
                h('div', { class: 'dialog-actions', dataset: { layout: isMenu ? 'menu' : 'row' }, children: buttons }),
            ],
        }));
        const primary = buttons.find((_, index) => options.choices[index]?.tone === 'primary');

        handle = openModal({
            title: options.title,
            content,
            variant: isMenu ? 'sheet' : 'dialog',
            onDismiss: () => resolve(undefined),
            initialFocus: primary ?? buttons[0],
        });
    });

    const confirmAsync = async (options: ConfirmOptions): Promise<boolean> => {
        const choice = await chooseAsync({
            title: options.title,
            message: options.message,
            choices: [
                { id: 'cancel', label: options.cancelLabel ?? 'Cancel' },
                { id: 'confirm', label: options.confirmLabel ?? 'OK', tone: options.danger === true ? 'danger' : 'primary' },
            ],
        });

        return choice === 'confirm';
    };

    const alertAsync = async (options: { title: string; message?: string; body?: Node }): Promise<void> => {
        await chooseAsync({ ...options, choices: [{ id: 'ok', label: 'OK', tone: 'primary' }] });
    };

    const toast = (message: string, options: ToastOptions = {}): void => {
        const element = h('div', { class: 'toast', text: message, dataset: { tone: options.tone ?? 'info' } });
        toastRegion.append(element);
        while (toastRegion.children.length > TOAST_LIMIT) {
            toastRegion.firstElementChild?.remove();
        }

        setTimeout(() => element.remove(), options.durationMs ?? 4000);
    };

    return {
        confirmAsync,
        chooseAsync,
        alertAsync,
        openModal,
        toast,
        get openCount() {
            return stack.length;
        },
        dispose: () => {
            document.removeEventListener('keydown', onKeyDown, true);
            for (const item of [...stack]) {
                item.dismiss();
            }

            layer.remove();
            toastRegion.remove();
        },
    };
}
