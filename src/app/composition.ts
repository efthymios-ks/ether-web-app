import { createClientAsync } from '../client/client.js';
import type { Client } from '../client/clientTypes.js';
import { openDatabaseAsync } from '../core/database.js';
import { getDeviceInfoAsync } from '../core/deviceInfo.js';
import type { DeviceInfo } from '../core/deviceInfo.js';
import { createDatabaseSink } from '../core/logDatabaseSink.js';
import { createLogger, installGlobalErrorHandlers } from '../core/logger.js';
import type { Logger, LoggerController } from '../core/logger.js';
import { createConsoleSink, createMemorySink, createPeerSink } from '../core/logSinks.js';
import type { MemorySink } from '../core/logSinks.js';
import { toLogRouting } from '../core/settings.js';
import type { Settings } from '../core/settings.js';
import { createBrowserDiscovery } from '../discovery/browserDiscovery.js';
import { truncateMiddle } from '../media/fileNames.js';
import { canPreview, probePreviewSupportAsync } from '../media/mediaKind.js';
import { createBrowserMediaToolkit } from '../media/mediaToolkit.js';
import { createNetwork } from '../network/network.js';
import { createPlatform } from '../platform/createPlatform.js';
import type { Platform } from '../platform/platform.js';
import { openCameraAsync } from '../qr/camera.js';
import { createQrMatrix, renderQrSvg } from '../qr/qrCode.js';
import { createQrScanner } from '../qr/qrScanner.js';
import { createApp } from './app.js';
import type { AppServices } from './appContext.js';
import { createDialogs } from './dialogs.js';
import { h } from './dom.js';
import { createLogViewer } from './logViewer/logViewer.js';
import type { LogViewer } from './logViewer/logViewer.js';
import { detectCameraAsync } from './pairing/cameraAvailability.js';
import { createCameraHub } from './pairing/cameraHub.js';
import type { CameraHub } from './pairing/cameraHub.js';
import { createPairingRelay, takeHashCode } from './pairing/pairingRelay.js';
import { createInstallController } from './pwa/installController.js';
import { registerServiceWorker } from './pwa/serviceWorkerClient.js';
import { createSettingsSheet } from './settings/settingsSheet.js';
import {
    acquireConnectionLockAsync,
    checkSupport,
    renderNotSupported,
    renderOtherTab,
    renderStartupError,
} from './shell/startupGuards.js';
import { createThemeController } from './shell/themeController.js';
import type { ThemeController } from './shell/themeController.js';

// The composition root: device info → platform → database → logger → client → service worker and install →
// Settings sheet, and the log viewer with ?debug=1 → app. Only this file knows the concrete network, discovery,
// media and QR modules.

const QR_QUIET_ZONE = 4;

export interface StartOptions {
    readonly document?: Document;
}

export async function startAppAsync(options: StartOptions = {}): Promise<void> {
    const doc = options.document ?? document;
    const theme = createThemeController({ root: doc.documentElement });
    const root = doc.querySelector<HTMLElement>('[data-role="app"]');
    if (root == null) {
        return;
    }

    // HS-06: read #<code> before anything else, and take it out of the address.
    const hashCode = takeHashCode();
    const support = checkSupport();
    if (!support.isSupported) {
        renderNotSupported(root, support);

        return;
    }

    const lock = await acquireConnectionLockAsync();
    if (lock.status === 'taken') {
        await showOtherTabAsync(root, hashCode);

        return;
    }

    try {
        await composeAsync({ root, theme, hashCode });
    } catch (error) {
        renderStartupError(root, error, () => globalThis.location.reload());
    }
}

// Test 18: the second tab doesn't pair. A code it was opened with goes to the tab that holds the connection (HS-07).
async function showOtherTabAsync(root: HTMLElement, hashCode: string | undefined): Promise<void> {
    const onRetry = (): void => globalThis.location.reload();
    renderOtherTab(root, { onRetry });
    if (hashCode == null) {
        return;
    }

    const relay = createPairingRelay();
    const isTaken = await relay.forwardAsync(hashCode);
    relay.dispose();
    renderOtherTab(root, { forwarded: isTaken, onRetry });
}

interface ComposeOptions {
    readonly root: HTMLElement;
    readonly theme: ThemeController;
    readonly hashCode: string | undefined;
}

interface Logging {
    readonly controller: LoggerController;
    readonly logger: Logger;
    readonly memorySink: MemorySink;
    readonly databaseSink: ReturnType<typeof createDatabaseSink>;
}

function createLogging(database: IDBDatabase): Logging {
    const memorySink = createMemorySink();
    const databaseSink = createDatabaseSink({ database, runId: crypto.randomUUID() });
    const controller = createLogger({ sinks: [memorySink, createConsoleSink(), databaseSink, createPeerSink()] });

    return { controller, logger: controller.logger, memorySink, databaseSink };
}

// LG-05: settings route the logger live. With ?debug=1, debug logging is on for this page whatever is stored,
// so the log viewer shows everything and polls the candidate pairs (DL-06).
function routeLogging(logging: Logging, settings: Settings, isDebug: boolean): void {
    logging.controller.configure(toLogRouting(isDebug ? { ...settings, debugLogging: true } : settings));
    if (logging.memorySink.capacity !== settings.logBufferSize) {
        logging.memorySink.resize(settings.logBufferSize);
    }

    logging.databaseSink.setLimit(settings.logPreviousRunSize);
}

// HS-05, NW-06: reuse the scanner's camera when it is open; iOS allows one capture session at a time.
function createExposeLocalIps(camera: CameraHub, platform: Platform): () => Promise<(() => void) | null> {
    return async () => camera.retainOpen() ?? platform.exposeLocalIpsAsync();
}

function appUrl(): string {
    const url = new URL(globalThis.location.href);
    url.hash = '';
    url.search = '';

    return url.toString();
}

function buildVersion(doc: Document): string {
    return doc.querySelector<HTMLMetaElement>('meta[name="ether-build"]')?.content ?? 'dev';
}

function createDebugLogViewer(options: {
    readonly doc: Document;
    readonly client: Client;
    readonly logging: Logging;
    readonly deviceInfo: DeviceInfo;
    readonly version: string;
}): LogViewer {
    const container = h('div', { class: 'log-viewer-host' });
    options.doc.body.append(container);

    return createLogViewer({
        container,
        client: options.client,
        memorySink: options.logging.memorySink,
        databaseSink: options.logging.databaseSink,
        deviceInfo: options.deviceInfo,
        buildVersion: options.version,
        logger: options.logging.logger,
        isDebugLogging: () => true,
    });
}

function createServices(logger: Logger): AppServices {
    return {
        renderQrSvg: text => renderQrSvg(createQrMatrix(text), { quietZone: QR_QUIET_ZONE }),
        createScanner: scannerOptions => createQrScanner(scannerOptions),
        openCameraAsync: constraints => openCameraAsync(constraints),
        canPreview,
        truncateMiddle,
        hasCameraAsync: () => detectCameraAsync(),
        discovery: createBrowserDiscovery({ logger }),
    };
}

async function createClientWithLoggingAsync(options: {
    readonly database: IDBDatabase;
    readonly logging: Logging;
    readonly platform: Platform;
    readonly deviceInfo: DeviceInfo;
    readonly camera: CameraHub;
    readonly isDebug: boolean;
}): Promise<Client> {
    const { logging, platform } = options;
    const client = await createClientAsync({
        database: options.database,
        logger: logging.logger,
        loggerController: logging.controller,
        createNetwork,
        media: createBrowserMediaToolkit(logging.logger),
        appUrl: appUrl(),
        exposeLocalIps: createExposeLocalIps(options.camera, platform),
        defaultSettings: platform.settingDefaults(),
        platform: platform.devicePlatform(),
        isPhone: options.deviceInfo.deviceType === 'phone',
    });
    routeLogging(logging, client.settings, options.isDebug);
    client.on('settings', (settings: Settings) => routeLogging(logging, settings, options.isDebug));

    return client;
}

async function composeAsync(options: ComposeOptions): Promise<void> {
    const doc = options.root.ownerDocument;
    const deviceInfo = await getDeviceInfoAsync();
    const platform = createPlatform(deviceInfo);
    // No pinch or double-tap zoom for the page's whole life; the guard goes only when the page is unloaded.
    const releaseTouchZoom = platform.preventTouchZoom(doc);
    doc.defaultView?.addEventListener('pagehide', event => {
        if (!event.persisted) {
            releaseTouchZoom();
        }
    });
    const database = await openDatabaseAsync();
    const logging = createLogging(database);
    const { logger } = logging;
    installGlobalErrorHandlers(logger);
    logger.info('device', 'detected', () => ({ ...deviceInfo, platform: platform.kind }));
    void probePreviewSupportAsync();

    const dialogs = createDialogs(doc.body);
    const services = createServices(logger);
    const camera = createCameraHub({ openCameraAsync: services.openCameraAsync, logger });
    // DL-01: the log viewer is a debug tool, there only with ?debug=1; the # part is reserved for pairing codes.
    const isDebug = new URLSearchParams(globalThis.location.search).get('debug') === '1';
    const client = await createClientWithLoggingAsync({ database, logging, platform, deviceInfo, camera, isDebug });
    const serviceWorker = registerServiceWorker({ logger });
    const install = createInstallController({ platform, logger });

    const version = buildVersion(doc);
    const logViewer = isDebug ? createDebugLogViewer({ doc, client, logging, deviceInfo, version }) : undefined;
    const settingsSheet = createSettingsSheet({
        client,
        dialogs,
        theme: options.theme,
        logger,
        buildVersion: version,
        clearSavedLogsAsync: () => logging.databaseSink.clearAsync(),
    });

    const app = createApp({
        root: options.root,
        client,
        platform,
        logger,
        services,
        dialogs,
        camera,
        settingsSheet,
        ...(logViewer == null ? {} : { logViewer }),
        serviceWorker,
        install,
    });
    await app.startAsync({ hashCode: options.hashCode });
    // DL-01: ?debug=1 opens the log viewer at start.
    logViewer?.open();

    logger.info('app', 'started', { version, screen: app.route.name });
}
