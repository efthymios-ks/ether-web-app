import { ClientError, UNFINISHED_STATES } from '../../client/clientTypes.js';
import type {
    Batch,
    BatchRecord,
    ClearScope,
    Client,
    ClientEvents,
    CodeInfo,
    ConnectionState,
    Diagnostics,
    Direction,
    FileRecord,
    FileRef,
    FileState,
    GalleryGroup,
    GalleryItem,
    GalleryStatus,
    ListFilesOptions,
    ListGalleryOptions,
    Peer,
    ResumeMatch,
    SessionSummary,
    StorageInfo,
    TestTool,
    UnfinishedElsewhere,
} from '../../client/clientTypes.js';
import { createEmitter } from '../../core/events.js';
import { createDefaultSettings } from '../../core/settings.js';
import type { Settings } from '../../core/settings.js';

// An in-memory Client for UI tests: plain data, recorded calls, and events the test emits.

export interface FakeCall {
    readonly method: string;
    readonly args: readonly unknown[];
}

export interface FakeClientBehaviour {
    startPairingAsync?: () => Promise<{ code: string; url: string; expiresAt: number }>;
    joinWithCodeAsync?: (code: string) => Promise<{ answerCode: string; answerUrl: string }>;
    completePairingAsync?: (code: string) => Promise<Peer>;
    inspectCode?: (code: string) => CodeInfo | undefined;
    resumeWithFilesAsync?: (files: readonly File[]) => Promise<ResumeMatch>;
    sendUnfinishedHereAsync?: (sessionIds: readonly string[]) => Promise<{ readonly queued: number; readonly needsFile: number }>;
    computeSha256Async?: Client['computeSha256Async'];
    // File IDs whose stored copy fails verification ('verify-failed').
    damaged?: readonly string[];
    // A thumbnail for this file, or undefined (the default) for none.
    thumbnail?: (file: FileRef) => Blob | undefined;
}

export interface FakeClientOptions {
    readonly deviceId?: string;
    readonly settings?: Partial<Settings>;
    readonly sessions?: readonly SessionSummary[];
    readonly files?: readonly FileRecord[];
    readonly batches?: readonly BatchRecord[];
    readonly gallery?: readonly GalleryGroup[];
    readonly unfinishedElsewhere?: readonly UnfinishedElsewhere[];
    readonly behaviour?: FakeClientBehaviour;
}

export interface FakeClient extends Client {
    readonly calls: FakeCall[];
    sessions: SessionSummary[];
    files: FileRecord[];
    batches: BatchRecord[];
    gallery: GalleryGroup[];
    unfinishedElsewhere: UnfinishedElsewhere[];
    behaviour: FakeClientBehaviour;
    emit<Name extends keyof ClientEvents>(name: Name, ...args: Parameters<ClientEvents[Name]>): void;
    setState(state: ConnectionState): void;
    // Sets the peer, moves to connected and emits peer + state, as a real pairing does.
    connect(peer?: Partial<Peer>): Peer;
    callsTo(method: string): ReadonlyArray<readonly unknown[]>;
}

const CLEAR_DIRECTIONS: Readonly<Record<ClearScope, readonly FileRecord['direction'][]>> = Object.freeze({
    sent: ['out'],
    received: ['in'],
    all: ['out', 'in'],
});

function clearable(files: readonly FileRecord[], sessionId: string, scope: ClearScope): FileRecord[] {
    return files.filter(file => file.sessionId === sessionId && CLEAR_DIRECTIONS[scope].includes(file.direction));
}

// The gallery the real client keeps beside the records: one item per file that moved or finished, by day.
const GALLERY_STATUS: Readonly<Record<Direction, Readonly<Partial<Record<FileState, GalleryStatus>>>>> = Object.freeze({
    in: { 'queued': 'waiting', 'offered': 'waiting', 'incoming': 'waiting', 'paused': 'waiting', 'active': 'receiving', 'verifying': 'receiving', 'done': 'received', 'failed': 'failed' },
    out: { 'queued': 'queued', 'offered': 'queued', 'paused': 'queued', 'needs-file': 'queued', 'active': 'sending', 'verifying': 'sending', 'done': 'sent', 'failed': 'failed' },
});

function localDay(epochMs: number): string {
    const date = new Date(epochMs);

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function galleryFromFiles(files: readonly FileRecord[], options: ListGalleryOptions): GalleryGroup[] {
    const days = new Map<string, GalleryItem[]>();
    const sorted = files
        .filter(file => file.sessionId === options.sessionId
            && (options.direction == null || file.direction === options.direction)
            && (options.batchId == null || file.batchId === options.batchId))
        .sort((left, right) => (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt));
    for (const file of sorted) {
        const status = GALLERY_STATUS[file.direction][file.state] as GalleryStatus | undefined;
        if (status == null) {
            continue;
        }

        const item: GalleryItem = {
            fileId: file.fileId,
            sessionId: file.sessionId,
            direction: file.direction,
            batchId: file.batchId,
            name: file.name,
            mime: file.mime,
            size: file.size,
            kind: file.kind,
            status: status === 'received' && file.savedAt != null ? 'saved' : status,
            hasThumbnail: file.hasThumbnail,
            hasData: file.hasData,
        };
        const day = localDay(file.completedAt ?? file.updatedAt);
        days.set(day, [...(days.get(day) ?? []), item]);
    }

    return [...days].map(([day, items]) => ({ day, items }));
}

export const FAKE_APP_URL = 'https://ether.test/';
export const OFFER_CODE = 'OFFERAAAABBBBCCCC';
export const ANSWER_CODE = 'ANSWERDDDDEEEEFFFF';

export function createPeer(overrides: Partial<Peer> = {}): Peer {
    return {
        deviceId: 'device-peer-1234',
        name: 'Pixel 8 · Blue Otter',
        displayName: 'Pixel 8 · Blue Otter',
        sessionId: 'session-1',
        connectionId: 'connection-1',
        checkCode: '7KQ2',
        protocol: 1,
        ...overrides,
    };
}

export function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        sessionId: 'session-1',
        peerDeviceId: 'device-peer-1234',
        peerName: 'Pixel 8 · Blue Otter',
        createdAt: Date.parse('2026-11-20T10:00:00Z'),
        lastConnectedAt: Date.parse('2026-11-23T09:00:00Z'),
        connections: [],
        totals: { filesSent: 0, bytesSent: 0, filesReceived: 0, bytesReceived: 0 },
        unfinishedCount: 0,
        connected: false,
        ...overrides,
    };
}

export function createFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
    return {
        sessionId: 'session-1',
        fileId: 'file-1',
        direction: 'out',
        name: 'IMG_2231.MOV',
        size: 2_147_483_648,
        mime: 'video/quicktime',
        kind: 'video',
        lastModified: Date.parse('2026-11-23T08:00:00Z'),
        state: 'queued',
        attempts: 0,
        createdAt: Date.parse('2026-11-23T08:00:00Z'),
        updatedAt: Date.parse('2026-11-23T08:00:00Z'),
        hasThumbnail: false,
        hasData: false,
        queueIndex: 0,
        ...overrides,
    };
}

export function createUnfinishedElsewhere(overrides: Partial<UnfinishedElsewhere> = {}): UnfinishedElsewhere {
    return {
        sessionId: 'session-old',
        peerName: 'iPhone · Old Fox',
        lastConnectedAt: Date.parse('2026-11-20T10:00:00Z'),
        fileCount: 3,
        totalBytes: 12_000_000,
        readyCount: 2,
        ...overrides,
    };
}

export function createBatchRecord(overrides: Partial<BatchRecord> = {}): BatchRecord {
    return {
        sessionId: 'session-1',
        batchId: 'batch-1',
        direction: 'in',
        itemCount: 3,
        totalBytes: 9_000_000,
        received: 1,
        saved: 0,
        failed: 0,
        canceled: 0,
        createdAt: Date.parse('2026-11-23T08:00:00Z'),
        ...overrides,
    };
}

function defaultInspect(codeOrUrl: string): CodeInfo | undefined {
    const code = codeOrUrl.replace(/^.*#/, '').replace(/[\s-]/g, '').toUpperCase();
    const kinds: ReadonlyArray<{ readonly prefix: string; readonly info: Omit<CodeInfo, 'code'> }> = [
        { prefix: 'OFFER', info: { kind: 'offer', expired: false } },
        { prefix: 'ANSWER', info: { kind: 'answer', expired: false } },
        { prefix: 'OLD', info: { kind: 'offer', expired: true } },
    ];
    const match = kinds.find(item => code.startsWith(item.prefix));

    return match == null ? undefined : { ...match.info, code };
}

export function createFakeClient(options: FakeClientOptions = {}): FakeClient {
    const emitter = createEmitter<ClientEvents>();
    const calls: FakeCall[] = [];
    let state: ConnectionState = 'idle';
    let peer: Peer | undefined;
    let settings = createDefaultSettings(options.settings);
    let testTools: readonly TestTool[] = [];

    const record = (method: string, ...args: unknown[]): void => {
        calls.push({ method, args });
    };

    const batchFiles = (sessionId: string, batchId: string, direction: Direction): FileRecord[] => client.files
        .filter(file => file.sessionId === sessionId && file.batchId === batchId && file.direction === direction);

    const client: FakeClient = {
        deviceId: options.deviceId ?? 'device-self-abcd',
        calls,
        sessions: [...(options.sessions ?? [])],
        files: [...(options.files ?? [])],
        batches: [...(options.batches ?? [])],
        gallery: [...(options.gallery ?? [])],
        unfinishedElsewhere: [...(options.unfinishedElsewhere ?? [])],
        behaviour: { ...options.behaviour },
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
            return testTools;
        },
        emit: (name, ...args) => emitter.emit(name, ...args),
        setState: next => {
            state = next;
            emitter.emit('state', next);
        },
        connect: overrides => {
            peer = createPeer(overrides);
            state = 'connected';
            emitter.emit('peer', 'connected', peer);
            emitter.emit('state', 'connected');

            return peer;
        },
        callsTo: method => calls.filter(call => call.method === method).map(call => call.args),

        inspectCode: codeOrUrl => (client.behaviour.inspectCode ?? defaultInspect)(codeOrUrl),
        startPairingAsync: async () => {
            record('startPairingAsync');
            state = 'awaiting-answer';

            return client.behaviour.startPairingAsync?.() ?? {
                code: OFFER_CODE,
                url: `${FAKE_APP_URL}#${OFFER_CODE}`,
                expiresAt: Date.now() + settings.codeExpiryMs,
            };
        },
        joinWithCodeAsync: async code => {
            record('joinWithCodeAsync', code);
            state = 'answering';

            return client.behaviour.joinWithCodeAsync?.(code) ?? { answerCode: ANSWER_CODE, answerUrl: `${FAKE_APP_URL}#${ANSWER_CODE}` };
        },
        completePairingAsync: async code => {
            record('completePairingAsync', code);
            if (client.behaviour.completePairingAsync != null) {
                return client.behaviour.completePairingAsync(code);
            }

            return client.connect();
        },
        cancelPairing: () => {
            record('cancelPairing');
            if (state !== 'connected') {
                state = 'idle';
            }
        },
        disconnectAsync: async () => {
            record('disconnectAsync');
            state = 'closed';
            emitter.emit('state', 'closed');
        },
        // As in the real client, a rename is a settings change.
        renameAsync: async name => {
            record('renameAsync', name);
            settings = { ...settings, deviceName: name.trim() };
            emitter.emit('settings', settings);
        },
        sendFilesAsync: async (files, sendOptions) => {
            record('sendFilesAsync', files, sendOptions);
            if (state !== 'connected') {
                throw new ClientError('not-connected', 'Not connected.');
            }

            const batch: Batch = {
                batchId: `batch-${calls.length}`,
                files: files.map((file, index) => ({ localId: `local-${index}`, name: file.name, size: file.size })),
            };

            return batch;
        },
        pauseAsync: async file => record('pauseAsync', file),
        resumeAsync: async file => record('resumeAsync', file),
        cancelAsync: async file => record('cancelAsync', file),
        cancelBatchAsync: async (sessionId, batchId, direction) => {
            record('cancelBatchAsync', sessionId, batchId, direction);

            return client.files.filter(file => file.sessionId === sessionId && file.batchId === batchId && file.direction === direction
                && UNFINISHED_STATES.includes(file.state)).length;
        },
        stopBatchAsync: async (sessionId, batchId, direction) => {
            record('stopBatchAsync', sessionId, batchId, direction);

            return batchFiles(sessionId, batchId, direction)
                .filter(file => UNFINISHED_STATES.includes(file.state))
                .length;
        },
        resumeBatchAsync: async (sessionId, batchId, direction) => {
            record('resumeBatchAsync', sessionId, batchId, direction);
            if (state !== 'connected') {
                throw new ClientError('not-connected', 'Not connected.');
            }

            return batchFiles(sessionId, batchId, direction)
                .filter(file => file.state === 'paused' && file.pausedBy === 'stop')
                .length;
        },
        resumeWithFilesAsync: async (files, resumeOptions) => {
            record('resumeWithFilesAsync', files, resumeOptions);

            return client.behaviour.resumeWithFilesAsync?.(files) ?? { matched: [], unmatched: [...files] };
        },
        listUnfinishedElsewhereAsync: async () => [...client.unfinishedElsewhere],
        sendUnfinishedHereAsync: async sessionIds => {
            record('sendUnfinishedHereAsync', sessionIds);
            if (client.behaviour.sendUnfinishedHereAsync != null) {
                return client.behaviour.sendUnfinishedHereAsync(sessionIds);
            }

            const groups = client.unfinishedElsewhere.filter(group => sessionIds.includes(group.sessionId));
            client.unfinishedElsewhere = client.unfinishedElsewhere.filter(group => !sessionIds.includes(group.sessionId));

            return {
                queued: groups.reduce((total, group) => total + group.readyCount, 0),
                needsFile: groups.reduce((total, group) => total + group.fileCount - group.readyCount, 0),
            };
        },
        sendAgainAsync: async file => record('sendAgainAsync', file),
        retryFailedAsync: async (sessionId, batchId) => record('retryFailedAsync', sessionId, batchId),
        acceptIncomingAsync: async file => record('acceptIncomingAsync', file),
        rejectIncomingAsync: async (file, reason) => record('rejectIncomingAsync', file, reason),
        acceptBatchAsync: async (batchId, acceptOptions) => record('acceptBatchAsync', batchId, acceptOptions),
        declineBatchAsync: async batchId => record('declineBatchAsync', batchId),
        getReceivedFileAsync: async file => {
            if (client.behaviour.damaged?.includes(file.fileId) === true) {
                throw new ClientError('verify-failed', 'The stored copy is damaged.', file.fileId);
            }

            record('getReceivedFileAsync', file);
            const stored = client.files.find(item => item.sessionId === file.sessionId && item.fileId === file.fileId && item.direction === 'in');

            return new File(['received bytes'], stored?.name ?? `${file.fileId}.bin`, { type: stored?.mime ?? 'application/octet-stream' });
        },
        getThumbnailAsync: async file => {
            record('getThumbnailAsync', file);

            return client.behaviour.thumbnail?.(file);
        },
        buildZipAsync: async (sessionId, fileIds) => {
            record('buildZipAsync', sessionId, fileIds);
            const damaged = fileIds.find(fileId => client.behaviour.damaged?.includes(fileId) === true);
            if (damaged != null) {
                throw new ClientError('verify-failed', 'The stored copy is damaged.', damaged);
            }

            return new Blob(['zip'], { type: 'application/zip' });
        },
        markSavedAsync: async (sessionId, fileIds) => {
            record('markSavedAsync', sessionId, fileIds);
        },
        computeSha256Async: async (file, hashOptions) => {
            record('computeSha256Async', file);
            if (client.behaviour.computeSha256Async != null) {
                return client.behaviour.computeSha256Async(file, hashOptions);
            }

            hashOptions?.onProgress?.(0.5);
            hashOptions?.onProgress?.(1);

            return 'a'.repeat(64);
        },
        deleteReceivedAsync: async file => record('deleteReceivedAsync', file),
        deleteReceivedManyAsync: async (sessionId, fileIds) => record('deleteReceivedManyAsync', sessionId, fileIds),
        deletePartialAsync: async file => record('deletePartialAsync', file),
        listSessionsAsync: async () => [...client.sessions],
        getSessionAsync: async sessionId => client.sessions.find(session => session.sessionId === sessionId),
        listFilesAsync: async (listOptions: ListFilesOptions) => client.files.filter(file => file.sessionId === listOptions.sessionId
            && (listOptions.direction == null || file.direction === listOptions.direction)
            && (listOptions.states == null || listOptions.states.includes(file.state))),
        listBatchesAsync: async sessionId => client.batches.filter(batch => batch.sessionId === sessionId),
        listGalleryAsync: async (galleryOptions: ListGalleryOptions) => {
            record('listGalleryAsync', galleryOptions);

            // Given gallery groups win; otherwise the gallery follows the records, as in the real client.
            if (client.gallery.length === 0) {
                return galleryFromFiles(client.files, galleryOptions);
            }

            return client.gallery
                .map(group => ({
                    ...group,
                    items: group.items.filter(item => item.sessionId === galleryOptions.sessionId
                        && (galleryOptions.direction == null || item.direction === galleryOptions.direction)
                        && (galleryOptions.batchId == null || item.batchId === galleryOptions.batchId)),
                }))
                .filter(group => group.items.length > 0);
        },
        clearSessionAsync: async sessionId => {
            record('clearSessionAsync', sessionId);
            if (peer?.sessionId === sessionId && state === 'connected') {
                throw new ClientError('busy', 'Disconnect before clearing this device');
            }

            client.sessions = client.sessions.filter(session => session.sessionId !== sessionId);
            client.files = client.files.filter(file => file.sessionId !== sessionId);
        },
        getClearSummaryAsync: async (sessionId, scope) => {
            const inScope = clearable(client.files, sessionId, scope);
            const finished = inScope.filter(file => !UNFINISHED_STATES.includes(file.state));

            return {
                finished: finished.length,
                unfinished: inScope.length - finished.length,
                notDownloaded: finished.filter(file => file.direction === 'in' && file.state === 'done' && file.hasData && file.savedAt == null).length,
                bytes: finished.reduce((total, file) => total + file.size, 0),
            };
        },
        clearSessionFilesAsync: async (sessionId, clearOptions) => {
            record('clearSessionFilesAsync', sessionId, clearOptions);
            const removed = clearable(client.files, sessionId, clearOptions.scope)
                .filter(file => clearOptions.includeUnfinished === true || !UNFINISHED_STATES.includes(file.state));
            client.files = client.files.filter(file => !removed.includes(file));
            client.gallery = client.gallery
                .map(group => ({ ...group, items: group.items.filter(item => !removed.some(file => file.sessionId === item.sessionId && file.fileId === item.fileId && file.direction === item.direction)) }))
                .filter(group => group.items.length > 0);
            emitter.emit('session-cleared', sessionId, clearOptions.scope);

            return { removed: removed.length };
        },
        clearAllAsync: async () => record('clearAllAsync'),
        restoreSessionAsync: async sessionId => record('restoreSessionAsync', sessionId),
        startFreshAsync: async sessionId => {
            record('startFreshAsync', sessionId);
            const removed = client.files.filter(file => file.sessionId === sessionId);
            client.files = client.files.filter(file => file.sessionId !== sessionId);
            emitter.emit('session-cleared', sessionId, 'all');

            return { removed: removed.length, isPeerNotified: state === 'connected' };
        },
        configureAsync: async changes => {
            settings = { ...settings, ...changes };
            emitter.emit('settings', settings);

            return settings;
        },
        configureSessionAsync: async changes => record('configureSessionAsync', changes),
        getDiagnosticsAsync: async (): Promise<Diagnostics> => ({ state, pairs: [], slots: [] }),
        getStorageInfoAsync: async (): Promise<StorageInfo> => ({ persisted: false }),
        setPeerLogs: isOn => record('setPeerLogs', isOn),
        setTestTool: (tool, isOn) => {
            record('setTestTool', tool, isOn);
            testTools = isOn ? [...testTools, tool] : testTools.filter(item => item !== tool);
            emitter.emit('test-tools', testTools);
        },
        dropConnectionForTest: () => record('dropConnectionForTest'),
        on: (name, handler) => emitter.on(name, handler),
        dispose: () => emitter.clear(),
    };

    return client;
}
