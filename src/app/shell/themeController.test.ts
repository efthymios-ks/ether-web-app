import { describe, expect, it } from 'vitest';
import { createThemeController, THEME_STORAGE_KEY } from './themeController.js';
import type { ThemeStorage } from './themeController.js';

function createStorage(initial: Record<string, string> = {}): ThemeStorage & { values: Map<string, string> } {
    const values = new Map(Object.entries(initial));

    return {
        values,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
    };
}

function createMedia(isDark: boolean): {
    matchMedia: (query: string) => MediaQueryList;
    setDark(next: boolean): void;
    readonly listenerCount: number;
} {
    let matches = isDark;
    const listeners = new Set<() => void>();
    const query = {
        get matches() {
            return matches;
        },
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    } as unknown as MediaQueryList;

    return {
        matchMedia: () => query,
        setDark: next => {
            matches = next;
            for (const listener of listeners) {
                listener();
            }
        },
        get listenerCount() {
            return listeners.size;
        },
    };
}

describe('createThemeController', () => {
    it('follows the system when nothing is stored, without storing anything (UI-12)', () => {
        // Arrange
        const root = document.createElement('div');
        const storage = createStorage();

        // Act
        const theme = createThemeController({ root, storage, matchMedia: createMedia(true).matchMedia });

        // Assert
        expect(theme.preference).toBe('system');
        expect(theme.mode).toBe('dark');
        expect(root.dataset.theme).toBe('dark');
        expect(storage.values.has(THEME_STORAGE_KEY)).toBe(false);
    });

    it('clears the pending flag that keeps a dark system from flashing light', () => {
        // Arrange
        const root = document.createElement('html');
        root.dataset.themePending = '';

        // Act
        createThemeController({ root, storage: createStorage(), matchMedia: createMedia(true).matchMedia });

        // Assert
        expect(root.dataset.theme).toBe('dark');
        expect(root.hasAttribute('data-theme-pending')).toBe(false);
    });

    it('follows a system change while System is chosen, and tells its listeners', () => {
        // Arrange
        const root = document.createElement('div');
        const media = createMedia(false);
        const theme = createThemeController({ root, storage: createStorage(), matchMedia: media.matchMedia });
        const modes: string[] = [];
        theme.onChange(mode => modes.push(mode));

        // Act
        media.setDark(true);

        // Assert
        expect(root.dataset.theme).toBe('dark');
        expect(modes).toEqual(['dark']);
    });

    it('keeps Light or Dark whatever the system does', () => {
        // Arrange
        const root = document.createElement('div');
        const media = createMedia(false);
        const theme = createThemeController({ root, storage: createStorage(), matchMedia: media.matchMedia });
        theme.setPreference('light');

        // Act
        media.setDark(true);

        // Assert
        expect(theme.mode).toBe('light');
        expect(root.dataset.theme).toBe('light');
    });

    it('stores each choice under ether.theme, System included', () => {
        // Arrange
        const root = document.createElement('div');
        const storage = createStorage();
        const theme = createThemeController({ root, storage, matchMedia: createMedia(false).matchMedia });

        // Act
        theme.setPreference('dark');
        const stored = storage.values.get(THEME_STORAGE_KEY);
        theme.setPreference('system');

        // Assert
        expect(stored).toBe('dark');
        expect(storage.values.get(THEME_STORAGE_KEY)).toBe('system');
        expect(root.dataset.theme).toBe('light');
    });

    it('keeps a stored choice over the system setting', () => {
        // Arrange
        const root = document.createElement('div');

        // Act
        const theme = createThemeController({
            root,
            storage: createStorage({ [THEME_STORAGE_KEY]: 'light' }),
            matchMedia: createMedia(true).matchMedia,
        });

        // Assert
        expect(theme.preference).toBe('light');
        expect(theme.mode).toBe('light');
    });

    it('treats any other stored value as System', () => {
        // Arrange
        const root = document.createElement('div');

        // Act
        const theme = createThemeController({
            root,
            storage: createStorage({ [THEME_STORAGE_KEY]: 'sepia' }),
            matchMedia: createMedia(true).matchMedia,
        });

        // Assert
        expect(theme.preference).toBe('system');
        expect(theme.mode).toBe('dark');
    });

    it('keeps working when storage throws', () => {
        // Arrange
        const root = document.createElement('div');
        const storage: ThemeStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };

        // Act
        const theme = createThemeController({ root, storage, matchMedia: createMedia(false).matchMedia });
        theme.setPreference('dark');

        // Assert
        expect(root.dataset.theme).toBe('dark');
    });

    it('stops following the system once disposed', () => {
        // Arrange
        const media = createMedia(false);
        const theme = createThemeController({
            root: document.createElement('div'),
            storage: createStorage(),
            matchMedia: media.matchMedia,
        });

        // Act
        theme.dispose();

        // Assert
        expect(media.listenerCount).toBe(0);
    });
});
