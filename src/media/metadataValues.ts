// Value clean-up shared by the image and video readers.
// It keeps the summary small, because SP-05 limits a manifest to 64 KiB.

export const TEXT_LIMITS = Object.freeze({
    short: 64,
    title: 200,
    description: 1000,
    tags: 30,
});

export interface Coordinates {
    readonly latitude: number;
    readonly longitude: number;
}

// MD-02: missing fields are left out, never stored as null or undefined.
export function withoutUndefined<Value extends object>(value: Value): Value {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Value;
}

export function roundTo(value: number, digits: number): number {
    const factor = 10 ** digits;

    return Math.round(value * factor) / factor;
}

export function finiteNumber(value: unknown): number | undefined {
    const candidate = Array.isArray(value) || ArrayBuffer.isView(value) ? (value as ArrayLike<unknown>)[0] : value;
    const number = typeof candidate === 'string' && candidate.trim() !== '' ? Number(candidate) : candidate;

    return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
    const number = finiteNumber(value);

    return number != null && Number.isInteger(number) && number > 0 ? number : undefined;
}

// 0,0 is what some cameras write when they have no fix; ~0.1 m precision is plenty.
export function toCoordinates(latitude: unknown, longitude: unknown): Coordinates | undefined {
    const north = finiteNumber(latitude);
    const east = finiteNumber(longitude);
    if (
        north == null
        || east == null
        || Math.abs(north) > 90
        || Math.abs(east) > 180
        || (north === 0 && east === 0)
    ) {
        return undefined;
    }

    return { latitude: roundTo(north, 6), longitude: roundTo(east, 6) };
}

// Strings, XMP language alternatives ({ lang, value }) and arrays of either; the first non-empty one wins.
export function cleanText(value: unknown, maxLength: number): string | undefined {
    if (Array.isArray(value)) {
        return value
            .map(item => cleanText(item, maxLength))
            .find(item => item != null);
    }

    if (value != null && typeof value === 'object' && 'value' in value) {
        return cleanText(value.value, maxLength);
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    const text = value.replace(/\0/g, '').trim();
    if (!text) {
        return undefined;
    }

    return Array.from(text).slice(0, maxLength).join('');
}

// Unique tags (ignoring case) in the order found; undefined when there are none.
export function cleanTags(values: readonly unknown[]): string[] | undefined {
    const tags = new Map<string, string>();
    for (const value of values.flat()) {
        const tag = cleanText(value, TEXT_LIMITS.short);
        if (tag != null && !tags.has(tag.toLowerCase())) {
            tags.set(tag.toLowerCase(), tag);
        }
    }

    const list = [...tags.values()].slice(0, TEXT_LIMITS.tags);

    return list.length > 0 ? list : undefined;
}
