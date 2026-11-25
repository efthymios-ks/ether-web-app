import type { Logger } from '../core/logger.js';
import type { RelayAllowanceNotice } from './discoveryTypes.js';

// Ether's own relays run on Cloudflare's free plan, whose allowances reset at 00:00 UTC. After two failures in a
// row, the relay's status check says whether the allowance ran out; while it has, the relay is left alone (each
// attempt would spend the next day's requests) and checked every 10 minutes and right after the reset.
// A relay that doesn't serve this page's address (a dev tunnel, say) answers 'forbidden': it is left alone for
// the rest of the page's life, with no notice, and the public relays carry on.

export type RelayStatusAnswer = 'ok' | 'limit' | 'error' | 'forbidden' | 'unreachable';

export interface RelayAllowanceOptions {
    readonly ownUrls: readonly string[];
    readonly fetchAsync: (url: string, init: RequestInit) => Promise<Response>;
    readonly clock: {
        now(): number;
        wallClock(): number;
        setTimeout(handler: () => void, ms: number): unknown;
        clearTimeout(handle: unknown): void;
    };
    readonly logger: Logger;
    // True when another relay is connected or a STUN server answered lately.
    readonly isInternetWorking: (relayUrl: string) => boolean;
    readonly pauseRelay: (relayUrl: string) => void;
    readonly resumeRelay: (relayUrl: string) => void;
    readonly onChange: (notice: RelayAllowanceNotice | undefined) => void;
}

export interface RelayAllowanceMonitor {
    readonly notice: RelayAllowanceNotice | undefined;
    relayOpened(relayUrl: string): void;
    relayFailed(relayUrl: string): void;
    // Forgets every notice; the change is reported when one stood.
    stop(): void;
}

export const FAILURES_BEFORE_CHECK = 2;
export const RECHECK_MS = 10 * 60_000;
// The first check after the reset waits this long, so Cloudflare's clock has passed midnight too.
export const AFTER_RESET_MS = 60_000;
const STATUS_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60_000;

interface RelayWatch {
    failures: number;
    isChecking: boolean;
    isRefused: boolean;
    notice?: RelayAllowanceNotice;
    recheckTimer?: unknown;
}

export function createRelayAllowanceMonitor(options: RelayAllowanceOptions): RelayAllowanceMonitor {
    return new AllowanceMonitor(options);
}

// The status URL of a relay: https://<host>/status.
export function toStatusUrl(relayUrl: string): string {
    const url = new URL(relayUrl);
    url.protocol = 'https:';
    url.pathname = '/status';
    url.search = '';
    url.hash = '';

    return url.toString();
}

// The next 00:00 UTC after this moment, in epoch milliseconds.
export function nextUtcMidnight(wallClock: number): number {
    return (Math.floor(wallClock / DAY_MS) + 1) * DAY_MS;
}

class AllowanceMonitor implements RelayAllowanceMonitor {
    private readonly options: RelayAllowanceOptions;
    private readonly logger: Logger;
    private readonly watches = new Map<string, RelayWatch>();
    private generation = 0;
    private shownNotice?: RelayAllowanceNotice;

    constructor(options: RelayAllowanceOptions) {
        this.options = options;
        this.logger = options.logger;
    }

    get notice(): RelayAllowanceNotice | undefined {
        return this.shownNotice;
    }

    relayOpened(relayUrl: string): void {
        const watch = this.watches.get(relayUrl);
        if (watch == null) {
            return;
        }

        watch.failures = 0;
        if (watch.notice != null) {
            this.logger.info('nearby', `own relay ${relayUrl} connected again; allowance notice cleared`);
            this.clearNotice(relayUrl, watch);
        }
    }

    relayFailed(relayUrl: string): void {
        if (!this.options.ownUrls.includes(relayUrl)) {
            return;
        }

        const watch = this.watchOf(relayUrl);
        watch.failures++;
        const canCheck = watch.notice == null && !watch.isChecking && !watch.isRefused;
        if (watch.failures >= FAILURES_BEFORE_CHECK && canCheck) {
            void this.checkAsync(relayUrl, watch);
        }
    }

    stop(): void {
        this.generation++;
        for (const watch of this.watches.values()) {
            this.options.clock.clearTimeout(watch.recheckTimer);
        }

        this.watches.clear();
        this.publish();
    }

    private watchOf(relayUrl: string): RelayWatch {
        const existing = this.watches.get(relayUrl);
        if (existing != null) {
            return existing;
        }

        const watch: RelayWatch = { failures: 0, isChecking: false, isRefused: false };
        this.watches.set(relayUrl, watch);

        return watch;
    }

    private async checkAsync(relayUrl: string, watch: RelayWatch): Promise<void> {
        const generation = this.generation;
        watch.isChecking = true;
        const answer = await this.fetchStatusAsync(relayUrl);
        if (generation !== this.generation) {
            return;
        }

        watch.isChecking = false;
        this.apply(relayUrl, watch, answer);
        if (watch.notice != null) {
            this.scheduleRecheck(relayUrl, watch, watch.notice);
        }
    }

    private apply(relayUrl: string, watch: RelayWatch, answer: RelayStatusAnswer): void {
        if (answer === 'ok') {
            this.logger.info('nearby', `own relay ${relayUrl} status ok; its failures were passing ones`);
            watch.failures = 0;
            if (watch.notice != null) {
                this.clearNotice(relayUrl, watch);
            }

            return;
        }

        if (answer === 'limit') {
            this.raiseNotice(relayUrl, watch, true);
            return;
        }

        if (answer === 'error') {
            this.logger.warn('nearby', `own relay ${relayUrl} status error: not its allowance`);
            return;
        }

        if (answer === 'forbidden') {
            this.logger.info('nearby', `own relay ${relayUrl} refuses this page's address; public relays carry on`);
            watch.isRefused = true;
            this.options.pauseRelay(relayUrl);
            return;
        }

        if (!this.options.isInternetWorking(relayUrl)) {
            this.logger.info('nearby', `own relay ${relayUrl} gave no status, and the internet seems down`);
            return;
        }

        this.raiseNotice(relayUrl, watch, false);
    }

    // Any 2xx is ok: the Worker and its Durable Object answered, so both are within their allowances.
    private async fetchStatusAsync(relayUrl: string): Promise<RelayStatusAnswer> {
        const controller = new AbortController();
        const timer = this.options.clock.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
        try {
            const response = await this.options.fetchAsync(toStatusUrl(relayUrl), {
                cache: 'no-store',
                credentials: 'omit',
                signal: controller.signal,
            });
            if (response.ok) {
                return 'ok';
            }

            const body = await readJsonAsync(response);
            if (response.status === 503 && body?.status === 'limit') {
                return 'limit';
            }

            if (response.status === 403 && body?.status === 'forbidden') {
                return 'forbidden';
            }

            this.logger.debug('nearby', `own relay ${relayUrl} status ${response.status}`);

            return 'error';
        } catch (error) {
            this.logger.debug('nearby', `own relay ${relayUrl} status check got no readable answer`, { error });

            return 'unreachable';
        } finally {
            this.options.clock.clearTimeout(timer);
        }
    }

    private raiseNotice(relayUrl: string, watch: RelayWatch, isCertain: boolean): void {
        const resetsAt = nextUtcMidnight(this.options.clock.wallClock());
        const previous = watch.notice;
        if (previous?.isCertain === isCertain && previous.resetsAt === resetsAt) {
            return;
        }

        watch.notice = { relayUrl, isCertain, resetsAt };
        const certainty = isCertain ? 'its status says so' : 'no readable answer while the internet works';
        this.logger.warn('nearby', `own relay ${relayUrl} out of its free allowance (${certainty})`, {
            resetsAt: new Date(resetsAt).toISOString(),
        });
        if (previous == null) {
            this.options.pauseRelay(relayUrl);
        }

        this.publish();
    }

    private clearNotice(relayUrl: string, watch: RelayWatch): void {
        this.options.clock.clearTimeout(watch.recheckTimer);
        watch.recheckTimer = undefined;
        watch.notice = undefined;
        watch.failures = 0;
        this.options.resumeRelay(relayUrl);
        this.publish();
    }

    // Every 10 minutes, and a minute after the reset if that comes first.
    private scheduleRecheck(relayUrl: string, watch: RelayWatch, notice: RelayAllowanceNotice): void {
        this.options.clock.clearTimeout(watch.recheckTimer);
        const untilReset = notice.resetsAt - this.options.clock.wallClock() + AFTER_RESET_MS;
        const delayMs = Math.max(0, Math.min(RECHECK_MS, untilReset));
        watch.recheckTimer = this.options.clock.setTimeout(() => {
            watch.recheckTimer = undefined;
            if (!watch.isChecking) {
                void this.checkAsync(relayUrl, watch);
            }
        }, delayMs);
    }

    // The first own relay with a notice is the one shown; only a change is reported.
    private publish(): void {
        const notice = this.options.ownUrls
            .map(url => this.watches.get(url)?.notice)
            .find(candidate => candidate != null);
        const previous = this.shownNotice;
        const isSame = previous?.relayUrl === notice?.relayUrl
            && previous?.isCertain === notice?.isCertain
            && previous?.resetsAt === notice?.resetsAt;
        if (isSame) {
            return;
        }

        this.shownNotice = notice;
        if (notice == null) {
            this.logger.info('nearby', 'no own relay is out of its allowance');
        }

        this.options.onChange(notice);
    }
}

async function readJsonAsync(response: Response): Promise<{ readonly status?: unknown } | undefined> {
    try {
        const value: unknown = await response.json();

        return value != null && typeof value === 'object' ? value : undefined;
    } catch {
        return undefined;
    }
}
