import { describe, expect, it } from 'vitest';
import {
    INITIAL_STATE,
    LIMITS,
    handleMessage,
    isOriginAllowed,
    matchingSubscriptions,
    statusFromError,
    statusHeaders,
} from './relayRules.js';
import type { ConnectionState, NostrEvent } from './relayRules.js';

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const ROOM = 'a'.repeat(64);
const OTHER_ROOM = 'b'.repeat(64);
const PUBKEY = 'c'.repeat(64);

function createEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
    return {
        id: 'd'.repeat(64),
        pubkey: PUBKEY,
        created_at: NOW_SECONDS,
        kind: 21_000,
        tags: [['x', ROOM]],
        content: 'sealed',
        sig: 'e'.repeat(128),
        ...overrides,
    };
}

function send(state: ConnectionState, message: unknown, nowMs = NOW_MS): ReturnType<typeof handleMessage> {
    return handleMessage(state, JSON.stringify(message), nowMs);
}

function subscribed(filters: unknown[], subscriptionId = 'room'): ConnectionState {
    return send(INITIAL_STATE, ['REQ', subscriptionId, ...filters]).state;
}

describe('handleMessage: EVENT', () => {
    it('accepts an ephemeral event and hands it on for delivery', () => {
        // Arrange
        const event = createEvent();

        // Act
        const outcome = send(INITIAL_STATE, ['EVENT', event]);

        // Assert
        expect(outcome.replies).toEqual([['OK', event.id, true, '']]);
        expect(outcome.event).toEqual(event);
    });

    it('keeps only the NIP-01 fields of an event', () => {
        // Arrange
        const event = { ...createEvent(), extra: 'dropped' };

        // Act
        const outcome = send(INITIAL_STATE, ['EVENT', event]);

        // Assert
        expect(outcome.event).toEqual(createEvent());
    });

    it.each([1, 19_999, 30_000])('blocks kind %i, since only ephemeral events are taken', kind => {
        // Arrange
        const event = createEvent({ kind });

        // Act
        const outcome = send(INITIAL_STATE, ['EVENT', event]);

        // Assert
        expect(outcome.replies).toEqual([['OK', event.id, false, 'blocked: ephemeral events only']]);
        expect(outcome.event).toBeUndefined();
    });

    it.each([
        ['an id that is not 64 hex characters', { id: 'XYZ' }],
        ['a signature that is not 128 hex characters', { sig: 'f'.repeat(127) }],
        ['a tag that is not a list of strings', { tags: [['x', 5]] as unknown as string[][] }],
        ['content over the limit', { content: 'z'.repeat(LIMITS.contentLength + 1) }],
        ['a negative created_at', { created_at: -1 }],
    ])('refuses an event with %s', (_, overrides) => {
        // Arrange
        const event = createEvent(overrides);

        // Act
        const outcome = send(INITIAL_STATE, ['EVENT', event]);

        // Assert
        expect(outcome.replies[0]?.[0]).toBe('OK');
        expect(outcome.replies[0]?.[2]).toBe(false);
        expect(outcome.event).toBeUndefined();
    });

    it('refuses an event dated more than the allowed skew from the relay clock', () => {
        // Arrange
        const event = createEvent({ created_at: NOW_SECONDS - LIMITS.clockSkewSeconds - 1 });

        // Act
        const outcome = send(INITIAL_STATE, ['EVENT', event]);

        // Assert
        expect(outcome.replies).toEqual([['OK', event.id, false, 'invalid: created_at is too far from now']]);
    });
});

describe('handleMessage: REQ and CLOSE', () => {
    it('keeps a subscription and ends its stored events at once', () => {
        // Arrange
        const filter = { kinds: [21_000], '#x': [ROOM] };

        // Act
        const outcome = send(INITIAL_STATE, ['REQ', 'room', filter]);

        // Assert
        expect(outcome.replies).toEqual([['EOSE', 'room']]);
        expect(outcome.state.subscriptions.room).toEqual([{ kinds: [21_000], tags: { x: [ROOM] } }]);
    });

    it('replaces a subscription sent again under the same id', () => {
        // Arrange
        const state = subscribed([{ '#x': [ROOM] }]);

        // Act
        const outcome = send(state, ['REQ', 'room', { '#x': [OTHER_ROOM] }]);

        // Assert
        expect(Object.keys(outcome.state.subscriptions)).toEqual(['room']);
        expect(outcome.state.subscriptions.room).toEqual([{ tags: { x: [OTHER_ROOM] } }]);
    });

    it('closes a subscription past the per-connection limit', () => {
        // Arrange
        let state = INITIAL_STATE;
        for (let index = 0; index < LIMITS.subscriptions; index++) {
            state = send(state, ['REQ', `room-${index}`, { '#x': [ROOM] }]).state;
        }

        // Act
        const outcome = send(state, ['REQ', 'one-too-many', { '#x': [ROOM] }]);

        // Assert
        expect(outcome.replies).toEqual([['CLOSED', 'one-too-many', 'blocked: too many subscriptions']]);
        expect(outcome.state.subscriptions).not.toHaveProperty('one-too-many');
    });

    it.each([
        ['no filters', []],
        ['too many filters', Array.from({ length: LIMITS.filtersPerRequest + 1 }, () => ({ '#x': [ROOM] }))],
        ['an unsupported field', [{ search: 'ether' }]],
        ['a multi-letter tag', [{ '#xy': [ROOM] }]],
        ['an empty list', [{ kinds: [] }]],
    ])('closes a request with %s', (_, filters) => {
        // Act
        const outcome = send(INITIAL_STATE, ['REQ', 'room', ...filters]);

        // Assert
        expect(outcome.replies[0]?.[0]).toBe('CLOSED');
        expect(outcome.state.subscriptions).toEqual({});
    });

    it('drops a subscription on CLOSE', () => {
        // Arrange
        const state = subscribed([{ '#x': [ROOM] }]);

        // Act
        const outcome = send(state, ['CLOSE', 'room']);

        // Assert
        expect(outcome.state.subscriptions).toEqual({});
        expect(outcome.replies).toEqual([]);
    });
});

describe('handleMessage: limits and malformed input', () => {
    it.each([
        ['a binary message', undefined, 'invalid: text messages only'],
        ['text that is not JSON', '{', 'invalid: not JSON'],
        ['JSON that is not a list', '{}', 'invalid: not a relay message'],
        ['an unknown message type', '["AUTH","x"]', 'invalid: unknown message type'],
        ['a message over the size limit', `["EVENT","${'z'.repeat(LIMITS.messageLength)}"]`, 'invalid: message too large'],
    ])('answers %s with a notice', (_, text, notice) => {
        // Act
        const outcome = handleMessage(INITIAL_STATE, text, NOW_MS);

        // Assert
        expect(outcome.replies).toEqual([['NOTICE', notice]]);
    });

    it('drops messages past the per-window limit and takes them again in the next window', () => {
        // Arrange
        let state = INITIAL_STATE;
        for (let index = 0; index < LIMITS.messagesPerWindow; index++) {
            state = send(state, ['EVENT', createEvent()]).state;
        }

        // Act
        const limited = send(state, ['EVENT', createEvent()]);
        const later = send(limited.state, ['EVENT', createEvent()], NOW_MS + LIMITS.windowMs);

        // Assert
        expect(limited.replies).toEqual([['NOTICE', 'rate-limited: slow down']]);
        expect(limited.event).toBeUndefined();
        expect(later.event).toEqual(createEvent());
    });
});

describe('matchingSubscriptions', () => {
    it('finds the subscriptions whose room tag and kind match', () => {
        // Arrange
        let state = subscribed([{ kinds: [21_000], '#x': [ROOM] }], 'mine');
        state = send(state, ['REQ', 'other-room', { '#x': [OTHER_ROOM] }]).state;
        state = send(state, ['REQ', 'other-kind', { kinds: [22_000], '#x': [ROOM] }]).state;

        // Act
        const matches = matchingSubscriptions(state, createEvent());

        // Assert
        expect(matches).toEqual(['mine']);
    });

    it('matches when any one filter of a subscription matches', () => {
        // Arrange
        const state = subscribed([{ '#x': [OTHER_ROOM] }, { authors: [PUBKEY] }]);

        // Act
        const matches = matchingSubscriptions(state, createEvent());

        // Assert
        expect(matches).toEqual(['room']);
    });

    it.each([
        ['since after the event', { since: NOW_SECONDS + 1 }, false],
        ['since at the event', { since: NOW_SECONDS }, true],
        ['until before the event', { until: NOW_SECONDS - 1 }, false],
        ['another author', { authors: ['0'.repeat(64)] }, false],
        ['its id', { ids: ['d'.repeat(64)] }, true],
    ])('applies a filter with %s', (_, filter, isMatch) => {
        // Arrange
        const state = subscribed([filter]);

        // Act
        const matches = matchingSubscriptions(state, createEvent());

        // Assert
        expect(matches.length === 1).toBe(isMatch);
    });
});

describe('isOriginAllowed', () => {
    const ALLOWED = 'https://efthymios-ks.github.io http://localhost http://127.0.0.1';

    it.each([
        ['the GitHub Pages origin', 'https://efthymios-ks.github.io', true],
        ['localhost on any port', 'http://localhost:5173', true],
        ['127.0.0.1 on any port', 'http://127.0.0.1:5299', true],
        ['another site', 'https://example.com', false],
        ['a look-alike host', 'https://efthymios-ks.github.io.example.com', false],
        ['the right host over http', 'http://efthymios-ks.github.io', false],
        ['no origin', null, false],
        ['an opaque origin', 'null', false],
        ['a computer on the home network, over https', 'https://192.168.1.20:5443', true],
        ['a 10.x network address', 'https://10.0.0.5:5443', true],
        ['a 172.16-31.x network address', 'http://172.20.1.2:8080', true],
        ['a public address', 'https://203.0.113.9', false],
        ['an address just outside 172.16-31', 'https://172.32.0.1', false],
        ['a dev tunnel', 'https://abc123-5443.euw.devtunnels.ms', false],
    ])('answers %s', (_, origin, isAllowed) => {
        // Act
        const result = isOriginAllowed(origin, ALLOWED);

        // Assert
        expect(result).toBe(isAllowed);
    });
});

describe('statusFromError', () => {
    it.each([
        ['a used-up free tier', new Error('Exceeded allowed volume of requests in Durable Objects free tier.'), 'limit'],
        ['a daily limit', new Error('Daily request limit reached'), 'limit'],
        ['any other fault', new Error('Network connection lost.'), 'error'],
        ['a thrown string', 'boom', 'error'],
    ])('reads %s', (_, error, status) => {
        // Act
        const result = statusFromError(error);

        // Assert
        expect(result).toBe(status);
    });
});

describe('statusHeaders', () => {
    it('lets only the asking origin read the answer, and never from a cache', () => {
        // Act
        const headers = statusHeaders('https://efthymios-ks.github.io');

        // Assert
        expect(headers).toMatchObject({
            'Access-Control-Allow-Origin': 'https://efthymios-ks.github.io',
            'Cache-Control': 'no-store',
            Vary: 'Origin',
        });
    });
});
