import { createSha256 } from '../core/sha256.js';
import { base64UrlToBytes, bytesToBase64Url, hexToBytes, utf8Bytes } from './encoding.js';

// WebCrypto only. The room comes from the public address: every device behind it derives the same tag
// (the relays' filter) and the same AES-GCM key for presence. Messages for one device use a key from ECDH
// between throwaway P-256 keys, so others in the room can't read the pairing codes.

const ROOM_PREFIX = 'ether-nearby-v1:';
const ROOM_KEY_SALT = 'ether-nearby-v1 room';
const ROOM_KEY_INFO = 'presence';
const DIRECT_KEY_INFO = 'ether-nearby-v1 direct';
const IV_BYTES = 12;
const TAG_BYTES = 16;
// An uncompressed P-256 point: 0x04, then x and y.
const PUBLIC_KEY_BYTES = 65;
const AES_GCM: AesKeyGenParams = Object.freeze({ name: 'AES-GCM', length: 256 });
const P256: EcKeyImportParams = Object.freeze({ name: 'ECDH', namedCurve: 'P-256' });

export interface RoomSecrets {
    readonly address: string;
    // Hex SHA-256 of `ether-nearby-v1:<ipv4>`.
    readonly tag: string;
    readonly key: CryptoKey;
}

export interface ExchangeKeys {
    // Base64url of the raw public key, as presence carries it.
    readonly publicKey: string;
    readonly privateKey: CryptoKey;
}

export function deriveRoomTag(address: string): string {
    return createSha256().update(utf8Bytes(`${ROOM_PREFIX}${address}`)).digestHex();
}

export async function deriveRoomAsync(address: string): Promise<RoomSecrets> {
    const material = await crypto.subtle.importKey(
        'raw',
        utf8Bytes(`${ROOM_PREFIX}${address}`),
        'HKDF',
        false,
        ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8Bytes(ROOM_KEY_SALT), info: utf8Bytes(ROOM_KEY_INFO) },
        material,
        AES_GCM,
        false,
        ['encrypt', 'decrypt'],
    );

    return { address, tag: deriveRoomTag(address), key };
}

// Not extractable: the private key never leaves WebCrypto, and a new pair comes with each page load.
export async function createExchangeKeysAsync(): Promise<ExchangeKeys> {
    const pair = await crypto.subtle.generateKey(P256, false, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

    return { publicKey: bytesToBase64Url(raw), privateKey: pair.privateKey };
}

// Both sides get the same key; undefined for a key that is not a P-256 point.
export async function deriveDirectKeyAsync(
    privateKey: CryptoKey,
    peerPublicKey: string,
    roomTag: string,
): Promise<CryptoKey | undefined> {
    const raw = base64UrlToBytes(peerPublicKey);
    const salt = hexToBytes(roomTag);
    if (raw == null || raw.length !== PUBLIC_KEY_BYTES || raw[0] !== 4 || salt == null) {
        return undefined;
    }

    try {
        const peer = await crypto.subtle.importKey('raw', raw, P256, false, []);
        const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
        const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);

        return await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt, info: utf8Bytes(DIRECT_KEY_INFO) },
            material,
            AES_GCM,
            false,
            ['encrypt', 'decrypt'],
        );
    } catch {
        return undefined;
    }
}

// AES-GCM with a random IV; `context` is bound as additional data, so a box can't be moved to another
// room or relabelled for another device.
export async function sealAsync(key: CryptoKey, plaintext: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8Bytes(context) },
        key,
        utf8Bytes(plaintext),
    );
    const sealed = new Uint8Array(IV_BYTES + encrypted.byteLength);
    sealed.set(iv, 0);
    sealed.set(new Uint8Array(encrypted), IV_BYTES);

    return bytesToBase64Url(sealed);
}

// Undefined when the text is not a box sealed with this key and context.
export async function openSealedAsync(
    key: CryptoKey,
    sealed: string,
    context: string,
): Promise<string | undefined> {
    const bytes = base64UrlToBytes(sealed);
    if (bytes == null || bytes.length < IV_BYTES + TAG_BYTES) {
        return undefined;
    }

    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES), additionalData: utf8Bytes(context) },
            key,
            bytes.subarray(IV_BYTES),
        );

        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch {
        return undefined;
    }
}
