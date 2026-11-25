import type { Logger } from '../core/logger.js';
import { mediaKindOf } from './mediaKind.js';
import type { FileMetadata, MediaKind } from './metadataTypes.js';

// TH-01: one small JPEG per photo or video, made from a copy; the file's own bytes are never touched (MD-01).

export const THUMBNAIL_MAX_SIDE = 256;
export const THUMBNAIL_MAX_BYTES = 24 * 1024;
// About 0.7, stepped down until the JPEG fits the byte budget.
export const THUMBNAIL_QUALITIES = Object.freeze([0.7, 0.6, 0.5, 0.4, 0.3, 0.2]);
// Seek here for the video frame, or to the middle of shorter clips.
export const VIDEO_FRAME_SECONDS = 1;

export type CanvasTransform = readonly [number, number, number, number, number, number];

export interface Size {
    readonly width: number;
    readonly height: number;
}

export interface DecodedImage extends Size {
    readonly source: CanvasImageSource;
    close(): void;
}

// Only one side is given, so the decoder keeps the real aspect ratio even when the stored size is stale.
export interface DecodeHint {
    readonly resizeWidth?: number;
    readonly resizeHeight?: number;
}

export interface ThumbnailLayout {
    readonly canvasWidth: number;
    readonly canvasHeight: number;
    readonly drawWidth: number;
    readonly drawHeight: number;
    // For setTransform(a, b, c, d, e, f) before drawing the unrotated image at (0, 0).
    readonly transform: CanvasTransform;
}

export interface ThumbnailCanvas {
    toJpegAsync(quality: number): Promise<Blob | undefined>;
}

// The browser work (decoding, canvas, <video>), injected so the decisions here run under Node in tests.
export interface Imaging {
    readEmbeddedThumbnailAsync(file: Blob): Promise<Blob | undefined>;
    decodeImageAsync(blob: Blob, hint?: DecodeHint): Promise<DecodedImage | undefined>;
    captureVideoFrameAsync(blob: Blob): Promise<DecodedImage | undefined>;
    draw(image: DecodedImage, layout: ThumbnailLayout): ThumbnailCanvas;
}

export interface ThumbnailOptions {
    readonly imaging: Imaging;
    readonly logger: Logger;
}

interface DecodedSource {
    readonly image: DecodedImage;
    readonly orientation: number;
}

type SourceDecoder = (
    file: File,
    metadata: FileMetadata | undefined,
    imaging: Imaging,
) => Promise<DecodedSource | undefined>;

interface ThumbnailSource {
    readonly kind: MediaKind;
    readonly decodeAsync: SourceDecoder;
}

// Tried in order for the file's kind; the first one that decodes wins.
const THUMBNAIL_SOURCES: readonly ThumbnailSource[] = Object.freeze([
    {
        // The preview embedded in EXIF holds unrotated pixels, so the metadata's orientation is applied here.
        // Without metadata the orientation is unknown, and the full decode below is safer.
        kind: 'image',
        decodeAsync: async (file, metadata, imaging) => {
            if (metadata == null) {
                return undefined;
            }

            const preview = await imaging.readEmbeddedThumbnailAsync(file);
            const image = preview == null ? undefined : await imaging.decodeImageAsync(preview);

            return image == null ? undefined : { image, orientation: metadata.orientation ?? 1 };
        },
    },
    {
        // Browsers apply the EXIF orientation themselves when they decode the whole file.
        kind: 'image',
        decodeAsync: async (file, metadata, imaging) => {
            const image = await imaging.decodeImageAsync(file, decodeHint(metadata));

            return image == null ? undefined : { image, orientation: 1 };
        },
    },
    {
        kind: 'video',
        decodeAsync: async (file, _, imaging) => {
            const image = await imaging.captureVideoFrameAsync(file);

            return image == null ? undefined : { image, orientation: 1 };
        },
    },
]);

type TransformFactory = (width: number, height: number) => CanvasTransform;

// EXIF orientation 1–8 as canvas transforms for a canvas of the oriented size.
const ORIENTATION_TRANSFORMS = Object.freeze<Record<number, TransformFactory>>({
    1: () => [1, 0, 0, 1, 0, 0],
    2: width => [-1, 0, 0, 1, width, 0],
    3: (width, height) => [-1, 0, 0, -1, width, height],
    4: (_, height) => [1, 0, 0, -1, 0, height],
    5: () => [0, 1, 1, 0, 0, 0],
    6: width => [0, 1, -1, 0, width, 0],
    7: (width, height) => [0, -1, -1, 0, width, height],
    8: (_, height) => [0, -1, 1, 0, 0, height],
});

// Resolves undefined when the browser can't decode the file (TH-01 then shows a file-type icon); never rejects.
export async function createThumbnailAsync(
    file: File,
    metadata: FileMetadata | undefined,
    options: ThumbnailOptions,
): Promise<Blob | undefined> {
    try {
        const decoded = await decodeSourceAsync(file, metadata, options.imaging);
        if (decoded == null) {
            options.logger.debug('xfer', 'no thumbnail: not decodable here', { name: file.name, type: file.type });

            return undefined;
        }

        try {
            const layout = thumbnailLayout(decoded.image, decoded.orientation, THUMBNAIL_MAX_SIDE);

            return await encodeWithinBudgetAsync(options.imaging.draw(decoded.image, layout), THUMBNAIL_MAX_BYTES);
        } finally {
            decoded.image.close();
        }
    } catch (error) {
        options.logger.debug('xfer', 'no thumbnail: drawing failed', { name: file.name, error });

        return undefined;
    }
}

export function thumbnailLayout(source: Size, orientation: number, maxSide: number): ThumbnailLayout {
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    const drawWidth = Math.max(1, Math.round(source.width * scale));
    const drawHeight = Math.max(1, Math.round(source.height * scale));
    const transformFor = ORIENTATION_TRANSFORMS[orientation] ?? ORIENTATION_TRANSFORMS[1];
    const isTransposed = orientation >= 5 && orientation <= 8;
    const canvasWidth = isTransposed ? drawHeight : drawWidth;
    const canvasHeight = isTransposed ? drawWidth : drawHeight;

    return {
        canvasWidth,
        canvasHeight,
        drawWidth,
        drawHeight,
        transform: transformFor?.(canvasWidth, canvasHeight) ?? [1, 0, 0, 1, 0, 0],
    };
}

export function decodeHint(
    metadata: FileMetadata | undefined,
    maxSide = THUMBNAIL_MAX_SIDE,
): DecodeHint | undefined {
    const width = metadata?.width;
    const height = metadata?.height;
    if (width == null || height == null || Math.max(width, height) <= maxSide) {
        return undefined;
    }

    const isTransposed = (metadata?.orientation ?? 1) >= 5;
    const displayedWidth = isTransposed ? height : width;
    const displayedHeight = isTransposed ? width : height;

    return displayedWidth >= displayedHeight ? { resizeWidth: maxSide } : { resizeHeight: maxSide };
}

export async function encodeWithinBudgetAsync(
    canvas: ThumbnailCanvas,
    maxBytes: number,
): Promise<Blob | undefined> {
    for (const quality of THUMBNAIL_QUALITIES) {
        const jpeg = await canvas.toJpegAsync(quality);
        if (jpeg != null && jpeg.size <= maxBytes) {
            return jpeg;
        }
    }

    return undefined;
}

export function videoFrameTime(durationSeconds: number): number {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return 0;
    }

    return durationSeconds >= 2 * VIDEO_FRAME_SECONDS ? VIDEO_FRAME_SECONDS : durationSeconds / 2;
}

async function decodeSourceAsync(
    file: File,
    metadata: FileMetadata | undefined,
    imaging: Imaging,
): Promise<DecodedSource | undefined> {
    const kind = mediaKindOf(file.type, file.name);
    for (const source of THUMBNAIL_SOURCES) {
        if (source.kind !== kind) {
            continue;
        }

        const decoded = await source.decodeAsync(file, metadata, imaging);
        if (decoded != null) {
            return decoded;
        }
    }

    return undefined;
}
