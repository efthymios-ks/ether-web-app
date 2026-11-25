import type { Logger } from '../../core/logger.js';

// WL-01, WL-02: hold the screen on while a transfer runs or a QR is shown (and, by setting, while connected);
// the browser drops the lock when the page hides, so take it again when it comes back.

export type WakeReason = 'transfer' | 'qr' | 'connected';

interface WakeLockSentinelLike extends EventTarget {
    readonly released: boolean;
    release(): Promise<void>;
}

interface WakeLockLike {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLockOptions {
    readonly logger: Logger;
    readonly wakeLock?: WakeLockLike;
    readonly document?: Document;
}

export interface WakeLockController {
    readonly isSupported: boolean;
    readonly isHeld: boolean;
    // True while any reason asks for the screen to stay on.
    readonly isWanted: boolean;
    set(reason: WakeReason, isOn: boolean): void;
    onChange(handler: () => void): () => void;
    dispose(): void;
}

export function createWakeLock(options: WakeLockOptions): WakeLockController {
    const { logger } = options;
    const doc = options.document ?? document;
    const api = options.wakeLock ?? (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    const reasons = new Set<WakeReason>();
    const handlers = new Set<() => void>();
    let sentinel: WakeLockSentinelLike | undefined;
    let requesting = false;

    const notify = (): void => {
        for (const handler of handlers) {
            handler();
        }
    };

    const acquireAsync = async (): Promise<void> => {
        if (api == null || requesting || sentinel != null || reasons.size === 0 || doc.visibilityState !== 'visible') {
            return;
        }

        requesting = true;
        try {
            const acquired = await api.request('screen');
            if (reasons.size === 0) {
                await acquired.release();

                return;
            }

            sentinel = acquired;
            acquired.addEventListener('release', () => {
                if (sentinel === acquired) {
                    sentinel = undefined;
                    logger.info('wake', 'wake lock released by the browser');
                    notify();
                }
            });
            logger.info('wake', 'wake lock acquired', { reasons: [...reasons] });
            notify();
        } catch (error) {
            logger.warn('wake', 'wake lock request failed', { error });
        } finally {
            requesting = false;
        }
    };

    const releaseAsync = async (): Promise<void> => {
        const current = sentinel;
        if (current == null) {
            return;
        }

        sentinel = undefined;
        try {
            await current.release();
            logger.info('wake', 'wake lock released');
        } catch (error) {
            logger.warn('wake', 'wake lock release failed', { error });
        }

        notify();
    };

    const onVisibility = (): void => {
        if (doc.visibilityState === 'visible' && reasons.size > 0) {
            logger.info('wake', 'page visible again, re-acquiring the wake lock');
            void acquireAsync();
        }
    };

    doc.addEventListener('visibilitychange', onVisibility);
    if (api == null) {
        logger.info('wake', 'wake lock unsupported');
    }

    return {
        get isSupported() {
            return api != null;
        },
        get isHeld() {
            return sentinel != null;
        },
        get isWanted() {
            return reasons.size > 0;
        },
        set: (reason, isOn) => {
            const wasWanted = reasons.size > 0;
            if (isOn) {
                reasons.add(reason);
            } else {
                reasons.delete(reason);
            }

            if (reasons.size > 0) {
                void acquireAsync();
            } else {
                void releaseAsync();
            }

            if (wasWanted !== reasons.size > 0) {
                notify();
            }
        },
        onChange: handler => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
        dispose: () => {
            doc.removeEventListener('visibilitychange', onVisibility);
            reasons.clear();
            handlers.clear();
            void releaseAsync();
        },
    };
}
