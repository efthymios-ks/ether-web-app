import type { SessionSummary } from '../../client/clientTypes.js';
import type { NearbyDevice } from '../../discovery/discoveryTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import { createOrbit, ORBIT_LABEL } from '../shell/orbit.js';
import { syncChildren } from '../transfers/syncChildren.js';
import type { NearbyView } from './nearbyController.js';
import { devicePlatformLabel, deviceTypeIcon } from './deviceTypes.js';

// Home's Nearby section (R6, §4.2): the orbit while looking, "Tap a device to connect", and one card per device.
// A whole card is the target: its icon, name and tags (platform, a lock PIN tag, Paired before, N unfinished).
// While a device is asked, its card says "Waiting for X to accept…" (or "Connecting to X…" with its PIN) with
// Cancel under it, and the other cards wait. Nobody found, no internet and the setting off replace the list.
// Cards are kept and changed in place, so focus survives the live list.

export interface NearbySectionOptions {
    // True while the section is on screen; notes then show under the list instead of as toasts.
    readonly isShown: () => boolean;
}

export interface NearbySection {
    readonly element: HTMLElement;
    dispose(): void;
}

// What the section shows instead of cards, or 'devices' for the cards.
export type NearbyMode = 'devices' | 'empty' | 'offline' | 'off' | 'paused';

interface Row {
    readonly element: HTMLLIElement;
    readonly card: HTMLButtonElement;
    readonly icon: HTMLElement;
    readonly name: HTMLElement;
    readonly tags: HTMLElement;
    readonly wait: HTMLElement;
    readonly waitText: HTMLElement;
    readonly actions: HTMLElement;
    readonly cancel: HTMLButtonElement;
    // The device type and the tags the row was drawn with, so presence repeating changes nothing.
    iconKind: string;
    tagKey: string;
}

interface Tag {
    readonly text: string;
    readonly tone?: 'warn';
    readonly isPin?: boolean;
}

export const NEARBY_HINT_TEXT = 'Tap a device to connect';

type EmptyMode = Exclude<NearbyMode, 'devices'>;

// [the big line, the line under it] for each state that replaces the cards.
export const NEARBY_EMPTY_TEXTS: Readonly<Record<EmptyMode, readonly [string, string]>> = Object.freeze({
    empty: ['Open Ether on another device.', 'Same Wi‑Fi. It shows up here.'],
    offline: ['No internet, so nearby devices can’t be found.', 'Pair with a code instead.'],
    off: ['Finding nearby devices is off.', 'Turn it on, or pair with a code.'],
    paused: ['Nearby search is paused while you pair with a code.', ''],
});

const STATUS_MODES: Readonly<Partial<Record<NearbyView['status'], EmptyMode>>> = Object.freeze({
    disabled: 'off',
    offline: 'offline',
    paused: 'paused',
});

function nearbyMode(view: NearbyView): NearbyMode {
    return STATUS_MODES[view.status] ?? (view.devices.length > 0 || view.asking != null ? 'devices' : 'empty');
}

// "Waiting for X to accept…", or "Connecting to X…" when its PIN went with the request and stands in
// for Accept.
export function askingText(view: NearbyView): string {
    if (view.asking == null) {
        return '';
    }

    const { name } = view.asking;

    return view.isAskingWithPin ? `Connecting to ${name}…` : `Waiting for ${name} to accept…`;
}

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

function setHidden(element: HTMLElement, isHidden: boolean): void {
    if (element.hidden !== isHidden) {
        element.hidden = isHidden;
    }
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
    if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
    }
}

function tagElement(tag: Tag): HTMLElement {
    return h('span', {
        class: tag.isPin === true ? 'badge nearby-pin' : 'badge',
        dataset: tag.tone == null ? {} : { tone: tag.tone },
        children: [
            tag.isPin === true
                ? h('span', { class: 'nearby-pin-icon', html: ICONS.lock, attrs: { 'aria-hidden': 'true' } })
                : null,
            tag.text,
        ],
    });
}

export function createNearbySection(context: AppContext, options: NearbySectionOptions): NearbySection {
    const { nearby, client } = context;
    const rows = new Map<string, Row>();
    // Numbers the tag lines, which describe their cards for screen readers.
    let rowCount = 0;
    const title = h('h2', {
        class: 'section-title nearby-title',
        text: 'Nearby',
        attrs: { id: 'home-nearby-title', tabindex: '-1' },
    });
    const hint = h('span', { class: 'nearby-hint', attrs: { 'aria-live': 'polite' } });
    const head = h('div', {
        class: 'nearby-head',
        children: [createOrbit(24, ORBIT_LABEL), title, hint],
    });
    const list = h('ul', { class: 'nearby-list', attrs: { role: 'list', hidden: true } });
    const emptyOrbit = h('span', { class: 'nearby-empty-orbit', children: [createOrbit(72, ORBIT_LABEL)] });
    const emptyTitle = h('p', { class: 'empty-title', attrs: { tabindex: '-1' } });
    const emptyText = h('p', { class: 'empty-text' });
    const turnOn = h('button', {
        class: 'button',
        text: 'Turn on',
        dataset: { action: 'turn-on-nearby' },
        attrs: { type: 'button' },
        on: { click: () => void turnOnAsync() },
    });
    const empty = h('div', {
        class: 'nearby-empty',
        attrs: { hidden: true },
        children: [emptyOrbit, emptyTitle, emptyText, turnOn],
    });
    const note = h('p', { class: 'notice nearby-note', attrs: { role: 'alert', hidden: true } });
    const element = h('section', {
        class: 'home-nearby',
        attrs: { 'aria-labelledby': 'home-nearby-title' },
        children: [head, list, empty, note],
    });

    const turnOnAsync = async (): Promise<void> => {
        try {
            await client.configureAsync({ findNearbyDevices: true });
        } catch {
            context.dialogs.toast('Couldn’t turn it on. Try again in Settings.', { tone: 'warn' });
        }
    };

    // The newest session with a peer of this name: its device was paired before.
    const sessionNamed = (name: string): SessionSummary | undefined => context.sessions.sessions
        .find(session => session.peerName === name);

    const tagsOf = (device: NearbyDevice): Tag[] => {
        const session = sessionNamed(device.name);
        const unfinished = session?.unfinishedCount ?? 0;

        return [
            { text: devicePlatformLabel(device) },
            ...(device.hasPin === true ? [{ text: 'PIN', isPin: true }] : []),
            ...(session == null ? [] : [{ text: 'Paired before' }]),
            ...(unfinished > 0
                ? [{ text: `${unfinished.toLocaleString('en')} unfinished`, tone: 'warn' as const }]
                : []),
        ];
    };

    const createRow = (device: NearbyDevice): Row => {
        const icon = h('span', { class: 'nearby-icon-slot' });
        const name = h('span', { class: 'device-name nearby-name' });
        const tagsId = `nearby-tags-${++rowCount}`;
        const tags = h('span', { class: 'device-tags nearby-tags', attrs: { id: tagsId } });
        const waitText = h('span');
        const wait = h('span', {
            class: 'nearby-wait',
            attrs: { hidden: true },
            children: [h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), waitText],
        });
        // "Connect to Pixel 8", then its tags, e.g. "Android PIN Paired before".
        const card = h('button', {
            class: 'device-card nearby-connect',
            dataset: { action: 'connect-nearby' },
            attrs: { 'type': 'button', 'aria-describedby': tagsId },
            children: [icon, h('span', { class: 'device-text', children: [name, tags, wait] })],
            on: {
                click: () => {
                    note.hidden = true;
                    void nearby.connectAsync(device.nearbyId);
                },
            },
        });
        const cancel = h('button', {
            class: 'button nearby-cancel',
            text: 'Cancel',
            dataset: { action: 'cancel-nearby' },
            attrs: { type: 'button' },
            on: { click: () => nearby.cancelRequest() },
        });
        const actions = h('div', { class: 'nearby-item-actions', attrs: { hidden: true }, children: [cancel] });
        const item = h('li', {
            class: 'nearby-item',
            dataset: { nearbyId: device.nearbyId },
            children: [card, actions],
        });

        return {
            element: item,
            card,
            icon,
            name,
            tags,
            wait,
            waitText,
            actions,
            cancel,
            iconKind: '',
            tagKey: '',
        };
    };

    // Presence repeats every half minute or so with the same name; only what changed is touched.
    const updateRow = (row: Row, device: NearbyDevice, view: NearbyView): void => {
        const isAskedHere = view.asking?.nearbyId === device.nearbyId;
        const isDisabled = view.asking != null;
        if (row.card.disabled !== isDisabled) {
            row.card.disabled = isDisabled;
        }

        setAttribute(row.card, 'aria-label', isAskedHere ? askingText(view) : `Connect to ${device.name}`);
        setText(row.name, device.name);
        setAttribute(row.name, 'title', device.name);
        if (row.iconKind !== device.deviceType) {
            row.iconKind = device.deviceType;
            row.icon.replaceChildren(deviceTypeIcon(device.deviceType));
        }

        const tags = tagsOf(device);
        const tagKey = tags.map(tag => `${tag.text}:${tag.tone ?? ''}`).join('|');
        if (row.tagKey !== tagKey) {
            row.tagKey = tagKey;
            row.tags.replaceChildren(...tags.map(tagElement));
        }

        setText(row.waitText, isAskedHere ? askingText(view) : '');
        setHidden(row.wait, !isAskedHere);
        setHidden(row.actions, !isAskedHere);
        setAttribute(row.cancel, 'aria-label', `Stop asking ${device.name}`);
        if (row.element.dataset.asked !== String(isAskedHere)) {
            row.element.dataset.asked = String(isAskedHere);
        }
    };

    const isUsable = (target: Element | null): target is HTMLElement => target instanceof HTMLElement
        && element.contains(target)
        && target.closest('[hidden]') == null
        && !(target instanceof HTMLButtonElement && target.disabled);

    // Focus that was in the section stays there: on the asked card's Cancel while asking, then on the same
    // device's card, or its neighbour when that device went away, or on the line that replaced the list.
    const restoreFocus = (view: NearbyView, previousId: string | undefined, previousIndex: number): void => {
        if (isUsable(document.activeElement)) {
            return;
        }

        const cards = [...list.querySelectorAll<HTMLButtonElement>('.nearby-connect:not(:disabled)')];
        const byId = previousId == null ? undefined : rows.get(previousId)?.card;
        const candidates = view.asking != null
            ? [rows.get(view.asking.nearbyId)?.cancel]
            : [byId, cards[previousIndex], cards[previousIndex - 1], cards.at(-1)];
        const fallback = empty.hidden ? title : (turnOn.hidden ? emptyTitle : turnOn);
        const target = candidates.find(candidate => candidate != null && isUsable(candidate)) ?? fallback;
        target.focus();
    };

    const renderList = (view: NearbyView): void => {
        // The asked device keeps its card, and its Cancel, even if it stops saying it is here meanwhile.
        const asked = view.asking;
        const devices = asked != null && !view.devices.some(device => device.nearbyId === asked.nearbyId)
            ? [...view.devices, asked]
            : view.devices;
        const ids = new Set(devices.map(device => device.nearbyId));
        for (const id of [...rows.keys()]) {
            if (!ids.has(id)) {
                rows.delete(id);
            }
        }

        const ordered = devices.map(device => {
            const row = rows.get(device.nearbyId) ?? createRow(device);
            rows.set(device.nearbyId, row);
            updateRow(row, device, view);

            return row.element;
        });
        syncChildren(list, ordered);
    };

    const renderEmpty = (mode: EmptyMode): void => {
        const [big, small] = NEARBY_EMPTY_TEXTS[mode];
        if (empty.dataset.kind !== mode) {
            empty.dataset.kind = mode;
        }

        setText(emptyTitle, big);
        setText(emptyText, small);
        setHidden(emptyText, small === '');
        setHidden(emptyOrbit, mode !== 'empty');
        setHidden(turnOn, mode !== 'off');
    };

    const render = (): void => {
        const view = nearby.view;
        const mode = nearbyMode(view);
        const active = document.activeElement;
        const hadFocus = active instanceof HTMLElement && element.contains(active);
        const focusedRow = active?.closest<HTMLElement>('.nearby-item');
        const previousId = focusedRow?.dataset.nearbyId;
        const previousIndex = focusedRow == null ? 0 : [...list.children].indexOf(focusedRow);

        const status = view.asking == null ? mode : 'asking';
        if (element.dataset.status !== status) {
            element.dataset.status = status;
        }

        setText(hint, view.asking == null ? NEARBY_HINT_TEXT : '');
        const isList = mode === 'devices';
        setHidden(head, !isList);
        setHidden(list, !isList);
        setHidden(empty, isList);
        if (isList) {
            renderList(view);
        } else {
            rows.clear();
            list.replaceChildren();
            renderEmpty(mode);
        }

        if (hadFocus) {
            restoreFocus(view, previousId, previousIndex);
        }
    };

    const unsubscribers = [
        nearby.onChange(render),
        context.sessions.subscribe(render),
        nearby.onNote(next => {
            if (!element.isConnected || element.closest('[hidden]') != null || !options.isShown()) {
                return false;
            }

            note.textContent = next.text;
            note.dataset.tone = next.tone;
            note.hidden = false;

            return true;
        }),
    ];
    render();

    return {
        element,
        dispose: () => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
    };
}
