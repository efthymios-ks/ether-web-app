// The page side of nearbyCheck.mjs: one real nearby discovery (real STUN pool, real relays) per page,
// driven from Playwright. Bundled by esbuild and served with the app's Content Security Policy.
import { createLogger } from '../../src/core/logger.ts';
import { createMemorySink } from '../../src/core/logSinks.ts';
import { createBrowserDiscovery } from '../../src/discovery/browserDiscovery.ts';

const memory = createMemorySink(5000);
const { logger } = createLogger({
    sinks: [memory],
    routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
});

const state = {
    discovery: undefined,
    statuses: [],
    requests: [],
    ended: [],
    notices: [],
    controller: undefined,
    pending: undefined,
};

function findDevice(name) {
    const device = state.discovery?.devices().find(candidate => candidate.name === name);
    if (device == null) {
        throw new Error(`${name} is not in the list`);
    }

    return device;
}

window.nearbyCheck = {
    start(name) {
        state.discovery = createBrowserDiscovery({ logger });
        state.discovery.on('status', status => state.statuses.push(status));
        state.discovery.on('request', request => state.requests.push(request));
        state.discovery.on('request-ended', requestId => state.ended.push(requestId));
        state.discovery.on('relay-allowance', notice => state.notices.push(notice ?? null));
        state.discovery.start({ name, deviceType: 'desktop' });
    },
    // Sets or removes this page's PIN while discovery runs, as a settings change does in the app.
    setPin(name, pin) {
        state.discovery.start({ name, deviceType: 'desktop', ...(pin == null ? {} : { pin }) });
    },
    snapshot() {
        return {
            status: state.discovery?.status() ?? 'off',
            statuses: state.statuses,
            devices: state.discovery?.devices().map(device => device.name) ?? [],
            rows: state.discovery?.devices().map(device => ({
                name: device.name,
                nearbyId: device.nearbyId,
                hasPin: device.hasPin === true,
            })) ?? [],
            isHidden: document.visibilityState === 'hidden',
            requests: state.requests.map(request => ({
                requestId: request.requestId,
                from: request.from.name,
                offerCode: request.offerCode,
                expiresInS: Math.round((request.expiresAt - Date.now()) / 1000),
                isPinVerified: request.isPinVerified,
            })),
            ended: state.ended,
            notices: state.notices,
        };
    },
    // Which relays connected and which STUN servers answered, from the log; never the address itself.
    connections() {
        const messages = memory.entries().map(entry => entry.msg);

        return {
            relays: [...new Set(messages
                .map(message => /^relay (\S+) connected$/.exec(message)?.[1])
                .filter(url => url != null))],
            stun: messages.find(message => message.startsWith('public address from')) ?? 'no STUN answer',
        };
    },
    async requestAsync(name, offerCode, pin) {
        const options = pin == null ? {} : { pin };

        return state.discovery.requestPairingAsync(findDevice(name).nearbyId, offerCode, options);
    },
    beginRequest(name, offerCode) {
        state.controller = new AbortController();
        state.pending = state.discovery.requestPairingAsync(findDevice(name).nearbyId, offerCode, {
            signal: state.controller.signal,
        });
    },
    async abortRequestAsync() {
        state.controller?.abort();

        return state.pending;
    },
    async acceptAsync(requestId, answerCode) {
        await state.discovery.acceptAsync(requestId, answerCode);
    },
    async declineAsync(requestId) {
        await state.discovery.declineAsync(requestId);
    },
    stop() {
        state.discovery?.stop();
    },
    logTail(count) {
        return memory.entries().slice(-count).map(entry => `${entry.t.toFixed(0)} ${entry.level} ${entry.msg}`);
    },
};
