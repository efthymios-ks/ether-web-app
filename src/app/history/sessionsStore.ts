import type { Client, SessionSummary } from '../../client/clientTypes.js';
import type { Logger } from '../../core/logger.js';
import { createDebounce } from '../throttle.js';

// §7.6: the sessions list, shared by the Previous sessions drawer, the session screens and the nearby prompts,
// so it loads once.

export interface SessionsStore {
    readonly sessions: readonly SessionSummary[];
    readonly isLoaded: boolean;
    find(sessionId: string): SessionSummary | undefined;
    // DN-03: a peer name with the last 4 characters of its deviceId when two sessions share the name.
    displayName(session: SessionSummary): string;
    refreshAsync(): Promise<void>;
    // Reloads soon, coalescing bursts of file events.
    refreshSoon(): void;
    // Clears one session on this device (the drawer's bin) and takes it off the list at once.
    clearAsync(sessionId: string): Promise<void>;
    subscribe(handler: () => void): () => void;
    dispose(): void;
}

export function createSessionsStore(client: Client, logger: Logger): SessionsStore {
    const handlers = new Set<() => void>();
    let sessions: SessionSummary[] = [];
    let isLoaded = false;

    const notify = (): void => {
        for (const handler of handlers) {
            handler();
        }
    };

    const refreshAsync = async (): Promise<void> => {
        try {
            sessions = (await client.listSessionsAsync())
                .slice()
                .sort((left, right) => right.lastConnectedAt - left.lastConnectedAt);
            isLoaded = true;
            notify();
        } catch (error) {
            logger.warn('app', 'could not load sessions', { error });
        }
    };

    const debounce = createDebounce(() => {
        void refreshAsync();
    }, 400);

    const unsubscribers = [
        client.on('peer', () => debounce.schedule()),
        client.on('state', () => debounce.schedule()),
        client.on('file-queued', () => debounce.schedule()),
        client.on('file-done', () => debounce.schedule()),
        client.on('file-failed', () => debounce.schedule()),
        client.on('needs-file', () => debounce.schedule()),
        client.on('file-state', () => debounce.schedule()),
        client.on('session-cleared', () => debounce.schedule()),
        client.on('session-reset', () => debounce.schedule()),
    ];

    return {
        get sessions() {
            return sessions;
        },
        get isLoaded() {
            return isLoaded;
        },
        find: sessionId => sessions.find(session => session.sessionId === sessionId),
        displayName: session => {
            const isShared = sessions.some(other => other.sessionId !== session.sessionId && other.peerName === session.peerName);

            return isShared ? `${session.peerName} (${session.peerDeviceId.slice(-4)})` : session.peerName;
        },
        refreshAsync,
        refreshSoon: () => debounce.schedule(),
        clearAsync: async sessionId => {
            await client.clearSessionAsync(sessionId);
            sessions = sessions.filter(session => session.sessionId !== sessionId);
            notify();
            await refreshAsync();
        },
        subscribe: handler => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
        dispose: () => {
            debounce.cancel();
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            handlers.clear();
        },
    };
}
