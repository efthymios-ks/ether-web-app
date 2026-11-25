import type { DeviceInfo, DevicePlatform } from '../core/deviceInfo.js';
import type { Settings } from '../core/settings.js';

// Behaviour that differs by device family. Each family has one implementation
// (DesktopPlatform, AndroidPlatform, IosPlatform) that overrides BasePlatform.
// Capability flags still decide which browser APIs are used inside each one (DD-02).
export type PlatformKind = 'desktop' | 'android' | 'ios';

export type PickerKind = 'media' | 'files' | 'folder';

export interface PickerButton {
    readonly kind: PickerKind;
    readonly label: string;
    // The `accept` attribute; empty for every file type.
    readonly accept: string;
    readonly multiple: boolean;
    readonly directory: boolean;
}

export interface Hint {
    readonly id: string;
    readonly title: string;
    readonly text: string;
}

export type InstallMethod = 'prompt' | 'instructions' | 'none';

export interface CameraPlan {
    readonly constraints: MediaTrackConstraints;
    // Phones scan with the rear camera; desktops use whatever camera exists.
    readonly preferRear: boolean;
}

export interface Platform {
    readonly kind: PlatformKind;
    readonly info: DeviceInfo;

    // The tag other devices show beside this device's name, e.g. "iPhone" or "Windows" (nearby `here`, `hello`).
    devicePlatform(): DevicePlatform;

    // §5: the picker buttons.
    pickerButtons(): readonly PickerButton[];

    // §3: camera for scanning and for exposing local IPs (HS-05).
    cameraPlan(): CameraPlan;
    // HS-10: likely causes on the failure screen, platform-specific ones included.
    pairingFailureHints(): readonly Hint[];
    // HS-06: what happens when the offer is scanned with the system camera.
    systemCameraNote(): string | undefined;
    // HS-05, NW-06: the hook the network calls before gathering. Browsers show real local IPs
    // only to pages with camera permission; resolves to "stop", or null when no camera could open.
    exposeLocalIpsAsync(): Promise<(() => void) | null>;

    // §10: background behaviour.
    readonly suspendsInBackground: boolean;
    transferBackgroundWarning(): string | undefined;

    // §12: install and storage.
    installMethod(): InstallMethod;
    installSteps(): readonly string[];
    // DN-05, §7.5: shown when the tab and the installed app keep separate identities.
    identityNote(): string | undefined;

    // No pinch or double-tap zoom on touch screens. The viewport meta tag and `touch-action` cover
    // Android and other browsers; a platform that ignores them adds its own guard. Returns a function that removes it.
    preventTouchZoom(target: Document): () => void;

    // §16.2: defaults that differ by device.
    settingDefaults(): Partial<Settings>;

    // MD-07: the "Open in Maps" link, opened only when the user taps it.
    mapsUrl(latitude: number, longitude: number): string;
    // DD-08: shown inside in-app browsers, where the camera, downloads and storage are limited.
    inAppBrowserNote(): string | undefined;
    // HS-09: how to paste by hand when the page can't read the clipboard.
    pasteShortcutHint(): string;
}
