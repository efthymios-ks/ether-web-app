import { describe, expect, it } from 'vitest';
import { decodeBase32, encodeBase32 } from './base32.js';

const encoder = new TextEncoder();

describe('encodeBase32', () => {
    it.each([
        ['', ''],
        ['f', 'MY'],
        ['fo', 'MZXQ'],
        ['foo', 'MZXW6'],
        ['foob', 'MZXW6YQ'],
        ['fooba', 'MZXW6YTB'],
        ['foobar', 'MZXW6YTBOI'],
    ])('encodes the RFC 4648 vector %j without padding', (text, expected) => {
        // Arrange
        const bytes = encoder.encode(text);

        // Act
        const encoded = encodeBase32(bytes);

        // Assert
        expect(encoded).toBe(expected);
    });
});

describe('decodeBase32', () => {
    it('round-trips every byte value', () => {
        // Arrange
        const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

        // Act
        const decoded = decodeBase32(encodeBase32(bytes));

        // Assert
        expect(decoded).toEqual(bytes);
    });

    it('accepts lowercase, spaces, dashes and padding as pasted', () => {
        // Arrange
        const pasted = ' mzxw-6ytb oi== ';

        // Act
        const decoded = decodeBase32(pasted);

        // Assert
        expect(decoded).toEqual(encoder.encode('foobar'));
    });

    it('rejects characters outside the alphabet', () => {
        // Arrange
        const text = 'MZXW1YTB';

        // Act
        const decoded = decodeBase32(text);

        // Assert
        expect(decoded).toBeUndefined();
    });

    it.each(['M', 'MZX', 'MZXW6Y'])('rejects the impossible length of %j', text => {
        // Act
        const decoded = decodeBase32(text);

        // Assert
        expect(decoded).toBeUndefined();
    });

    it('rejects leftover bits that are not zero', () => {
        // Arrange
        const text = 'MZ';

        // Act
        const decoded = decodeBase32(text);

        // Assert
        expect(decoded).toBeUndefined();
    });
});
