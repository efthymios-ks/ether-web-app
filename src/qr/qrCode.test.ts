import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';
import { createQrMatrix, renderQrSvg, splitQrSegments } from './qrCode.js';
import type { QrMatrix } from './qrCode.js';
import { decodeQrImageData } from './qrScanner.js';
import type { QrImageData } from './qrScanner.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const APP_URL = 'https://example.github.io/ether-web-app/';

function base32Code(length: number): string {
    return Array.from({ length }, (_, index) => BASE32_ALPHABET[(index * 7 + 3) % 32]).join('');
}

const PAIRING_URL = `${APP_URL}#${base32Code(140)}`;

// Draws the matrix as black-on-white RGBA pixels, the way a camera frame would arrive.
function rasterize(matrix: QrMatrix, moduleSize = 4, quietZone = 4): QrImageData {
    const side = (matrix.size + quietZone * 2) * moduleSize;
    const data = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            const isDark = matrix.isDark(Math.floor(y / moduleSize) - quietZone, Math.floor(x / moduleSize) - quietZone);
            if (isDark) {
                const pixel = (y * side + x) * 4;
                data[pixel] = 0;
                data[pixel + 1] = 0;
                data[pixel + 2] = 0;
            }
        }
    }

    return { data, width: side, height: side };
}

function byteOnlyVersion(text: string): number {
    const code = qrcode(0, 'M');
    code.addData(text, 'Byte');
    code.make();

    return (code.getModuleCount() - 17) / 4;
}

describe('splitQrSegments', () => {
    it('puts the URL up to "#" in byte mode and the Base32 code in alphanumeric mode', () => {
        // Act
        const segments = splitQrSegments(`${APP_URL}#ABCD2345`);

        // Assert
        expect(segments).toEqual([
            { mode: 'Byte', data: `${APP_URL}#` },
            { mode: 'Alphanumeric', data: 'ABCD2345' },
        ]);
    });

    it('encodes a bare code as alphanumeric and anything else as bytes', () => {
        // Act
        const bare = splitQrSegments('ABCD2345');
        const lowerCase = splitQrSegments(`${APP_URL}#abcd2345`);
        const noHash = splitQrSegments(APP_URL);

        // Assert
        expect(bare).toEqual([{ mode: 'Alphanumeric', data: 'ABCD2345' }]);
        expect(lowerCase).toEqual([{ mode: 'Byte', data: `${APP_URL}#abcd2345` }]);
        expect(noHash).toEqual([{ mode: 'Byte', data: APP_URL }]);
    });
});

describe('createQrMatrix', () => {
    it('round-trips a pairing URL through jsQR', () => {
        // Arrange
        const matrix = createQrMatrix(PAIRING_URL);

        // Act
        const text = decodeQrImageData(rasterize(matrix));

        // Assert
        expect(text).toBe(PAIRING_URL);
    });

    it('stores the code in an alphanumeric segment after a byte segment', () => {
        // Arrange
        const image = rasterize(createQrMatrix(PAIRING_URL));

        // Act
        const result = jsQR(image.data, image.width, image.height);

        // Assert
        expect(result?.chunks.map(chunk => chunk.type)).toEqual(['byte', 'alphanumeric']);
    });

    it('needs no larger a version than byte mode alone, and at most 10', () => {
        // Act
        const matrix = createQrMatrix(PAIRING_URL);

        // Assert
        expect(matrix.version).toBeLessThan(byteOnlyVersion(PAIRING_URL));
        expect(matrix.version).toBeLessThanOrEqual(10);
        expect(matrix.size).toBe(matrix.version * 4 + 17);
    });

    it('keeps non-ASCII text intact as UTF-8 bytes', () => {
        // Arrange
        const text = 'Grüße aus Αθήνα #abc';

        // Act
        const decoded = decodeQrImageData(rasterize(createQrMatrix(text)));

        // Assert
        expect(decoded).toBe(text);
    });

    it('answers false outside the matrix', () => {
        // Act
        const matrix = createQrMatrix('ABC');

        // Assert
        expect(matrix.isDark(0, 0)).toBe(true);
        expect([matrix.isDark(-1, 0), matrix.isDark(0, matrix.size), matrix.isDark(matrix.size, 0)]).toEqual([false, false, false]);
    });

    it('throws a RangeError when the text cannot fit any version', () => {
        // Act
        const create = (): QrMatrix => createQrMatrix('x'.repeat(3000));

        // Assert
        expect(create).toThrow(RangeError);
    });
});

describe('decodeQrImageData', () => {
    it('resolves undefined for a frame without a code', () => {
        // Arrange
        const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };

        // Act
        const text = decodeQrImageData(blank);

        // Assert
        expect(text).toBeUndefined();
    });
});

describe('renderQrSvg', () => {
    it('draws black modules on white inside a 4-module quiet zone, as one crisp path without styles', () => {
        // Arrange
        const matrix = createQrMatrix(PAIRING_URL);
        const extent = matrix.size + 8;

        // Act
        const svg = renderQrSvg(matrix);

        // Assert
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        expect(svg).toContain(`viewBox="0 0 ${extent} ${extent}"`);
        expect(svg).toContain('shape-rendering="crispEdges"');
        expect(svg).toContain(`<rect width="${extent}" height="${extent}" fill="#fff"/>`);
        expect(svg.match(/<path /g)).toHaveLength(1);
        expect(svg).toContain('fill="#000"');
        expect(svg).not.toContain('style');
    });

    it('covers exactly the dark modules, offset by the quiet zone', () => {
        // Arrange
        const matrix = createQrMatrix('HELLO');
        const quietZone = 2;

        // Act
        const svg = renderQrSvg(matrix, { quietZone });

        // Assert
        const drawn = new Set<string>();
        for (const [, x = '0', y = '0', length = '0'] of svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
            for (let offset = 0; offset < Number(length); offset++) {
                drawn.add(`${Number(y) - quietZone},${Number(x) - quietZone + offset}`);
            }
        }

        const expected = new Set<string>();
        for (let row = 0; row < matrix.size; row++) {
            for (let column = 0; column < matrix.size; column++) {
                if (matrix.isDark(row, column)) {
                    expected.add(`${row},${column}`);
                }
            }
        }

        expect(svg).toContain(`viewBox="0 0 ${matrix.size + 4} ${matrix.size + 4}"`);
        expect(drawn).toEqual(expected);
    });
});
