import type { DevicePlatform } from '../core/deviceInfo.js';
import { BasePlatform, FILES_PICKER, MEDIA_PICKER } from './basePlatform.js';
import type { InstallMethod, PickerButton } from './platform.js';

// iPhone and iPad: every browser is WebKit, WebRTC stops in the background,
// and Safari and the home-screen app keep separate storage.
export class IosPlatform extends BasePlatform {
    readonly kind = 'ios';

    // An iPad on iPadOS 13+ sends a Mac user agent; detection already told it apart by its touch points.
    override devicePlatform(): DevicePlatform {
        return this.info.os === 'iPadOS' ? 'iPad' : 'iPhone';
    }

    override get suspendsInBackground(): boolean {
        return true;
    }

    // PK-03: the folder picker stays hidden on iOS until testing confirms it.
    override pickerButtons(): readonly PickerButton[] {
        return [MEDIA_PICKER, FILES_PICKER];
    }

    override systemCameraNote(): string | undefined {
        return this.info.installed
            ? 'Scanning with the Camera app opens Safari, not this app. Scan from inside the app to keep this device’s history.'
            : undefined;
    }

    override transferBackgroundWarning(): string | undefined {
        return 'Keep the app open until done. iOS pauses the connection when the screen locks or you switch apps.';
    }

    override installMethod(): InstallMethod {
        return this.info.installed ? 'none' : 'instructions';
    }

    override installSteps(): readonly string[] {
        return [
            'Tap the Share button in Safari.',
            'Tap Add to Home Screen.',
            'Open Ether from the Home Screen from now on.',
        ];
    }

    // Safari ignores user-scalable=no; its own gesture events and two-finger moves are cancelled instead.
    override preventTouchZoom(target: Document): () => void {
        const cancel = (event: Event): void => event.preventDefault();
        const cancelPinch = (event: TouchEvent): void => {
            if (event.touches.length > 1) {
                event.preventDefault();
            }
        };
        const gestureEvents = ['gesturestart', 'gesturechange', 'gestureend'];
        for (const name of gestureEvents) {
            target.addEventListener(name, cancel, { passive: false });
        }

        target.addEventListener('touchmove', cancelPinch, { passive: false });

        return () => {
            for (const name of gestureEvents) {
                target.removeEventListener(name, cancel);
            }

            target.removeEventListener('touchmove', cancelPinch);
        };
    }

    override identityNote(): string | undefined {
        return this.info.installed
            ? undefined
            : 'Safari and the Home Screen app keep separate history. Use the Home Screen app every time.';
    }

    override mapsUrl(latitude: number, longitude: number): string {
        return `https://maps.apple.com/?ll=${latitude},${longitude}&q=${latitude},${longitude}`;
    }

    override inAppBrowserNote(): string | undefined {
        return this.info.inAppBrowser
            ? 'This app’s built-in browser limits the camera, downloads and storage. Tap ⋯ and choose Open in Safari.'
            : undefined;
    }
}
