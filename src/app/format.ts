// Text the screens show for sizes, speeds, durations and dates. Sizes use decimal units, as phones do.

const SIZE_UNITS = Object.freeze(['B', 'kB', 'MB', 'GB', 'TB']);
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAY_MS = 24 * 60 * 60 * 1000;

export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes)) {
        return '0 B';
    }

    if (bytes < 1000) {
        return `${Math.max(0, Math.round(bytes))} B`;
    }

    const exponent = Math.min(Math.floor(Math.log10(bytes) / 3), SIZE_UNITS.length - 1);
    const value = bytes / 1000 ** exponent;
    const digits = value >= 100 ? 0 : 1;

    return `${value.toFixed(digits)} ${SIZE_UNITS[exponent]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
    return `${formatSize(bytesPerSecond)}/s`;
}

export function formatTimeLeft(seconds: number | undefined): string {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
        return '';
    }

    if (seconds < MINUTE) {
        return `${Math.max(1, Math.ceil(seconds))} s left`;
    }

    if (seconds < HOUR) {
        return `${Math.ceil(seconds / MINUTE)} min left`;
    }

    if (seconds < DAY) {
        const hours = Math.floor(seconds / HOUR);
        const minutes = Math.ceil((seconds - hours * HOUR) / MINUTE);

        return `${hours} h ${minutes} min left`;
    }

    const days = Math.floor(seconds / DAY);
    const hours = Math.ceil((seconds - days * DAY) / HOUR);

    return `${days} d ${hours} h left`;
}

export interface LiveRate {
    readonly bytesPerSecond: number;
    readonly secondsLeft?: number;
    readonly stalled?: boolean;
}

// TR-10: speed and time left while bytes move, or why there is no estimate.
export function formatLiveRate(rate: LiveRate): string[] {
    if (rate.stalled === true) {
        return ['Waiting for the connection…'];
    }

    if (rate.bytesPerSecond <= 0) {
        return ['Estimating time left…'];
    }

    const left = formatTimeLeft(rate.secondsLeft);

    return left.length > 0 ? [formatSpeed(rate.bytesPerSecond), left] : [formatSpeed(rate.bytesPerSecond)];
}

// Video length and countdowns: "0:42", "12:05", "1:02:09".
export function formatClock(totalSeconds: number): string {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / HOUR);
    const minutes = Math.floor((seconds % HOUR) / MINUTE);
    const rest = `${seconds % MINUTE}`.padStart(2, '0');

    return hours > 0 ? `${hours}:${`${minutes}`.padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function formatPercent(percent: number): string {
    const clamped = Math.min(100, Math.max(0, percent));

    return clamped > 0 && clamped < 1 ? `${clamped.toFixed(1)}%` : `${Math.floor(clamped)}%`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
    return `${count.toLocaleString('en')} ${count === 1 ? singular : plural}`;
}

export function formatDateTime(epochMs: number): string {
    return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// "Today 14:02", "Yesterday 09:10", or the date.
export function formatRelative(epochMs: number, now: number = Date.now()): string {
    const days = startOfDay(now) - startOfDay(epochMs);
    if (days === 0) {
        return `Today ${formatTime(epochMs)}`;
    }

    if (days === DAY_MS) {
        return `Yesterday ${formatTime(epochMs)}`;
    }

    return new Date(epochMs).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

// Short enough for a thin row's meta line (§13): the time today, "Yesterday", "23 Nov", or "23 Nov 2025".
export function formatShortWhen(epochMs: number, now: number = Date.now()): string {
    const days = Math.round((startOfDay(now) - startOfDay(epochMs)) / DAY_MS);
    if (days === 0) {
        return formatTime(epochMs);
    }

    if (days === 1) {
        return 'Yesterday';
    }

    const isThisYear = new Date(epochMs).getFullYear() === new Date(now).getFullYear();

    return new Date(epochMs).toLocaleDateString(undefined, isThisYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

// Month headers of the Sent and Received tabs: 'YYYY-MM' → "November 2026".
export function formatMonth(month: string): string {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) {
        return 'No date';
    }

    return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// Day headers (GL-03): 'YYYY-MM-DD' or 'no-date'.
export function formatDay(day: string, now: number = Date.now()): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!match) {
        return 'No date';
    }

    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const days = Math.round((startOfDay(now) - date.getTime()) / DAY_MS);
    if (days === 0) {
        return 'Today';
    }

    if (days === 1) {
        return 'Yesterday';
    }

    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// MD-07: the date a photo was taken, keeping the time zone it was taken in when the file has one.
export function formatTakenAt(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }

    const offset = /([+-]\d{2}:\d{2}|Z)$/.exec(iso)?.[1];

    return offset != null && offset !== 'Z'
        ? `${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (UTC${offset})`
        : formatDateTime(date.getTime());
}

export function formatCoordinates(latitude: number, longitude: number): string {
    return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

function startOfDay(epochMs: number): number {
    const date = new Date(epochMs);
    date.setHours(0, 0, 0, 0);

    return date.getTime();
}
