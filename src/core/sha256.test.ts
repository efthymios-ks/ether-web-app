import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSha256 } from './sha256.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('createSha256', () => {
    it.each([
        ['the empty message', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ['the 448-bit message', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
        [
            'the 896-bit message',
            'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
            'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
        ],
    ])('matches the NIST vector for %s', (_, message, expected) => {
        // Act
        const digest = createSha256().update(text(message)).digestHex();

        // Assert
        expect(digest).toBe(expected);
    });

    it('matches the NIST vector for one million "a" fed in pieces', () => {
        // Arrange
        const hash = createSha256();
        const piece = text('a'.repeat(1000));

        // Act
        for (let index = 0; index < 1000; index++) {
            hash.update(piece);
        }

        // Assert
        expect(hash.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    });

    it.each([55, 56, 63, 64, 65, 119, 120])('pads a %i-byte message like Node does', length => {
        // Arrange
        const bytes = new Uint8Array(randomBytes(length));

        // Act
        const digest = createSha256().update(bytes).digestHex();

        // Assert
        expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('matches Node for several MB split at odd boundaries', () => {
        // Arrange
        const data = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
        const hash = createSha256();
        const cuts = [1, 63, 65, 4097, 1_000_003, 777, 2_000_001];
        let offset = 0;

        // Act
        for (const cut of cuts) {
            hash.update(data.subarray(offset, Math.min(data.length, offset + cut)));
            offset = Math.min(data.length, offset + cut);
        }

        hash.update(data.subarray(offset));

        // Assert
        expect(hash.digestHex()).toBe(createHash('sha256').update(data).digest('hex'));
    });

    it('returns the same digest when asked twice and refuses more data after it', () => {
        // Arrange
        const hash = createSha256().update(text('abc'));

        // Act
        const first = hash.digestHex();
        const second = hash.digestHex();

        // Assert
        expect(second).toBe(first);
        expect(() => hash.update(text('more'))).toThrow('SHA-256 already finished');
    });
});
