import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { STORE, isQuotaExceeded, openDatabaseAsync } from '../core/database.js';
import type { SessionRecord } from './clientTypes.js';
import { createClientStorage } from './storage.js';
import type { ClientStorage, StoredFile, StoredPage } from './storage.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 23);

async function storageAsync(): Promise<{ storage: ClientStorage; database: IDBDatabase }> {
    const database = await openDatabaseAsync(new IDBFactory());

    return { storage: createClientStorage(database), database };
}

function session(sessionId: string): SessionRecord {
    return {
        sessionId,
        peerDeviceId: 'peer',
        peerName: 'Pixel 8',
        createdAt: NOW,
        lastConnectedAt: NOW,
        connections: [],
        totals: { filesSent: 0, bytesSent: 0, filesReceived: 0, bytesReceived: 0 },
    };
}

function file(changes: Partial<StoredFile> = {}): StoredFile {
    return {
        sessionId: 's1',
        fileId: 'f1',
        direction: 'in',
        name: 'IMG_2230.HEIC',
        size: 3,
        mime: 'image/heic',
        kind: 'image',
        lastModified: NOW,
        state: 'active',
        attempts: 0,
        createdAt: NOW,
        updatedAt: NOW,
        hasThumbnail: false,
        hasData: false,
        queueIndex: 1,
        ...changes,
    };
}

function page(pageIndex: number, sessionId = 's1'): StoredPage {
    return { sessionId, fileId: 'f1', pageIndex, data: new Blob([new Uint8Array([pageIndex])]), hash: new Uint8Array(32).fill(pageIndex) };
}

describe('createClientStorage', () => {
    it('keeps the device ID and the settings record under their keys (AP-05)', async () => {
        // Arrange
        const { storage } = await storageAsync();

        // Act
        await storage.writeDeviceIdAsync('device-1');
        await storage.writeSettingsAsync({ schemaVersion: 1, pageSize: 2 });

        // Assert
        expect(await storage.readDeviceIdAsync()).toBe('device-1');
        expect(await storage.readSettingsAsync()).toEqual({ schemaVersion: 1, pageSize: 2 });
    });

    it('writes a page and the updated pagination in one transaction (§7.2)', async () => {
        // Arrange
        const { storage } = await storageAsync();
        const pagination = { pageSize: 1, totalPages: 3, currentPage: 1, pagesDone: 1, slot: 1, crc32: 7 };

        // Act
        await storage.writePageAsync(page(0), file({ pagination }));
        await storage.writePageAsync(page(1), file({ pagination: { ...pagination, currentPage: 2, pagesDone: 2 } }));

        // Assert
        const pages = await storage.readPagesAsync('s1', 'f1');
        expect(pages.map(item => item.pageIndex)).toEqual([0, 1]);
        expect((await storage.getFileAsync('s1', 'f1', 'in'))?.pagination?.pagesDone).toBe(2);
    });

    it('writes nothing when the page write fails with QuotaExceededError (PW-08)', async () => {
        // Arrange
        const { storage } = await storageAsync();
        storage.failDataWrites = true;

        // Act
        const error = await storage.writePageAsync(page(0), file({ state: 'paused' })).catch((caught: unknown) => caught);

        // Assert
        expect(isQuotaExceeded(error)).toBe(true);
        expect(await storage.getFileAsync('s1', 'f1', 'in')).toBeUndefined();
        expect(await storage.readPagesAsync('s1', 'f1')).toEqual([]);
    });

    it('moves a partial and its pages into another session (§7.5)', async () => {
        // Arrange
        const { storage } = await storageAsync();
        const partial = file({ pagination: { pageSize: 1, totalPages: 3, currentPage: 2, pagesDone: 2, slot: null } });
        await storage.writePageAsync(page(0), partial);
        await storage.writePageAsync(page(1), partial);

        // Act
        await storage.movePartialAsync(partial, { ...partial, sessionId: 's2' });

        // Assert
        expect(await storage.getFileAsync('s1', 'f1', 'in')).toBeUndefined();
        expect((await storage.readPagesAsync('s2', 'f1')).map(item => item.pageIndex)).toEqual([0, 1]);
        expect(await storage.readPagesAsync('s1', 'f1')).toEqual([]);
        expect((await storage.findFilesByFileIdAsync('f1')).map(item => item.sessionId)).toEqual(['s2']);
    });

    it('drops pages from a page on and saves the record together', async () => {
        // Arrange
        const { storage } = await storageAsync();
        for (const index of [0, 1, 2]) {
            await storage.writePageAsync(page(index), file());
        }

        // Act
        await storage.putFileDeletingPagesAsync(file({ state: 'paused' }), 1);

        // Assert
        expect((await storage.readPagesAsync('s1', 'f1')).map(item => item.pageIndex)).toEqual([0]);
        expect((await storage.getFileAsync('s1', 'f1', 'in'))?.state).toBe('paused');
    });

    it('counts unfinished files per session', async () => {
        // Arrange
        const { storage } = await storageAsync();
        await storage.putFileAsync(file({ fileId: 'a', state: 'paused' }));
        await storage.putFileAsync(file({ fileId: 'b', state: 'needs-file', direction: 'out' }));
        await storage.putFileAsync(file({ fileId: 'c', state: 'done' }));

        // Act
        const count = await storage.countUnfinishedAsync('s1');

        // Assert
        expect(count).toBe(2);
        expect((await storage.listFilesInStatesAsync('s1', ['done'])).map(item => item.fileId)).toEqual(['c']);
    });

    it('expires old partials and trims old history, keeping unsaved received files (§7.5)', async () => {
        // Arrange
        const { storage } = await storageAsync();
        await storage.putSessionAsync(session('s1'));
        const old = NOW - 10 * DAY;
        await storage.writePageAsync(page(0), file({ state: 'paused', updatedAt: old, pagination: { pageSize: 1, totalPages: 3, currentPage: 1, pagesDone: 1, slot: null } }));
        await storage.putFileAsync(file({ fileId: 'sent-old', direction: 'out', state: 'done', completedAt: NOW - 100 * DAY }));
        await storage.putFileAsync(file({ fileId: 'unsaved-old', state: 'done', hasData: true, completedAt: NOW - 100 * DAY }));
        await storage.putFileAsync(file({ fileId: 'recent-1', state: 'done', completedAt: NOW - 2 * DAY }));
        await storage.putFileAsync(file({ fileId: 'recent-2', state: 'done', completedAt: NOW - DAY }));

        // Act
        const result = await storage.cleanupAsync({ now: NOW, keepPartialDays: 7, keepHistoryDays: 90, keepHistoryPerSession: 1 });

        // Assert
        expect(result).toEqual({ expiredPartials: 1, trimmedHistory: 2 });
        const remaining = await storage.listFilesAsync('s1');
        expect(remaining.map(item => item.fileId).sort()).toEqual(['f1', 'recent-2', 'unsaved-old']);
        expect(remaining.find(item => item.fileId === 'f1')).toMatchObject({ state: 'canceled', note: 'partial-expired' });
        expect(await storage.readPagesAsync('s1', 'f1')).toEqual([]);
    });

    it('never trims a file whose data is still in the app, saved or not, nor the pages of a twin in the other direction', async () => {
        // Arrange
        const { storage } = await storageAsync();
        await storage.putSessionAsync(session('s1'));
        const old = NOW - 100 * DAY;
        await storage.writePageAsync(page(0), file({ state: 'active', pagination: { pageSize: 1, totalPages: 1, currentPage: 0, pagesDone: 0, slot: null } }));
        await storage.patchFileAsync('s1', 'f1', 'in', current => ({ ...current, state: 'done', hasData: true, savedAt: old, completedAt: old, pagination: undefined }));
        await storage.putFileAsync(file({ direction: 'out', state: 'done', completedAt: old }));
        await storage.putFileAsync(file({ fileId: 'saved-old', state: 'done', hasData: true, savedAt: old, completedAt: old }));
        await storage.putFileAsync(file({ fileId: 'deleted-old', state: 'done', completedAt: old }));

        // Act
        const result = await storage.cleanupAsync({ now: NOW, keepPartialDays: 7, keepHistoryDays: 1, keepHistoryPerSession: 0 });

        // Assert
        expect(result).toEqual({ expiredPartials: 0, trimmedHistory: 2 });
        const remaining = await storage.listFilesAsync('s1');
        expect(remaining.map(item => `${item.fileId}:${item.direction}`).sort()).toEqual(['f1:in', 'saved-old:in']);
        expect(await storage.readPagesAsync('s1', 'f1')).toHaveLength(1);
    });

    it('clears one session, or everything but the identity and settings', async () => {
        // Arrange
        const { storage, database } = await storageAsync();
        await storage.writeDeviceIdAsync('device-1');
        for (const sessionId of ['s1', 's2']) {
            await storage.putSessionAsync(session(sessionId));
            await storage.writePageAsync(page(0, sessionId), file({ sessionId }));
            await storage.putThumbAsync({ sessionId, fileId: 'f1', data: new Blob(['jpeg']), createdAt: NOW });
            await storage.putBatchAsync({ sessionId, batchId: 'b', direction: 'in', itemCount: 1, totalBytes: 3, received: 0, saved: 0, failed: 0, createdAt: NOW });
        }

        // Act
        await storage.clearSessionAsync('s1');
        const afterSession = (await storage.listSessionsAsync()).map(item => item.sessionId);
        const thumbsKept = await storage.getThumbAsync('s2', 'f1');
        database.transaction(STORE.logs, 'readwrite').objectStore(STORE.logs).add({ runId: 'r', msg: 'x' });
        await storage.clearAllAsync();

        // Assert
        expect(afterSession).toEqual(['s2']);
        expect(thumbsKept?.data).toBeInstanceOf(Blob);
        expect(await storage.listSessionsAsync()).toEqual([]);
        expect(await storage.listFilesAsync('s2')).toEqual([]);
        expect(await storage.listBatchesAsync('s2')).toEqual([]);
        expect(await storage.readDeviceIdAsync()).toBe('device-1');
    });
});
