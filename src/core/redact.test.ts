import { describe, expect, it } from 'vitest';
import { maskIpAddresses, redact, shorten } from './redact.js';

describe('maskIpAddresses', () => {
    it('masks the last part of IPv4 addresses', () => {
        // Act
        const masked = maskIpAddresses('192.168.1.23:52344 ↔ 10.84.2.7:61021');

        // Assert
        expect(masked).toBe('192.168.1.x:52344 ↔ 10.84.2.x:61021');
    });

    it('masks IPv6 addresses but leaves clock times alone', () => {
        // Act
        const masked = maskIpAddresses('13:05:09 host fe80::1c2b:3a4d:5e6f:7a8b and 2001:db8:0:0:1:2:3:4');

        // Assert
        expect(masked).toBe('13:05:09 host fe80::x and 2001:db8:x');
    });
});

describe('redact', () => {
    it('hides secrets, codes and long hashes, recursively', () => {
        // Act
        const result = redact({ ice: { icePwd: 'secret' }, answerCode: 'ABCD', hashes: [{ sha256: '0123456789abcdef' }] });

        // Assert
        expect(result).toEqual({ ice: { icePwd: '[redacted]' }, answerCode: '[code, 4 chars]', hashes: [{ sha256: '01234567…' }] });
    });

    it('hides the PIN and a PIN proof, set or not, but not keys that only contain the word', () => {
        // Act
        const result = redact({
            changes: { pin: '2468' },
            settings: { pin: null, newPin: '1357' },
            request: { proof: 'A'.repeat(43), isPinVerified: true, hasPin: true },
            pingMs: 12,
        });

        // Assert
        expect(result).toEqual({
            changes: { pin: '[redacted]' },
            settings: { pin: '[redacted]', newPin: '[redacted]' },
            request: { proof: '[redacted]', isPinVerified: true, hasPin: true },
            pingMs: 12,
        });
    });

    it('shortens only long values', () => {
        // Act & Assert
        expect(shorten('abc')).toBe('abc');
        expect(shorten('0123456789')).toBe('01234567…');
    });
});
