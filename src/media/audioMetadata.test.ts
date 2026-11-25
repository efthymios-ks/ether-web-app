import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAudioDurationAsync, readAudioMetadataAsync } from './audioMetadata.js';
import type { AudioElement } from './audioMetadata.js';

// What the fake element does once it is given a source, as a browser would after reading the header.
type Outcome = { readonly duration: number } | 'error' | 'never';

class FakeAudio extends EventTarget implements AudioElement {
    preload = '';
    duration = Number.NaN;
    loads = 0;
    private source = '';

    constructor(private readonly outcome: Outcome) {
        super();
    }

    get src(): string {
        return this.source;
    }

    set src(value: string) {
        this.source = value;
        const { outcome } = this;
        if (outcome === 'never') {
            return;
        }

        queueMicrotask(() => {
            if (outcome === 'error') {
                this.dispatchEvent(new Event('error'));

                return;
            }

            this.duration = outcome.duration;
            this.dispatchEvent(new Event('loadedmetadata'));
        });
    }

    removeAttribute(name: string): void {
        if (name === 'src') {
            this.source = '';
        }
    }

    load(): void {
        this.loads++;
    }
}

const SONG = new Blob(['ID3'], { type: 'audio/mpeg' });

describe('readAudioDurationAsync', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads the length from the header only, to the millisecond, and lets the file go', async () => {
        // Arrange
        const audio = new FakeAudio({ duration: 187.123_456 });
        const revoke = vi.spyOn(URL, 'revokeObjectURL');

        // Act
        const seconds = await readAudioDurationAsync(SONG, { createAudio: () => audio });

        // Assert
        expect(seconds).toBe(187.123);
        expect(audio.preload).toBe('metadata');
        expect(audio.src).toBe('');
        expect(audio.loads).toBe(1);
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('leaves the length out when the browser can’t play the file or the header has none', async () => {
        // Arrange
        const outcomes: Outcome[] = ['error', { duration: Number.POSITIVE_INFINITY }, { duration: 0 }];

        // Act
        const lengths = await Promise.all(outcomes.map(outcome => readAudioDurationAsync(SONG, {
            createAudio: () => new FakeAudio(outcome),
        })));

        // Assert
        expect(lengths).toEqual([undefined, undefined, undefined]);
    });

    it('gives up after its time limit, well inside the metadata limit', async () => {
        // Arrange
        const audio = new FakeAudio('never');

        // Act
        const seconds = await readAudioDurationAsync(SONG, { createAudio: () => audio, timeoutMs: 10 });

        // Assert
        expect(seconds).toBeUndefined();
        expect(audio.src).toBe('');
    });

    it('reads nothing outside a browser', async () => {
        // Act
        const metadata = await readAudioMetadataAsync(new File(['ID3'], 'song.mp3', { type: 'audio/mpeg' }));

        // Assert
        expect(metadata).toBeUndefined();
    });
});
