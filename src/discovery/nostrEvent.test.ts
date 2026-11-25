import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    computeEventId,
    createNostrSigner,
    createSecretKey,
    hasValidId,
    hasValidSignature,
    parseNostrEvent,
    readTag,
} from './nostrEvent.js';
import type { NostrEvent } from './nostrEvent.js';

const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));
const UNSIGNED = { createdAt: 1_795_000_000, kind: 25_050, tags: [['x', 'ab'.repeat(32)]], content: 'sealed' };

function signed(): NostrEvent {
    return createNostrSigner(createSecretKey(random), random).sign(UNSIGNED);
}

describe('createNostrSigner', () => {
    it('signs events whose id and signature check out', () => {
        // Act
        const event = signed();

        // Assert
        expect(event).toMatchObject({ created_at: UNSIGNED.createdAt, kind: 25_050, content: 'sealed' });
        expect(hasValidId(event)).toBe(true);
        expect(hasValidSignature(event)).toBe(true);
    });

    it('makes a new key for each signer', () => {
        // Act
        const first = createNostrSigner(createSecretKey(random), random).publicKey;
        const second = createNostrSigner(createSecretKey(random), random).publicKey;

        // Assert
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(second).not.toBe(first);
    });

    it('gives up on a random source that never yields a valid key', () => {
        // Act
        const create = (): unknown => createSecretKey(length => new Uint8Array(length));

        // Assert
        expect(create).toThrow();
    });
});

describe('computeEventId', () => {
    it('is the SHA-256 of the NIP-01 serialization', () => {
        // Arrange
        const pubkey = 'cd'.repeat(32);
        const content = 'line\nquote" back\\slash é';
        const serialized = JSON.stringify([0, pubkey, 1, 25_050, [['x', 'y']], content]);

        // Act
        const id = computeEventId({ pubkey, createdAt: 1, kind: 25_050, tags: [['x', 'y']], content });

        // Assert
        expect(id).toBe(createHash('sha256').update(serialized, 'utf8').digest('hex'));
    });
});

describe('hasValidId and hasValidSignature', () => {
    it('refuses changed content, a moved signature and a signature from another key', () => {
        // Arrange
        const event = signed();
        const other = signed();

        // Act
        const results = [
            hasValidId({ ...event, content: 'changed' }),
            hasValidSignature({ ...event, sig: other.sig }),
            hasValidSignature({ ...event, pubkey: other.pubkey }),
        ];

        // Assert
        expect(results).toEqual([false, false, false]);
    });
});

describe('parseNostrEvent', () => {
    it('keeps a well-formed event', () => {
        // Arrange
        const event = signed();

        // Act
        const parsed = parseNostrEvent(JSON.parse(JSON.stringify(event)));

        // Assert
        expect(parsed).toEqual(event);
        expect(readTag(event, 'x')).toBe('ab'.repeat(32));
        expect(readTag(event, 'p')).toBeUndefined();
    });

    it.each<[string, (event: NostrEvent) => unknown]>([
        ['not an object', () => 'event'],
        ['an upper-case id', event => ({ ...event, id: event.id.toUpperCase() })],
        ['a short signature', event => ({ ...event, sig: 'ab' })],
        ['a fractional time', event => ({ ...event, created_at: 1.5 })],
        ['a negative kind', event => ({ ...event, kind: -1 })],
        ['a tag that is not a list of strings', event => ({ ...event, tags: [['x', 1]] })],
        ['an empty tag', event => ({ ...event, tags: [[]] })],
        ['too many tags', event => ({ ...event, tags: Array.from({ length: 17 }, () => ['t', 'v']) })],
        ['oversized content', event => ({ ...event, content: 'x'.repeat(16 * 1024 + 1) })],
    ])('drops %s', (_, change) => {
        // Act
        const parsed = parseNostrEvent(change(signed()));

        // Assert
        expect(parsed).toBeUndefined();
    });
});
