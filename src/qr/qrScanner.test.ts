import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, SILENT_LOGGER } from '../core/logger.js';
import type { LogRouting } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { createQrScanner, createRepeatFilter, frameSize } from './qrScanner.js';
import type { FrameDecoder } from './qrScanner.js';

const DEBUG_ROUTING: LogRouting = { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] };

function createVideo(readyState = 4): HTMLVideoElement {
    return { readyState, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
}

function createDecoder(reads: readonly (string | undefined)[]): FrameDecoder & { readonly calls: () => number } {
    const queue = [...reads];
    const state = { calls: 0 };

    return {
        name: 'fake',
        calls: () => state.calls,
        decodeAsync: async () => {
            state.calls += 1;

            return queue.shift();
        },
    };
}

describe('createRepeatFilter', () => {
    it('reports a code once while it stays in view and again after it has been away', () => {
        // Arrange
        const filter = createRepeatFilter(3000);

        // Act
        const answers = [
            filter.accept('A', 0),
            filter.accept('A', 2000),
            filter.accept('A', 4500),
            filter.accept('B', 4600),
            filter.accept('A', 4700),
            filter.accept('A', 9000),
        ];

        // Assert
        expect(answers).toEqual([true, false, false, true, true, true]);
    });
});

describe('frameSize', () => {
    it('scales the longest side down to 640 and never up', () => {
        // Act
        const sizes = [frameSize(1920, 1080), frameSize(720, 1280), frameSize(320, 240), frameSize(0, 0)];

        // Assert
        expect(sizes).toEqual([
            { width: 640, height: 360 },
            { width: 360, height: 640 },
            { width: 320, height: 240 },
            { width: 1, height: 1 },
        ]);
    });
});

describe('createQrScanner', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('scans frames at the given rate and reports each code once', async () => {
        // Arrange
        const decoder = createDecoder(['A', 'A', undefined, 'B', 'A']);
        const codes: string[] = [];
        const scanner = createQrScanner({
            video: createVideo(),
            onCode: text => codes.push(text),
            logger: SILENT_LOGGER,
            framesPerSecond: 10,
            createDecoderAsync: async () => decoder,
        });

        // Act
        scanner.start();
        await vi.advanceTimersByTimeAsync(450);
        scanner.stop();
        await vi.advanceTimersByTimeAsync(1000);

        // Assert
        expect(codes).toEqual(['A', 'B', 'A']);
        expect(decoder.calls()).toBe(5);
    });

    it('waits until the video has a frame', async () => {
        // Arrange
        const decoder = createDecoder(['A']);
        const scanner = createQrScanner({
            video: createVideo(1),
            onCode: () => undefined,
            logger: SILENT_LOGGER,
            createDecoderAsync: async () => decoder,
        });

        // Act
        scanner.start();
        await vi.advanceTimersByTimeAsync(1000);
        scanner.stop();

        // Assert
        expect(decoder.calls()).toBe(0);
    });

    it('stops scheduling when onCode stops the scanner', async () => {
        // Arrange
        const decoder = createDecoder(['A', 'B', 'C']);
        const codes: string[] = [];
        const scanner = createQrScanner({
            video: createVideo(),
            onCode: text => {
                codes.push(text);
                scanner.stop();
            },
            logger: SILENT_LOGGER,
            createDecoderAsync: async () => decoder,
        });

        // Act
        scanner.start();
        await vi.advanceTimersByTimeAsync(2000);

        // Assert
        expect(codes).toEqual(['A']);
        expect(decoder.calls()).toBe(1);
    });

    it('keeps scanning after a failing frame and logs the failure', async () => {
        // Arrange
        const memory = createMemorySink(10);
        const { logger } = createLogger({ sinks: [memory], routing: DEBUG_ROUTING });
        const results: (() => string | undefined)[] = [
            () => {
                throw new Error('frame busy');
            },
            () => 'A',
        ];
        const codes: string[] = [];
        const scanner = createQrScanner({
            video: createVideo(),
            onCode: text => codes.push(text),
            logger,
            framesPerSecond: 10,
            createDecoderAsync: async () => ({ name: 'fake', decodeAsync: async () => results.shift()?.() }),
        });

        // Act
        scanner.start();
        await vi.advanceTimersByTimeAsync(150);
        scanner.stop();

        // Assert
        expect(codes).toEqual(['A']);
        expect(memory.entries().map(entry => entry.msg)).toEqual(['QR frame could not be decoded', 'QR code read']);
    });

    it('ignores a second start while running', async () => {
        // Arrange
        const decoder = createDecoder([]);
        const scanner = createQrScanner({
            video: createVideo(),
            onCode: () => undefined,
            logger: SILENT_LOGGER,
            framesPerSecond: 10,
            createDecoderAsync: async () => decoder,
        });

        // Act
        scanner.start();
        scanner.start();
        await vi.advanceTimersByTimeAsync(250);
        scanner.stop();

        // Assert
        expect(decoder.calls()).toBe(3);
    });
});
