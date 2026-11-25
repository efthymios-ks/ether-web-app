import type { AppContext, ScanPurpose, Screen } from '../appContext.js';
import { h } from '../dom.js';
import { formatClock } from '../format.js';
import { ICONS } from '../icons.js';
import type { HomePanel } from '../shell/homePanel.js';
import { createCodeIntake } from './codeIntake.js';
import type { CodeIntake, CodeKind } from './codeIntake.js';
import type { PairingFlow } from './pairingFlow.js';
import { createQrPanel } from './qrPanel.js';
import { createScanPanel } from './scanPanel.js';

// UI-11, R7, §4.4: Home's pane, "Pair with a code" and its steps, in plain words: Show my code, Scan a code
// or Paste a code; "Step 1 of 2 · Scan this on the other device", then "Step 2 of 2 · Then get its reply";
// the other device shows "Show this to the first device". The code says offer and answer; the screens never do.
// Codes are never shown as text: they move as QR codes, through Copy and Paste, or with Ctrl/Cmd+V on the screen.

const EXPIRY_WARNING_MS = 30_000;
// HS-05: the browser may ask for the camera first; allowing it shows the device's real address.
const PREPARING_TEXT = 'Preparing your code… If the browser asks for the camera, allow it: '
    + 'the devices find each other more easily.';
const NO_CAMERA_TEXT = 'No camera on this device. Use Paste instead.';

const PAIR_TITLE = 'Pair with a code';
export const PAIR_LEAD = 'For devices that don’t show up nearby. '
    + 'One shows a code, the other scans it and shows one back.';

function intakeFor(context: AppContext, flow: PairingFlow, kind: CodeKind): CodeIntake {
    const intake = createCodeIntake({
        kind,
        pasteHint: context.platform.pasteShortcutHint(),
        onCodeAsync: text => flow.submitCodeAsync(text, { source: 'paste', expect: kind }),
    });
    intake.setMessage(flow.takeError());

    return intake;
}

function iconButton(options: {
    readonly className: string;
    readonly action: string;
    readonly icon: string;
    readonly label: string;
    readonly onClick: () => void;
}): HTMLButtonElement {
    return h('button', {
        class: options.className,
        dataset: { action: options.action },
        attrs: { type: 'button' },
        children: [
            h('span', { class: 'button-icon', html: options.icon, attrs: { 'aria-hidden': 'true' } }),
            options.label,
        ],
        on: { click: () => options.onClick() },
    });
}

// "‹ Back" on the menu, "‹ Other options" on its steps.
function backButton(label: string, onClick: () => void): HTMLButtonElement {
    return iconButton({ className: 'back-link', action: 'back', icon: ICONS.chevronLeft, label, onClick });
}

function stepLine(text: string): HTMLElement {
    return h('p', { class: 'pairing-step', text });
}

function pairingLayout(options: {
    readonly name: string;
    readonly back?: HTMLElement;
    readonly step?: string;
    readonly title: string;
    readonly lead?: string;
    readonly media?: Node;
    readonly content: ReadonlyArray<Node | null>;
}): HTMLElement {
    return h('section', {
        class: 'screen pairing-screen',
        dataset: { screen: options.name, hasMedia: String(options.media != null) },
        attrs: { 'aria-labelledby': `${options.name}-title` },
        children: [
            options.back == null ? null : h('div', { class: 'pairing-back', children: [options.back] }),
            h('header', {
                class: 'pairing-header',
                children: [
                    options.step == null ? null : stepLine(options.step),
                    h('h1', { class: 'screen-title', text: options.title, attrs: { id: `${options.name}-title`, tabindex: '-1' } }),
                    options.lead == null ? null : h('p', { class: 'screen-lead', text: options.lead }),
                ],
            }),
            options.media == null ? null : h('div', { class: 'pairing-media', children: [options.media] }),
            h('div', { class: 'pairing-content', children: options.content }),
        ],
    });
}

function placeholder(text: string, state: 'busy' | 'failed' = 'busy'): HTMLElement {
    return h('div', {
        class: 'qr-placeholder',
        dataset: { state },
        attrs: { role: 'status' },
        children: [h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text })],
    });
}

function waitingLine(text: string): HTMLElement {
    return h('p', {
        class: 'pairing-waiting',
        attrs: { role: 'status' },
        children: [h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text })],
    });
}

function actionRow(children: ReadonlyArray<Node | null>): HTMLElement {
    return h('div', { class: 'pairing-actions', children });
}

// Show my code, Scan a code (Paste a code without a camera) and Done: what the failure and expired screens offer.
function startAgainActions(context: AppContext, flow: PairingFlow, intake: CodeIntake): HTMLElement {
    const show = iconButton({
        className: 'button button-primary',
        action: 'show-code',
        icon: ICONS.qr,
        label: 'Show my code',
        onClick: () => void flow.showCodeAsync(),
    });
    const scanOrPaste = context.hasCamera
        ? iconButton({
            className: 'button',
            action: 'scan-code',
            icon: ICONS.camera,
            label: 'Scan a code',
            onClick: () => flow.scanCode(),
        })
        : intake.createButton({ label: 'Paste a code', className: 'button' });
    const done = h('button', {
        class: 'button button-quiet',
        text: 'Done',
        dataset: { action: 'done' },
        attrs: { type: 'button' },
        on: { click: () => flow.cancel() },
    });

    return actionRow([show, scanOrPaste, done]);
}

// Show my code and Scan a code as tiles, Paste a code under them; without a camera, Paste a code is the second tile.
function codeChoices(context: AppContext, flow: PairingFlow, intake: CodeIntake): Array<HTMLElement | null> {
    const showTile = iconButton({
        className: 'pair-tile',
        action: 'show-code',
        icon: ICONS.qr,
        label: 'Show my code',
        onClick: () => void flow.showCodeAsync(),
    });
    const secondTile = context.hasCamera
        ? iconButton({
            className: 'pair-tile',
            action: 'scan-code',
            icon: ICONS.camera,
            label: 'Scan a code',
            onClick: () => flow.scanCode(),
        })
        : intake.createButton({ label: 'Paste a code', className: 'pair-tile' });
    const pasteLink = context.hasCamera
        ? intake.createButton({ label: 'Paste a code', className: 'link-button' })
        : null;

    return [
        h('div', { class: 'pair-choice', children: [showTile, secondTile] }),
        pasteLink == null ? null : actionRow([pasteLink]),
    ];
}

// Home's pane beside the sidebar on wide screens and landscape phones (D9): the sidebar looks for nearby devices,
// so the pane offers the other way, "Or pair with a code", and the sidebar drops its link to it.
// On one column the pane stays hidden and Home is the sidebar alone. Ctrl/Cmd+V on Home takes a code either way;
// what goes wrong shows in the pane beside the sidebar, or under the nearby devices on one column.
export function createHomeScreen(context: AppContext, flow: PairingFlow, panel: HomePanel): Screen {
    const intake = intakeFor(context, flow, 'offer');
    const paneMessage = h('div', { class: 'home-pane-message' });
    const element = h('section', {
        class: 'screen pairing-screen home-pane',
        dataset: { screen: 'home' },
        attrs: { 'aria-labelledby': 'home-pane-title' },
        children: [
            h('header', {
                class: 'pairing-header',
                children: [
                    h('h2', { class: 'screen-title', text: 'Or pair with a code', attrs: { id: 'home-pane-title' } }),
                    h('p', { class: 'screen-lead', text: PAIR_LEAD }),
                ],
            }),
            h('div', { class: 'pairing-content', children: [...codeChoices(context, flow, intake), paneMessage] }),
        ],
    });

    // The message goes where it can be seen, and moves when the layout changes.
    const placeMessage = (): void => {
        const host = context.layout.hasSidebar ? paneMessage : panel.messageSlot;
        if (intake.message.parentElement !== host) {
            host.append(intake.message);
        }
    };

    placeMessage();
    const unsubscribe = context.layout.onChange(placeMessage);

    return {
        element,
        title: 'Ether',
        codeEntry: { pasteAsync: text => intake.pasteAsync(text), focus: () => panel.focus() },
        dispose: () => {
            unsubscribe();
            intake.message.remove();
        },
    };
}

// "Pair with a code" on its own screen: on one column, and when opened from a session or the drawer.
export function createPairScreen(context: AppContext, flow: PairingFlow): Screen {
    const intake = intakeFor(context, flow, 'offer');
    const element = pairingLayout({
        name: 'pair',
        back: backButton('Back', () => flow.cancel()),
        title: PAIR_TITLE,
        lead: PAIR_LEAD,
        content: [...codeChoices(context, flow, intake), intake.message],
    });

    return {
        element,
        title: PAIR_TITLE,
        codeEntry: { pasteAsync: text => intake.pasteAsync(text), focus: () => intake.focus() },
        dispose: () => undefined,
    };
}

// Step 1 of 2 on the first device: its code as a QR, Copy code and the countdown; step 2 asks for the reply.
export function createOfferScreen(context: AppContext, flow: PairingFlow): Screen {
    const intake = intakeFor(context, flow, 'reply');
    const media = h('div', { class: 'qr-stage' });
    const expiry = h('span', { class: 'pairing-expiry', attrs: { 'aria-live': 'off' } });
    const scanButton = context.hasCamera
        ? iconButton({
            className: 'button button-primary',
            action: 'scan-reply',
            icon: ICONS.camera,
            label: 'Scan reply',
            onClick: () => flow.scanAnswer(),
        })
        : null;
    const pasteButton = intake.createButton({
        label: 'Paste reply',
        className: context.hasCamera ? 'button' : 'button button-primary',
    });
    const element = pairingLayout({
        name: 'offer',
        back: backButton('Other options', () => flow.openMenu()),
        step: 'Step 1 of 2',
        title: 'Scan this on the other device',
        media,
        content: [
            h('section', {
                class: 'pairing-next',
                attrs: { 'aria-labelledby': 'offer-next-title' },
                children: [
                    stepLine('Step 2 of 2'),
                    h('h2', {
                        class: 'pairing-next-title',
                        text: 'Then get its reply',
                        attrs: { id: 'offer-next-title' },
                    }),
                    actionRow([scanButton, pasteButton]),
                    intake.message,
                ],
            }),
        ],
    });
    let countdown: ReturnType<typeof setInterval> | undefined;
    let shownCode: string | undefined;

    const stopCountdown = (): void => {
        if (countdown != null) {
            clearInterval(countdown);
            countdown = undefined;
        }
    };

    const tick = (): void => {
        const expiresAt = flow.offer?.expiresAt;
        if (expiresAt == null) {
            expiry.textContent = '';

            return;
        }

        const left = expiresAt - Date.now();
        if (left <= 0) {
            stopCountdown();
            flow.expireOffer();

            return;
        }

        expiry.textContent = `Expires in ${formatClock(left / 1000)} · works once`;
        expiry.dataset.tone = left <= EXPIRY_WARNING_MS ? 'warn' : 'info';
    };

    const render = (): void => {
        const offer = flow.offer;
        if (flow.offerStatus === 'ready' && offer != null) {
            if (shownCode === offer.code && media.firstElementChild?.classList.contains('qr-figure') === true) {
                return;
            }

            shownCode = offer.code;
            media.replaceChildren(createQrPanel(context, {
                url: offer.url,
                code: offer.code,
                kind: 'offer',
                note: expiry,
            }));
            context.wakeLock.set('qr', true);
            stopCountdown();
            tick();
            countdown = setInterval(tick, 1000);

            return;
        }

        shownCode = undefined;
        context.wakeLock.set('qr', false);
        const isFailed = flow.offerStatus === 'failed';
        media.replaceChildren(isFailed
            ? placeholder('Your code could not be created.', 'failed')
            : placeholder(PREPARING_TEXT));
        expiry.textContent = '';
    };

    const unsubscribe = flow.onChange(render);
    render();

    return {
        element,
        title: 'Your code',
        codeEntry: { pasteAsync: text => intake.pasteAsync(text), focus: () => pasteButton.focus() },
        dispose: () => {
            unsubscribe();
            stopCountdown();
            context.wakeLock.set('qr', false);
        },
    };
}

// The camera, with the torch where the track has one, and Paste instead; scanning the reply can go back
// to the code.
export function createScanScreen(context: AppContext, flow: PairingFlow, purpose: ScanPurpose): Screen {
    const kind: CodeKind = purpose === 'answer' ? 'reply' : 'offer';
    const intake = intakeFor(context, flow, kind);
    const scanner = createScanPanel(context, {
        label: kind === 'offer' ? 'Camera view for the other device’s code' : 'Camera view for the reply',
        onCode: text => {
            void handleCodeAsync(text);
        },
    });
    const pasteButton = intake.createButton({
        label: 'Paste instead',
        className: context.hasCamera ? 'button' : 'button button-primary',
    });
    const showAgain = kind === 'reply'
        ? h('button', {
            class: 'button button-quiet',
            text: 'Show my code again',
            dataset: { action: 'show-code-again' },
            attrs: { type: 'button' },
            on: { click: () => void flow.showCodeAsync() },
        })
        : null;
    const element = pairingLayout({
        name: 'scan',
        back: backButton('Other options', () => flow.openMenu()),
        step: kind === 'reply' ? 'Step 2 of 2' : undefined,
        title: kind === 'reply' ? 'Scan the reply' : 'Scan the other device’s code',
        media: h('div', { class: 'scan-block', dataset: { kind }, children: [scanner.element] }),
        content: [actionRow([pasteButton, showAgain]), intake.message],
    });

    const handleCodeAsync = async (text: string): Promise<void> => {
        scanner.pause();
        const releaseCamera = context.camera.retainOpen() ?? undefined;
        const problem = await flow.submitCodeAsync(text, { source: 'scan', expect: kind, releaseCamera });
        if (problem == null || !element.isConnected) {
            return;
        }

        intake.setMessage(problem);
        scanner.resume();
    };

    if (context.hasCamera) {
        void scanner.startAsync();
    } else {
        scanner.showUnavailable(NO_CAMERA_TEXT);
        queueMicrotask(() => pasteButton.focus());
    }

    return {
        element,
        title: kind === 'reply' ? 'Scan the reply' : 'Scan a code',
        codeEntry: { pasteAsync: text => intake.pasteAsync(text), focus: () => pasteButton.focus() },
        dispose: () => scanner.dispose(),
    };
}

// Step 2 of 2 on the second device: its reply as a QR, then waiting for the first device to read it.
export function createAnswerScreen(context: AppContext, flow: PairingFlow): Screen {
    const media = h('div', { class: 'qr-stage' });
    const note = h('p', { class: 'notice', dataset: { tone: 'warn' }, attrs: { hidden: true } });
    const waiting = waitingLine('Waiting for the first device to read it…');
    const element = pairingLayout({
        name: 'answer',
        back: backButton('Other options', () => flow.openMenu()),
        step: 'Step 2 of 2',
        title: 'Show this to the first device',
        media,
        content: [note, waiting],
    });
    let shownCode: string | undefined;

    const render = (): void => {
        note.textContent = flow.answerNote ?? '';
        note.hidden = flow.answerNote == null;
        const answer = flow.answer;
        if (flow.answerStatus === 'ready' && answer != null) {
            if (shownCode === answer.answerCode) {
                return;
            }

            shownCode = answer.answerCode;
            media.replaceChildren(createQrPanel(context, { url: answer.answerUrl, code: answer.answerCode, kind: 'reply' }));
            waiting.hidden = false;
            context.wakeLock.set('qr', true);

            return;
        }

        shownCode = undefined;
        context.wakeLock.set('qr', false);
        waiting.hidden = true;
        const isFailed = flow.answerStatus === 'failed';
        media.replaceChildren(placeholder(isFailed ? 'The reply could not be created.' : 'Creating the reply…', isFailed ? 'failed' : 'busy'));
    };

    const unsubscribe = flow.onChange(render);
    render();

    return {
        element,
        title: 'Reply',
        dispose: () => {
            unsubscribe();
            context.wakeLock.set('qr', false);
        },
    };
}

export function createConnectingScreen(_context: AppContext, flow: PairingFlow): Screen {
    const element = pairingLayout({
        name: 'connecting',
        title: 'Connecting…',
        lead: 'Both devices are looking for each other on the local network. This takes a few seconds.',
        media: h('span', { class: 'spinner pairing-spinner', attrs: { 'aria-hidden': 'true' } }),
        content: [
            actionRow([h('button', {
                class: 'button',
                text: 'Cancel',
                dataset: { action: 'cancel' },
                attrs: { type: 'button' },
                on: { click: () => flow.cancel() },
            })]),
        ],
    });

    return {
        element,
        title: 'Connecting',
        dispose: () => undefined,
    };
}

export function createFailureScreen(context: AppContext, flow: PairingFlow, reason: string | undefined): Screen {
    const intake = intakeFor(context, flow, 'offer');
    const hints = context.platform.pairingFailureHints();
    const element = pairingLayout({
        name: 'failure',
        title: 'The devices couldn’t connect',
        lead: reason === 'protocol-version'
            ? 'The other device runs a different version of Ether. Reload Ether on both devices and pair again.'
            : 'They read each other’s codes but found no way to reach each other. The usual causes:',
        content: [
            h('ul', {
                class: 'hint-list',
                children: hints.map(hint => h('li', {
                    class: 'hint-item',
                    children: [h('strong', { class: 'hint-title', text: hint.title }), h('span', { text: hint.text })],
                })),
            }),
            // DL-07: the timeline lives in the log viewer, which only ?debug=1 opens.
            context.hasLogViewer
                ? iconButton({
                    className: 'button',
                    action: 'show-timeline',
                    icon: ICONS.info,
                    label: 'Show the connection timeline',
                    onClick: () => context.showTimeline(),
                })
                : null,
            startAgainActions(context, flow, intake),
            intake.message,
        ],
    });

    return {
        element,
        title: 'Could not connect',
        codeEntry: { pasteAsync: text => intake.pasteAsync(text), focus: () => intake.focus() },
        dispose: () => undefined,
    };
}

export function createExpiredScreen(context: AppContext, flow: PairingFlow): Screen {
    const intake = intakeFor(context, flow, 'offer');
    const element = pairingLayout({
        name: 'expired',
        title: 'This code expired, show a new one',
        lead: 'A code works once, and only for a short time. Show a new one and scan it again.',
        content: [startAgainActions(context, flow, intake), intake.message],
    });

    return {
        element,
        title: 'Code expired',
        codeEntry: { pasteAsync: text => intake.pasteAsync(text), focus: () => intake.focus() },
        dispose: () => undefined,
    };
}
