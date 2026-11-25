// Prints a URL as a QR code in the terminal, so a phone can open the debug site by scanning it.
// Light modules are drawn with block characters, which suits the usual dark terminal background.
//
//   node scripts/print-qr.mjs https://example.devtunnels.ms/
import qrcode from 'qrcode-generator';
import { fileURLToPath } from 'node:url';
import { normalize } from 'node:path';

const QUIET_ZONE = 2;

// Two module rows per text line: the upper and lower half of each character cell.
const HALF_BLOCKS = Object.freeze({
    'light-light': '█',
    'light-dark': '▀',
    'dark-light': '▄',
    'dark-dark': ' ',
});

export function renderQrText(text) {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const isLight = (row, column) => row < 0 || column < 0 || row >= count || column >= count || !qr.isDark(row, column);
    const lines = [];

    for (let row = -QUIET_ZONE; row < count + QUIET_ZONE; row += 2) {
        let line = '';
        for (let column = -QUIET_ZONE; column < count + QUIET_ZONE; column++) {
            const top = isLight(row, column) ? 'light' : 'dark';
            const bottom = isLight(row + 1, column) ? 'light' : 'dark';
            line += HALF_BLOCKS[`${top}-${bottom}`];
        }

        lines.push(line);
    }

    return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
    const url = process.argv[2];
    if (!url) {
        process.stderr.write('Usage: node scripts/print-qr.mjs <url>\n');
        process.exit(1);
    }

    process.stdout.write(`${renderQrText(url)}\n`);
}
