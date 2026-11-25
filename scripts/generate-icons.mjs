// Draws the app icons into public/icons: a teal-to-blue tile with waves rising from a dot.
// Run by hand when the design changes; the PNGs are committed.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICON_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const START_COLOR = [0x00, 0x5f, 0xb8];
const END_COLOR = [0x4e, 0xc9, 0xb0];
const GLYPH_COLOR = [0xff, 0xff, 0xff];
const SAMPLES = 4;

const ICONS = [
    { name: 'icon-192.png', size: 192, maskable: false },
    { name: 'icon-512.png', size: 512, maskable: false },
    { name: 'icon-maskable-512.png', size: 512, maskable: true },
    { name: 'apple-touch-icon.png', size: 180, maskable: true },
    { name: 'favicon-32.png', size: 32, maskable: false },
];

// The glyph in unit coordinates: a dot and three arcs opening upwards.
const DOT = { x: 0.5, y: 0.66, radius: 0.065 };
const ARC_RADII = [0.17, 0.28, 0.39];
const ARC_WIDTH = 0.06;
const ARC_HALF_ANGLE = Math.PI / 4;

const CRC_TABLE = (() => {
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

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 0);

    return Buffer.concat([length, typeBytes, payload, checksum]);
}

function encodePng(size, rgba) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = Buffer.alloc((size * 4 + 1) * size);
    for (let row = 0; row < size; row++) {
        rows[row * (size * 4 + 1)] = 0;
        rgba.copy(rows, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(rows)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function insideGlyph(x, y) {
    if (Math.hypot(x - DOT.x, y - DOT.y) <= DOT.radius) {
        return true;
    }

    const distance = Math.hypot(x - DOT.x, y - DOT.y);
    const angle = Math.atan2(DOT.x - x, DOT.y - y);
    if (Math.abs(angle) > ARC_HALF_ANGLE) {
        // Round caps at the arc ends.
        return ARC_RADII.some(radius => {
            const capAngle = Math.sign(angle) * ARC_HALF_ANGLE;
            const capX = DOT.x - Math.sin(capAngle) * radius;
            const capY = DOT.y - Math.cos(capAngle) * radius;

            return Math.hypot(x - capX, y - capY) <= ARC_WIDTH / 2;
        });
    }

    return ARC_RADII.some(radius => Math.abs(distance - radius) <= ARC_WIDTH / 2);
}

function insideTile(x, y, maskable) {
    if (maskable) {
        return true;
    }

    const corner = 0.22;
    const dx = Math.max(corner - x, 0, x - (1 - corner));
    const dy = Math.max(corner - y, 0, y - (1 - corner));

    return Math.hypot(dx, dy) <= corner;
}

function drawIcon(size, maskable) {
    const rgba = Buffer.alloc(size * size * 4);
    // Maskable icons keep the glyph inside the central 80% safe zone.
    const scale = maskable ? 0.78 : 1;

    for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
            let tile = 0;
            let glyph = 0;
            for (let sampleY = 0; sampleY < SAMPLES; sampleY++) {
                for (let sampleX = 0; sampleX < SAMPLES; sampleX++) {
                    const x = (column + (sampleX + 0.5) / SAMPLES) / size;
                    const y = (row + (sampleY + 0.5) / SAMPLES) / size;
                    tile += insideTile(x, y, maskable) ? 1 : 0;
                    glyph += insideGlyph(0.5 + (x - 0.5) / scale, 0.5 + (y - 0.5) / scale) ? 1 : 0;
                }
            }

            const total = SAMPLES * SAMPLES;
            const weight = (column + row) / (2 * size - 2);
            const background = START_COLOR.map((start, channel) => start + (END_COLOR[channel] - start) * weight);
            const glyphShare = glyph / total;
            const color = background.map((value, channel) => Math.round(value * (1 - glyphShare) + GLYPH_COLOR[channel] * glyphShare));
            const offset = (row * size + column) * 4;
            rgba[offset] = color[0];
            rgba[offset + 1] = color[1];
            rgba[offset + 2] = color[2];
            rgba[offset + 3] = Math.round((tile / total) * 255);
        }
    }

    return encodePng(size, rgba);
}

function svgIcon() {
    const arcs = ARC_RADII.map(radius => {
        const startX = DOT.x - Math.sin(ARC_HALF_ANGLE) * radius;
        const endX = DOT.x + Math.sin(ARC_HALF_ANGLE) * radius;
        const y = DOT.y - Math.cos(ARC_HALF_ANGLE) * radius;

        return `<path d="M${(startX * 100).toFixed(2)} ${(y * 100).toFixed(2)}A${radius * 100} ${radius * 100} 0 0 1 ${(endX * 100).toFixed(2)} ${(y * 100).toFixed(2)}"/>`;
    }).join('');

    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
        '<stop offset="0" stop-color="#005fb8"/><stop offset="1" stop-color="#4ec9b0"/>',
        '</linearGradient></defs>',
        '<rect width="100" height="100" rx="22" fill="url(#g)"/>',
        `<circle cx="${DOT.x * 100}" cy="${DOT.y * 100}" r="${DOT.radius * 100}" fill="#fff"/>`,
        `<g fill="none" stroke="#fff" stroke-width="${ARC_WIDTH * 100}" stroke-linecap="round">${arcs}</g>`,
        '</svg>',
        '',
    ].join('\n');
}

await mkdir(ICON_DIRECTORY, { recursive: true });
for (const icon of ICONS) {
    await writeFile(join(ICON_DIRECTORY, icon.name), drawIcon(icon.size, icon.maskable));
}

await writeFile(join(ICON_DIRECTORY, 'icon.svg'), svgIcon(), 'utf-8');
console.log(`Wrote ${ICONS.length + 1} icons to ${ICON_DIRECTORY}`);
