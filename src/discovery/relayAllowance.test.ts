import { describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { FakeClock } from '../network/fakeEnvironment.js';
import type { RelayAllowanceNotice } from './discoveryTypes.js';
import {
    AFTER_RESET_MS,
    createRelayAllowanceMonitor,
    nextUtcMidnight,
    RECHECK_MS,
    toStatusUrl,
} from './relayAllowance.js';
import type { RelayAllowanceMonitor } from './relayAllowance.js';

const OWN = 'wss://ether-relay.example.workers.dev';
const PUBLIC = 'wss://relay.example.org';
const STATUS_URL = 'https://ether-relay.example.workers.dev/status';
// 25 Nov 2026, 12:00 UTC.
const NOON = Date.UTC(2026, 10, 25, 12, 0, 0);
const NEXT_MIDNIGHT = Date.UTC(2026, 10, 26, 0, 0, 0);

type Answer = { readonly status: number; readonly body?: unknown } | 'throw';

interface Harness {
    readonly monitor: RelayAllowanceMonitor;
    readonly clock: FakeClock;
    readonly requests: { readonly url: string; readonly init: RequestInit }[];
    readonly notices: (RelayAllowanceNotice | undefined)[];
    readonly paused: string[];
    readonly resumed: string[];
    answer: Answer;
    isInternetWorking: boolean;
    messages(): string[];
}

function createHarness(start = NOON): Harness {
    const clock = new FakeClock();
    const memory = createMemorySink(500);
    const { logger } = createLogger({
        sinks: [memory],
        routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
        now: clock.now,
    });
    const harness: Omit<Harness, 'monitor'> & { monitor?: RelayAllowanceMonitor } = {
        clock,
        requests: [],
        notices: [],
        paused: [],
        resumed: [],
        answer: { status: 200, body: { status: 'ok' } },
        isInternetWorking: true,
        messages: () => memory.entries().map(entry => entry.msg),
    };
    harness.monitor = createRelayAllowanceMonitor({
        ownUrls: [OWN],
        fetchAsync: async (url, init) => {
            harness.requests.push({ url, init });
            const answer = harness.answer;
            if (answer === 'throw') {
                throw new TypeError('Failed to fetch');
            }

            return Response.json(answer.body ?? null, { status: answer.status });
        },
        clock: {
            now: clock.now,
            wallClock: () => start + clock.time,
            setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
            clearTimeout: handle => clock.clear(handle),
        },
        logger,
        isInternetWorking: () => harness.isInternetWorking,
        pauseRelay: url => harness.paused.push(url),
        resumeRelay: url => harness.resumed.push(url),
        onChange: notice => harness.notices.push(notice),
    });

    return harness as Harness;
}

async function settleAsync(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

async function failTwiceAsync(harness: Harness): Promise<void> {
    harness.monitor.relayFailed(OWN);
    harness.monitor.relayFailed(OWN);
    await settleAsync();
}

describe('createRelayAllowanceMonitor', () => {
    it('checks the status only after two failures in a row, without caching', async () => {
        // Arrange
        const harness = createHarness();

        // Act
        harness.monitor.relayFailed(OWN);
        await settleAsync();
        const afterOne = harness.requests.length;
        harness.monitor.relayFailed(OWN);
        await settleAsync();

        // Assert
        expect(afterOne).toBe(0);
        expect(harness.requests).toHaveLength(1);
        expect(harness.requests[0]?.url).toBe(STATUS_URL);
        expect(harness.requests[0]?.init).toMatchObject({ cache: 'no-store', credentials: 'omit' });
    });

    it('starts counting again after the relay opens', async () => {
        // Arrange
        const harness = createHarness();

        // Act
        harness.monitor.relayFailed(OWN);
        harness.monitor.relayOpened(OWN);
        harness.monitor.relayFailed(OWN);
        await settleAsync();

        // Assert
        expect(harness.requests).toEqual([]);
    });

    it('ignores the public relays', async () => {
        // Arrange
        const harness = createHarness();

        // Act
        harness.monitor.relayFailed(PUBLIC);
        harness.monitor.relayFailed(PUBLIC);
        harness.monitor.relayFailed(PUBLIC);
        await settleAsync();

        // Assert
        expect(harness.requests).toEqual([]);
    });

    it('treats status ok as a passing failure: no notice, and two more failures before the next check', async () => {
        // Arrange
        const harness = createHarness();

        // Act
        await failTwiceAsync(harness);
        harness.monitor.relayFailed(OWN);
        await settleAsync();

        // Assert
        expect(harness.notices).toEqual([]);
        expect(harness.requests).toHaveLength(1);
        expect(harness.monitor.notice).toBeUndefined();
    });

    it('raises a certain notice for status limit, until the next 00:00 UTC, and pauses the relay', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = { status: 503, body: { status: 'limit' } };

        // Act
        await failTwiceAsync(harness);

        // Assert
        const notice = { relayUrl: OWN, isCertain: true, resetsAt: NEXT_MIDNIGHT };
        expect(harness.notices).toEqual([notice]);
        expect(harness.monitor.notice).toEqual(notice);
        expect(harness.paused).toEqual([OWN]);
        expect(harness.messages().some(message => message.includes('out of its free allowance'))).toBe(true);
    });

    it('logs status error and raises no notice', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = { status: 503, body: { status: 'error' } };

        // Act
        await failTwiceAsync(harness);

        // Assert
        expect(harness.notices).toEqual([]);
        expect(harness.paused).toEqual([]);
        expect(harness.messages()).toContain(`own relay ${OWN} status error: not its allowance`);
    });

    it('leaves a relay that refuses the page address alone for good, with no notice', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = { status: 403, body: { status: 'forbidden' } };

        // Act
        await failTwiceAsync(harness);
        await failTwiceAsync(harness);

        // Assert
        expect(harness.notices).toEqual([]);
        expect(harness.monitor.notice).toBeUndefined();
        expect(harness.paused).toEqual([OWN]);
        expect(harness.requests).toHaveLength(1);
    });

    it('raises an uncertain notice when the check gets no readable answer while the internet works', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = 'throw';

        // Act
        await failTwiceAsync(harness);

        // Assert
        expect(harness.notices).toEqual([{ relayUrl: OWN, isCertain: false, resetsAt: NEXT_MIDNIGHT }]);
    });

    it('raises nothing when the check gets no answer and the internet is down', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = 'throw';
        harness.isInternetWorking = false;

        // Act
        await failTwiceAsync(harness);

        // Assert
        expect(harness.notices).toEqual([]);
        expect(harness.paused).toEqual([]);
    });

    it('checks again every 10 minutes and clears the notice once the status is ok', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = { status: 503, body: { status: 'limit' } };
        await failTwiceAsync(harness);

        // Act
        harness.clock.advance(RECHECK_MS);
        await settleAsync();
        const stillOut = [...harness.notices];
        harness.answer = { status: 200, body: { status: 'ok' } };
        harness.clock.advance(RECHECK_MS);
        await settleAsync();

        // Assert
        expect(stillOut).toHaveLength(1);
        expect(harness.requests).toHaveLength(3);
        expect(harness.notices.at(-1)).toBeUndefined();
        expect(harness.monitor.notice).toBeUndefined();
        expect(harness.resumed).toEqual([OWN]);
    });

    it('checks right after the reset when that comes before the next 10 minutes', async () => {
        // Arrange
        const harness = createHarness(Date.UTC(2026, 10, 25, 23, 57, 0));
        harness.answer = { status: 503, body: { status: 'limit' } };
        await failTwiceAsync(harness);

        // Act
        harness.answer = { status: 200, body: { status: 'ok' } };
        harness.clock.advance(3 * 60_000 + AFTER_RESET_MS - 1);
        await settleAsync();
        const before = harness.requests.length;
        harness.clock.advance(1);
        await settleAsync();

        // Assert
        expect(before).toBe(1);
        expect(harness.requests).toHaveLength(2);
        expect(harness.monitor.notice).toBeUndefined();
    });

    it('clears the notice when the relay connects again', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = { status: 503, body: { status: 'limit' } };
        await failTwiceAsync(harness);

        // Act
        harness.monitor.relayOpened(OWN);

        // Assert
        expect(harness.notices).toEqual([{ relayUrl: OWN, isCertain: true, resetsAt: NEXT_MIDNIGHT }, undefined]);
    });

    it('turns an uncertain notice certain when the status later says limit', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = 'throw';
        await failTwiceAsync(harness);

        // Act
        harness.answer = { status: 503, body: { status: 'limit' } };
        harness.clock.advance(RECHECK_MS);
        await settleAsync();

        // Assert
        expect(harness.notices.map(notice => notice?.isCertain)).toEqual([false, true]);
        expect(harness.paused).toEqual([OWN]);
    });

    it('forgets the notice on stop and checks nothing after', async () => {
        // Arrange
        const harness = createHarness();
        harness.answer = { status: 503, body: { status: 'limit' } };
        await failTwiceAsync(harness);

        // Act
        harness.monitor.stop();
        harness.clock.advance(RECHECK_MS * 3);
        await settleAsync();

        // Assert
        expect(harness.notices.at(-1)).toBeUndefined();
        expect(harness.requests).toHaveLength(1);
    });
});

describe('toStatusUrl', () => {
    it.each([
        ['wss://ether-relay.example.workers.dev', 'https://ether-relay.example.workers.dev/status'],
        ['wss://relay.example.org:8443/nostr?x=1', 'https://relay.example.org:8443/status'],
    ])('maps %s to %s', (relayUrl, expected) => {
        // Act
        const url = toStatusUrl(relayUrl);

        // Assert
        expect(url).toBe(expected);
    });
});

describe('nextUtcMidnight', () => {
    it('is the next 00:00 UTC, a whole day ahead at midnight itself', () => {
        // Act
        const fromNoon = nextUtcMidnight(NOON);
        const fromMidnight = nextUtcMidnight(NEXT_MIDNIGHT);

        // Assert
        expect(fromNoon).toBe(NEXT_MIDNIGHT);
        expect(fromMidnight).toBe(Date.UTC(2026, 10, 27, 0, 0, 0));
    });
});
