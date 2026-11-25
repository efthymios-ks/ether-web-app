import type { Logger } from '../../core/logger.js';
import type { CameraSession } from '../appContext.js';

// One camera for the whole page. iOS allows one capture session at a time, so the hook that exposes
// local IPs (HS-05, NW-06) reuses the scanner's camera instead of opening a second one.

export interface CameraLease {
    readonly session: CameraSession;
    release(): void;
}

export interface CameraHub {
    readonly isOpen: boolean;
    acquireAsync(constraints: MediaTrackConstraints): Promise<CameraLease>;
    // Holds the open camera for one more user and returns its release, or null when none is open.
    retainOpen(): (() => void) | null;
    dispose(): void;
}

export interface CameraHubOptions {
    readonly openCameraAsync: (constraints: MediaTrackConstraints) => Promise<CameraSession>;
    readonly logger: Logger;
}

export function createCameraHub(options: CameraHubOptions): CameraHub {
    let current: { session: CameraSession; holders: number } | undefined;
    let opening: Promise<CameraSession> | undefined;

    const createRelease = (session: CameraSession): (() => void) => {
        let isReleased = false;

        return () => {
            if (isReleased || current?.session !== session) {
                return;
            }

            isReleased = true;
            current.holders--;
            if (current.holders <= 0) {
                current = undefined;
                session.stop();
                options.logger.debug('pair', 'camera closed');
            }
        };
    };

    return {
        get isOpen() {
            return current != null;
        },
        acquireAsync: async constraints => {
            if (current == null) {
                opening ??= options.openCameraAsync(constraints);
                try {
                    const session = await opening;
                    current ??= { session, holders: 0 };
                } finally {
                    opening = undefined;
                }
            }

            const active = current;
            if (active == null) {
                throw new Error('camera closed while opening');
            }

            active.holders++;

            return { session: active.session, release: createRelease(active.session) };
        },
        retainOpen: () => {
            if (current == null) {
                return null;
            }

            current.holders++;
            options.logger.debug('pair', 'reusing the open camera to expose local addresses');

            return createRelease(current.session);
        },
        dispose: () => {
            current?.session.stop();
            current = undefined;
        },
    };
}
