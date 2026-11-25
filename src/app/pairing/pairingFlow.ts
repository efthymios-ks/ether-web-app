import { ClientError } from '../../client/clientTypes.js';
import type { ClientErrorCode, Peer } from '../../client/clientTypes.js';
import type { AppContext, Route } from '../appContext.js';

// The steps of §3 behind "Pair with a code". The code says offer and answer; the screens say "your code"
// and "reply": Show my code → (reply scanned or pasted) → connecting → connected,
// or a code read → reply shown → connected.

export type StepStatus = 'idle' | 'preparing' | 'ready' | 'failed';
export type CodeSource = 'scan' | 'paste' | 'link' | 'relay';

export interface SubmitOptions {
    readonly source: CodeSource;
    // What the screen asked for; the other kind gets a clear message instead of a surprise.
    readonly expect?: 'offer' | 'reply';
    // HS-05: the scanner's hold on the camera, released once gathering is over.
    readonly releaseCamera?: () => void;
}

export interface NearbyAnswerOptions {
    readonly offerCode: string;
    // Sends the answer back through the relays to the device that asked.
    readonly sendAnswerAsync: (answerCode: string) => Promise<void>;
    // How long to wait for the connection once the answer is on its way (HS-10).
    readonly timeoutMs: number;
}

export interface PairingFlow {
    readonly offer: { readonly code: string; readonly url: string; readonly expiresAt: number } | undefined;
    readonly offerStatus: StepStatus;
    readonly answer: { readonly answerCode: string; readonly answerUrl: string } | undefined;
    readonly answerStatus: StepStatus;
    // HS-06: shown on the answer screen when the code came from the system Camera.
    readonly answerNote: string | undefined;
    // The last problem, once: the screen the user lands on shows it, and it is gone after that.
    takeError(): string | undefined;
    // Leaves any pairing by code under way and opens "Pair with a code"; its Back returns to where it was opened.
    // Beside Home's sidebar, Home's own pane is that menu (D9), so Home opens instead when it was opened from there.
    openMenu(): void;
    showCodeAsync(): Promise<void>;
    scanCode(): void;
    scanAnswer(): void;
    // Resolves to a message to show, or undefined when the code was taken.
    submitCodeAsync(text: string, options: SubmitOptions): Promise<string | undefined>;
    // HS-07: a code forwarded from another tab; true when this tab takes it.
    takeRelayedCode(text: string): boolean;
    // Nearby, asking side: the other device accepted this device's offer and answered. Connects as Paste reply
    // does; resolves to a problem to show on the screen it returns to, or undefined.
    completeNearbyAsync(answerCode: string): Promise<string | undefined>;
    // Nearby, asked side: answers the offer behind the Connecting screen, since no reply needs showing, then waits
    // as the reply screen does. Rejects when answering fails, or with `canceled` when Cancel was tapped meanwhile.
    answerNearbyAsync(options: NearbyAnswerOptions): Promise<void>;
    expireOffer(): void;
    // Stops pairing by code and goes back to where it started, or to `destination`.
    cancel(destination?: Route): void;
    onChange(handler: () => void): () => void;
    dispose(): void;
}

type ErrorOutcome =
    | { readonly codes: readonly ClientErrorCode[]; readonly route: 'expired' | 'failure' }
    | { readonly codes: readonly ClientErrorCode[]; readonly message: string };

const ERROR_OUTCOMES: readonly ErrorOutcome[] = [
    { codes: ['code-expired', 'code-used'], route: 'expired' },
    { codes: ['connect-timeout', 'ice-failed', 'gathering-timeout'], route: 'failure' },
    { codes: ['code-invalid'], message: 'That code isn’t valid. Check it and try again.' },
    { codes: ['code-version'], message: 'This code comes from a different version of Ether. Reload Ether on both devices.' },
    { codes: ['not-supported'], message: 'This browser can’t pair. Try another browser on this device.' },
];

export const EXPIRED_TEXT = 'This code expired, show a new one.';
export const NOT_A_CODE_TEXT = 'That isn’t an Ether code. Copy it again and try once more.';
export const REPLY_PASTED_TEXT = 'That’s a reply. Paste it on the first device, the one showing its code.';
export const REPLY_SCANNED_TEXT = 'That’s a reply. Scan it with the first device, the one showing its code.';
export const OFFER_WHERE_REPLY_TEXT = 'That’s a code, not a reply. Scan or paste it on the other device.';

const FAILURE_CODES: readonly ClientErrorCode[] = ['connect-timeout', 'ice-failed', 'gathering-timeout', 'protocol-version'];
const PAIRING_ROUTES: readonly Route['name'][] = ['offer', 'scan', 'answer', 'connecting'];
// Screens of pairing by code; going back from them returns to the screen before the first of them.
const CODE_ROUTES: readonly Route['name'][] = [...PAIRING_ROUTES, 'pair', 'failure', 'expired'];

export function createPairingFlow(context: AppContext): PairingFlow {
    const { client, logger } = context;
    const handlers = new Set<() => void>();
    let offer: PairingFlow['offer'];
    let offerStatus: StepStatus = 'idle';
    let answer: PairingFlow['answer'];
    let answerStatus: StepStatus = 'idle';
    let answerNote: string | undefined;
    let error: string | undefined;
    let returnRoute: Route = { name: 'home' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Counts Cancel taps, so a step that finishes after one doesn't move the screen again.
    let cancelCount = 0;

    const emit = (): void => {
        for (const handler of handlers) {
            handler();
        }
    };

    const clearTimer = (): void => {
        if (timer != null) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const rememberReturnRoute = (): void => {
        if (!CODE_ROUTES.includes(context.route.name)) {
            returnRoute = context.route;
        }
    };

    // This flow holds a code, or a screen of it is busy pairing; a nearby request on Home is none of these.
    const isUnderWay = (): boolean => offerStatus !== 'idle'
        || answerStatus !== 'idle'
        || PAIRING_ROUTES.includes(context.route.name);

    const resetSteps = (): void => {
        clearTimer();
        offer = undefined;
        offerStatus = 'idle';
        answer = undefined;
        answerStatus = 'idle';
        answerNote = undefined;
    };

    const fail = (reason: string): void => {
        clearTimer();
        logger.warn('pair', 'pairing failed', { reason });
        client.cancelPairing();
        resetSteps();
        context.navigate({ name: 'failure', reason });
        emit();
    };

    // HS-10: not connected 15 s after the answer was applied.
    const startTimer = (ms: number): void => {
        clearTimer();
        timer = setTimeout(() => {
            timer = undefined;
            if (client.state !== 'connected') {
                fail('timeout');
            }
        }, ms);
    };

    const handleError = (caught: unknown, fallbackRoute: Route): string | undefined => {
        const code: ClientErrorCode = caught instanceof ClientError ? caught.code : 'internal';
        if (code === 'canceled') {
            return undefined;
        }

        const outcome = ERROR_OUTCOMES.find(item => item.codes.includes(code));
        if (outcome != null && 'route' in outcome) {
            clearTimer();
            client.cancelPairing();
            resetSteps();
            context.navigate(outcome.route === 'failure' ? { name: 'failure', reason: code } : { name: 'expired' });
            emit();

            return undefined;
        }

        const message = outcome?.message ?? (caught instanceof Error ? caught.message : 'Pairing failed.');
        error = message;
        if (context.route.name !== fallbackRoute.name) {
            context.navigate(fallbackRoute);
        }

        emit();

        return message;
    };

    const onConnected = (peer: Peer): void => {
        clearTimer();
        resetSteps();
        error = undefined;
        if (context.route.name !== 'session' || context.route.sessionId !== peer.sessionId) {
            context.navigate({ name: 'session', sessionId: peer.sessionId });
        }

        emit();
    };

    const completeAsync = async (code: string, fallbackRoute: Route): Promise<string | undefined> => {
        const cancels = cancelCount;
        context.navigate({ name: 'connecting' });
        startTimer(client.settings.connectTimeoutMs + 1000);
        try {
            const peer = await client.completePairingAsync(code);
            onConnected(peer);

            return undefined;
        } catch (caught) {
            if (cancelCount !== cancels) {
                return undefined;
            }

            return handleError(caught, fallbackRoute);
        }
    };

    const answerNearbyAsync = async (options: NearbyAnswerOptions): Promise<void> => {
        const cancels = cancelCount;
        rememberReturnRoute();
        resetSteps();
        error = undefined;
        context.navigate({ name: 'connecting' });
        emit();
        try {
            const answer = await client.joinWithCodeAsync(options.offerCode);
            if (cancelCount !== cancels) {
                throw new ClientError('canceled', 'Pairing was canceled.');
            }

            await options.sendAnswerAsync(answer.answerCode);
            if (cancelCount !== cancels) {
                throw new ClientError('canceled', 'Pairing was canceled.');
            }

            startTimer(options.timeoutMs);
        } catch (caught) {
            // After Cancel the screen has moved on, and another pairing may have started; leave both alone.
            if (cancelCount === cancels) {
                client.cancelPairing();
                if (context.route.name === 'connecting') {
                    context.navigate(returnRoute);
                }

                emit();
            }

            throw caught;
        }
    };

    const joinAsync = async (code: string, options: SubmitOptions): Promise<string | undefined> => {
        if (offerStatus !== 'idle') {
            client.cancelPairing();
        }

        // A problem is explained where the code came in: the scan screen, the screen it was pasted on, or Home.
        const origin = context.route;
        const fallback: Route = options.source === 'scan'
            ? { name: 'scan', purpose: 'offer' }
            : CODE_ROUTES.includes(origin.name) && origin.name !== 'pair' ? returnRoute : origin;
        rememberReturnRoute();
        resetSteps();
        error = undefined;
        answerStatus = 'preparing';
        answerNote = options.source === 'link' ? context.platform.systemCameraNote() : undefined;
        context.navigate({ name: 'answer' });
        emit();
        try {
            answer = await client.joinWithCodeAsync(code);
            answerStatus = 'ready';
            // B can't see when A applies the answer; give up once A's code would have expired and timed out.
            startTimer(client.settings.codeExpiryMs + client.settings.connectTimeoutMs);
            emit();

            return undefined;
        } catch (caught) {
            answerStatus = 'failed';

            return handleError(caught, fallback);
        } finally {
            options.releaseCamera?.();
        }
    };

    const submitCodeAsync = async (text: string, options: SubmitOptions): Promise<string | undefined> => {
        const info = client.inspectCode(text);
        if (info == null) {
            options.releaseCamera?.();

            return NOT_A_CODE_TEXT;
        }

        logger.info('pair', 'code read', { kind: info.kind, source: options.source, expired: info.expired });
        // HS-08: a pasted or scanned old code is explained in place; a link has no box, so it gets the screen.
        if (info.expired) {
            options.releaseCamera?.();
            if (options.source === 'link' || options.source === 'relay') {
                handleError(new ClientError('code-expired', 'expired'), { name: 'expired' });

                return undefined;
            }

            return EXPIRED_TEXT;
        }

        if (info.kind === 'answer') {
            options.releaseCamera?.();
            if (options.expect === 'offer' || offer == null || offerStatus !== 'ready') {
                return options.source === 'scan' ? REPLY_SCANNED_TEXT : REPLY_PASTED_TEXT;
            }

            return completeAsync(info.code, { name: 'offer' });
        }

        if (options.expect === 'reply') {
            options.releaseCamera?.();

            return OFFER_WHERE_REPLY_TEXT;
        }

        return joinAsync(info.code, options);
    };

    const unsubscribers = [
        client.on('peer', (kind, peer) => {
            if (kind === 'connected') {
                onConnected(peer);
            }
        }),
        client.on('error', clientError => {
            if (!PAIRING_ROUTES.includes(context.route.name)) {
                return;
            }

            if (FAILURE_CODES.includes(clientError.code)) {
                fail(clientError.code);

                return;
            }

            if (clientError.code === 'code-expired' && context.route.name === 'offer') {
                handleError(clientError, { name: 'expired' });
            }
        }),
    ];

    return {
        get offer() {
            return offer;
        },
        get offerStatus() {
            return offerStatus;
        },
        get answer() {
            return answer;
        },
        get answerStatus() {
            return answerStatus;
        },
        get answerNote() {
            return answerNote;
        },
        takeError: () => {
            const taken = error;
            error = undefined;

            return taken;
        },
        openMenu: () => {
            if (isUnderWay()) {
                cancelCount++;
                client.cancelPairing();
            }

            rememberReturnRoute();
            resetSteps();
            error = undefined;
            const isHomeTheMenu = returnRoute.name === 'home' && context.layout.hasSidebar;
            context.navigate(isHomeTheMenu ? { name: 'home' } : { name: 'pair' });
            emit();
        },
        showCodeAsync: async () => {
            if (offerStatus === 'preparing') {
                context.navigate({ name: 'offer' });

                return;
            }

            if (offer != null && offerStatus === 'ready' && offer.expiresAt > Date.now()) {
                context.navigate({ name: 'offer' });

                return;
            }

            rememberReturnRoute();
            client.cancelPairing();
            resetSteps();
            error = undefined;
            offerStatus = 'preparing';
            context.navigate({ name: 'offer' });
            emit();
            try {
                offer = await client.startPairingAsync();
                offerStatus = 'ready';
                logger.info('pair', 'offer shown', { expiresAt: offer.expiresAt });
                emit();
            } catch (caught) {
                offerStatus = 'failed';
                handleError(caught, { name: 'offer' });
            }
        },
        scanCode: () => {
            error = undefined;
            if (!context.hasCamera && context.focusCodeEntry()) {
                return;
            }

            rememberReturnRoute();
            context.navigate({ name: 'scan', purpose: 'offer' });
        },
        scanAnswer: () => {
            error = undefined;
            if (!context.hasCamera && context.route.name === 'offer' && context.focusCodeEntry()) {
                return;
            }

            context.navigate({ name: 'scan', purpose: 'answer' });
        },
        submitCodeAsync,
        takeRelayedCode: text => {
            const info = client.inspectCode(text);
            if (info == null || info.expired) {
                return false;
            }

            const isWaitingForAnswer = info.kind === 'answer' && offer != null && offerStatus === 'ready';
            const isFree = info.kind === 'offer' && client.state !== 'connected' && !PAIRING_ROUTES.includes(context.route.name);
            if (!isWaitingForAnswer && !isFree) {
                return false;
            }

            void submitCodeAsync(text, { source: 'relay' });

            return true;
        },
        completeNearbyAsync: async answerCode => {
            rememberReturnRoute();
            resetSteps();
            error = undefined;

            return completeAsync(answerCode, returnRoute);
        },
        answerNearbyAsync,
        expireOffer: () => {
            client.cancelPairing();
            resetSteps();
            context.navigate({ name: 'expired' });
            emit();
        },
        cancel: destination => {
            if (isUnderWay()) {
                cancelCount++;
                client.cancelPairing();
            }

            resetSteps();
            error = undefined;
            context.navigate(destination ?? returnRoute);
            emit();
        },
        onChange: handler => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
        dispose: () => {
            clearTimer();
            handlers.clear();
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
    };
}
