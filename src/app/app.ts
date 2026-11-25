import type { Client, TestTool } from '../client/clientTypes.js';
import type { Logger } from '../core/logger.js';
import type { InstallMethod, Platform } from '../platform/platform.js';
import type { AppContext, AppServices, LinkEnd, Route, Screen } from './appContext.js';
import type { Dialogs } from './dialogs.js';
import { h } from './dom.js';
import { formatCount } from './format.js';
import { createRestorePrompt } from './history/restorePrompt.js';
import { createSessionsDrawer } from './history/sessionList.js';
import { createSessionScreen } from './history/sessionScreen.js';
import type { SessionScreen } from './history/sessionScreen.js';
import { createSessionsStore } from './history/sessionsStore.js';
import { createNearbyController } from './nearby/nearbyController.js';
import type { CameraHub } from './pairing/cameraHub.js';
import { createPairingFlow } from './pairing/pairingFlow.js';
import { createPairingRelay } from './pairing/pairingRelay.js';
import type { PairingRelay } from './pairing/pairingRelay.js';
import {
    createAnswerScreen,
    createConnectingScreen,
    createExpiredScreen,
    createFailureScreen,
    createHomeScreen,
    createOfferScreen,
    createPairScreen,
    createScanScreen,
} from './pairing/pairingScreens.js';
import { createBanners } from './shell/banners.js';
import type { BannerState } from './shell/banners.js';
import { createHeader } from './shell/header.js';
import { createHomePanel } from './shell/homePanel.js';
import { watchKeyboardInset } from './shell/keyboardInset.js';
import { createShellLayout } from './shell/layout.js';
import { PAIRING_CONTINUED_TEXT, PAIRING_CONTINUED_TITLE } from './shell/startupGuards.js';
import { createWakeLock } from './shell/wakeLock.js';
import type { WakeLockController } from './shell/wakeLock.js';
import { createFileActions, describeClientError } from './transfers/fileActions.js';
import { createIncomingPrompts } from './transfers/incomingPrompts.js';
import { createPickers } from './transfers/pickers.js';
import type { PickedFiles } from './transfers/pickers.js';
import { createTransferTracker } from './transfers/transferTracker.js';

// The page shell (UI-12, §13, UI plan §4.9) and the screens it switches between. Everything goes through
// the client (AR-02). Home's panel (identity and nearby devices) lives as long as the app, beside the screen's pane:
// on one column it is Home itself; on wide screens and landscape phones, while not connected, it is the sidebar
// beside the pane on Home and while pairing with a code. A session takes the whole width.

export interface InstallControllerLike {
    readonly method: InstallMethod;
    readonly canPrompt: boolean;
    promptAsync(): Promise<boolean>;
    steps(): readonly string[];
    on(name: 'change', handler: () => void): () => void;
}

export interface ServiceWorkerLike {
    onUpdateReady(handler: () => void): () => void;
    applyUpdate(): void;
}

export interface SettingsSheetLike {
    open(): void;
}

export interface LogViewerLike {
    open(): void;
    showTimeline(): void;
}

export interface AppOptions {
    // The `[data-role="app"]` element of index.html.
    readonly root: HTMLElement;
    readonly client: Client;
    readonly platform: Platform;
    readonly logger: Logger;
    readonly services: AppServices;
    readonly dialogs: Dialogs;
    readonly camera: CameraHub;
    readonly wakeLock?: WakeLockController;
    // Opened by the header's Settings button.
    readonly settingsSheet?: SettingsSheetLike;
    // Only with ?debug=1 (DL-01): the failure screen links to its timeline only then.
    readonly logViewer?: LogViewerLike;
    readonly serviceWorker?: ServiceWorkerLike;
    readonly install?: InstallControllerLike;
    readonly createRelay?: (onCode: (code: string) => boolean) => PairingRelay;
}

export interface App {
    readonly route: Route;
    readonly context: AppContext;
    navigate(route: Route): void;
    startAsync(options?: { readonly hashCode?: string }): Promise<void>;
    dispose(): void;
}

const PAIRING_ROUTES: readonly Route['name'][] = ['offer', 'scan', 'answer', 'connecting'];
// "Pair with a code" and its steps: in the pane beside Home's sidebar on wide screens.
const CODE_ROUTES: readonly Route['name'][] = ['pair', ...PAIRING_ROUTES, 'failure', 'expired'];

export function createApp(options: AppOptions): App {
    const { root, client, platform, logger, dialogs } = options;
    const { discovery } = options.services;
    const tracker = createTransferTracker(client);
    const sessions = createSessionsStore(client, logger);
    const wakeLock = options.wakeLock ?? createWakeLock({ logger });
    const dataHandlers = new Set<() => void>();
    const disposers: Array<() => void> = [];
    let route: Route = { name: 'home' };
    let screen: Screen | undefined;
    let testTools: readonly TestTool[] = client.activeTestTools;
    let isUpdateReady = false;
    let isFirstRender = true;
    let hasCamera = platform.info.capabilities.camera;
    let lastLinkEnd: LinkEnd | undefined;

    // Registered before any screen, so screens see the link end that their own handlers react to.
    disposers.push(
        client.on('peer', (kind, peer) => {
            if (kind === 'left') {
                lastLinkEnd = { sessionId: peer.sessionId, peerName: peer.displayName, byPeer: true };
            }
        }),
        client.on('state', state => {
            const peer = client.peer;
            if (state === 'connected') {
                lastLinkEnd = undefined;

                return;
            }

            if (state === 'lost' && peer != null && lastLinkEnd?.sessionId !== peer.sessionId) {
                lastLinkEnd = { sessionId: peer.sessionId, peerName: peer.displayName, byPeer: false };
            }
        }),
    );

    const pane = h('div', { class: 'app-pane' });
    const main = h('main', { class: 'app-main', attrs: { id: 'main', tabindex: '-1' } });
    const layout = createShellLayout(client);

    const context: AppContext = {
        client,
        platform,
        logger,
        dialogs,
        services: options.services,
        camera: options.camera,
        tracker,
        sessions,
        wakeLock,
        layout,
        get nearby() {
            return nearby;
        },
        get route() {
            return route;
        },
        get hasCamera() {
            return hasCamera;
        },
        get lastLinkEnd() {
            return lastLinkEnd;
        },
        hasLogViewer: options.logViewer != null,
        navigate: next => navigate(next),
        focusCodeEntry: () => {
            if (screen?.codeEntry == null) {
                return false;
            }

            screen.codeEntry.focus();

            return true;
        },
        openLogViewer: () => options.logViewer?.open(),
        showTimeline: () => {
            if (options.logViewer == null) {
                dialogs.toast('The log viewer is not available.', { tone: 'warn' });

                return;
            }

            options.logViewer.showTimeline();
        },
        pickFiles: kind => pickers.open(kind),
        pickFilesToResume: () => pickers.openResume(),
        notifyDataChanged: () => {
            sessions.refreshSoon();
            for (const handler of dataHandlers) {
                handler();
            }
        },
        onDataChanged: handler => {
            dataHandlers.add(handler);

            return () => {
                dataHandlers.delete(handler);
            };
        },
    };

    const flow = createPairingFlow(context);
    const nearby = createNearbyController({ context, flow });
    const fileActions = createFileActions(context);
    const drawer = createSessionsDrawer({ context, flow, onOpenChange: isOpen => header.setHistoryOpen(isOpen) });
    const restorePrompt = createRestorePrompt(context);
    const incomingPrompts = createIncomingPrompts({ context });
    // The sidebar shows only while the layout splits; on one column Home's panel shows on Home alone.
    const homePanel = createHomePanel({
        context,
        flow,
        isShown: () => route.name === 'home' || (root.dataset.split === 'true' && layout.hasSidebar),
    });

    const sendAsync = async (picked: PickedFiles): Promise<void> => {
        const peer = client.peer;
        if (client.state !== 'connected' || peer == null) {
            dialogs.toast('Pair a device first, then pick the files.', { tone: 'warn' });

            return;
        }

        try {
            const hasPaths = picked.relativePaths.some(path => path != null);
            await client.sendFilesAsync(picked.files, hasPaths ? { relativePaths: picked.relativePaths } : undefined);
            // The Send tab's progress view shows the files going; no toast repeats it.
            navigate({ name: 'session', sessionId: peer.sessionId, tab: 'send' });
        } catch (error) {
            dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    };

    const resumeWithAsync = async (files: File[]): Promise<void> => {
        try {
            // Only the connected session's waiting files: another session's file with the same name stays put.
            const match = await client.resumeWithFilesAsync(files, { sessionId: client.peer?.sessionId });
            if (match.matched.length > 0) {
                dialogs.toast(`Resuming ${formatCount(match.matched.length, 'file')}.`, { tone: 'ok' });
            }

            if (match.unmatched.length === 0) {
                return;
            }

            const isConfirmed = await dialogs.confirmAsync({
                title: 'Send as new files?',
                message: `${formatCount(match.unmatched.length, 'file')} didn’t match anything waiting to resume. Send them as new files?`,
                confirmLabel: 'Send',
            });
            if (isConfirmed) {
                await sendAsync({ files: [...match.unmatched], relativePaths: match.unmatched.map(() => undefined) });
            }
        } catch (error) {
            dialogs.toast(describeClientError(error), { tone: 'fail' });
        }
    };

    const pickers = createPickers({
        platform,
        onPick: picked => {
            void sendAsync(picked);
        },
        onResumePick: files => {
            void resumeWithAsync(files);
        },
    });

    // R9: the logo always goes Home, leaving any pairing by code; while connected Home shows the connected device.
    const header = createHeader({
        onHome: () => {
            if (CODE_ROUTES.includes(route.name)) {
                flow.cancel({ name: 'home' });

                return;
            }

            navigate({ name: 'home' });
        },
        onHistory: () => drawer.open(),
        onSettings: () => options.settingsSheet?.open(),
    });

    const banners = createBanners({
        applyUpdate: () => {
            if (tracker.isTransferring) {
                dialogs.toast('The update installs once the transfer finishes.', { tone: 'warn' });

                return;
            }

            options.serviceWorker?.applyUpdate();
        },
        turnOffTestTools: () => {
            for (const tool of testTools) {
                client.setTestTool(tool, false);
            }
        },
        promptInstall: () => {
            void options.install?.promptAsync();
        },
        showInstallSteps: () => {
            void dialogs.alertAsync({
                title: 'Install Ether',
                body: h('ol', { class: 'save-steps', children: (options.install?.steps() ?? platform.installSteps()).map(step => h('li', { text: step })) }),
            });
        },
        copyLink: () => {
            void copyLinkAsync();
        },
    });

    const copyLinkAsync = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(globalThis.location.href);
            dialogs.toast('Link copied. Paste it into your browser.', { tone: 'ok' });
        } catch {
            dialogs.toast('Copy the address from the menu instead.', { tone: 'warn' });
        }
    };

    const SCREENS: Readonly<{ [Name in Route['name']]: (route: Extract<Route, { name: Name }>) => Screen }> = {
        home: () => createHomeScreen(context, flow, homePanel),
        pair: () => createPairScreen(context, flow),
        offer: () => createOfferScreen(context, flow),
        scan: next => createScanScreen(context, flow, next.purpose),
        answer: () => createAnswerScreen(context, flow),
        connecting: () => createConnectingScreen(context, flow),
        failure: next => createFailureScreen(context, flow, next.reason),
        expired: () => createExpiredScreen(context, flow),
        session: next => createSessionScreen({
            context,
            flow,
            actions: fileActions,
            sessionId: next.sessionId,
            tab: next.tab ?? (client.state === 'connected' ? 'send' : 'received'),
            scroller: main,
        }),
    };

    const createScreen = (next: Route): Screen => (SCREENS[next.name] as (value: Route) => Screen)(next);

    const navigate = (next: Route): void => {
        const current = screen as SessionScreen | undefined;
        if (next.name === 'session' && route.name === 'session' && current?.sessionId === next.sessionId) {
            if (next.tab != null) {
                current.setTab(next.tab);
            }

            route = next;

            return;
        }

        screen?.dispose();
        route = next;
        const created = createScreen(next);
        screen = created;
        pane.replaceChildren(created.element);
        main.scrollTop = 0;
        pane.scrollTop = 0;
        root.dataset.screen = next.name;
        refreshShell();
        if (!isFirstRender) {
            if (next.name === 'home') {
                homePanel.focus();
            } else {
                created.element.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
            }
        }

        isFirstRender = false;
        logger.debug('app', 'screen', { screen: next.name });
        // Pairing by QR code or copy and paste pauses nearby devices; leaving it resumes them.
        nearby.refresh();
    };

    const bannerState = (): BannerState => {
        const install = options.install;

        return {
            updateReady: isUpdateReady,
            isTransferring: tracker.isTransferring,
            testTools,
            wakeUnsupported: !wakeLock.isSupported && wakeLock.isWanted,
            backgroundWarning: platform.suspendsInBackground ? platform.transferBackgroundWarning() : undefined,
            identityNote: platform.identityNote(),
            install: install == null || install.method === 'none' ? undefined : { method: install.method, canPrompt: install.canPrompt },
            inAppNote: platform.inAppBrowserNote(),
            // Only while nearby devices are on: with the setting off, the relay doesn't matter.
            relayAllowance: nearby.view.status === 'disabled' ? undefined : discovery.relayAllowance(),
        };
    };

    const refreshShell = (): void => {
        wakeLock.set('transfer', tracker.isTransferring);
        // WL-01: the screen stays on while connected, not only during transfers; there is no setting for it.
        wakeLock.set('connected', client.state === 'connected');
        banners.update(bannerState());
        root.dataset.connection = client.state;
        // D8: connected, the session and Home take the whole width; otherwise Home and pairing by code may split.
        const isSplitRoute = route.name === 'home' || CODE_ROUTES.includes(route.name);
        const split = String(isSplitRoute && client.state !== 'connected');
        if (root.dataset.split !== split) {
            root.dataset.split = split;
        }
    };

    const onPaste = (event: ClipboardEvent): void => {
        const target = event.target as HTMLElement | null;
        const isEditable = target != null && (target.closest('input, textarea, [contenteditable="true"]') != null);
        const text = event.clipboardData?.getData('text') ?? '';
        if (isEditable || screen?.codeEntry == null || text.trim().length === 0) {
            return;
        }

        event.preventDefault();
        void screen.codeEntry.pasteAsync(text);
    };

    const handleLinkCodeAsync = async (code: string): Promise<void> => {
        const info = client.inspectCode(code);
        if (info == null) {
            dialogs.toast('This page was opened without a valid Ether code.', { tone: 'warn' });

            return;
        }

        if (info.expired) {
            navigate({ name: 'expired' });

            return;
        }

        if (info.kind === 'offer') {
            await flow.submitCodeAsync(code, { source: 'link' });

            return;
        }

        // HS-07: the reply belongs to an offer held by another tab.
        const isTaken = await relay.forwardAsync(code);
        if (isTaken) {
            // Not awaited: start-up carries on while the note stays until dismissed.
            void dialogs.alertAsync({ title: PAIRING_CONTINUED_TITLE, message: PAIRING_CONTINUED_TEXT });

            return;
        }

        await dialogs.alertAsync({
            title: 'Scan the reply from inside the app',
            message: 'This reply belongs to a code shown in an Ether tab that isn’t open any more. '
                + 'On the first device, tap Show my code again, then Scan reply or Paste reply inside Ether.',
        });
    };

    const relay = (options.createRelay ?? (onCode => createPairingRelay({ onCode })))(code => flow.takeRelayedCode(code));

    main.replaceChildren(homePanel.element, pane);
    root.replaceChildren(
        header.element,
        banners.element,
        h('div', { class: 'app-body', children: [main] }),
        pickers.inputs,
    );
    root.dataset.platform = platform.kind;

    disposers.push(
        client.on('state', () => {
            refreshShell();
        }),
        client.on('peer', (kind, peer) => {
            // Connecting shows on screen and in the peer bar; only a peer leaving gets a toast.
            if (kind === 'left') {
                dialogs.toast(`${peer.displayName} disconnected.`, { tone: 'info' });
            }

            refreshShell();
        }),
        client.on('settings', () => refreshShell()),
        client.on('test-tools', active => {
            testTools = active;
            refreshShell();
        }),
        client.on('notice', notice => {
            const texts: Readonly<Record<typeof notice.kind, string>> = {
                'partials-expired': `${formatCount(notice.count, 'old partial file')} deleted to free space.`,
                'history-trimmed': `${formatCount(notice.count, 'old history entry', 'old history entries')} cleared.`,
            };
            dialogs.toast(texts[notice.kind]);
        }),
        client.on('sync', decisions => {
            const resuming = decisions.filter(decision => decision.decision === 'resume' || decision.decision === 'adopted').length;
            const lost = decisions.filter(decision => decision.decision === 'data-lost').length;
            if (resuming > 0) {
                dialogs.toast(`Resuming ${formatCount(resuming, 'file')} where they stopped.`, { tone: 'ok' });
            }

            if (lost > 0) {
                dialogs.toast(`Partial data of ${formatCount(lost, 'file')} was lost, restarting.`, { tone: 'warn' });
            }
        }),
        client.on('error', error => {
            if (!PAIRING_ROUTES.includes(route.name)) {
                dialogs.toast(describeClientError(error), { tone: 'fail' });
            }
        }),
        tracker.onChange(() => {
            refreshShell();
        }),
        wakeLock.onChange(() => banners.update(bannerState())),
        sessions.subscribe(() => banners.update(bannerState())),
        discovery.on('relay-allowance', () => banners.update(bannerState())),
        options.serviceWorker?.onUpdateReady(() => {
            isUpdateReady = true;
            refreshShell();
        }) ?? (() => undefined),
        options.install?.on('change', () => refreshShell()) ?? (() => undefined),
        watchKeyboardInset(),
    );
    document.addEventListener('paste', onPaste);

    return {
        get route() {
            return route;
        },
        context,
        navigate,
        startAsync: async (startOptions = {}) => {
            const [cameraFound] = await Promise.all([
                options.services.hasCameraAsync().catch(() => hasCamera),
                sessions.refreshAsync(),
            ]);
            hasCamera = cameraFound;
            root.dataset.camera = String(hasCamera);
            const peer = client.peer;
            navigate(client.state === 'connected' && peer != null ? { name: 'session', sessionId: peer.sessionId } : { name: 'home' });
            if (startOptions.hashCode != null) {
                await handleLinkCodeAsync(startOptions.hashCode);
            }
        },
        dispose: () => {
            screen?.dispose();
            screen = undefined;
            document.removeEventListener('paste', onPaste);
            for (const dispose of disposers) {
                dispose();
            }

            nearby.dispose();
            banners.dispose();
            flow.dispose();
            relay.dispose();
            tracker.dispose();
            sessions.dispose();
            drawer.dispose();
            restorePrompt.dispose();
            incomingPrompts.dispose();
            homePanel.dispose();
            layout.dispose();
            header.dispose();
            wakeLock.dispose();
        },
    };
}

