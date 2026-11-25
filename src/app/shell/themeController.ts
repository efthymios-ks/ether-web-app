// UI-12: System, Light or Dark, chosen in Settings, stored per device and applied as data-theme on <html>.
// System follows prefers-color-scheme, also when it changes while the page is open; nothing stored counts as System.

export type ThemeMode = 'light' | 'dark';
export type ThemePreference = 'system' | ThemeMode;

export const THEME_STORAGE_KEY = 'ether.theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = Object.freeze(['system', 'light', 'dark']);
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export interface ThemeControllerOptions {
    readonly root?: HTMLElement;
    readonly storage?: ThemeStorage;
    readonly matchMedia?: (query: string) => MediaQueryList;
}

export interface ThemeController {
    // The theme on screen.
    readonly mode: ThemeMode;
    // What the user chose; System shows whichever theme the device uses.
    readonly preference: ThemePreference;
    // Applies and stores the choice.
    setPreference(preference: ThemePreference): void;
    // Called whenever the theme is applied, with the theme on screen.
    onChange(handler: (mode: ThemeMode) => void): () => void;
    dispose(): void;
}

export function createThemeController(options: ThemeControllerOptions = {}): ThemeController {
    const root = options.root ?? document.documentElement;
    const storage = options.storage ?? safeLocalStorage();
    const systemDark = (options.matchMedia ?? defaultMatchMedia())?.(SYSTEM_DARK_QUERY);
    const handlers = new Set<(mode: ThemeMode) => void>();
    let preference: ThemePreference = readStoredPreference(storage) ?? 'system';

    const currentMode = (): ThemeMode => {
        if (preference !== 'system') {
            return preference;
        }

        return systemDark?.matches === true ? 'dark' : 'light';
    };

    const apply = (): void => {
        const mode = currentMode();
        root.dataset.theme = mode;
        delete root.dataset.themePending;
        for (const handler of handlers) {
            handler(mode);
        }
    };

    const onSystemChange = (): void => {
        if (preference === 'system') {
            apply();
        }
    };

    const setPreference = (next: ThemePreference): void => {
        preference = next;
        try {
            storage?.setItem(THEME_STORAGE_KEY, next);
        } catch {
            // Private mode or blocked storage: the theme still applies for this page.
        }

        apply();
    };

    systemDark?.addEventListener?.('change', onSystemChange);
    apply();

    return {
        get mode() {
            return currentMode();
        },
        get preference() {
            return preference;
        },
        setPreference,
        onChange: handler => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
        dispose: () => {
            handlers.clear();
            systemDark?.removeEventListener?.('change', onSystemChange);
        },
    };
}

// Anything stored other than system, light or dark counts as no choice.
function readStoredPreference(storage: ThemeStorage | undefined): ThemePreference | undefined {
    try {
        const stored = storage?.getItem(THEME_STORAGE_KEY);

        return THEME_PREFERENCES.includes(stored as ThemePreference) ? (stored as ThemePreference) : undefined;
    } catch {
        return undefined;
    }
}

function safeLocalStorage(): ThemeStorage | undefined {
    try {
        return globalThis.localStorage;
    } catch {
        return undefined;
    }
}

function defaultMatchMedia(): ((query: string) => MediaQueryList) | undefined {
    return typeof globalThis.matchMedia === 'function' ? query => globalThis.matchMedia(query) : undefined;
}
