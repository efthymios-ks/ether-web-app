import { defaultDeviceName, fallbackPlatform } from '../core/deviceInfo.js';
import type { DeviceInfo, DevicePlatform } from '../core/deviceInfo.js';
import type { Settings } from '../core/settings.js';
import type {
    CameraPlan,
    Hint,
    InstallMethod,
    PickerButton,
    Platform,
    PlatformKind,
} from './platform.js';

export const MEDIA_PICKER: PickerButton = Object.freeze({
    kind: 'media',
    label: 'Photos & videos',
    accept: 'image/*,video/*',
    multiple: true,
    directory: false,
});

export const FILES_PICKER: PickerButton = Object.freeze({
    kind: 'files',
    label: 'Files',
    accept: '',
    multiple: true,
    directory: false,
});

export const FOLDER_PICKER: PickerButton = Object.freeze({
    kind: 'folder',
    label: 'Folder',
    accept: '',
    multiple: true,
    directory: true,
});

// HS-10: causes every platform shares.
export const COMMON_FAILURE_HINTS: readonly Hint[] = Object.freeze([
    {
        id: 'isolation',
        title: 'Guest Wi‑Fi or client isolation',
        text: 'Some routers block devices from reaching each other, often on guest networks. Join the main network on both devices.',
    },
    {
        id: 'same-network',
        title: 'Not on the same network',
        text: 'Both devices must use the same Wi‑Fi. Check that neither is on mobile data, and that 2.4 GHz and 5 GHz are not separate networks.',
    },
    {
        id: 'vpn',
        title: 'VPN on either device',
        text: 'A VPN can hide or reroute the local network. Turn it off on both devices and try again.',
    },
    {
        id: 'browsers',
        title: 'Different browsers',
        text: 'Pairing works across Safari, Chrome and Firefox. If one browser keeps failing, try another on that device.',
    },
]);

// Defaults shared by every platform; subclasses override what differs.
export abstract class BasePlatform implements Platform {
    abstract readonly kind: PlatformKind;

    constructor(readonly info: DeviceInfo) {}

    // An unknown system still says what kind of device it is.
    devicePlatform(): DevicePlatform {
        return fallbackPlatform(this.info.deviceType);
    }

    get suspendsInBackground(): boolean {
        return false;
    }

    pickerButtons(): readonly PickerButton[] {
        return [MEDIA_PICKER, FILES_PICKER];
    }

    cameraPlan(): CameraPlan {
        return { constraints: { facingMode: { ideal: 'environment' } }, preferRear: true };
    }

    pairingFailureHints(): readonly Hint[] {
        return COMMON_FAILURE_HINTS;
    }

    systemCameraNote(): string | undefined {
        return undefined;
    }

    async exposeLocalIpsAsync(): Promise<(() => void) | null> {
        if (!this.info.capabilities.camera) {
            return null;
        }

        try {
            const constraints = { video: this.cameraPlan().constraints, audio: false };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);

            return () => {
                for (const track of stream.getTracks()) {
                    track.stop();
                }
            };
        } catch {
            // Denied or no camera: the network continues with .local names.
            return null;
        }
    }

    transferBackgroundWarning(): string | undefined {
        return undefined;
    }

    installMethod(): InstallMethod {
        return this.info.installed ? 'none' : 'prompt';
    }

    installSteps(): readonly string[] {
        return [];
    }

    preventTouchZoom(_target: Document): () => void {
        return () => undefined;
    }

    identityNote(): string | undefined {
        return undefined;
    }

    settingDefaults(): Partial<Settings> {
        return { deviceName: defaultDeviceName() };
    }

    mapsUrl(latitude: number, longitude: number): string {
        return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
    }

    inAppBrowserNote(): string | undefined {
        return this.info.inAppBrowser
            ? 'This app’s built-in browser limits the camera, downloads and storage. Open this page in your browser.'
            : undefined;
    }

    pasteShortcutHint(): string {
        if (this.info.deviceType !== 'desktop') {
            return 'Allow pasting when your browser asks.';
        }

        return this.info.os === 'macOS' ? 'Allow clipboard access, or press Cmd+V.' : 'Allow clipboard access, or press Ctrl+V.';
    }
}
