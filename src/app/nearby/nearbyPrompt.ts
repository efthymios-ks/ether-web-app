import type { PairRequest } from '../../discovery/discoveryTypes.js';
import type { Dialogs, ModalHandle } from '../dialogs.js';
import { h } from '../dom.js';
import { devicePlatformLabel, deviceTypeIcon } from './deviceTypes.js';

// A nearby device asks to pair. Nothing pairs without Accept: Decline, Escape and the backdrop all say no.

export const NEARBY_PROMPT_TEXT =
    'Accept only if you know this device. Both screens then show the same check code.';

export interface NearbyPromptOptions {
    readonly request: PairRequest;
    // A session with a peer of this name exists, so the request reads as connecting again.
    readonly isPairedBefore: boolean;
    readonly onAccept: () => void;
    readonly onDecline: () => void;
}

export function openNearbyPrompt(dialogs: Dialogs, options: NearbyPromptOptions): ModalHandle {
    const { from } = options.request;
    let handle: ModalHandle | undefined;

    const choose = (callback: () => void): void => {
        handle?.close();
        callback();
    };

    const declineButton = h('button', {
        class: 'button',
        text: 'Decline',
        dataset: { action: 'decline-nearby' },
        attrs: { type: 'button' },
        on: { click: () => choose(options.onDecline) },
    });
    const acceptButton = h('button', {
        class: 'button button-primary',
        text: 'Accept',
        dataset: { action: 'accept-nearby' },
        attrs: { type: 'button' },
        on: { click: () => choose(options.onAccept) },
    });
    const device = h('p', {
        class: 'nearby-prompt-device',
        children: [
            h('span', { text: `${devicePlatformLabel(from)} nearby` }),
            options.isPairedBefore
                ? h('span', { class: 'badge', dataset: { tone: 'ok' }, text: 'Paired before' })
                : null,
        ],
    });
    const actions = h('div', {
        class: 'dialog-actions',
        dataset: { layout: 'row' },
        children: [declineButton, acceptButton],
    });
    const content = h('div', {
        class: 'dialog-body nearby-prompt',
        children: [device, h('p', { class: 'dialog-message', text: NEARBY_PROMPT_TEXT }), actions],
    });

    handle = dialogs.openModal({
        title: options.isPairedBefore ? `${from.name} wants to connect again` : `${from.name} wants to connect`,
        icon: deviceTypeIcon(from.deviceType),
        content,
        onDismiss: options.onDecline,
        initialFocus: acceptButton,
    });
    handle.element.dataset.prompt = 'nearby';

    return handle;
}
