import { describe, expect, it } from 'vitest';
import { acquireConnectionLockAsync, checkSupport, CONNECTION_LOCK, renderNotSupported, renderOtherTab } from './startupGuards.js';

function createLocks(isHeldElsewhere: boolean) {
    const names: string[] = [];

    return {
        names,
        request: async (name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>) => {
            names.push(name);
            void callback(isHeldElsewhere ? null : { name });
        },
    };
}

describe('checkSupport', () => {
    it('lists what is missing when WebRTC or IndexedDB is absent (§2)', () => {
        // Arrange
        const scope = { RTCPeerConnection: undefined, indexedDB: undefined } as unknown as typeof globalThis;

        // Act
        const check = checkSupport(scope);

        // Assert
        expect(check.isSupported).toBe(false);
        expect(check.missing).toEqual(['WebRTC (RTCPeerConnection)', 'IndexedDB storage']);
    });

    it('passes when both exist', () => {
        // Arrange
        const scope = { RTCPeerConnection: function RTCPeerConnection() {}, indexedDB: {} } as unknown as typeof globalThis;

        // Act & Assert
        expect(checkSupport(scope).isSupported).toBe(true);
    });

    it('draws one clear not-supported screen', () => {
        // Arrange
        const container = document.createElement('div');

        // Act
        renderNotSupported(container, { isSupported: false, missing: ['IndexedDB storage'] });

        // Assert
        expect(container.querySelector('h1')?.textContent).toBe('This browser can’t run Ether');
        expect(container.textContent).toContain('IndexedDB storage');
    });
});

describe('acquireConnectionLockAsync', () => {
    it('takes the ether-connection lock when it is free (§7.5)', async () => {
        // Arrange
        const locks = createLocks(false);

        // Act
        const lock = await acquireConnectionLockAsync(locks);

        // Assert
        expect(lock.status).toBe('acquired');
        expect(locks.names).toEqual([CONNECTION_LOCK]);
    });

    it('reports another tab holding it (test 18)', async () => {
        // Act
        const lock = await acquireConnectionLockAsync(createLocks(true));

        // Assert
        expect(lock.status).toBe('taken');
    });

    it('carries on without Web Locks', async () => {
        // Act
        const lock = await acquireConnectionLockAsync({} as never);

        // Assert
        expect(lock.status).toBe('unsupported');
    });
});

describe('renderOtherTab', () => {
    it('says Ether is open in another tab, and whether a code was passed on (HS-07)', () => {
        // Arrange
        const container = document.createElement('div');
        let retries = 0;

        // Act
        renderOtherTab(container, { forwarded: false, onRetry: () => retries++ });
        container.querySelector('button')?.click();

        // Assert
        expect(container.querySelector('h1')?.textContent).toBe('Ether is open in another tab');
        expect(container.textContent).toContain('Scan the reply from inside the app');
        expect(retries).toBe(1);
    });

    it('says only that pairing continued in the other tab when it took the reply (HS-07)', () => {
        // Arrange
        const container = document.createElement('div');

        // Act
        renderOtherTab(container, { forwarded: true, onRetry: () => undefined });

        // Assert
        expect(container.querySelector('h1')?.textContent).toBe('Pairing continued in the other tab');
        expect(container.textContent).toContain('you can close this one');
        expect(container.querySelector('button')).toBeNull();
    });
});
