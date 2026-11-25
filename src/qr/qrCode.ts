import qrcode from 'qrcode-generator';

// HS-04 and UI-03: the pairing QR. The URL keeps its case, so it goes in as bytes; the Base32 code after "#"
// fits the denser alphanumeric mode (5.5 bits per character instead of 8), which keeps the version small.

export interface QrMatrix {
    readonly size: number;
    readonly version: number;
    isDark(row: number, column: number): boolean;
}

export type QrSegmentMode = 'Byte' | 'Alphanumeric';

export interface QrSegment {
    readonly mode: QrSegmentMode;
    readonly data: string;
}

export interface QrSvgOptions {
    // In modules; the QR specification asks for at least 4.
    readonly quietZone?: number;
}

const BASE32_CODE = /^[A-Z2-7]+$/;
const ERROR_CORRECTION = 'M';
const SMALLEST_FITTING_VERSION = 0;
const DEFAULT_QUIET_ZONE = 4;

export function splitQrSegments(text: string): QrSegment[] {
    if (BASE32_CODE.test(text)) {
        return [{ mode: 'Alphanumeric', data: text }];
    }

    const hash = text.lastIndexOf('#');
    const code = text.slice(hash + 1);
    if (hash < 0 || !BASE32_CODE.test(code)) {
        return [{ mode: 'Byte', data: text }];
    }

    return [
        { mode: 'Byte', data: text.slice(0, hash + 1) },
        { mode: 'Alphanumeric', data: code },
    ];
}

export function createQrMatrix(text: string): QrMatrix {
    const code = qrcode(SMALLEST_FITTING_VERSION, ERROR_CORRECTION);
    for (const segment of splitQrSegments(text)) {
        code.addData(segment.mode === 'Byte' ? toByteString(segment.data) : segment.data, segment.mode);
    }

    try {
        code.make();
    } catch (error) {
        // The library throws a plain string when the text exceeds version 40.
        throw new RangeError(`Text is too long for a QR code (${text.length} characters)`, { cause: error });
    }

    const size = code.getModuleCount();
    const modules = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
            modules[row * size + column] = code.isDark(row, column) ? 1 : 0;
        }
    }

    const isInside = (index: number): boolean => index >= 0 && index < size;

    return {
        size,
        version: (size - 17) / 4,
        isDark: (row, column) => isInside(row) && isInside(column) && modules[row * size + column] === 1,
    };
}

// Black on white in every theme, crisp edges and one path of horizontal runs.
// No style attributes: the page's Content Security Policy forbids them.
export function renderQrSvg(matrix: QrMatrix, options: QrSvgOptions = {}): string {
    const quietZone = options.quietZone ?? DEFAULT_QUIET_ZONE;
    const extent = matrix.size + quietZone * 2;
    const path = darkRuns(matrix)
        .map(run => `M${run.column + quietZone} ${run.row + quietZone}h${run.length}v1h-${run.length}z`)
        .join('');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges">`,
        `<rect width="${extent}" height="${extent}" fill="#fff"/>`,
        `<path fill="#000" d="${path}"/>`,
        '</svg>',
    ].join('');
}

interface DarkRun {
    readonly row: number;
    readonly column: number;
    readonly length: number;
}

function darkRuns(matrix: QrMatrix): DarkRun[] {
    const runs: DarkRun[] = [];
    for (let row = 0; row < matrix.size; row++) {
        let start = -1;
        for (let column = 0; column <= matrix.size; column++) {
            const isDark = column < matrix.size && matrix.isDark(row, column);
            if (isDark && start < 0) {
                start = column;
            }

            if (!isDark && start >= 0) {
                runs.push({ row, column: start, length: column - start });
                start = -1;
            }
        }
    }

    return runs;
}

// The library maps each character to one byte, so UTF-8 bytes are passed as one character each.
function toByteString(text: string): string {
    return String.fromCharCode(...new TextEncoder().encode(text));
}
