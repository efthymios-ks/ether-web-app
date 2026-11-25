// Live transfer rate for the time-left estimate (TR-10). Fed with the position of a transfer
// (bytes that have crossed the link) a couple of times a second, so the estimate keeps moving
// between pages, also on a slow link where one page takes longer than a few seconds.
// The first seconds use the plain average since the start. After that, each movement updates a
// moving average with the bytes it moved over the time since the movement before, so a slow link
// that delivers whole chunks every few seconds still reads at its real rate. While nothing moves for
// longer than a step usually takes, the rate shown falls with the wait, so the time left grows.

export interface RateEstimatorOptions {
    // Until this long after the first sample, the rate is the average since the start.
    readonly warmupMs?: number;
    // Time constant of the moving average.
    readonly smoothingMs?: number;
    // No movement for this long counts as stalled, or longer when steps are rare on a slow link.
    readonly stallMs?: number;
}

export interface RateEstimator {
    // Records the position at a moment; a position below the last one counts as no movement.
    record(position: number, now: number): void;
    bytesPerSecondAt(now: number): number;
    // True once nothing has moved for a while after something did.
    isStalled(now: number): boolean;
}

const DEFAULT_WARMUP_MS = 3000;
const DEFAULT_SMOOTHING_MS = 5000;
const DEFAULT_STALL_MS = 10_000;
// Chunks arrive whole, so on a slow link movement comes in steps; allow this many missed steps.
const STALL_STEPS = 3;

interface Point {
    readonly time: number;
    readonly position: number;
}

export function createRateEstimator(options: RateEstimatorOptions = {}): RateEstimator {
    const warmupMs = options.warmupMs ?? DEFAULT_WARMUP_MS;
    const smoothingMs = options.smoothingMs ?? DEFAULT_SMOOTHING_MS;
    const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    let start: Point | undefined;
    let lastMove: Point | undefined;
    let hasMoved = false;
    let lastStepBytes = 0;
    let rate = 0;

    // How long one step of the last size takes at the current rate.
    const stepMs = (): number => (rate > 0 ? (lastStepBytes * 1000) / rate : 0);

    return {
        record: (position, now) => {
            if (!start || !lastMove) {
                start = { time: now, position };
                lastMove = start;

                return;
            }

            const moved = position - lastMove.position;
            const interval = now - lastMove.time;
            if (moved <= 0 || interval <= 0) {
                return;
            }

            const elapsed = now - start.time;
            if (elapsed < warmupMs || !hasMoved) {
                rate = ((position - start.position) * 1000) / elapsed;
            } else {
                const instant = (moved * 1000) / interval;
                const weight = 1 - Math.exp(-interval / smoothingMs);
                rate += weight * (instant - rate);
            }

            hasMoved = true;
            lastStepBytes = moved;
            lastMove = { time: now, position };
        },
        bytesPerSecondAt: now => {
            if (!lastMove || !hasMoved) {
                return 0;
            }

            const waited = now - lastMove.time;
            if (waited <= stepMs()) {
                return rate;
            }

            return Math.min(rate, (lastStepBytes * 1000) / waited);
        },
        isStalled: now => {
            if (!lastMove || !hasMoved) {
                return false;
            }

            return now - lastMove.time > Math.max(stallMs, STALL_STEPS * stepMs());
        },
    };
}

// Seconds until `remaining` bytes are done at this rate; undefined while there is no rate yet.
export function secondsLeftAt(remaining: number, bytesPerSecond: number): number | undefined {
    if (remaining <= 0) {
        return 0;
    }

    return bytesPerSecond > 0 ? remaining / bytesPerSecond : undefined;
}
