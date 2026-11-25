import { createSha256 } from '../core/sha256.js';
import { bytesToHex, hexToBytes, utf8Bytes } from './encoding.js';

// BIP-340 Schnorr signatures over secp256k1, the signatures Nostr events carry (NIP-01).
// BigInt arithmetic is not constant-time. The keys are made per page load and sign only throwaway
// nearby messages, so a timing leak would expose nothing that outlives the page.

const FIELD_PRIME = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const CURVE_B = 7n;
// The field prime is 3 modulo 4, so a square root is one exponentiation.
const SQUARE_ROOT_EXPONENT = (FIELD_PRIME + 1n) / 4n;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
// Multiples 0–15 of a point, so a scalar costs 64 additions instead of 128.
const WINDOW_BITS = 4;
const WINDOW_SIZE = 1 << WINDOW_BITS;

// Jacobian coordinates (x / z^2, y / z^3); z = 0 is the point at infinity.
interface JacobianPoint {
    readonly x: bigint;
    readonly y: bigint;
    readonly z: bigint;
}

interface AffinePoint {
    readonly x: bigint;
    readonly y: bigint;
}

const INFINITY: JacobianPoint = Object.freeze({ x: 0n, y: 1n, z: 0n });
const GENERATOR: JacobianPoint = Object.freeze({
    x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
    z: 1n,
});

const tagHashes = new Map<string, Uint8Array>();
let generatorTable: readonly JacobianPoint[] | undefined;

export function isValidSecretKey(secretKey: Uint8Array): boolean {
    if (secretKey.length !== KEY_BYTES) {
        return false;
    }

    const scalar = bytesToBigInt(secretKey);

    return scalar > 0n && scalar < CURVE_ORDER;
}

// The 32-byte x-only public key of BIP-340.
export function schnorrPublicKey(secretKey: Uint8Array): Uint8Array {
    const point = publicPoint(secretKey);

    return bigIntToBytes(point.x);
}

export function signSchnorr(message: Uint8Array, secretKey: Uint8Array, auxRandom: Uint8Array): Uint8Array {
    if (auxRandom.length !== KEY_BYTES) {
        throw new RangeError('BIP-340 needs 32 bytes of auxiliary randomness');
    }

    const point = publicPoint(secretKey);
    const publicKey = bigIntToBytes(point.x);
    const rawSecret = bytesToBigInt(secretKey);
    const secret = isEven(point.y) ? rawSecret : CURVE_ORDER - rawSecret;
    const masked = xorBytes(bigIntToBytes(secret), taggedHash('BIP0340/aux', auxRandom));
    const rawNonce = modulo(bytesToBigInt(taggedHash('BIP0340/nonce', masked, publicKey, message)), CURVE_ORDER);
    if (rawNonce === 0n) {
        throw new RangeError('BIP-340 nonce is zero');
    }

    const commitment = toAffine(multiplyGenerator(rawNonce));
    if (commitment == null) {
        throw new RangeError('BIP-340 nonce point is at infinity');
    }

    const nonce = isEven(commitment.y) ? rawNonce : CURVE_ORDER - rawNonce;
    const commitmentBytes = bigIntToBytes(commitment.x);
    const challenge = modulo(
        bytesToBigInt(taggedHash('BIP0340/challenge', commitmentBytes, publicKey, message)),
        CURVE_ORDER,
    );
    const signature = new Uint8Array(SIGNATURE_BYTES);
    signature.set(commitmentBytes, 0);
    signature.set(bigIntToBytes(modulo(nonce + challenge * secret, CURVE_ORDER)), KEY_BYTES);

    return signature;
}

export function verifySchnorr(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    if (signature.length !== SIGNATURE_BYTES || publicKey.length !== KEY_BYTES) {
        return false;
    }

    const point = liftX(bytesToBigInt(publicKey));
    const commitmentBytes = signature.subarray(0, KEY_BYTES);
    const commitmentX = bytesToBigInt(commitmentBytes);
    const response = bytesToBigInt(signature.subarray(KEY_BYTES));
    if (point == null || commitmentX >= FIELD_PRIME || response >= CURVE_ORDER) {
        return false;
    }

    const challenge = modulo(
        bytesToBigInt(taggedHash('BIP0340/challenge', commitmentBytes, publicKey, message)),
        CURVE_ORDER,
    );
    const negated = modulo(CURVE_ORDER - challenge, CURVE_ORDER);
    const sum = add(multiplyGenerator(response), multiply({ ...point, z: 1n }, negated));
    const commitment = toAffine(sum);

    return commitment != null && isEven(commitment.y) && commitment.x === commitmentX;
}

function publicPoint(secretKey: Uint8Array): AffinePoint {
    if (!isValidSecretKey(secretKey)) {
        throw new RangeError('A secp256k1 secret key is 32 bytes between 1 and the curve order');
    }

    const point = toAffine(multiplyGenerator(bytesToBigInt(secretKey)));
    if (point == null) {
        throw new RangeError('The public key is at infinity');
    }

    return point;
}

function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
    let tagHash = tagHashes.get(tag);
    if (tagHash == null) {
        tagHash = createSha256().update(utf8Bytes(tag)).digest();
        tagHashes.set(tag, tagHash);
    }

    const hash = createSha256().update(tagHash).update(tagHash);
    for (const part of parts) {
        hash.update(part);
    }

    return hash.digest();
}

function liftX(x: bigint): AffinePoint | undefined {
    if (x >= FIELD_PRIME) {
        return undefined;
    }

    const square = modulo(x * x * x + CURVE_B);
    const root = power(square, SQUARE_ROOT_EXPONENT);
    if (modulo(root * root) !== square) {
        return undefined;
    }

    return { x, y: isEven(root) ? root : FIELD_PRIME - root };
}

function double(point: JacobianPoint): JacobianPoint {
    if (point.z === 0n || point.y === 0n) {
        return INFINITY;
    }

    const ySquared = modulo(point.y * point.y);
    const slopePart = modulo(4n * point.x * ySquared);
    const tangent = modulo(3n * point.x * point.x);
    const x = modulo(tangent * tangent - 2n * slopePart);
    const y = modulo(tangent * (slopePart - x) - 8n * ySquared * ySquared);

    return { x, y, z: modulo(2n * point.y * point.z) };
}

function add(first: JacobianPoint, second: JacobianPoint): JacobianPoint {
    if (first.z === 0n) {
        return second;
    }

    if (second.z === 0n) {
        return first;
    }

    const firstZSquared = modulo(first.z * first.z);
    const secondZSquared = modulo(second.z * second.z);
    const firstX = modulo(first.x * secondZSquared);
    const secondX = modulo(second.x * firstZSquared);
    const firstY = modulo(first.y * secondZSquared * second.z);
    const secondY = modulo(second.y * firstZSquared * first.z);
    if (firstX === secondX) {
        return firstY === secondY ? double(first) : INFINITY;
    }

    const xDifference = modulo(secondX - firstX);
    const yDifference = modulo(secondY - firstY);
    const differenceSquared = modulo(xDifference * xDifference);
    const differenceCubed = modulo(differenceSquared * xDifference);
    const scaledX = modulo(firstX * differenceSquared);
    const x = modulo(yDifference * yDifference - differenceCubed - 2n * scaledX);
    const y = modulo(yDifference * (scaledX - x) - firstY * differenceCubed);

    return { x, y, z: modulo(xDifference * first.z * second.z) };
}

function multiplyGenerator(scalar: bigint): JacobianPoint {
    generatorTable ??= buildWindowTable(GENERATOR);

    return multiplyWithTable(generatorTable, scalar);
}

function multiply(point: JacobianPoint, scalar: bigint): JacobianPoint {
    return multiplyWithTable(buildWindowTable(point), scalar);
}

function buildWindowTable(point: JacobianPoint): readonly JacobianPoint[] {
    const table: JacobianPoint[] = [INFINITY, point];
    for (let index = 2; index < WINDOW_SIZE; index++) {
        table.push(add(table[index - 1] ?? INFINITY, point));
    }

    return table;
}

// Fixed 4-bit windows from the most significant end.
function multiplyWithTable(table: readonly JacobianPoint[], scalar: bigint): JacobianPoint {
    const digits = scalar.toString(WINDOW_SIZE);
    let result = INFINITY;
    for (const digit of digits) {
        for (let bit = 0; bit < WINDOW_BITS; bit++) {
            result = double(result);
        }

        result = add(result, table[Number.parseInt(digit, WINDOW_SIZE)] ?? INFINITY);
    }

    return result;
}

function toAffine(point: JacobianPoint): AffinePoint | undefined {
    if (point.z === 0n) {
        return undefined;
    }

    const inverse = invert(point.z);
    const inverseSquared = modulo(inverse * inverse);

    return { x: modulo(point.x * inverseSquared), y: modulo(point.y * inverseSquared * inverse) };
}

function modulo(value: bigint, modulus = FIELD_PRIME): bigint {
    const remainder = value % modulus;

    return remainder >= 0n ? remainder : remainder + modulus;
}

// Extended Euclid; the modulus is prime, so every non-zero value has an inverse.
function invert(value: bigint, modulus = FIELD_PRIME): bigint {
    let remainder = modulo(value, modulus);
    let previousRemainder = modulus;
    let coefficient = 1n;
    let previousCoefficient = 0n;
    while (remainder !== 0n) {
        const quotient = previousRemainder / remainder;
        [remainder, previousRemainder] = [previousRemainder - quotient * remainder, remainder];
        [coefficient, previousCoefficient] = [previousCoefficient - quotient * coefficient, coefficient];
    }

    return modulo(previousCoefficient, modulus);
}

function power(base: bigint, exponent: bigint, modulus = FIELD_PRIME): bigint {
    let result = 1n;
    let square = modulo(base, modulus);
    for (let remaining = exponent; remaining > 0n; remaining >>= 1n) {
        if ((remaining & 1n) === 1n) {
            result = modulo(result * square, modulus);
        }

        square = modulo(square * square, modulus);
    }

    return result;
}

function isEven(value: bigint): boolean {
    return (value & 1n) === 0n;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    return bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
}

function bigIntToBytes(value: bigint): Uint8Array {
    return hexToBytes(value.toString(16).padStart(KEY_BYTES * 2, '0')) ?? new Uint8Array(KEY_BYTES);
}

function xorBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
    return first.map((byte, index) => byte ^ (second[index] ?? 0));
}
