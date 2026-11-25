import { createSha256 } from '../core/sha256.js';
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from './encoding.js';

// A device with a PIN takes a nearby request without an Accept when the request proves the asker knows the PIN.
// The PIN itself never travels: the request carries
//   proof = base64url(HMAC-SHA256(key = PIN, message = requestId + "|" + hex(SHA-256(offer code))))
// inside its sealed box, so a proof is bound to one request and one offer and can't be reused for another.
// Guessing is slowed by the PIN guard below: a few wrong proofs, then `busy` for a minute, and again for each
// further wrong proof while the earlier ones are recent, so guesses come at about one a minute.

// HMAC (RFC 2104) works on 64-byte blocks for SHA-256.
const BLOCK_BYTES = 64;
const INNER_PAD = 0x36;
const OUTER_PAD = 0x5c;
const PROOF_BYTES = 32;

export const PIN_ATTEMPTS_PER_ASKER = 5;
// Wrong proofs from every asker together, so new identities don't buy new guesses.
export const PIN_ATTEMPTS_IN_TOTAL = 10;
// Wrong proofs older than this no longer count.
export const PIN_ATTEMPT_WINDOW_MS = 10 * 60_000;
export const PIN_LOCKOUT_MS = 60_000;
// Askers remembered, the oldest forgotten first, so a flood of identities can't grow the map.
const MAX_ASKERS = 256;

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
    const block = new Uint8Array(BLOCK_BYTES);
    block.set(key.length > BLOCK_BYTES ? createSha256().update(key).digest() : key);
    const inner = block.map(byte => byte ^ INNER_PAD);
    const outer = block.map(byte => byte ^ OUTER_PAD);
    const innerHash = createSha256().update(inner).update(message).digest();

    return createSha256().update(outer).update(innerHash).digest();
}

export function createPinProof(pin: string, requestId: string, offerCode: string): string {
    return bytesToBase64Url(proofBytes(pin, requestId, offerCode));
}

// Compares every byte, so the time taken says nothing about how close a wrong proof was.
export function isPinProofValid(pin: string, requestId: string, offerCode: string, proof: string): boolean {
    const given = base64UrlToBytes(proof);
    if (given?.length !== PROOF_BYTES) {
        return false;
    }

    const expected = proofBytes(pin, requestId, offerCode);
    let difference = 0;
    for (let index = 0; index < PROOF_BYTES; index++) {
        difference |= (given[index] ?? 0) ^ (expected[index] ?? 0);
    }

    return difference === 0;
}

function proofBytes(pin: string, requestId: string, offerCode: string): Uint8Array {
    const offerHash = createSha256().update(utf8Bytes(offerCode)).digestHex();

    return hmacSha256(utf8Bytes(pin), utf8Bytes(`${requestId}|${offerHash}`));
}

// Who asked, as the request's envelope says: its nearbyId and the run it was sent from.
export interface PinAsker {
    readonly nearbyId: string;
    readonly run: string;
}

export type WrongPinResult = 'counted' | 'asker-locked' | 'all-locked';

export interface PinGuard {
    // True while requests from this asker (its nearbyId or its run), or from everyone, get `busy`.
    isLockedOut(asker: PinAsker): boolean;
    // Counts a wrong proof; one that reaches a limit starts the lockout it names.
    recordWrong(asker: PinAsker): WrongPinResult;
    // A right proof clears that asker's count.
    recordRight(asker: PinAsker): void;
}

interface AttemptLog {
    // When the latest wrong proofs in the window came, oldest first; no more than the limit.
    times: number[];
    lockedUntil: number;
}

// After PIN_ATTEMPTS_PER_ASKER wrong proofs within PIN_ATTEMPT_WINDOW_MS from one nearbyId or one run, that asker
// gets `busy` for PIN_LOCKOUT_MS; after PIN_ATTEMPTS_IN_TOTAL from everyone together, every request does.
// The count isn't reset by a lockout, so a wrong proof after it, while the others are still in the window,
// locks again at once.
export function createPinGuard(now: () => number): PinGuard {
    const askers = new Map<string, AttemptLog>();
    const total: AttemptLog = { times: [], lockedUntil: Number.NEGATIVE_INFINITY };

    const keysOf = (asker: PinAsker): string[] => [`id:${asker.nearbyId}`, `run:${asker.run}`];

    const logOf = (key: string): AttemptLog => {
        const log = askers.get(key) ?? { times: [], lockedUntil: Number.NEGATIVE_INFINITY };
        askers.delete(key);
        askers.set(key, log);
        while (askers.size > MAX_ASKERS) {
            const oldest = askers.keys().next().value;
            if (oldest == null) {
                break;
            }

            askers.delete(oldest);
        }

        return log;
    };

    // Adds one wrong proof; true when the window holds the limit, which locks.
    const count = (log: AttemptLog, limit: number, at: number): boolean => {
        log.times = [...log.times.filter(time => at - time < PIN_ATTEMPT_WINDOW_MS), at].slice(-limit);
        if (log.times.length < limit) {
            return false;
        }

        log.lockedUntil = at + PIN_LOCKOUT_MS;

        return true;
    };

    return {
        isLockedOut: asker => {
            const at = now();

            const isAskerLocked = keysOf(asker)
                .some(key => (askers.get(key)?.lockedUntil ?? Number.NEGATIVE_INFINITY) > at);

            return isAskerLocked || total.lockedUntil > at;
        },
        recordWrong: asker => {
            const at = now();
            const logs = keysOf(asker).map(logOf);
            const isAskerLocked = logs.map(log => count(log, PIN_ATTEMPTS_PER_ASKER, at)).some(Boolean);
            if (isAskerLocked) {
                for (const log of logs) {
                    log.lockedUntil = at + PIN_LOCKOUT_MS;
                }
            }

            if (count(total, PIN_ATTEMPTS_IN_TOTAL, at)) {
                return 'all-locked';
            }

            return isAskerLocked ? 'asker-locked' : 'counted';
        },
        recordRight: asker => {
            for (const key of keysOf(asker)) {
                askers.delete(key);
            }
        },
    };
}
