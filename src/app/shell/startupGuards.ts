import { h } from '../dom.js';
import { ICONS } from '../icons.js';

// §2: one clear screen when the browser lacks what Ether needs; §7.5: one tab holds the connection.

export const CONNECTION_LOCK = 'ether-connection';

export interface SupportCheck {
    readonly isSupported: boolean;
    readonly missing: readonly string[];
}

const REQUIRED_FEATURES: ReadonlyArray<{ readonly label: string; isPresent(scope: typeof globalThis): boolean }> = [
    { label: 'WebRTC (RTCPeerConnection)', isPresent: scope => typeof scope.RTCPeerConnection === 'function' },
    { label: 'IndexedDB storage', isPresent: scope => scope.indexedDB != null },
];

export function checkSupport(scope: typeof globalThis = globalThis): SupportCheck {
    const missing = REQUIRED_FEATURES
        .filter(feature => !feature.isPresent(scope))
        .map(feature => feature.label);

    return { isSupported: missing.length === 0, missing };
}

export type LockStatus = 'acquired' | 'taken' | 'unsupported';

export interface ConnectionLock {
    readonly status: LockStatus;
    release(): void;
}

interface LockManagerLike {
    request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<unknown>;
}

// Without Web Locks the app carries on; two tabs may then both pair.
export function acquireConnectionLockAsync(locks?: LockManagerLike): Promise<ConnectionLock> {
    const manager = locks ?? (navigator as Navigator & { locks?: LockManagerLike }).locks;
    if (manager?.request == null) {
        return Promise.resolve({ status: 'unsupported', release: () => undefined });
    }

    return new Promise(resolve => {
        let release: () => void = () => undefined;
        const held = new Promise<void>(done => {
            release = done;
        });

        manager.request(CONNECTION_LOCK, { ifAvailable: true }, async lock => {
            if (lock == null) {
                resolve({ status: 'taken', release: () => undefined });

                return;
            }

            resolve({ status: 'acquired', release });
            await held;
        }).catch(() => resolve({ status: 'unsupported', release: () => undefined }));
    });
}

function startupCard(title: string, children: ReadonlyArray<Node | null>): HTMLElement {
    return h('section', {
        class: 'startup-screen',
        attrs: { 'aria-labelledby': 'startup-title' },
        children: [
            h('div', {
                class: 'startup-card',
                children: [
                    h('span', { class: 'startup-brand', html: ICONS.brand }),
                    h('h1', { class: 'startup-title', text: title, attrs: { id: 'startup-title', tabindex: '-1' } }),
                    ...children,
                ],
            }),
        ],
    });
}

export function renderNotSupported(container: HTMLElement, check: SupportCheck, note?: string): void {
    container.replaceChildren(startupCard('This browser can’t run Ether', [
        h('p', { text: 'Ether sends files straight between two browsers, and this one is missing:' }),
        h('ul', { class: 'startup-list', children: check.missing.map(item => h('li', { text: item })) }),
        h('p', { text: 'Open this page in a current version of Safari, Chrome, Edge, Samsung Internet or Firefox.' }),
        note == null ? null : h('p', { class: 'startup-note', text: note }),
    ]));
}

export interface OtherTabOptions {
    // undefined: no code came with this page; true: the other tab took it; false: no tab answered (HS-07).
    readonly forwarded?: boolean;
    readonly onRetry: () => void;
}

export const PAIRING_CONTINUED_TITLE = 'Pairing continued in the other tab';
export const PAIRING_CONTINUED_TEXT = 'The reply you opened went to the tab that shows this device’s code. '
    + 'Switch to it; you can close this one.';

export function renderOtherTab(container: HTMLElement, options: OtherTabOptions): void {
    // HS-07: a reply link opened in a new tab went to the tab holding the offer, and this tab only says so.
    if (options.forwarded === true) {
        container.replaceChildren(startupCard(PAIRING_CONTINUED_TITLE, [h('p', { text: PAIRING_CONTINUED_TEXT })]));

        return;
    }

    const note = options.forwarded === false ? 'The other tab did not take the code. Scan the reply from inside the app.' : undefined;

    container.replaceChildren(startupCard('Ether is open in another tab', [
        h('p', { text: 'Only one tab can hold a connection. Switch to the other tab, or close it and try again here.' }),
        note == null ? null : h('p', { class: 'startup-note', text: note }),
        h('button', {
            class: 'button button-primary',
            text: 'Try again',
            attrs: { type: 'button' },
            on: { click: () => options.onRetry() },
        }),
    ]));
}

// The page couldn't start, e.g. storage is blocked in a private window.
export function renderStartupError(container: HTMLElement, error: unknown, onRetry: () => void): void {
    const detail = error instanceof Error ? error.message : String(error);
    container.replaceChildren(startupCard('Ether couldn’t start', [
        h('p', { text: 'Storage may be blocked, for example in a private window, or another tab is upgrading Ether.' }),
        h('p', { class: 'startup-note', text: detail }),
        h('button', {
            class: 'button button-primary',
            text: 'Reload',
            attrs: { type: 'button' },
            on: { click: () => onRetry() },
        }),
    ]));
}
