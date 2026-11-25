import { ADDRESS_LENGTHS, addressToBytes, bytesToAddress } from './address.js';
import type { AddressKind } from './address.js';
import { decodeBase32, encodeBase32, normalizeBase32 } from './base32.js';
import { NetworkError } from './networkTypes.js';
import type { CodeKind } from './networkTypes.js';
import { FINGERPRINT_LENGTHS, SETUP_ROLES } from './sdp.js';
import type { HostCandidate, RemoteDescription, SdpCandidate } from './sdp.js';

// The compact pairing code (HS-03, layout in docs/Network.md): what the other side needs to rebuild
// a full description, in about 70–110 bytes, written as Base32 (HS-04).

export const CODE_VERSION = 1;
export const MAX_CODE_CANDIDATES = 4;

export interface PairingPayload extends RemoteDescription {
    readonly kind: CodeKind;
    // Seconds since the Unix epoch, so the other side can reject an expired offer (HS-08).
    readonly createdAt: number;
    // Answers only: names the offer they answer, so an answer to another code is refused at once.
    readonly offerTag?: number;
}

export interface DecodedPairingCode extends PairingPayload {
    readonly version: number;
}

// High nibble of the first byte; the low nibble is the version.
const MAGIC = 0xe0;
const KIND_BIT = 0x01;
const SETUP_SHIFT = 1;
const SETUP_MASK = 0x06;
const KNOWN_FLAGS = KIND_BIT | SETUP_MASK;
const MIN_UFRAG_LENGTH = 4;
const MIN_PWD_LENGTH = 22;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;
const OFFER_TAG_DOMAIN = new TextEncoder().encode('ether-offer-tag-1');

// RFC 8839 ice-char: exactly 64 characters, so each takes 6 bits.
const ICE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MID_PATTERN = /^[\x21-\x7e]{1,255}$/;

const ADDRESS_KINDS: readonly { readonly kind: AddressKind; readonly id: number }[] = Object.freeze([
    { kind: 'ipv4', id: 1 },
    { kind: 'ipv6', id: 2 },
    { kind: 'mdns', id: 3 },
]);

// IPv4 first: it needs no name resolution and is the smallest; IPv6 last.
const ADDRESS_PREFERENCE: Readonly<Record<AddressKind, number>> = Object.freeze({
    ipv4: 0,
    mdns: 1,
    ipv6: 2,
});

export function encodePairingCode(payload: PairingPayload): string {
    const writer = new ByteWriter();
    writer.byte(MAGIC | CODE_VERSION);
    writer.byte(encodeFlags(payload));
    writer.uint32(payload.createdAt);
    writer.uint32(payload.maxMessageSize ?? 0);
    writeIceText(writer, payload.iceUfrag);
    writeIceText(writer, payload.icePwd);
    writeFingerprint(writer, payload.fingerprint);
    writeMid(writer, payload.mid);
    writeCandidates(writer, payload.candidates);
    if (payload.kind === 'answer') {
        writeOfferTag(writer, payload.offerTag);
    }

    return encodeBase32(writer.toBytes());
}

// The first 16 bits of SHA-256 over the offer's fingerprint and ICE ufrag; both sides compute it.
export async function deriveOfferTagAsync(fingerprint: Uint8Array, iceUfrag: string): Promise<number> {
    const ufrag = new TextEncoder().encode(iceUfrag);
    const input = new Uint8Array(OFFER_TAG_DOMAIN.length + fingerprint.length + ufrag.length);
    input.set(OFFER_TAG_DOMAIN, 0);
    input.set(fingerprint, OFFER_TAG_DOMAIN.length);
    input.set(ufrag, OFFER_TAG_DOMAIN.length + fingerprint.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));

    return ((digest[0] ?? 0) << 8) | (digest[1] ?? 0);
}

// Accepts a code or an app URL ending in `#code`. Throws NetworkError code-invalid or code-version.
export function decodePairingCode(codeOrUrl: string): DecodedPairingCode {
    const code = extractCode(codeOrUrl);
    const bytes = code === '' ? undefined : decodeBase32(code);
    if (bytes == null || bytes.length < 2) {
        throw invalidCode('This is not an Ether pairing code');
    }

    const reader = new ByteReader(bytes);
    const version = readVersion(reader.byte());
    const flags = reader.byte();
    const setup = SETUP_ROLES[(flags & SETUP_MASK) >> SETUP_SHIFT];
    if ((flags & ~KNOWN_FLAGS) !== 0 || setup == null) {
        throw invalidCode('The pairing code has unknown flags');
    }

    const kind: CodeKind = (flags & KIND_BIT) === 0 ? 'offer' : 'answer';
    const createdAt = reader.uint32();
    const maxMessageSize = reader.uint32();
    const iceUfrag = readIceText(reader, MIN_UFRAG_LENGTH);
    const icePwd = readIceText(reader, MIN_PWD_LENGTH);
    const fingerprint = readFingerprint(reader);
    const mid = readMid(reader);
    const candidates = readCandidates(reader);
    const offerTag = kind === 'answer' ? reader.uint16() : undefined;
    if (reader.remaining > 0) {
        throw invalidCode('The pairing code is longer than its content');
    }

    return {
        version,
        kind,
        createdAt,
        iceUfrag,
        icePwd,
        fingerprint,
        setup,
        mid,
        ...(maxMessageSize > 0 ? { maxMessageSize } : {}),
        candidates,
        ...(offerTag == null ? {} : { offerTag }),
    };
}

// The code part of a pasted code or URL, upper case, without spaces or dashes.
export function extractCode(codeOrUrl: string): string {
    const hashIndex = codeOrUrl.lastIndexOf('#');

    return normalizeBase32(hashIndex < 0 ? codeOrUrl : codeOrUrl.slice(hashIndex + 1));
}

export function buildCodeUrl(appUrl: string, code: string): string {
    const base = appUrl.split('#')[0] ?? appUrl;

    return `${base}#${code}`;
}

// Base32 carries 5 bits per character.
export function codeByteLength(code: string): number {
    return Math.floor((code.length * 5) / 8);
}

// Up to four UDP host candidates the code can carry, the most useful first (HS-03).
export function selectCodeCandidates(candidates: readonly SdpCandidate[]): HostCandidate[] {
    const usable = candidates
        .filter(isUdpHostCandidate)
        .map(candidate => ({ candidate, address: addressToBytes(candidate.address) }))
        .filter(entry => entry.address != null && entry.candidate.port > 0 && entry.candidate.port <= 0xffff)
        .sort((first, second) => rankCandidate(first) - rankCandidate(second));
    const seen = new Set<string>();
    const selected: HostCandidate[] = [];

    for (const { candidate } of usable) {
        const key = `${candidate.address} ${candidate.port}`;
        if (seen.has(key) || selected.length >= MAX_CODE_CANDIDATES) {
            continue;
        }

        seen.add(key);
        selected.push({ address: candidate.address, port: candidate.port });
    }

    return selected;
}

function isUdpHostCandidate(candidate: SdpCandidate): boolean {
    return candidate.component === 1 && candidate.protocol === 'udp' && candidate.type === 'host';
}

function rankCandidate(entry: { candidate: SdpCandidate; address?: { kind: AddressKind } }): number {
    const preference = ADDRESS_PREFERENCE[entry.address?.kind ?? 'ipv6'];

    return preference * 2 ** 32 - entry.candidate.priority;
}

function encodeFlags(payload: PairingPayload): number {
    const kind = payload.kind === 'answer' ? KIND_BIT : 0;

    return kind | (SETUP_ROLES.indexOf(payload.setup) << SETUP_SHIFT);
}

function readVersion(firstByte: number): number {
    if ((firstByte & 0xf0) !== MAGIC) {
        throw invalidCode('This is not an Ether pairing code');
    }

    const version = firstByte & 0x0f;
    if (version !== CODE_VERSION) {
        const message = `The pairing code has version ${version}; this app reads version ${CODE_VERSION}`;
        throw new NetworkError('code-version', message);
    }

    return version;
}

function writeIceText(writer: ByteWriter, text: string): void {
    if (text.length === 0 || text.length > 0xff) {
        throw new RangeError(`ICE credentials of ${text.length} characters do not fit the code`);
    }

    writer.byte(text.length);
    writer.bytes(packIceText(text));
}

function readIceText(reader: ByteReader, minimumLength: number): string {
    const length = reader.byte();
    if (length < minimumLength) {
        throw invalidCode('The pairing code has malformed ICE credentials');
    }

    return unpackIceText(reader.take(Math.ceil((length * 6) / 8)), length);
}

function packIceText(text: string): Uint8Array {
    const bytes = new Uint8Array(Math.ceil((text.length * 6) / 8));
    let bitOffset = 0;

    for (const character of text) {
        const value = ICE_CHARACTERS.indexOf(character);
        if (value < 0) {
            throw new RangeError('ICE credentials contain a character outside the ICE character set');
        }

        writeBits(bytes, bitOffset, value);
        bitOffset += 6;
    }

    return bytes;
}

function unpackIceText(bytes: Uint8Array, length: number): string {
    return Array.from({ length }, (_, index) => ICE_CHARACTERS.charAt(readBits(bytes, index * 6))).join('');
}

// Six bits, most significant first, starting at a bit offset.
function writeBits(bytes: Uint8Array, bitOffset: number, value: number): void {
    for (let bit = 0; bit < 6; bit++) {
        const position = bitOffset + bit;
        if (((value >> (5 - bit)) & 1) === 1) {
            const index = position >> 3;
            bytes[index] = (bytes[index] ?? 0) | (0x80 >> (position & 7));
        }
    }
}

function readBits(bytes: Uint8Array, bitOffset: number): number {
    let value = 0;
    for (let bit = 0; bit < 6; bit++) {
        const position = bitOffset + bit;
        value = (value << 1) | (((bytes[position >> 3] ?? 0) >> (7 - (position & 7))) & 1);
    }

    return value;
}

function writeFingerprint(writer: ByteWriter, fingerprint: Uint8Array): void {
    if (!FINGERPRINT_LENGTHS.includes(fingerprint.length)) {
        throw new RangeError(`A ${fingerprint.length}-byte fingerprint does not fit the code`);
    }

    writer.byte(fingerprint.length);
    writer.bytes(fingerprint);
}

function readFingerprint(reader: ByteReader): Uint8Array {
    const length = reader.byte();
    if (!FINGERPRINT_LENGTHS.includes(length)) {
        throw invalidCode('The pairing code has a malformed fingerprint');
    }

    return reader.take(length).slice();
}

function writeMid(writer: ByteWriter, mid: string): void {
    if (!MID_PATTERN.test(mid)) {
        throw new RangeError('The mid must be 1–255 printable ASCII characters');
    }

    writer.byte(mid.length);
    writer.bytes(Uint8Array.from(mid, character => character.charCodeAt(0)));
}

function readMid(reader: ByteReader): string {
    const bytes = reader.take(reader.byte());
    const mid = String.fromCharCode(...bytes);
    if (!MID_PATTERN.test(mid)) {
        throw invalidCode('The pairing code has a malformed mid');
    }

    return mid;
}

function writeCandidates(writer: ByteWriter, candidates: readonly HostCandidate[]): void {
    if (candidates.length > MAX_CODE_CANDIDATES) {
        throw new RangeError(`The code carries at most ${MAX_CODE_CANDIDATES} candidates`);
    }

    writer.byte(candidates.length);
    for (const candidate of candidates) {
        const address = addressToBytes(candidate.address);
        const kind = ADDRESS_KINDS.find(entry => entry.kind === address?.kind);
        if (address == null || kind == null || candidate.port < 1 || candidate.port > 0xffff) {
            const endpoint = `${candidate.address}:${candidate.port}`;
            throw new RangeError(`The candidate ${endpoint} does not fit the code`);
        }

        writer.byte(kind.id);
        writer.bytes(address.bytes);
        writer.uint16(candidate.port);
    }
}

function readCandidates(reader: ByteReader): HostCandidate[] {
    const count = reader.byte();
    if (count > MAX_CODE_CANDIDATES) {
        throw invalidCode('The pairing code has too many candidates');
    }

    return Array.from({ length: count }, () => {
        const id = reader.byte();
        const kind = ADDRESS_KINDS.find(entry => entry.id === id)?.kind;
        if (kind == null) {
            throw invalidCode('The pairing code has an unknown address type');
        }

        const address = bytesToAddress(kind, reader.take(ADDRESS_LENGTHS[kind]));
        const port = reader.uint16();
        if (port === 0) {
            throw invalidCode('The pairing code has a candidate without a port');
        }

        return { address, port };
    });
}

function writeOfferTag(writer: ByteWriter, offerTag: number | undefined): void {
    if (offerTag == null || !Number.isInteger(offerTag) || offerTag < 0 || offerTag > MAX_UINT16) {
        throw new RangeError('An answer needs the 16-bit tag of the offer it answers');
    }

    writer.uint16(offerTag);
}

function invalidCode(message: string): NetworkError {
    return new NetworkError('code-invalid', message);
}

class ByteWriter {
    private readonly values: number[] = [];

    byte(value: number): void {
        this.values.push(value & 0xff);
    }

    uint16(value: number): void {
        this.byte(value >> 8);
        this.byte(value);
    }

    uint32(value: number): void {
        if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
            throw new RangeError(`${value} does not fit 32 bits`);
        }

        this.uint16(Math.floor(value / 0x10000));
        this.uint16(value % 0x10000);
    }

    bytes(values: Uint8Array): void {
        this.values.push(...values);
    }

    toBytes(): Uint8Array {
        return Uint8Array.from(this.values);
    }
}

class ByteReader {
    private offset = 0;

    constructor(private readonly source: Uint8Array) {}

    get remaining(): number {
        return this.source.length - this.offset;
    }

    take(length: number): Uint8Array {
        if (length > this.remaining) {
            throw invalidCode('The pairing code is cut short');
        }

        const slice = this.source.subarray(this.offset, this.offset + length);
        this.offset += length;

        return slice;
    }

    byte(): number {
        return this.take(1)[0] ?? 0;
    }

    uint16(): number {
        return this.byte() * 0x100 + this.byte();
    }

    uint32(): number {
        return this.uint16() * 0x10000 + this.uint16();
    }
}
