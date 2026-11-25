import type { Unsubscribe } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { createDiscovery } from './discovery.js';
import type { DiscoveryEnvironment } from './discovery.js';
import type { Discovery } from './discoveryTypes.js';
import type { RelaySocket, RelaySocketHandlers } from './relayConnection.js';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

// The browser wiring of nearby discovery; the logic and its tests live in discovery.ts.
export function createBrowserDiscovery(options: { readonly logger: Logger }): Discovery {
    return createDiscovery({ logger: options.logger, environment: createBrowserDiscoveryEnvironment() });
}

// Each member reads its global only when called, so building the object is safe where one is missing.
export function createBrowserDiscoveryEnvironment(): DiscoveryEnvironment {
    return {
        createPeerConnection: configuration => new RTCPeerConnection(configuration),
        createSocket: openWebSocket,
        fetchAsync: (url, init) => fetch(url, init),
        now: () => performance.now(),
        wallClock: () => Date.now(),
        setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
        clearTimeout: handle => globalThis.clearTimeout(handle as TimerHandle),
        random: () => Math.random(),
        randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
        onConnectivityChange: handler => {
            const stopOnline = listenToWindow('online', () => handler(true));
            const stopOffline = listenToWindow('offline', () => handler(false));

            return () => {
                stopOnline();
                stopOffline();
            };
        },
        onPageHide: handler => listenToWindow('pagehide', () => handler()),
        onPageShow: handler => listenToWindow('pageshow', event => {
            if ((event as PageTransitionEvent).persisted) {
                handler();
            }
        }),
        onVisibilityChange: handler => {
            if (typeof document === 'undefined') {
                return () => undefined;
            }

            const listener = (): void => handler(isHidden());
            document.addEventListener('visibilitychange', listener);

            return () => document.removeEventListener('visibilitychange', listener);
        },
        isHidden,
        sessionStore: {
            read: key => sessionStorage.getItem(key),
            write: (key, value) => sessionStorage.setItem(key, value),
        },
    };
}

function isHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// The relay connection hears about a socket's end once, whether it failed to open or closed later,
// and not at all when it closed the socket itself.
export function openWebSocket(url: string, handlers: RelaySocketHandlers): RelaySocket {
    const socket = new WebSocket(url);
    let isEnded = false;
    const end = (): void => {
        if (!isEnded) {
            isEnded = true;
            handlers.onClose();
        }
    };
    socket.addEventListener('open', () => handlers.onOpen());
    socket.addEventListener('message', event => handlers.onMessage(event.data));
    socket.addEventListener('error', end);
    socket.addEventListener('close', end);

    return {
        send: text => socket.send(text),
        close: () => {
            isEnded = true;
            socket.close();
        },
    };
}

function listenToWindow(type: string, handler: (event: Event) => void): Unsubscribe {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    window.addEventListener(type, handler);

    return () => window.removeEventListener(type, handler);
}
