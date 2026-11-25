import type { Client } from '../client/clientTypes.js';
import type { Logger } from '../core/logger.js';
import type { Discovery } from '../discovery/discoveryTypes.js';
import type { Platform } from '../platform/platform.js';
import type { Dialogs } from './dialogs.js';
import type { NearbyController } from './nearby/nearbyController.js';
import type { CameraHub } from './pairing/cameraHub.js';
import type { ShellLayout } from './shell/layout.js';
import type { WakeLockController } from './shell/wakeLock.js';
import type { SessionsStore } from './history/sessionsStore.js';
import type { TransferTracker } from './transfers/transferTracker.js';

// What the screens need from the QR, camera and media modules; the composition root passes the real ones
// and tests pass fakes (happy-dom has no camera).

export interface CameraSession {
    readonly stream: MediaStream;
    readonly track: MediaStreamTrack;
    readonly torchSupported: boolean;
    setTorchAsync(isOn: boolean): Promise<void>;
    stop(): void;
}

export interface QrScannerHandle {
    start(): void;
    stop(): void;
}

export interface QrScannerOptions {
    readonly video: HTMLVideoElement;
    readonly onCode: (code: string) => void;
    readonly logger: Logger;
}

export interface AppServices {
    // Trusted SVG markup for a QR of `text`, black on white with a 4-module quiet zone (UI-03).
    renderQrSvg(text: string): string;
    createScanner(options: QrScannerOptions): QrScannerHandle;
    openCameraAsync(constraints: MediaTrackConstraints): Promise<CameraSession>;
    // RX-06, SP-06: image, video and audio types this browser can show or play; without a MIME type, the name's
    // extension decides.
    canPreview(mime: string, name: string): boolean;
    // UI-09: long names keep their start and extension.
    truncateMiddle(name: string, maxLength: number): string;
    // False when no camera can scan, so the scan buttons lead to the paste box instead.
    hasCameraAsync(): Promise<boolean>;
    // Devices behind the same router, found through public relays; pairing with one needs its yes.
    readonly discovery: Discovery;
}

export type SessionTab = 'send' | 'received' | 'sent';

export const SESSION_TABS: ReadonlyArray<{ readonly id: SessionTab; readonly label: string }> = Object.freeze([
    { id: 'send', label: 'Send' },
    { id: 'received', label: 'Received' },
    { id: 'sent', label: 'Sent' },
]);

export type ScanPurpose = 'offer' | 'answer';

export type Route =
    | { readonly name: 'home' }
    // "Pair with a code": Show my code, Scan a code or Paste a code.
    | { readonly name: 'pair' }
    | { readonly name: 'offer' }
    | { readonly name: 'scan'; readonly purpose: ScanPurpose }
    | { readonly name: 'answer' }
    | { readonly name: 'connecting' }
    | { readonly name: 'failure'; readonly reason?: string }
    | { readonly name: 'expired' }
    | { readonly name: 'session'; readonly sessionId: string; readonly tab?: SessionTab };

export interface LinkEnd {
    readonly sessionId: string;
    readonly peerName: string;
    readonly byPeer: boolean;
}

export interface AppContext {
    readonly client: Client;
    readonly platform: Platform;
    readonly logger: Logger;
    readonly dialogs: Dialogs;
    readonly services: AppServices;
    readonly camera: CameraHub;
    readonly tracker: TransferTracker;
    readonly sessions: SessionsStore;
    readonly wakeLock: WakeLockController;
    // Whether Home's sidebar shows beside the pane (§4.9).
    readonly layout: ShellLayout;
    // The Nearby list on Home, the requests this device sends, and the ones it is asked to accept.
    readonly nearby: NearbyController;
    readonly route: Route;
    // Known at start-up; without a camera the scan actions fall back to the paste box (HS-09).
    readonly hasCamera: boolean;
    // How the last link ended: the peer said bye (HC-06), or it dropped. Cleared on the next connection.
    readonly lastLinkEnd: LinkEnd | undefined;
    // The log viewer exists only with ?debug=1 in the address (DL-01).
    readonly hasLogViewer: boolean;
    navigate(route: Route): void;
    // Focuses the current screen's code box; false when the screen has none.
    focusCodeEntry(): boolean;
    openLogViewer(): void;
    showTimeline(): void;
    // Opens the file pickers for sending (connected only), from the Send tab's tiles.
    pickFiles(kind: 'media' | 'files' | 'folder'): void;
    // PK-05: picks files again for needs-file items.
    pickFilesToResume(): void;
    // Lists reload after saves and deletes made from this page.
    notifyDataChanged(): void;
    onDataChanged(handler: () => void): () => void;
}

// A screen in the main area, or in the pane beside Home's sidebar on wide screens. Each holds its own actions.
export interface Screen {
    readonly element: HTMLElement;
    readonly title: string;
    // Set when the screen takes a code that Ctrl/Cmd+V pastes anywhere on it (UI-06).
    readonly codeEntry?: { pasteAsync(text: string): Promise<void>; focus(): void };
    dispose(): void;
}
