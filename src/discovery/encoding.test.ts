import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, hexToBytes, utf8Bytes } from './encoding.js';

describe('hex', () => {
    it('round-trips bytes and reads either case', () => {
        // Arrange
        const bytes = Uint8Array.from([0, 1, 127, 128, 255]);

        // Act
        const hex = bytesToHex(bytes);

        // Assert
        expect(hex).toBe('00017f80ff');
        expect(hexToBytes(hex)).toEqual(bytes);
        expect(hexToBytes('00017F80FF')).toEqual(bytes);
    });

    it.each([['an odd length', 'abc'], ['a non-hex character', 'zz']])('refuses %s', (_, text) => {
        // Act
        const bytes = hexToBytes(text);

        // Assert
        expect(bytes).toBeUndefined();
    });
});

describe('base64url', () => {
    it.each([0, 1, 2, 3, 65])('round-trips %i bytes without padding', length => {
        // Arrange
        const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 250) % 256);

        // Act
        const text = bytesToBase64Url(bytes);

        // Assert
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(base64UrlToBytes(text)).toEqual(bytes);
    });

    it.each([['padding', 'AA=='], ['standard base64 characters', 'a+b/'], ['an impossible length', 'AAAAA']])(
        'refuses %s',
        (_, text) => {
            // Act
            const bytes = base64UrlToBytes(text);

            // Assert
            expect(bytes).toBeUndefined();
        },
    );
});

describe('utf8Bytes', () => {
    it('encodes UTF-8', () => {
        // Act
        const bytes = utf8Bytes('é');

        // Assert
        expect([...bytes]).toEqual([0xc3, 0xa9]);
    });
});
