import { TEXT_LIMITS } from '../media/metadataValues.js';
import type { FileMetadata } from '../media/metadataTypes.js';

// What goes into a manifest's metadata summary (§8): only known fields, finite numbers in range and strings within
// the media layer's limits, so a valid file is never refused for its tags (SP-05) and a manifest stays small.

type Rule = (value: unknown) => unknown;

const MAX_NAME_CHARACTERS = 255;
const MAX_PATH_CHARACTERS = 1024;
const MAX_DATE_CHARACTERS = 40;
// Ten days: anything longer is a broken duration (e.g. an mvhd with timescale 0).
const MAX_DURATION_SECONDS = 10 * 24 * 60 * 60;
const MAX_PIXELS_PER_SIDE = 1_000_000;

const text = (limit: number): Rule => value => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed === '' ? undefined : Array.from(trimmed).slice(0, limit).join('');
};

const number = (min: number, max: number): Rule => value => (
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined
);

const integer = (min: number, max: number): Rule => value => (number(min, max)(value) != null && Number.isInteger(value) ? value : undefined);

const oneOf = (choices: readonly string[]): Rule => value => (typeof value === 'string' && choices.includes(value) ? value : undefined);

const date: Rule = value => {
    const candidate = text(MAX_DATE_CHARACTERS)(value);

    return typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined;
};

const tags: Rule = value => {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const cleaned = value
        .map(text(TEXT_LIMITS.short))
        .filter((tag): tag is string => typeof tag === 'string');
    const unique = [...new Map(cleaned.map(tag => [tag.toLowerCase(), tag])).values()].slice(0, TEXT_LIMITS.tags);

    return unique.length > 0 ? unique : undefined;
};

const RULES: Readonly<Record<keyof FileMetadata, Rule>> = Object.freeze({
    takenAt: date,
    takenAtSource: oneOf(['exif', 'quicktime', 'mvhd', 'file']),
    latitude: number(-90, 90),
    longitude: number(-180, 180),
    altitude: number(-20_000, 100_000),
    make: text(TEXT_LIMITS.short),
    model: text(TEXT_LIMITS.short),
    lens: text(TEXT_LIMITS.short),
    width: integer(1, MAX_PIXELS_PER_SIDE),
    height: integer(1, MAX_PIXELS_PER_SIDE),
    orientation: integer(1, 8),
    rotation: integer(0, 359),
    durationSeconds: number(0, MAX_DURATION_SECONDS),
    tags,
    title: text(TEXT_LIMITS.title),
    description: text(TEXT_LIMITS.description),
    rating: number(-1, 100),
    originalName: text(MAX_NAME_CHARACTERS),
    relativePath: text(MAX_PATH_CHARACTERS),
});

// Undefined when nothing usable is left, so the manifest carries no empty summary.
export function sanitizeMetadata(metadata: unknown): FileMetadata | undefined {
    if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return undefined;
    }

    const source = metadata as Readonly<Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const [key, rule] of Object.entries(RULES)) {
        const value = rule(source[key]);
        if (value !== undefined) {
            result[key] = value;
        }
    }

    return Object.keys(result).length > 0 ? (result as FileMetadata) : undefined;
}
