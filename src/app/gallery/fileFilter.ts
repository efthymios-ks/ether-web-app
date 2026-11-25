import type { Direction, FileRecord, GalleryItem } from '../../client/clientTypes.js';
import type { FileCategory } from '../../media/fileCategory.js';

// The Type and Status filters of the Sent and Received tabs, set in the View & filter sheet.
// Within a group the boxes add up (OR), across groups they narrow (AND), and nothing checked shows everything.
// Filtering runs over the loaded rows, so the client's single-valued filter isn't needed and the list stays
// virtualised. The Type boxes follow the file's category (media/fileCategory.ts), the one its icon shows.

export type FilterStatus = 'not-downloaded' | 'downloaded' | 'failed' | 'sent' | 'not-sent';

// Archives have no box of their own: they count as Other files.
export type FilterType = Exclude<FileCategory, 'archive'>;

export interface FileFilter {
    readonly types: ReadonlySet<FilterType>;
    readonly statuses: ReadonlySet<FilterStatus>;
}

export interface FilterChoice<Id extends string> {
    readonly id: Id;
    readonly label: string;
}

export const EMPTY_FILTER: FileFilter = Object.freeze({
    types: new Set<FilterType>(),
    statuses: new Set<FilterStatus>(),
});

export const TYPE_CHOICES: ReadonlyArray<FilterChoice<FilterType>> = Object.freeze([
    { id: 'image', label: 'Photos' },
    { id: 'video', label: 'Videos' },
    { id: 'audio', label: 'Audio' },
    { id: 'document', label: 'Documents' },
    { id: 'other', label: 'Other files' },
]);

export const STATUS_CHOICES: Readonly<Record<Direction, ReadonlyArray<FilterChoice<FilterStatus>>>> = Object.freeze({
    in: [
        { id: 'not-downloaded', label: 'Not downloaded' },
        { id: 'downloaded', label: 'Downloaded' },
        { id: 'failed', label: 'Failed' },
    ],
    out: [
        { id: 'sent', label: 'Sent' },
        { id: 'not-sent', label: 'Not sent yet' },
        { id: 'failed', label: 'Failed' },
    ],
});

export function activeCount(filter: FileFilter): number {
    return filter.types.size + filter.statuses.size;
}

export function filterTypeOf(category: FileCategory): FilterType {
    return category === 'archive' ? 'other' : category;
}

export function matchesFilter(
    filter: FileFilter,
    category: FileCategory,
    status: FilterStatus | undefined,
): boolean {
    const isTypeOk = filter.types.size === 0 || filter.types.has(filterTypeOf(category));
    const isStatusOk = filter.statuses.size === 0 || (status != null && filter.statuses.has(status));

    return isTypeOk && isStatusOk;
}

export function galleryStatusOf(item: GalleryItem): FilterStatus | undefined {
    const statuses: Readonly<Record<GalleryItem['status'], FilterStatus | undefined>> = {
        waiting: undefined,
        receiving: undefined,
        received: 'not-downloaded',
        saved: 'downloaded',
        failed: 'failed',
        queued: 'not-sent',
        sending: 'not-sent',
        sent: 'sent',
    };

    return statuses[item.status];
}

// A file's status for the filter, from its record when it is loaded: a damaged copy counts as Failed.
export function filterStatusOf(item: GalleryItem, record: FileRecord | undefined): FilterStatus | undefined {
    const isDamaged = record != null
        && record.direction === 'in'
        && record.state === 'done'
        && record.note === 'damaged';

    return isDamaged ? 'failed' : galleryStatusOf(item);
}

// The checked boxes in the sheet's order, for the "Filtered: Photos · Failed" line above the list.
export function filterLabels(filter: FileFilter, direction: Direction): string[] {
    return [
        ...TYPE_CHOICES.filter(choice => filter.types.has(choice.id)),
        ...STATUS_CHOICES[direction].filter(choice => filter.statuses.has(choice.id)),
    ].map(choice => choice.label);
}
