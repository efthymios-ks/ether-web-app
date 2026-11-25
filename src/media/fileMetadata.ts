import type { Logger } from '../core/logger.js';
import { readAudioMetadataAsync } from './audioMetadata.js';
import { fileCategoryOf } from './fileCategory.js';
import type { FileCategory } from './fileCategory.js';
import { readImageMetadataAsync } from './imageMetadata.js';
import { formatLocalDate } from './metadataDates.js';
import type { EmbeddedDateSource, EmbeddedMetadata, FileMetadata } from './metadataTypes.js';
import { withoutUndefined } from './metadataValues.js';
import { readVideoMetadataAsync } from './videoMetadata.js';

// MD-06: a slow or stuck file never holds up sending.
export const METADATA_TIMEOUT_MS = 2000;

export type MetadataReader = (file: File, logger: Logger) => Promise<EmbeddedMetadata | undefined>;
export type MetadataReaders = Readonly<Partial<Record<FileCategory, MetadataReader>>>;

// One reader per category; other files get the file-level fields only.
export const METADATA_READERS: MetadataReaders = Object.freeze({
    image: readImageMetadataAsync,
    video: readVideoMetadataAsync,
    audio: readAudioMetadataAsync,
});

// MD-05: EXIF DateTimeOriginal → QuickTime creationdate → mvhd → File.lastModified ("file date").
const DATE_SOURCE_ORDER: readonly EmbeddedDateSource[] = Object.freeze(['exif', 'quicktime', 'mvhd']);

export interface ExtractMetadataOptions {
    readonly logger: Logger;
    readonly timeoutMs?: number;
    readonly readers?: MetadataReaders;
}

type FileFields = Pick<File, 'name' | 'lastModified' | 'webkitRelativePath'>;

// Resolves undefined on failure or timeout and never rejects, so the file is sent without a summary.
export async function extractFileMetadataAsync(
    file: File,
    options: ExtractMetadataOptions,
): Promise<FileMetadata | undefined> {
    const timeoutMs = options.timeoutMs ?? METADATA_TIMEOUT_MS;
    const endSpan = options.logger.span('xfer', 'metadata', 'debug');
    try {
        const outcome = await withTimeoutAsync(summarizeAsync(file, options), timeoutMs);
        if (outcome.timedOut) {
            const message = `metadata took over ${timeoutMs} ms, sending without it`;
            options.logger.warn('xfer', message, { name: file.name });

            return undefined;
        }

        endSpan(() => ({ name: file.name, source: outcome.value.takenAtSource }));

        return outcome.value;
    } catch (error) {
        options.logger.warn('xfer', 'metadata failed, sending without it', { name: file.name, error });

        return undefined;
    }
}

export function buildFileMetadata(file: FileFields, embedded: EmbeddedMetadata | undefined): FileMetadata {
    const { dates, ...fields } = embedded ?? {};

    return withoutUndefined({
        ...takenDate(file, dates),
        ...fields,
        originalName: file.name,
        relativePath: file.webkitRelativePath ? file.webkitRelativePath : undefined,
    });
}

type TakenDate = Pick<FileMetadata, 'takenAt' | 'takenAtSource'>;

function takenDate(file: FileFields, dates: EmbeddedMetadata['dates']): TakenDate {
    const source = DATE_SOURCE_ORDER.find(key => dates?.[key] != null);
    if (source != null) {
        return { takenAt: dates?.[source], takenAtSource: source };
    }

    if (!Number.isFinite(file.lastModified) || file.lastModified <= 0) {
        return {};
    }

    return { takenAt: formatLocalDate(file.lastModified), takenAtSource: 'file' };
}

async function summarizeAsync(file: File, options: ExtractMetadataOptions): Promise<FileMetadata> {
    const category = fileCategoryOf(file.type, file.name);
    const reader = (options.readers ?? METADATA_READERS)[category];
    const embedded = reader == null ? undefined : await reader(file, options.logger);

    return buildFileMetadata(file, embedded);
}

type TimeoutOutcome<Value> = { readonly timedOut: false; readonly value: Value } | { readonly timedOut: true };

async function withTimeoutAsync<Value>(work: Promise<Value>, timeoutMs: number): Promise<TimeoutOutcome<Value>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TimeoutOutcome<Value>>(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const finished = (async (): Promise<TimeoutOutcome<Value>> => ({ timedOut: false, value: await work }))();
    try {
        return await Promise.race([finished, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
