import { describe, expect, it } from 'vitest';
import { decodeBase32, encodeBase32 } from './base32.js';
import { NetworkError } from './networkTypes.js';
import {
    buildCodeUrl,
    decodePairingCode,
    deriveOfferTagAsync,
    encodePairingCode,
    extractCode,
    selectCodeCandidates,
} from './pairingCode.js';
import type { PairingPayload } from './pairingCode.js';
import type { SdpCandidate } from './sdp.js';

const CHROME_OFFER: PairingPayload = {
    kind: 'offer',
    createdAt: 1_795_000_000,
    iceUfrag: 'x9cK',
    icePwd: 'fJ4o0P2q7vG2nW+3bLk/XyZa',
    fingerprint: Uint8Array.from({ length: 32 }, (_, index) => index * 7),
    setup: 'actpass',
    mid: '0',
    maxMessageSize: 262144,
    candidates: [
        { address: '192.168.1.23', port: 52344 },
        { address: '10.84.2.7', port: 61021 },
    ],
};

const FIREFOX_ANSWER: PairingPayload = {
    kind: 'answer',
    createdAt: 1_795_000_042,
    iceUfrag: '1a2b3c4d',
    icePwd: '4f1c0d2e9a8b7c6d5e4f3a2b1c0d9e8f',
    fingerprint: Uint8Array.from({ length: 64 }, (_, index) => 255 - index),
    setup: 'passive',
    mid: 'data',
    maxMessageSize: 1073741823,
    candidates: [
        { address: '3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local', port: 54321 },
        { address: 'fe80::1c2d:3e4f:5a6b:7c8d', port: 54322 },
        { address: '192.168.1.41', port: 54323 },
        { address: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a.local', port: 54324 },
    ],
    offerTag: 0xbeef,
};

function expectNetworkError(action: () => unknown, code: string): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).code).toBe(code);
        return;
    }

    throw new Error(`expected NetworkError ${code}`);
}

function withFirstByte(code: string, firstByte: number): string {
    const bytes = decodeBase32(code) ?? new Uint8Array();
    bytes[0] = firstByte;

    return encodeBase32(bytes);
}

describe('encodePairingCode', () => {
    it('fits a Chrome offer with two IPv4 candidates into 83 bytes', () => {
        // Act
        const code = encodePairingCode(CHROME_OFFER);

        // Assert
        expect(decodeBase32(code)).toHaveLength(83);
        expect(code).toMatch(/^[A-Z2-7]+$/);
        expect(code).toHaveLength(133);
    });

    it('round-trips an offer', () => {
        // Arrange
        const code = encodePairingCode(CHROME_OFFER);

        // Act
        const payload = decodePairingCode(code);

        // Assert
        expect(payload).toEqual({ ...CHROME_OFFER, version: 1 });
    });

    it('adds the 2-byte offer tag at the end of an answer', () => {
        // Arrange
        const answer: PairingPayload = { ...CHROME_OFFER, kind: 'answer', setup: 'active', offerTag: 0x1234 };

        // Act
        const bytes = decodeBase32(encodePairingCode(answer));

        // Assert
        expect(bytes).toHaveLength(85);
        expect(Array.from(bytes?.subarray(-2) ?? [])).toEqual([0x12, 0x34]);
    });

    it('refuses an answer without an offer tag', () => {
        // Arrange
        const answer: PairingPayload = { ...CHROME_OFFER, kind: 'answer', setup: 'active' };

        // Act
        const encode = () => encodePairingCode(answer);

        // Assert
        expect(encode).toThrow(RangeError);
    });

    it('leaves the offer tag out of an offer', () => {
        // Arrange
        const offer: PairingPayload = { ...CHROME_OFFER, offerTag: 0x1234 };

        // Act
        const payload = decodePairingCode(encodePairingCode(offer));

        // Assert
        expect('offerTag' in payload).toBe(false);
    });

    it('round-trips an answer with SHA-512, mDNS, IPv6 and a non-zero mid', () => {
        // Arrange
        const code = encodePairingCode(FIREFOX_ANSWER);

        // Act
        const payload = decodePairingCode(code);

        // Assert
        expect(payload).toEqual({ ...FIREFOX_ANSWER, version: 1 });
    });

    it.each([32, 48, 64])('round-trips a %i-byte fingerprint', length => {
        // Arrange
        const offer = { ...CHROME_OFFER, fingerprint: new Uint8Array(length).fill(0xab) };

        // Act
        const payload = decodePairingCode(encodePairingCode(offer));

        // Assert
        expect(payload.fingerprint).toEqual(offer.fingerprint);
    });

    it('leaves maxMessageSize out when the description had none', () => {
        // Arrange
        const offer = { ...CHROME_OFFER, maxMessageSize: undefined };

        // Act
        const payload = decodePairingCode(encodePairingCode(offer));

        // Assert
        expect(payload.maxMessageSize).toBeUndefined();
        expect('maxMessageSize' in payload).toBe(false);
    });

    it('refuses more than four candidates', () => {
        // Arrange
        const candidates = [...FIREFOX_ANSWER.candidates, { address: '10.0.0.1', port: 1 }];
        const offer = { ...CHROME_OFFER, candidates };

        // Act
        const encode = () => encodePairingCode(offer);

        // Assert
        expect(encode).toThrow(RangeError);
    });

    it('refuses ICE credentials outside the ICE character set', () => {
        // Arrange
        const offer = { ...CHROME_OFFER, iceUfrag: 'ab-cd' };

        // Act
        const encode = () => encodePairingCode(offer);

        // Assert
        expect(encode).toThrow(RangeError);
    });
});

describe('decodePairingCode', () => {
    it('accepts the code inside an app URL', () => {
        // Arrange
        const code = encodePairingCode(CHROME_OFFER);
        const url = buildCodeUrl('https://example.github.io/ether-web-app/', code);

        // Act
        const payload = decodePairingCode(url);

        // Assert
        expect(url).toBe(`https://example.github.io/ether-web-app/#${code}`);
        expect(payload.iceUfrag).toBe('x9cK');
    });

    it('accepts a pasted code in lowercase groups of four', () => {
        // Arrange
        const code = encodePairingCode(CHROME_OFFER);
        const pasted = code.toLowerCase().match(/.{1,4}/g)?.join(' - ') ?? '';

        // Act
        const payload = decodePairingCode(pasted);

        // Assert
        expect(payload.kind).toBe('offer');
    });

    it('rejects another version with code-version', () => {
        // Arrange
        const code = withFirstByte(encodePairingCode(CHROME_OFFER), 0xe2);

        // Act
        const decode = () => decodePairingCode(code);

        // Assert
        expectNetworkError(decode, 'code-version');
    });

    it.each([
        ['an empty text', ''],
        ['characters outside Base32', 'HELLO WORLD!'],
        ['a URL without a code', 'https://example.github.io/ether-web-app/#'],
        ['random Base32', 'MZXW6YTBOI'],
    ])('rejects %s with code-invalid', (_, text) => {
        // Act
        const decode = () => decodePairingCode(text);

        // Assert
        expectNetworkError(decode, 'code-invalid');
    });

    it('rejects a truncated code with code-invalid', () => {
        // Arrange
        const bytes = decodeBase32(encodePairingCode(CHROME_OFFER)) ?? new Uint8Array();
        const truncated = encodeBase32(bytes.subarray(0, bytes.length - 3));

        // Act
        const decode = () => decodePairingCode(truncated);

        // Assert
        expectNetworkError(decode, 'code-invalid');
    });

    it('rejects trailing bytes with code-invalid', () => {
        // Arrange
        const bytes = decodeBase32(encodePairingCode(CHROME_OFFER)) ?? new Uint8Array();
        const padded = encodeBase32(Uint8Array.from([...bytes, 0]));

        // Act
        const decode = () => decodePairingCode(padded);

        // Assert
        expectNetworkError(decode, 'code-invalid');
    });

    it('rejects an answer without its offer tag with code-invalid', () => {
        // Arrange
        const bytes = decodeBase32(encodePairingCode(FIREFOX_ANSWER)) ?? new Uint8Array();
        const cut = encodeBase32(bytes.subarray(0, bytes.length - 2));

        // Act
        const decode = () => decodePairingCode(cut);

        // Assert
        expectNetworkError(decode, 'code-invalid');
    });

    it('rejects unknown flag bits with code-invalid', () => {
        // Arrange
        const bytes = decodeBase32(encodePairingCode(CHROME_OFFER)) ?? new Uint8Array();
        bytes[1] = (bytes[1] ?? 0) | 0x80;

        // Act
        const decode = () => decodePairingCode(encodeBase32(bytes));

        // Assert
        expectNetworkError(decode, 'code-invalid');
    });
});

describe('deriveOfferTagAsync', () => {
    it('gives the same 16-bit tag for the same offer', async () => {
        // Act
        const first = await deriveOfferTagAsync(CHROME_OFFER.fingerprint, CHROME_OFFER.iceUfrag);
        const second = await deriveOfferTagAsync(CHROME_OFFER.fingerprint, CHROME_OFFER.iceUfrag);

        // Assert
        expect(first).toBe(second);
        expect(Number.isInteger(first) && first >= 0 && first <= 0xffff).toBe(true);
    });

    it('gives another tag for another offer', async () => {
        // Act
        const original = await deriveOfferTagAsync(CHROME_OFFER.fingerprint, CHROME_OFFER.iceUfrag);
        const otherUfrag = await deriveOfferTagAsync(CHROME_OFFER.fingerprint, 'Zz9+');
        const otherFingerprint = await deriveOfferTagAsync(FIREFOX_ANSWER.fingerprint, CHROME_OFFER.iceUfrag);

        // Assert
        expect(otherUfrag).not.toBe(original);
        expect(otherFingerprint).not.toBe(original);
    });
});

describe('extractCode', () => {
    it('takes the part after # and normalises it', () => {
        // Act
        const code = extractCode('https://example.github.io/ether-web-app/?debug=1#abcd-efgh');

        // Assert
        expect(code).toBe('ABCDEFGH');
    });
});

describe('selectCodeCandidates', () => {
    const candidate = (address: string, port: number, extra: Partial<SdpCandidate> = {}): SdpCandidate => ({
        foundation: '1',
        component: 1,
        protocol: 'udp',
        priority: 2122260223,
        address,
        port,
        type: 'host',
        ...extra,
    });

    it('keeps UDP host candidates of component 1 with an encodable address', () => {
        // Arrange
        const candidates = [
            candidate('192.168.1.23', 1000),
            candidate('192.168.1.23', 9, { protocol: 'tcp' }),
            candidate('192.168.1.23', 1001, { component: 2 }),
            candidate('203.0.113.7', 1002, { type: 'srflx' }),
            candidate('printer.example', 1003),
        ];

        // Act
        const selected = selectCodeCandidates(candidates);

        // Assert
        expect(selected).toEqual([{ address: '192.168.1.23', port: 1000 }]);
    });

    it('prefers IPv4, then mDNS, then IPv6, by priority, at most four and without duplicates', () => {
        // Arrange
        const candidates = [
            candidate('fe80::1', 1, { priority: 30 }),
            candidate('3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local', 2, { priority: 20 }),
            candidate('10.0.0.2', 3, { priority: 10 }),
            candidate('10.0.0.1', 4, { priority: 40 }),
            candidate('10.0.0.1', 4, { priority: 40 }),
            candidate('fe80::2', 5, { priority: 50 }),
        ];

        // Act
        const selected = selectCodeCandidates(candidates);

        // Assert
        expect(selected.map(item => item.port)).toEqual([4, 3, 2, 5]);
    });
});
