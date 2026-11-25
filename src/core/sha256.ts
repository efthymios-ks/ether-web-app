// SHA-256 (FIPS 180-4) fed piece by piece, for whole-file hashes that `crypto.subtle.digest()` can't stream.

const ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = Object.freeze([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_BYTES = 64;
const LENGTH_BYTES = 8;
const TWO_TO_THE_32 = 0x1_0000_0000;

export interface Sha256 {
    update(bytes: Uint8Array): Sha256;
    digest(): Uint8Array;
    digestHex(): string;
}

function rotateRight(value: number, count: number): number {
    return (value >>> count) | (value << (32 - count));
}

export function createSha256(): Sha256 {
    const state = new Uint32Array(INITIAL_STATE);
    const schedule = new Uint32Array(64);
    const block = new Uint8Array(BLOCK_BYTES);
    let blockLength = 0;
    let totalBytes = 0;
    let isFinished = false;

    const compress = (bytes: Uint8Array, offset: number): void => {
        for (let index = 0; index < 16; index++) {
            const at = offset + index * 4;
            schedule[index] = (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
        }

        for (let index = 16; index < 64; index++) {
            const early = schedule[index - 15] ?? 0;
            const late = schedule[index - 2] ?? 0;
            const sigma0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3);
            const sigma1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10);
            schedule[index] = ((schedule[index - 16] ?? 0) + sigma0 + (schedule[index - 7] ?? 0) + sigma1) >>> 0;
        }

        let a = state[0] ?? 0;
        let b = state[1] ?? 0;
        let c = state[2] ?? 0;
        let d = state[3] ?? 0;
        let e = state[4] ?? 0;
        let f = state[5] ?? 0;
        let g = state[6] ?? 0;
        let h = state[7] ?? 0;
        for (let index = 0; index < 64; index++) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const first = (h + sum1 + choice + (ROUND_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const second = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + first) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (first + second) >>> 0;
        }

        state[0] = ((state[0] ?? 0) + a) >>> 0;
        state[1] = ((state[1] ?? 0) + b) >>> 0;
        state[2] = ((state[2] ?? 0) + c) >>> 0;
        state[3] = ((state[3] ?? 0) + d) >>> 0;
        state[4] = ((state[4] ?? 0) + e) >>> 0;
        state[5] = ((state[5] ?? 0) + f) >>> 0;
        state[6] = ((state[6] ?? 0) + g) >>> 0;
        state[7] = ((state[7] ?? 0) + h) >>> 0;
    };

    const update = (bytes: Uint8Array): void => {
        if (isFinished) {
            throw new Error('SHA-256 already finished');
        }

        totalBytes += bytes.length;
        let offset = 0;
        if (blockLength > 0) {
            const taken = Math.min(BLOCK_BYTES - blockLength, bytes.length);
            block.set(bytes.subarray(0, taken), blockLength);
            blockLength += taken;
            offset = taken;
            if (blockLength < BLOCK_BYTES) {
                return;
            }

            compress(block, 0);
            blockLength = 0;
        }

        for (; offset + BLOCK_BYTES <= bytes.length; offset += BLOCK_BYTES) {
            compress(bytes, offset);
        }

        block.set(bytes.subarray(offset), 0);
        blockLength = bytes.length - offset;
    };

    const digest = (): Uint8Array => {
        if (!isFinished) {
            const bitsHigh = Math.floor(totalBytes / (TWO_TO_THE_32 / 8));
            const bitsLow = (totalBytes * 8) % TWO_TO_THE_32;
            const paddingLength = ((BLOCK_BYTES + BLOCK_BYTES - LENGTH_BYTES - 1 - blockLength) % BLOCK_BYTES) + 1;
            const padding = new Uint8Array(paddingLength + LENGTH_BYTES);
            padding[0] = 0x80;
            const view = new DataView(padding.buffer);
            view.setUint32(paddingLength, bitsHigh);
            view.setUint32(paddingLength + 4, bitsLow);
            const counted = totalBytes;
            update(padding);
            totalBytes = counted;
            isFinished = true;
        }

        const result = new Uint8Array(32);
        const view = new DataView(result.buffer);
        state.forEach((word, index) => view.setUint32(index * 4, word));

        return result;
    };

    const hash: Sha256 = {
        update: bytes => {
            update(bytes);

            return hash;
        },
        digest,
        digestHex: () => [...digest()].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    };

    return hash;
}
