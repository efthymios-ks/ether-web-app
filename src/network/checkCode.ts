import { encodeBase32 } from './base32.js';

// SP-02: 4 characters from both DTLS fingerprints, shown on both screens once connected.
// Someone racing the real device with a photographed QR has another fingerprint, so another code.

const CHECK_CODE_LENGTH = 4;
const DOMAIN = new TextEncoder().encode('ether-check-code-1');

// Order-independent, so both devices compute the same code from (local, remote).
export async function deriveCheckCodeAsync(first: Uint8Array, second: Uint8Array): Promise<string> {
    const [low, high] = compareBytes(first, second) <= 0 ? [first, second] : [second, first];
    const input = new Uint8Array(DOMAIN.length + 2 + low.length + high.length);
    input.set(DOMAIN, 0);
    input[DOMAIN.length] = low.length;
    input.set(low, DOMAIN.length + 1);
    input[DOMAIN.length + 1 + low.length] = high.length;
    input.set(high, DOMAIN.length + 2 + low.length);

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));

    // Three bytes give five characters; the first four carry 20 bits.
    return encodeBase32(digest.subarray(0, 3)).slice(0, CHECK_CODE_LENGTH);
}

function compareBytes(first: Uint8Array, second: Uint8Array): number {
    const length = Math.min(first.length, second.length);
    for (let index = 0; index < length; index++) {
        const difference = (first[index] ?? 0) - (second[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }

    return first.length - second.length;
}
