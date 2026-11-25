// CRC-32 (IEEE 802.3) for store-only ZIP entries, updated page by page as data arrives (SV-04).

const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }

        table[index] = value >>> 0;
    }

    return table;
})();

export const CRC32_INITIAL = 0;

// Continues a running CRC; start from CRC32_INITIAL and feed every byte range in order.
export function crc32Update(crc: number, bytes: Uint8Array): number {
    let value = ~crc >>> 0;
    for (const byte of bytes) {
        value = (TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
    }

    return ~value >>> 0;
}

export function crc32(bytes: Uint8Array): number {
    return crc32Update(CRC32_INITIAL, bytes);
}
