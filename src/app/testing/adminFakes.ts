// Fakes for the Settings sheet, log viewer and PWA tests, and for the browser harness in scripts/checks.
import type {
    Client,
    ClientEvents,
    ConnectionState,
    Diagnostics,
    Peer,
    SessionSummary,
    StorageInfo,
    TestTool,
    TransferSettings,
} from '../../client/clientTypes.js';
import { createEmitter } from '../../core/events.js';
import type { Capabilities, DeviceInfo } from '../../core/deviceInfo.js';
import type { DatabaseSink } from '../../core/logDatabaseSink.js';
import type { LogCategory, LogEntry, LogLevel } from '../../core/logger.js';
import { createDefaultSettings, normalizeSettings } from '../../core/settings.js';
import type { Settings } from '../../core/settings.js';
import { createPlatform } from '../../platform/createPlatform.js';
import type { InstallMethod, Platform, PlatformKind } from '../../platform/platform.js';

export const ALL_CAPABILITIES: Capabilities = Object.freeze({
    webrtc: true,
    wakeLock: true,
    shareFiles: true,
    barcodeDetector: false,
    webLocks: true,
    persistentStorage: true,
    opfsWritable: false,
    camera: true,
    broadcastChannel: true,
    indexedDb: true,
    directoryPicker: false,
    folderInput: true,
});

export function createFakeDeviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
    return {
        os: 'iOS',
        osVersion: '18.4',
        deviceType: 'phone',
        model: 'iPhone',
        browser: 'Safari',
        browserVersion: '18.4',
        engine: 'WebKit',
        displayMode: 'browser',
        installed: false,
        inAppBrowser: false,
        touch: true,
        capabilities: ALL_CAPABILITIES,
        label: 'iPhone · Safari',
        ...overrides,
    };
}

export interface FakePlatformOptions {
    readonly kind?: PlatformKind;
    readonly info?: DeviceInfo;
    readonly installMethod?: InstallMethod;
    readonly installSteps?: readonly string[];
    readonly settingDefaults?: Partial<Settings>;
}

// The real platform for the device, with the parts the log viewer and installer read made predictable.
export function createFakePlatform(options: FakePlatformOptions = {}): Platform {
    const info = options.info ?? createFakeDeviceInfo();
    const real = createPlatform(info);
    const overrides: Partial<Platform> = {
        info,
        ...(options.kind == null ? {} : { kind: options.kind }),
        installMethod: () => options.installMethod ?? 'instructions',
        installSteps: () => options.installSteps ?? ['Tap the Share button in Safari.', 'Tap Add to Home Screen.'],
        settingDefaults: () => ({
            ...(options.settingDefaults ?? { deviceName: 'iPhone · Blue Otter' }),
        }),
    };

    return Object.assign(Object.create(real) as Platform, overrides);
}

export interface FakeClientCalls {
    readonly configure: Array<Partial<Settings>>;
    readonly configureSession: Array<Partial<TransferSettings>>;
    readonly rename: string[];
    readonly peerLogs: boolean[];
    readonly testTools: Array<[TestTool, boolean]>;
    readonly clearedSessions: string[];
    clearAllCount: number;
    dropConnectionCount: number;
    diagnosticsCount: number;
}

export interface FakeAdminClient extends Client {
    readonly calls: FakeClientCalls;
    emit<Name extends keyof ClientEvents>(name: Name, ...args: Parameters<ClientEvents[Name]>): void;
    setConnection(state: ConnectionState, peer?: Peer): void;
    setDiagnostics(diagnostics: Diagnostics): void;
    setSessions(sessions: SessionSummary[]): void;
}

export interface FakeAdminClientOptions {
    readonly settings?: Partial<Settings>;
    readonly state?: ConnectionState;
    readonly peer?: Peer;
    readonly sessions?: SessionSummary[];
    readonly storage?: StorageInfo;
    readonly diagnostics?: Diagnostics;
    readonly sessionOverrides?: Partial<TransferSettings>;
    // Makes configureAsync reject, to test error handling.
    readonly failConfigure?: boolean;
}

export const SAMPLE_PEER: Peer = Object.freeze({
    deviceId: 'peer-device-8f2c',
    name: 'Pixel 8',
    displayName: 'Pixel 8',
    sessionId: 'session-1',
    connectionId: 'connection-1',
    checkCode: 'K7QX',
    protocol: 1,
});

export function createSampleSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        sessionId: 'session-1',
        peerDeviceId: SAMPLE_PEER.deviceId,
        peerName: 'Pixel 8',
        createdAt: Date.UTC(2026, 10, 1, 9),
        lastConnectedAt: Date.UTC(2026, 10, 23, 12),
        connections: [],
        totals: { filesSent: 3, bytesSent: 12_000_000, filesReceived: 5, bytesReceived: 40_000_000 },
        unfinishedCount: 1,
        connected: false,
        ...overrides,
    };
}

export function createFakeAdminClient(options: FakeAdminClientOptions = {}): FakeAdminClient {
    const emitter = createEmitter<ClientEvents>();
    let settings = createDefaultSettings({ deviceName: 'iPhone · Blue Otter', ...options.settings });
    let state: ConnectionState = options.state ?? 'idle';
    let peer = options.peer;
    let sessions = options.sessions ?? [createSampleSession()];
    let diagnostics: Diagnostics = options.diagnostics ?? { state, pairs: [], slots: [] };
    let overrides: Partial<TransferSettings> = { ...options.sessionOverrides };
    let activeTestTools: TestTool[] = [];
    const calls: FakeClientCalls = {
        configure: [],
        configureSession: [],
        rename: [],
        peerLogs: [],
        testTools: [],
        clearedSessions: [],
        clearAllCount: 0,
        dropConnectionCount: 0,
        diagnosticsCount: 0,
    };
    const notFaked = (name: string) => async (): Promise<never> => {
        throw new Error(`${name} is not faked`);
    };

    const applySettings = (changes: Partial<Settings>): Settings => {
        settings = normalizeSettings({ ...settings, ...changes }).settings;
        emitter.emit('settings', settings);

        return settings;
    };

    return {
        calls,
        deviceId: 'this-device-1a2b',
        get settings() {
            return settings;
        },
        get state() {
            return state;
        },
        get peer() {
            return peer;
        },
        get activeTestTools() {
            return activeTestTools;
        },
        emit: (name, ...args) => emitter.emit(name, ...args),
        setConnection: (next, nextPeer) => {
            state = next;
            peer = nextPeer;
            emitter.emit('state', next);
        },
        setDiagnostics: next => {
            diagnostics = next;
        },
        setSessions: next => {
            sessions = next;
        },
        inspectCode: () => undefined,
        startPairingAsync: notFaked('startPairingAsync'),
        joinWithCodeAsync: notFaked('joinWithCodeAsync'),
        completePairingAsync: notFaked('completePairingAsync'),
        cancelPairing: () => undefined,
        disconnectAsync: async () => undefined,
        renameAsync: async name => {
            calls.rename.push(name);
            applySettings({ deviceName: name });
        },
        sendFilesAsync: notFaked('sendFilesAsync'),
        pauseAsync: notFaked('pauseAsync'),
        resumeAsync: notFaked('resumeAsync'),
        cancelAsync: notFaked('cancelAsync'),
        cancelBatchAsync: notFaked('cancelBatchAsync'),
        stopBatchAsync: notFaked('stopBatchAsync'),
        resumeBatchAsync: notFaked('resumeBatchAsync'),
        resumeWithFilesAsync: notFaked('resumeWithFilesAsync'),
        sendAgainAsync: notFaked('sendAgainAsync'),
        retryFailedAsync: notFaked('retryFailedAsync'),
        listUnfinishedElsewhereAsync: async () => [],
        sendUnfinishedHereAsync: notFaked('sendUnfinishedHereAsync'),
        acceptIncomingAsync: notFaked('acceptIncomingAsync'),
        rejectIncomingAsync: notFaked('rejectIncomingAsync'),
        acceptBatchAsync: notFaked('acceptBatchAsync'),
        declineBatchAsync: notFaked('declineBatchAsync'),
        getReceivedFileAsync: notFaked('getReceivedFileAsync'),
        getThumbnailAsync: async () => undefined,
        buildZipAsync: notFaked('buildZipAsync'),
        markSavedAsync: notFaked('markSavedAsync'),
        computeSha256Async: notFaked('computeSha256Async'),
        deleteReceivedAsync: notFaked('deleteReceivedAsync'),
        deleteReceivedManyAsync: notFaked('deleteReceivedManyAsync'),
        deletePartialAsync: notFaked('deletePartialAsync'),
        listSessionsAsync: async () => sessions,
        getSessionAsync: async sessionId => {
            const session = sessions.find(item => item.sessionId === sessionId);

            return session == null ? undefined : { ...session, transferSettings: overrides };
        },
        listFilesAsync: async () => [],
        listBatchesAsync: async () => [],
        listGalleryAsync: async () => [],
        clearSessionAsync: async sessionId => {
            calls.clearedSessions.push(sessionId);
            sessions = sessions.filter(item => item.sessionId !== sessionId);
        },
        getClearSummaryAsync: async () => ({ finished: 0, unfinished: 0, notDownloaded: 0, bytes: 0 }),
        clearSessionFilesAsync: async () => ({ removed: 0 }),
        clearAllAsync: async () => {
            calls.clearAllCount++;
            sessions = [];
        },
        restoreSessionAsync: async () => undefined,
        startFreshAsync: async () => ({ removed: 0, isPeerNotified: false }),
        configureAsync: async changes => {
            calls.configure.push(changes);
            if (options.failConfigure === true) {
                throw new Error('configure failed');
            }

            return applySettings(changes);
        },
        configureSessionAsync: async changes => {
            calls.configureSession.push(changes);
            overrides = { ...overrides, ...changes };
        },
        getDiagnosticsAsync: async () => {
            calls.diagnosticsCount++;

            return diagnostics;
        },
        getStorageInfoAsync: async () => options.storage ?? {
            usedBytes: 1_250_000_000,
            quotaBytes: 64_000_000_000,
            freeBytes: 62_750_000_000,
            persisted: true,
        },
        setPeerLogs: isOn => {
            calls.peerLogs.push(isOn);
        },
        setTestTool: (tool, isOn) => {
            calls.testTools.push([tool, isOn]);
            activeTestTools = isOn
                ? [...activeTestTools.filter(item => item !== tool), tool]
                : activeTestTools.filter(item => item !== tool);
            emitter.emit('test-tools', activeTestTools);
        },
        dropConnectionForTest: () => {
            calls.dropConnectionCount++;
        },
        on: (name, handler) => emitter.on(name, handler),
        dispose: () => emitter.clear(),
    };
}

export function createFakeDatabaseSink(previousRun: LogEntry[] = []): DatabaseSink {
    return {
        name: 'indexeddb',
        write: () => undefined,
        flushAsync: async () => undefined,
        readPreviousRunAsync: async () => previousRun,
        clearAsync: async () => undefined,
        setLimit: () => undefined,
    };
}

export interface SampleEntryOptions {
    // Epoch milliseconds of the first entry.
    readonly startWall?: number;
    readonly peerName?: string;
    // Adds one busy second of page lines (DL-09).
    readonly pageBurst?: number;
}

type EntryShape = [number, LogCategory, LogLevel, string, unknown?, Partial<LogEntry>?];

// The §16.7 example, as entries: a camera-allowed handshake, a resumed file, page lines and summaries.
export function createSampleLogEntries(options: SampleEntryOptions = {}): LogEntry[] {
    const startWall = options.startWall ?? Date.UTC(2026, 10, 23, 13, 2, 0);
    const file = { fileId: 'f1c2a9e07b3d4411', sessionId: 'session-1', connectionId: 'connection-1' };
    const shapes: EntryShape[] = [
        [0, 'pair', 'info', 'camera permission: granted (real local IPs exposed)'],
        [12, 'pair', 'info', 'offer created, gathering…'],
        [214, 'ice', 'debug', 'local host udp 192.168.1.23:52344', { type: 'host', protocol: 'udp', address: '192.168.1.23', port: 52344 }],
        [216, 'ice', 'debug', 'local host udp 10.84.2.7:61021'],
        [301, 'pair', 'info', 'gathering 289 ms', { durationMs: 289, candidates: 2 }],
        [302, 'pair', 'info', 'code 86 B → 138 chars, QR v6', { bytes: 86, chars: 138, version: 6 }],
        [9880, 'pair', 'info', 'answer applied; remote host 192.168.1.41:60111, host 3f2a9c1e-77b0-4c1d-9a51-2b7f0e3d8c44.local:60111'],
        [9890, 'ice', 'info', 'iceConnectionState checking'],
        [9902, 'pairs', 'info', '192.168.1.23:52344 ↔ 192.168.1.41:60111 in-progress'],
        [9951, 'pairs', 'info', '192.168.1.23:52344 ↔ 192.168.1.41:60111 succeeded, nominated, rtt 4 ms'],
        [9960, 'ice', 'info', 'iceConnectionState connected'],
        [10010, 'dtls', 'info', 'connected; fingerprint ok; sctp maxMessageSize 262144', { fingerprint: '9C:1F:3A:77…' }],
        [10020, 'dtls', 'info', 'channels open: control, slot1, slot2'],
        [10031, 'resume', 'info', 'peer sync: IMG_2231.MOV in, 1312/2048 pages, prefix match', undefined, { peer: options.peerName }],
        [10040, 'xfer', 'info', 'IMG_2231.MOV accept fromPage=1312 pageSize=1 MiB slot=1', { name: 'IMG_2231.MOV', fromPage: 1312 }, file],
        [10071, 'xfer', 'debug', 'IMG_2231.MOV page 1312/2048 ack 29 ms hash 9c1f… buf 1.9 MiB', undefined, { ...file, page: 1312 }],
        [10102, 'xfer', 'debug', 'IMG_2231.MOV page 1313/2048 ack 27 ms hash 41aa… buf 1.8 MiB', undefined, { ...file, page: 1313 }],
        [11000, 'xfer', 'info', 'IMG_2231.MOV 1340/2048 (65.4%) 28.0 MiB/s, 25 s left', undefined, file],
        [11500, 'health', 'warn', 'weak: 6.2 s since last message'],
    ];
    const entries = shapes.map(([t, cat, level, msg, data, extra]) => ({
        t,
        wall: startWall + t,
        level,
        cat,
        msg,
        ...(data === undefined ? {} : { data }),
        ...stripUndefined(extra ?? {}),
    }));

    const burst = options.pageBurst ?? 0;
    for (let index = 0; index < burst; index++) {
        const t = 12000 + Math.floor((index * 990) / Math.max(1, burst));
        entries.push({
            t,
            wall: startWall + t,
            level: 'debug',
            cat: 'xfer',
            msg: `IMG_2231.MOV page ${1341 + index}/2048 ack 9 ms buf 3.1 MiB`,
            ...file,
            page: 1341 + index,
        });
    }

    if (burst > 0) {
        entries.push({ t: 12995, wall: startWall + 12995, level: 'info', cat: 'xfer', msg: `IMG_2231.MOV ${1341 + burst}/2048 summary`, ...file });
    }

    return entries;
}

export function createSampleDiagnostics(): Diagnostics {
    return {
        state: 'connected',
        health: { status: 'good', rttMs: 4, lastSeenMs: 120, peerHidden: false },
        maxMessageSize: 262_144,
        slots: [
            { slot: 1, fileId: 'f1c2a9e07b3d4411', direction: 'out', buffered: 1_992_294 },
            { slot: 2, buffered: 0 },
        ],
        pairs: [
            {
                id: 'pair-2',
                local: { type: 'host', protocol: 'udp', address: '3f2a9c1e-77b0-4c1d-9a51-2b7f0e3d8c44.local', port: 52344 },
                remote: { type: 'host', protocol: 'udp', address: '192.168.1.41', port: 60111 },
                state: 'failed',
                nominated: false,
                selected: false,
                bytesSent: 0,
                bytesReceived: 0,
            },
            {
                id: 'pair-1',
                local: { type: 'host', protocol: 'udp', address: '192.168.1.23', port: 52344 },
                remote: { type: 'prflx', protocol: 'udp', address: '192.168.1.41', port: 60111 },
                state: 'succeeded',
                nominated: true,
                selected: true,
                rttMs: 4,
                bytesSent: 1_400_000_000,
                bytesReceived: 2_100_000,
            },
            {
                id: 'pair-3',
                local: { type: 'host', protocol: 'udp', address: 'fe80::1c2a:4bff:fe01:9a3c', port: 61021 },
                remote: { type: 'host', protocol: 'udp', address: '192.168.1.41', port: 60111 },
                state: 'in-progress',
                nominated: false,
                selected: false,
                bytesSent: 312,
                bytesReceived: 0,
            },
        ],
    };
}

function stripUndefined(value: Partial<LogEntry>): Partial<LogEntry> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<LogEntry>;
}
