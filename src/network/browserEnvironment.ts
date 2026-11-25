import type { NetworkEnvironment } from './networkTypes.js';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

// The browser side of NetworkEnvironment. Each member reads its global only when called,
// so building the object is safe where a global is missing (tests, workers).
export function createBrowserEnvironment(): NetworkEnvironment {
    const isHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    return {
        createPeerConnection: configuration => new RTCPeerConnection(configuration),
        now: () => performance.now(),
        wallClock: () => Date.now(),
        setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
        clearTimeout: handle => globalThis.clearTimeout(handle as TimerHandle),
        setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
        clearInterval: handle => globalThis.clearInterval(handle as TimerHandle),
        onVisibilityChange: handler => {
            if (typeof document === 'undefined') {
                return () => undefined;
            }

            const listener = (): void => handler(isHidden());
            document.addEventListener('visibilitychange', listener);

            return () => document.removeEventListener('visibilitychange', listener);
        },
        isHidden,
        onPageHide: handler => {
            if (typeof window === 'undefined') {
                return () => undefined;
            }

            const listener = (): void => handler();
            window.addEventListener('pagehide', listener);

            return () => window.removeEventListener('pagehide', listener);
        },
        randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
    };
}
