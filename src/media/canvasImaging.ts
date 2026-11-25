import { readEmbeddedThumbnailAsync } from './imageMetadata.js';
import { videoFrameTime } from './thumbnail.js';
import type { DecodedImage, DecodeHint, Imaging, ThumbnailCanvas, ThumbnailLayout } from './thumbnail.js';

// The browser side of thumbnails (TH-01): decoding, drawing and JPEG encoding.
// Thin on purpose: the decisions live in thumbnail.ts, where Node tests cover them.

const VIDEO_EVENT_TIMEOUT_MS = 5000;
const HAVE_CURRENT_DATA = 2;

type ThumbnailCanvasElement = OffscreenCanvas | HTMLCanvasElement;
type Context2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function createCanvasImaging(): Imaging {
    return {
        readEmbeddedThumbnailAsync,
        decodeImageAsync,
        captureVideoFrameAsync,
        draw,
    };
}

async function decodeImageAsync(blob: Blob, hint?: DecodeHint): Promise<DecodedImage | undefined> {
    if (typeof createImageBitmap !== 'function') {
        return undefined;
    }

    try {
        const options: ImageBitmapOptions | undefined = hint == null
            ? undefined
            : { ...hint, resizeQuality: 'high' };
        const bitmap = await createImageBitmap(blob, options);

        return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
    } catch {
        return undefined;
    }
}

// Loads the clip from an object URL (revoked on close) and seeks to 1 s, or the middle of shorter clips.
async function captureVideoFrameAsync(blob: Blob): Promise<DecodedImage | undefined> {
    if (typeof document === 'undefined') {
        return undefined;
    }

    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    const release = (): void => {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    };

    try {
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.src = url;
        await waitForEventAsync(video, 'loadedmetadata');
        video.currentTime = videoFrameTime(video.duration);
        await waitForEventAsync(video, 'seeked');
        if (video.readyState < HAVE_CURRENT_DATA) {
            await waitForEventAsync(video, 'loadeddata');
        }

        if (video.videoWidth === 0 || video.videoHeight === 0) {
            release();

            return undefined;
        }

        return { width: video.videoWidth, height: video.videoHeight, source: video, close: release };
    } catch {
        release();

        return undefined;
    }
}

function draw(image: DecodedImage, layout: ThumbnailLayout): ThumbnailCanvas {
    const canvas = createCanvas(layout.canvasWidth, layout.canvasHeight);
    const context = canvas.getContext('2d') as Context2d | null;
    if (context == null) {
        return { toJpegAsync: async () => undefined };
    }

    // JPEG has no transparency; without a background transparent PNGs turn black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);
    context.imageSmoothingQuality = 'high';
    context.setTransform(...layout.transform);
    context.drawImage(image.source, 0, 0, layout.drawWidth, layout.drawHeight);

    return { toJpegAsync: quality => toJpegAsync(canvas, quality) };
}

function createCanvas(width: number, height: number): ThumbnailCanvasElement {
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(width, height);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    return canvas;
}

async function toJpegAsync(canvas: ThumbnailCanvasElement, quality: number): Promise<Blob | undefined> {
    if ('convertToBlob' in canvas) {
        return canvas.convertToBlob({ type: 'image/jpeg', quality });
    }

    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob ?? undefined), 'image/jpeg', quality);
    });
}

function waitForEventAsync(video: HTMLVideoElement, type: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const finish = (error?: Error): void => {
            clearTimeout(timer);
            video.removeEventListener(type, onEvent);
            video.removeEventListener('error', onError);
            if (error != null) {
                reject(error);

                return;
            }

            resolve();
        };
        const onEvent = (): void => finish();
        const onError = (): void => finish(new Error(`video could not load (${type})`));
        const onTimeout = (): void => finish(new Error(`video timed out waiting for ${type}`));
        const timer = setTimeout(onTimeout, VIDEO_EVENT_TIMEOUT_MS);
        video.addEventListener(type, onEvent);
        video.addEventListener('error', onError);
    });
}
