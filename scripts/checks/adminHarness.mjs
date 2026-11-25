// Builds a page with the Settings sheet and the log viewer on a fake client and sample logs, then serves it, so they
// can be checked in a real browser at phone and desktop sizes, in both themes (§13, test 26).
//
//   node scripts/checks/adminHarness.mjs [--port 5199] [--out <folder>] [--build-only]
//
// Open http://127.0.0.1:5199/?open=settings,viewer&theme=dark (see adminHarnessPage.mjs for the query options).
// The output goes to the system temp folder unless --out names another; nothing is written inside the repo.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as sass from 'sass';

const CHECKS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = join(CHECKS_DIRECTORY, '..', '..');

const CONTENT_TYPES = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
});

// The app's policy: no inline scripts or styles (PW-04, SP-04).
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:";

function readOption(name, fallback) {
    const index = process.argv.indexOf(name);

    return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback;
}

const options = {
    port: Number(readOption('--port', '5199')),
    out: readOption('--out', join(tmpdir(), 'ether-admin-harness')),
    isBuildOnly: process.argv.includes('--build-only'),
};

const PAGE = `<!doctype html>
<html lang="en" data-theme="light">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
    <title>Ether settings and logs harness</title>
    <link rel="stylesheet" href="styles.css">
    <link rel="stylesheet" href="harness.css">
    <script type="module" src="harness.js"></script>
</head>
<body>
    <div class="harness-app" data-role="harness-app">
        <header class="harness-header">
            <h1 class="harness-title">Ether</h1>
            <button class="button button-small" type="button" data-role="logs">Logs</button>
            <button class="button button-small" type="button" data-role="settings">Settings</button>
        </header>
        <main class="harness-main">
            <div class="harness-qr" role="img" aria-label="QR code stand-in"></div>
            <p class="harness-text">Scan this code with the other device. The QR and the camera must stay visible
                while the log viewer is open.</p>
        </main>
    </div>
</body>
</html>
`;

async function buildAsync() {
    await mkdir(options.out, { recursive: true });
    await esbuild.build({
        entryPoints: [join(CHECKS_DIRECTORY, 'adminHarnessPage.mjs')],
        outfile: join(options.out, 'harness.js'),
        bundle: true,
        format: 'esm',
        target: ['es2022'],
        sourcemap: 'linked',
        logLevel: 'warning',
    });
    const styles = sass.compile(join(ROOT_DIRECTORY, 'src', 'app', 'styles.scss'), { style: 'expanded' });
    await writeFile(join(options.out, 'styles.css'), styles.css, 'utf-8');
    await writeFile(join(options.out, 'harness.css'), await readFile(join(CHECKS_DIRECTORY, 'adminHarness.css')));
    await writeFile(join(options.out, 'index.html'), PAGE, 'utf-8');
}

function serve() {
    const root = normalize(options.out);
    const server = createServer(async (request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        const target = normalize(join(root, path === '/' ? 'index.html' : decodeURIComponent(path)));
        if (!target.startsWith(root + sep)) {
            response.writeHead(403).end();

            return;
        }

        try {
            const body = await readFile(target);
            response.writeHead(200, {
                'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
                'cache-control': 'no-store',
            });
            response.end(body);
        } catch {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        }
    });
    server.listen(options.port, '127.0.0.1', () => {
        console.log(`Settings and logs harness at http://127.0.0.1:${options.port}/ (from ${options.out})`);
    });
}

await buildAsync();
console.log(`Built the settings and logs harness into ${options.out}`);
if (!options.isBuildOnly) {
    serve();
}
