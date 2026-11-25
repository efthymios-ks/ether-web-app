import type { Logger } from '../core/logger.js';
import { bytesToBase64Url, bytesToHex, hexToBytes } from './encoding.js';
import { isValidId } from './nearbyMessages.js';
import { createSecretKey } from './nostrEvent.js';
import { isValidSecretKey } from './schnorr.js';

// The tab's nearby identity, its nearbyId and Nostr key, kept in sessionStorage. A reload in the same tab then
// speaks as the same device, so the other devices update its row instead of adding one next to a page that left
// without saying goodbye (iOS drops the socket while the page unloads). A new tab gets a new identity, and
// nothing outlives the tab. Without storage, every page load is a new device.

export const TAB_IDENTITY_KEY = 'ether.nearby.identity';
const ID_BYTES = 16;

export interface TabIdentity {
    readonly nearbyId: string;
    readonly secretKey: Uint8Array;
}

// sessionStorage behind an interface; either call may throw (blocked storage, some private modes).
export interface SessionStore {
    read(key: string): string | null;
    write(key: string, value: string): void;
}

export function createTabIdentity(randomBytes: (length: number) => Uint8Array): TabIdentity {
    return { nearbyId: bytesToBase64Url(randomBytes(ID_BYTES)), secretKey: createSecretKey(randomBytes) };
}

export function loadTabIdentity(
    store: SessionStore,
    randomBytes: (length: number) => Uint8Array,
    logger: Logger,
): TabIdentity {
    const stored = readTabIdentity(store, logger);
    if (stored != null) {
        logger.info('nearby', 'this tab speaks as the device it was before the reload');

        return stored;
    }

    const identity = createTabIdentity(randomBytes);
    saveTabIdentity(store, identity, logger);

    return identity;
}

export function saveTabIdentity(store: SessionStore, identity: TabIdentity, logger: Logger): void {
    const record = { v: 1, nearbyId: identity.nearbyId, key: bytesToHex(identity.secretKey) };
    try {
        store.write(TAB_IDENTITY_KEY, JSON.stringify(record));
    } catch (error) {
        logger.info('nearby', 'session storage unavailable; a reload will count as a new device', { error });
    }
}

function readTabIdentity(store: SessionStore, logger: Logger): TabIdentity | undefined {
    let text: string | null;
    try {
        text = store.read(TAB_IDENTITY_KEY);
    } catch (error) {
        logger.info('nearby', 'session storage unavailable; a reload will count as a new device', { error });

        return undefined;
    }

    if (text == null) {
        return undefined;
    }

    const identity = parseTabIdentity(text);
    if (identity == null) {
        logger.warn('nearby', 'the stored tab identity is unreadable; making a new one');
    }

    return identity;
}

function parseTabIdentity(text: string): TabIdentity | undefined {
    try {
        const value = JSON.parse(text) as { readonly nearbyId?: unknown; readonly key?: unknown } | null;
        const secretKey = typeof value?.key === 'string' ? hexToBytes(value.key) : undefined;
        if (!isValidId(value?.nearbyId) || secretKey == null || !isValidSecretKey(secretKey)) {
            return undefined;
        }

        return { nearbyId: value.nearbyId, secretKey };
    } catch {
        return undefined;
    }
}
