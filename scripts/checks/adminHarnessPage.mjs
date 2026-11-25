// The Settings sheet and the log viewer on a fake client with sample logs, for screenshots in a real browser.
// Query: ?theme=system|light|dark, ?open=settings,viewer, ?scenario=connected|failed, ?live=1.
import { createDialogs } from '../../src/app/dialogs.js';
import { createLogViewer } from '../../src/app/logViewer/logViewer.js';
import { createSettingsSheet } from '../../src/app/settings/settingsSheet.js';
import { createThemeController } from '../../src/app/shell/themeController.js';
import {
    createFakeAdminClient,
    createFakeDatabaseSink,
    createFakeDeviceInfo,
    createSampleDiagnostics,
    createSampleLogEntries,
    createSampleSession,
    SAMPLE_PEER,
} from '../../src/app/testing/adminFakes.js';
import { createLogger } from '../../src/core/logger.js';
import { createMemorySink } from '../../src/core/logSinks.js';

const MIB = 1024 * 1024;
const params = new URLSearchParams(location.search);
const opened = (params.get('open') ?? 'settings,viewer').split(',');
const scenario = params.get('scenario') ?? 'connected';
const start = Date.UTC(2026, 10, 23, 13, 2, 0);

// The harness keeps its theme choice in memory, so it never touches the app's stored one.
const themeChoices = new Map();
const theme = createThemeController({
    storage: { getItem: key => themeChoices.get(key) ?? null, setItem: (key, value) => themeChoices.set(key, value) },
});
theme.setPreference(params.get('theme') ?? 'light');

function failedHandshake() {
    const lines = [
        [0, 'pair', 'info', 'camera permission: denied (.local names only)'],
        [11, 'pair', 'info', 'offer created, gathering…'],
        [180, 'ice', 'debug', 'local host udp 3f2a9c1e-77b0-4c1d-9a51-2b7f0e3d8c44.local:52344'],
        [302, 'pair', 'info', 'gathering 291 ms'],
        [303, 'pair', 'info', 'code 70 B → 112 chars, QR v5'],
        [8120, 'pair', 'info', 'answer applied; remote host 8b11d0a2-5e1f-4b7e-a0f9-3c2d1e4f5a6b.local:60111'],
        [8130, 'ice', 'info', 'iceConnectionState checking'],
        [8150, 'pairs', 'info', '3f2a….local:52344 ↔ 8b11….local:60111 in-progress'],
        [23130, 'ice', 'warn', 'iceConnectionState failed'],
        [23131, 'pair', 'error', 'connect timeout after 15 s'],
    ];

    return lines.map(([t, cat, level, msg]) => ({ t, wall: start + t, cat, level, msg }));
}

const entries = scenario === 'failed'
    ? failedHandshake()
    : createSampleLogEntries({ startWall: start, pageBurst: 87, peerName: SAMPLE_PEER.deviceId });
const memorySink = createMemorySink(5000);
const loggerController = createLogger({
    sinks: [memorySink],
    routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
});
for (const entry of entries) {
    memorySink.write(entry);
}

const isConnected = scenario !== 'failed';
const client = createFakeAdminClient({
    settings: { debugLogging: true, peerLogs: true, logSinks: ['memory', 'indexeddb'], categoryLevels: { ice: 'debug' } },
    state: isConnected ? 'connected' : 'idle',
    ...(isConnected ? { peer: SAMPLE_PEER } : {}),
    diagnostics: isConnected ? createSampleDiagnostics() : { state: 'idle', pairs: [], slots: [] },
    sessionOverrides: { pageSize: 2 * MIB },
    sessions: [
        createSampleSession({ connected: isConnected }),
        createSampleSession({ sessionId: 'session-2', peerName: 'Office Mac', unfinishedCount: 0, lastConnectedAt: start - 86_400_000 * 3 }),
    ],
});

const appHost = document.querySelector('[data-role="harness-app"]');
const viewerHost = document.createElement('div');
document.body.append(viewerHost);
const dialogs = createDialogs(document.body);

const logViewer = createLogViewer({
    container: viewerHost,
    client,
    memorySink,
    databaseSink: createFakeDatabaseSink([
        { t: 0, wall: start - 600_000, level: 'info', cat: 'app', msg: 'started' },
        { t: 9_100, wall: start - 590_900, level: 'error', cat: 'store', msg: 'QuotaExceededError while writing page 812' },
    ]),
    deviceInfo: createFakeDeviceInfo(),
    buildVersion: '0.1.0+a2d6bc91',
    logger: loggerController.logger,
});
const settingsSheet = createSettingsSheet({
    client,
    dialogs,
    theme,
    logger: loggerController.logger,
    buildVersion: '0.1.0+a2d6bc91',
    clearSavedLogsAsync: async () => undefined,
});

appHost?.querySelector('[data-role="settings"]')?.addEventListener('click', () => settingsSheet.open());
appHost?.querySelector('[data-role="logs"]')?.addEventListener('click', () => logViewer.toggle());

if (opened.includes('viewer')) {
    logViewer.open();
}

if (opened.includes('settings')) {
    settingsSheet.open();
}

if (params.get('live') === '1') {
    let page = 1400;
    setInterval(() => {
        const t = performance.now();
        loggerController.logger.with({ fileId: 'f1c2a9e07b3d4411', page }).debug('xfer', `IMG_2231.MOV page ${page}/2048 ack 11 ms buf 2.4 MiB`);
        page++;
        if (page % 20 === 0) {
            loggerController.logger.info('xfer', `IMG_2231.MOV ${page}/2048 (${((page / 2048) * 100).toFixed(1)}%) 28.0 MiB/s`, { t });
        }
    }, 25);
}

globalThis.harness = { settingsSheet, logViewer, client, theme, loggerController, memorySink };
