// Redaction runs inside the logger before any sink sees an entry (LG-08, DL-14).

const SECRET_KEYS = /pwd|password|passphrase|secret/i;
// The device's PIN (a setting) and a nearby request's proof of it, whatever they hold.
const PIN_KEYS = /^(pin|newPin|proof)$/i;
const CODE_KEYS = /^(code|offerCode|answerCode|url|offerUrl|answerUrl|codeOrUrl)$/;
const SHORTENED_KEYS = /hash|fingerprint|sha256/i;
const SHORT_LENGTH = 8;
const MAX_DEPTH = 6;

export function shorten(value: string, length = SHORT_LENGTH): string {
    return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function redact(value: unknown, depth = 0): unknown {
    if (value == null || typeof value !== 'object') {
        return value;
    }

    if (depth >= MAX_DEPTH) {
        return '[…]';
    }

    if (Array.isArray(value)) {
        return value.map(item => redact(item, depth + 1));
    }

    if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob) {
        return `[${value.constructor.name}]`;
    }

    if (value instanceof Error) {
        return { name: value.name, message: value.message };
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        result[key] = redactProperty(key, item, depth);
    }

    return result;
}

function redactProperty(key: string, item: unknown, depth: number): unknown {
    if (SECRET_KEYS.test(key) || PIN_KEYS.test(key)) {
        return '[redacted]';
    }

    if (CODE_KEYS.test(key) && typeof item === 'string') {
        return `[code, ${item.length} chars]`;
    }

    if (SHORTENED_KEYS.test(key) && typeof item === 'string') {
        return shorten(item);
    }

    return redact(item, depth + 1);
}

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
// Candidate IPv6 tokens; isIpv6 then rules out look-alikes such as clock times (13:05:09).
const IPV6_CANDIDATE = /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi;

function isIpv6(token: string): boolean {
    const groups = token.split(':');

    return token.includes('::') || groups.length === 8;
}

// Export option: hides the last part of local addresses, e.g. 192.168.1.x (DL-14).
export function maskIpAddresses(text: string): string {
    return text
        .replace(IPV4, (_, first: string, second: string, third: string) => `${first}.${second}.${third}.x`)
        .replace(IPV6_CANDIDATE, match => (isIpv6(match) ? `${match.split(':').slice(0, 2).join(':')}:x` : match));
}
