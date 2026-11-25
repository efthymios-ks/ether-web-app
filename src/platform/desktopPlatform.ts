import type { DevicePlatform, OS } from '../core/deviceInfo.js';
import { BasePlatform, COMMON_FAILURE_HINTS, FILES_PICKER, FOLDER_PICKER } from './basePlatform.js';
import type { CameraPlan, Hint, InstallMethod, PickerButton } from './platform.js';

const DESKTOP_PLATFORMS: Readonly<Partial<Record<OS, DevicePlatform>>> = Object.freeze({
    Windows: 'Windows',
    macOS: 'Mac',
    Linux: 'Linux',
    ChromeOS: 'ChromeOS',
});

// Desktop browsers (Windows, macOS, Linux, ChromeOS): Files and Folder pickers,
// and pasting codes when there is no camera.
export class DesktopPlatform extends BasePlatform {
    readonly kind = 'desktop';

    override devicePlatform(): DevicePlatform {
        return DESKTOP_PLATFORMS[this.info.os] ?? super.devicePlatform();
    }

    // A desktop file dialog already shows photos and videos, so Files and Folder are all it needs.
    override pickerButtons(): readonly PickerButton[] {
        const folder = this.info.capabilities.folderInput ? [FOLDER_PICKER] : [];

        return [FILES_PICKER, ...folder];
    }

    override cameraPlan(): CameraPlan {
        return { constraints: {}, preferRear: false };
    }

    // Most desktops have no camera; skip the permission prompt when none is attached.
    override async exposeLocalIpsAsync(): Promise<(() => void) | null> {
        const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
        if (!devices.some(device => device.kind === 'videoinput')) {
            return null;
        }

        return super.exposeLocalIpsAsync();
    }

    override pairingFailureHints(): readonly Hint[] {
        return [
            ...COMMON_FAILURE_HINTS,
            {
                id: 'firewall',
                title: 'Firewall',
                text: 'A firewall on this computer may block incoming connections from the local network. Allow the browser on private networks.',
            },
            {
                id: 'local-network',
                title: 'Local network permission',
                text: 'Chrome and Edge may ask to allow access to devices on your local network. If you blocked it, click the icon next to the address and allow Local network in the site settings.',
            },
        ];
    }

    override installMethod(): InstallMethod {
        return this.info.installed || this.info.engine !== 'Blink' ? 'none' : 'prompt';
    }
}
