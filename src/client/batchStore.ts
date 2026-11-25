import type { ClientStorage, StoredBatch } from './storage.js';

// Batch records change from the receiver's prompt, from finished files and from saving; one write at a time.

export interface BatchStore {
    getAsync(sessionId: string, batchId: string): Promise<StoredBatch | undefined>;
    updateAsync(
        sessionId: string,
        batchId: string,
        update: (batch: StoredBatch | undefined) => StoredBatch | undefined,
    ): Promise<StoredBatch | undefined>;
    cached(batchId: string): StoredBatch | undefined;
    forget(batchIds: readonly string[]): void;
    clear(): void;
}

export function createBatchStore(storage: ClientStorage): BatchStore {
    const cache = new Map<string, StoredBatch>();
    let chain: Promise<unknown> = Promise.resolve();

    const getAsync = async (sessionId: string, batchId: string): Promise<StoredBatch | undefined> => {
        const cached = cache.get(batchId);
        if (cached?.sessionId === sessionId) {
            return cached;
        }

        const stored = await storage.getBatchAsync(sessionId, batchId);
        if (stored) {
            cache.set(batchId, stored);
        }

        return stored;
    };

    return {
        getAsync,
        updateAsync: (sessionId, batchId, update) => {
            const next = chain.then(async () => {
                const current = await getAsync(sessionId, batchId);
                const updated = update(current);
                if (updated && updated !== current) {
                    await storage.putBatchAsync(updated);
                    cache.set(batchId, updated);
                }

                return updated;
            });
            chain = next.catch(() => undefined);

            return next;
        },
        cached: batchId => cache.get(batchId),
        forget: batchIds => {
            for (const batchId of batchIds) {
                cache.delete(batchId);
            }
        },
        clear: () => cache.clear(),
    };
}
