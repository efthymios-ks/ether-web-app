import { describe, expect, it } from 'vitest';
import {
    BASE_DEFAULTS,
    BASIC_SETTINGS,
    createDefaultSettings,
    formatBytes,
    normalizeSettings,
    SETTING_DESCRIPTORS,
    settingVisibility,
    toLogRouting,
} from './settings.js';

describe('normalizeSettings', () => {
    it('fills missing values from the defaults', () => {
        // Act
        const { settings, problems } = normalizeSettings({ pageSize: 2 * 1024 * 1024 });

        // Assert
        expect(settings.pageSize).toBe(2 * 1024 * 1024);
        expect(settings.chunkSize).toBe(BASE_DEFAULTS.chunkSize);
        expect(problems).toEqual([]);
    });

    it('clamps out-of-range numbers and reports the allowed range', () => {
        // Act
        const { settings, problems } = normalizeSettings({ pingIntervalMs: 60_000 });

        // Assert
        expect(settings.pingIntervalMs).toBe(10_000);
        expect(problems).toEqual([{ key: 'pingIntervalMs', message: 'Allowed: 1 s – 10 s.' }]);
    });

    it('snaps page sizes to the nearest choice', () => {
        // Act
        const { settings } = normalizeSettings({ pageSize: 3 * 1024 * 1024 });

        // Assert
        expect([2 * 1024 * 1024, 4 * 1024 * 1024]).toContain(settings.pageSize);
    });

    it('keeps Lost after longer than Weak after', () => {
        // Act
        const { settings, problems } = normalizeSettings({ weakAfterMs: 12_000, lostAfterMs: 8000 });

        // Assert
        expect(settings.lostAfterMs).toBe(13_000);
        expect(problems.map(problem => problem.key)).toContain('lostAfterMs');
    });

    it('trims the device name and rejects an empty one', () => {
        // Act
        const trimmed = normalizeSettings({ deviceName: '  Pixel 8  ' }).settings.deviceName;
        const empty = normalizeSettings({ deviceName: '   ' });

        // Assert
        expect(trimmed).toBe('Pixel 8');
        expect(empty.settings.deviceName).toBe(BASE_DEFAULTS.deviceName);
        expect(empty.problems[0]?.key).toBe('deviceName');
    });

    it('counts emoji as one character in the name limit', () => {
        // Act
        const { settings, problems } = normalizeSettings({ deviceName: '📱'.repeat(32) });

        // Assert
        expect([...settings.deviceName]).toHaveLength(32);
        expect(problems).toEqual([]);
    });

    it('drops unknown sinks and levels', () => {
        // Act
        const { settings } = normalizeSettings({
            logSinks: ['memory', 'cloud' as never, 'memory'],
            categoryLevels: { xfer: 'debug', ice: 'loud' as never },
        });

        // Assert
        expect(settings.logSinks).toEqual(['memory']);
        expect(settings.categoryLevels).toEqual({ xfer: 'debug' });
    });
});

describe('settings defaults', () => {
    it('has a descriptor for every setting', () => {
        // Arrange
        const keys = Object.keys(BASE_DEFAULTS).filter(key => key !== 'schemaVersion');

        // Act & Assert
        expect(SETTING_DESCRIPTORS.map(descriptor => descriptor.key).sort()).toEqual(keys.sort());
    });

    it('applies platform overrides', () => {
        // Act
        const settings = createDefaultSettings({ deviceName: 'Swift Perseus', askBeforeReceiving: false });

        // Assert
        expect(settings.deviceName).toBe('Swift Perseus');
        expect(settings.askBeforeReceiving).toBe(false);
    });

    it('asks before receiving by default (SP-07)', () => {
        // Act
        const settings = createDefaultSettings();

        // Assert
        expect(BASE_DEFAULTS.askBeforeReceiving).toBe(true);
        expect(settings.askBeforeReceiving).toBe(true);
    });

    it('maps to logger routing', () => {
        // Act
        const routing = toLogRouting(createDefaultSettings({ debugLogging: true }));

        // Assert
        expect(routing).toEqual({ debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory', 'console'] });
    });
});

describe('settingVisibility', () => {
    it('shows only everyday settings and keeps the rest advanced', () => {
        // Act & Assert
        expect(BASIC_SETTINGS).toEqual(['deviceName', 'pin', 'askBeforeReceiving', 'findNearbyDevices']);
        expect(BASIC_SETTINGS.every(key => SETTING_DESCRIPTORS.some(descriptor => descriptor.key === key))).toBe(true);
        expect(settingVisibility('deviceName')).toBe('basic');
        expect(settingVisibility('pin')).toBe('basic');
        expect(settingVisibility('askBeforeReceiving')).toBe('basic');
        expect(settingVisibility('findNearbyDevices')).toBe('basic');
        expect(settingVisibility('pageSize')).toBe('advanced');
        expect(settingVisibility('lostAfterMs')).toBe('advanced');
    });
});

describe('findNearbyDevices', () => {
    it('is on by default and says it uses public relays', () => {
        // Act
        const descriptor = SETTING_DESCRIPTORS.find(item => item.key === 'findNearbyDevices');

        // Assert
        expect(BASE_DEFAULTS.findNearbyDevices).toBe(true);
        expect(descriptor).toMatchObject({ kind: 'boolean', label: 'Find nearby devices', takesEffect: 'now' });
        expect(descriptor?.help).toBe('Uses public relays to find devices on the same Wi‑Fi.');
    });

    it('keeps a stored choice and refuses anything but on or off', () => {
        // Act
        const off = normalizeSettings({ findNearbyDevices: false });
        const broken = normalizeSettings({ findNearbyDevices: 'yes' as never });

        // Assert
        expect(off.settings.findNearbyDevices).toBe(false);
        expect(broken.settings.findNearbyDevices).toBe(true);
        expect(broken.problems).toEqual([{ key: 'findNearbyDevices', message: 'Must be on or off.' }]);
    });
});

describe('pin', () => {
    it('has none by default, and is an everyday setting with its own kind', () => {
        // Act
        const descriptor = SETTING_DESCRIPTORS.find(item => item.key === 'pin');

        // Assert
        expect(BASE_DEFAULTS.pin).toBeNull();
        expect(createDefaultSettings().pin).toBeNull();
        expect(descriptor).toMatchObject({ kind: 'pin', label: 'PIN', minDigits: 4, maxDigits: 8, takesEffect: 'now' });
        expect(descriptor?.help).toBe('Devices must enter it to connect to you.');
    });

    it.each([
        ['4 digits', '1234', '1234'],
        ['8 digits with a leading zero', '01234567', '01234567'],
        ['digits with spaces', ' 1234 5678 ', '12345678'],
        ['null', null, null],
        ['an empty text', '', null],
    ] as const)('keeps %s', (_, pin, expected) => {
        // Arrange
        const current = createDefaultSettings({ pin: '1111' });

        // Act
        const { settings, problems } = normalizeSettings({ pin }, current);

        // Assert
        expect(settings.pin).toBe(expected);
        expect(problems).toEqual([]);
    });

    it.each([
        ['too short', '123'],
        ['too long', '123456789'],
        ['not digits', '12ab'],
        ['a number', 1234],
    ] as const)('refuses a PIN that is %s and keeps the one before', (_, pin) => {
        // Arrange
        const current = createDefaultSettings({ pin: '2468' });

        // Act
        const { settings, problems } = normalizeSettings({ pin: pin as never }, current);

        // Assert
        expect(settings.pin).toBe('2468');
        expect(problems).toEqual([{ key: 'pin', message: 'Use 4 to 8 digits.' }]);
    });

    it('leaves the PIN alone when a change does not name it', () => {
        // Arrange
        const current = createDefaultSettings({ pin: '2468' });

        // Act
        const { settings } = normalizeSettings({ askBeforeReceiving: false }, current);

        // Assert
        expect(settings.pin).toBe('2468');
    });
});

describe('formatBytes', () => {
    it('formats binary units', () => {
        // Act & Assert
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024 * 1024)).toBe('1 MiB');
        expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MiB');
        expect(formatBytes(3 * 1024 ** 3)).toBe('3 GiB');
    });
});
