import type { Logger } from '../../core/logger.js';

export interface ServiceWorkerHandle {
    // The build version the controlling worker reported, once it answered.
    getVersion(): string | undefined;
    // PW-03: called when a new version is installed and waiting; returns unsubscribe.
    onUpdateReady(handler: () => void): () => void;
    // Activates the waiting worker and reloads once it takes over.
    // The shell calls it only when no transfer runs.
    applyUpdate(): void;
}

// The parts of the browser this module uses, so tests can pass fakes.
export interface ServiceWorkerEnvironment {
    readonly container?: ServiceWorkerContainer;
    readonly isSecureContext: boolean;
    reload(): void;
}

export interface RegisterServiceWorkerOptions {
    readonly logger: Logger;
    readonly environment?: ServiceWorkerEnvironment;
    readonly scriptUrl?: string;
}

// The messages src/sw/serviceWorker.ts understands.
export const SERVICE_WORKER_MESSAGES = Object.freeze({
    skipWaiting: 'skip-waiting',
    version: 'version',
});

export function registerServiceWorker(options: RegisterServiceWorkerOptions): ServiceWorkerHandle {
    const { logger } = options;
    const environment = options.environment ?? browserEnvironment();
    const container = environment.container;
    const handlers = new Set<() => void>();
    let version: string | undefined;
    let registration: ServiceWorkerRegistration | undefined;
    let isUpdateReady = false;
    let isReloading = false;
    let isUpdateRequested = false;

    const handle: ServiceWorkerHandle = {
        getVersion: () => version,
        onUpdateReady: handler => {
            handlers.add(handler);
            if (isUpdateReady) {
                handler();
            }

            return () => {
                handlers.delete(handler);
            };
        },
        applyUpdate: () => {
            const waiting = registration?.waiting;
            if (waiting == null) {
                logger.debug('sw', 'no update waiting');

                return;
            }

            isUpdateRequested = true;
            logger.info('sw', 'applying update');
            waiting.postMessage({ type: SERVICE_WORKER_MESSAGES.skipWaiting });
        },
    };

    // PW-02 needs a secure page; plain http on a LAN address, or an old browser, runs without offline support.
    if (container == null || !environment.isSecureContext) {
        logger.info('sw', 'service worker unavailable; offline use is off', {
            supported: container != null,
            secure: environment.isSecureContext,
        });

        return handle;
    }

    const announceUpdate = (): void => {
        if (isUpdateReady) {
            return;
        }

        isUpdateReady = true;
        logger.info('sw', 'update waiting');
        for (const handler of [...handlers]) {
            handler();
        }
    };

    const askVersion = (worker: ServiceWorker | null | undefined): void => {
        if (worker == null) {
            return;
        }

        const channel = new MessageChannel();
        channel.port1.onmessage = event => {
            const data = event.data as { type?: string; version?: unknown } | undefined;
            if (data?.type === SERVICE_WORKER_MESSAGES.version && typeof data.version === 'string') {
                version = data.version;
                channel.port1.close();
            }
        };
        worker.postMessage({ type: SERVICE_WORKER_MESSAGES.version }, [channel.port2]);
    };

    const watchInstalling = (worker: ServiceWorker): void => {
        worker.addEventListener('statechange', () => {
            if (worker.state === 'installed') {
                if (container.controller != null) {
                    announceUpdate();
                } else {
                    logger.info('sw', 'installed; the app now works offline');
                }
            }

            if (worker.state === 'activated') {
                logger.info('sw', 'activated');
            }

            if (worker.state === 'redundant') {
                logger.warn('sw', 'install failed; the worker became redundant');
            }
        });
    };

    container.addEventListener('controllerchange', () => {
        version = undefined;
        askVersion(container.controller);
        // PW-03: reload once, and only for an update the user asked for.
        if (isUpdateRequested && !isReloading) {
            isReloading = true;
            logger.info('sw', 'new version active; reloading');
            environment.reload();
        }
    });

    const registerAsync = async (): Promise<void> => {
        try {
            registration = await container.register(options.scriptUrl ?? './sw.js', { scope: './' });
            logger.info('sw', 'registered', { scope: registration.scope });
        } catch (error) {
            logger.warn('sw', 'registration failed', error);

            return;
        }

        askVersion(container.controller ?? registration.active);
        if (registration.waiting != null && container.controller != null) {
            announceUpdate();
        }

        if (registration.installing != null) {
            watchInstalling(registration.installing);
        }

        registration.addEventListener('updatefound', () => {
            const installing = registration?.installing;
            if (installing != null) {
                logger.info('sw', 'update found; installing');
                watchInstalling(installing);
            }
        });
    };

    void registerAsync();

    return handle;
}

function browserEnvironment(): ServiceWorkerEnvironment {
    const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

    return {
        ...(hasServiceWorker ? { container: navigator.serviceWorker } : {}),
        isSecureContext: globalThis.isSecureContext === true,
        reload: () => window.location.reload(),
    };
}
