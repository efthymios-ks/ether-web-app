// MD-02 dates: ISO 8601 with the offset when the source has one, and without it (wall-clock time) when it doesn't.

const DATE_TIME = new RegExp([
    /^(\d{4})[:-](\d{2})[:-](\d{2})/.source,
    /[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?/.source,
    /\s*(Z|[+-]\d{2}:?\d{2})?$/.source,
].join(''), 'i');
const OFFSET = /^(Z)$|^([+-])(\d{2}):?(\d{2})$/i;
const MAX_OFFSET_MINUTES = 14 * 60;
// Seconds between 1904-01-01 (QuickTime) and 1970-01-01 (Unix).
export const QUICKTIME_EPOCH_OFFSET_SECONDS = 2_082_844_800;

// Accepts EXIF "2026:11:23 14:05:42", XMP and QuickTime "2026-11-23T14:05:42+0100"; `offset` is EXIF OffsetTime*.
export function parseMetadataDate(value: unknown, offset?: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const match = DATE_TIME.exec(value.replace(/\0/g, '').trim());
    if (!match) {
        return undefined;
    }

    const [, year, month, day, hours, minutes, seconds = '00', ownOffset] = match;
    if (!isValidDateTime([year, month, day, hours, minutes, seconds].map(Number))) {
        return undefined;
    }

    const zone = normalizeOffset(ownOffset) ?? normalizeOffset(offset) ?? '';

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${zone}`;
}

export function normalizeOffset(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const match = OFFSET.exec(value.replace(/\0/g, '').trim());
    if (!match) {
        return undefined;
    }

    if (match[1]) {
        return 'Z';
    }

    const [, , sign, hours = '', minutes = ''] = match;
    const totalMinutes = Number(hours) * 60 + Number(minutes);
    if (Number(minutes) >= 60 || totalMinutes > MAX_OFFSET_MINUTES) {
        return undefined;
    }

    return `${sign}${hours}:${minutes}`;
}

export function formatUtcDate(epochMs: number): string {
    return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The instant in this device's zone, e.g. for File.lastModified ("file date").
export function formatLocalDate(epochMs: number): string {
    const date = new Date(epochMs);
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes < 0 ? '-' : '+';
    const absolute = Math.abs(offsetMinutes);
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

    return `${day}T${time}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

// QuickTime stores seconds since 1904 in UTC; 0 and pre-1970 values mean "not set".
export function quickTimeSecondsToDate(seconds: number): string | undefined {
    const unixSeconds = seconds - QUICKTIME_EPOCH_OFFSET_SECONDS;
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
        return undefined;
    }

    return formatUtcDate(unixSeconds * 1000);
}

function isValidDateTime(parts: readonly number[]): boolean {
    const [year = 0, month = 0, day = 0, hours = 0, minutes = 0, seconds = 0] = parts;
    if (year < 1800 || hours > 23 || minutes > 59 || seconds > 59) {
        return false;
    }

    const date = new Date(Date.UTC(year, month - 1, day));

    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function pad(value: number): string {
    return `${value}`.padStart(2, '0');
}
