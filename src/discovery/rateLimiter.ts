// A token bucket per key, so one flooding sender can't crowd out the rest of the room.
// Keys beyond `maxKeys` evict the oldest, so a flood of new keys can't grow the map either.

export interface RateLimiterOptions {
    readonly burst: number;
    // One token comes back every `refillMs`.
    readonly refillMs: number;
    readonly maxKeys: number;
    readonly now: () => number;
}

export interface RateLimiter {
    // True when the key may go ahead; takes a token.
    take(key: string): boolean;
    clear(): void;
}

interface Bucket {
    tokens: number;
    updatedAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
    const buckets = new Map<string, Bucket>();

    const take = (key: string): boolean => {
        const now = options.now();
        const bucket = buckets.get(key) ?? { tokens: options.burst, updatedAt: now };
        const refilled = Math.floor((now - bucket.updatedAt) / options.refillMs);
        if (refilled > 0) {
            bucket.tokens = Math.min(options.burst, bucket.tokens + refilled);
            bucket.updatedAt += refilled * options.refillMs;
        }

        if (bucket.tokens >= options.burst) {
            bucket.updatedAt = now;
        }

        buckets.delete(key);
        buckets.set(key, bucket);
        evictOldest(buckets, options.maxKeys);
        if (bucket.tokens <= 0) {
            return false;
        }

        bucket.tokens--;

        return true;
    };

    return { take, clear: () => buckets.clear() };
}

function evictOldest(buckets: Map<string, Bucket>, maxKeys: number): void {
    while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest == null) {
            return;
        }

        buckets.delete(oldest);
    }
}
