import { describe, expect, it } from 'vitest';
import { deriveCheckCodeAsync } from './checkCode.js';

const OFFERER = Uint8Array.from({ length: 32 }, (_, index) => index);
const ANSWERER = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

describe('deriveCheckCodeAsync', () => {
    it('gives 4 Base32 characters', async () => {
        // Act
        const code = await deriveCheckCodeAsync(OFFERER, ANSWERER);

        // Assert
        expect(code).toMatch(/^[A-Z2-7]{4}$/);
    });

    it('is the same on both devices, whatever the order', async () => {
        // Act
        const onOfferer = await deriveCheckCodeAsync(OFFERER, ANSWERER);
        const onAnswerer = await deriveCheckCodeAsync(ANSWERER, OFFERER);

        // Assert
        expect(onOfferer).toBe(onAnswerer);
    });

    it('changes when either fingerprint changes', async () => {
        // Arrange
        const intruder = OFFERER.slice();
        intruder[31] = 0xff;

        // Act
        const genuine = await deriveCheckCodeAsync(OFFERER, ANSWERER);
        const raced = await deriveCheckCodeAsync(intruder, ANSWERER);

        // Assert
        expect(raced).not.toBe(genuine);
    });

    it('accepts fingerprints of different lengths', async () => {
        // Arrange
        const sha384 = new Uint8Array(48).fill(7);

        // Act
        const first = await deriveCheckCodeAsync(sha384, ANSWERER);
        const second = await deriveCheckCodeAsync(ANSWERER, sha384);

        // Assert
        expect(first).toBe(second);
    });
});
