// RFC 4648 Base32 without padding (HS-04): it fits QR alphanumeric mode once uppercased and is URL-safe.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BITS_PER_CHARACTER = 5;
const IGNORED_CHARACTERS = /[\s-]+/g;
const TRAILING_PADDING = /=+$/;

export function encodeBase32(bytes: Uint8Array): string {
    const characters: string[] = [];
    let buffer = 0;
    let bufferedBits = 0;

    for (const byte of bytes) {
        buffer = ((buffer << 8) | byte) & 0xffff;
        bufferedBits += 8;

        while (bufferedBits >= BITS_PER_CHARACTER) {
            bufferedBits -= BITS_PER_CHARACTER;
            characters.push(ALPHABET.charAt((buffer >> bufferedBits) & 31));
        }
    }

    if (bufferedBits > 0) {
        characters.push(ALPHABET.charAt((buffer << (BITS_PER_CHARACTER - bufferedBits)) & 31));
    }

    return characters.join('');
}

// Accepts what people paste: lowercase, spaces, dashes and padding. Anything else returns undefined.
export function decodeBase32(text: string): Uint8Array | undefined {
    const normalized = normalizeBase32(text);
    const bytes = new Uint8Array(Math.floor((normalized.length * BITS_PER_CHARACTER) / 8));
    let buffer = 0;
    let bufferedBits = 0;
    let length = 0;

    for (const character of normalized) {
        const value = ALPHABET.indexOf(character);
        if (value < 0) {
            return undefined;
        }

        buffer = ((buffer << BITS_PER_CHARACTER) | value) & 0xffff;
        bufferedBits += BITS_PER_CHARACTER;

        if (bufferedBits >= 8) {
            bufferedBits -= 8;
            bytes[length] = (buffer >> bufferedBits) & 0xff;
            length++;
        }
    }

    const leftover = buffer & ((1 << bufferedBits) - 1);
    if (bufferedBits >= BITS_PER_CHARACTER || leftover !== 0) {
        return undefined;
    }

    return bytes;
}

export function normalizeBase32(text: string): string {
    return text
        .replace(IGNORED_CHARACTERS, '')
        .replace(TRAILING_PADDING, '')
        .toUpperCase();
}
