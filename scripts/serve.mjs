// Serves dist for debugging. localhost is a secure context, so the camera, service worker and
// crypto.subtle work there. Phones on the LAN need HTTPS: pass --pfx (Start-Debug.ps1 -Lan makes one),
// or put a dev tunnel in front (Start-Debug.ps1 -Tunnel). --host localhost listens on 127.0.0.1 and ::1,
// since a tunnel or browser may reach "localhost" through either. --root serves another folder instead of dist,
// e.g. the page of npm run check:nearby.
//
//   node scripts/serve.mjs [--port 5173] [--host 127.0.0.1] [--pfx file.pfx --passphrase secret] [--base /ether-web-app/]
//                          [--root folder]
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = join(ROOT_DIRECTORY, 'dist');

const CONTENT_TYPES = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
});

export function parseArguments(argv) {
    const options = { port: 5173, host: '127.0.0.1', pfx: undefined, passphrase: undefined, base: '/', root: undefined };

    for (let index = 0; index < argv.length; index++) {
        const name = argv[index];
        const value = argv[index + 1];
        if (name === '--port') {
            options.port = Number(value);
            index++;
        }

        if (name === '--host') {
            options.host = value;
            index++;
        }

        if (name === '--pfx') {
            options.pfx = value;
            index++;
        }

        if (name === '--passphrase') {
            options.passphrase = value;
            index++;
        }

        if (name === '--base') {
            options.base = value.endsWith('/') ? value : `${value}/`;
            index++;
        }

        if (name === '--root') {
            options.root = resolve(value);
            index++;
        }
    }

    return options;
}

// Maps a request path to a file under dist, or undefined when it escapes dist or the base path.
export function resolveRequestPath(urlPath, base, root = OUTPUT_DIRECTORY) {
    const pathname = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
    if (!pathname.startsWith(base)) {
        return undefined;
    }

    const inner = pathname.slice(base.length) || 'index.html';
    const target = normalize(join(root, inner.endsWith('/') ? `${inner}index.html` : inner));
    if (target !== root && !target.startsWith(root + sep)) {
        return undefined;
    }

    return target;
}

async function handleAsync(request, response, options) {
    const path = resolveRequestPath(request.url ?? '/', options.base, options.root ?? OUTPUT_DIRECTORY);
    if (request.url === '/' && options.base !== '/') {
        response.writeHead(302, { location: options.base });
        response.end();

        return;
    }

    try {
        if (!path || !(await stat(path)).isFile()) {
            throw new Error('not found');
        }

        const body = await readFile(path);
        response.writeHead(200, {
            'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
            'cache-control': 'no-cache',
        });
        response.end(body);
    } catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
    }
}

function lanAddresses() {
    return Object.values(networkInterfaces())
        .flat()
        .filter(address => address && address.family === 'IPv4' && !address.internal)
        .map(address => address.address);
}

async function startAsync() {
    const options = parseArguments(process.argv.slice(2));
    const handler = (request, response) => {
        void handleAsync(request, response, options);
    };
    const isHttps = options.pfx != null;
    const tls = isHttps ? { pfx: await readFile(options.pfx), passphrase: options.passphrase } : undefined;
    const createServer = () => (tls ? createHttpsServer(tls, handler) : createHttpServer(handler));
    const scheme = isHttps ? 'https' : 'http';
    const bindAddresses = options.host === 'localhost' ? ['127.0.0.1', '::1'] : [options.host];
    const servers = bindAddresses.map(() => createServer());

    servers.forEach((instance, index) => {
        const address = bindAddresses[index];
        instance.on('error', error => {
            // IPv6 loopback may be missing; the IPv4 listener is enough then.
            if (index > 0) {
                console.warn(`Not listening on ${address}: ${error.message}`);

                return;
            }

            console.error(error.message);
            process.exit(1);
        });
        instance.listen(options.port, address, () => {
            if (index > 0) {
                return;
            }

            const hosts = options.host === '0.0.0.0' ? ['localhost', ...lanAddresses()] : [options.host];
            const folder = options.root ?? 'dist';
            for (const host of hosts) {
                console.log(`Serving ${folder} at ${scheme}://${host}:${options.port}${options.base}`);
            }
        });
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
    await startAsync();
}
