import { LOG_CATEGORIES, LOG_LEVELS, LOG_SINK_NAMES } from './logger.js';
import type { LogCategory, LogLevel, LogRouting, LogSinkName } from './logger.js';
import { isValidPin, MAX_PIN_DIGITS, MIN_PIN_DIGITS, PIN_FORMAT_TEXT } from './pin.js';

export const SETTINGS_SCHEMA_VERSION = 1;

const KIB = 1024;
const MIB = 1024 * KIB;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// §16.2 and §16.3. Durations in milliseconds, sizes in bytes; 0 concurrency means Auto.
export interface Settings {
    readonly schemaVersion: number;
    readonly deviceName: string;
    // 4–8 digits, or null for none. It stays on this device: never sent to the peer, redacted in logs.
    readonly pin: string | null;
    readonly askBeforeReceiving: boolean;
    readonly findNearbyDevices: boolean;
    readonly pageSize: number;
    readonly chunkSize: number;
    readonly maxConcurrentFiles: number;
    readonly sendThumbnailsFirst: boolean;
    readonly maxBuffered: number;
    readonly pingIntervalMs: number;
    readonly weakAfterMs: number;
    readonly lostAfterMs: number;
    readonly gatheringCapMs: number;
    readonly codeExpiryMs: number;
    readonly connectTimeoutMs: number;
    readonly offerReplyTimeoutMs: number;
    readonly pageAckTimeoutMs: number;
    readonly pageResendTries: number;
    readonly keepPartialDays: number;
    readonly keepHistoryDays: number;
    readonly keepHistoryPerSession: number;
    readonly debugLogging: boolean;
    readonly logLevel: LogLevel;
    readonly categoryLevels: Readonly<Partial<Record<LogCategory, LogLevel>>>;
    readonly logSinks: readonly LogSinkName[];
    readonly logBufferSize: number;
    readonly logPreviousRunSize: number;
    readonly statsIntervalMs: number;
    readonly peerLogs: boolean;
}

export type SettingKey = Exclude<keyof Settings, 'schemaVersion'>;

export type SettingSection = 'general' | 'transfer' | 'timeouts' | 'storage' | 'advanced';

// AP-04: when a change takes effect.
export type TakesEffect = 'now' | 'next-file' | 'next-batch' | 'next-save' | 'next-pairing' | 'slot-free';

export type SettingUnit = 'bytes' | 'ms' | 'seconds' | 'minutes' | 'days' | 'count' | 'files';

// Everyday settings show in the Settings sheet; the rest are changed here, in code.
export type SettingVisibility = 'basic' | 'advanced';

export const BASIC_SETTINGS: readonly SettingKey[] = Object.freeze([
    'deviceName',
    'pin',
    'askBeforeReceiving',
    'findNearbyDevices',
]);

interface DescriptorBase<Key extends SettingKey> {
    readonly key: Key;
    readonly section: SettingSection;
    readonly label: string;
    readonly takesEffect: TakesEffect;
    readonly help?: string;
}

export interface NumberDescriptor<Key extends SettingKey = SettingKey> extends DescriptorBase<Key> {
    readonly kind: 'number';
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly unit: SettingUnit;
    // Choices shown instead of a free number field, e.g. page sizes in powers of two.
    readonly choices?: readonly number[];
    // Label for 0, e.g. "Auto" for concurrency.
    readonly zeroLabel?: string;
}

export interface BooleanDescriptor<Key extends SettingKey = SettingKey> extends DescriptorBase<Key> {
    readonly kind: 'boolean';
}

export interface TextDescriptor<Key extends SettingKey = SettingKey> extends DescriptorBase<Key> {
    readonly kind: 'text';
    readonly minLength: number;
    readonly maxLength: number;
}

// A PIN: digits only, or null for none.
export interface PinDescriptor<Key extends SettingKey = SettingKey> extends DescriptorBase<Key> {
    readonly kind: 'pin';
    readonly minDigits: number;
    readonly maxDigits: number;
}

export interface ChoiceDescriptor<Key extends SettingKey = SettingKey> extends DescriptorBase<Key> {
    readonly kind: 'choice';
    readonly choices: readonly string[];
    // Display text per choice; the value itself when missing.
    readonly choiceLabels?: Readonly<Record<string, string>>;
}

export interface ListDescriptor<Key extends SettingKey = SettingKey> extends DescriptorBase<Key> {
    readonly kind: 'list';
    readonly choices: readonly string[];
}

export interface LevelMapDescriptor<Key extends SettingKey = SettingKey> extends DescriptorBase<Key> {
    readonly kind: 'level-map';
}

export type SettingDescriptor =
    | NumberDescriptor
    | BooleanDescriptor
    | TextDescriptor
    | PinDescriptor
    | ChoiceDescriptor
    | ListDescriptor
    | LevelMapDescriptor;

const PAGE_SIZES = Object.freeze([256 * KIB, 512 * KIB, MIB, 2 * MIB, 4 * MIB, 8 * MIB]);
const CHUNK_SIZES = Object.freeze([16 * KIB, 32 * KIB, 64 * KIB]);

// Every setting with its label, range and when a change takes effect (AP-03, AP-04). The Settings sheet shows the
// everyday ones (BASIC_SETTINGS) with their label and help; the rest have no UI and are changed in code.
export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = Object.freeze([
    {
        key: 'deviceName',
        section: 'general',
        kind: 'text',
        label: 'Device name',
        minLength: 1,
        maxLength: 32,
        takesEffect: 'now',
        help: 'Nearby devices see this name.',
    },
    {
        key: 'pin',
        section: 'general',
        kind: 'pin',
        label: 'PIN',
        minDigits: MIN_PIN_DIGITS,
        maxDigits: MAX_PIN_DIGITS,
        takesEffect: 'now',
        help: 'Devices must enter it to connect to you.',
    },
    {
        key: 'askBeforeReceiving',
        section: 'general',
        kind: 'boolean',
        label: 'Ask before receiving',
        takesEffect: 'next-file',
        help: 'Review each batch before it arrives.',
    },
    {
        key: 'findNearbyDevices',
        section: 'general',
        kind: 'boolean',
        label: 'Find nearby devices',
        takesEffect: 'now',
        help: 'Uses public relays to find devices on the same Wi‑Fi.',
    },
    {
        key: 'pageSize',
        section: 'transfer',
        kind: 'number',
        label: 'Batch (page) size',
        min: 256 * KIB,
        max: 8 * MIB,
        step: 256 * KIB,
        unit: 'bytes',
        choices: PAGE_SIZES,
        takesEffect: 'next-file',
    },
    {
        key: 'chunkSize',
        section: 'transfer',
        kind: 'number',
        label: 'Chunk size',
        min: 16 * KIB,
        max: 64 * KIB,
        step: 16 * KIB,
        unit: 'bytes',
        choices: CHUNK_SIZES,
        takesEffect: 'next-file',
    },
    {
        key: 'maxConcurrentFiles',
        section: 'transfer',
        kind: 'number',
        label: 'Concurrent files',
        min: 0,
        max: 4,
        step: 1,
        unit: 'files',
        zeroLabel: 'Auto',
        takesEffect: 'slot-free',
        help: 'Auto sends 2 at once, or 4 when most files in the batch are under 5 MB.',
    },
    {
        key: 'sendThumbnailsFirst',
        section: 'transfer',
        kind: 'boolean',
        label: 'Send thumbnails first',
        takesEffect: 'next-batch',
    },
    {
        key: 'maxBuffered',
        section: 'transfer',
        kind: 'number',
        label: 'Max buffered',
        min: MIB,
        max: 16 * MIB,
        step: MIB,
        unit: 'bytes',
        takesEffect: 'now',
    },
    {
        key: 'pingIntervalMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Ping interval',
        min: SECOND,
        max: 10 * SECOND,
        step: SECOND,
        unit: 'seconds',
        takesEffect: 'now',
    },
    {
        key: 'weakAfterMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Weak after',
        min: 3 * SECOND,
        max: 30 * SECOND,
        step: SECOND,
        unit: 'seconds',
        takesEffect: 'now',
    },
    {
        key: 'lostAfterMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Lost after',
        min: 5 * SECOND,
        max: 60 * SECOND,
        step: SECOND,
        unit: 'seconds',
        takesEffect: 'now',
        help: 'Must be longer than Weak after.',
    },
    {
        key: 'gatheringCapMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Gathering cap',
        min: SECOND,
        max: 10 * SECOND,
        step: SECOND,
        unit: 'seconds',
        takesEffect: 'next-pairing',
    },
    {
        key: 'codeExpiryMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Code expiry',
        min: MINUTE,
        max: 30 * MINUTE,
        step: MINUTE,
        unit: 'minutes',
        takesEffect: 'next-pairing',
    },
    {
        key: 'connectTimeoutMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Connect timeout',
        min: 5 * SECOND,
        max: 60 * SECOND,
        step: SECOND,
        unit: 'seconds',
        takesEffect: 'next-pairing',
    },
    {
        key: 'offerReplyTimeoutMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Offer reply timeout',
        min: 5 * SECOND,
        max: 60 * SECOND,
        step: SECOND,
        unit: 'seconds',
        takesEffect: 'next-file',
    },
    {
        key: 'pageAckTimeoutMs',
        section: 'timeouts',
        kind: 'number',
        label: 'Page ack timeout',
        min: 2 * SECOND,
        max: 60 * SECOND,
        step: SECOND,
        unit: 'seconds',
        takesEffect: 'now',
        help: 'A page with no ack after this is sent again.',
    },
    {
        key: 'pageResendTries',
        section: 'timeouts',
        kind: 'number',
        label: 'Page resend tries',
        min: 1,
        max: 10,
        step: 1,
        unit: 'count',
        takesEffect: 'now',
    },
    {
        key: 'keepPartialDays',
        section: 'storage',
        kind: 'number',
        label: 'Keep partial files',
        min: 1,
        max: 90,
        step: 1,
        unit: 'days',
        takesEffect: 'now',
    },
    {
        key: 'keepHistoryDays',
        section: 'storage',
        kind: 'number',
        label: 'Keep history',
        min: 7,
        max: 365,
        step: 1,
        unit: 'days',
        takesEffect: 'now',
    },
    {
        key: 'keepHistoryPerSession',
        section: 'storage',
        kind: 'number',
        label: 'History per device',
        min: 100,
        max: 10_000,
        step: 100,
        unit: 'count',
        takesEffect: 'now',
    },
    {
        key: 'debugLogging',
        section: 'advanced',
        kind: 'boolean',
        label: 'Debug logging',
        takesEffect: 'now',
    },
    {
        key: 'logLevel',
        section: 'advanced',
        kind: 'choice',
        label: 'Minimum level',
        choices: LOG_LEVELS,
        takesEffect: 'now',
    },
    {
        key: 'categoryLevels',
        section: 'advanced',
        kind: 'level-map',
        label: 'Category levels',
        takesEffect: 'now',
    },
    {
        key: 'logSinks',
        section: 'advanced',
        kind: 'list',
        label: 'Sinks',
        choices: LOG_SINK_NAMES,
        takesEffect: 'now',
    },
    {
        key: 'logBufferSize',
        section: 'advanced',
        kind: 'number',
        label: 'Log buffer size',
        min: 500,
        max: 50_000,
        step: 500,
        unit: 'count',
        takesEffect: 'now',
    },
    {
        key: 'logPreviousRunSize',
        section: 'advanced',
        kind: 'number',
        label: 'Keep previous run',
        min: 100,
        max: 10_000,
        step: 100,
        unit: 'count',
        takesEffect: 'now',
    },
    {
        key: 'statsIntervalMs',
        section: 'advanced',
        kind: 'number',
        label: 'Stats polling interval',
        min: 500,
        max: 10 * SECOND,
        step: 500,
        unit: 'ms',
        takesEffect: 'now',
    },
    {
        key: 'peerLogs',
        section: 'advanced',
        kind: 'boolean',
        label: "Show peer's logs",
        takesEffect: 'now',
    },
] satisfies SettingDescriptor[]);

export const BASE_DEFAULTS: Settings = Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    deviceName: 'Device',
    pin: null,
    askBeforeReceiving: true,
    findNearbyDevices: true,
    pageSize: MIB,
    chunkSize: 64 * KIB,
    maxConcurrentFiles: 0,
    sendThumbnailsFirst: true,
    maxBuffered: 4 * MIB,
    pingIntervalMs: 2 * SECOND,
    weakAfterMs: 6 * SECOND,
    lostAfterMs: 10 * SECOND,
    gatheringCapMs: 3 * SECOND,
    codeExpiryMs: 5 * MINUTE,
    connectTimeoutMs: 15 * SECOND,
    offerReplyTimeoutMs: 15 * SECOND,
    pageAckTimeoutMs: 10 * SECOND,
    pageResendTries: 3,
    keepPartialDays: 7,
    keepHistoryDays: 7,
    keepHistoryPerSession: 1000,
    debugLogging: false,
    logLevel: 'debug',
    categoryLevels: {},
    logSinks: ['memory', 'console'] as LogSinkName[],
    logBufferSize: 5000,
    logPreviousRunSize: 1000,
    statsIntervalMs: SECOND,
    peerLogs: false,
});

// Platform and device values that differ from the base, e.g. the default device name.
export function createDefaultSettings(overrides: Partial<Settings> = {}): Settings {
    return normalizeSettings({ ...BASE_DEFAULTS, ...overrides }).settings;
}

export interface SettingProblem {
    readonly key: SettingKey;
    readonly message: string;
}

export interface NormalizedSettings {
    readonly settings: Settings;
    // AP-03: values that were clamped or replaced, with the allowed range.
    readonly problems: readonly SettingProblem[];
}

// Fills gaps from the defaults, clamps out-of-range values and keeps Lost after > Weak after.
export function normalizeSettings(input: Partial<Settings>, defaults: Settings = BASE_DEFAULTS): NormalizedSettings {
    const problems: SettingProblem[] = [];
    const result: Record<string, unknown> = { ...defaults, schemaVersion: SETTINGS_SCHEMA_VERSION };

    for (const descriptor of SETTING_DESCRIPTORS) {
        const raw = (input as Record<string, unknown>)[descriptor.key];
        if (raw === undefined) {
            continue;
        }

        const { value, problem } = normalizeValue(descriptor, raw, defaults[descriptor.key]);
        result[descriptor.key] = value;
        if (problem) {
            problems.push({ key: descriptor.key, message: problem });
        }
    }

    const settings = result as unknown as Settings;
    if (settings.lostAfterMs <= settings.weakAfterMs) {
        result.lostAfterMs = Math.min(60 * SECOND, settings.weakAfterMs + SECOND);
        problems.push({ key: 'lostAfterMs', message: 'Lost after must be longer than Weak after.' });
    }

    return { settings: result as unknown as Settings, problems };
}

function normalizeValue(
    descriptor: SettingDescriptor,
    raw: unknown,
    fallback: unknown,
): { value: unknown; problem?: string } {
    switch (descriptor.kind) {
        case 'number': {
            return normalizeNumber(descriptor, raw, fallback as number);
        }
        case 'boolean': {
            return typeof raw === 'boolean' ? { value: raw } : { value: fallback, problem: 'Must be on or off.' };
        }
        case 'text': {
            const text = typeof raw === 'string' ? raw.trim() : '';
            const length = [...text].length;
            const problem = `Use ${descriptor.minLength}–${descriptor.maxLength} characters.`;
            if (length < descriptor.minLength) {
                return { value: fallback, problem };
            }

            if (length > descriptor.maxLength) {
                return { value: [...text].slice(0, descriptor.maxLength).join(''), problem };
            }

            return { value: text };
        }
        case 'pin': {
            return normalizePin(raw, fallback as string | null);
        }
        case 'choice': {
            return descriptor.choices.includes(raw as string)
                ? { value: raw }
                : { value: fallback, problem: `Choose one of ${descriptor.choices.join(', ')}.` };
        }
        case 'list': {
            const list = Array.isArray(raw) ? raw.filter(item => descriptor.choices.includes(item as string)) : [];

            return { value: [...new Set(list)] };
        }
        case 'level-map': {
            return { value: normalizeLevelMap(raw) };
        }
    }
}

// Null, or an empty text, is no PIN; spaces are dropped, so "1234 5678" reads as 8 digits.
function normalizePin(raw: unknown, fallback: string | null): { value: string | null; problem?: string } {
    const digits = typeof raw === 'string' ? raw.replace(/\s+/g, '') : raw;
    if (digits === null || digits === '') {
        return { value: null };
    }

    return isValidPin(digits) ? { value: digits } : { value: fallback, problem: PIN_FORMAT_TEXT };
}

function normalizeNumber(
    descriptor: NumberDescriptor,
    raw: unknown,
    fallback: number,
): { value: number; problem?: string } {
    const number = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(number)) {
        return { value: fallback, problem: 'Must be a number.' };
    }

    const clamped = Math.min(descriptor.max, Math.max(descriptor.min, number));
    const value = descriptor.choices ? nearest(descriptor.choices, clamped) : Math.round(clamped);
    if (value !== number) {
        const minimum = formatSettingValue(descriptor, descriptor.min);
        const maximum = formatSettingValue(descriptor, descriptor.max);

        return { value, problem: `Allowed: ${minimum} – ${maximum}.` };
    }

    return { value };
}

function nearest(choices: readonly number[], value: number): number {
    return choices.reduce((best, choice) => (Math.abs(choice - value) < Math.abs(best - value) ? choice : best));
}

function normalizeLevelMap(raw: unknown): Partial<Record<LogCategory, LogLevel>> {
    if (raw == null || typeof raw !== 'object') {
        return {};
    }

    const result: Partial<Record<LogCategory, LogLevel>> = {};
    for (const cat of LOG_CATEGORIES) {
        const level = (raw as Record<string, unknown>)[cat];
        if (LOG_LEVELS.includes(level as LogLevel)) {
            result[cat] = level as LogLevel;
        }
    }

    return result;
}

const UNIT_FORMATS: Readonly<Record<SettingUnit, (value: number) => string>> = Object.freeze({
    bytes: (value: number) => formatBytes(value),
    ms: (value: number) => `${value} ms`,
    seconds: (value: number) => `${value / SECOND} s`,
    minutes: (value: number) => `${value / MINUTE} min`,
    days: (value: number) => (value === 1 ? '1 day' : `${value} days`),
    count: (value: number) => value.toLocaleString('en'),
    files: (value: number) => `${value}`,
});

export function formatSettingValue(descriptor: NumberDescriptor, value: number): string {
    if (value === 0 && descriptor.zeroLabel) {
        return descriptor.zeroLabel;
    }

    return UNIT_FORMATS[descriptor.unit](value);
}

export function formatBytes(bytes: number): string {
    if (bytes < KIB) {
        return `${bytes} B`;
    }

    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes / KIB;
    let unit = 0;
    while (value >= KIB && unit < units.length - 1) {
        value /= KIB;
        unit++;
    }

    const digits = value >= 100 || Number.isInteger(value) ? 0 : 1;

    return `${value.toFixed(digits)} ${units[unit]}`;
}

export function toLogRouting(settings: Settings): LogRouting {
    return {
        debugLogging: settings.debugLogging,
        level: settings.logLevel,
        categoryLevels: settings.categoryLevels,
        sinks: settings.logSinks,
    };
}

// The record stored under the 'settings' key in the settings store, with older schema versions upgraded.
interface SettingsMigration {
    readonly from: number;
    migrate(record: Record<string, unknown>): Record<string, unknown>;
}

const MIGRATIONS: readonly SettingsMigration[] = [];

export function migrateSettings(record: unknown): Partial<Settings> {
    if (record == null || typeof record !== 'object') {
        return {};
    }

    let current = { ...(record as Record<string, unknown>) };
    for (const migration of MIGRATIONS) {
        if ((current.schemaVersion as number | undefined ?? 0) === migration.from) {
            current = migration.migrate(current);
        }
    }

    return current as Partial<Settings>;
}

export function settingVisibility(key: SettingKey): SettingVisibility {
    return BASIC_SETTINGS.includes(key) ? 'basic' : 'advanced';
}

export function getDescriptor(key: SettingKey): SettingDescriptor {
    const descriptor = SETTING_DESCRIPTORS.find(item => item.key === key);
    if (!descriptor) {
        throw new Error(`Unknown setting ${key}`);
    }

    return descriptor;
}
