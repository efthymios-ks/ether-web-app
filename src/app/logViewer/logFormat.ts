import type { LogEntry } from '../../core/logger.js';

export interface PeerIdentity {
    readonly deviceId: string;
    readonly name: string;
    readonly displayName: string;
}

export interface LineParts {
    readonly time: string;
    readonly cat: string;
    readonly level: string;
    readonly peer?: string;
    readonly msg: string;
    readonly hasData: boolean;
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'space';

export interface JsonToken {
    readonly kind: JsonTokenKind;
    readonly text: string;
}

const TIME_WIDTH = 7;
const CATEGORY_WIDTH = 6;
const LEVEL_WIDTH = 5;

// "+9.902", seconds since the pairing started, as in §16.7.
export function formatOffset(t: number): string {
    return `+${(t / 1000).toFixed(3)}`;
}

// DL-15: peer entries carry the peer's device id or name; show the name people know.
export function peerLabel(entry: LogEntry, peer: PeerIdentity | undefined): string | undefined {
    if (entry.peer == null) {
        return undefined;
    }

    if (peer != null && (entry.peer === peer.deviceId || entry.peer === peer.name)) {
        return peer.displayName;
    }

    return entry.peer;
}

export function lineParts(entry: LogEntry, peerName?: string): LineParts {
    return {
        time: formatOffset(entry.t),
        cat: entry.cat,
        level: entry.level,
        ...(peerName == null ? {} : { peer: peerName }),
        msg: entry.msg,
        hasData: entry.data !== undefined,
    };
}

// One text line per entry; exports add the data as compact JSON.
export interface LineOptions {
    readonly peerName?: string;
    readonly withData?: boolean;
}

export function formatLine(entry: LogEntry, options: LineOptions = {}): string {
    const parts = lineParts(entry, options.peerName);
    const peer = parts.peer == null ? '' : `[${parts.peer}] `;
    const data = options.withData === true && entry.data !== undefined ? ` ${safeStringify(entry.data)}` : '';

    const head = [parts.time.padEnd(TIME_WIDTH), parts.cat.padEnd(CATEGORY_WIDTH), parts.level.padEnd(LEVEL_WIDTH)];

    return `${head.join(' ')} ${peer}${parts.msg}${data}`;
}

// The expanded view of a line: every field of the entry, wall time as ISO.
export function entryDetails(entry: LogEntry): Record<string, unknown> {
    const details: Record<string, unknown> = {
        t: entry.t,
        wall: new Date(entry.wall).toISOString(),
        level: entry.level,
        cat: entry.cat,
        msg: entry.msg,
        peer: entry.peer,
        sessionId: entry.sessionId,
        connectionId: entry.connectionId,
        fileId: entry.fileId,
        page: entry.page,
        data: entry.data,
    };

    return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

// JSON that never throws: cycles, bigints and functions become short markers.
export function safeStringify(value: unknown, space?: number): string {
    const seen = new WeakSet<object>();

    try {
        return JSON.stringify(
            value,
            (_, item: unknown) => {
                if (typeof item === 'bigint') {
                    return `${item}n`;
                }

                if (typeof item === 'function') {
                    return '[function]';
                }

                if (item != null && typeof item === 'object') {
                    if (seen.has(item)) {
                        return '[circular]';
                    }

                    seen.add(item);
                }

                return item;
            },
            space,
        ) ?? 'undefined';
    } catch {
        return '"[unserializable]"';
    }
}

interface JsonTokenRule {
    readonly kind: JsonTokenKind;
    readonly pattern: RegExp;
}

const JSON_TOKEN_PATTERNS: readonly JsonTokenRule[] = Object.freeze([
    { kind: 'key', pattern: /^"(?:[^"\\]|\\.)*"(?=\s*:)/ },
    { kind: 'string', pattern: /^"(?:[^"\\]|\\.)*"/ },
    { kind: 'number', pattern: /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/ },
    { kind: 'boolean', pattern: /^(?:true|false)/ },
    { kind: 'null', pattern: /^null/ },
    { kind: 'space', pattern: /^\s+/ },
    { kind: 'punct', pattern: /^[{}[\]:,]/ },
]);

// Splits pretty-printed JSON into coloured spans for the expanded line (DL-03); built as text nodes, never HTML.
export function tokenizeJson(text: string): JsonToken[] {
    const tokens: JsonToken[] = [];
    let rest = text;

    while (rest.length > 0) {
        const match = JSON_TOKEN_PATTERNS
            .map(rule => ({ kind: rule.kind, found: rule.pattern.exec(rest)?.[0] }))
            .find(candidate => candidate.found != null && candidate.found.length > 0);
        const kind = match?.kind ?? 'punct';
        const found = match?.found ?? rest.charAt(0);
        tokens.push({ kind, text: found });
        rest = rest.slice(found.length);
    }

    return tokens;
}
