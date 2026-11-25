import { describe, expect, it, vi } from 'vitest';
import { SILENT_LOGGER } from '../core/logger.js';
import type { FileMetadata } from './metadataTypes.js';
import {
    createThumbnailAsync,
    decodeHint,
    encodeWithinBudgetAsync,
    thumbnailLayout,
    videoFrameTime,
} from './thumbnail.js';
import type { CanvasTransform, DecodedImage, Imaging, ThumbnailLayout } from './thumbnail.js';

const PREVIEW = new Blob(['preview'], { type: 'image/jpeg' });

function createImage(width: number, height: number, name: string): DecodedImage & { readonly name: string } {
    return { name, width, height, source: {} as CanvasImageSource, close: vi.fn() };
}

// Sizes per quality step: 0.7 → 30 KiB, 0.6 → 26 KiB, 0.5 → 22 KiB…
function jpegOfQuality(quality: number): Blob {
    return new Blob([new Uint8Array(Math.round((quality * 40 + 2) * 1024))], { type: 'image/jpeg' });
}

function createImaging(overrides: Partial<Imaging> = {}) {
    const layouts: ThumbnailLayout[] = [];
    const drawn: string[] = [];
    const imaging: Imaging = {
        readEmbeddedThumbnailAsync: vi.fn(async () => PREVIEW),
        decodeImageAsync: vi.fn(async (blob: Blob) => (
            blob === PREVIEW ? createImage(160, 120, 'preview') : createImage(256, 192, 'full')
        )),
        captureVideoFrameAsync: vi.fn(async () => createImage(1920, 1080, 'frame')),
        draw: (image, layout) => {
            layouts.push(layout);
            drawn.push((image as DecodedImage & { name: string }).name);

            return { toJpegAsync: async quality => jpegOfQuality(quality) };
        },
        ...overrides,
    };

    return { imaging, layouts, drawn };
}

function photo(name = 'IMG_1.JPG', type = 'image/jpeg'): File {
    return new File(['pixels'], name, { type });
}

function applyTransform(transform: CanvasTransform, x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = transform;

    return [a * x + c * y + e, b * x + d * y + f];
}

describe('createThumbnailAsync', () => {
    it('uses the embedded preview and applies the EXIF orientation to it', async () => {
        // Arrange
        const { imaging, layouts, drawn } = createImaging();
        const metadata: FileMetadata = { orientation: 6, width: 4032, height: 3024 };

        // Act
        const thumbnail = await createThumbnailAsync(photo(), metadata, { imaging, logger: SILENT_LOGGER });

        // Assert
        expect(drawn).toEqual(['preview']);
        expect(layouts[0]).toEqual({
            canvasWidth: 120,
            canvasHeight: 160,
            drawWidth: 160,
            drawHeight: 120,
            transform: [0, 1, -1, 0, 120, 0],
        });
        expect(thumbnail?.size).toBeLessThanOrEqual(24 * 1024);
    });

    it('decodes the whole photo with a one-sided size hint when there is no preview', async () => {
        // Arrange
        const { imaging, layouts, drawn } = createImaging({ readEmbeddedThumbnailAsync: vi.fn(async () => undefined) });
        const metadata: FileMetadata = { orientation: 6, width: 4032, height: 3024 };

        // Act
        await createThumbnailAsync(photo(), metadata, { imaging, logger: SILENT_LOGGER });

        // Assert
        expect(drawn).toEqual(['full']);
        expect(imaging.decodeImageAsync).toHaveBeenCalledWith(expect.any(File), { resizeHeight: 256 });
        expect(layouts[0]?.transform).toEqual([1, 0, 0, 1, 0, 0]);
    });

    it('falls back to the whole photo when the preview does not decode', async () => {
        // Arrange
        const decodeImageAsync = vi.fn(async (blob: Blob) => (blob === PREVIEW ? undefined : createImage(256, 192, 'full')));
        const { imaging, drawn } = createImaging({ decodeImageAsync });

        // Act
        await createThumbnailAsync(photo(), {}, { imaging, logger: SILENT_LOGGER });

        // Assert
        expect(drawn).toEqual(['full']);
    });

    it('skips the preview when the orientation is unknown because metadata is missing', async () => {
        // Arrange
        const { imaging, drawn } = createImaging();

        // Act
        await createThumbnailAsync(photo('IMG_2.HEIC', ''), undefined, { imaging, logger: SILENT_LOGGER });

        // Assert
        expect(imaging.readEmbeddedThumbnailAsync).not.toHaveBeenCalled();
        expect(drawn).toEqual(['full']);
    });

    it('draws a video frame scaled to 256 px', async () => {
        // Arrange
        const { imaging, layouts, drawn } = createImaging();
        const clip = new File(['movie'], 'clip.mov', { type: 'video/quicktime' });

        // Act
        await createThumbnailAsync(clip, undefined, { imaging, logger: SILENT_LOGGER });

        // Assert
        expect(drawn).toEqual(['frame']);
        expect(layouts[0]).toMatchObject({ canvasWidth: 256, canvasHeight: 144 });
    });

    it('makes no thumbnail for other files or formats the browser cannot decode', async () => {
        // Arrange
        const { imaging } = createImaging({
            readEmbeddedThumbnailAsync: vi.fn(async () => undefined),
            decodeImageAsync: vi.fn(async () => undefined),
        });
        const scan = new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' });

        // Act
        const results = await Promise.all([
            createThumbnailAsync(scan, undefined, { imaging, logger: SILENT_LOGGER }),
            createThumbnailAsync(photo('IMG_3.HEIC', 'image/heic'), {}, { imaging, logger: SILENT_LOGGER }),
        ]);

        // Assert
        expect(results).toEqual([undefined, undefined]);
        expect(imaging.captureVideoFrameAsync).not.toHaveBeenCalled();
    });

    it('releases the decoded image and resolves undefined when drawing fails', async () => {
        // Arrange
        const image = createImage(100, 100, 'full');
        const { imaging } = createImaging({
            readEmbeddedThumbnailAsync: vi.fn(async () => undefined),
            decodeImageAsync: vi.fn(async () => image),
            draw: () => {
                throw new Error('canvas lost');
            },
        });

        // Act
        const thumbnail = await createThumbnailAsync(photo(), {}, { imaging, logger: SILENT_LOGGER });

        // Assert
        expect(thumbnail).toBeUndefined();
        expect(image.close).toHaveBeenCalledTimes(1);
    });
});

describe('encodeWithinBudgetAsync', () => {
    it('steps the quality down until the JPEG fits', async () => {
        // Arrange
        const toJpegAsync = vi.fn(async (quality: number) => jpegOfQuality(quality));

        // Act
        const jpeg = await encodeWithinBudgetAsync({ toJpegAsync }, 24 * 1024);

        // Assert
        expect(toJpegAsync.mock.calls.map(([quality]) => quality)).toEqual([0.7, 0.6, 0.5]);
        expect(jpeg?.size).toBe(22 * 1024);
    });

    it('gives up when even the lowest quality is too large', async () => {
        // Act
        const jpeg = await encodeWithinBudgetAsync({ toJpegAsync: async () => new Blob([new Uint8Array(30_000)]) }, 24 * 1024);

        // Assert
        expect(jpeg).toBeUndefined();
    });
});

describe('thumbnailLayout', () => {
    it('scales the longest side to 256 and never enlarges', () => {
        // Act
        const large = thumbnailLayout({ width: 4032, height: 3024 }, 1, 256);
        const small = thumbnailLayout({ width: 100, height: 50 }, 1, 256);

        // Assert
        expect(large).toMatchObject({ canvasWidth: 256, canvasHeight: 192 });
        expect(small).toMatchObject({ canvasWidth: 100, canvasHeight: 50 });
    });

    it('maps the image corners onto the canvas corners for every orientation', () => {
        // Arrange
        const source = { width: 200, height: 100 };
        const cornersOf = (width: number, height: number): number[][] => [[0, 0], [width, 0], [0, height], [width, height]];

        // Act
        const corners = [1, 2, 3, 4, 5, 6, 7, 8].map(orientation => {
            const layout = thumbnailLayout(source, orientation, 256);
            const mapped = cornersOf(200, 100).map(([x = 0, y = 0]) => applyTransform(layout.transform, x, y));

            return { layout, mapped: mapped.map(point => point.join(',')).sort() };
        });

        // Assert
        for (const { layout, mapped } of corners) {
            const expected = cornersOf(layout.canvasWidth, layout.canvasHeight);
            expect(mapped).toEqual(expected.map(point => point.join(',')).sort());
        }
    });

    it('turns the top edge into the right edge for orientation 6', () => {
        // Act
        const layout = thumbnailLayout({ width: 200, height: 100 }, 6, 256);

        // Assert
        expect(applyTransform(layout.transform, 0, 0)).toEqual([100, 0]);
        expect(applyTransform(layout.transform, 200, 0)).toEqual([100, 200]);
    });
});

describe('decodeHint', () => {
    it('asks for the displayed longest side only', () => {
        // Act
        const landscape = decodeHint({ width: 4032, height: 3024 });
        const rotated = decodeHint({ width: 4032, height: 3024, orientation: 8 });
        const small = decodeHint({ width: 200, height: 100 });
        const unknown = decodeHint(undefined);

        // Assert
        expect(landscape).toEqual({ resizeWidth: 256 });
        expect(rotated).toEqual({ resizeHeight: 256 });
        expect(small).toBeUndefined();
        expect(unknown).toBeUndefined();
    });
});

describe('videoFrameTime', () => {
    it('seeks to 1 s, to the middle of short clips, and to 0 without a duration', () => {
        // Act
        const times = [10, 1.5, 0, Number.NaN, Number.POSITIVE_INFINITY].map(videoFrameTime);

        // Assert
        expect(times).toEqual([1, 0.75, 0, 0, 0]);
    });
});
