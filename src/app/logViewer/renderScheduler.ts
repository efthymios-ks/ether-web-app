export interface RenderScheduler {
    schedule(): void;
    cancel(): void;
    readonly isPending: boolean;
}

export interface RenderSchedulerOptions {
    render(): void;
    // DL-10: at most 10 renders a second.
    readonly minIntervalMs?: number;
    readonly requestFrame?: (callback: () => void) => number;
    readonly cancelFrame?: (handle: number) => void;
    readonly setTimer?: (callback: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
    readonly now?: () => number;
}

// Coalesces many log writes into one render on the next animation frame, spaced at least minIntervalMs apart.
export function createRenderScheduler(options: RenderSchedulerOptions): RenderScheduler {
    const minIntervalMs = options.minIntervalMs ?? 100;
    const requestFrame = options.requestFrame
        ?? (callback => globalThis.requestAnimationFrame(() => callback()));
    const cancelFrame = options.cancelFrame ?? (handle => globalThis.cancelAnimationFrame(handle));
    const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    const clearTimer = options.clearTimer ?? (handle => globalThis.clearTimeout(handle as number));
    const now = options.now ?? (() => performance.now());
    let lastRender = Number.NEGATIVE_INFINITY;
    let frame: number | undefined;
    let timer: unknown;
    let isPending = false;

    const run = (): void => {
        frame = undefined;
        isPending = false;
        lastRender = now();
        options.render();
    };

    return {
        get isPending() {
            return isPending;
        },
        schedule: () => {
            if (isPending) {
                return;
            }

            isPending = true;
            const wait = lastRender + minIntervalMs - now();
            if (wait <= 0) {
                frame = requestFrame(run);

                return;
            }

            timer = setTimer(() => {
                timer = undefined;
                frame = requestFrame(run);
            }, wait);
        },
        cancel: () => {
            if (frame != null) {
                cancelFrame(frame);
                frame = undefined;
            }

            if (timer != null) {
                clearTimer(timer);
                timer = undefined;
            }

            isPending = false;
        },
    };
}
