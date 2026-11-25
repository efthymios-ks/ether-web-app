import jsQR from 'jsqr';
import type { Logger } from '../core/logger.js';

// HS-09: BarcodeDetector where the browser has it (not on iPhone), jsQR on a downscaled frame everywhere else.

export interface QrImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
}

export interface FrameDecoder {
    readonly name: string;
    decodeAsync(video: HTMLVideoElement): Promise<string | undefined>;
}

export interface QrScannerOptions {
    readonly video: HTMLVideoElement;
    onCode(text: string): void;
    readonly logger: Logger;
    readonly framesPerSecond?: number;
    // Replaces the browser decoders, e.g. in tests.
    readonly createDecoderAsync?: () => Promise<FrameDecoder>;
}

export interface QrScanner {
    start(): void;
    stop(): void;
}

export interface RepeatFilter {
    accept(text: string, now: number): boolean;
}

export interface FrameSize {
    readonly width: number;
    readonly height: number;
}

const DEFAULT_FRAMES_PER_SECOND = 8;
// jsQR cost grows with pixels; 640 px still resolves a phone-screen QR held at arm's length.
export const MAX_FRAME_SIDE = 640;
// The same code is reported again only after it has been out of view this long.
export const REPEAT_WINDOW_MS = 3000;
const HAVE_CURRENT_DATA = 2;
const QR_FORMAT = 'qr_code';

interface DetectedBarcode {
    readonly rawValue: string;
}

interface BarcodeDetectorLike {
    detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
    new (options: { formats: string[] }): BarcodeDetectorLike;
    getSupportedFormats(): Promise<string[]>;
}

type FrameCanvas = OffscreenCanvas | HTMLCanvasElement;
type FrameContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function decodeQrImageData(image: QrImageData): string | undefined {
    const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });

    return result?.data ? result.data : undefined;
}

export function createQrScanner(options: QrScannerOptions): QrScanner {
    const intervalMs = 1000 / (options.framesPerSecond ?? DEFAULT_FRAMES_PER_SECOND);
    const repeats = createRepeatFilter(REPEAT_WINDOW_MS);
    const createDecoderAsync = options.createDecoderAsync ?? (() => createBrowserDecoderAsync(options.logger));
    const state: {
        run: number;
        isRunning: boolean;
        timer?: ReturnType<typeof setTimeout>;
        decoder?: Promise<FrameDecoder>;
    } = { run: 0, isRunning: false };

    const scanFrameAsync = async (run: number): Promise<void> => {
        try {
            state.decoder ??= createDecoderAsync();
            const decoder = await state.decoder;
            const text = isFrameReady(options.video) ? await decodeSafelyAsync(decoder, options) : undefined;
            if (run !== state.run) {
                return;
            }

            if (text != null && repeats.accept(text, Date.now())) {
                options.logger.info('pair', 'QR code read', { decoder: decoder.name, characters: text.length });
                options.onCode(text);
            }

            // onCode may have stopped the scanner.
            if (run === state.run) {
                state.timer = setTimeout(() => void scanFrameAsync(run), intervalMs);
            }
        } catch (error) {
            options.logger.error('pair', 'QR scanner stopped', { error });
        }
    };

    return {
        start: () => {
            if (state.isRunning) {
                return;
            }

            state.isRunning = true;
            state.run += 1;
            void scanFrameAsync(state.run);
        },
        stop: () => {
            state.isRunning = false;
            state.run += 1;
            clearTimeout(state.timer);
        },
    };
}

// A code held in view is reported once; the window slides while it stays visible.
export function createRepeatFilter(windowMs: number): RepeatFilter {
    const last: { text?: string; seenAt: number } = { seenAt: Number.NEGATIVE_INFINITY };

    return {
        accept: (text, now) => {
            const isRepeat = text === last.text && now - last.seenAt < windowMs;
            last.text = text;
            last.seenAt = now;

            return !isRepeat;
        },
    };
}

export function frameSize(width: number, height: number, maxSide = MAX_FRAME_SIDE): FrameSize {
    const scale = Math.min(1, maxSide / Math.max(width, height, 1));

    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function isFrameReady(video: HTMLVideoElement): boolean {
    return video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0;
}

async function decodeSafelyAsync(decoder: FrameDecoder, options: QrScannerOptions): Promise<string | undefined> {
    try {
        return await decoder.decodeAsync(options.video);
    } catch (error) {
        if (options.logger.every('qr-decode-error', 10_000)) {
            options.logger.warn('pair', 'QR frame could not be decoded', { decoder: decoder.name, error });
        }

        return undefined;
    }
}

async function createBrowserDecoderAsync(logger: Logger): Promise<FrameDecoder> {
    const fallback = createJsQrDecoder();
    const detector = await createBarcodeDetectorAsync();
    if (detector == null) {
        logger.info('pair', 'QR scanning with jsQR');

        return fallback;
    }

    logger.info('pair', 'QR scanning with BarcodeDetector');

    return withFallback(detector, fallback, logger);
}

async function createBarcodeDetectorAsync(): Promise<FrameDecoder | undefined> {
    const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (Detector == null) {
        return undefined;
    }

    try {
        const formats = await Detector.getSupportedFormats();
        if (!formats.includes(QR_FORMAT)) {
            return undefined;
        }

        const detector = new Detector({ formats: [QR_FORMAT] });

        return {
            name: 'BarcodeDetector',
            decodeAsync: async video => (await detector.detect(video))[0]?.rawValue,
        };
    } catch {
        return undefined;
    }
}

// Some Android builds expose BarcodeDetector but throw on detect(); the first failure switches to jsQR for good.
function withFallback(primary: FrameDecoder, fallback: FrameDecoder, logger: Logger): FrameDecoder {
    const state = { current: primary };

    return {
        get name() {
            return state.current.name;
        },
        decodeAsync: async video => {
            try {
                return await state.current.decodeAsync(video);
            } catch (error) {
                if (state.current === fallback) {
                    throw error;
                }

                logger.warn('pair', 'BarcodeDetector failed, switching to jsQR', { error });
                state.current = fallback;

                return fallback.decodeAsync(video);
            }
        },
    };
}

function createJsQrDecoder(): FrameDecoder {
    const state: { canvas?: FrameCanvas; context?: FrameContext } = {};

    return {
        name: 'jsQR',
        decodeAsync: async video => {
            const size = frameSize(video.videoWidth, video.videoHeight);
            if (state.canvas == null || state.canvas.width !== size.width || state.canvas.height !== size.height) {
                state.canvas = createCanvas(size.width, size.height);
                const context = state.canvas.getContext('2d', { willReadFrequently: true }) as FrameContext | null;
                state.context = context ?? undefined;
            }

            if (state.context == null) {
                return undefined;
            }

            state.context.drawImage(video, 0, 0, size.width, size.height);

            return decodeQrImageData(state.context.getImageData(0, 0, size.width, size.height));
        },
    };
}

function createCanvas(width: number, height: number): FrameCanvas {
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(width, height);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    return canvas;
}
