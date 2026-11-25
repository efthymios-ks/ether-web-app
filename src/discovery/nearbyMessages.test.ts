import { describe, expect, it } from 'vitest';
import {
    isValidCode,
    isValidId,
    MAX_REQUEST_TTL_MS,
    MIN_REQUEST_TTL_MS,
    parseDirectMessage,
    parseRoomMessage,
    sanitizeName,
    serializeDirectMessage,
    serializeRoomMessage,
} from './nearbyMessages.js';
import type { DirectMessage, RoomMessage } from './nearbyMessages.js';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const OTHER_ID = 'ZyXwVuTsRqPoNmLkJiHgFe';
const RUN = 'RuNrUnRuNrUnRuNrUnRuN0';
const KEY = `B${'A'.repeat(86)}`;
const CODE = 'AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYUCULBOGAZDINRYHI6D4QA';
const PROOF = 'P'.repeat(43);

describe('parseRoomMessage', () => {
    it.each<[string, RoomMessage]>([
        ['presence', { t: 'here', from: ID, run: RUN, name: 'Laptop', device: 'desktop', key: KEY }],
        ['a joining presence', { t: 'here', from: ID, run: RUN, name: 'L', device: 'phone', key: KEY, joined: true }],
        ['a presence with its platform', { t: 'here', from: ID, run: RUN, name: 'Swift Perseus', device: 'tablet', platform: 'iPad', key: KEY }],
        ['a presence of a device with a PIN', { t: 'here', from: ID, run: RUN, name: 'Calm Athena', device: 'phone', key: KEY, pin: true }],
        ['a goodbye', { t: 'bye', from: ID, run: RUN }],
        ['a direct envelope', { t: 'direct', from: ID, run: RUN, to: OTHER_ID, key: KEY, box: 'A'.repeat(40) }],
    ])('reads back %s', (_, message) => {
        // Act
        const parsed = parseRoomMessage(serializeRoomMessage(message));

        // Assert
        expect(parsed).toEqual(message);
    });

    it('ignores unknown fields and falls back to desktop for an unknown device type', () => {
        // Arrange
        const fields = { v: 2, t: 'here', from: ID, run: RUN, name: 'Fridge', device: 'fridge', key: KEY };
        const text = JSON.stringify({ ...fields, extra: [1] });

        // Act
        const parsed = parseRoomMessage(text);

        // Assert
        expect(parsed).toEqual({ t: 'here', from: ID, run: RUN, name: 'Fridge', device: 'desktop', key: KEY });
    });

    it('leaves out a platform this build does not know, and keeps the presence', () => {
        // Arrange
        const presence = { v: 1, t: 'here', from: ID, run: RUN, device: 'phone', key: KEY };
        const text = JSON.stringify({ ...presence, name: 'Watch', platform: 'WatchOS' });
        const wrongType = JSON.stringify({ ...presence, name: 'Odd', platform: 7 });

        // Act
        const parsed = parseRoomMessage(text);
        const parsedWrongType = parseRoomMessage(wrongType);

        // Assert
        expect(parsed).toEqual({ t: 'here', from: ID, run: RUN, name: 'Watch', device: 'phone', key: KEY });
        expect(parsedWrongType).toEqual({ t: 'here', from: ID, run: RUN, name: 'Odd', device: 'phone', key: KEY });
    });

    it('says a device has a PIN only for pin: true, so an older or odd value lists it without one', () => {
        // Arrange
        const presence = { v: 1, t: 'here', from: ID, run: RUN, name: 'Hera', device: 'phone', key: KEY };
        const texts = [presence, { ...presence, pin: 'true' }, { ...presence, pin: '1234' }, { ...presence, pin: 1 }]
            .map(fields => JSON.stringify(fields));

        // Act
        const parsed = texts.map(text => parseRoomMessage(text));

        // Assert
        for (const message of parsed) {
            expect(message).toEqual({ t: 'here', from: ID, run: RUN, name: 'Hera', device: 'phone', key: KEY });
        }
    });

    it.each([
        ['not JSON', 'nope'],
        ['an array', '[1]'],
        ['no version', JSON.stringify({ t: 'bye', from: ID, run: RUN })],
        ['version 0', JSON.stringify({ v: 0, t: 'bye', from: ID, run: RUN })],
        ['a short id', JSON.stringify({ v: 1, t: 'bye', from: 'abc', run: RUN })],
        ['no run', JSON.stringify({ v: 1, t: 'bye', from: ID })],
        ['an unknown type', JSON.stringify({ v: 1, t: 'shout', from: ID, run: RUN })],
        ['an inherited type', JSON.stringify({ v: 1, t: 'constructor', from: ID, run: RUN })],
        ['presence without a name', JSON.stringify({ v: 1, t: 'here', from: ID, run: RUN, name: ' \n ', key: KEY })],
        ['presence with a bad key', JSON.stringify({ v: 1, t: 'here', from: ID, run: RUN, name: 'A', key: 'x' })],
        ['a direct envelope without a box', JSON.stringify({ v: 1, t: 'direct', from: ID, run: RUN, key: KEY })],
        ['an oversized message', JSON.stringify({ v: 1, t: 'bye', from: ID, run: RUN, pad: 'x'.repeat(5000) })],
    ])('drops %s', (_, text) => {
        // Act
        const parsed = parseRoomMessage(text);

        // Assert
        expect(parsed).toBeUndefined();
    });
});

describe('parseDirectMessage', () => {
    it.each<[string, DirectMessage]>([
        ['a request', { t: 'request', id: ID, offer: CODE, ttl: 60_000, name: 'Phone', device: 'phone' }],
        ['a request with a PIN proof', { t: 'request', id: ID, offer: CODE, ttl: 60_000, name: 'P', device: 'phone', proof: PROOF }],
        ['an accept', { t: 'accept', id: ID, answer: CODE }],
        ['a decline', { t: 'decline', id: ID, reason: 'declined' }],
        ['a busy answer', { t: 'decline', id: ID, reason: 'busy' }],
        ['a PIN is needed', { t: 'decline', id: ID, reason: 'pin-required' }],
        ['a wrong PIN', { t: 'decline', id: ID, reason: 'wrong-pin' }],
        ['a cancel', { t: 'cancel', id: ID }],
    ])('reads back %s', (_, message) => {
        // Act
        const parsed = parseDirectMessage(serializeDirectMessage(message));

        // Assert
        expect(parsed).toEqual(message);
    });

    it('leaves out a proof that is not a base64url HMAC, and keeps the request', () => {
        // Arrange
        const request = { t: 'request', id: ID, offer: CODE, ttl: 60_000, name: 'P', device: 'phone' };
        const texts = [`${PROOF}A`, PROOF.slice(1), `${PROOF.slice(1)}+`, 1234]
            .map(proof => JSON.stringify({ ...request, proof }));

        // Act
        const parsed = texts.map(text => parseDirectMessage(text));

        // Assert
        for (const message of parsed) {
            expect(message).toEqual(request);
        }
    });

    it('reads a reason it does not know as declined', () => {
        // Act
        const parsed = parseDirectMessage(JSON.stringify({ t: 'decline', id: ID, reason: 'on-holiday' }));

        // Assert
        expect(parsed).toEqual({ t: 'decline', id: ID, reason: 'declined' });
    });

    it('clamps the request lifetime', () => {
        // Arrange
        const request = (ttl: number): string => JSON.stringify({ t: 'request', id: ID, offer: CODE, ttl, name: 'P' });

        // Act
        const short = parseDirectMessage(request(10));
        const long = parseDirectMessage(request(86_400_000));

        // Assert
        expect(short).toMatchObject({ ttl: MIN_REQUEST_TTL_MS });
        expect(long).toMatchObject({ ttl: MAX_REQUEST_TTL_MS });
    });

    it.each([
        ['a request with spaces in the code', { t: 'request', id: ID, offer: 'A B', ttl: 1000, name: 'P' }],
        ['a request with an oversized code', { t: 'request', id: ID, offer: 'A'.repeat(2049), ttl: 1000, name: 'P' }],
        ['a request without a lifetime', { t: 'request', id: ID, offer: CODE, name: 'P' }],
        ['an accept without an answer', { t: 'accept', id: ID }],
        ['a message without an id', { t: 'cancel' }],
    ])('drops %s', (_, message) => {
        // Act
        const parsed = parseDirectMessage(JSON.stringify(message));

        // Assert
        expect(parsed).toBeUndefined();
    });
});

describe('sanitizeName', () => {
    it.each([
        ['trims and collapses spaces', '  Kitchen   tablet ', 'Kitchen tablet'],
        ['turns controls and direction marks into spaces', 'Evil\u202eeman\u0007', 'Evil eman'],
        ['keeps 32 characters, counting emoji as one', '📱'.repeat(40), '📱'.repeat(32)],
    ])('%s', (_, input, expected) => {
        // Act
        const name = sanitizeName(input);

        // Assert
        expect(name).toBe(expected);
    });

    it.each([
        ['empty', ''],
        ['only controls', '\u0000\u0001'],
        ['not text', 42],
    ])('refuses a name that is %s', (_, input) => {
        // Act
        const name = sanitizeName(input);

        // Assert
        expect(name).toBeUndefined();
    });
});

describe('isValidCode and isValidId', () => {
    it('accepts codes and URLs, refuses spaces and huge text', () => {
        // Act
        const results = [
            isValidCode(CODE),
            isValidCode(`https://example.github.io/ether-web-app/#${CODE}`),
            isValidCode('two words'),
            isValidCode('A'.repeat(2049)),
            isValidCode(42),
        ];

        // Assert
        expect(results).toEqual([true, true, false, false, false]);
    });

    it('accepts base64url ids of 16 to 64 characters', () => {
        // Act
        const results = [isValidId(ID), isValidId('short'), isValidId('a+b/c'.repeat(5)), isValidId('A'.repeat(65))];

        // Assert
        expect(results).toEqual([true, false, false, false]);
    });
});
