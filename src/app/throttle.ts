// Runs `task` at most once per `intervalMs`, after the first request in each window (TR-10: ≤ 10 redraws a second).

export interface Throttle {
    schedule(): void;
    // Runs a pending task now.
    flush(): void;
    cancel(): void;
}

export function createThrottle(task: () => void, intervalMs: number): Throttle {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = (): void => {
        timer = undefined;
        task();
    };

    return {
        schedule: () => {
            timer ??= setTimeout(run, intervalMs);
        },
        flush: () => {
            if (timer == null) {
                return;
            }

            clearTimeout(timer);
            run();
        },
        cancel: () => {
            if (timer != null) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
}

// Waits until calls stop for `delayMs`, then runs once.
export function createDebounce(task: () => void, delayMs: number): Throttle {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = (): void => {
        timer = undefined;
        task();
    };

    return {
        schedule: () => {
            if (timer != null) {
                clearTimeout(timer);
            }

            timer = setTimeout(run, delayMs);
        },
        flush: () => {
            if (timer == null) {
                return;
            }

            clearTimeout(timer);
            run();
        },
        cancel: () => {
            if (timer != null) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
}
