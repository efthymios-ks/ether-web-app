// PW-02, PW-03: precaches the build, serves it cache-first, and waits for the page to ask before updating.
const worker = self as unknown as ServiceWorkerGlobalScope;

const CACHE_PREFIX = 'ether-';
const CACHE_NAME = `${CACHE_PREFIX}${__BUILD_VERSION__}`;

const MESSAGES = Object.freeze({
    skipWaiting: 'skip-waiting',
    version: 'version',
});

function scopeUrl(path: string): string {
    return new URL(path, worker.registration.scope).href;
}

async function precacheAsync(): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    // Bypass the HTTP cache so a new version never stores an older file.
    await cache.addAll(__PRECACHE__.map(path => new Request(scopeUrl(path), { cache: 'reload' })));
}

async function removeOldCachesAsync(): Promise<void> {
    const names = await caches.keys();
    await Promise.all(names
        .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map(name => caches.delete(name)));
}

async function respondAsync(request: Request): Promise<Response> {
    const cache = await caches.open(CACHE_NAME);
    // `?debug=1` and other queries open the same page (DL-01); the `#` part never reaches the worker.
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached != null) {
        return cached;
    }

    if (request.mode === 'navigate') {
        const shell = await cache.match(scopeUrl('./'));
        if (shell != null) {
            return shell;
        }
    }

    return fetch(request);
}

function isSameOrigin(request: Request): boolean {
    return new URL(request.url).origin === worker.location.origin;
}

function messageType(data: unknown): string | undefined {
    if (typeof data === 'string') {
        return data;
    }

    if (data != null && typeof data === 'object') {
        const type = (data as { type?: unknown }).type;

        return typeof type === 'string' ? type : undefined;
    }

    return undefined;
}

worker.addEventListener('install', event => {
    event.waitUntil(precacheAsync());
});

worker.addEventListener('activate', event => {
    event.waitUntil((async () => {
        await removeOldCachesAsync();
        // The first install controls the open page at once, so it works offline without a reload.
        await worker.clients.claim();
    })());
});

worker.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET' || !isSameOrigin(request)) {
        return;
    }

    event.respondWith(respondAsync(request));
});

worker.addEventListener('message', event => {
    const type = messageType(event.data);
    if (type === MESSAGES.skipWaiting) {
        void worker.skipWaiting();

        return;
    }

    if (type === MESSAGES.version) {
        const reply = { type: MESSAGES.version, version: __BUILD_VERSION__ };
        const port = event.ports[0];
        if (port != null) {
            port.postMessage(reply);

            return;
        }

        event.source?.postMessage(reply);
    }
});
