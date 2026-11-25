// PW-04, SP-04: the page's Content Security Policy. GitHub Pages can't send headers, so build.mjs writes it into
// index.html as a meta tag. 'unsafe-inline' styles are not needed: the app sets styles through the CSSOM only.
// connect-src names each nearby relay from src/discovery/relays.json, never a blanket wss: — Ether's own relays
// twice, as wss:// for the relay and https:// for its status check, and the public relays as wss://.
// STUN is not governed by CSP.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RELAY_LIST_PATH = join(ROOT_DIRECTORY, 'src', 'discovery', 'relays.json');
// A bare origin: no path, so the CSP source matches the relay exactly.
const RELAY_URL_PATTERN = /^wss:\/\/[a-z0-9.-]+(:\d+)?$/;

// Throws for anything but { own: [...], public: [...] } of bare wss:// origins.
export function validateRelayList(list) {
    const groups = [list?.own, list?.public];
    if (!groups.every(Array.isArray)) {
        throw new Error('relays.json must hold "own" and "public" lists');
    }

    const invalid = groups.flat().filter(url => typeof url !== 'string' || !RELAY_URL_PATTERN.test(url));
    if (invalid.length > 0) {
        throw new Error(`relays.json holds URLs that are not bare wss:// origins: ${invalid.join(', ')}`);
    }

    return { own: [...list.own], public: [...list.public] };
}

export async function readRelayListAsync(path = RELAY_LIST_PATH) {
    return validateRelayList(JSON.parse(await readFile(path, 'utf-8')));
}

export function connectSources(relayList) {
    return [
        "'self'",
        ...relayList.own.flatMap(url => [url, url.replace(/^wss:/, 'https:')]),
        ...relayList.public,
    ];
}

export function buildContentSecurityPolicy(relayList) {
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        `connect-src ${connectSources(relayList).join(' ')}`,
        "worker-src 'self'",
        "manifest-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
    ].join('; ');
}
