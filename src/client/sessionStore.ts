import type { SessionRecord } from './clientTypes.js';
import type { ClientStorage } from './storage.js';

// Session records change from several places (connection log, totals); writes run one at a time so none is lost.

export interface SessionStore {
    updateAsync(sessionId: string, update: (session: SessionRecord | undefined) => SessionRecord | undefined): Promise<SessionRecord | undefined>;
}

export function createSessionStore(storage: ClientStorage): SessionStore {
    let chain: Promise<unknown> = Promise.resolve();

    return {
        updateAsync: (sessionId, update) => {
            const next = chain.then(async () => {
                const current = await storage.getSessionAsync(sessionId);
                const updated = update(current);
                if (updated && updated !== current) {
                    await storage.putSessionAsync(updated);
                }

                return updated;
            });
            chain = next.catch(() => undefined);

            return next;
        },
    };
}
