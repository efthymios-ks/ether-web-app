// The page side of networkLoopbackCheck.mjs (NW-08, acceptance test 29): two Network instances in one
// page, paired by passing their codes in code. Bundled by esbuild; each step is called from Playwright.
import { createLogger } from '../../src/core/logger.ts';
import { createMemorySink } from '../../src/core/logSinks.ts';
import { addressToBytes } from '../../src/network/address.ts';
import { createNetwork, inspectCode } from '../../src/network/network.ts';
import { decodePairingCode } from '../../src/network/pairingCode.ts';

const KIB = 1024;
const MIB = 1024 * KIB;
const FRAMES_PER_PAGE = 16;
const SLOTS = [1, 2, 3, 4];
const INTERNAL_TYPES = ['ping', 'pong', 'vis', 'bye'];

const TIMEOUTS = Object.freeze({
    gatheringMs: 3000,
    codeExpiryMs: 120_000,
    connectMs: 15_000,
    pingMs: 500,
    weakMs: 6000,
    lostMs: 10_000,
});

const memory = createMemorySink(5000);
const { logger } = createLogger({
    sinks: [memory],
    routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
});

const sides = {};

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAsync(condition, description, timeoutMs = 10_000) {
    const deadline = performance.now() + timeoutMs;
    while (!condition()) {
        if (performance.now() > deadline) {
            throw new Error(`timed out waiting for ${description}`);
        }

        await wait(10);
    }
}

async function exposeLocalIpsAsync() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

        return () => {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        };
    } catch {
        return null;
    }
}

function createSide(name, useCamera) {
    const side = {
        name,
        states: [],
        messages: [],
        errors: [],
        frameSize: 0,
        received: new Map(SLOTS.map(slot => [slot, { bytes: 0, frames: 0, mismatches: 0 }])),
        peakBuffered: new Map(SLOTS.map(slot => [slot, 0])),
    };
    side.network = createNetwork({
        chunkSize: 64 * KIB,
        maxBuffered: 4 * MIB,
        timeouts: TIMEOUTS,
        appUrl: `${location.origin}/`,
        logger: logger.with({ connectionId: name }),
        ...(useCamera ? { exposeLocalIps: exposeLocalIpsAsync } : {}),
    });
    side.network.on('state', state => side.states.push(state));
    side.network.on('message', (channel, message) => side.messages.push({ channel, message }));
    side.network.on('error', error => side.errors.push(error.code));
    side.network.on('frame', (header, payload) => verifyFrame(side, header, payload));

    return side;
}

function fillPayload(slot, index, length) {
    const payload = new Uint8Array(length);
    for (let position = 0; position < length; position++) {
        payload[position] = (slot * 17 + index * 7 + position) & 0xff;
    }

    return payload;
}

function verifyFrame(side, header, payload) {
    const counters = side.received.get(header.slot);
    const index = counters.frames;
    const isHeaderRight = header.page === Math.floor(index / FRAMES_PER_PAGE)
        && header.offset === (index % FRAMES_PER_PAGE) * side.frameSize
        && header.flags === header.slot;
    const expected = fillPayload(header.slot, index, payload.length);
    const isPayloadRight = payload.every((value, position) => value === expected[position]);
    if (!isHeaderRight || !isPayloadRight) {
        counters.mismatches++;
    }

    counters.frames++;
    counters.bytes += payload.length;
}

// Address kinds only: the codes and the local IPs inside them stay out of the output (SP-03).
function describeCandidates(code) {
    return decodePairingCode(code).candidates.map(candidate => addressToBytes(candidate.address)?.kind ?? 'unknown');
}

function errorCodeOf(action) {
    try {
        action();

        return 'sent';
    } catch (error) {
        return error.code ?? String(error);
    }
}

function formatEntry(entry) {
    const time = entry.t.toFixed(0).padStart(6);

    return `${time} ${entry.connectionId ?? '-'} ${entry.cat.padEnd(6)} ${entry.level.padEnd(5)} ${entry.msg}`;
}

window.networkCheck = {
    setup(useCamera) {
        memory.clear();
        sides.offerer = createSide('A', useCamera);
        sides.answerer = createSide('B', useCamera);

        return true;
    },

    async pairAsync() {
        const { offerer, answerer } = sides;
        const offer = await offerer.network.createOfferAsync();
        const answer = await answerer.network.acceptOfferAsync(offer.url);
        await offerer.network.acceptAnswerAsync(answer.code);
        await waitForAsync(() => answerer.network.state === 'connected', 'the answerer to connect');
        const summary = inspectCode(offer.url);

        return {
            offerChars: offer.code.length,
            answerChars: answer.code.length,
            offerCandidates: describeCandidates(offer.code),
            answerCandidates: describeCandidates(answer.code),
            isSummaryRight: summary.kind === 'offer' && summary.code === offer.code && summary.candidateCount > 0,
            offererStates: offerer.states,
            answererStates: answerer.states,
            maxMessageSize: offerer.network.maxMessageSize,
            maxFramePayload: offerer.network.maxFramePayload,
        };
    },

    checkCodes() {
        return [sides.offerer.network.checkCode, sides.answerer.network.checkCode];
    },

    async controlMessagesAsync() {
        const { offerer, answerer } = sides;
        offerer.network.send('control', { t: 'hello', from: 'A' });
        answerer.network.send('control', { t: 'hello', from: 'B' });
        answerer.network.send(3, { t: 'accept', id: '1', fromPage: 0 });
        await waitForAsync(() => offerer.messages.length >= 2 && answerer.messages.length >= 1, 'control messages');
        await waitForAsync(() => offerer.network.health.rttMs != null, 'a pong', 3000);
        const all = [...offerer.messages, ...answerer.messages];

        return {
            offererReceived: offerer.messages,
            answererReceived: answerer.messages,
            internalLeaked: all.filter(entry => INTERNAL_TYPES.includes(entry.message.t)),
            rttMs: offerer.network.health.rttMs,
            health: offerer.network.health.status,
        };
    },

    async framesAsync(bytesPerSlot) {
        const { offerer, answerer } = sides;
        const frameSize = offerer.network.maxFramePayload;
        answerer.frameSize = frameSize;
        const started = performance.now();

        const sendSlotAsync = async slot => {
            for (let index = 0, sent = 0; sent < bytesPerSlot; index++) {
                const length = Math.min(frameSize, bytesPerSlot - sent);
                const header = {
                    slot,
                    page: Math.floor(index / FRAMES_PER_PAGE),
                    offset: (index % FRAMES_PER_PAGE) * frameSize,
                    flags: slot,
                };
                offerer.network.sendFrame(header, fillPayload(slot, index, length));
                sent += length;
                const buffered = offerer.network.bufferedAmount(slot);
                offerer.peakBuffered.set(slot, Math.max(offerer.peakBuffered.get(slot), buffered));
                await offerer.network.waitDrainedAsync(slot);
            }
        };

        await Promise.all(SLOTS.map(slot => sendSlotAsync(slot)));
        await waitForAsync(
            () => SLOTS.every(slot => answerer.received.get(slot).bytes >= bytesPerSlot),
            'every frame to arrive',
            60_000,
        );
        const seconds = (performance.now() - started) / 1000;

        return {
            frameSize,
            seconds: Math.round(seconds * 100) / 100,
            mibPerSecond: Math.round((bytesPerSlot * SLOTS.length) / MIB / seconds),
            received: SLOTS.map(slot => ({ slot, ...answerer.received.get(slot) })),
            peakBuffered: SLOTS.map(slot => offerer.peakBuffered.get(slot)),
        };
    },

    oversized() {
        const { network } = sides.offerer;
        const header = { slot: 1, page: 0, offset: 0, flags: 0 };

        return [
            errorCodeOf(() => network.sendFrame(header, new Uint8Array(network.maxFramePayload + 1))),
            errorCodeOf(() => network.send('control', { t: 'big', data: 'x'.repeat(64 * KIB) })),
        ];
    },

    async closeAsync() {
        const { offerer, answerer } = sides;
        const started = performance.now();
        offerer.network.close('check finished');
        await waitForAsync(() => ['closed', 'lost'].includes(answerer.network.state), 'the answerer to close', 5000);

        return {
            offererState: offerer.network.state,
            answererState: answerer.network.state,
            reactionMs: Math.round(performance.now() - started),
            byeReceived: memory.entries().some(entry => entry.connectionId === 'B' && entry.msg === 'bye received'),
            sendAfterClose: errorCodeOf(() => offerer.network.send('control', { t: 'hello' })),
            errors: [...offerer.errors, ...answerer.errors],
        };
    },

    logTail(count) {
        return memory.entries()
            .slice(-count)
            .map(formatEntry);
    },
};
