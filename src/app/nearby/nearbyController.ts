import { ClientError } from '../../client/clientTypes.js';
import type { ClientErrorCode, ConnectionState } from '../../client/clientTypes.js';
import type { Unsubscribe } from '../../core/events.js';
import { DiscoveryError } from '../../discovery/discoveryError.js';
import type { DiscoveryErrorCode } from '../../discovery/discoveryError.js';
import type { NearbyDevice, PairRequest, PairRequestOutcome } from '../../discovery/discoveryTypes.js';
import type { AppContext, Route } from '../appContext.js';
import type { ModalHandle, Tone } from '../dialogs.js';
import type { PairingFlow } from '../pairing/pairingFlow.js';
import { openNearbyPrompt } from './nearbyPrompt.js';
import { openPinEntrySheet, WRONG_PIN_TEXT } from './pinEntrySheet.js';

// Nearby devices: the list on Home, the one request this device may send at a time, and the prompt for
// a request it receives. Discovery runs while the setting is on and this device is neither connected nor
// pairing by QR code or copy and paste. A yes swaps the usual pairing codes through the relays, then the
// pairing goes on as usual: a direct connection and the check code. Anything but a yes pairs nothing.
// A device with a PIN (SP-10) asks for it first, and the right PIN stands in for the yes: a request that proves it
// connects without the prompt (SP-11). Pairing by code never asks for a PIN (SP-12).
// Reconnect (HC-05) asks a session's peer when it is listed, or waits for it to show up and asks it then. The wait
// lasts for the page run, across screens, until Cancel, a connection, the session being cleared or reset, or
// nearby search being turned off or going offline. One wait or request at a time.

// disabled: the setting is off. paused: this device is connected, or pairing with a code.
export type NearbyStatus = 'disabled' | 'paused' | 'starting' | 'listening' | 'offline';

// A session's peer, found among nearby devices by the names it went by.
export interface SessionPeer {
    readonly sessionId: string;
    // The names it may show up under, the one it last used first.
    readonly names: readonly string[];
}

export interface NearbyView {
    readonly status: NearbyStatus;
    readonly devices: readonly NearbyDevice[];
    // The device this one asked, while it waits for the answer.
    readonly asking: NearbyDevice | undefined;
    // The request carries that device's PIN, so it connects without waiting for an Accept.
    readonly isAskingWithPin: boolean;
    // The peer Reconnect waits for, to ask it as soon as it shows up nearby.
    readonly awaited: SessionPeer | undefined;
}

export interface NearbyNote {
    readonly text: string;
    readonly tone: Tone;
    // The device the note is about, so a screen about that device can show it in place.
    readonly name?: string;
}

export interface NearbyController {
    readonly view: NearbyView;
    // Sends this device's offer to one nearby device and waits for its answer; one request at a time.
    // A device with a PIN gets the Enter PIN sheet first, and the request goes once the PIN is entered.
    // Asking a device ends a wait for another.
    connectAsync(nearbyId: string): Promise<void>;
    // Reconnect: asks the peer as connectAsync does when it is listed, or else waits for it to show up nearby and
    // asks it then. Does nothing while busy, or while nearby search can't run.
    reconnect(peer: SessionPeer): void;
    // Withdraws the request waiting for an answer, or stops waiting for a peer to show up.
    cancelRequest(): void;
    // The listed device with one of these names, the most recently seen when several match.
    deviceNamed(names: readonly string[]): NearbyDevice | undefined;
    // Follows the screen and the connection: starts, stops or renames discovery as they require.
    refresh(): void;
    onChange(handler: () => void): Unsubscribe;
    // Why a request ended without pairing, e.g. "Pixel 8 declined.". A handler returns true when it showed the
    // note; one that no handler shows becomes a toast.
    onNote(handler: (note: NearbyNote) => boolean): Unsubscribe;
    dispose(): void;
}

export interface NearbyControllerOptions {
    readonly context: AppContext;
    readonly flow: PairingFlow;
}

interface Asking {
    readonly kind: 'asking';
    readonly device: NearbyDevice;
    readonly abort: AbortController;
    readonly hasPin: boolean;
    // Known once the offer is ready; it settles which of two devices asking each other goes on.
    offerCode: string | undefined;
    // That device's own request to this one, left open while this request goes on; declined once it ends.
    crossedRequestId: string | undefined;
}

// The codes went through the relays (or are on their way); the Connecting screen carries the pairing from here.
interface Pairing {
    readonly kind: 'pairing';
}

type Phase = { readonly kind: 'idle' } | Asking | Pairing;

// The device's PIN sheet, open before a request goes to it.
interface PinEntry {
    readonly device: NearbyDevice;
    readonly handle: ModalHandle;
}

type PinRefusal = Extract<PairRequestOutcome['kind'], 'pin-required' | 'wrong-pin'>;

type Refusal = Exclude<PairRequestOutcome['kind'], 'accepted' | PinRefusal>;

const IDLE: Phase = Object.freeze({ kind: 'idle' });

const PAIRING_ROUTES: readonly Route['name'][] = ['offer', 'scan', 'answer', 'connecting'];
const PAIRING_STATES: readonly ConnectionState[] = [
    'creating-offer',
    'awaiting-answer',
    'answering',
    'connecting',
];

const REFUSAL_NOTES: Readonly<Record<Refusal, (name: string) => NearbyNote>> = Object.freeze({
    'declined': name => ({ text: `${name} declined.`, tone: 'warn' }),
    'busy': name => ({ text: `${name} is busy.`, tone: 'warn' }),
    'no-answer': name => ({ text: `${name} didn’t answer.`, tone: 'warn' }),
    'canceled': name => ({ text: `The request to ${name} was canceled.`, tone: 'info' }),
});

interface AnswerProblem {
    readonly codes: ReadonlyArray<ClientErrorCode | DiscoveryErrorCode>;
    readonly text: (name: string) => string;
}

// Problems with an offer that came through the relays, worded for the device that was asked.
const ANSWER_PROBLEMS: readonly AnswerProblem[] = [
    {
        codes: ['code-expired', 'code-used'],
        text: name => `The request from ${name} expired. Try again from ${name}.`,
    },
    {
        codes: ['code-invalid'],
        text: name => `${name} sent a code that isn’t valid. Try again from ${name}.`,
    },
    {
        codes: ['code-version'],
        text: name => `${name} runs a different version of Ether. Reload Ether on both devices.`,
    },
    {
        codes: ['not-supported'],
        text: () => 'This browser can’t pair. Try another browser on this device.',
    },
    {
        codes: ['request-ended'],
        text: name => `The request from ${name} ended before your reply reached it. Try again from ${name}.`,
    },
    {
        codes: ['send-failed'],
        text: name => `Couldn’t send your reply to ${name}. Try again from ${name}, or pair with a code.`,
    },
];

// Why a request couldn't go out or ended early, worded for the device that asked.
const ASK_PROBLEMS: Readonly<Record<DiscoveryErrorCode, (name: string) => string>> = Object.freeze({
    'not-listening': () => 'Nearby devices can’t be reached right now. Try again soon, or pair with a code.',
    'unknown-device': name => `${name} is no longer nearby. Check Ether is open there, or pair with a code.`,
    'invalid-code': () => 'This device’s code couldn’t be sent. Try again, or pair with a code.',
    'request-ended': name => `The request to ${name} ended without an answer. Try again.`,
    'send-failed': name => `Couldn’t reach ${name} through the relays. Try again, or pair with a code.`,
});

function errorCode(error: unknown): ClientErrorCode | DiscoveryErrorCode | undefined {
    if (error instanceof ClientError || error instanceof DiscoveryError) {
        return error.code;
    }

    return undefined;
}

function describeAskProblem(error: unknown, name: string): string {
    if (error instanceof DiscoveryError) {
        return ASK_PROBLEMS[error.code](name);
    }

    return `Couldn’t ask ${name}. Try again, or pair with a code.`;
}

function describeAnswerProblem(error: unknown, name: string): string {
    const code = errorCode(error);
    const problem = ANSWER_PROBLEMS.find(item => code != null && item.codes.includes(code));

    return problem?.text(name) ?? `Couldn’t connect to ${name}. Try again, or pair with a code.`;
}

function isCanceled(error: unknown): boolean {
    if (error instanceof ClientError) {
        return error.code === 'canceled';
    }

    return error instanceof Error && error.name === 'AbortError';
}

export function createNearbyController(options: NearbyControllerOptions): NearbyController {
    const { context, flow } = options;
    const { client, dialogs, logger } = context;
    const discovery = context.services.discovery;
    const changeHandlers = new Set<() => void>();
    const noteHandlers = new Set<(note: NearbyNote) => boolean>();
    let phase: Phase = IDLE;
    let prompt: { readonly request: PairRequest; readonly handle: ModalHandle } | undefined;
    let pinEntry: PinEntry | undefined;
    let awaited: SessionPeer | undefined;
    // The name discovery runs under; undefined while it is stopped.
    let startedName: string | undefined;
    // The PIN discovery runs with, so a new one reaches it.
    let startedPin: string | null = null;
    let isDisposed = false;

    const emitChange = (): void => {
        for (const handler of changeHandlers) {
            handler();
        }
    };

    const notify = (note: NearbyNote): void => {
        const isShown = [...noteHandlers].some(handler => handler(note));
        if (!isShown) {
            dialogs.toast(note.text, { tone: note.tone });
        }
    };

    const isEnabled = (): boolean => client.settings.findNearbyDevices;

    const isPairingByCode = (): boolean => PAIRING_ROUTES.includes(context.route.name)
        || PAIRING_STATES.includes(client.state);

    const isBusy = (): boolean => prompt != null
        || pinEntry != null
        || phase.kind !== 'idle'
        || client.state === 'connected'
        || isPairingByCode();

    const shouldRun = (): boolean => {
        if (!isEnabled() || client.state === 'connected') {
            return false;
        }

        // A nearby pairing needs the relays until it connects.
        return phase.kind !== 'idle' || !isPairingByCode();
    };

    // Discovery runs and has the internet, so a peer can show up.
    const canLook = (): boolean => startedName != null && discovery.status() !== 'offline';

    const deviceNamed = (names: readonly string[]): NearbyDevice | undefined => {
        const devices = startedName == null ? [] : discovery.devices();

        return devices
            .filter(device => names.includes(device.name))
            .sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
    };

    // Ends Reconnect's wait, if any; the caller shows the change.
    const stopWaiting = (reason: string): void => {
        if (awaited == null) {
            return;
        }

        awaited = undefined;
        logger.info('nearby', 'wait ended', { reason });
    };

    const declineQuietlyAsync = async (requestId: string, reason: 'declined' | 'busy'): Promise<void> => {
        try {
            await discovery.declineAsync(requestId, reason);
        } catch (error) {
            logger.debug('nearby', 'decline not delivered', { reason, error });
        }
    };

    const closePrompt = (requestId: string): void => {
        if (prompt?.request.requestId !== requestId) {
            return;
        }

        const { handle } = prompt;
        prompt = undefined;
        handle.close();
    };

    const closePinEntry = (): void => {
        const entry = pinEntry;
        pinEntry = undefined;
        entry?.handle.close();
    };

    const releaseCrossing = (asking: Asking): void => {
        if (asking.crossedRequestId != null) {
            void declineQuietlyAsync(asking.crossedRequestId, 'busy');
            asking.crossedRequestId = undefined;
        }
    };

    // Without a separate cancel note: the person withdrew it, or a pairing by code took over.
    const withdraw = (asking: Asking): void => {
        asking.abort.abort();
        client.cancelPairing();
        phase = IDLE;
        releaseCrossing(asking);
        logger.info('nearby', 'request withdrawn');
    };

    const settlePhase = (): void => {
        if (phase.kind === 'pairing' && context.route.name !== 'connecting') {
            phase = IDLE;
        }

        const isTakenOver = PAIRING_ROUTES.includes(context.route.name)
            || client.state === 'connected'
            || !isEnabled();
        if (phase.kind === 'asking' && isTakenOver) {
            withdraw(phase);
        }

        const isPromptOver = client.state === 'connected' || isPairingByCode() || !isEnabled();
        if (prompt != null && isPromptOver) {
            const { requestId } = prompt.request;
            closePrompt(requestId);
            void declineQuietlyAsync(requestId, isEnabled() ? 'busy' : 'declined');
        }

        if (pinEntry != null && isPromptOver) {
            closePinEntry();
        }

        if (client.state === 'connected') {
            stopWaiting('connected');
        } else if (!isEnabled()) {
            stopWaiting('nearby turned off');
        }
    };

    const refresh = (): void => {
        if (isDisposed) {
            return;
        }

        settlePhase();
        if (!shouldRun()) {
            if (startedName != null) {
                startedName = undefined;
                startedPin = null;
                discovery.stop();
                logger.info('nearby', 'stopped');
            }

            emitChange();

            return;
        }

        const { deviceName: name, pin } = client.settings;
        if (startedName !== name || startedPin !== pin) {
            startedName = name;
            startedPin = pin;
            discovery.start({
                name,
                deviceType: context.platform.info.deviceType,
                platform: context.platform.devicePlatform(),
                ...(pin == null ? {} : { pin }),
            });
            logger.info('nearby', 'started');
        }

        askAwaited();
        emitChange();
    };

    const viewStatus = (): NearbyStatus => {
        if (!isEnabled()) {
            return 'disabled';
        }

        if (startedName == null) {
            return 'paused';
        }

        const status = discovery.status();

        return status === 'off' ? 'starting' : status;
    };

    const finishRefused = (asking: Asking, refusal: Refusal): void => {
        phase = IDLE;
        client.cancelPairing();
        releaseCrossing(asking);
        logger.info('nearby', 'request ended', { outcome: refusal });
        notify({ ...REFUSAL_NOTES[refusal](asking.device.name), name: asking.device.name });
        refresh();
    };

    // The device's PIN sheet; Connect sends the request with the PIN. It counts as busy while open, so a request
    // that arrives meanwhile isn't shown over it. Screens settle first, so focus comes back to what they show.
    const askForPin = (device: NearbyDevice, error?: string): void => {
        emitChange();
        const handle = openPinEntrySheet(dialogs, {
            device,
            ...(error == null ? {} : { error }),
            onSubmit: pin => {
                pinEntry = undefined;
                void askAsync(device, pin);
            },
            onCancel: () => {
                pinEntry = undefined;
                logger.info('nearby', 'PIN not entered; nothing sent');
            },
        });
        pinEntry = { device, handle };
    };

    // The device has a PIN and no PIN came, or a wrong one: nothing pairs, and its PIN sheet opens again.
    const finishPinRefused = (asking: Asking, refusal: PinRefusal): void => {
        phase = IDLE;
        client.cancelPairing();
        releaseCrossing(asking);
        logger.info('nearby', 'request ended', { outcome: refusal });
        refresh();
        if (startedName != null && !isBusy()) {
            askForPin(asking.device, refusal === 'wrong-pin' ? WRONG_PIN_TEXT : undefined);
        }
    };

    const askAsync = async (device: NearbyDevice, pin: string | undefined): Promise<void> => {
        if (startedName == null || isBusy()) {
            return;
        }

        const asking: Asking = {
            kind: 'asking',
            device,
            abort: new AbortController(),
            hasPin: pin != null,
            offerCode: undefined,
            crossedRequestId: undefined,
        };
        phase = asking;
        logger.info('nearby', 'request', { deviceType: device.deviceType, hasPin: pin != null });
        emitChange();
        let outcome: PairRequestOutcome;
        try {
            const offer = await client.startPairingAsync();
            // Withdrawn while the offer was prepared: the withdrawal already let go of it.
            if (phase !== asking) {
                return;
            }

            asking.offerCode = offer.code;
            const { signal } = asking.abort;
            outcome = await discovery.requestPairingAsync(device.nearbyId, offer.code, {
                signal,
                ...(pin == null ? {} : { pin }),
            });
        } catch (error) {
            if (phase !== asking) {
                return;
            }

            if (isCanceled(error)) {
                finishRefused(asking, 'canceled');

                return;
            }

            phase = IDLE;
            client.cancelPairing();
            releaseCrossing(asking);
            logger.warn('nearby', 'request failed', { error });
            notify({ text: describeAskProblem(error, device.name), tone: 'fail', name: device.name });
            refresh();

            return;
        }

        if (phase !== asking) {
            return;
        }

        if (outcome.kind === 'pin-required' || outcome.kind === 'wrong-pin') {
            finishPinRefused(asking, outcome.kind);

            return;
        }

        if (outcome.kind !== 'accepted') {
            finishRefused(asking, outcome.kind);

            return;
        }

        logger.info('nearby', 'request accepted');
        phase = { kind: 'pairing' };
        releaseCrossing(asking);
        emitChange();
        const problem = await flow.completeNearbyAsync(outcome.answerCode);
        if (problem != null) {
            notify({ text: problem, tone: 'fail', name: device.name });
        }
    };

    const connectAsync = async (nearbyId: string): Promise<void> => {
        const device = discovery.devices().find(item => item.nearbyId === nearbyId);
        if (device == null || startedName == null || isBusy()) {
            return;
        }

        stopWaiting('another device asked');
        if (device.hasPin === true) {
            askForPin(device);

            return;
        }

        await askAsync(device, undefined);
    };

    // The awaited peer, once listed and while nothing else goes on, is asked as a tap on its card would.
    const askAwaited = (): void => {
        const device = awaited == null || isBusy() ? undefined : deviceNamed(awaited.names);
        if (device == null) {
            return;
        }

        awaited = undefined;
        logger.info('nearby', 'awaited device showed up');
        void connectAsync(device.nearbyId);
    };

    const reconnect = (peer: SessionPeer): void => {
        if (!canLook() || isBusy()) {
            return;
        }

        const device = deviceNamed(peer.names);
        if (device != null) {
            void connectAsync(device.nearbyId);

            return;
        }

        awaited = peer;
        logger.info('nearby', 'waiting for a device to show up');
        emitChange();
    };

    const acceptAsync = async (request: PairRequest): Promise<void> => {
        closePrompt(request.requestId);
        const name = request.from.name;
        const pairing: Pairing = { kind: 'pairing' };
        phase = pairing;
        logger.info('nearby', 'request accepted here');
        emitChange();
        try {
            await flow.answerNearbyAsync({
                offerCode: request.offerCode,
                sendAnswerAsync: answerCode => discovery.acceptAsync(request.requestId, answerCode),
                // The asker applies the answer until its request expires, then connects as usual.
                timeoutMs: Math.max(0, request.expiresAt - Date.now())
                    + client.settings.connectTimeoutMs
                    + 1000,
            });
        } catch (error) {
            if (phase === pairing) {
                phase = IDLE;
            }

            void declineQuietlyAsync(request.requestId, 'declined');
            if (!isCanceled(error)) {
                logger.warn('nearby', 'answer failed', { error });
                notify({ text: describeAnswerProblem(error, name), tone: 'fail', name });
            }

            refresh();
        }
    };

    const decline = (request: PairRequest): void => {
        closePrompt(request.requestId);
        logger.info('nearby', 'request declined here');
        void declineQuietlyAsync(request.requestId, 'declined');
        askAwaited();
    };

    const normalizedCode = (code: string): string => client.inspectCode(code)?.code ?? code;

    // Both devices asked each other. The one whose offer code sorts first goes on with its request and leaves
    // the other's open; the other withdraws its own and takes the incoming one without asking, since its
    // person already asked for exactly this device. A device whose offer isn't ready has sent nothing yet, so
    // it is the one that yields.
    const resolveCrossing = (asking: Asking, request: PairRequest): void => {
        const own = asking.offerCode == null ? undefined : normalizedCode(asking.offerCode);
        if (own != null && own < normalizedCode(request.offerCode)) {
            logger.info('nearby', 'crossing request left open');
            releaseCrossing(asking);
            asking.crossedRequestId = request.requestId;

            return;
        }

        logger.info('nearby', 'crossing request taken');
        withdraw(asking);
        void acceptAsync(request);
    };

    const isPairedBefore = (name: string): boolean => context.sessions.sessions
        .some(session => session.peerName === name);

    const onRequest = (request: PairRequest): void => {
        if (phase.kind === 'asking' && phase.device.nearbyId === request.from.nearbyId) {
            resolveCrossing(phase, request);

            return;
        }

        // Asked by the very device whose PIN is being typed: its person already asked for exactly this device.
        if (pinEntry?.device.nearbyId === request.from.nearbyId) {
            logger.info('nearby', 'request from the device whose PIN is being entered taken');
            closePinEntry();
            void acceptAsync(request);

            return;
        }

        if (isBusy()) {
            logger.info('nearby', 'request answered busy');
            void declineQuietlyAsync(request.requestId, 'busy');

            return;
        }

        // The awaited peer asked first: its request, answered as any other, takes the wait's place.
        if (awaited?.names.includes(request.from.name) === true) {
            stopWaiting('asked by the awaited device');
            emitChange();
        }

        // The asker entered this device's PIN, which stands in for Accept (SP-11).
        if (request.isPinVerified) {
            logger.info('nearby', 'request with the right PIN taken without asking');
            dialogs.toast(`${request.from.name} entered your PIN.`, { tone: 'info' });
            void acceptAsync(request);

            return;
        }

        const handle = openNearbyPrompt(dialogs, {
            request,
            isPairedBefore: isPairedBefore(request.from.name),
            onAccept: () => {
                void acceptAsync(request);
            },
            onDecline: () => decline(request),
        });
        prompt = { request, handle };
    };

    const onRequestEnded = (requestId: string): void => {
        if (prompt?.request.requestId !== requestId) {
            return;
        }

        const { from, expiresAt } = prompt.request;
        closePrompt(requestId);
        dialogs.toast(Date.now() >= expiresAt
            ? `The request from ${from.name} expired.`
            : `${from.name} canceled.`);
        askAwaited();
    };

    // Clearing the session, or resetting it, ends a wait for its peer.
    const endWaitFor = (sessionId: string, reason: string): void => {
        if (awaited?.sessionId === sessionId) {
            stopWaiting(reason);
            emitChange();
        }
    };

    const unsubscribers = [
        discovery.on('status', status => {
            if (status === 'offline') {
                stopWaiting('offline');
            }

            emitChange();
        }),
        discovery.on('devices', () => {
            askAwaited();
            emitChange();
        }),
        discovery.on('request', onRequest),
        discovery.on('request-ended', onRequestEnded),
        client.on('state', () => refresh()),
        client.on('settings', () => refresh()),
        client.on('session-cleared', (sessionId, scope) => {
            if (scope === 'all') {
                endWaitFor(sessionId, 'session reset');
            }
        }),
        client.on('session-reset', reset => endWaitFor(reset.sessionId, 'session reset')),
        context.sessions.subscribe(() => {
            if (awaited != null && context.sessions.isLoaded && context.sessions.find(awaited.sessionId) == null) {
                endWaitFor(awaited.sessionId, 'session cleared');
            }
        }),
    ];

    return {
        get view() {
            return {
                status: viewStatus(),
                devices: startedName == null ? [] : discovery.devices(),
                asking: phase.kind === 'asking' ? phase.device : undefined,
                isAskingWithPin: phase.kind === 'asking' && phase.hasPin,
                awaited,
            };
        },
        connectAsync,
        reconnect,
        deviceNamed,
        cancelRequest: () => {
            if (awaited != null) {
                stopWaiting('canceled');
                emitChange();
            }

            if (phase.kind !== 'asking') {
                return;
            }

            withdraw(phase);
            refresh();
        },
        refresh,
        onChange: handler => {
            changeHandlers.add(handler);

            return () => {
                changeHandlers.delete(handler);
            };
        },
        onNote: handler => {
            noteHandlers.add(handler);

            return () => {
                noteHandlers.delete(handler);
            };
        },
        dispose: () => {
            isDisposed = true;
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            if (phase.kind === 'asking') {
                phase.abort.abort();
            }

            phase = IDLE;
            awaited = undefined;
            prompt?.handle.close();
            prompt = undefined;
            closePinEntry();
            if (startedName != null) {
                startedName = undefined;
                startedPin = null;
                discovery.stop();
            }

            changeHandlers.clear();
            noteHandlers.clear();
        },
    };
}
