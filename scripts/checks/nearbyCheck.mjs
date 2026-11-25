// Real-world check of nearby devices: two headless Chromium pages ("Check A" and "Check B", each with its own
// storage) find the public IPv4 address through the real STUN pool, meet through the real relays, complete
// request → accept, request → decline and request → cancel with dummy codes, B reloads its page without A ever
// listing it twice, and a device with a PIN turns requests down without the PIN or with a wrong one and takes the
// right one as verified. Opt-in: it needs the internet.
//
//   node scripts/checks/nearbyCheck.mjs [--log]       (or: npm run check:nearby)
//
// The page is served by scripts/serve.mjs from a temporary folder, with the app's own Content Security Policy,
// so it also proves that policy lets every relay through. --log prints each page's nearby log.
// Uses the Chromium that Playwright installed under ms-playwright, else an installed Chrome; set CHROME_PATH
// to choose another. Prints PASS or FAIL per step and exits with 1 when any step fails.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { buildContentSecurityPolicy, readRelayListAsync } from '../contentSecurityPolicy.mjs';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE_ENTRY = join(ROOT_DIRECTORY, 'scripts', 'checks', 'nearbyCheckPage.mjs');
const IS_LOG_PRINTED = process.argv.includes('--log');
const LOG_TAIL_LINES = 40;
// Dummy codes: discovery carries pairing codes as text and never decodes them.
const OFFER = 'CHECKOFFERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2345';
const ANSWER = 'CHECKANSWERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB6767';
const NAMES = Object.freeze(['Check A', 'Check B']);
const PIN = '2468';
const WRONG_PIN = '1357';

const results = [];

function findBrowser() {
    const local = process.env.LOCALAPPDATA ?? '';
    const caches = [
        { root: join(local, 'ms-playwright'), executable: ['chrome-win64', 'chrome.exe'] },
        { root: join(homedir(), '.cache', 'ms-playwright'), executable: ['chrome-linux', 'chrome'] },
    ];
    const fromCaches = caches.flatMap(cache => (existsSync(cache.root) ? readdirSync(cache.root) : [])
        .filter(name => /^chromium-\d+$/.test(name))
        .sort((first, second) => Number(second.split('-')[1]) - Number(first.split('-')[1]))
        .map(build => join(cache.root, build, ...cache.executable)));
    const installed = [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];

    return [process.env.CHROME_PATH, ...fromCaches, ...installed].find(path => path && existsSync(path));
}

function findFreePortAsync() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

// The page with the app's policy as a meta tag, as build.mjs writes it, in its own temporary folder.
async function writePageAsync() {
    const folder = await mkdtemp(join(tmpdir(), 'ether-nearby-check-'));
    const bundle = await esbuild.build({
        entryPoints: [PAGE_ENTRY],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        write: false,
        logLevel: 'warning',
    });
    const policy = buildContentSecurityPolicy(await readRelayListAsync());
    const html = [
        '<!doctype html>',
        '<meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
        '<title>Nearby check</title>',
        '<script type="module" src="./check.js"></script>',
    ].join('\n');
    await writeFile(join(folder, 'index.html'), html, 'utf-8');
    await writeFile(join(folder, 'check.js'), bundle.outputFiles[0].text, 'utf-8');

    return folder;
}

async function startServerAsync(folder, port) {
    const serveScript = join(ROOT_DIRECTORY, 'scripts', 'serve.mjs');
    const serveArguments = ['--port', String(port), '--host', '127.0.0.1', '--root', folder];
    const server = spawn(process.execPath, [serveScript, ...serveArguments], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
        server.stdout.on('data', chunk => {
            if (String(chunk).includes('Serving ')) {
                resolve();
            }
        });
        server.on('exit', code => reject(new Error(`server exited with ${code}`)));
    });

    return server;
}

function withTimeoutAsync(promise, ms, description) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${description}`)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function stepAsync(name, timeoutMs, runAsync) {
    try {
        const detail = await withTimeoutAsync(runAsync(), timeoutMs, name);
        results.push({ name, isPassed: true });
        process.stdout.write(`PASS  ${name}${detail ? ` — ${detail}` : ''}\n`);

        return true;
    } catch (error) {
        results.push({ name, isPassed: false });
        process.stdout.write(`FAIL  ${name} — ${error.message}\n`);

        return false;
    }
}

async function waitForAsync(check, description, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) {
            return value;
        }

        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${description}`);
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

async function openDeviceAsync(browser, url, name) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const device = { name, context, page, errors: [], violations: [] };
    page.on('pageerror', error => device.errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
            device.violations.push(message.text());
        }
    });
    await page.goto(url);
    await page.waitForFunction(() => window.nearbyCheck != null, undefined, { timeout: 10_000 });

    return device;
}

const call = (device, method, ...args) => device.page.evaluate(
    ([name, values]) => window.nearbyCheck[name](...values),
    [method, args],
);

async function printLogsAsync(devices, count) {
    for (const device of devices) {
        const lines = await call(device, 'logTail', count).catch(() => []);
        process.stdout.write(`      ${device.name} log:\n${lines.map(line => `      ${line}`).join('\n')}\n`);
    }
}

// Waits for B's next request, from A, carrying A's offer.
async function nextRequestAsync(target, seen) {
    return waitForAsync(async () => {
        const snapshot = await call(target, 'snapshot');

        return snapshot.requests.length > seen ? snapshot.requests.at(-1) : undefined;
    }, `${target.name} to get the request`, 20_000);
}

function verifyRequest(request) {
    if (request.from !== 'Check A' || request.offerCode !== OFFER) {
        throw new Error(`the request came from ${request.from} with another code`);
    }

    if (request.expiresInS < 50 || request.expiresInS > 61) {
        throw new Error(`the request expires in ${request.expiresInS} s`);
    }
}

async function runStepsAsync(first, second, ownRelays, relayCount) {
    const devices = [first, second];
    const isListening = await stepAsync('Check A and Check B find the public address and listen', 45_000, async () => {
        await Promise.all(devices.map(device => waitForAsync(
            async () => (await call(device, 'snapshot')).status === 'listening',
            `${device.name} to listen`,
            40_000,
        )));
        const connections = await call(first, 'connections');

        return `${connections.stun}; relays connected: ${connections.relays.length}`;
    });
    if (!isListening) {
        return;
    }

    await stepAsync("Ether's own relay connects under the page's CSP", 20_000, async () => {
        for (const device of devices) {
            await waitForAsync(async () => {
                const { relays } = await call(device, 'connections');

                return ownRelays.every(url => relays.includes(url));
            }, `${device.name} to reach ${ownRelays.join(', ')}`, 15_000);
        }

        const { relays } = await call(first, 'connections');

        return relays.join(', ');
    });

    const isMet = await stepAsync('each lists the other', 45_000, async () => {
        const started = Date.now();
        for (const [device, other] of [[first, second], [second, first]]) {
            await waitForAsync(
                async () => (await call(device, 'snapshot')).devices.includes(other.name),
                `${device.name} to list ${other.name}`,
                40_000,
            );
        }

        return `in ${((Date.now() - started) / 1000).toFixed(1)} s`;
    });
    if (!isMet) {
        return;
    }

    await stepAsync('request → accept carries the offer and brings back the answer', 30_000, async () => {
        const seen = (await call(second, 'snapshot')).requests.length;
        const outcome = call(first, 'requestAsync', 'Check B', OFFER);
        const request = await nextRequestAsync(second, seen);
        verifyRequest(request);
        await call(second, 'acceptAsync', request.requestId, ANSWER);
        const result = await outcome;
        if (result.kind !== 'accepted' || result.answerCode !== ANSWER) {
            throw new Error(`outcome ${JSON.stringify(result)}`);
        }

        return 'accepted with the answer';
    });

    await stepAsync('request → decline', 30_000, async () => {
        const seen = (await call(second, 'snapshot')).requests.length;
        const outcome = call(first, 'requestAsync', 'Check B', OFFER);
        const request = await nextRequestAsync(second, seen);
        await call(second, 'declineAsync', request.requestId);
        const result = await outcome;
        if (result.kind !== 'declined') {
            throw new Error(`outcome ${JSON.stringify(result)}`);
        }

        return 'declined';
    });

    await stepAsync('request → cancel ends the request on the other side', 30_000, async () => {
        const seen = (await call(second, 'snapshot')).requests.length;
        await call(first, 'beginRequest', 'Check B', OFFER);
        const request = await nextRequestAsync(second, seen);
        const result = await call(first, 'abortRequestAsync');
        await waitForAsync(
            async () => (await call(second, 'snapshot')).ended.includes(request.requestId),
            'Check B to hear the cancel',
            15_000,
        );
        if (result.kind !== 'canceled') {
            throw new Error(`outcome ${JSON.stringify(result)}`);
        }

        return 'canceled';
    });

    await stepAsync('B reloads its page: A lists B once, within a few seconds', 30_000, async () => {
        const rowsOfB = snapshot => snapshot.rows.filter(row => row.name === 'Check B');
        const before = rowsOfB(await call(first, 'snapshot'));
        let mostRows = before.length;
        let isWatching = true;
        const watching = (async () => {
            while (isWatching) {
                mostRows = Math.max(mostRows, rowsOfB(await call(first, 'snapshot')).length);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        })();
        const started = Date.now();
        try {
            await second.page.reload();
            await second.page.waitForFunction(() => window.nearbyCheck != null, undefined, { timeout: 10_000 });
            await call(second, 'start', 'Check B');
            await waitForAsync(async () => {
                const rows = rowsOfB(await call(first, 'snapshot'));
                const back = await call(second, 'snapshot');

                return rows.length === 1 && back.status === 'listening' && back.devices.includes('Check A');
            }, 'Check A to list Check B again, and Check B to list Check A', 20_000);
        } finally {
            isWatching = false;
            await watching;
        }

        const after = rowsOfB(await call(first, 'snapshot'));
        if (mostRows > 1) {
            throw new Error(`Check A listed Check B ${mostRows} times during the reload`);
        }

        if (before[0]?.nearbyId !== after[0]?.nearbyId) {
            throw new Error('Check B came back as another device');
        }

        return `same device, back in ${((Date.now() - started) / 1000).toFixed(1)} s`;
    });

    // After the reload, with A holding the PIN: B then sends three requests, well within what A takes from one device
    // (10 messages, then 1 every 3 s), so B's goodbye in the next step still gets through.
    await stepAsync('a PIN: none or a wrong one is turned down, the right one needs no Accept', 60_000, async () => {
        await call(first, 'setPin', 'Check A', PIN);
        try {
            await waitForAsync(
                async () => (await call(second, 'snapshot')).rows.find(row => row.name === 'Check A')?.hasPin === true,
                'Check B to see that Check A has a PIN',
                15_000,
            );
            const seen = (await call(first, 'snapshot')).requests.length;
            const missing = await call(second, 'requestAsync', 'Check A', OFFER);
            const wrong = await call(second, 'requestAsync', 'Check A', OFFER, WRONG_PIN);
            if (missing.kind !== 'pin-required' || wrong.kind !== 'wrong-pin') {
                throw new Error(`outcomes ${JSON.stringify([missing, wrong])}`);
            }

            const outcome = call(second, 'requestAsync', 'Check A', OFFER, PIN);
            const request = await nextRequestAsync(first, seen);
            if (request.from !== 'Check B' || request.isPinVerified !== true) {
                throw new Error(`the request came from ${request.from}, verified: ${request.isPinVerified}`);
            }

            await call(first, 'acceptAsync', request.requestId, ANSWER);
            const result = await outcome;
            if (result.kind !== 'accepted' || result.answerCode !== ANSWER) {
                throw new Error(`outcome ${JSON.stringify(result)}`);
            }
        } finally {
            await call(first, 'setPin', 'Check A', null);
        }

        return 'pin-required, wrong-pin, then accepted as verified';
    });

    await stepAsync('stop says goodbye and the other side drops it at once', 15_000, async () => {
        const started = Date.now();
        await call(second, 'stop');
        await waitForAsync(
            async () => !(await call(first, 'snapshot')).devices.includes('Check B'),
            'Check A to drop Check B',
            10_000,
        );

        return `in ${((Date.now() - started) / 1000).toFixed(1)} s`;
    });

    await stepAsync('no relay allowance notice, page errors or CSP violations', 1000, async () => {
        const notices = (await call(first, 'snapshot')).notices;
        const problems = [
            ...notices.filter(notice => notice != null).map(notice => `notice for ${notice.relayUrl}`),
            ...devices.flatMap(device => [...device.errors, ...device.violations]),
        ];
        if (problems.length > 0) {
            throw new Error(problems.join(' | '));
        }

        const counts = await Promise.all(devices
            .map(async device => (await call(device, 'connections')).relays.length));

        return `relays connected by the end: ${counts.join(' and ')} of ${relayCount}`;
    });
}

async function mainAsync() {
    const executablePath = findBrowser();
    if (executablePath == null) {
        throw new Error('No Chromium or Chrome found; install one or set CHROME_PATH');
    }

    process.stdout.write(`Browser: ${executablePath}\n`);
    const relayList = await readRelayListAsync();
    process.stdout.write(`Relays: ${[...relayList.own, ...relayList.public].join(', ')}\n`);
    const folder = await writePageAsync();
    const port = await findFreePortAsync();
    const server = await startServerAsync(folder, port);
    const browser = await chromium.launch({ executablePath, headless: true });
    const devices = [];
    try {
        const url = `http://127.0.0.1:${port}/`;
        for (const name of NAMES) {
            devices.push(await openDeviceAsync(browser, url, name));
        }

        for (const device of devices) {
            await call(device, 'start', device.name);
        }

        await runStepsAsync(devices[0], devices[1], relayList.own, relayList.own.length + relayList.public.length);
        if (IS_LOG_PRINTED || results.some(result => !result.isPassed)) {
            await printLogsAsync(devices, IS_LOG_PRINTED ? 5000 : LOG_TAIL_LINES);
        }
    } finally {
        for (const device of devices) {
            await call(device, 'stop').catch(() => undefined);
        }

        await browser.close();
        server.kill();
        await rm(folder, { recursive: true, force: true });
    }
}

try {
    await mainAsync();
} catch (error) {
    results.push({ name: 'setup', isPassed: false });
    process.stdout.write(`FAIL  setup — ${error.message}\n`);
}

const failed = results.filter(result => !result.isPassed).length;
const passed = results.length - failed;
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 && passed > 0 ? 0 : 1);
