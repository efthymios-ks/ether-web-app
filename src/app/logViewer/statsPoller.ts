import type { Diagnostics } from '../../client/clientTypes.js';

export interface StatsPoller {
    // Starts polling, or restarts it with the current interval.
    start(): void;
    stop(): void;
    readonly isRunning: boolean;
}

export interface StatsPollerOptions {
    getDiagnosticsAsync(): Promise<Diagnostics>;
    intervalMs(): number;
    onResult(diagnostics: Diagnostics): void;
    onError?(error: unknown): void;
    readonly setTimer?: (callback: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

// DL-06, DL-11: one getDiagnosticsAsync() at a time, the next one an interval after the last answer.
export function createStatsPoller(options: StatsPollerOptions): StatsPoller {
    const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    const clearTimer = options.clearTimer ?? (handle => globalThis.clearTimeout(handle as number));
    let timer: unknown;
    let generation = 0;
    let isRunning = false;

    const tickAsync = async (current: number): Promise<void> => {
        timer = undefined;
        try {
            const diagnostics = await options.getDiagnosticsAsync();
            if (current === generation) {
                options.onResult(diagnostics);
            }
        } catch (error) {
            if (current === generation) {
                options.onError?.(error);
            }
        }

        if (current === generation && isRunning) {
            timer = setTimer(() => void tickAsync(current), options.intervalMs());
        }
    };

    const stop = (): void => {
        generation++;
        isRunning = false;
        if (timer != null) {
            clearTimer(timer);
            timer = undefined;
        }
    };

    return {
        get isRunning() {
            return isRunning;
        },
        start: () => {
            stop();
            isRunning = true;
            void tickAsync(generation);
        },
        stop,
    };
}
