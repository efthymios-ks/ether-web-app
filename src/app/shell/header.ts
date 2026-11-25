import { h } from '../dom.js';
import { ICONS } from '../icons.js';

// UI-12, §4.1: the brand, which always goes Home, and on the right Previous sessions and Settings, each 44×44 px
// with a tooltip. Previous sessions opens the drawer; Settings opens the Settings sheet at any time.
// The peer's name and health show once, in the session's peer bar, so the header has no peer pill.

export interface HeaderOptions {
    readonly onHome: () => void;
    readonly onHistory: () => void;
    readonly onSettings: () => void;
}

export interface Header {
    readonly element: HTMLElement;
    setHistoryOpen(isOpen: boolean): void;
    dispose(): void;
}

export function createHeader(options: HeaderOptions): Header {
    const historyButton = h('button', {
        class: 'icon-button',
        html: ICONS.history,
        dataset: { role: 'history-toggle', tooltip: 'Previous sessions' },
        attrs: {
            'type': 'button',
            'aria-label': 'Previous sessions',
            'aria-haspopup': 'dialog',
            'aria-expanded': 'false',
        },
        on: { click: () => options.onHistory() },
    });
    const settingsButton = h('button', {
        class: 'icon-button',
        html: ICONS.settings,
        dataset: { role: 'settings', tooltip: 'Settings' },
        attrs: { 'type': 'button', 'aria-label': 'Settings', 'aria-haspopup': 'dialog' },
        on: { click: () => options.onSettings() },
    });
    const element = h('header', {
        class: 'app-header',
        children: [
            h('button', {
                class: 'brand',
                dataset: { role: 'home' },
                attrs: { 'type': 'button', 'aria-label': 'Ether, home' },
                children: [h('span', { class: 'brand-mark', html: ICONS.brand }), h('span', { class: 'brand-name', text: 'Ether' })],
                on: { click: () => options.onHome() },
            }),
            h('div', { class: 'header-tools', children: [historyButton, settingsButton] }),
        ],
    });

    return {
        element,
        setHistoryOpen: isOpen => {
            historyButton.setAttribute('aria-expanded', String(isOpen));
        },
        dispose: () => undefined,
    };
}
