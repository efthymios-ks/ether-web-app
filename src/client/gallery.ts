import type {
    Direction,
    FileRecord,
    FileState,
    GalleryFilter,
    GalleryGroup,
    GalleryItem,
    GalleryStatus,
} from './clientTypes.js';

// Rows for the virtualised gallery (§18.3): grouped by date taken, newest first (GL-03),
// with the status badges of GL-04 and the sender's own states (GL-07).

export const NO_DATE = 'no-date';

const INCOMING_STATUS: Readonly<Record<FileState, GalleryStatus>> = Object.freeze({
    queued: 'waiting',
    offered: 'waiting',
    incoming: 'waiting',
    'needs-file': 'waiting',
    active: 'receiving',
    paused: 'receiving',
    verifying: 'receiving',
    done: 'received',
    failed: 'failed',
    canceled: 'failed',
});

const OUTGOING_STATUS: Readonly<Record<FileState, GalleryStatus>> = Object.freeze({
    queued: 'queued',
    offered: 'queued',
    incoming: 'queued',
    'needs-file': 'queued',
    paused: 'queued',
    active: 'sending',
    verifying: 'sending',
    done: 'sent',
    failed: 'failed',
    canceled: 'failed',
});

const FILTERS: Readonly<Record<GalleryFilter, (file: FileRecord) => boolean>> = Object.freeze({
    all: () => true,
    photos: file => file.kind === 'image',
    videos: file => file.kind === 'video',
    'not-saved': file => file.direction === 'in' && file.state === 'done' && file.savedAt == null,
    failed: file => file.state === 'failed' || file.state === 'canceled',
});

const DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

export function galleryStatus(file: FileRecord): GalleryStatus {
    if (
        file.direction === 'in'
        && file.state === 'done'
        && file.savedAt != null
    ) {
        return 'saved';
    }

    return (file.direction === 'in' ? INCOMING_STATUS : OUTGOING_STATUS)[file.state];
}

// The calendar day as the camera wrote it, offset included, so a photo taken at 23:30 abroad stays on its day.
export function dayOf(file: FileRecord): string {
    const match = DAY_PATTERN.exec(file.metadata?.takenAt ?? '');

    return match?.[1] ?? NO_DATE;
}

export function toGalleryItem(file: FileRecord): GalleryItem {
    const pagination = file.pagination;
    const isMoving = pagination != null && pagination.totalPages > 0 && file.state !== 'done';

    return {
        fileId: file.fileId,
        sessionId: file.sessionId,
        direction: file.direction,
        ...(file.batchId == null ? {} : { batchId: file.batchId }),
        name: file.name,
        mime: file.mime,
        size: file.size,
        kind: file.kind,
        ...(file.metadata?.takenAt == null ? {} : { takenAt: file.metadata.takenAt }),
        ...(file.metadata?.durationSeconds == null ? {} : { durationSeconds: file.metadata.durationSeconds }),
        status: galleryStatus(file),
        ...(isMoving ? { progress: pagination.pagesDone / pagination.totalPages } : {}),
        hasThumbnail: file.hasThumbnail,
        hasData: file.hasData,
    };
}

export interface GalleryQuery {
    readonly batchId?: string;
    readonly direction?: Direction;
    readonly filter: GalleryFilter;
}

export function buildGallery(files: readonly FileRecord[], query: GalleryQuery): GalleryGroup[] {
    const groups = new Map<string, FileRecord[]>();
    for (const file of files) {
        if (query.batchId != null && file.batchId !== query.batchId) {
            continue;
        }

        if (query.direction != null && file.direction !== query.direction) {
            continue;
        }

        if (!FILTERS[query.filter](file)) {
            continue;
        }

        const day = dayOf(file);
        const group = groups.get(day) ?? [];
        group.push(file);
        groups.set(day, group);
    }

    return [...groups.entries()]
        .sort(([first], [second]) => compareDays(first, second))
        .map(([day, items]) => ({ day, items: items.sort(compareNewestFirst).map(toGalleryItem) }));
}

function compareDays(first: string, second: string): number {
    if (first === NO_DATE) {
        return second === NO_DATE ? 0 : 1;
    }

    if (second === NO_DATE) {
        return -1;
    }

    return second.localeCompare(first);
}

function compareNewestFirst(first: FileRecord, second: FileRecord): number {
    const byTime = takenTime(second) - takenTime(first);

    return byTime !== 0 ? byTime : first.queueIndex - second.queueIndex;
}

function takenTime(file: FileRecord): number {
    const time = Date.parse(file.metadata?.takenAt ?? '');

    return Number.isNaN(time) ? 0 : time;
}
