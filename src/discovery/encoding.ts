// Hex and base64url for keys, ids and sealed messages. Decoders return undefined for malformed text.

const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
    if (!HEX_PATTERN.test(hex)) {
        return undefined;
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }

    return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
    // A length of 1 modulo 4 can't come from whole bytes.
    if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
        return undefined;
    }

    const padded = text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
    try {
        const binary = atob(padded);

        return Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch {
        return undefined;
    }
}

export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(text);
}
