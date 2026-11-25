import { describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { FakeClock } from '../network/fakeEnvironment.js';
import { FakeRelayNetwork } from './fakeRelay.js';
import type { FakeRelay } from './fakeRelay.js';
import { createRelayConnection, MAX_INCOMING_FRAME_CHARS } from './relayConnection.js';
import type { RelayConnection, RelaySocketFactory } from './relayConnection.js';

const URL = 'wss://relay.test';
const EVENT_JSON = JSON.stringify({ id: 'a'.repeat(64), kind: 25_050, tags: [['x', 'room']], created_at: 100 });

interface Harness {
    readonly connection: RelayConnection;
    readonly clock: FakeClock;
    readonly relay: FakeRelay;
    readonly network: FakeRelayNetwork;
    readonly events: unknown[];
    readonly results: [string, boolean][];
    readonly calls: string[];
    readonly sockets: number[];
    messages(): string[];
}

function createHarness(options: { readonly createSocket?: RelaySocketFactory } = {}): Harness {
    const clock = new FakeClock();
    const network = new FakeRelayNetwork([URL]);
    const memory = createMemorySink(500);
    const { logger } = createLogger({
        sinks: [memory],
        routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
        now: clock.now,
    });
    const factory = network.socketFactory('device');
    const sockets: number[] = [];
    const harness: Omit<Harness, 'connection'> = {
        clock,
        relay: network.relay(URL),
        network,
        events: [],
        results: [],
        calls: [],
        sockets,
        messages: () => memory.entries().map(entry => entry.msg),
    };
    const connection = createRelayConnection({
        url: URL,
        createSocket: options.createSocket ?? ((url, handlers) => {
            sockets.push(clock.time);

            return factory(url, handlers);
        }),
        clock: {
            now: clock.now,
            setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
            clearTimeout: handle => clock.clear(handle),
            random: () => 0.5,
        },
        logger,
        onEvent: event => harness.events.push(event),
        onPublishResult: (eventId, isAccepted) => harness.results.push([eventId, isAccepted]),
        onStateChange: () => undefined,
        onOpened: () => harness.calls.push('opened'),
        onFailed: () => harness.calls.push('failed'),
    });

    return { ...harness, connection };
}

async function flushAsync(): Promise<void> {
    for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve();
    }
}

function frames(relay: FakeRelay): unknown[][] {
    return relay.frames.map(frame => JSON.parse(frame) as unknown[]);
}

describe('createRelayConnection', () => {
    it('opens, then subscribes with a fresh filter on every connect', async () => {
        // Arrange
        const harness = createHarness();
        let since = 100;
        harness.connection.setFilter(() => ({ kinds: [25_050], '#x': ['room'], since: since++ }));

        // Act
        harness.connection.connect();
        await flushAsync();
        harness.relay.kill();
        harness.relay.revive();
        await flushAsync();
        harness.clock.advance(1000);
        await flushAsync();

        // Assert
        expect(harness.connection.state).toBe('open');
        expect(frames(harness.relay).filter(frame => frame[0] === 'REQ')).toEqual([
            ['REQ', 'nearby-1', { kinds: [25_050], '#x': ['room'], since: 100 }],
            ['REQ', 'nearby-2', { kinds: [25_050], '#x': ['room'], since: 101 }],
        ]);
        expect(harness.calls).toEqual(['opened', 'failed', 'opened']);
    });

    it('closes the old subscription before opening one for a new filter', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.setFilter(() => ({ kinds: [1] }));
        harness.connection.connect();
        await flushAsync();

        // Act
        harness.connection.setFilter(() => ({ kinds: [2] }));
        await flushAsync();

        // Assert
        expect(frames(harness.relay).slice(-2)).toEqual([['CLOSE', 'nearby-1'], ['REQ', 'nearby-2', { kinds: [2] }]]);
        expect(harness.relay.subscriptionCount).toBe(1);
    });

    it('passes on events for its subscription only, and reports OK answers', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.setFilter(() => ({ kinds: [25_050] }));
        harness.connection.connect();
        await flushAsync();

        // Act
        harness.relay.broadcast(JSON.stringify(['EVENT', 'nearby-1', { id: 'one' }]));
        harness.relay.broadcast(JSON.stringify(['EVENT', 'someone-else', { id: 'two' }]));
        harness.relay.broadcast(JSON.stringify(['OK', 'abc', false, 'blocked: test']));
        harness.relay.broadcast(JSON.stringify(['NOTICE', 'rate-limited: slow down']));
        await flushAsync();

        // Assert
        expect(harness.events).toEqual([{ id: 'one' }]);
        expect(harness.results).toEqual([['abc', false]]);
        expect(harness.messages()).toContain(`relay ${URL} refused an event: blocked: test`);
        expect(harness.messages()).toContain(`relay ${URL} notice: rate-limited: slow down`);
    });

    it('drops what the relay replays before EOSE, its stored history', async () => {
        // Arrange
        const harness = createHarness();
        harness.relay.storesEvents = true;
        harness.relay.published.push({
            id: 'a'.repeat(64),
            pubkey: 'b'.repeat(64),
            created_at: 100,
            kind: 25_050,
            tags: [],
            content: 'old',
            sig: 'c'.repeat(128),
        });
        harness.connection.setFilter(() => ({ kinds: [25_050] }));

        // Act
        harness.connection.connect();
        await flushAsync();
        harness.relay.broadcast(JSON.stringify(['EVENT', 'nearby-1', { id: 'live' }]));
        await flushAsync();

        // Assert
        expect(harness.events).toEqual([{ id: 'live' }]);
        expect(harness.messages()).toContain(`relay ${URL} subscribed; skipped 1 stored event(s)`);
    });

    it('takes the subscription as live 5 s after a REQ that got no EOSE', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.setFilter(() => ({ kinds: [25_050] }));
        harness.connection.connect();
        await flushAsync();
        harness.connection.setFilter(() => ({ kinds: [1] }));
        harness.relay.broadcast(JSON.stringify(['EVENT', 'nearby-2', { id: 'early' }]));
        await flushAsync();

        // Act
        harness.clock.advance(5000);
        harness.relay.broadcast(JSON.stringify(['EVENT', 'nearby-2', { id: 'late' }]));
        await flushAsync();

        // Assert
        expect(harness.events).toEqual([{ id: 'late' }]);
    });

    it('drops frames that are too large, not text, or not a JSON array', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.setFilter(() => ({ kinds: [25_050] }));
        harness.connection.connect();
        await flushAsync();

        // Act
        harness.relay.broadcast(JSON.stringify(['EVENT', 'nearby-1', { pad: 'x'.repeat(MAX_INCOMING_FRAME_CHARS) }]));
        harness.relay.broadcast('{"not":"an array"}');
        harness.relay.broadcast('not json');
        await flushAsync();

        // Assert
        expect(harness.events).toEqual([]);
        expect(harness.connection.state).toBe('open');
    });

    it('sends events at once when open, and queues them briefly while connecting', async () => {
        // Arrange
        const harness = createHarness();

        // Act
        harness.connection.connect();
        const isQueued = harness.connection.publish(EVENT_JSON, 5000);
        harness.connection.publish('{"stale":true}', -1);
        await flushAsync();
        harness.connection.publish(EVENT_JSON, 0);
        await flushAsync();

        // Assert
        expect(isQueued).toBe(true);
        expect(harness.relay.frames).toEqual([`["EVENT",${EVENT_JSON}]`, `["EVENT",${EVENT_JSON}]`]);
    });

    it('backs off after failures: 1 s, 3 s, 10 s', async () => {
        // Arrange
        const harness = createHarness();
        harness.relay.kill();

        // Act
        harness.connection.connect();
        await flushAsync();
        for (const step of [1000, 3000, 10_000]) {
            harness.clock.advance(step);
            await flushAsync();
        }

        // Assert
        expect(harness.sockets).toEqual([0, 1000, 4000, 14_000]);
        expect(harness.connection.state).toBe('waiting');
        expect(harness.connection.hasFailed).toBe(true);
        expect(harness.calls).toEqual(['failed', 'failed', 'failed', 'failed']);
    });

    it('starts the backoff over after a connection that stayed up', async () => {
        // Arrange
        const harness = createHarness();
        harness.relay.kill();
        harness.connection.connect();
        await flushAsync();
        harness.clock.advance(1000);
        await flushAsync();
        harness.relay.revive();
        harness.clock.advance(3000);
        await flushAsync();

        // Act
        harness.clock.advance(30_000);
        harness.relay.kill();
        harness.relay.revive();
        await flushAsync();
        harness.clock.advance(1000);
        await flushAsync();

        // Assert
        expect(harness.sockets).toEqual([0, 1000, 4000, 35_000]);
        expect(harness.connection.state).toBe('open');
    });

    it('gives up on a socket that does not open within 10 s', async () => {
        // Arrange
        const harness = createHarness({ createSocket: () => ({ send: () => undefined, close: () => undefined }) });

        // Act
        harness.connection.connect();
        harness.clock.advance(10_000);

        // Assert
        expect(harness.connection.state).toBe('waiting');
        expect(harness.messages()).toContain(`relay ${URL} no answer within 10 s`);
    });

    it('retries in 5 minutes when the relay refuses the subscription', async () => {
        // Arrange
        const harness = createHarness();
        harness.relay.subscriptionRefusal = 'auth-required: test';
        harness.connection.setFilter(() => ({ kinds: [1] }));

        // Act
        harness.connection.connect();
        await flushAsync();
        harness.relay.subscriptionRefusal = undefined;
        harness.clock.advance(5 * 60_000 * 0.99);
        await flushAsync();
        const stateBefore = harness.connection.state;
        harness.clock.advance(5 * 60_000 * 0.02);
        await flushAsync();

        // Assert
        expect(stateBefore).toBe('waiting');
        expect(harness.connection.state).toBe('open');
        expect(harness.messages()).toContain(`relay ${URL} closed the subscription: auth-required: test`);
    });

    it('reconnects a socket that has heard nothing for 100 s', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.connect();
        await flushAsync();

        // Act
        harness.clock.advance(100_000);
        await flushAsync();
        harness.clock.advance(1000);
        await flushAsync();

        // Assert
        expect(harness.sockets).toEqual([0, 101_000]);
        expect(harness.connection.state).toBe('open');
    });

    it('disconnects while offline without counting a failure, and reconnects at once when asked', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.connect();
        await flushAsync();

        // Act
        harness.connection.disconnect();
        const stateOffline = harness.connection.state;
        harness.connection.reconnectNow();
        await flushAsync();

        // Assert
        expect(stateOffline).toBe('waiting');
        expect(harness.connection.state).toBe('open');
        expect(harness.calls).toEqual(['opened', 'opened']);
    });

    it('stays paused until resumed, whatever reconnectNow says', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.connect();
        await flushAsync();

        // Act
        harness.connection.pause();
        harness.connection.reconnectNow();
        harness.clock.advance(60 * 60_000);
        await flushAsync();
        const stateWhilePaused = harness.connection.state;
        harness.connection.resume();
        await flushAsync();

        // Assert
        expect(stateWhilePaused).toBe('waiting');
        expect(harness.sockets).toEqual([0, 3_600_000]);
        expect(harness.connection.state).toBe('open');
    });

    it('stops for good', async () => {
        // Arrange
        const harness = createHarness();
        harness.connection.connect();
        await flushAsync();

        // Act
        harness.connection.stop();
        harness.connection.connect();
        const isPublished = harness.connection.publish(EVENT_JSON, 5000);
        harness.clock.advance(600_000);
        await flushAsync();

        // Assert
        expect(harness.connection.state).toBe('stopped');
        expect(isPublished).toBe(false);
        expect(harness.relay.sockets.size).toBe(0);
        expect(harness.sockets).toEqual([0]);
    });

    it('retries when the browser refuses to create the socket', () => {
        // Arrange
        const harness = createHarness({
            createSocket: () => {
                throw new DOMException('Refused by the Content Security Policy', 'SecurityError');
            },
        });

        // Act
        harness.connection.connect();

        // Assert
        expect(harness.connection.state).toBe('waiting');
        expect(harness.messages()).toContain(`relay ${URL} refused by the browser`);
    });
});
