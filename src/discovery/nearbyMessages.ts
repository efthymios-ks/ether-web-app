import { toDevicePlatform } from '../core/deviceInfo.js';
import type { DevicePlatform, DeviceType } from '../core/deviceInfo.js';

// The nearby protocol's messages and their checks. Like the metadata sanitizer, parsing keeps only known
// fields of the right type and size, cleans names, ignores unknown fields, and drops anything malformed.
//
// Room messages travel sealed with the room key. `run` is new each time the device joins (start, or the page
// becoming visible again), so a goodbye ends that run only, and a reloaded page that keeps its id is welcome back:
//   here    {"v":1,"t":"here","from":"<id>","run":"<id>","name":"…","device":"phone","platform":"Android",
//            "key":"<P-256 key>","pin":true,"joined":true}
//           (joined only on the first presence after joining or rejoining the room: "greet me";
//           platform is optional, and an unknown one is left out, so older and newer builds still list each other;
//           pin only when the device has a PIN, never the PIN itself)
//   bye     {"v":1,"t":"bye","from":"<id>","run":"<id>"}
//   direct  {"v":1,"t":"direct","from":"<id>","run":"<id>","to":"<id>","key":"<P-256 key>","box":"<sealed message>"}
// Direct messages travel in `box`, sealed with the key the two devices share:
//   request {"t":"request","id":"<request id>","offer":"<code>","ttl":60000,"name":"…","device":"phone",
//            "proof":"<HMAC of the asked device's PIN>"}
//           (proof only when the asker entered a PIN: nearbyPin.ts; an older build ignores it)
//   accept  {"t":"accept","id":"<request id>","answer":"<code>"}
//   decline {"t":"decline","id":"<request id>","reason":"declined"}
//           (reason: declined, busy, pin-required or wrong-pin; an unknown reason reads as declined)
//   cancel  {"t":"cancel","id":"<request id>"}

export const PROTOCOL_VERSION = 1;
// Like the device name setting.
export const MAX_NAME_CHARACTERS = 32;
export const MAX_PLAINTEXT_CHARS = 4096;
export const MAX_CODE_CHARS = 2048;
export const MIN_REQUEST_TTL_MS = 5000;
export const MAX_REQUEST_TTL_MS = 5 * 60_000;

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
// Base64url of a 65-byte P-256 point is 87 characters.
const KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;
// Base64url of a 32-byte HMAC-SHA256 is 43 characters.
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BOX_PATTERN = /^[A-Za-z0-9_-]{38,3600}$/;
// A pairing code or its URL: printable ASCII without spaces.
const CODE_PATTERN = /^[\x21-\x7e]+$/;
// C0 and C1 controls, bidi overrides and isolates, and the line and paragraph separators.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
const DEVICE_TYPES: readonly DeviceType[] = Object.freeze(['phone', 'tablet', 'desktop']);

// Why a request was turned down: declined by the person, busy (connected, pairing, or too many wrong PINs),
// or, from a device with a PIN, no PIN given or a wrong one.
export type DeclineReason = 'declined' | 'busy' | 'pin-required' | 'wrong-pin';

const DECLINE_REASONS: readonly DeclineReason[] = Object.freeze(['declined', 'busy', 'pin-required', 'wrong-pin']);

export type RoomMessage =
    | {
        readonly t: 'here';
        readonly from: string;
        readonly run: string;
        readonly name: string;
        readonly device: DeviceType;
        readonly platform?: DevicePlatform;
        readonly key: string;
        readonly pin?: true;
        readonly joined?: true;
    }
    | { readonly t: 'bye'; readonly from: string; readonly run: string }
    | {
        readonly t: 'direct';
        readonly from: string;
        readonly run: string;
        readonly to: string;
        readonly key: string;
        readonly box: string;
    };

type RoomParser = (fields: Fields, from: string, run: string) => RoomMessage | undefined;
type DirectParser = (fields: Fields, id: string) => DirectMessage | undefined;

export type DirectMessage =
    | {
        readonly t: 'request';
        readonly id: string;
        readonly offer: string;
        readonly ttl: number;
        readonly name: string;
        readonly device: DeviceType;
        readonly proof?: string;
    }
    | { readonly t: 'accept'; readonly id: string; readonly answer: string }
    | { readonly t: 'decline'; readonly id: string; readonly reason: DeclineReason }
    | { readonly t: 'cancel'; readonly id: string };

type Fields = Readonly<Record<string, unknown>>;

const ROOM_PARSERS: Readonly<Record<string, RoomParser>> = Object.freeze({
    here: (fields, from, run) => {
        const name = sanitizeName(fields.name);
        const key = matching(fields.key, KEY_PATTERN);
        if (name == null || key == null) {
            return undefined;
        }

        const message = { t: 'here', from, run, name, device: toDeviceType(fields.device), key } as const;
        const platform = toDevicePlatform(fields.platform);
        const described = platform == null ? message : { ...message, platform };
        const locked = fields.pin === true ? { ...described, pin: true } as const : described;

        return fields.joined === true ? { ...locked, joined: true } : locked;
    },
    bye: (_, from, run) => ({ t: 'bye', from, run }),
    direct: (fields, from, run) => {
        const to = matching(fields.to, ID_PATTERN);
        const key = matching(fields.key, KEY_PATTERN);
        const box = matching(fields.box, BOX_PATTERN);
        if (to == null || key == null || box == null) {
            return undefined;
        }

        return { t: 'direct', from, run, to, key, box };
    },
});

const DIRECT_PARSERS: Readonly<Record<string, DirectParser>> = Object.freeze({
    request: (fields, id) => {
        const offer = toCode(fields.offer);
        const name = sanitizeName(fields.name);
        const ttl = fields.ttl;
        if (offer == null || name == null || !Number.isInteger(ttl)) {
            return undefined;
        }

        const clamped = Math.min(MAX_REQUEST_TTL_MS, Math.max(MIN_REQUEST_TTL_MS, ttl as number));
        const request = { t: 'request', id, offer, ttl: clamped, name, device: toDeviceType(fields.device) } as const;
        // A malformed proof counts as none, so the asked device answers pin-required.
        const proof = matching(fields.proof, PROOF_PATTERN);

        return proof == null ? request : { ...request, proof };
    },
    accept: (fields, id) => {
        const answer = toCode(fields.answer);

        return answer == null ? undefined : { t: 'accept', id, answer };
    },
    decline: (fields, id) => ({ t: 'decline', id, reason: toDeclineReason(fields.reason) }),
    cancel: (_, id) => ({ t: 'cancel', id }),
});

export function parseRoomMessage(text: string): RoomMessage | undefined {
    const fields = parseObject(text);
    const version = fields?.v;
    const from = matching(fields?.from, ID_PATTERN);
    const run = matching(fields?.run, ID_PATTERN);
    const isValid = fields != null
        && Number.isInteger(version)
        && (version as number) >= PROTOCOL_VERSION
        && from != null
        && run != null;
    if (!isValid) {
        return undefined;
    }

    return findParser(ROOM_PARSERS, fields.t)?.(fields, from, run);
}

export function parseDirectMessage(text: string): DirectMessage | undefined {
    const fields = parseObject(text);
    const id = matching(fields?.id, ID_PATTERN);
    if (fields == null || id == null) {
        return undefined;
    }

    return findParser(DIRECT_PARSERS, fields.t)?.(fields, id);
}

export function serializeRoomMessage(message: RoomMessage): string {
    return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}

export function serializeDirectMessage(message: DirectMessage): string {
    return JSON.stringify(message);
}

// Trimmed, single-spaced, without control or direction characters, at most 32 characters (emoji count as one);
// undefined when nothing is left.
export function sanitizeName(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const cleaned = value
        .slice(0, MAX_NAME_CHARACTERS * 8)
        .replace(UNSAFE_CHARACTERS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const limited = Array.from(cleaned).slice(0, MAX_NAME_CHARACTERS).join('').trim();

    return limited === '' ? undefined : limited;
}

export function isValidCode(value: unknown): value is string {
    return toCode(value) != null;
}

export function isValidId(value: unknown): value is string {
    return matching(value, ID_PATTERN) != null;
}

export function toDeviceType(value: unknown): DeviceType {
    return DEVICE_TYPES.includes(value as DeviceType) ? (value as DeviceType) : 'desktop';
}

// A reason from a newer build that this one doesn't know reads as a plain no.
function toDeclineReason(value: unknown): DeclineReason {
    return DECLINE_REASONS.includes(value as DeclineReason) ? (value as DeclineReason) : 'declined';
}

// Own keys only, so a type such as "constructor" finds nothing.
function findParser<Parser>(parsers: Readonly<Record<string, Parser>>, type: unknown): Parser | undefined {
    return typeof type === 'string' && Object.hasOwn(parsers, type) ? parsers[type] : undefined;
}

function toCode(value: unknown): string | undefined {
    return typeof value === 'string' && value.length <= MAX_CODE_CHARS ? matching(value, CODE_PATTERN) : undefined;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
    return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function parseObject(text: string): Fields | undefined {
    if (text.length > MAX_PLAINTEXT_CHARS) {
        return undefined;
    }

    try {
        const value: unknown = JSON.parse(text);

        return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : undefined;
    } catch {
        return undefined;
    }
}
