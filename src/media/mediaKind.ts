import type { MediaKind } from './metadataTypes.js';

// The type each extension stands for, for photos, videos and audio, whose kind and preview depend on it.
// Some pickers (Windows without a HEIF codec, files without a known type) report no MIME type.
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    avif: 'image/avif',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    dng: 'image/x-adobe-dng',
    jxl: 'image/jxl',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    qt: 'video/quicktime',
    '3gp': 'video/3gpp',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    weba: 'audio/webm',
    aif: 'audio/aiff',
    aiff: 'audio/aiff',
    wma: 'audio/x-ms-wma',
    amr: 'audio/amr',
    mid: 'audio/midi',
    midi: 'audio/midi',
});

// Other names engines and pickers use for the same type; canPlayType answers for the standard name.
const MIME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/x-png': 'image/png',
    'video/x-m4v': 'video/mp4',
    'audio/mp3': 'audio/mpeg',
    'audio/x-mp3': 'audio/mpeg',
    'audio/mpeg3': 'audio/mpeg',
    'audio/x-mpeg-3': 'audio/mpeg',
    'audio/m4a': 'audio/mp4',
    'audio/x-m4a': 'audio/mp4',
    'audio/x-aac': 'audio/aac',
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/vnd.wave': 'audio/wav',
    'audio/x-flac': 'audio/flac',
    'audio/opus': 'audio/ogg',
    'audio/x-aiff': 'audio/aiff',
});

const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream']);

// SP-06: types every supported engine decodes. SVG stays out: it is a document, not a picture.
const BASELINE_PREVIEW_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

// RX-06: decodable or playable only on some engines (HEIC and QuickTime on Safari, AVIF on newer ones,
// FLAC, Ogg and WebM audio where the engine has the codec).
export const PROBED_PREVIEW_TYPES = Object.freeze([
    'image/avif',
    'image/heic',
    'image/heif',
    'image/jxl',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
    'video/3gpp',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/wav',
    'audio/flac',
    'audio/ogg',
    'audio/webm',
]);

const probedPreviewTypes = new Set<string>();

export interface PreviewProbe {
    // An audio or video type this engine plays (HTMLMediaElement.canPlayType).
    canPlayMedia(mime: string): boolean;
    canDecodeImageAsync(mime: string): Promise<boolean>;
}

export function normalizeMime(mime: string): string {
    const type = (mime.split(';')[0] ?? '').trim().toLowerCase();

    return MIME_ALIASES[type] ?? type;
}

// The lower-case text after the name's last dot, or '' without one.
export function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.');

    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// The file's type for its kind and its preview: the MIME type when the picker named one,
// else the type its extension stands for.
export function mediaTypeOf(mime: string, name: string): string {
    const type = normalizeMime(mime);
    if (!GENERIC_MIME_TYPES.has(type)) {
        return type;
    }

    return MEDIA_TYPE_BY_EXTENSION[extensionOf(name)] ?? type;
}

export function mediaKindOf(mime: string, name: string): MediaKind {
    const type = mediaTypeOf(mime, name);
    if (type.startsWith('image/')) {
        return 'image';
    }

    if (type.startsWith('video/')) {
        return 'video';
    }

    return 'other';
}

// RX-06 / SP-06: true only for image, video and audio types this browser decodes or plays; the rest get an icon.
// Without a MIME type, the name's extension decides.
export function canPreview(mime: string, name = ''): boolean {
    const type = mediaTypeOf(mime, name);

    return BASELINE_PREVIEW_TYPES.has(type) || probedPreviewTypes.has(type);
}

// Fills the answers canPreview gives for engine-specific types; runs once at start-up.
export async function probePreviewSupportAsync(
    probe: PreviewProbe | undefined = createBrowserPreviewProbe(),
): Promise<void> {
    if (probe == null) {
        return;
    }

    const results = await Promise.all(PROBED_PREVIEW_TYPES.map(async mime => ({
        mime,
        isSupported: await isSupportedAsync(probe, mime),
    })));

    probedPreviewTypes.clear();
    for (const { mime, isSupported } of results) {
        if (isSupported) {
            probedPreviewTypes.add(mime);
        }
    }
}

async function isSupportedAsync(probe: PreviewProbe, mime: string): Promise<boolean> {
    try {
        return mime.startsWith('image/') ? await probe.canDecodeImageAsync(mime) : probe.canPlayMedia(mime);
    } catch {
        return false;
    }
}

const PROBE_TIMEOUT_MS = 1000;
const PROBE_FALLBACK_SOURCE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

function createBrowserPreviewProbe(): PreviewProbe | undefined {
    if (typeof document === 'undefined') {
        return undefined;
    }

    return {
        canPlayMedia: mime => {
            const element = document.createElement(mime.startsWith('audio/') ? 'audio' : 'video');

            return element.canPlayType(mime) !== '';
        },
        canDecodeImageAsync: mime => canSelectImageTypeAsync(mime),
    };
}

// A <picture> skips a <source> whose type the engine can't decode,
// so the URL it picks answers the question without a sample file.
function canSelectImageTypeAsync(mime: string): Promise<boolean> {
    const candidate = `data:${mime};base64,AA==`;
    const picture = document.createElement('picture');
    const source = document.createElement('source');
    const image = document.createElement('img');
    source.type = mime;
    source.srcset = candidate;
    picture.append(source);

    return new Promise(resolve => {
        const finish = (): void => {
            clearTimeout(timer);
            resolve(image.currentSrc === candidate);
        };
        const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
        image.addEventListener('load', finish, { once: true });
        image.addEventListener('error', finish, { once: true });
        image.src = PROBE_FALLBACK_SOURCE;
        picture.append(image);
    });
}
