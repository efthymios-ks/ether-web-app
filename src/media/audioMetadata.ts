import type { EmbeddedMetadata } from './metadataTypes.js';
import { roundTo } from './metadataValues.js';

// The length of an audio file, read the way a player reads it: an <audio> element loads only the file's header
// from an object URL. So the length is known wherever this browser plays the format, and nowhere else.
// Audio carries no date taken, place or camera here, so the length is all it adds to the summary.

// Well inside MD-06's 2 s, so a slow file still sends with its file-level fields.
const AUDIO_TIMEOUT_MS = 1000;
const MAX_DURATION_SECONDS = 10_000_000;

// The part of an <audio> element the reader uses; tests pass their own.
export interface AudioElement extends EventTarget {
    preload: string;
    readonly duration: number;
    src: string;
    removeAttribute(name: string): void;
    load(): void;
}

export interface AudioReaderOptions {
    readonly createAudio?: () => AudioElement | undefined;
    readonly timeoutMs?: number;
}

function createBrowserAudio(): AudioElement | undefined {
    return typeof document === 'undefined' ? undefined : document.createElement('audio');
}

// Resolves on loadedmetadata, or false on error or timeout; never rejects.
function waitForMetadataAsync(audio: AudioElement, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const finish = (isLoaded: boolean): void => {
            clearTimeout(timer);
            audio.removeEventListener('loadedmetadata', onLoaded);
            audio.removeEventListener('error', onError);
            resolve(isLoaded);
        };
        const onLoaded = (): void => finish(true);
        const onError = (): void => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        audio.addEventListener('loadedmetadata', onLoaded);
        audio.addEventListener('error', onError);
    });
}

export async function readAudioDurationAsync(
    file: Blob,
    options: AudioReaderOptions = {},
): Promise<number | undefined> {
    const audio = (options.createAudio ?? createBrowserAudio)();
    if (audio == null) {
        return undefined;
    }

    const url = URL.createObjectURL(file);
    try {
        audio.preload = 'metadata';
        const loading = waitForMetadataAsync(audio, options.timeoutMs ?? AUDIO_TIMEOUT_MS);
        audio.src = url;
        if (!(await loading)) {
            return undefined;
        }

        // A recording made in a browser often has no length in its header (Infinity); it is left out.
        const seconds = audio.duration;
        const isKnown = Number.isFinite(seconds) && seconds > 0 && seconds < MAX_DURATION_SECONDS;

        return isKnown ? roundTo(seconds, 3) : undefined;
    } finally {
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(url);
    }
}

// The metadata reader for audio files (fileMetadata.ts): the length, when this browser can read it.
export async function readAudioMetadataAsync(file: File): Promise<EmbeddedMetadata | undefined> {
    const durationSeconds = await readAudioDurationAsync(file);

    return durationSeconds == null ? undefined : { durationSeconds };
}
