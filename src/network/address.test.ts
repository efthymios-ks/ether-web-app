import { describe, expect, it } from 'vitest';
import { addressToBytes, bytesToAddress } from './address.js';

describe('addressToBytes', () => {
    it('packs an IPv4 address into 4 bytes', () => {
        // Act
        const address = addressToBytes('192.168.1.23');

        // Assert
        expect(address).toEqual({ kind: 'ipv4', bytes: Uint8Array.from([192, 168, 1, 23]) });
    });

    it('packs an mDNS name into the 16 bytes of its UUID', () => {
        // Act
        const address = addressToBytes('3F2A6C1E-2B4D-4E5F-8A9B-0C1D2E3F4A5B.local');

        // Assert
        expect(address?.kind).toBe('mdns');
        expect(address?.bytes).toHaveLength(16);
        expect(address?.bytes[0]).toBe(0x3f);
        expect(address?.bytes[15]).toBe(0x5b);
    });

    it.each([
        ['fe80::1c2d:3e4f:5a6b:7c8d', 'fe80::1c2d:3e4f:5a6b:7c8d'],
        ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329'],
        ['::1', '::1'],
        ['2001:db8:0:1:0:0:0:1', '2001:db8:0:1::1'],
        ['2001:db8::', '2001:db8::'],
        ['::ffff:192.168.1.23', '::ffff:c0a8:117'],
        ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2:3:4:5:6'],
    ])('round-trips the IPv6 address %s as %s', (text, expected) => {
        // Arrange
        const address = addressToBytes(text);

        // Act
        const formatted = address == null ? undefined : bytesToAddress(address.kind, address.bytes);

        // Assert
        expect(address?.kind).toBe('ipv6');
        expect(formatted).toBe(expected);
    });

    it.each([
        'example.com',
        '256.1.1.1',
        '1.2.3',
        'fe80::1%eth0',
        '1::2::3',
        '1:2:3:4:5:6:7:8:9',
        'not-a-uuid.local',
        '',
    ])('rejects %j', text => {
        // Act
        const address = addressToBytes(text);

        // Assert
        expect(address).toBeUndefined();
    });
});

describe('bytesToAddress', () => {
    it('formats IPv4 bytes as a dotted quad', () => {
        // Act
        const text = bytesToAddress('ipv4', Uint8Array.from([10, 84, 2, 7]));

        // Assert
        expect(text).toBe('10.84.2.7');
    });

    it('formats mDNS bytes as a lowercase UUID name', () => {
        // Arrange
        const address = addressToBytes('3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local');

        // Act
        const text = address == null ? undefined : bytesToAddress('mdns', address.bytes);

        // Assert
        expect(text).toBe('3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local');
    });
});
