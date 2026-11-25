import { IDBFactory } from 'fake-indexeddb';
import { openDatabaseAsync } from '../core/database.js';
import type { DevicePlatform } from '../core/deviceInfo.js';
import { createLogger } from '../core/logger.js';
import type { LogEntry, LoggerController } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import type { MemorySink } from '../core/logSinks.js';
import type { Settings } from '../core/settings.js';
import type { FileMetadata, MediaToolkit } from '../media/metadataTypes.js';
import { createClientAsync } from './client.js';
import type { Client, ClientOptions } from './clientTypes.js';
import type { FakeNetworkHub } from './fakeNetwork.js';

// Test support only: two clients on a fake network, each with its own in-memory IndexedDB (CL-10).

export const KIB = 1024;
export const PAGE = 256 * KIB;

export interface TestDevice {
    readonly client: Client;
    readonly memory: MemorySink;
    readonly controller: LoggerController;
    readonly factory: IDBFactory;
    readonly database: IDBDatabase;
    readonly name: string;
}

export interface TestDeviceOptions {
    readonly name: string;
    readonly factory?: IDBFactory;
    readonly settings?: Partial<Settings>;
    readonly platform?: DevicePlatform;
    // Free space the storage estimate reports; unlimited when left out.
    readonly freeBytes?: () => number | undefined;
    readonly media?: MediaToolkit;
    readonly persistStorageAsync?: () => Promise<boolean>;
    readonly now?: () => number;
    // Wraps the database the client sees, e.g. to make some writes slow like a phone's storage.
    readonly wrapDatabase?: (database: IDBDatabase) => IDBDatabase;
    // 'restore' (the default) answers every Restore prompt with Restore, as a person tapping it at once would;
    // 'ask' leaves `session-known` for the test to answer.
    readonly restorePrompt?: 'restore' | 'ask';
}

export const TEST_SETTINGS: Partial<Settings> = Object.freeze({
    pageSize: PAGE,
    chunkSize: 64 * KIB,
    sendThumbnailsFirst: false,
    pageAckTimeoutMs: 2000,
    offerReplyTimeoutMs: 5000,
});

export const PLAIN_MEDIA: MediaToolkit = Object.freeze({
    extractMetadataAsync: async () => undefined,
    createThumbnailAsync: async () => undefined,
});

// Pretends every image has a date taken and GPS, and makes a tiny "thumbnail" from its first bytes.
export const PHOTO_MEDIA: MediaToolkit = Object.freeze({
    extractMetadataAsync: async (file: File): Promise<FileMetadata | undefined> => (file.type.startsWith('image/')
        ? { takenAt: `2026-11-${String(10 + (file.size % 9)).padStart(2, '0')}T12:00:00+01:00`, latitude: 37.97, longitude: 23.72 }
        : undefined),
    createThumbnailAsync: async (file: File) => (file.type.startsWith('image/')
        ? new Blob([await file.slice(0, 64).arrayBuffer()], { type: 'image/jpeg' })
        : undefined),
});

export async function createTestDeviceAsync(hub: FakeNetworkHub, options: TestDeviceOptions): Promise<TestDevice> {
    const factory = options.factory ?? new IDBFactory();
    const database = await openDatabaseAsync(factory);
    const memory = createMemorySink(50_000);
    const controller = createLogger({ sinks: [memory] });
    const clientOptions: ClientOptions = {
        database: options.wrapDatabase ? options.wrapDatabase(database) : database,
        logger: controller.logger,
        loggerController: controller,
        createNetwork: hub.createNetwork,
        media: options.media ?? PLAIN_MEDIA,
        appUrl: 'https://example.test/ether/',
        // Files arrive without asking unless a test turns Ask before receiving on; a reload keeps what was stored.
        defaultSettings: {
            deviceName: options.name,
            askBeforeReceiving: false,
            ...TEST_SETTINGS,
            ...options.settings,
        },
        ...(options.platform == null ? {} : { platform: options.platform }),
        isPhone: false,
        storageEstimateAsync: async () => {
            const free = options.freeBytes?.();

            return free == null ? {} : { usage: 0, quota: free };
        },
        persistStorageAsync: options.persistStorageAsync ?? (async () => true),
        ...(options.now ? { now: options.now } : {}),
    };
    const client = await createClientAsync(clientOptions);
    if (options.restorePrompt !== 'ask') {
        client.on('session-known', info => {
            void client.restoreSessionAsync(info.sessionId);
        });
    }

    await client.configureAsync({
        debugLogging: true,
        logLevel: 'debug',
        logSinks: ['memory'],
        ...TEST_SETTINGS,
        ...options.settings,
    });

    return { client, memory, controller, factory, database, name: options.name };
}

export async function waitForAsync(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condition'): Promise<void> {
    const started = Date.now();
    while (!(await predicate())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

export function messages(device: TestDevice, filter: (entry: LogEntry) => boolean = () => true): string[] {
    return device.memory.entries().filter(filter).map(entry => entry.msg);
}

export function countLogs(device: TestDevice, pattern: RegExp): number {
    return device.memory.entries().filter(entry => pattern.test(entry.msg)).length;
}

// Pairs two devices by their fake codes and waits until both have applied the other's sync.
export async function pairAsync(offerer: TestDevice, answerer: TestDevice): Promise<void> {
    const syncsBefore = [countLogs(offerer, /^sync received/), countLogs(answerer, /^sync received/)];
    const offer = await offerer.client.startPairingAsync();
    const answer = await answerer.client.joinWithCodeAsync(offer.url);
    await offerer.client.completePairingAsync(answer.answerCode);
    await waitForAsync(
        () => countLogs(offerer, /^sync received/) > (syncsBefore[0] ?? 0) && countLogs(answerer, /^sync received/) > (syncsBefore[1] ?? 0),
        5000,
        'both syncs',
    );
}

// Deterministic bytes from a seed, so two picks of "the same file" have the same fileId.
export function createTestFile(name: string, size: number, seed: number, type = 'application/octet-stream'): File {
    const bytes = new Uint8Array(size);
    let state = seed * 2654435761 + 1;
    for (let index = 0; index < size; index++) {
        state = (state * 1103515245 + 12345) >>> 0;
        bytes[index] = state >>> 24;
    }

    return new File([bytes], name, { type, lastModified: 1_700_000_000_000 + seed });
}

export async function bytesOfAsync(blob: Blob): Promise<Uint8Array> {
    return new Uint8Array(await blob.arrayBuffer());
}

export async function reopenDeviceAsync(hub: FakeNetworkHub, device: TestDevice, options: Partial<TestDeviceOptions> = {}): Promise<TestDevice> {
    device.client.dispose();

    return createTestDeviceAsync(hub, { name: device.name, factory: device.factory, ...options });
}

// Drops every link while `count` files are part-way: a page from `minimumPage` on acked, but not the last of
// `totalPages`. Only receivers send acks.
export function dropWhenPartialAsync(hub: FakeNetworkHub, count: number, totalPages: number, minimumPage = 0): Promise<void> {
    const partial = new Set<string>();
    let hasDropped = false;

    return new Promise(resolve => {
        const stop = hub.intercept(traffic => {
            if (hasDropped || traffic.kind !== 'message' || traffic.message.t !== 'ack') {
                return undefined;
            }

            const fileId = traffic.message.fileId as string;
            const page = traffic.message.page as number;
            if (page >= totalPages - 1) {
                partial.delete(fileId);

                return undefined;
            }

            if (page >= minimumPage) {
                partial.add(fileId);
            }

            if (partial.size < count) {
                return undefined;
            }

            hasDropped = true;
            stop();
            queueMicrotask(() => {
                hub.dropLinks();
                resolve();
            });

            return 'drop';
        });
    });
}

// A database whose read-write transactions over exactly `storeNames` (one store, or the full list) report completion
// `delayMs` late, the data already written: the slow writes of a phone, so other work happens while one is in flight.
export function delayWritesTo(storeNames: string | readonly string[], delayMs: number): (database: IDBDatabase) => IDBDatabase {
    const wanted = [...(typeof storeNames === 'string' ? [storeNames] : storeNames)].sort().join(',');

    return database => new Proxy(database, {
        get: (target, property) => {
            if (property !== 'transaction') {
                const value = Reflect.get(target, property, target) as unknown;

                return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(target) : value;
            }

            return (stores: string | string[], mode?: IDBTransactionMode) => {
                const transaction = target.transaction(stores, mode);
                const names = typeof stores === 'string' ? [stores] : [...stores];
                if (mode !== 'readwrite' || names.sort().join(',') !== wanted) {
                    return transaction;
                }

                return new Proxy(transaction, {
                    set: (inner, key, value: unknown) => {
                        if (key === 'oncomplete' && typeof value === 'function') {
                            inner.oncomplete = event => setTimeout(() => (value as (event: Event) => void).call(inner, event), delayMs);

                            return true;
                        }

                        return Reflect.set(inner, key, value, inner);
                    },
                    get: (inner, key) => {
                        const value = Reflect.get(inner, key, inner) as unknown;

                        return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(inner) : value;
                    },
                });
            };
        },
    });
}
