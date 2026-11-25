import { INDEX, STORE, requestAsync, transactionDoneAsync } from '../core/database.js';
import type { StoreName } from '../core/database.js';
import type { BatchBudget } from './batches.js';
import { UNFINISHED_STATES } from './clientTypes.js';
import type { BatchRecord, Direction, FileRecord, FileState, Pagination, SessionRecord } from './clientTypes.js';

// Every IndexedDB read and write of the client (CL-04), following the §7.2 write rules.

const DEVICE_KEY = 'device';
const SETTINGS_KEY = 'settings';
const DAY_MS = 24 * 60 * 60 * 1000;
const FINISHED_STATES: readonly FileState[] = Object.freeze(['done', 'failed', 'canceled']);
const BUSY_STATES: readonly FileState[] = Object.freeze(['offered', 'active', 'verifying']);

export interface StoredPagination extends Pagination {
    // Sender: hashes of acknowledged pages, 32 bytes each. The receiver keeps them in its page records.
    readonly pageHashes?: Uint8Array;
    // Receiver: CRC-32 of the saved pages so far (SV-04), left out once it is unknown (the ZIP then reads the pages).
    readonly crc32?: number;
    // Receiver: CRC-32 of the saved pages before the last one, for a resume that sends the last page again.
    readonly crc32Previous?: number;
}

export interface StoredFile extends Omit<FileRecord, 'pagination'> {
    readonly pagination?: StoredPagination;
    // Receiver: CRC-32 of the whole file, kept once it is done (SV-04).
    readonly crc32?: number;
    // Receiver: the page size rootHash was computed with, kept once it is done, so a sender can check its copy against it.
    readonly rootPageSize?: number;
    // The content and the name without the folder (the manifest's contentId), to find a file already here from another send.
    readonly contentId?: string;
}

export interface StoredPage {
    readonly sessionId: string;
    readonly fileId: string;
    readonly pageIndex: number;
    readonly data: Blob;
    readonly hash: Uint8Array;
}

export interface StoredThumb {
    readonly sessionId: string;
    readonly fileId: string;
    readonly data: Blob;
    readonly createdAt: number;
}

// Batches stored before `canceled` existed lack it; it reads as 0.
export interface StoredBatch extends Omit<BatchRecord, 'canceled'> {
    readonly canceled?: number;
    // The sizes of the files that ended received, or were already on the receiver, so a reload keeps them.
    readonly bytesDone?: number;
    // Receiver: the user's answer to the batch prompt and the bytes it still allows.
    readonly budget?: BatchBudget;
    // Receiver: made for files offered on their own, counting each member once.
    readonly singleOfferFileIds?: readonly string[];
}

export interface CleanupOptions {
    readonly now: number;
    readonly keepPartialDays: number;
    readonly keepHistoryDays: number;
    readonly keepHistoryPerSession: number;
}

export interface CleanupResult {
    readonly expiredPartials: number;
    readonly trimmedHistory: number;
}

export interface ClientStorage {
    readDeviceIdAsync(): Promise<string | undefined>;
    writeDeviceIdAsync(deviceId: string): Promise<void>;
    readSettingsAsync(): Promise<unknown>;
    writeSettingsAsync(settings: unknown): Promise<void>;

    getSessionAsync(sessionId: string): Promise<SessionRecord | undefined>;
    putSessionAsync(session: SessionRecord): Promise<void>;
    listSessionsAsync(): Promise<SessionRecord[]>;

    getFileAsync(sessionId: string, fileId: string, direction: Direction): Promise<StoredFile | undefined>;
    putFileAsync(file: StoredFile): Promise<void>;
    deleteFileAsync(sessionId: string, fileId: string, direction: Direction): Promise<void>;
    listFilesAsync(sessionId: string): Promise<StoredFile[]>;
    listFilesInStatesAsync(sessionId: string, states: readonly FileState[]): Promise<StoredFile[]>;
    findFilesByFileIdAsync(fileId: string): Promise<StoredFile[]>;
    countUnfinishedAsync(sessionId: string): Promise<number>;

    // §7.2: the page Blob and the updated file record in one transaction.
    writePageAsync(page: StoredPage, file: StoredFile): Promise<void>;
    readPagesAsync(sessionId: string, fileId: string): Promise<StoredPage[]>;
    // The file record and the removal of its pages from `fromPage` on, in one transaction.
    putFileDeletingPagesAsync(file: StoredFile, fromPage?: number): Promise<void>;
    // Reads the stored record and writes `patch(current)` in the same transaction, so a change never lands on an
    // older copy and never undoes a state written meanwhile. Undefined from `patch` writes nothing.
    // With `deletePages`, the file's pages go in that transaction too, only when the patch is written.
    patchFileAsync(
        sessionId: string,
        fileId: string,
        direction: Direction,
        patch: (current: StoredFile) => StoredFile | undefined,
        options?: { readonly deletePages?: boolean },
    ): Promise<StoredFile | undefined>;
    // §7.5: moves a partial and its pages into another session.
    movePartialAsync(from: StoredFile, to: StoredFile): Promise<void>;

    getBatchAsync(sessionId: string, batchId: string): Promise<StoredBatch | undefined>;
    putBatchAsync(batch: StoredBatch): Promise<void>;
    listBatchesAsync(sessionId: string): Promise<StoredBatch[]>;

    getThumbAsync(sessionId: string, fileId: string): Promise<StoredThumb | undefined>;
    putThumbAsync(thumb: StoredThumb): Promise<void>;
    deleteThumbAsync(sessionId: string, fileId: string): Promise<void>;

    cleanupAsync(options: CleanupOptions): Promise<CleanupResult>;
    clearSessionAsync(sessionId: string): Promise<void>;
    // One transaction: the file records (with the pages of received ones), thumbnails and batches of one session.
    removeSessionFilesAsync(
        sessionId: string,
        removal: { readonly files: readonly StoredFile[]; readonly thumbFileIds: readonly string[]; readonly batchIds: readonly string[] },
    ): Promise<void>;
    // Everything but the device ID and settings, logs included.
    clearAllAsync(): Promise<void>;

    // §16.3 "fill storage": page and thumbnail writes fail with QuotaExceededError while on.
    failDataWrites: boolean;
}

export function createQuotaError(): DOMException {
    return new DOMException('Storage full', 'QuotaExceededError');
}

function sessionRange(sessionId: string): IDBKeyRange {
    return IDBKeyRange.bound([sessionId], [sessionId, []]);
}

function pageRangeKey(sessionId: string, fileId: string, fromPage: number): IDBKeyRange {
    return IDBKeyRange.bound([sessionId, fileId, fromPage], [sessionId, fileId, Infinity]);
}

export function createClientStorage(database: IDBDatabase): ClientStorage {
    const readAsync = async <T>(store: StoreName, read: (objectStore: IDBObjectStore) => IDBRequest): Promise<T> => {
        const transaction = database.transaction(store, 'readonly');

        return (await requestAsync(read(transaction.objectStore(store)))) as T;
    };

    const writeAsync = async (stores: StoreName | StoreName[], write: (transaction: IDBTransaction) => void): Promise<void> => {
        const transaction = database.transaction(stores, 'readwrite');
        write(transaction);
        await transactionDoneAsync(transaction);
    };

    const throwIfFull = (): void => {
        if (storage.failDataWrites) {
            throw createQuotaError();
        }
    };

    const listFilesInStatesAsync = async (sessionId: string, states: readonly FileState[]): Promise<StoredFile[]> => {
        const transaction = database.transaction(STORE.files, 'readonly');
        const index = transaction.objectStore(STORE.files).index(INDEX.filesBySessionState);
        const lists = await Promise.all(states.map(state => requestAsync(index.getAll([sessionId, state]))));

        return (lists.flat() as StoredFile[]).sort((first, second) => first.queueIndex - second.queueIndex);
    };

    // Each record is read again in the deleting transaction; one that changed since the listing, or holds data, stays.
    const trimHistoryAsync = async (files: readonly StoredFile[]): Promise<number> => {
        if (files.length === 0) {
            return 0;
        }

        let trimmed = 0;
        await writeAsync([STORE.files, STORE.thumbs], transaction => {
            const store = transaction.objectStore(STORE.files);
            for (const file of files) {
                const request = store.get([file.sessionId, file.fileId, file.direction]);
                request.onsuccess = () => {
                    const current = request.result as StoredFile | undefined;
                    if (current == null || current.hasData || current.pagination != null || current.updatedAt !== file.updatedAt) {
                        return;
                    }

                    store.delete([file.sessionId, file.fileId, file.direction]);
                    transaction.objectStore(STORE.thumbs).delete([file.sessionId, file.fileId]);
                    trimmed += 1;
                };
            }
        });

        return trimmed;
    };

    const cleanupSessionAsync = async (sessionId: string, options: CleanupOptions): Promise<CleanupResult> => {
        const files = await storage.listFilesAsync(sessionId);
        const partialCutoff = options.now - options.keepPartialDays * DAY_MS;
        const expired = files.filter(file => (
            file.direction === 'in'
            && file.pagination != null
            && file.pagination.pagesDone > 0
            && !BUSY_STATES.includes(file.state)
            && file.updatedAt < partialCutoff
        ));

        // Each expiry is checked again on the stored record: a file resumed since the listing keeps its pages.
        let expiredPartials = 0;
        for (const file of expired) {
            const patched = await storage.patchFileAsync(file.sessionId, file.fileId, file.direction, current => {
                if (current.pagination == null || BUSY_STATES.includes(current.state) || current.updatedAt >= partialCutoff) {
                    return undefined;
                }

                const { pagination: _, ...rest } = current;

                return { ...rest, state: 'canceled', note: 'partial-expired', hasData: false, updatedAt: options.now };
            }, { deletePages: true });
            expiredPartials += patched ? 1 : 0;
        }

        // History never removes a file whose data is still in the app; only Delete and Clear do that.
        const historyCutoff = options.now - options.keepHistoryDays * DAY_MS;
        const finished = files
            .filter(file => FINISHED_STATES.includes(file.state) && file.pagination == null && !file.hasData)
            .sort((first, second) => (second.completedAt ?? second.updatedAt) - (first.completedAt ?? first.updatedAt));
        const trimmed = finished.filter((file, index) => (
            (file.completedAt ?? file.updatedAt) < historyCutoff || index >= options.keepHistoryPerSession
        ));
        const trimmedHistory = await trimHistoryAsync(trimmed);

        return { expiredPartials, trimmedHistory };
    };

    const storage: ClientStorage = {
        failDataWrites: false,

        readDeviceIdAsync: () => readAsync<string | undefined>(STORE.settings, store => store.get(DEVICE_KEY)),
        writeDeviceIdAsync: deviceId => writeAsync(STORE.settings, transaction => {
            transaction.objectStore(STORE.settings).put(deviceId, DEVICE_KEY);
        }),
        readSettingsAsync: () => readAsync<unknown>(STORE.settings, store => store.get(SETTINGS_KEY)),
        writeSettingsAsync: settings => writeAsync(STORE.settings, transaction => {
            transaction.objectStore(STORE.settings).put(settings, SETTINGS_KEY);
        }),

        getSessionAsync: sessionId => readAsync(STORE.sessions, store => store.get(sessionId)),
        putSessionAsync: session => writeAsync(STORE.sessions, transaction => {
            transaction.objectStore(STORE.sessions).put(session);
        }),
        listSessionsAsync: () => readAsync(STORE.sessions, store => store.getAll()),

        getFileAsync: (sessionId, fileId, direction) => readAsync(STORE.files, store => store.get([sessionId, fileId, direction])),
        putFileAsync: file => writeAsync(STORE.files, transaction => {
            transaction.objectStore(STORE.files).put(file);
        }),
        deleteFileAsync: (sessionId, fileId, direction) => writeAsync([STORE.files, STORE.pages], transaction => {
            transaction.objectStore(STORE.files).delete([sessionId, fileId, direction]);
            if (direction === 'in') {
                transaction.objectStore(STORE.pages).delete(pageRangeKey(sessionId, fileId, 0));
            }
        }),
        listFilesAsync: async sessionId => {
            const files = await readAsync<StoredFile[]>(STORE.files, store => store.index(INDEX.filesBySession).getAll(sessionId));

            return files.sort((first, second) => first.queueIndex - second.queueIndex);
        },
        listFilesInStatesAsync,
        findFilesByFileIdAsync: fileId => readAsync(STORE.files, store => store.index(INDEX.filesByFileId).getAll(fileId)),
        countUnfinishedAsync: async sessionId => {
            const transaction = database.transaction(STORE.files, 'readonly');
            const index = transaction.objectStore(STORE.files).index(INDEX.filesBySessionState);
            const counts = await Promise.all(UNFINISHED_STATES.map(state => requestAsync(index.count([sessionId, state]))));

            return counts.reduce((sum, count) => sum + count, 0);
        },

        writePageAsync: async (page, file) => {
            throwIfFull();
            await writeAsync([STORE.pages, STORE.files], transaction => {
                transaction.objectStore(STORE.pages).put(page);
                transaction.objectStore(STORE.files).put(file);
            });
        },
        readPagesAsync: async (sessionId, fileId) => {
            const pages = await readAsync<StoredPage[]>(STORE.pages, store => store.getAll(pageRangeKey(sessionId, fileId, 0)));

            return pages.sort((first, second) => first.pageIndex - second.pageIndex);
        },
        patchFileAsync: async (sessionId, fileId, direction, patch, patchOptions = {}) => {
            const transaction = database.transaction([STORE.files, STORE.pages], 'readwrite');
            const files = transaction.objectStore(STORE.files);
            const request = files.get([sessionId, fileId, direction]);
            let written: StoredFile | undefined;
            request.onsuccess = () => {
                const current = request.result as StoredFile | undefined;
                const next = current ? patch(current) : undefined;
                if (!next) {
                    return;
                }

                files.put(next);
                written = next;
                if (patchOptions.deletePages) {
                    transaction.objectStore(STORE.pages).delete(pageRangeKey(sessionId, fileId, 0));
                }
            };
            await transactionDoneAsync(transaction);

            return written;
        },
        putFileDeletingPagesAsync: (file, fromPage = 0) => writeAsync([STORE.files, STORE.pages], transaction => {
            transaction.objectStore(STORE.files).put(file);
            transaction.objectStore(STORE.pages).delete(pageRangeKey(file.sessionId, file.fileId, fromPage));
        }),
        movePartialAsync: async (from, to) => {
            const transaction = database.transaction([STORE.files, STORE.pages], 'readwrite');
            const pages = transaction.objectStore(STORE.pages);
            const files = transaction.objectStore(STORE.files);
            const request = pages.getAll(pageRangeKey(from.sessionId, from.fileId, 0));
            request.onsuccess = () => {
                for (const page of request.result as StoredPage[]) {
                    pages.put({ ...page, sessionId: to.sessionId } satisfies StoredPage);
                }

                pages.delete(pageRangeKey(from.sessionId, from.fileId, 0));
                files.delete([from.sessionId, from.fileId, from.direction]);
                files.put(to);
            };
            await transactionDoneAsync(transaction);
        },

        getBatchAsync: (sessionId, batchId) => readAsync(STORE.batches, store => store.get([sessionId, batchId])),
        putBatchAsync: batch => writeAsync(STORE.batches, transaction => {
            transaction.objectStore(STORE.batches).put(batch);
        }),
        listBatchesAsync: async sessionId => {
            const batches = await readAsync<StoredBatch[]>(STORE.batches, store => store.index(INDEX.batchesBySession).getAll(sessionId));

            return batches.sort((first, second) => second.createdAt - first.createdAt);
        },

        getThumbAsync: (sessionId, fileId) => readAsync(STORE.thumbs, store => store.get([sessionId, fileId])),
        deleteThumbAsync: (sessionId, fileId) => writeAsync(STORE.thumbs, transaction => {
            transaction.objectStore(STORE.thumbs).delete([sessionId, fileId]);
        }),
        putThumbAsync: async thumb => {
            throwIfFull();
            await writeAsync(STORE.thumbs, transaction => {
                transaction.objectStore(STORE.thumbs).put(thumb);
            });
        },

        cleanupAsync: async options => {
            const sessions = await storage.listSessionsAsync();
            let expiredPartials = 0;
            let trimmedHistory = 0;
            for (const session of sessions) {
                const result = await cleanupSessionAsync(session.sessionId, options);
                expiredPartials += result.expiredPartials;
                trimmedHistory += result.trimmedHistory;
            }

            return { expiredPartials, trimmedHistory };
        },
        removeSessionFilesAsync: (sessionId, removal) => writeAsync(
            [STORE.files, STORE.pages, STORE.thumbs, STORE.batches],
            transaction => {
                for (const file of removal.files) {
                    transaction.objectStore(STORE.files).delete([sessionId, file.fileId, file.direction]);
                    if (file.direction === 'in') {
                        transaction.objectStore(STORE.pages).delete(pageRangeKey(sessionId, file.fileId, 0));
                    }
                }

                for (const fileId of removal.thumbFileIds) {
                    transaction.objectStore(STORE.thumbs).delete([sessionId, fileId]);
                }

                for (const batchId of removal.batchIds) {
                    transaction.objectStore(STORE.batches).delete([sessionId, batchId]);
                }
            },
        ),
        clearSessionAsync: sessionId => writeAsync(
            [STORE.sessions, STORE.files, STORE.pages, STORE.batches, STORE.thumbs],
            transaction => {
                transaction.objectStore(STORE.sessions).delete(sessionId);
                transaction.objectStore(STORE.files).delete(sessionRange(sessionId));
                transaction.objectStore(STORE.pages).delete(sessionRange(sessionId));
                transaction.objectStore(STORE.batches).delete(sessionRange(sessionId));
                transaction.objectStore(STORE.thumbs).delete(sessionRange(sessionId));
            },
        ),
        clearAllAsync: () => writeAsync(
            [STORE.sessions, STORE.files, STORE.pages, STORE.batches, STORE.thumbs, STORE.logs],
            transaction => {
                for (const store of [STORE.sessions, STORE.files, STORE.pages, STORE.batches, STORE.thumbs, STORE.logs]) {
                    transaction.objectStore(store).clear();
                }
            },
        ),
    };

    return storage;
}
