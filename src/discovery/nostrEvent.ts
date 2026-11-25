import { createSha256 } from '../core/sha256.js';
import { bytesToHex, hexToBytes, utf8Bytes } from './encoding.js';
import { isValidSecretKey, schnorrPublicKey, signSchnorr, verifySchnorr } from './schnorr.js';

// Nostr events (NIP-01): the envelope the relays pass along. The field names are the wire format's.

export interface NostrEvent {
    readonly id: string;
    readonly pubkey: string;
    readonly created_at: number;
    readonly kind: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
    readonly sig: string;
}

export interface UnsignedEvent {
    // Seconds since the Unix epoch.
    readonly createdAt: number;
    readonly kind: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
}

export interface NostrSigner {
    // Hex x-only public key.
    readonly publicKey: string;
    sign(event: UnsignedEvent): NostrEvent;
}

export interface EventLimits {
    readonly maxContentLength: number;
    readonly maxTags: number;
    readonly maxTagValues: number;
    readonly maxTagValueLength: number;
}

export const DEFAULT_EVENT_LIMITS: EventLimits = Object.freeze({
    maxContentLength: 16 * 1024,
    maxTags: 16,
    maxTagValues: 4,
    maxTagValueLength: 256,
});

const HEX_32_PATTERN = /^[0-9a-f]{64}$/;
const HEX_64_PATTERN = /^[0-9a-f]{128}$/;
const MAX_KIND = 65_535;
const MAX_KEY_ATTEMPTS = 8;

// Signs with a throwaway key (createSecretKey), kept no longer than its tab (tabIdentity.ts).
export function createNostrSigner(secretKey: Uint8Array, randomBytes: (length: number) => Uint8Array): NostrSigner {
    const publicKey = bytesToHex(schnorrPublicKey(secretKey));

    return {
        publicKey,
        sign: event => {
            const id = computeEventId({ ...event, pubkey: publicKey });
            const idBytes = hexToBytes(id) ?? new Uint8Array(32);
            const signature = signSchnorr(idBytes, secretKey, randomBytes(32));

            return {
                id,
                pubkey: publicKey,
                created_at: event.createdAt,
                kind: event.kind,
                tags: event.tags.map(tag => [...tag]),
                content: event.content,
                sig: bytesToHex(signature),
            };
        },
    };
}

// NIP-01: the SHA-256 of [0, pubkey, created_at, kind, tags, content] as compact JSON.
export function computeEventId(event: UnsignedEvent & { readonly pubkey: string }): string {
    const serialized = JSON.stringify([0, event.pubkey, event.createdAt, event.kind, event.tags, event.content]);

    return createSha256().update(utf8Bytes(serialized)).digestHex();
}

// The shape only: lowercase hex of the right lengths, whole numbers, string tags, sizes within the limits.
export function parseNostrEvent(
    value: unknown,
    limits: EventLimits = DEFAULT_EVENT_LIMITS,
): NostrEvent | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const source = value as Readonly<Record<string, unknown>>;
    const { id, pubkey, sig, content, kind } = source;
    const createdAt = source.created_at;
    const tags = parseTags(source.tags, limits);
    const isValid = typeof id === 'string'
        && HEX_32_PATTERN.test(id)
        && typeof pubkey === 'string'
        && HEX_32_PATTERN.test(pubkey)
        && typeof sig === 'string'
        && HEX_64_PATTERN.test(sig)
        && typeof content === 'string'
        && content.length <= limits.maxContentLength
        && Number.isSafeInteger(createdAt)
        && (createdAt as number) >= 0
        && Number.isInteger(kind)
        && (kind as number) >= 0
        && (kind as number) <= MAX_KIND
        && tags != null;
    if (!isValid) {
        return undefined;
    }

    return { id, pubkey, created_at: createdAt as number, kind: kind as number, tags, content, sig };
}

export function hasValidId(event: NostrEvent): boolean {
    const id = computeEventId({
        pubkey: event.pubkey,
        createdAt: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
    });

    return id === event.id;
}

// The id must be checked first: the signature covers the id, not the fields.
export function hasValidSignature(event: NostrEvent): boolean {
    const signature = hexToBytes(event.sig);
    const id = hexToBytes(event.id);
    const publicKey = hexToBytes(event.pubkey);
    if (signature == null || id == null || publicKey == null) {
        return false;
    }

    return verifySchnorr(signature, id, publicKey);
}

// The value of the first tag with this name, e.g. the room tag.
export function readTag(event: NostrEvent, name: string): string | undefined {
    return event.tags.find(tag => tag[0] === name)?.[1];
}

function parseTags(value: unknown, limits: EventLimits): string[][] | undefined {
    if (!Array.isArray(value) || value.length > limits.maxTags) {
        return undefined;
    }

    const tags: string[][] = [];
    for (const tag of value) {
        const isValid = Array.isArray(tag)
            && tag.length > 0
            && tag.length <= limits.maxTagValues
            && tag.every(item => typeof item === 'string' && item.length <= limits.maxTagValueLength);
        if (!isValid) {
            return undefined;
        }

        tags.push([...(tag as string[])]);
    }

    return tags;
}

export function createSecretKey(randomBytes: (length: number) => Uint8Array): Uint8Array {
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
        const candidate = randomBytes(32);
        if (isValidSecretKey(candidate)) {
            return candidate;
        }
    }

    throw new Error('No valid secp256k1 key came from the random source');
}
