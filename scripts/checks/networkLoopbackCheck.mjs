// Acceptance test 29 (NW-08): two Network instances in one real Chromium page pair by passing codes in code,
// then exchange messages and frames on all four slots and close cleanly. Runs with and without camera
// permission, because only with it does Chromium expose real local IPs instead of .local names (HS-05).
//
//   node scripts/checks/networkLoopbackCheck.mjs [--log]       (or: npm run check:network)
//
// --log prints each scenario's network log, the handshake timeline of DL-07.
// Uses the Chromium that Playwright installed under ms-playwright, else an installed Chrome; set CHROME_PATH
// to choose another. Prints PASS or FAIL per step and exits with 1 when any step fails.
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';

const CHECKS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PAGE_ENTRY = join(CHECKS_DIRECTORY, 'networkLoopbackPage.mjs');
const MIB = 1024 * 1024;
const BYTES_PER_SLOT = 8 * MIB;
const MAX_BUFFERED = 4 * MIB;
const LOG_TAIL_LINES = 60;
const SCENARIO_TIMEOUT_MS = 180_000;
const IS_LOG_PRINTED = process.argv.includes('--log');

const SCENARIOS = Object.freeze([
    {
        name: 'camera granted (real local IPs)',
        useCamera: true,
        browserArguments: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        expectedCandidates: ['ipv4', 'ipv6'],
    },
    {
        name: 'no camera hook (.local names)',
        useCamera: false,
        browserArguments: [],
        expectedCandidates: ['mdns'],
    },
]);

const results = [];

function findBrowser() {
    const local = process.env.LOCALAPPDATA ?? '';
    const playwrightCaches = [
        { root: join(local, 'ms-playwright'), executable: ['chrome-win64', 'chrome.exe'] },
        { root: join(homedir(), '.cache', 'ms-playwright'), executable: ['chrome-linux', 'chrome'] },
        {
            root: join(homedir(), 'Library', 'Caches', 'ms-playwright'),
            executable: ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        },
    ];
    const installedChrome = [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        '/usr/bin/google-chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    const fromCaches = playwrightCaches.flatMap(cache => listChromiumBuilds(cache.root)
        .map(build => join(cache.root, build, ...cache.executable)));

    return [process.env.CHROME_PATH, ...fromCaches, ...installedChrome]
        .filter(path => path != null && path !== '')
        .find(path => existsSync(path));
}

// Newest build first.
function listChromiumBuilds(root) {
    if (!existsSync(root)) {
        return [];
    }

    return readdirSync(root)
        .filter(name => /^chromium-\d+$/.test(name))
        .sort((first, second) => Number(second.split('-')[1]) - Number(first.split('-')[1]));
}

async function bundlePageAsync() {
    const result = await esbuild.build({
        entryPoints: [PAGE_ENTRY],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        write: false,
        logLevel: 'warning',
    });

    return result.outputFiles[0].text;
}

function startServerAsync(script) {
    const html = [
        '<!doctype html>',
        '<meta charset="utf-8">',
        '<title>Network loopback check</title>',
        '<script type="module" src="/check.js"></script>',
    ].join('');
    const routes = {
        '/': { type: 'text/html; charset=utf-8', body: html },
        '/check.js': { type: 'text/javascript; charset=utf-8', body: script },
    };
    const server = createServer((request, response) => {
        const route = routes[request.url ?? ''];
        if (route == null) {
            response.writeHead(404).end();
            return;
        }

        response.writeHead(200, { 'content-type': route.type }).end(route.body);
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function withTimeoutAsync(promise, ms, description) {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${description} took longer than ${ms} ms`)), ms).unref();
    });

    return Promise.race([promise, timeout]);
}

function report(scenario, step, isPassed, detail) {
    results.push({ scenario, step, isPassed });
    process.stdout.write(`${isPassed ? 'PASS' : 'FAIL'}  ${scenario} · ${step}${detail ? ` — ${detail}` : ''}\n`);
}

function describe(value) {
    return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
}

// Returns false when the step failed, so the scenario stops there.
async function runStepAsync({ scenario, step, timeoutMs, runAsync, verify }) {
    try {
        const value = await withTimeoutAsync(runAsync(), timeoutMs, step);
        const problem = verify(value);
        report(scenario, step, problem == null, problem ?? describe(value));

        return problem == null;
    } catch (error) {
        report(scenario, step, false, error instanceof Error ? error.message : String(error));

        return false;
    }
}

function verifyPairing(value) {
    if (!value.isSummaryRight) {
        return 'inspectCode does not describe the offer';
    }

    if (value.offererStates.join(' ') !== 'gathering awaiting-answer connecting connected') {
        return `offerer states ${value.offererStates.join(' → ')}`;
    }

    if (value.answererStates.join(' ') !== 'answering connecting connected') {
        return `answerer states ${value.answererStates.join(' → ')}`;
    }

    return undefined;
}

function verifyMessages(value) {
    if (value.internalLeaked.length > 0) {
        return `internal messages reached the client: ${describe(value.internalLeaked)}`;
    }

    const isDelivered = value.offererReceived.some(entry => entry.message.from === 'B')
        && value.offererReceived.some(entry => entry.channel === 3)
        && value.answererReceived.some(entry => entry.message.from === 'A');

    return isDelivered ? undefined : 'a message did not arrive';
}

function verifyFrames(value, maxFramePayload) {
    if (value.frameSize !== maxFramePayload) {
        return `frame size ${value.frameSize}`;
    }

    const broken = value.received.filter(slot => slot.bytes !== BYTES_PER_SLOT || slot.mismatches > 0);
    if (broken.length > 0) {
        return `slots with missing or wrong bytes: ${describe(broken)}`;
    }

    // TR-04: each busy slot stays within its share of maxBuffered, plus the frame that crossed it.
    const share = MAX_BUFFERED / 4;
    const overBuffered = value.peakBuffered.filter(peak => peak > share + value.frameSize + 16);

    return overBuffered.length === 0 ? undefined : `buffer peaks ${value.peakBuffered.join(', ')} over ${share}`;
}

function verifyClose(value) {
    if (value.offererState !== 'closed' || value.answererState !== 'closed') {
        return `states ${value.offererState} and ${value.answererState}`;
    }

    if (!value.byeReceived || value.reactionMs > 1000) {
        return `bye received: ${value.byeReceived}, after ${value.reactionMs} ms`;
    }

    if (value.sendAfterClose !== 'channel-closed' || value.errors.length > 0) {
        return `send after close: ${value.sendAfterClose}, errors: ${value.errors.join(', ')}`;
    }

    return undefined;
}

function buildSteps(scenario, page) {
    const call = (name, ...args) => page.evaluate(([method, values]) => window.networkCheck[method](...values), [name, args]);
    const pairing = {};

    return [
        {
            step: 'both instances reach connected',
            timeoutMs: 30_000,
            runAsync: async () => Object.assign(pairing, await call('pairAsync')),
            verify: verifyPairing,
        },
        {
            step: 'codes carry the expected candidates',
            timeoutMs: 1000,
            runAsync: async () => ({
                offer: `${pairing.offerChars} chars, ${pairing.offerCandidates.join(' ')}`,
                answer: `${pairing.answerChars} chars, ${pairing.answerCandidates.join(' ')}`,
            }),
            verify: () => {
                const kinds = [...pairing.offerCandidates, ...pairing.answerCandidates];
                const isExpected = kinds.length > 0 && kinds.every(kind => scenario.expectedCandidates.includes(kind));
                const expected = scenario.expectedCandidates.join(' or ');

                return isExpected ? undefined : `expected only ${expected}, got ${kinds.join(' ')}`;
            },
        },
        {
            step: 'check codes match',
            timeoutMs: 1000,
            runAsync: () => call('checkCodes'),
            verify: ([offerer, answerer]) => {
                const isMatch = /^[A-Z2-7]{4}$/.test(offerer ?? '') && offerer === answerer;

                return isMatch ? undefined : `${offerer} vs ${answerer}`;
            },
        },
        {
            step: 'control messages both ways, ping and pong kept inside',
            timeoutMs: 10_000,
            runAsync: () => call('controlMessagesAsync'),
            verify: verifyMessages,
        },
        {
            step: `frames on all four slots with backpressure (${BYTES_PER_SLOT / MIB} MiB each)`,
            timeoutMs: 90_000,
            runAsync: () => call('framesAsync', BYTES_PER_SLOT),
            verify: value => verifyFrames(value, pairing.maxFramePayload),
        },
        {
            step: 'oversized frame and JSON throw message-too-large',
            timeoutMs: 2000,
            runAsync: () => call('oversized'),
            verify: codes => (codes.every(code => code === 'message-too-large') ? undefined : `got ${codes.join(', ')}`),
        },
        {
            step: 'close sends bye and the peer closes at once',
            timeoutMs: 10_000,
            runAsync: () => call('closeAsync'),
            verify: verifyClose,
        },
    ];
}

async function printLogAsync(page, count) {
    const lines = await page.evaluate(limit => window.networkCheck.logTail(limit), count).catch(() => []);
    process.stdout.write(`      network log:\n${lines.map(line => `      ${line}`).join('\n')}\n`);
}

async function runScenarioAsync(executablePath, url, scenario) {
    const browser = await chromium.launch({ executablePath, headless: true, args: scenario.browserArguments });
    try {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(url);
        await page.waitForFunction(() => window.networkCheck != null, undefined, { timeout: 10_000 });
        await page.evaluate(useCamera => window.networkCheck.setup(useCamera), scenario.useCamera);

        for (const step of buildSteps(scenario, page)) {
            const isPassed = await runStepAsync({ scenario: scenario.name, ...step });
            if (!isPassed) {
                await printLogAsync(page, LOG_TAIL_LINES);
                break;
            }
        }

        if (IS_LOG_PRINTED) {
            await printLogAsync(page, Number.MAX_SAFE_INTEGER);
        }

        for (const message of pageErrors) {
            report(scenario.name, 'no page errors', false, message);
        }
    } finally {
        await browser.close();
    }
}

async function mainAsync() {
    const executablePath = findBrowser();
    if (executablePath == null) {
        process.stdout.write('FAIL  no Chromium or Chrome found; install one or set CHROME_PATH\n');
        process.exitCode = 1;
        return;
    }

    process.stdout.write(`Browser: ${executablePath}\n`);
    const server = await startServerAsync(await bundlePageAsync());
    const { port } = server.address();
    try {
        for (const scenario of SCENARIOS) {
            const running = runScenarioAsync(executablePath, `http://127.0.0.1:${port}/`, scenario);
            await withTimeoutAsync(running, SCENARIO_TIMEOUT_MS, scenario.name)
                .catch(error => report(scenario.name, 'scenario', false, error.message));
        }
    } finally {
        server.close();
    }

    const failed = results.filter(result => !result.isPassed).length;
    process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
    process.exitCode = failed === 0 ? 0 : 1;
}

await mainAsync();
