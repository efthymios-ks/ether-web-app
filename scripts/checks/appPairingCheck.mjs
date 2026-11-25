// End-to-end check of the built app in real Chromium: two isolated browser contexts (two devices,
// each with its own storage) open Home with the sidebar beside the pane, which offers Pair with a code, then pair
// through it alone: Show my code and Copy code on one, Paste a code and Copy code on the other,
// Paste reply on the first, with no code shown as text; the copied text is a bare Base32 code; the check codes
// match; one sends a file, the other accepts it (Ask before receiving is on by default), selects it in Received,
// taps Download ZIP (1) and gets a ZIP that holds exactly the same bytes; a dark system starts dark.
//
//   npm run check:app            builds first, then runs
//   node scripts/checks/appPairingCheck.mjs --no-build
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP_TIMEOUT_MS = 30_000;
const FILE_SIZE = 3 * 1024 * 1024 + 123;

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

async function startServerAsync(port) {
    const server = spawn(process.execPath, [join(ROOT_DIRECTORY, 'scripts', 'serve.mjs'), '--port', String(port), '--host', '127.0.0.1'], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
        server.stdout.on('data', chunk => {
            if (String(chunk).includes('Serving dist')) {
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

async function stepAsync(name, runAsync) {
    try {
        const detail = await withTimeoutAsync(runAsync(), STEP_TIMEOUT_MS, name);
        results.push({ name, isPassed: true });
        process.stdout.write(`PASS  ${name}${detail ? ` — ${detail}` : ''}\n`);

        return detail;
    } catch (error) {
        results.push({ name, isPassed: false });
        process.stdout.write(`FAIL  ${name} — ${error.message}\n`);
        throw error;
    }
}

async function openDeviceAsync(browser, url, colorScheme = 'light') {
    const context = await browser.newContext({ colorScheme, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);

    return { context, page, errors };
}

// A code is Base32 (A–Z, 2–7) and carries a version, keys and addresses, so it is never short.
const CODE_SHAPE = /^[A-Z2-7]{40,400}$/;

// Copies the bare code under this device's QR (kind "offer") or the reply's (kind "reply").
async function copyCodeAsync(page, kind) {
    const button = page.locator(`.qr-figure[data-kind="${kind}"] [data-action="copy-code"]`).first();
    const label = (await button.innerText()).trim();
    if (label !== 'Copy code') {
        throw new Error(`the copy button reads "${label}"`);
    }

    await button.click();
    await page.locator(`.qr-figure[data-kind="${kind}"] [data-action="copy-code"][data-state="copied"]`).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (!CODE_SHAPE.test(copied)) {
        throw new Error(`the clipboard holds no bare ${kind} code (${copied.slice(0, 40)}…, ${copied.length} characters)`);
    }

    const isShownAsText = await page.evaluate(code => document.body.innerText.replace(/\s+/g, '').includes(code), copied);
    if (isShownAsText || (await page.locator('textarea, .pairing-code').count()) > 0) {
        throw new Error('the code is shown as text, or a code box is on the page');
    }

    return copied;
}

async function pasteCodeAsync(page, screen, code) {
    await page.evaluate(text => navigator.clipboard.writeText(text), code);
    await page.locator(`.pairing-screen[data-screen="${screen}"] [data-action="paste-code"]`).first().click();
}

async function stepTextAsync(page, screen) {
    const step = page.locator(`.pairing-screen[data-screen="${screen}"] .pairing-header .pairing-step`);

    return (await step.innerText()).trim();
}

// Reads a store-only ZIP (ZIP64 included) and returns its entries as { name, data }.
function readZipEntries(buffer) {
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) {
        throw new Error('no end of central directory');
    }

    let count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    if (offset === 0xffffffff || count === 0xffff) {
        const zip64End = Number(buffer.readBigUInt64LE(end - 20 + 8));
        count = Number(buffer.readBigUInt64LE(zip64End + 32));
        offset = Number(buffer.readBigUInt64LE(zip64End + 48));
    }

    const entries = [];
    for (let index = 0, pointer = offset; index < count; index++) {
        if (buffer.readUInt32LE(pointer) !== 0x02014b50) {
            throw new Error('bad central directory entry');
        }

        const method = buffer.readUInt16LE(pointer + 10);
        let size = buffer.readUInt32LE(pointer + 20);
        const nameLength = buffer.readUInt16LE(pointer + 28);
        const extraLength = buffer.readUInt16LE(pointer + 30);
        const commentLength = buffer.readUInt16LE(pointer + 32);
        let localOffset = buffer.readUInt32LE(pointer + 42);
        const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
        const extra = buffer.subarray(pointer + 46 + nameLength, pointer + 46 + nameLength + extraLength);
        for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) {
            if (extra.readUInt16LE(at) !== 0x0001) {
                continue;
            }

            let field = at + 4;
            if (buffer.readUInt32LE(pointer + 24) === 0xffffffff) {
                field += 8;
            }

            if (size === 0xffffffff) {
                size = Number(extra.readBigUInt64LE(field));
                field += 8;
            }

            if (localOffset === 0xffffffff) {
                localOffset = Number(extra.readBigUInt64LE(field));
            }
        }

        if (method !== 0) {
            throw new Error(`${name} is compressed (method ${method}); Ether writes store-only ZIPs`);
        }

        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        entries.push({ name, data: buffer.subarray(dataStart, dataStart + size) });
        pointer += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

async function mainAsync() {
    if (!process.argv.includes('--no-build')) {
        const build = spawnSync(process.execPath, [join(ROOT_DIRECTORY, 'scripts', 'build.mjs')], { stdio: 'inherit' });
        if (build.status !== 0) {
            throw new Error('build failed');
        }
    }

    const executablePath = findBrowser();
    if (!executablePath) {
        throw new Error('No Chromium found; set CHROME_PATH.');
    }

    const port = await findFreePortAsync();
    const server = await startServerAsync(port);
    const url = `http://127.0.0.1:${port}/`;
    const browser = await chromium.launch({ executablePath, headless: true });

    try {
        const first = await openDeviceAsync(browser, url);
        const second = await openDeviceAsync(browser, url);

        const homeStep = 'both devices open Home at 1280 px: the header, who they are, and the sidebar beside a pane '
            + 'with Pair with a code';
        await stepAsync(homeStep, async () => {
            for (const device of [first, second]) {
                await device.page.locator('[data-screen="home"]').first().waitFor();
                const layout = await device.page.evaluate(() => {
                    // On screen, inside the window.
                    const isShown = selector => {
                        const box = document.querySelector(selector)?.getBoundingClientRect();

                        return box != null && box.width > 0 && box.left >= 0 && box.right <= window.innerWidth;
                    };

                    return {
                        split: document.querySelector('[data-role="app"]')?.dataset.split,
                        header: ['[data-role="home"]', '[data-role="history-toggle"]', '[data-role="settings"]']
                            .every(isShown),
                        side: isShown('.home-panel'),
                        identity: isShown('.me [data-action="rename"]'),
                        pane: isShown('.home-pane [data-action="show-code"]'),
                        link: isShown('[data-action="pair-with-code"]'),
                        actionBar: document.querySelector('.action-bar') != null,
                        pill: document.querySelector('.peer-pill') != null,
                    };
                });
                const expected = {
                    split: 'true',
                    header: true,
                    side: true,
                    identity: true,
                    pane: true,
                    link: false,
                    actionBar: false,
                    pill: false,
                };
                if (JSON.stringify(layout) !== JSON.stringify(expected)) {
                    throw new Error(JSON.stringify(layout));
                }
            }
        });

        // Codes carry local addresses (SP-03), so steps report their length only.
        let offer = '';
        await stepAsync('device A shows its code (Step 1 of 2) and Copy code copies the bare code', async () => {
            await first.page.locator('.home-pane [data-action="show-code"]').click();
            await first.page.locator('[data-screen="offer"] .qr-figure[data-kind="offer"] .qr-code svg').waitFor();
            const step = await stepTextAsync(first.page, 'offer');
            if (step !== 'Step 1 of 2') {
                throw new Error(`the step reads "${step}"`);
            }

            offer = await copyCodeAsync(first.page, 'offer');

            return `${offer.length} characters`;
        });

        let reply = '';
        await stepAsync('device B pastes the code and shows its reply (Step 2 of 2)', async () => {
            await pasteCodeAsync(second.page, 'home', offer);
            await second.page.locator('[data-screen="answer"] .qr-figure[data-kind="reply"] .qr-code svg').waitFor();
            const step = await stepTextAsync(second.page, 'answer');
            if (step !== 'Step 2 of 2') {
                throw new Error(`the step reads "${step}"`);
            }

            reply = await copyCodeAsync(second.page, 'reply');
            if (reply === offer) {
                throw new Error('the reply is the offer');
            }

            return `${reply.length} characters`;
        });

        await stepAsync('device A pastes the reply and both connect with the same check code', async () => {
            await pasteCodeAsync(first.page, 'offer', reply);
            const firstCode = first.page.locator('.check-code-value').first();
            const secondCode = second.page.locator('.check-code-value').first();
            await firstCode.waitFor();
            await secondCode.waitFor();
            const codes = [await firstCode.innerText(), await secondCode.innerText()];
            if (codes[0] !== codes[1] || !/^[A-Z2-7]{4}$/.test(codes[0])) {
                throw new Error(`check codes differ: ${codes.join(' vs ')}`);
            }

            return codes[0];
        });

        const sendStep = `A sends a ${FILE_SIZE} byte file; B accepts it, selects it in Received `
            + 'and Download ZIP (1) holds the same bytes';
        await stepAsync(sendStep, async () => {
            const content = randomBytes(FILE_SIZE);
            await first.page.locator('input[data-picker="files"]').setInputFiles({
                name: 'ether-check.bin',
                mimeType: 'application/octet-stream',
                buffer: content,
            });
            // Ask before receiving is on by default (SP-07), so B accepts first in the receive dialog: its primary
            // button is Accept, or Accept all when a batch is bigger than the free space.
            await second.page.locator('[role="dialog"][data-prompt="receive"] .button-primary').first()
                .click({ timeout: STEP_TIMEOUT_MS });
            // Nothing downloads by itself: B picks the file in Received and taps Download ZIP (1).
            const received = second.page.locator('#panel-received');
            await second.page.locator('[data-tab="received"]').click();
            // Received lists files while they arrive too; this one is ready once it is Not downloaded yet,
            // the plain end that the row leaves unsaid and names only for screen readers.
            await received.locator('.file-row[data-state="done"]', { hasText: 'ether-check.bin' })
                .locator('.file-open[aria-label*="Not downloaded yet"]')
                .waitFor({ timeout: STEP_TIMEOUT_MS });
            await received.locator('[data-action="select"]').click();
            await received.locator('.file-row', { hasText: 'ether-check.bin' }).locator('.file-check-box').check();
            const zipButton = received.locator('.selection-bar [data-action="download-zip"]');
            // "ZIP (1)" on screen, "Download ZIP (1)" for screen readers.
            const zipLabel = ((await zipButton.textContent()) ?? '').trim();
            if (zipLabel !== 'Download ZIP (1)') {
                throw new Error(`the selection bar reads "${zipLabel}"`);
            }

            const download = second.page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS });
            await zipButton.click();
            const zip = await download;
            if (!zip.suggestedFilename().endsWith('.zip')) {
                throw new Error(`downloaded ${zip.suggestedFilename()}, not a ZIP`);
            }

            const path = join(tmpdir(), `ether-check-${Date.now()}.zip`);
            await zip.saveAs(path);
            const entries = readZipEntries(await readFile(path));
            const entry = entries.find(item => item.name.endsWith('ether-check.bin'));
            if (!entry) {
                throw new Error(`the ZIP holds ${entries.map(item => item.name).join(', ') || 'nothing'}`);
            }

            const expected = createHash('sha256').update(content).digest('hex');
            const actual = createHash('sha256').update(entry.data).digest('hex');
            if (actual !== expected) {
                throw new Error(`ether-check.bin in the ZIP has sha256 ${actual.slice(0, 12)}, expected ${expected.slice(0, 12)}`);
            }

            return `${zip.suggestedFilename()} holds ${entry.name}, sha256 ${actual.slice(0, 12)}…`;
        });

        await stepAsync('no page errors on either device', async () => {
            const errors = [...first.errors, ...second.errors];
            if (errors.length > 0) {
                throw new Error(errors.join(' | '));
            }
        });

        await first.context.close();
        await second.context.close();

        await stepAsync('a dark system starts dark, with the pending flag cleared', async () => {
            const dark = await openDeviceAsync(browser, url, 'dark');
            await dark.page.locator('[data-screen="home"]').first().waitFor();
            const state = await dark.page.evaluate(() => ({
                theme: document.documentElement.dataset.theme,
                isPending: document.documentElement.hasAttribute('data-theme-pending'),
            }));
            await dark.context.close();
            if (state.theme !== 'dark' || state.isPending) {
                throw new Error(JSON.stringify(state));
            }

            return 'data-theme="dark"';
        });
    } finally {
        await browser.close();
        server.kill();
    }
}

try {
    await mainAsync();
} catch {
    // Reported by the failing step, or below when nothing ran.
}

const failed = results.filter(result => !result.isPassed).length;
const passed = results.length - failed;
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 && passed > 0 ? 0 : 1);
