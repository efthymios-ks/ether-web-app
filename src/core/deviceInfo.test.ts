import { describe, expect, it } from 'vitest';
import {
    defaultDeviceName,
    detectDisplayMode,
    fallbackPlatform,
    parseUserAgent,
    suggestDeviceNames,
    toDevicePlatform,
} from './deviceInfo.js';

const USER_AGENTS = Object.freeze({
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
    iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0 (iPhone14,5; iOS 17_5; en_US)',
    ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
    androidChromeReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    androidFirefoxTablet: 'Mozilla/5.0 (Android 14; Tablet; rv:132.0) Gecko/132.0 Firefox/132.0',
    windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

describe('parseUserAgent', () => {
    it('reads iPhone Safari', () => {
        // Act
        const parsed = parseUserAgent({ ua: USER_AGENTS.iphoneSafari, maxTouchPoints: 5 });

        // Assert
        expect(parsed).toMatchObject({
            os: 'iOS',
            osVersion: '17.4',
            deviceType: 'phone',
            model: 'iPhone',
            browser: 'Safari',
            browserVersion: '17.4',
            engine: 'WebKit',
            inAppBrowser: false,
        });
    });

    it('reports Chrome on iPhone as WebKit', () => {
        // Act
        const parsed = parseUserAgent({ ua: USER_AGENTS.iphoneChrome, maxTouchPoints: 5 });

        // Assert
        expect(parsed).toMatchObject({ browser: 'Chrome', browserVersion: '131.0.6778.73', engine: 'WebKit', osVersion: '18.1' });
    });

    it('flags in-app browsers', () => {
        // Act
        const parsed = parseUserAgent({ ua: USER_AGENTS.iphoneInstagram, maxTouchPoints: 5 });

        // Assert
        expect(parsed).toMatchObject({ browser: 'In-app', inAppBrowser: true });
    });

    it('treats a touch Mac as an iPad', () => {
        // Act
        const ipad = parseUserAgent({ ua: USER_AGENTS.ipadAsMac, maxTouchPoints: 5 });
        const mac = parseUserAgent({ ua: USER_AGENTS.ipadAsMac, maxTouchPoints: 0 });

        // Assert
        expect(ipad).toMatchObject({ os: 'iPadOS', deviceType: 'tablet', model: 'iPad' });
        expect(mac).toMatchObject({ os: 'macOS', deviceType: 'desktop', model: 'Mac', browser: 'Safari' });
    });

    it('reads Firefox on a Mac', () => {
        // Act
        const parsed = parseUserAgent({ ua: USER_AGENTS.macFirefox });

        // Assert
        expect(parsed).toMatchObject({ os: 'macOS', browser: 'Firefox', engine: 'Gecko' });
    });

    it('takes the Android model from Client Hints when the user agent is reduced', () => {
        // Act
        const reduced = parseUserAgent({ ua: USER_AGENTS.androidChromeReduced, maxTouchPoints: 5 });
        const hinted = parseUserAgent({
            ua: USER_AGENTS.androidChromeReduced,
            maxTouchPoints: 5,
            uaData: { mobile: true, brands: [{ brand: 'Google Chrome', version: '131' }] },
            highEntropy: {
                model: 'Pixel 8',
                platformVersion: '15.0.0',
                fullVersionList: [{ brand: 'Google Chrome', version: '131.0.6778.81' }],
            },
        });

        // Assert
        expect(reduced.model).toBeUndefined();
        expect(hinted).toMatchObject({
            os: 'Android',
            osVersion: '15.0.0',
            model: 'Pixel 8',
            browser: 'Chrome',
            browserVersion: '131.0.6778.81',
            engine: 'Blink',
            deviceType: 'phone',
        });
    });

    it('reads Samsung Internet with its model', () => {
        // Act
        const parsed = parseUserAgent({ ua: USER_AGENTS.samsung, maxTouchPoints: 5 });

        // Assert
        expect(parsed).toMatchObject({ browser: 'Samsung Internet', model: 'SM-S918B', engine: 'Blink' });
    });

    it('reads an Android Firefox tablet', () => {
        // Act
        const parsed = parseUserAgent({ ua: USER_AGENTS.androidFirefoxTablet, maxTouchPoints: 5 });

        // Assert
        expect(parsed).toMatchObject({ os: 'Android', deviceType: 'tablet', browser: 'Firefox', engine: 'Gecko' });
    });

    it('tells Windows 11 from 10 through Client Hints', () => {
        // Act
        const eleven = parseUserAgent({ ua: USER_AGENTS.windowsEdge, highEntropy: { platformVersion: '15.0.0' } });
        const ten = parseUserAgent({ ua: USER_AGENTS.windowsEdge, highEntropy: { platformVersion: '10.0.0' } });
        const unknown = parseUserAgent({ ua: USER_AGENTS.windowsEdge });

        // Assert
        expect(eleven).toMatchObject({ os: 'Windows', osVersion: '11', browser: 'Edge' });
        expect(ten.osVersion).toBe('10');
        expect(unknown.osVersion).toBeUndefined();
    });

    it('reads Linux and ChromeOS', () => {
        // Act & Assert
        expect(parseUserAgent({ ua: USER_AGENTS.linuxChrome })).toMatchObject({ os: 'Linux', browser: 'Chrome' });
        expect(parseUserAgent({ ua: USER_AGENTS.chromeOs })).toMatchObject({ os: 'ChromeOS', deviceType: 'desktop' });
    });
});

describe('detectDisplayMode', () => {
    it('reports an installed app', () => {
        // Act
        const standalone = detectDisplayMode(query => query === '(display-mode: standalone)', false);
        const iosHomeScreen = detectDisplayMode(() => false, true);
        const tab = detectDisplayMode(() => false, false);

        // Assert
        expect(standalone).toEqual({ displayMode: 'standalone', installed: true });
        expect(iosHomeScreen).toEqual({ displayMode: 'standalone', installed: true });
        expect(tab).toEqual({ displayMode: 'browser', installed: false });
    });
});

describe('defaultDeviceName', () => {
    it('joins an adjective and a Greek hero or god, without the platform', () => {
        // Act
        const first = defaultDeviceName(() => 0);
        const last = defaultDeviceName(() => 0.999);

        // Assert
        expect(first).toBe('Swift Perseus');
        expect(last).toBe('Lucky Nike');
    });

    it('picks from the whole list of names', () => {
        // Arrange
        const values = [0.5, 0.5];

        // Act
        const name = defaultDeviceName(() => values.shift() ?? 0);

        // Assert
        expect(name).toBe('Clever Poseidon');
    });
});

describe('suggestDeviceNames', () => {
    it('gives different names, leaving out the excluded ones whatever their case', () => {
        // Arrange
        const values = [0, 0, 0, 0, 0.5, 0.5, 0.1, 0.1];

        // Act
        const names = suggestDeviceNames(2, { exclude: ['swift perseus '], random: () => values.shift() ?? 0.9 });

        // Assert
        expect(names).toEqual(['Clever Poseidon', 'Brave Odysseus']);
    });

    it('stops when the random source keeps repeating itself', () => {
        // Act
        const names = suggestDeviceNames(3, { random: () => 0 });

        // Assert
        expect(names).toEqual(['Swift Perseus']);
    });
});

describe('toDevicePlatform', () => {
    it('keeps known platforms and drops anything else', () => {
        // Act & Assert
        expect(toDevicePlatform('iPad')).toBe('iPad');
        expect(toDevicePlatform('Computer')).toBe('Computer');
        expect(toDevicePlatform('Watch')).toBeUndefined();
        expect(toDevicePlatform(7)).toBeUndefined();
        expect(toDevicePlatform(undefined)).toBeUndefined();
    });

    it('stands in Phone, Tablet or Computer by device type', () => {
        // Act & Assert
        expect(fallbackPlatform('phone')).toBe('Phone');
        expect(fallbackPlatform('tablet')).toBe('Tablet');
        expect(fallbackPlatform('desktop')).toBe('Computer');
    });
});
