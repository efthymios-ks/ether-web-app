import { describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { FakeClock } from '../network/fakeEnvironment.js';
import { FakeStun } from './fakeDiscoveryEnvironment.js';
import type { FakeStunAnswer } from './fakeDiscoveryEnvironment.js';
import { findPublicAddressAsync, STUN_SERVERS } from './stunPool.js';
import type { PublicAddressResult } from './stunPool.js';

const SERVERS = ['stun:one.test:3478', 'stun:two.test:3478', 'stun:three.test:3478', 'stun:four.test:3478'];
const HOME = '203.0.113.7';
const ELSEWHERE = '198.51.100.23';

interface Lookup {
    readonly result: Promise<PublicAddressResult>;
    readonly stun: FakeStun;
    readonly clock: FakeClock;
    isSettled(): boolean;
    messages(): string[];
}

function lookUp(answers: readonly FakeStunAnswer[], servers: readonly string[] = SERVERS): Lookup {
    const clock = new FakeClock();
    const stun = new FakeStun('silent');
    servers.forEach((server, index) => stun.answers.set(server, answers[index] ?? 'silent'));
    const memory = createMemorySink(100);
    const { logger } = createLogger({
        sinks: [memory],
        routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
    });
    let isSettled = false;
    const result = findPublicAddressAsync({
        servers,
        environment: {
            createPeerConnection: stun.createPeerConnection,
            setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
            clearTimeout: handle => clock.clear(handle),
        },
        logger,
        timeoutMs: 5000,
    });
    void result.then(() => {
        isSettled = true;
    });

    return {
        result,
        stun,
        clock,
        isSettled: () => isSettled,
        messages: () => memory.entries().map(entry => entry.msg),
    };
}

async function flushAsync(): Promise<void> {
    for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve();
    }
}

describe('STUN_SERVERS', () => {
    it('asks Cloudflare first, with Google behind it', () => {
        // Act & Assert
        expect(STUN_SERVERS[0]).toBe('stun:stun.cloudflare.com:3478');
        expect(STUN_SERVERS.slice(1).every(server => server.includes('.l.google.com:19302'))).toBe(true);
    });
});

describe('findPublicAddressAsync', () => {
    it('asks every server at once on a throwaway connection with a data channel', async () => {
        // Act
        const lookup = lookUp([HOME, HOME, HOME, HOME]);
        await lookup.result;

        // Assert
        expect(lookup.stun.configurations).toEqual(SERVERS.map(server => ({ iceServers: [{ urls: server }] })));
        expect(lookup.stun.connections.every(connection => connection.channels.length === 1)).toBe(true);
        expect(lookup.stun.connections.every(connection => connection.isClosed)).toBe(true);
    });

    it('answers as soon as no missing server could change the winner', async () => {
        // Arrange
        const lookup = lookUp([HOME, HOME, 'hang', 'hang']);

        // Act
        await flushAsync();

        // Assert
        expect(lookup.isSettled()).toBe(true);
        await expect(lookup.result).resolves.toEqual({
            address: HOME,
            answered: SERVERS.slice(0, 2),
            silent: SERVERS.slice(2),
        });
    });

    it('waits while one answer alone could still be outvoted', async () => {
        // Arrange
        const lookup = lookUp([HOME, 'hang', 'hang', 'hang']);

        // Act
        await flushAsync();
        const isEarly = lookup.isSettled();
        lookup.clock.advance(5000);

        // Assert
        expect(isEarly).toBe(false);
        await expect(lookup.result).resolves.toMatchObject({ address: HOME, answered: [SERVERS[0]] });
    });

    it('takes the address most servers agree on', async () => {
        // Act
        const result = await lookUp([ELSEWHERE, HOME, HOME, 'silent']).result;

        // Assert
        expect(result.address).toBe(HOME);
    });

    it('breaks a tie in favour of the address heard first', async () => {
        // Act
        const result = await lookUp([ELSEWHERE, HOME]).result;

        // Assert
        expect(result.address).toBe(ELSEWHERE);
    });

    it('ignores IPv6, loopback and malformed server-reflexive addresses', async () => {
        // Act
        const result = await lookUp(['2001:db8::1', '127.0.0.1', '300.1.2.3', HOME]).result;

        // Assert
        expect(result).toEqual({ address: HOME, answered: [SERVERS[3]], silent: SERVERS.slice(0, 3) });
    });

    it('gives up after the timeout with no address, closes everything and logs it', async () => {
        // Arrange
        const lookup = lookUp(['hang', 'hang', 'silent', 'hang']);

        // Act
        lookup.clock.advance(5000);
        const result = await lookup.result;

        // Assert
        expect(result).toEqual({ answered: [], silent: SERVERS });
        expect(lookup.stun.connections.every(connection => connection.isClosed)).toBe(true);
        expect(lookup.messages()).toContain('no STUN server gave a public IPv4 address (4 asked)');
    });

    it('finishes at once when every server is silent', async () => {
        // Act
        const result = await lookUp(['silent', 'silent', 'silent', 'silent']).result;

        // Assert
        expect(result.address).toBeUndefined();
    });

    it('logs which servers answered, never the address', async () => {
        // Arrange
        const lookup = lookUp([HOME, HOME, HOME, HOME]);

        // Act
        await lookup.result;

        // Assert
        expect(lookup.messages()).toContain('public address from 2 of 4 STUN servers');
        expect(lookup.messages().join(' ')).not.toContain(HOME);
    });

    it('survives a browser that refuses peer connections', async () => {
        // Arrange
        const clock = new FakeClock();
        const stun = new FakeStun(HOME);
        stun.throwsOnCreate = true;

        // Act
        const result = await findPublicAddressAsync({
            servers: SERVERS,
            environment: {
                createPeerConnection: stun.createPeerConnection,
                setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
                clearTimeout: handle => clock.clear(handle),
            },
            logger: createLogger().logger,
            timeoutMs: 5000,
        });

        // Assert
        expect(result).toEqual({ answered: [], silent: SERVERS });
    });
});
