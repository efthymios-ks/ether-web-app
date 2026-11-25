import { describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { FakeClock } from '../network/fakeEnvironment.js';
import { FakeRelayNetwork } from './fakeRelay.js';
import { createNostrSigner, createSecretKey } from './nostrEvent.js';
import type { NostrEvent } from './nostrEvent.js';
import { createRelayPool, OWN_RELAY_URLS, PUBLIC_RELAY_URLS, RELAY_URLS } from './relayPool.js';
import type { RelayPool } from './relayPool.js';
import relayList from './relays.json';

const URLS = ['wss://one.test', 'wss://two.test', 'wss://three.test'];
const ROOM = 'ab'.repeat(32);
const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

interface Harness {
    readonly pool: RelayPool;
    readonly clock: FakeClock;
    readonly network: FakeRelayNetwork;
    readonly received: NostrEvent[];
    readonly changes: string[];
    messages(): string[];
}

function createHarness(): Harness {
    const clock = new FakeClock();
    const network = new FakeRelayNetwork(URLS);
    const memory = createMemorySink(500);
    const { logger } = createLogger({
        sinks: [memory],
        routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
        now: clock.now,
    });
    const pool = createRelayPool({
        urls: URLS,
        createSocket: network.socketFactory('device'),
        clock: {
            now: clock.now,
            setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
            clearTimeout: handle => clock.clear(handle),
            random: () => 0.5,
        },
        logger,
    });
    const received: NostrEvent[] = [];
    const changes: string[] = [];
    pool.on('event', event => received.push(event));
    pool.on('relay-opened', url => changes.push(`opened ${url}`));
    pool.on('relay-failed', url => changes.push(`failed ${url}`));
    pool.setSubscription({
        filter: () => ({ kinds: [25_050], '#x': [ROOM] }),
        matches: event => event.kind === 25_050 && event.tags.some(tag => tag[0] === 'x' && tag[1] === ROOM),
    });

    return { pool, clock, network, received, changes, messages: () => memory.entries().map(entry => entry.msg) };
}

async function flushAsync(): Promise<void> {
    for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve();
    }
}

function event(content = 'sealed', signer = createNostrSigner(createSecretKey(random), random)): NostrEvent {
    return signer.sign({ createdAt: 1_795_000_000, kind: 25_050, tags: [['x', ROOM]], content });
}

async function startedAsync(): Promise<Harness> {
    const harness = createHarness();
    harness.pool.start();
    await flushAsync();

    return harness;
}

describe('relay list', () => {
    it('puts Ether\'s own relays first and the public backups after them', () => {
        // Act & Assert
        expect(RELAY_URLS).toEqual([...relayList.own, ...relayList.public]);
        expect(OWN_RELAY_URLS).toEqual(relayList.own);
        expect(PUBLIC_RELAY_URLS.length).toBeGreaterThanOrEqual(4);
        expect(RELAY_URLS.every(url => /^wss:\/\/[a-z0-9.-]+$/.test(url))).toBe(true);
    });
});

describe('createRelayPool', () => {
    it('connects to every relay and subscribes on each', async () => {
        // Act
        const harness = await startedAsync();

        // Assert
        expect(harness.pool.openCount).toBe(3);
        expect(harness.network.relays.every(relay => relay.subscriptionCount === 1)).toBe(true);
        expect(harness.changes).toEqual(URLS.map(url => `opened ${url}`));
    });

    it('passes on the first copy of an event and drops the copies from the other relays', async () => {
        // Arrange
        const harness = await startedAsync();
        const incoming = event();

        // Act
        for (const relay of harness.network.relays) {
            relay.inject(incoming);
        }

        await flushAsync();

        // Assert
        expect(harness.received).toEqual([incoming]);
    });

    it('checks the id and the signature, whatever relay sent the event', async () => {
        // Arrange
        const harness = await startedAsync();
        const real = event('real');
        const forgedSignature = { ...real, sig: event('other').sig };
        const wrongId = { ...event('x'), content: 'changed' };
        const [first, second] = harness.network.relays;

        // Act
        first?.inject(forgedSignature);
        first?.inject(wrongId);
        await flushAsync();
        second?.inject(real);
        await flushAsync();

        // Assert
        expect(harness.received).toEqual([real]);
    });

    it('drops events the subscription would not match', async () => {
        // Arrange
        const harness = await startedAsync();
        const signer = createNostrSigner(createSecretKey(random), random);
        const otherKind = signer.sign({ createdAt: 1, kind: 1, tags: [['x', ROOM]], content: 'note' });

        // Act
        harness.network.relays[0]?.broadcast(JSON.stringify(['EVENT', 'nearby-1', otherKind]));
        await flushAsync();

        // Assert
        expect(harness.received).toEqual([]);
    });

    it('drops its own events when the relays send them back', async () => {
        // Arrange
        const harness = await startedAsync();
        const own = event();

        // Act
        const isDelivered = await harness.pool.publishAsync(own);
        await flushAsync();

        // Assert
        expect(isDelivered).toBe(true);
        expect(harness.network.relays.every(relay => relay.published.length === 1)).toBe(true);
        expect(harness.received).toEqual([]);
    });

    it('limits how many events one key gets checked', async () => {
        // Arrange
        const harness = await startedAsync();
        const signer = createNostrSigner(createSecretKey(random), random);
        const flood = Array.from({ length: 30 }, (_, index) => event(`flood ${index}`, signer));

        // Act
        for (const item of flood) {
            harness.network.relays[0]?.inject(item);
        }

        await flushAsync();

        // Assert
        expect(harness.received).toHaveLength(20);
        expect(harness.messages().some(message => message.startsWith('dropped relay events'))).toBe(true);
    });

    it('reports a publish as not delivered when every relay refuses it', async () => {
        // Arrange
        const harness = await startedAsync();
        for (const relay of harness.network.relays) {
            relay.refusal = 'blocked: test';
        }

        // Act
        const isDelivered = await harness.pool.publishAsync(event());

        // Assert
        expect(isDelivered).toBe(false);
    });

    it('counts a publish that went out but got no answer as delivered after 5 s', async () => {
        // Arrange
        const harness = await startedAsync();
        for (const relay of harness.network.relays) {
            relay.sendsOk = false;
        }

        // Act
        const publishing = harness.pool.publishAsync(event());
        await flushAsync();
        harness.clock.advance(5000);

        // Assert
        await expect(publishing).resolves.toBe(true);
    });

    it('reports a publish as not delivered when no relay was ever reached', async () => {
        // Arrange
        const harness = createHarness();
        for (const relay of harness.network.relays) {
            relay.kill();
        }

        harness.pool.start();

        // Act
        const publishing = harness.pool.publishAsync(event());
        await flushAsync();
        harness.clock.advance(5000);

        // Assert
        await expect(publishing).resolves.toBe(false);
        expect(harness.pool.isUnreachable).toBe(true);
        expect(harness.pool.openCount).toBe(0);
    });

    it('refuses to send an oversized event', async () => {
        // Arrange
        const harness = await startedAsync();

        // Act
        const isDelivered = await harness.pool.publishAsync(event('x'.repeat(17 * 1024)));

        // Assert
        expect(isDelivered).toBe(false);
        expect(harness.network.relays.every(relay => relay.published.length === 0)).toBe(true);
    });

    it('sends at once on open relays only for publishNow', async () => {
        // Arrange
        const harness = await startedAsync();
        harness.network.relays[2]?.kill();
        await flushAsync();

        // Act
        harness.pool.publishNow(event());
        await flushAsync();

        // Assert
        expect(harness.network.relays.map(relay => relay.published.length)).toEqual([1, 1, 0]);
    });

    it('is reachable while one relay is open, and reports each failure', async () => {
        // Arrange
        const harness = await startedAsync();

        // Act
        harness.network.relays[0]?.kill();
        harness.network.relays[1]?.kill();
        await flushAsync();

        // Assert
        expect(harness.pool.openCount).toBe(1);
        expect(harness.pool.isUnreachable).toBe(false);
        expect(harness.pool.isOpen(URLS[2] ?? '')).toBe(true);
        expect(harness.changes.filter(change => change.startsWith('failed'))).toEqual([
            `failed ${URLS[0]}`,
            `failed ${URLS[1]}`,
        ]);
    });

    it('pauses and resumes one relay', async () => {
        // Arrange
        const harness = await startedAsync();

        // Act
        harness.pool.pause(URLS[0] ?? '');
        const whilePaused = harness.pool.isOpen(URLS[0] ?? '');
        harness.pool.resume(URLS[0] ?? '');
        await flushAsync();

        // Assert
        expect(whilePaused).toBe(false);
        expect(harness.pool.isOpen(URLS[0] ?? '')).toBe(true);
    });

    it('closes everything on stop and settles pending publishes', async () => {
        // Arrange
        const harness = await startedAsync();
        for (const relay of harness.network.relays) {
            relay.sendsOk = false;
        }

        const publishing = harness.pool.publishAsync(event());

        // Act
        harness.pool.stop();
        await flushAsync();

        // Assert
        await expect(publishing).resolves.toBe(false);
        expect(harness.pool.openCount).toBe(0);
        expect(harness.network.socketsOf('device')).toEqual([]);
    });
});
