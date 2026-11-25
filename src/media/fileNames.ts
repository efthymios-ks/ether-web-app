// RX-05 and UI-09: names that are safe on every file system, unique inside one save, and short enough to show.

const FORBIDDEN_CHARACTERS = /[/\\:*?"<>|\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const EXTENSION = /\.[^.\s]{1,12}$/u;
const PATH_SEPARATORS = /[/\\]+/;
const PATH_JOINER = ' - ';
const REPLACEMENT = '_';
const FALLBACK_NAME = 'file';
const ELLIPSIS = '…';
// Most file systems allow 255 bytes per name; UTF-8 is the strictest common encoding.
const MAX_NAME_BYTES = 255;

export interface NameParts {
    readonly base: string;
    // Includes the dot, e.g. ".jpg"; empty when the name has none.
    readonly extension: string;
}

export function splitExtension(name: string): NameParts {
    const match = EXTENSION.exec(name);
    if (!match || match.index === 0) {
        return { base: name, extension: '' };
    }

    return { base: name.slice(0, match.index), extension: match[0] };
}

export function sanitizeFileName(name: string): string {
    const cleaned = name
        .normalize('NFC')
        .replace(FORBIDDEN_CHARACTERS, REPLACEMENT)
        .trim()
        .replace(TRAILING_DOTS_AND_SPACES, '');
    if (!cleaned) {
        return FALLBACK_NAME;
    }

    const { base, extension } = splitExtension(avoidReservedName(cleaned));

    return limitBytes(base, extension);
}

// Adds " (2)", " (3)"… before the extension until the name is free.
// `taken` holds lower-case names, since phones and desktops compare names without case, and gains the result.
export function uniqueFileName(name: string, taken: Set<string>): string {
    const { base, extension } = splitExtension(name);
    let candidate = name;
    for (let copy = 2; taken.has(candidate.toLowerCase()); copy++) {
        candidate = `${base} (${copy})${extension}`;
    }

    taken.add(candidate.toLowerCase());

    return candidate;
}

// Phones save into flat places (Photos, Downloads), so "Trip/Day 1/IMG_1.jpg" becomes "Trip - Day 1 - IMG_1.jpg".
export function flattenRelativePath(path: string): string {
    const segments = path
        .split(PATH_SEPARATORS)
        .map(segment => segment.trim())
        .filter(segment => segment !== '' && segment !== '.' && segment !== '..');

    return sanitizeFileName(segments.join(PATH_JOINER));
}

export function truncateMiddle(name: string, maxLength: number): string {
    const characters = Array.from(name);
    if (characters.length <= maxLength) {
        return name;
    }

    if (maxLength <= 1) {
        return ELLIPSIS.slice(0, Math.max(0, maxLength));
    }

    const { base, extension } = splitExtension(name);
    const extensionLength = Array.from(extension).length;
    const keptFromBase = maxLength - ELLIPSIS.length - extensionLength;
    if (keptFromBase < 2) {
        return cutMiddle(characters, maxLength - ELLIPSIS.length);
    }

    return `${cutMiddle(Array.from(base), keptFromBase)}${extension}`;
}

function cutMiddle(characters: readonly string[], kept: number): string {
    const headLength = Math.ceil(kept / 2);
    const head = characters.slice(0, headLength).join('');
    const tail = characters.slice(characters.length - (kept - headLength)).join('');

    return `${head}${ELLIPSIS}${tail}`;
}

// Windows refuses "CON", "nul.txt" and the like whatever follows the first dot.
function avoidReservedName(name: string): string {
    const firstDot = name.indexOf('.');
    const stem = firstDot < 0 ? name : name.slice(0, firstDot);
    if (!RESERVED_WINDOWS_NAMES.test(stem)) {
        return name;
    }

    return `${stem}${REPLACEMENT}${name.slice(stem.length)}`;
}

function limitBytes(base: string, extension: string): string {
    const encoder = new TextEncoder();
    if (encoder.encode(base + extension).length <= MAX_NAME_BYTES) {
        return `${base}${extension}`;
    }

    const kept: string[] = [];
    let used = encoder.encode(extension).length;
    for (const character of base) {
        const size = encoder.encode(character).length;
        if (used + size > MAX_NAME_BYTES) {
            break;
        }

        kept.push(character);
        used += size;
    }

    const shortenedBase = kept.join('').replace(TRAILING_DOTS_AND_SPACES, '');

    return `${shortenedBase === '' ? FALLBACK_NAME : shortenedBase}${extension}`;
}
