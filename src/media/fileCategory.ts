import { extensionOf, mediaKindOf, mediaTypeOf, normalizeMime } from './mediaKind.js';

// What kind of file a file is, for its icon, its preview and the Type filter: photos, videos and audio preview
// or play where the browser can; documents (PDF, Office, OpenDocument, iWork, e-books, text, Markdown, CSV,
// RTF and the like) share one icon, as do archives; everything else is a file.

export type FileCategory = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';

export const FILE_CATEGORIES: readonly FileCategory[] = Object.freeze([
    'image',
    'video',
    'audio',
    'document',
    'archive',
    'other',
]);

const DOCUMENT_TYPES = new Set([
    'application/pdf',
    'application/x-pdf',
    'application/rtf',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.visio',
    'application/vnd.apple.pages',
    'application/vnd.apple.numbers',
    'application/vnd.apple.keynote',
    'application/x-iwork-pages-sffpages',
    'application/x-iwork-numbers-sffnumbers',
    'application/x-iwork-keynote-sffkey',
    'application/epub+zip',
    'application/x-mobipocket-ebook',
    'application/vnd.amazon.ebook',
    'application/json',
    'application/xml',
    'application/x-tex',
    'application/vnd.ms-xpsdocument',
    'application/oxps',
    'application/x-abiword',
]);

// Families of document types: text of every kind, and the Office and OpenDocument formats with their many
// variants (macro-enabled, templates, slide shows).
const DOCUMENT_TYPE_PREFIXES: readonly string[] = Object.freeze([
    'text/',
    'application/vnd.openxmlformats-officedocument.',
    'application/vnd.oasis.opendocument.',
    'application/vnd.ms-word.',
    'application/vnd.ms-excel.',
    'application/vnd.ms-powerpoint.',
]);

const ARCHIVE_TYPES = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/x-zip',
    'application/gzip',
    'application/x-gzip',
    'application/x-tar',
    'application/x-gtar',
    'application/x-bzip',
    'application/x-bzip2',
    'application/x-xz',
    'application/zstd',
    'application/x-7z-compressed',
    'application/vnd.rar',
    'application/x-rar-compressed',
    'application/x-rar',
    'application/x-compress',
    'application/x-compressed',
    'application/x-lzh-compressed',
    'application/x-lzma',
    'application/vnd.ms-cab-compressed',
    'application/x-iso9660-image',
    'application/x-apple-diskimage',
]);

// For files whose picker reports no MIME type, or application/octet-stream.
const CATEGORY_BY_EXTENSION: Readonly<Record<string, FileCategory>> = Object.freeze({
    pdf: 'document',
    doc: 'document',
    docx: 'document',
    docm: 'document',
    dot: 'document',
    dotx: 'document',
    dotm: 'document',
    xls: 'document',
    xlsx: 'document',
    xlsm: 'document',
    xlsb: 'document',
    xlt: 'document',
    xltx: 'document',
    xltm: 'document',
    ppt: 'document',
    pptx: 'document',
    pptm: 'document',
    pps: 'document',
    ppsx: 'document',
    ppsm: 'document',
    pot: 'document',
    potx: 'document',
    potm: 'document',
    odt: 'document',
    ods: 'document',
    odp: 'document',
    odg: 'document',
    odf: 'document',
    ott: 'document',
    ots: 'document',
    otp: 'document',
    pages: 'document',
    numbers: 'document',
    key: 'document',
    rtf: 'document',
    txt: 'document',
    text: 'document',
    log: 'document',
    md: 'document',
    markdown: 'document',
    csv: 'document',
    tsv: 'document',
    json: 'document',
    xml: 'document',
    html: 'document',
    htm: 'document',
    tex: 'document',
    epub: 'document',
    mobi: 'document',
    azw: 'document',
    azw3: 'document',
    xps: 'document',
    oxps: 'document',
    vsd: 'document',
    vsdx: 'document',
    zip: 'archive',
    gz: 'archive',
    tgz: 'archive',
    tar: 'archive',
    bz2: 'archive',
    tbz2: 'archive',
    xz: 'archive',
    txz: 'archive',
    zst: 'archive',
    '7z': 'archive',
    rar: 'archive',
    cab: 'archive',
    lzh: 'archive',
    lzma: 'archive',
    iso: 'archive',
    dmg: 'archive',
});

function categoryOfType(type: string): FileCategory | undefined {
    if (type.startsWith('audio/')) {
        return 'audio';
    }

    if (DOCUMENT_TYPES.has(type) || DOCUMENT_TYPE_PREFIXES.some(prefix => type.startsWith(prefix))) {
        return 'document';
    }

    return ARCHIVE_TYPES.has(type) ? 'archive' : undefined;
}

// Photos and videos are what mediaKindOf says, so a file's category always agrees with its stored kind.
// For the rest, the MIME type decides when it names a category, and the extension when it doesn't.
export function fileCategoryOf(mime: string, name: string): FileCategory {
    const kind = mediaKindOf(mime, name);
    if (kind !== 'other') {
        return kind;
    }

    return categoryOfType(normalizeMime(mime))
        ?? categoryOfType(mediaTypeOf('', name))
        ?? CATEGORY_BY_EXTENSION[extensionOf(name)]
        ?? 'other';
}

// Photos, videos and audio can show or play in the browser; the other categories never do.
export function isPreviewCategory(category: FileCategory): boolean {
    return category === 'image' || category === 'video' || category === 'audio';
}
