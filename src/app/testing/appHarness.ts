import type { Capabilities, DeviceInfo } from '../../core/deviceInfo.js';
import { createLogger } from '../../core/logger.js';
import type { Logger } from '../../core/logger.js';
import { createMemorySink } from '../../core/logSinks.js';
import type { MemorySink } from '../../core/logSinks.js';
import { createPlatform } from '../../platform/createPlatform.js';
import type { Platform, PlatformKind } from '../../platform/platform.js';
import { createApp } from '../app.js';
import type { App, AppOptions } from '../app.js';
import type { AppServices, CameraSession, QrScannerOptions } from '../appContext.js';
import { createDialogs } from '../dialogs.js';
import type { Dialogs } from '../dialogs.js';
import { createCameraHub } from '../pairing/cameraHub.js';
import type { PairingRelay } from '../pairing/pairingRelay.js';
import { createSettingsSheet } from '../settings/settingsSheet.js';
import { createThemeController } from '../shell/themeController.js';
import type { ThemeController } from '../shell/themeController.js';
import { createWakeLock } from '../shell/wakeLock.js';
import type { WakeLockController } from '../shell/wakeLock.js';
import { createFakeClient } from './fakeClient.js';
import type { FakeClient, FakeClientOptions } from './fakeClient.js';
import { createFakeDiscovery } from './fakeDiscovery.js';
import type { FakeDiscovery } from './fakeDiscovery.js';

// Builds the whole app on happy-dom with a fake client, platform, camera and QR modules.

export const TEST_CAPABILITIES: Capabilities = Object.freeze({
    webrtc: true,
    wakeLock: true,
    shareFiles: true,
    barcodeDetector: false,
    webLocks: true,
    persistentStorage: true,
    opfsWritable: false,
    camera: true,
    broadcastChannel: true,
    indexedDb: true,
    directoryPicker: true,
    folderInput: true,
});

const PLATFORM_DEVICES: Readonly<Record<PlatformKind, Partial<DeviceInfo>>> = Object.freeze({
    desktop: { os: 'Windows', deviceType: 'desktop', browser: 'Chrome', engine: 'Blink', label: 'Windows · Chrome' },
    android: { os: 'Android', deviceType: 'phone', model: 'Pixel 8', browser: 'Chrome', engine: 'Blink', label: 'Pixel 8 · Chrome' },
    ios: { os: 'iOS', deviceType: 'phone', model: 'iPhone', browser: 'Safari', engine: 'WebKit', label: 'iPhone · Safari' },
});

export function createTestDeviceInfo(kind: PlatformKind, overrides: Partial<DeviceInfo> = {}): DeviceInfo {
    return {
        os: 'Windows',
        deviceType: 'desktop',
        browser: 'Chrome',
        engine: 'Blink',
        displayMode: 'browser',
        installed: false,
        inAppBrowser: false,
        touch: kind !== 'desktop',
        capabilities: TEST_CAPABILITIES,
        label: 'Test',
        ...PLATFORM_DEVICES[kind],
        ...overrides,
    };
}

export function createTestPlatform(kind: PlatformKind, overrides: Partial<DeviceInfo> = {}): Platform {
    return createPlatform(createTestDeviceInfo(kind, overrides));
}

export interface FakeScanners {
    readonly started: QrScannerOptions[];
    // Simulates the scanner reading a code.
    read(text: string): void;
}

export interface FakeServicesOptions {
    // 'none': the device has no camera at all; 'missing': one is listed but fails to open.
    readonly camera?: 'ok' | 'denied' | 'missing' | 'none';
    readonly torch?: boolean;
}

export interface FakeServices extends AppServices {
    readonly scanners: FakeScanners;
    readonly cameraOpens: MediaTrackConstraints[];
    readonly cameraStops: number[];
    readonly discovery: FakeDiscovery;
}

export function createFakeServices(options: FakeServicesOptions = {}): FakeServices {
    const started: QrScannerOptions[] = [];
    const cameraOpens: MediaTrackConstraints[] = [];
    const cameraStops: number[] = [];

    return {
        discovery: createFakeDiscovery(),
        scanners: {
            started,
            read: text => started.at(-1)?.onCode(text),
        },
        cameraOpens,
        cameraStops,
        renderQrSvg: text => {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('data-qr', text);
            svg.setAttribute('viewBox', '0 0 10 10');

            return svg.outerHTML;
        },
        createScanner: scannerOptions => {
            started.push(scannerOptions);

            return { start: () => undefined, stop: () => undefined };
        },
        openCameraAsync: async constraints => {
            cameraOpens.push(constraints);
            const failures: Readonly<Record<string, string>> = { denied: 'NotAllowedError', missing: 'NotFoundError', none: 'NotFoundError' };
            const failure = failures[options.camera ?? 'ok'];
            if (failure != null) {
                throw new DOMException('camera', failure);
            }

            const session: CameraSession = {
                stream: new MediaStream(),
                track: {} as MediaStreamTrack,
                torchSupported: options.torch === true,
                setTorchAsync: async () => undefined,
                stop: () => cameraStops.push(cameraOpens.length),
            };

            return session;
        },
        canPreview: mime => ['image/jpeg', 'image/png', 'video/mp4', 'audio/mpeg'].includes(mime),
        truncateMiddle: (name, maxLength) => (name.length <= maxLength ? name : `${name.slice(0, maxLength - 5)}…${name.slice(-4)}`),
        hasCameraAsync: async () => options.camera !== 'none',
    };
}

export interface FakeWakeLockSentinel extends EventTarget {
    released: boolean;
    release(): Promise<void>;
}

export interface FakeWakeLockApi {
    readonly api: { request(type: 'screen'): Promise<FakeWakeLockSentinel> };
    readonly counts: { requests: number; releases: number };
    readonly sentinels: FakeWakeLockSentinel[];
}

export function createFakeWakeLockApi(): FakeWakeLockApi {
    const counts = { requests: 0, releases: 0 };
    const sentinels: FakeWakeLockSentinel[] = [];

    return {
        counts,
        sentinels,
        api: {
            request: async () => {
                counts.requests++;
                const sentinel = new EventTarget() as FakeWakeLockSentinel;
                sentinel.released = false;
                sentinel.release = async () => {
                    counts.releases++;
                    sentinel.released = true;
                };
                sentinels.push(sentinel);

                return sentinel;
            },
        },
    };
}

export interface Viewport {
    readonly width: number;
    readonly height: number;
}

// One column, as on a portrait phone; WIDE_VIEWPORT puts Home's sidebar beside the pane (§4.9).
const PHONE_VIEWPORT: Viewport = Object.freeze({ width: 390, height: 844 });
export const WIDE_VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });

// happy-dom's own way to size the window, which its media queries follow.
function setViewport(viewport: Viewport): void {
    (globalThis as { happyDOM?: { setViewport(size: Viewport): void } }).happyDOM?.setViewport(viewport);
}

export interface TestAppOptions {
    readonly viewport?: Viewport;
    readonly platform?: PlatformKind;
    readonly device?: Partial<DeviceInfo>;
    readonly client?: FakeClientOptions;
    readonly services?: FakeServicesOptions;
    readonly app?: Partial<Pick<AppOptions, 'settingsSheet' | 'logViewer' | 'serviceWorker' | 'install'>>;
    readonly relay?: PairingRelay;
    readonly wakeLockSupported?: boolean;
}

export interface TestApp {
    readonly app: App;
    readonly client: FakeClient;
    readonly root: HTMLElement;
    readonly dialogs: Dialogs;
    readonly services: FakeServices;
    readonly discovery: FakeDiscovery;
    readonly platform: Platform;
    readonly theme: ThemeController;
    readonly memory: MemorySink;
    readonly logger: Logger;
    readonly wakeLock: WakeLockController;
    // A code arriving over BroadcastChannel from another tab; true when this app takes it.
    relayCode(code: string): boolean;
    dispose(): void;
}

export function createTestApp(options: TestAppOptions = {}): TestApp {
    setViewport(options.viewport ?? PHONE_VIEWPORT);
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-theme');
    const root = document.createElement('div');
    root.dataset.role = 'app';
    root.className = 'app';
    document.body.append(root);

    const memory = createMemorySink(500);
    const logger = createLogger({
        sinks: [memory],
        routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
    }).logger;
    const client = createFakeClient(options.client);
    const platform = createTestPlatform(options.platform ?? 'desktop', options.device);
    const services = createFakeServices(options.services);
    const dialogs = createDialogs(document.body);
    const storage = new Map<string, string>();
    const theme = createThemeController({
        storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
    });
    const wakeLock = createWakeLock({
        logger,
        wakeLock: options.wakeLockSupported === false ? undefined : createFakeWakeLockApi().api,
    });
    const camera = createCameraHub({ openCameraAsync: services.openCameraAsync, logger });
    const settingsSheet = createSettingsSheet({ client, dialogs, theme, logger, buildVersion: '0.1.0+test' });
    let onRelayedCode: (code: string) => boolean = () => false;
    const app = createApp({
        root,
        client,
        platform,
        logger,
        services,
        dialogs,
        camera,
        wakeLock,
        settingsSheet,
        createRelay: onCode => {
            onRelayedCode = onCode;

            return options.relay ?? { forwardAsync: async () => false, dispose: () => undefined };
        },
        ...options.app,
    });

    return {
        app,
        client,
        root,
        dialogs,
        services,
        discovery: services.discovery,
        platform,
        theme,
        memory,
        logger,
        wakeLock,
        relayCode: code => onRelayedCode(code),
        dispose: () => {
            app.dispose();
            dialogs.dispose();
            theme.dispose();
            document.body.replaceChildren();
        },
    };
}

// Lets pending promises and short timers run.
export async function settleAsync(ms: number = 0): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
    await Promise.resolve();
}

export function buttonByText(container: ParentNode, text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text);
}

// Taps "Can't see it? Pair with a code" on Home.
export async function openPairMenuAsync(root: HTMLElement): Promise<void> {
    root.querySelector<HTMLButtonElement>('[data-action="pair-with-code"]')?.click();
    await settleAsync();
}

// Pair with a code, then Show my code.
export async function showMyCodeAsync(root: HTMLElement): Promise<void> {
    await openPairMenuAsync(root);
    root.querySelector<HTMLButtonElement>('[data-screen="pair"] [data-action="show-code"]')?.click();
    await settleAsync();
}
