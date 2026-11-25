import { describe, expect, it } from 'vitest';
import type { Capabilities, DeviceInfo } from '../core/deviceInfo.js';
import { createPlatform } from './createPlatform.js';

const ALL_CAPABILITIES: Capabilities = {
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
    directoryPicker: false,
    folderInput: true,
};

function deviceInfo(overrides: Partial<DeviceInfo>): DeviceInfo {
    return {
        os: 'Windows',
        deviceType: 'desktop',
        browser: 'Chrome',
        engine: 'Blink',
        displayMode: 'browser',
        installed: false,
        inAppBrowser: false,
        touch: false,
        capabilities: ALL_CAPABILITIES,
        label: 'Windows · Chrome',
        ...overrides,
    };
}

describe('createPlatform', () => {
    it('picks iOS for iPhone and iPad', () => {
        // Act & Assert
        expect(createPlatform(deviceInfo({ os: 'iOS', deviceType: 'phone', model: 'iPhone' })).kind).toBe('ios');
        expect(createPlatform(deviceInfo({ os: 'iPadOS', deviceType: 'tablet', model: 'iPad' })).kind).toBe('ios');
    });

    it('picks Android, and desktop for the rest', () => {
        // Assert
        expect(createPlatform(deviceInfo({ os: 'Android', deviceType: 'phone' })).kind).toBe('android');
        expect(createPlatform(deviceInfo({ os: 'macOS' })).kind).toBe('desktop');
        expect(createPlatform(deviceInfo({ os: 'Linux' })).kind).toBe('desktop');
    });

    it.each<[string, Partial<DeviceInfo>, string]>([
        ['an Android phone', { os: 'Android', deviceType: 'phone' }, 'Android'],
        ['an Android tablet', { os: 'Android', deviceType: 'tablet' }, 'Android'],
        ['an iPhone', { os: 'iOS', deviceType: 'phone', model: 'iPhone' }, 'iPhone'],
        ['an iPad', { os: 'iPadOS', deviceType: 'tablet', model: 'iPad' }, 'iPad'],
        ['Windows', { os: 'Windows' }, 'Windows'],
        ['a Mac', { os: 'macOS', model: 'Mac' }, 'Mac'],
        ['Linux', { os: 'Linux' }, 'Linux'],
        ['a Chromebook', { os: 'ChromeOS' }, 'ChromeOS'],
        ['an unknown computer', { os: 'Unknown' }, 'Computer'],
        ['an unknown tablet', { os: 'Unknown', deviceType: 'tablet' }, 'Tablet'],
    ])('names the platform of %s for other devices', (_, overrides, expected) => {
        // Act
        const platform = createPlatform(deviceInfo(overrides));

        // Assert
        expect(platform.devicePlatform()).toBe(expected);
    });

    it('defaults the device name to an adjective and a Greek hero or god', () => {
        // Act
        const name = createPlatform(deviceInfo({ os: 'iOS', deviceType: 'phone', model: 'iPhone' })).settingDefaults().deviceName;

        // Assert
        expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
        expect(name).not.toContain('iPhone');
    });
});

describe('IosPlatform', () => {
    it('cancels Safari pinch gestures and two-finger moves until removed', () => {
        // Arrange
        const platform = createPlatform(deviceInfo({ os: 'iOS', deviceType: 'phone' }));
        const target = new EventTarget() as Document;
        const fire = (event: Event): boolean => {
            target.dispatchEvent(event);

            return event.defaultPrevented;
        };
        const twoFingers = (): Event => Object.assign(new Event('touchmove', { cancelable: true }), { touches: [{}, {}] });
        const oneFinger = (): Event => Object.assign(new Event('touchmove', { cancelable: true }), { touches: [{}] });

        // Act
        const remove = platform.preventTouchZoom(target);
        const pinch = fire(new Event('gesturestart', { cancelable: true }));
        const twoFingerMove = fire(twoFingers());
        const scroll = fire(oneFinger());
        remove();
        const afterRemove = fire(new Event('gesturestart', { cancelable: true }));

        // Assert
        expect([pinch, twoFingerMove, scroll, afterRemove]).toEqual([true, true, false, false]);
    });

    it('warns that iOS pauses the connection in the background', () => {
        // Act
        const platform = createPlatform(deviceInfo({ os: 'iOS', deviceType: 'phone', model: 'iPhone' }));

        // Assert
        expect(platform.suspendsInBackground).toBe(true);
        expect(platform.transferBackgroundWarning()).toContain('Keep the app open');
    });

    it('offers installing through instructions in a Safari tab', () => {
        // Act
        const tab = createPlatform(deviceInfo({ os: 'iOS', deviceType: 'phone' }));

        // Assert
        expect(tab.installMethod()).toBe('instructions');
    });

    it('hides the folder picker', () => {
        // Act
        const kinds = createPlatform(deviceInfo({ os: 'iOS', deviceType: 'phone' })).pickerButtons().map(button => button.kind);

        // Assert
        expect(kinds).toEqual(['media', 'files']);
    });
});

describe('AndroidPlatform', () => {
    it('lists the local network permission among the failure hints', () => {
        // Act
        const platform = createPlatform(deviceInfo({ os: 'Android', deviceType: 'phone' }));

        // Assert
        expect(platform.pairingFailureHints().map(hint => hint.id)).toContain('local-network');
    });
});

describe('DesktopPlatform', () => {
    it('offers Files and Folder only', () => {
        // Arrange
        const windows = createPlatform(deviceInfo({}));

        // Act & Assert
        expect(windows.pickerButtons().map(button => button.kind)).toEqual(['files', 'folder']);
    });
});
