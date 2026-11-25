// The one IndexedDB database, `ether` (PW-00). Never rename it or its stores: history lives here.

export const DATABASE_NAME = 'ether';
export const DATABASE_VERSION = 1;

export const STORE = Object.freeze({
    settings: 'settings',
    sessions: 'sessions',
    files: 'files',
    pages: 'pages',
    batches: 'batches',
    thumbs: 'thumbs',
    logs: 'logs',
});

export type StoreName = (typeof STORE)[keyof typeof STORE];

export const INDEX = Object.freeze({
    filesBySession: 'bySession',
    filesByFileId: 'byFileId',
    filesBySessionState: 'bySessionState',
    pagesByFile: 'byFile',
    batchesBySession: 'bySession',
    logsByRun: 'byRun',
});

interface Migration {
    readonly version: number;
    apply(database: IDBDatabase): void;
}

// Each entry upgrades from the version before it; append new ones, never edit old ones.
const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        apply: database => {
            // Out-of-line keys: 'device' holds deviceId, 'settings' the settings record.
            database.createObjectStore(STORE.settings);
            database.createObjectStore(STORE.sessions, { keyPath: 'sessionId' });

            const files = database.createObjectStore(STORE.files, { keyPath: ['sessionId', 'fileId', 'direction'] });
            files.createIndex(INDEX.filesBySession, 'sessionId');
            files.createIndex(INDEX.filesByFileId, 'fileId');
            files.createIndex(INDEX.filesBySessionState, ['sessionId', 'state']);

            const pages = database.createObjectStore(STORE.pages, { keyPath: ['sessionId', 'fileId', 'pageIndex'] });
            pages.createIndex(INDEX.pagesByFile, ['sessionId', 'fileId']);

            const batches = database.createObjectStore(STORE.batches, { keyPath: ['sessionId', 'batchId'] });
            batches.createIndex(INDEX.batchesBySession, 'sessionId');

            database.createObjectStore(STORE.thumbs, { keyPath: ['sessionId', 'fileId'] });

            const logs = database.createObjectStore(STORE.logs, { autoIncrement: true });
            logs.createIndex(INDEX.logsByRun, 'runId');
        },
    },
];

export function openDatabaseAsync(
    factory: IDBFactory = indexedDB,
    name: string = DATABASE_NAME,
): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(name, DATABASE_VERSION);

        request.onupgradeneeded = event => {
            const database = request.result;
            for (const migration of MIGRATIONS) {
                if (migration.version > event.oldVersion) {
                    migration.apply(database);
                }
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            // Another tab with a newer version asks to upgrade: let it.
            database.onversionchange = () => database.close();
            resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
}

export function requestAsync<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

export function transactionDoneAsync(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'));
    });
}

export function isQuotaExceeded(error: unknown): boolean {
    return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}
