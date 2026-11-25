// The metadata summary sent in the offer (MD-02). Missing fields are left out, never null.
export interface FileMetadata {
    // ISO 8601, with the offset when the file has one, e.g. "2026-11-23T14:05:42+01:00".
    readonly takenAt?: string;
    // MD-05: where takenAt came from; 'file' means File.lastModified ("file date").
    readonly takenAtSource?: 'exif' | 'quicktime' | 'mvhd' | 'file';
    readonly latitude?: number;
    readonly longitude?: number;
    readonly altitude?: number;
    readonly make?: string;
    readonly model?: string;
    readonly lens?: string;
    readonly width?: number;
    readonly height?: number;
    // EXIF orientation 1–8 (images).
    readonly orientation?: number;
    // Clockwise degrees from the video track matrix: 0, 90, 180 or 270 (videos).
    readonly rotation?: number;
    readonly durationSeconds?: number;
    readonly tags?: readonly string[];
    readonly title?: string;
    readonly description?: string;
    readonly rating?: number;
    readonly originalName?: string;
    readonly relativePath?: string;
}

export type MediaKind = 'image' | 'video' | 'other';

// The embedded date sources in MD-05 fallback order; File.lastModified ('file') comes last.
export type EmbeddedDateSource = 'exif' | 'quicktime' | 'mvhd';

type FileLevelField = 'takenAt' | 'takenAtSource' | 'originalName' | 'relativePath';

// What a format reader finds inside a file, before the file-level fields and the date fallback are added.
export interface EmbeddedMetadata extends Omit<FileMetadata, FileLevelField> {
    readonly dates?: Readonly<Partial<Record<EmbeddedDateSource, string>>>;
}

// What the client needs from the media layer; injected so the client runs under Node in tests.
export interface MediaToolkit {
    // MD-06: at most 2 s per file; resolves to undefined on failure or timeout, never rejects.
    extractMetadataAsync(file: File): Promise<FileMetadata | undefined>;
    // TH-01: JPEG, longest side 256 px, at most 24 KiB; undefined when the browser can't decode it.
    createThumbnailAsync(file: File, metadata: FileMetadata | undefined): Promise<Blob | undefined>;
}
