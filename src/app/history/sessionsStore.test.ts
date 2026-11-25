import { afterEach, describe, expect, it, vi } from 'vitest';
import { SILENT_LOGGER } from '../../core/logger.js';
import { createFakeClient, createSession } from '../testing/fakeClient.js';
import { createSessionsStore } from './sessionsStore.js';

describe('createSessionsStore', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('lists sessions by last connection and flags unfinished work (§7.6)', async () => {
        // Arrange
        const client = createFakeClient({
            sessions: [
                createSession({ sessionId: 'old', lastConnectedAt: 1000 }),
                createSession({ sessionId: 'new', lastConnectedAt: 5000, unfinishedCount: 2 }),
            ],
        });
        const store = createSessionsStore(client, SILENT_LOGGER);

        // Act
        await store.refreshAsync();

        // Assert
        expect(store.sessions.map(session => session.sessionId)).toEqual(['new', 'old']);
    });

    it('adds the last 4 characters of the device ID when two peers share a name (DN-03)', async () => {
        // Arrange
        const client = createFakeClient({
            sessions: [
                createSession({ sessionId: 'a', peerName: 'iPhone · Blue Otter', peerDeviceId: 'device-1111' }),
                createSession({ sessionId: 'b', peerName: 'iPhone · Blue Otter', peerDeviceId: 'device-2222' }),
                createSession({ sessionId: 'c', peerName: 'Pixel 8 · Calm Fox', peerDeviceId: 'device-3333' }),
            ],
        });
        const store = createSessionsStore(client, SILENT_LOGGER);
        await store.refreshAsync();

        // Act
        const names = store.sessions.map(session => store.displayName(session));

        // Assert
        expect(names).toEqual(['iPhone · Blue Otter (1111)', 'iPhone · Blue Otter (2222)', 'Pixel 8 · Calm Fox']);
    });

    it('clears one session and takes it off the list at once (§7.6)', async () => {
        // Arrange
        const client = createFakeClient({ sessions: [createSession({ sessionId: 'a' }), createSession({ sessionId: 'b' })] });
        const store = createSessionsStore(client, SILENT_LOGGER);
        await store.refreshAsync();
        const seen: string[][] = [];
        store.subscribe(() => seen.push(store.sessions.map(session => session.sessionId)));

        // Act
        await store.clearAsync('a');

        // Assert
        expect(client.callsTo('clearSessionAsync')).toEqual([['a']]);
        expect(seen[0]).toEqual(['b']);
        expect(store.sessions.map(session => session.sessionId)).toEqual(['b']);
    });

    it('keeps the session when the client refuses to clear the connected one', async () => {
        // Arrange
        const client = createFakeClient({ sessions: [createSession()] });
        const store = createSessionsStore(client, SILENT_LOGGER);
        await store.refreshAsync();
        client.connect();

        // Act
        const error = await store.clearAsync('session-1').catch((caught: unknown) => caught);

        // Assert
        expect(error).toMatchObject({ code: 'busy' });
        expect(store.sessions.map(session => session.sessionId)).toEqual(['session-1']);
    });

    it('reloads after the peer started fresh', async () => {
        // Arrange
        vi.useFakeTimers();
        const client = createFakeClient({ sessions: [createSession({ unfinishedCount: 2 })] });
        const store = createSessionsStore(client, SILENT_LOGGER);
        await store.refreshAsync();
        client.sessions = [createSession({ unfinishedCount: 0 })];

        // Act
        client.emit('session-reset', { sessionId: 'session-1', peerName: 'Pixel 8 · Blue Otter', removed: 5 });
        await vi.advanceTimersByTimeAsync(500);

        // Assert
        expect(store.sessions[0]?.unfinishedCount).toBe(0);
    });
});
