import { createHash } from 'node:crypto';
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import * as esbuild from 'esbuild';
import * as sass from 'sass';
import { buildContentSecurityPolicy, readRelayListAsync } from './contentSecurityPolicy.mjs';
import { buildNoticesAsync } from './thirdPartyNotices.mjs';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const FINAL_DIRECTORY = join(ROOT_DIRECTORY, 'dist');
// Each build writes into its own folder and replaces dist only when it succeeds, so a failed rebuild keeps the last
// good site and two builds at once (a watcher and a manual build) never write into the same folder.
const STAGING_PREFIX = 'dist.staging-';
const OUTPUT_DIRECTORY = join(ROOT_DIRECTORY, `${STAGING_PREFIX}${process.pid}`);
const ASSETS_DIRECTORY = join(OUTPUT_DIRECTORY, 'assets');
const IS_WATCH_MODE = process.argv.includes('--watch');

// Safari 17 is the oldest engine the app supports (§2).
const TARGETS = ['es2022', 'safari17', 'chrome120', 'firefox126'];

function shortHash(content) {
    return createHash('sha256').update(content).digest('hex').slice(0, 10);
}

async function listFilesAsync(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFilesAsync(path)));
        } else {
            files.push(path);
        }
    }

    return files;
}

function toUrlPath(path) {
    return relative(OUTPUT_DIRECTORY, path).split(sep).join('/');
}

// The main bundle's path, and the licence texts of the libraries bundled into it (licenses.txt).
async function bundleScriptAsync() {
    const result = await esbuild.build({
        entryPoints: [join(ROOT_DIRECTORY, 'src', 'app', 'main.ts')],
        outdir: ASSETS_DIRECTORY,
        entryNames: '[name]-[hash]',
        chunkNames: 'chunk-[hash]',
        bundle: true,
        splitting: true,
        format: 'esm',
        target: TARGETS,
        minify: true,
        sourcemap: 'linked',
        metafile: true,
        logLevel: 'warning',
        legalComments: 'linked',
    });
    const outputs = Object.keys(result.metafile.outputs).map(path => join(ROOT_DIRECTORY, path));
    const entry = outputs.find(path => /[\\/]main-[^\\/]+\.js$/.test(path));
    if (!entry) {
        throw new Error('esbuild produced no main bundle');
    }

    const notices = await buildNoticesAsync(Object.keys(result.metafile.inputs), ROOT_DIRECTORY);
    await writeFile(join(OUTPUT_DIRECTORY, 'licenses.txt'), notices, 'utf-8');

    return toUrlPath(entry);
}

async function compileStylesAsync() {
    const result = sass.compile(join(ROOT_DIRECTORY, 'src', 'app', 'styles.scss'), {
        style: 'compressed',
        sourceMap: false,
    });
    const name = `styles-${shortHash(result.css)}.css`;
    await writeFile(join(ASSETS_DIRECTORY, name), result.css, 'utf-8');

    return `assets/${name}`;
}

// PW-04, SP-04: the policy is a meta tag; contentSecurityPolicy.mjs builds it, relays included.
async function writeIndexAsync(scriptPath, stylePath, version) {
    const template = await readFile(join(ROOT_DIRECTORY, 'src', 'app', 'index.html'), 'utf-8');
    const contentSecurityPolicy = buildContentSecurityPolicy(await readRelayListAsync());
    const html = template
        .replaceAll('{{csp}}', contentSecurityPolicy)
        .replaceAll('{{styles}}', stylePath)
        .replaceAll('{{script}}', scriptPath)
        .replaceAll('{{version}}', version);
    await writeFile(join(OUTPUT_DIRECTORY, 'index.html'), html, 'utf-8');
}

// PW-02: the service worker precaches every built file; its cache name is the build version.
async function bundleServiceWorkerAsync(version) {
    const files = (await listFilesAsync(OUTPUT_DIRECTORY))
        .map(toUrlPath)
        .filter(path => !path.endsWith('.map') && !path.endsWith('.LEGAL.txt') && path !== 'sw.js')
        .sort();
    const precache = ['./', ...files];

    await esbuild.build({
        entryPoints: [join(ROOT_DIRECTORY, 'src', 'sw', 'serviceWorker.ts')],
        outfile: join(OUTPUT_DIRECTORY, 'sw.js'),
        bundle: true,
        format: 'iife',
        target: TARGETS,
        minify: true,
        sourcemap: false,
        logLevel: 'warning',
        define: {
            __BUILD_VERSION__: JSON.stringify(version),
            __PRECACHE__: JSON.stringify(precache),
        },
    });

    return precache.length;
}

async function computeVersionAsync() {
    const files = (await listFilesAsync(OUTPUT_DIRECTORY)).filter(path => !path.endsWith('.map')).sort();
    const hash = createHash('sha256');

    for (const path of files) {
        hash.update(toUrlPath(path));
        hash.update(await readFile(path));
    }

    const packageJson = JSON.parse(await readFile(join(ROOT_DIRECTORY, 'package.json'), 'utf-8'));

    return `${packageJson.version}+${hash.digest('hex').slice(0, 8)}`;
}

// Swaps the finished staging folder in for dist; copies instead when Windows holds a file in dist open.
const PUBLISH_LOCK = join(ROOT_DIRECTORY, 'dist.lock');
const LOCK_WAIT_MS = 15_000;
const STALE_LOCK_MS = 30_000;

// One build at a time replaces dist; a lock older than STALE_LOCK_MS belongs to a build that died.
async function withPublishLockAsync(runAsync) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            const handle = await open(PUBLISH_LOCK, 'wx');
            await handle.close();
            break;
        } catch (error) {
            if (error.code !== 'EEXIST' || Date.now() > deadline) {
                throw error;
            }

            const age = Date.now() - (await stat(PUBLISH_LOCK).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
            if (age > STALE_LOCK_MS) {
                await rm(PUBLISH_LOCK, { force: true });
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    try {
        await runAsync();
    } finally {
        await rm(PUBLISH_LOCK, { force: true });
    }
}

async function publishAsync() {
    await withPublishLockAsync(async () => {
        await rm(FINAL_DIRECTORY, { recursive: true, force: true });
        try {
            await rename(OUTPUT_DIRECTORY, FINAL_DIRECTORY);
        } catch {
            await cp(OUTPUT_DIRECTORY, FINAL_DIRECTORY, { recursive: true });
            await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
        }
    });
}

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// Staging folders left by builds that stopped before swapping in.
async function removeAbandonedStagingAsync() {
    const entries = await readdir(ROOT_DIRECTORY, { withFileTypes: true });
    for (const entry of entries) {
        const pid = Number(entry.name.slice(STAGING_PREFIX.length));
        const isAbandoned = entry.isDirectory()
            && entry.name.startsWith(STAGING_PREFIX)
            && Number.isInteger(pid)
            && pid !== process.pid
            && !isProcessRunning(pid);
        if (isAbandoned) {
            await rm(join(ROOT_DIRECTORY, entry.name), { recursive: true, force: true });
        }
    }
}

async function buildAsync() {
    const started = Date.now();
    await removeAbandonedStagingAsync();
    await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
    await mkdir(ASSETS_DIRECTORY, { recursive: true });
    await cp(join(ROOT_DIRECTORY, 'public'), OUTPUT_DIRECTORY, { recursive: true });

    const scriptPath = await bundleScriptAsync();
    const stylePath = await compileStylesAsync();
    await writeIndexAsync(scriptPath, stylePath, 'pending');
    const version = await computeVersionAsync();
    await writeIndexAsync(scriptPath, stylePath, version);
    const precacheCount = await bundleServiceWorkerAsync(version);

    const size = (await Promise.all((await listFilesAsync(OUTPUT_DIRECTORY))
        .filter(path => !path.endsWith('.map'))
        .map(async path => (await stat(path)).size)))
        .reduce((total, value) => total + value, 0);
    await publishAsync();
    console.log(`Built ${version}: ${precacheCount} precached files, ${(size / 1024).toFixed(0)} KiB, ${Date.now() - started} ms`);
}

function watchSources() {
    let timer;
    let running = Promise.resolve();
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            running = running.then(() => buildAsync().catch(async error => {
                await rm(OUTPUT_DIRECTORY, { recursive: true, force: true }).catch(() => undefined);
                console.error(error.message);
            }));
        }, 150);
    };

    for (const folder of ['src', 'public']) {
        watch(join(ROOT_DIRECTORY, folder), { recursive: true }, schedule);
    }

    console.log('Watching src and public for changes…');
}

try {
    await buildAsync();
} catch (error) {
    await rm(OUTPUT_DIRECTORY, { recursive: true, force: true }).catch(() => undefined);
    console.error(error.message ?? error);
    if (!IS_WATCH_MODE) {
        process.exit(1);
    }
}

if (IS_WATCH_MODE) {
    watchSources();
}
