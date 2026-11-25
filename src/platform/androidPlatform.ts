import type { DevicePlatform } from '../core/deviceInfo.js';
import { BasePlatform, COMMON_FAILURE_HINTS } from './basePlatform.js';
import type { Hint, InstallMethod } from './platform.js';

// Android: Chrome can prompt for local network access.
export class AndroidPlatform extends BasePlatform {
    readonly kind = 'android';

    override devicePlatform(): DevicePlatform {
        return 'Android';
    }

    override pairingFailureHints(): readonly Hint[] {
        return [
            ...COMMON_FAILURE_HINTS,
            {
                id: 'local-network',
                title: 'Local network permission',
                text: 'Chrome may ask to allow access to devices on your local network. If you blocked it, tap the icon next to the address, open Permissions and allow Local network.',
            },
        ];
    }

    override installMethod(): InstallMethod {
        return this.info.installed ? 'none' : 'prompt';
    }

    override installSteps(): readonly string[] {
        return ['Open the browser menu and tap Install app or Add to Home screen.'];
    }

    // A geo: link opens whichever maps app the user has.
    override mapsUrl(latitude: number, longitude: number): string {
        return `geo:${latitude},${longitude}?q=${latitude},${longitude}`;
    }

    override inAppBrowserNote(): string | undefined {
        return this.info.inAppBrowser
            ? 'This app’s built-in browser limits the camera, downloads and storage. Tap ⋮ and choose Open in Chrome.'
            : undefined;
    }
}
