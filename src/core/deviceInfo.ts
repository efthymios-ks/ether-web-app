// Identifies OS, device type, model, browser, engine and install mode (Appendix A).
// The user-agent string is a hint, not a guarantee: decide features with `capabilities`,
// and use the rest for labels, defaults and diagnostics.

export type OS = 'iOS' | 'iPadOS' | 'macOS' | 'Android' | 'Windows' | 'ChromeOS' | 'Linux' | 'Unknown';
export type DeviceType = 'phone' | 'tablet' | 'desktop';
export type Browser =
    | 'Safari'
    | 'Chrome'
    | 'Edge'
    | 'Firefox'
    | 'Samsung Internet'
    | 'Opera'
    | 'Brave'
    | 'In-app'
    | 'Unknown';
export type Engine = 'WebKit' | 'Blink' | 'Gecko' | 'Unknown';
export type DisplayMode = 'browser' | 'standalone' | 'minimal-ui' | 'fullscreen';

export interface Capabilities {
    readonly webrtc: boolean;
    readonly wakeLock: boolean;
    readonly shareFiles: boolean;
    readonly barcodeDetector: boolean;
    readonly webLocks: boolean;
    readonly persistentStorage: boolean;
    readonly opfsWritable: boolean;
    readonly camera: boolean;
    readonly broadcastChannel: boolean;
    readonly indexedDb: boolean;
    readonly directoryPicker: boolean;
    readonly folderInput: boolean;
}

export interface DeviceInfo {
    readonly os: OS;
    // From the user agent or Client Hints. Browsers freeze parts of it; never gate features on it.
    readonly osVersion?: string;
    readonly deviceType: DeviceType;
    // 'iPhone' | 'iPad' | 'Mac' | an Android model (Chromium on Android only, through Client Hints).
    readonly model?: string;
    readonly browser: Browser;
    readonly browserVersion?: string;
    readonly engine: Engine;
    readonly displayMode: DisplayMode;
    // An installed / home-screen app. On iPhone it has its own storage, separate from Safari.
    readonly installed: boolean;
    // Facebook, Instagram and other web views: camera, downloads and storage are often limited.
    readonly inAppBrowser: boolean;
    readonly touch: boolean;
    readonly capabilities: Capabilities;
    // Short label, e.g. "iPhone · Safari", "Pixel 8 · Chrome", "Mac · Firefox".
    readonly label: string;
}

export type ParsedUserAgent = Omit<DeviceInfo, 'displayMode' | 'installed' | 'capabilities' | 'label'>;

export interface UaBrand {
    readonly brand: string;
    readonly version: string;
}

// Minimal typings: User-Agent Client Hints are not in every TypeScript DOM lib.
export interface UaData {
    readonly brands?: readonly UaBrand[];
    readonly mobile?: boolean;
    readonly platform?: string;
    getHighEntropyValues?(hints: string[]): Promise<HighEntropy>;
}

export interface HighEntropy {
    readonly model?: string;
    readonly platformVersion?: string;
    readonly fullVersionList?: readonly UaBrand[];
}

export interface UaInput {
    readonly ua: string;
    readonly maxTouchPoints?: number;
    // navigator.userAgentData (Chromium only).
    readonly uaData?: UaData;
    // The result of uaData.getHighEntropyValues(), when asked for.
    readonly highEntropy?: HighEntropy;
}

const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|LinkedInApp|GSA\/|Snapchat|TikTok|musical_ly/i;

interface OsMatch {
    readonly os: OS;
    readonly deviceType: DeviceType;
    readonly model?: string;
}

// Order is priority: iPadOS before macOS, Android before Linux.
const OS_RULES: ReadonlyArray<{ test(ua: string, maxTouchPoints: number): boolean; match(ua: string, input: UaInput): OsMatch }> = [
    {
        test: ua => /iPhone|iPod/.test(ua),
        match: () => ({ os: 'iOS', deviceType: 'phone', model: 'iPhone' }),
    },
    {
        // iPadOS 13+ Safari sends a Mac user agent; touch points give it away.
        test: (ua, maxTouchPoints) => /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1),
        match: () => ({ os: 'iPadOS', deviceType: 'tablet', model: 'iPad' }),
    },
    {
        test: ua => /Android/.test(ua),
        match: (ua, input) => ({
            os: 'Android',
            deviceType: (input.uaData?.mobile ?? /Mobile/.test(ua)) ? 'phone' : 'tablet',
            model: androidModel(ua, input.highEntropy),
        }),
    },
    {
        test: ua => /CrOS/.test(ua),
        match: () => ({ os: 'ChromeOS', deviceType: 'desktop' }),
    },
    {
        test: ua => /Macintosh|Mac OS X/.test(ua),
        match: () => ({ os: 'macOS', deviceType: 'desktop', model: 'Mac' }),
    },
    {
        test: ua => /Windows NT/.test(ua),
        match: () => ({ os: 'Windows', deviceType: 'desktop' }),
    },
    {
        test: ua => /Linux/.test(ua),
        match: () => ({ os: 'Linux', deviceType: 'desktop' }),
    },
];

function androidModel(ua: string, highEntropy: HighEntropy | undefined): string | undefined {
    if (highEntropy?.model) {
        return highEntropy.model;
    }

    // The reduced user agent shows "K".
    const fromUa = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1]?.trim();
    if (!fromUa || /^(K|Mobile|Tablet|rv:.*)$/.test(fromUa)) {
        return undefined;
    }

    return fromUa;
}

function osVersionOf(os: OS, ua: string, highEntropy: HighEntropy | undefined): string | undefined {
    if (os === 'iOS' || os === 'iPadOS') {
        const version = /OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/.exec(ua) ?? /Version\/(\d+)\.(\d+)/.exec(ua);

        return version ? [version[1], version[2], version[3]].filter(Boolean).join('.') : undefined;
    }

    if (os === 'Android') {
        return highEntropy?.platformVersion || /Android ([\d.]+)/.exec(ua)?.[1];
    }

    if (os === 'Windows') {
        // The user agent says "10" for both 10 and 11.
        const major = Number(highEntropy?.platformVersion?.split('.')[0]);
        if (!Number.isFinite(major) || major <= 0) {
            return undefined;
        }

        return major >= 13 ? '11' : '10';
    }

    if (os === 'macOS') {
        // The user agent is frozen at 10_15_7.
        return highEntropy?.platformVersion;
    }

    return undefined;
}

interface BrowserRule {
    readonly pattern: RegExp;
    readonly browser: Browser;
    readonly version?: RegExp;
}

// Every browser on iPhone and iPad is WebKit; the wrapper names its own brand.
const APPLE_MOBILE_BROWSERS: readonly BrowserRule[] = [
    { pattern: /CriOS\//, browser: 'Chrome', version: /CriOS\/([\d.]+)/ },
    { pattern: /FxiOS\//, browser: 'Firefox', version: /FxiOS\/([\d.]+)/ },
    { pattern: /EdgiOS\//, browser: 'Edge', version: /EdgiOS\/([\d.]+)/ },
    { pattern: /OPT\/|OPiOS\//, browser: 'Opera', version: /(?:OPT|OPiOS)\/([\d.]+)/ },
    { pattern: IN_APP, browser: 'In-app' },
    { pattern: /Safari\//, browser: 'Safari', version: /Version\/([\d.]+)/ },
];

const OTHER_BROWSERS: readonly BrowserRule[] = [
    { pattern: /Edg(?:A|e)?\//, browser: 'Edge', version: /Edg(?:A|e)?\/([\d.]+)/ },
    { pattern: /OPR\//, browser: 'Opera', version: /OPR\/([\d.]+)/ },
    { pattern: /SamsungBrowser\//, browser: 'Samsung Internet', version: /SamsungBrowser\/([\d.]+)/ },
    { pattern: /Firefox\//, browser: 'Firefox', version: /Firefox\/([\d.]+)/ },
    { pattern: IN_APP, browser: 'In-app' },
    { pattern: /Chrome\/|Chromium\//, browser: 'Chrome', version: /(?:Chrome|Chromium)\/([\d.]+)/ },
    { pattern: /Version\/[\d.]+.*Safari\//, browser: 'Safari', version: /Version\/([\d.]+)/ },
];

// Client Hints brands are more reliable than the user agent on Chromium.
const HINTED_BRANDS: ReadonlyArray<{ readonly pattern: RegExp; readonly browser: Browser; readonly brand: string }> = [
    { pattern: /Microsoft Edge/, browser: 'Edge', brand: 'Microsoft Edge' },
    { pattern: /Opera/, browser: 'Opera', brand: 'Opera' },
    { pattern: /Brave/, browser: 'Brave', brand: 'Brave' },
    { pattern: /Samsung Internet/, browser: 'Samsung Internet', brand: 'Samsung Internet' },
    { pattern: /Google Chrome/, browser: 'Chrome', brand: 'Google Chrome' },
];

function browserOf(
    os: OS,
    ua: string,
    brands: readonly UaBrand[],
): { browser: Browser; browserVersion?: string } {
    const rules = os === 'iOS' || os === 'iPadOS' ? APPLE_MOBILE_BROWSERS : OTHER_BROWSERS;
    const rule = rules.find(item => item.pattern.test(ua));
    const fromUa = {
        browser: rule?.browser ?? 'Unknown',
        browserVersion: rule?.version ? rule.version.exec(ua)?.[1] : undefined,
    } satisfies { browser: Browser; browserVersion?: string };

    const hinted = HINTED_BRANDS.find(item => brands.some(brand => item.pattern.test(brand.brand)));
    if (!hinted) {
        return fromUa;
    }

    const version = brands.find(brand => brand.brand.includes(hinted.brand))?.version;

    return { browser: hinted.browser, browserVersion: version ?? fromUa.browserVersion };
}

function engineOf(os: OS, browser: Browser, ua: string, brands: readonly UaBrand[]): Engine {
    if (os === 'iOS' || os === 'iPadOS') {
        return 'WebKit';
    }

    if (browser === 'Firefox') {
        return 'Gecko';
    }

    if (/Chrome\/|Chromium\/|Edg|OPR\/|SamsungBrowser/.test(ua) || brands.length > 0) {
        return 'Blink';
    }

    if (/AppleWebKit/.test(ua)) {
        return 'WebKit';
    }

    return /Gecko\//.test(ua) ? 'Gecko' : 'Unknown';
}

// Pure parser: testable without a browser (DD-09).
export function parseUserAgent(input: UaInput): ParsedUserAgent {
    const { ua, maxTouchPoints = 0, uaData, highEntropy } = input;
    const touch = maxTouchPoints > 0 || /Mobi|Android|iPhone|iPad/i.test(ua);
    const osRule = OS_RULES.find(rule => rule.test(ua, maxTouchPoints));
    const { os, deviceType, model } = osRule?.match(ua, input) ?? { os: 'Unknown', deviceType: 'desktop' };
    const brands = highEntropy?.fullVersionList ?? uaData?.brands ?? [];
    const { browser, browserVersion } = browserOf(os, ua, brands);

    return {
        os,
        osVersion: osVersionOf(os, ua, highEntropy),
        deviceType,
        model,
        browser,
        browserVersion,
        engine: engineOf(os, browser, ua, brands),
        inAppBrowser: IN_APP.test(ua),
        touch,
    };
}

export function detectDisplayMode(
    matches: (query: string) => boolean = query => typeof matchMedia === 'function' && matchMedia(query).matches,
    iosStandalone: boolean = (globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true,
): { displayMode: DisplayMode; installed: boolean } {
    const isMode = (mode: string): boolean => matches(`(display-mode: ${mode})`);
    const displayMode: DisplayMode = isMode('fullscreen')
        ? 'fullscreen'
        : isMode('standalone') || iosStandalone
            ? 'standalone'
            : isMode('minimal-ui')
                ? 'minimal-ui'
                : 'browser';

    return { displayMode, installed: displayMode !== 'browser' };
}

export function detectCapabilities(): Capabilities {
    const nav = navigator as Navigator & { locks?: unknown };
    let shareFiles = false;
    try {
        shareFiles = typeof nav.canShare === 'function'
            && nav.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });
    } catch {
        // canShare throws on some builds.
    }

    return {
        webrtc: typeof RTCPeerConnection === 'function',
        wakeLock: 'wakeLock' in nav,
        shareFiles,
        barcodeDetector: 'BarcodeDetector' in globalThis,
        webLocks: 'locks' in nav,
        persistentStorage: typeof nav.storage?.persist === 'function',
        opfsWritable: typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype,
        camera: typeof nav.mediaDevices?.getUserMedia === 'function',
        broadcastChannel: typeof BroadcastChannel === 'function',
        indexedDb: typeof indexedDB !== 'undefined',
        directoryPicker: 'showDirectoryPicker' in globalThis,
        folderInput: typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input'),
    };
}

export function deviceLabel(parsed: Pick<DeviceInfo, 'model' | 'os' | 'browser'>, installed: boolean): string {
    return `${parsed.model ?? parsed.os} · ${installed ? 'App' : parsed.browser}`;
}

// Full detection in the browser. Asks Client Hints for the Android model and real OS version (Chromium).
export async function getDeviceInfoAsync(): Promise<DeviceInfo> {
    const uaData = (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
    let highEntropy: HighEntropy | undefined;
    try {
        highEntropy = await uaData?.getHighEntropyValues?.(['model', 'platformVersion', 'fullVersionList']);
    } catch {
        // Blocked by policy or not supported.
    }

    const parsed = parseUserAgent({
        ua: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        uaData,
        highEntropy,
    });

    // Brave hides its brand on some platforms but exposes navigator.brave.
    const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    const isBrave = brave?.isBrave ? await brave.isBrave().catch(() => false) : false;
    const browser: Browser = isBrave ? 'Brave' : parsed.browser;
    const { displayMode, installed } = detectDisplayMode();

    return {
        ...parsed,
        browser,
        displayMode,
        installed,
        capabilities: detectCapabilities(),
        label: deviceLabel({ ...parsed, browser }, installed),
    };
}

// What a device says it is, shown as a tag beside its name on other devices. The platform classes in
// src/platform pick it; Phone, Tablet and Computer stand in when the system is unknown.
export const DEVICE_PLATFORMS = Object.freeze([
    'Android',
    'iPhone',
    'iPad',
    'Windows',
    'Mac',
    'Linux',
    'ChromeOS',
    'Phone',
    'Tablet',
    'Computer',
] as const);

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

const FALLBACK_PLATFORMS: Readonly<Record<DeviceType, DevicePlatform>> = Object.freeze({
    phone: 'Phone',
    tablet: 'Tablet',
    desktop: 'Computer',
});

export function fallbackPlatform(deviceType: DeviceType): DevicePlatform {
    return FALLBACK_PLATFORMS[deviceType] ?? 'Computer';
}

// A platform another device sent; undefined when it is missing or unknown to this build, so no tag shows.
export function toDevicePlatform(value: unknown): DevicePlatform | undefined {
    return DEVICE_PLATFORMS.includes(value as DevicePlatform) ? (value as DevicePlatform) : undefined;
}

// Default names pair an adjective with a Greek hero or god: public-domain myth, unlike superhero names.
const ADJECTIVES = Object.freeze([
    'Swift',
    'Brave',
    'Bold',
    'Calm',
    'Bright',
    'Noble',
    'Clever',
    'Mighty',
    'Quick',
    'Silent',
    'Golden',
    'Lucky',
]);
const NAMES = Object.freeze([
    'Perseus',
    'Achilles',
    'Atalanta',
    'Odysseus',
    'Hector',
    'Orion',
    'Theseus',
    'Hippolyta',
    'Jason',
    'Ajax',
    'Penelope',
    'Castor',
    'Pollux',
    'Icarus',
    'Medea',
    'Hercules',
    'Zeus',
    'Hera',
    'Poseidon',
    'Athena',
    'Apollo',
    'Artemis',
    'Hermes',
    'Ares',
    'Aphrodite',
    'Hephaestus',
    'Demeter',
    'Dionysus',
    'Hestia',
    'Persephone',
    'Hades',
    'Helios',
    'Selene',
    'Eos',
    'Iris',
    'Nike',
]);

// Default editable device name, e.g. "Swift Perseus". Browsers don't expose the real device name,
// and the platform travels as its own tag.
export function defaultDeviceName(random: () => number = Math.random): string {
    const pick = (list: readonly string[]): string => list[Math.floor(random() * list.length)] ?? list[0] ?? '';

    return `${pick(ADJECTIVES)} ${pick(NAMES)}`;
}

export interface NameSuggestionOptions {
    // Names left out, compared without case: the current name and the suggestions already shown.
    readonly exclude?: readonly string[];
    readonly random?: () => number;
}

// Up to `count` different default-style names for the rename sheet.
export function suggestDeviceNames(count: number, options: NameSuggestionOptions = {}): string[] {
    const random = options.random ?? Math.random;
    const excluded = new Set((options.exclude ?? []).map(name => name.trim().toLowerCase()));
    const names = new Set<string>();
    // Bounded, so a random source that keeps repeating itself still ends.
    for (let tries = 0; names.size < count && tries < count * 20; tries++) {
        const name = defaultDeviceName(random);
        if (!excluded.has(name.toLowerCase())) {
            names.add(name);
        }
    }

    return [...names];
}
