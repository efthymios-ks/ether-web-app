import type { Logger } from '../../core/logger.js';
import type { InstallMethod, Platform } from '../../platform/platform.js';

// Chromium's install prompt event; not in the DOM typings.
export interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed'; readonly platform?: string }>;
}

export interface InstallController {
    readonly method: InstallMethod;
    // True once the browser offered its install prompt (Android and desktop Chromium).
    readonly canPrompt: boolean;
    promptAsync(): Promise<boolean>;
    steps(): readonly string[];
    on(name: 'change', handler: () => void): () => void;
}

export interface InstallControllerOptions {
    readonly platform: Platform;
    readonly logger: Logger;
    // The window, or a stand-in in tests.
    readonly target?: EventTarget;
}

// PW-05: Android keeps the browser's prompt for a custom button; iPhone has no prompt API, only steps.
export function createInstallController(options: InstallControllerOptions): InstallController {
    const { platform, logger } = options;
    const target = options.target ?? globalThis;
    const handlers = new Set<() => void>();
    let deferred: BeforeInstallPromptEvent | undefined;
    let isInstalled = platform.info.installed;

    const notify = (): void => {
        for (const handler of [...handlers]) {
            handler();
        }
    };

    target.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferred = event as BeforeInstallPromptEvent;
        logger.info('app', 'install prompt available');
        notify();
    });

    target.addEventListener('appinstalled', () => {
        deferred = undefined;
        isInstalled = true;
        logger.info('app', 'app installed');
        notify();
    });

    return {
        get method() {
            return isInstalled ? 'none' : platform.installMethod();
        },
        get canPrompt() {
            return deferred != null && !isInstalled;
        },
        promptAsync: async () => {
            const event = deferred;
            if (event == null) {
                return false;
            }

            // The browser allows one prompt per event.
            deferred = undefined;
            try {
                await event.prompt();
                const choice = await event.userChoice;
                logger.info('app', `install prompt ${choice.outcome}`);

                return choice.outcome === 'accepted';
            } catch (error) {
                logger.warn('app', 'install prompt failed', error);

                return false;
            } finally {
                notify();
            }
        },
        steps: () => platform.installSteps(),
        on: (_, handler) => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
    };
}
