import { INDEX, STORE, requestAsync, transactionDoneAsync } from './database.js';
import type { LogEntry, LogSink } from './logger.js';

interface StoredLogEntry extends LogEntry {
    readonly runId: string;
}

export interface DatabaseSink extends LogSink {
    readonly name: 'indexeddb';
    // Writes the queue now; the sink also does it once a second.
    flushAsync(): Promise<void>;
    // DL-12: the last entries of the page load before this one.
    readPreviousRunAsync(): Promise<LogEntry[]>;
    clearAsync(): Promise<void>;
    // "Keep previous run" (16.3): entries kept per run from the next flush on.
    setLimit(limit: number): void;
}

export interface DatabaseSinkOptions {
    readonly database: IDBDatabase;
    readonly runId: string;
    // Entries kept per run.
    readonly limit?: number;
    readonly flushIntervalMs?: number;
    readonly setInterval?: (handler: () => void, ms: number) => unknown;
    readonly clearInterval?: (handle: unknown) => void;
}

export function createDatabaseSink(options: DatabaseSinkOptions): DatabaseSink {
    const { database, runId } = options;
    let limit = options.limit ?? 1000;
    const startTimer = options.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms));
    const stopTimer = options.clearInterval ?? (handle => globalThis.clearInterval(handle as number));
    let queue: StoredLogEntry[] = [];
    let previousRun: Promise<LogEntry[]> | undefined;
    let writing = false;

    const flushAsync = async (): Promise<void> => {
        if (writing || queue.length === 0) {
            return;
        }

        writing = true;
        const pending = queue.slice(-limit);
        queue = [];

        try {
            const transaction = database.transaction(STORE.logs, 'readwrite');
            const store = transaction.objectStore(STORE.logs);
            for (const entry of pending) {
                store.add(entry);
            }

            await transactionDoneAsync(transaction);
            await trimRunAsync(database, runId, limit);
        } catch {
            // LG-07: a full database drops the oldest entries rather than failing the app.
            await trimRunAsync(database, runId, Math.floor(limit / 2)).catch(() => undefined);
        } finally {
            writing = false;
        }
    };

    const timer = startTimer(() => {
        void flushAsync();
    }, options.flushIntervalMs ?? 1000);

    return {
        name: 'indexeddb',
        write: entry => {
            queue.push({ ...entry, runId });
            if (queue.length > limit) {
                queue.splice(0, queue.length - limit);
            }
        },
        flushAsync,
        readPreviousRunAsync: () => {
            previousRun ??= readAndPruneAsync(database, runId);

            return previousRun;
        },
        clearAsync: async () => {
            queue = [];
            const transaction = database.transaction(STORE.logs, 'readwrite');
            transaction.objectStore(STORE.logs).clear();
            await transactionDoneAsync(transaction);
        },
        setLimit: next => {
            limit = Math.max(1, Math.floor(next));
        },
        dispose: () => {
            stopTimer(timer);
            void flushAsync();
        },
    };
}

// Keeps only the newest run before this one, and returns its entries.
async function readAndPruneAsync(database: IDBDatabase, runId: string): Promise<LogEntry[]> {
    const transaction = database.transaction(STORE.logs, 'readwrite');
    const store = transaction.objectStore(STORE.logs);
    const all = (await requestAsync(store.getAll())) as StoredLogEntry[];
    const keys = await requestAsync(store.getAllKeys());
    const previousRunId = [...all].reverse().find(entry => entry.runId !== runId)?.runId;

    all.forEach((entry, index) => {
        const key = keys[index];
        if (key != null && entry.runId !== runId && entry.runId !== previousRunId) {
            store.delete(key);
        }
    });

    await transactionDoneAsync(transaction);

    return all
        .filter(entry => entry.runId === previousRunId)
        .map(({ runId: _, ...entry }) => entry);
}

async function trimRunAsync(database: IDBDatabase, runId: string, limit: number): Promise<void> {
    const transaction = database.transaction(STORE.logs, 'readwrite');
    const index = transaction.objectStore(STORE.logs).index(INDEX.logsByRun);
    const keys = await requestAsync(index.getAllKeys(IDBKeyRange.only(runId)));
    const excess = keys.length - limit;
    const store = transaction.objectStore(STORE.logs);

    for (const key of keys.slice(0, Math.max(0, excess))) {
        store.delete(key);
    }

    await transactionDoneAsync(transaction);
}
