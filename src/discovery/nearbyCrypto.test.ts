import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    createExchangeKeysAsync,
    deriveDirectKeyAsync,
    deriveRoomAsync,
    deriveRoomTag,
    openSealedAsync,
    sealAsync,
} from './nearbyCrypto.js';

const HOME = '203.0.113.7';
const ELSEWHERE = '198.51.100.23';

describe('deriveRoomTag', () => {
    it('is the hex SHA-256 of ether-nearby-v1:<ipv4>', () => {
        // Act
        const tag = deriveRoomTag(HOME);

        // Assert
        expect(tag).toBe(createHash('sha256').update(`ether-nearby-v1:${HOME}`).digest('hex'));
    });
});

describe('deriveRoomAsync', () => {
    it('gives devices behind one address the same tag and key', async () => {
        // Arrange
        const first = await deriveRoomAsync(HOME);
        const second = await deriveRoomAsync(HOME);

        // Act
        const sealed = await sealAsync(first.key, 'hello', first.tag);
        const opened = await openSealedAsync(second.key, sealed, second.tag);

        // Assert
        expect(second.tag).toBe(first.tag);
        expect(opened).toBe('hello');
    });

    it('keeps another address out', async () => {
        // Arrange
        const home = await deriveRoomAsync(HOME);
        const elsewhere = await deriveRoomAsync(ELSEWHERE);
        const sealed = await sealAsync(home.key, 'hello', home.tag);

        // Act
        const opened = await openSealedAsync(elsewhere.key, sealed, home.tag);

        // Assert
        expect(elsewhere.tag).not.toBe(home.tag);
        expect(opened).toBeUndefined();
    });
});

describe('sealAsync and openSealedAsync', () => {
    it('uses a fresh IV each time and binds the context', async () => {
        // Arrange
        const room = await deriveRoomAsync(HOME);

        // Act
        const first = await sealAsync(room.key, 'same', 'context');
        const second = await sealAsync(room.key, 'same', 'context');
        const wrongContext = await openSealedAsync(room.key, first, 'other');

        // Assert
        expect(first).not.toBe(second);
        expect(wrongContext).toBeUndefined();
    });

    it.each([
        ['not base64url', '***'],
        ['too short', 'AAAA'],
        ['tampered', undefined],
    ])('refuses a box that is %s', async (_, box) => {
        // Arrange
        const room = await deriveRoomAsync(HOME);
        const sealed = await sealAsync(room.key, 'hello', 'context');
        const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;

        // Act
        const opened = await openSealedAsync(room.key, box ?? tampered, 'context');

        // Assert
        expect(opened).toBeUndefined();
    });
});

describe('deriveDirectKeyAsync', () => {
    it('gives both devices the same key and leaves a third out', async () => {
        // Arrange
        const room = await deriveRoomAsync(HOME);
        const phone = await createExchangeKeysAsync();
        const laptop = await createExchangeKeysAsync();
        const tablet = await createExchangeKeysAsync();
        const phoneKey = await deriveDirectKeyAsync(phone.privateKey, laptop.publicKey, room.tag);
        const laptopKey = await deriveDirectKeyAsync(laptop.privateKey, phone.publicKey, room.tag);
        const tabletKey = await deriveDirectKeyAsync(tablet.privateKey, phone.publicKey, room.tag);
        if (phoneKey == null || laptopKey == null || tabletKey == null) {
            throw new Error('no key');
        }

        // Act
        const sealed = await sealAsync(phoneKey, 'offer', 'phone>laptop');
        const forLaptop = await openSealedAsync(laptopKey, sealed, 'phone>laptop');
        const forTablet = await openSealedAsync(tabletKey, sealed, 'phone>laptop');

        // Assert
        expect(phone.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
        expect(forLaptop).toBe('offer');
        expect(forTablet).toBeUndefined();
    });

    it.each([
        ['not base64url', '***'],
        ['the wrong length', 'AAAA'],
        ['not a curve point', `B${'A'.repeat(86)}`],
    ])('refuses a peer key that is %s', async (_, peerKey) => {
        // Arrange
        const room = await deriveRoomAsync(HOME);
        const keys = await createExchangeKeysAsync();

        // Act
        const key = await deriveDirectKeyAsync(keys.privateKey, peerKey, room.tag);

        // Assert
        expect(key).toBeUndefined();
    });
});
