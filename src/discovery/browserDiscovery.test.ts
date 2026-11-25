import { afterEach, describe, expect, it, vi } from 'vitest';
import { SILENT_LOGGER } from '../core/logger.js';
import { createBrowserDiscovery, createBrowserDiscoveryEnvironment, openWebSocket } from './browserDiscovery.js';

class StubWebSocket extends EventTarget {
    static last?: StubWebSocket;
    readonly sent: string[] = [];
    closeCount = 0;

    constructor(readonly url: string) {
        super();
        StubWebSocket.last = this;
    }

    send(text: string): void {
        this.sent.push(text);
    }

    close(): void {
        this.closeCount++;
    }
}

function socketEvent(type: string, data?: unknown): Event {
    return Object.assign(new Event(type), data === undefined ? {} : { data });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('openWebSocket', () => {
    it('passes open, messages and one close to the relay connection', () => {
        // Arrange
        vi.stubGlobal('WebSocket', StubWebSocket);
        const calls: string[] = [];
        const socket = openWebSocket('wss://relay.test', {
            onOpen: () => calls.push('open'),
            onMessage: data => calls.push(`message ${String(data)}`),
            onClose: () => calls.push('close'),
        });
        const stub = StubWebSocket.last;

        // Act
        stub?.dispatchEvent(socketEvent('open'));
        stub?.dispatchEvent(socketEvent('message', '["EOSE","nearby-1"]'));
        socket.send('["REQ"]');
        stub?.dispatchEvent(socketEvent('error'));
        stub?.dispatchEvent(socketEvent('close'));

        // Assert
        expect(stub?.url).toBe('wss://relay.test');
        expect(stub?.sent).toEqual(['["REQ"]']);
        expect(calls).toEqual(['open', 'message ["EOSE","nearby-1"]', 'close']);
    });

    it('says nothing when the relay connection closed the socket itself', () => {
        // Arrange
        vi.stubGlobal('WebSocket', StubWebSocket);
        const calls: string[] = [];
        const socket = openWebSocket('wss://relay.test', {
            onOpen: () => undefined,
            onMessage: () => undefined,
            onClose: () => calls.push('close'),
        });

        // Act
        socket.close();
        StubWebSocket.last?.dispatchEvent(socketEvent('close'));

        // Assert
        expect(StubWebSocket.last?.closeCount).toBe(1);
        expect(calls).toEqual([]);
    });
});

describe('createBrowserDiscoveryEnvironment', () => {
    it('builds where window and document are missing, with listeners that do nothing', () => {
        // Arrange
        const environment = createBrowserDiscoveryEnvironment();

        // Act
        const unsubscribes = [
            environment.onConnectivityChange(() => undefined),
            environment.onPageHide(() => undefined),
            environment.onPageShow(() => undefined),
            environment.onVisibilityChange(() => undefined),
        ];

        // Assert
        expect(() => unsubscribes.forEach(unsubscribe => unsubscribe())).not.toThrow();
        expect(environment.isHidden()).toBe(false);
        expect(() => environment.sessionStore.read('ether.nearby.identity')).toThrow();
        expect(environment.randomBytes(16)).toHaveLength(16);
        expect(environment.wallClock()).toBeGreaterThan(0);
    });

    it('hears online, offline, pagehide, a restoring pageshow and visibility changes', () => {
        // Arrange
        const target = new EventTarget();
        const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
        vi.stubGlobal('window', target);
        vi.stubGlobal('document', documentTarget);
        const environment = createBrowserDiscoveryEnvironment();
        const calls: string[] = [];
        environment.onConnectivityChange(isOnline => calls.push(isOnline ? 'online' : 'offline'));
        environment.onPageHide(() => calls.push('pagehide'));
        environment.onPageShow(() => calls.push('pageshow'));
        environment.onVisibilityChange(isHidden => calls.push(isHidden ? 'hidden' : 'visible'));

        // Act
        target.dispatchEvent(new Event('offline'));
        target.dispatchEvent(new Event('online'));
        target.dispatchEvent(new Event('pagehide'));
        target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
        target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        documentTarget.visibilityState = 'hidden';
        documentTarget.dispatchEvent(new Event('visibilitychange'));
        const hiddenNow = environment.isHidden();
        documentTarget.visibilityState = 'visible';
        documentTarget.dispatchEvent(new Event('visibilitychange'));

        // Assert
        expect(calls).toEqual(['offline', 'online', 'pagehide', 'pageshow', 'hidden', 'visible']);
        expect(hiddenNow).toBe(true);
    });

    it('keeps the tab identity in sessionStorage', () => {
        // Arrange
        const values = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });
        const environment = createBrowserDiscoveryEnvironment();

        // Act
        environment.sessionStore.write('ether.nearby.identity', '{}');

        // Assert
        expect(environment.sessionStore.read('ether.nearby.identity')).toBe('{}');
    });
});

describe('createBrowserDiscovery', () => {
    it('starts off', () => {
        // Act
        const discovery = createBrowserDiscovery({ logger: SILENT_LOGGER });

        // Assert
        expect(discovery.status()).toBe('off');
        expect(discovery.devices()).toEqual([]);
        expect(discovery.relayAllowance()).toBeUndefined();
    });
});
