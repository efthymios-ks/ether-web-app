// The relay's rules, kept apart from Cloudflare so they can be tested: which messages it takes, which
// subscriptions hear an event, and the limits that keep one connection from using up the free plan.
// It speaks the part of NIP-01 that Ether needs. Only ephemeral events (kinds 20000–29999) are taken, so nothing
// is stored and a subscription ends its stored events (EOSE) at once. Ids and signatures are not checked here,
// to stay within the free plan's CPU time: Ether checks both on every event it receives.

export const LIMITS = Object.freeze({
    messageLength: 32 * 1024,
    contentLength: 16 * 1024,
    subscriptions: 4,
    filtersPerRequest: 4,
    subscriptionIdLength: 64,
    filterValues: 16,
    tagCount: 16,
    tagEntries: 8,
    tagLength: 256,
    // A connection's subscriptions are kept in its WebSocket attachment, which holds at most 2 KB.
    subscriptionsJsonLength: 1500,
    messagesPerWindow: 40,
    windowMs: 10_000,
    clockSkewSeconds: 600,
});

export const EPHEMERAL_KINDS = Object.freeze({ first: 20_000, last: 29_999 });

// Ether asks this when its WebSocket to the relay fails, since a browser can't see why a WebSocket failed.
export const STATUS_PATH = '/status';

// ok: the relay works. limit: Cloudflare refused it for a used-up free allowance. error: any other fault.
// forbidden: the relay doesn't serve the asking page's origin, so Ether leaves it alone and shows no notice.
export type RelayStatus = 'ok' | 'limit' | 'error' | 'forbidden';

export interface NostrEvent {
    readonly id: string;
    readonly pubkey: string;
    readonly created_at: number;
    readonly kind: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
    readonly sig: string;
}

export interface Filter {
    readonly ids?: readonly string[];
    readonly authors?: readonly string[];
    readonly kinds?: readonly number[];
    readonly since?: number;
    readonly until?: number;
    // The single-letter tag conditions ('#x' in NIP-01), keyed by the letter.
    readonly tags?: Readonly<Record<string, readonly string[]>>;
}

export interface ConnectionState {
    readonly subscriptions: Readonly<Record<string, readonly Filter[]>>;
    readonly windowStartMs: number;
    readonly messagesInWindow: number;
}

export type RelayReply =
    | readonly ['OK', string, boolean, string]
    | readonly ['EOSE', string]
    | readonly ['CLOSED', string, string]
    | readonly ['NOTICE', string];

export interface Outcome {
    readonly state: ConnectionState;
    readonly replies: readonly RelayReply[];
    // An accepted event, for every subscription that matches it, the sender's included.
    readonly event?: NostrEvent;
}

export const INITIAL_STATE: ConnectionState = Object.freeze({ subscriptions: {}, windowStartMs: 0, messagesInWindow: 0 });

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const TAG_FILTER_KEY = /^#[A-Za-z]$/;
const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1']);

// `text` is undefined for a binary message.
export function handleMessage(state: ConnectionState, text: string | undefined, nowMs: number): Outcome {
    const counted = countMessage(state, nowMs);
    if (counted.messagesInWindow > LIMITS.messagesPerWindow) {
        return reply(counted, ['NOTICE', 'rate-limited: slow down']);
    }

    if (text == null) {
        return reply(counted, ['NOTICE', 'invalid: text messages only']);
    }

    if (text.length > LIMITS.messageLength) {
        return reply(counted, ['NOTICE', 'invalid: message too large']);
    }

    let message: unknown;
    try {
        message = JSON.parse(text);
    } catch {
        return reply(counted, ['NOTICE', 'invalid: not JSON']);
    }

    if (!Array.isArray(message)) {
        return reply(counted, ['NOTICE', 'invalid: not a relay message']);
    }

    switch (message[0]) {
        case 'EVENT':
            return handleEvent(counted, message[1], nowMs);
        case 'REQ':
            return handleRequest(counted, message[1], message.slice(2));
        case 'CLOSE':
            return handleClose(counted, message[1]);
        default:
            return reply(counted, ['NOTICE', 'invalid: unknown message type']);
    }
}

// The ids of this connection's subscriptions that an event matches.
export function matchingSubscriptions(state: ConnectionState, event: NostrEvent): string[] {
    return Object.entries(state.subscriptions)
        .filter(([, filters]) => filters.some(filter => matchesFilter(filter, event)))
        .map(([subscriptionId]) => subscriptionId);
}

export function matchesFilter(filter: Filter, event: NostrEvent): boolean {
    return (filter.ids == null || filter.ids.includes(event.id))
        && (filter.authors == null || filter.authors.includes(event.pubkey))
        && (filter.kinds == null || filter.kinds.includes(event.kind))
        && (filter.since == null || event.created_at >= filter.since)
        && (filter.until == null || event.created_at <= filter.until)
        && Object.entries(filter.tags ?? {}).every(([letter, values]) => event.tags
            .some(tag => tag[0] === letter && tag[1] != null && values.includes(tag[1])));
}

// Browsers always send Origin with a WebSocket handshake. `allowedOrigins` is a space-separated list;
// localhost and 127.0.0.1 match on any port, every other origin must match exactly.
// Pages served from a private network address (10.x, 172.16–31.x, 192.168.x) are allowed on any port too:
// that's Ether served from a computer to a phone on the same Wi-Fi, which only that network can reach.
export function isOriginAllowed(origin: string | null, allowedOrigins: string): boolean {
    const url = parseUrl(origin);
    if (url == null) {
        return false;
    }

    if ((url.protocol === 'https:' || url.protocol === 'http:') && isPrivateNetworkHost(url.hostname)) {
        return true;
    }

    return allowedOrigins.split(/\s+/).some(entry => {
        const allowed = parseUrl(entry);
        if (allowed == null) {
            return false;
        }

        return LOCAL_HOSTS.includes(allowed.hostname)
            ? url.protocol === allowed.protocol && url.hostname === allowed.hostname
            : url.origin === allowed.origin;
    });
}

// Cloudflare's errors for a used-up free allowance speak of the free tier or of a limit exceeded.
export function statusFromError(error: unknown): RelayStatus {
    const message = error instanceof Error ? error.message : String(error);

    return /free tier|limit|exceeded/i.test(message) ? 'limit' : 'error';
}

// The status check is read from Ether's page on another origin, so it answers with that origin's CORS header.
export function statusHeaders(origin: string): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': origin,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        Vary: 'Origin',
    };
}

export function isPrivateNetworkHost(hostname: string): boolean {
    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)?.slice(1).map(Number);
    if (octets == null || octets.some(octet => octet > 255)) {
        return false;
    }

    const [first = -1, second = -1] = octets;

    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function countMessage(state: ConnectionState, nowMs: number): ConnectionState {
    return nowMs - state.windowStartMs >= LIMITS.windowMs
        ? { ...state, windowStartMs: nowMs, messagesInWindow: 1 }
        : { ...state, messagesInWindow: state.messagesInWindow + 1 };
}

function handleEvent(state: ConnectionState, value: unknown, nowMs: number): Outcome {
    const event = parseEvent(value);
    if (event == null) {
        const id = isRecord(value) && typeof value.id === 'string' && HEX_64.test(value.id) ? value.id : '';

        return reply(state, ['OK', id, false, 'invalid: malformed event']);
    }

    if (event.kind < EPHEMERAL_KINDS.first || event.kind > EPHEMERAL_KINDS.last) {
        return reply(state, ['OK', event.id, false, 'blocked: ephemeral events only']);
    }

    if (Math.abs(event.created_at - nowMs / 1000) > LIMITS.clockSkewSeconds) {
        return reply(state, ['OK', event.id, false, 'invalid: created_at is too far from now']);
    }

    return { state, replies: [['OK', event.id, true, '']], event };
}

function handleRequest(state: ConnectionState, subscriptionId: unknown, values: readonly unknown[]): Outcome {
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0 || subscriptionId.length > LIMITS.subscriptionIdLength) {
        return reply(state, ['NOTICE', 'invalid: subscription id']);
    }

    if (values.length === 0 || values.length > LIMITS.filtersPerRequest) {
        return reply(state, ['CLOSED', subscriptionId, `invalid: 1 to ${LIMITS.filtersPerRequest} filters`]);
    }

    const filters = values.map(parseFilter);
    if (filters.some(filter => filter == null)) {
        return reply(state, ['CLOSED', subscriptionId, 'invalid: unsupported filter']);
    }

    const isNew = !(subscriptionId in state.subscriptions);
    if (isNew && Object.keys(state.subscriptions).length >= LIMITS.subscriptions) {
        return reply(state, ['CLOSED', subscriptionId, 'blocked: too many subscriptions']);
    }

    const subscriptions = { ...state.subscriptions, [subscriptionId]: filters as Filter[] };
    if (JSON.stringify(subscriptions).length > LIMITS.subscriptionsJsonLength) {
        return reply(state, ['CLOSED', subscriptionId, 'blocked: subscription too large']);
    }

    return reply({ ...state, subscriptions }, ['EOSE', subscriptionId]);
}

function handleClose(state: ConnectionState, subscriptionId: unknown): Outcome {
    if (typeof subscriptionId !== 'string') {
        return reply(state, ['NOTICE', 'invalid: subscription id']);
    }

    const { [subscriptionId]: _, ...subscriptions } = state.subscriptions;

    return { state: { ...state, subscriptions }, replies: [] };
}

// Only the NIP-01 fields, checked for shape and size; anything else on the event is dropped.
function parseEvent(value: unknown): NostrEvent | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = value;
    if (typeof id !== 'string' || !HEX_64.test(id)
        || typeof pubkey !== 'string' || !HEX_64.test(pubkey)
        || typeof sig !== 'string' || !HEX_128.test(sig)
        || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0
        || typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 0xffff
        || typeof content !== 'string' || content.length > LIMITS.contentLength
        || !isTagList(tags)) {
        return undefined;
    }

    return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

function isTagList(value: unknown): value is string[][] {
    return Array.isArray(value) && value.length <= LIMITS.tagCount && value.every(tag => Array.isArray(tag)
        && tag.length <= LIMITS.tagEntries
        && tag.every(entry => typeof entry === 'string' && entry.length <= LIMITS.tagLength));
}

function parseFilter(value: unknown): Filter | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const filter: { -readonly [Key in keyof Filter]: Filter[Key] } = {};
    const tags: Record<string, readonly string[]> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === 'ids' || key === 'authors') {
            if (!isListOf(entry, item => typeof item === 'string' && HEX_64.test(item))) {
                return undefined;
            }

            filter[key] = entry as string[];
        } else if (key === 'kinds') {
            if (!isListOf(entry, item => Number.isInteger(item))) {
                return undefined;
            }

            filter.kinds = entry as number[];
        } else if (key === 'since' || key === 'until') {
            if (!Number.isSafeInteger(entry)) {
                return undefined;
            }

            filter[key] = entry as number;
        } else if (key === 'limit') {
            // Nothing is stored, so there is nothing to limit.
            if (!Number.isSafeInteger(entry) || (entry as number) < 0) {
                return undefined;
            }
        } else if (TAG_FILTER_KEY.test(key)) {
            if (!isListOf(entry, item => typeof item === 'string' && item.length <= LIMITS.tagLength)) {
                return undefined;
            }

            tags[key.slice(1)] = entry as string[];
        } else {
            return undefined;
        }
    }

    return Object.keys(tags).length === 0 ? filter : { ...filter, tags };
}

function isListOf(value: unknown, isItem: (item: unknown) => boolean): boolean {
    return Array.isArray(value) && value.length > 0 && value.length <= LIMITS.filterValues && value.every(isItem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseUrl(text: string | null): URL | undefined {
    if (!text) {
        return undefined;
    }

    try {
        return new URL(text);
    } catch {
        return undefined;
    }
}

function reply(state: ConnectionState, message: RelayReply): Outcome {
    return { state, replies: [message] };
}
