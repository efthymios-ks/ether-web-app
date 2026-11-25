import type { DevicePlatform } from '../core/deviceInfo.js';
import type { Unsubscribe } from '../core/events.js';
import type { Logger, LoggerController } from '../core/logger.js';
import type { Settings } from '../core/settings.js';
import type { FileMetadata, MediaKind, MediaToolkit } from '../media/metadataTypes.js';
import type { CandidatePairStats, CreateNetwork } from '../network/networkTypes.js';

// The use-case layer (§17.3). The UI imports only this file, client.ts and the media types it re-exports.

export type { FileMetadata, MediaKind } from '../media/metadataTypes.js';
export type { CandidatePairStats as DiagnosticPair } from '../network/networkTypes.js';

export type Direction = 'out' | 'in';

// §7.3, plus 'incoming' for a receiver waiting for "Ask before receiving".
export type FileState =
    | 'queued'
    | 'offered'
    | 'incoming'
    | 'active'
    | 'paused'
    | 'needs-file'
    | 'verifying'
    | 'done'
    | 'failed'
    | 'canceled';

export const UNFINISHED_STATES: readonly FileState[] = Object.freeze([
    'queued',
    'offered',
    'incoming',
    'active',
    'paused',
    'needs-file',
    'verifying',
]);

// The pairing and connection state the UI draws screens from.
export type ConnectionState =
    | 'idle'
    | 'creating-offer'
    | 'awaiting-answer'
    | 'answering'
    | 'connecting'
    | 'connected'
    | 'lost'
    | 'closed';

export type HealthStatus = 'good' | 'weak' | 'lost';

export interface HealthInfo {
    readonly status: HealthStatus;
    readonly rttMs?: number;
    readonly lastSeenMs: number;
    readonly peerHidden: boolean;
}

export interface Peer {
    readonly deviceId: string;
    readonly name: string;
    // DN-03: the name with the last 4 characters of the deviceId when it clashes with ours.
    readonly displayName: string;
    readonly sessionId: string;
    readonly connectionId: string;
    // SP-02.
    readonly checkCode?: string;
    readonly protocol: number;
    // From `hello`, e.g. "Android"; missing when the peer runs an older build or sent one this build doesn't know.
    readonly platform?: DevicePlatform;
}

// Why a file is paused: by the user here, by the peer, by a lost link, by full storage, or by a Stop of its batch
// on either device ('stop': what arrived is kept, and only Resume moves it again, never a reconnect).
export type PausedBy = 'user' | 'peer' | 'link' | 'storage' | 'stop';

// A short status the UI turns into text, e.g. 'already-on-peer' → "Already on Pixel 8".
export type FileNote =
    | 'checking'
    | 'check-waiting'
    | 'already-on-peer'
    | 'data-lost'
    | 'adopted'
    | 'restarted'
    | 'storage-full'
    | 'partial-expired'
    | 'declined'
    | 'no-space'
    | 'moved'
    | 'damaged';

// What clearSessionFilesAsync removes: sent files, received files, or both.
export type ClearScope = 'sent' | 'received' | 'all';

export interface ClearSummary {
    readonly finished: number;
    readonly unfinished: number;
    // Received, verified, still in the app and never saved.
    readonly notDownloaded: number;
    // Total size of the files counted.
    readonly bytes: number;
}


export interface Pagination {
    readonly pageSize: number;
    readonly totalPages: number;
    readonly currentPage: number;
    readonly pagesDone: number;
    readonly prefixHash?: string;
    readonly slot: number | null;
    readonly lastConnectionId?: string;
}

// §7.2 `files` record, as the UI sees it.
export interface FileRecord {
    readonly sessionId: string;
    readonly fileId: string;
    readonly direction: Direction;
    readonly batchId?: string;
    readonly name: string;
    readonly relativePath?: string;
    readonly size: number;
    readonly mime: string;
    readonly kind: MediaKind;
    readonly lastModified: number;
    readonly metadata?: FileMetadata;
    readonly state: FileState;
    readonly attempts: number;
    readonly lastError?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly completedAt?: number;
    readonly rootHash?: string;
    // The standard whole-file SHA-256 (hex), once computed with computeSha256Async.
    readonly sha256?: string;
    readonly savedAt?: number;
    readonly pagination?: Pagination;
    readonly hasThumbnail: boolean;
    // True while the pages of a received file are still stored in the app.
    readonly hasData: boolean;
    // Order in the queue, for resume order (§7.5).
    readonly queueIndex: number;
    readonly pausedBy?: PausedBy;
    readonly note?: FileNote;
}

export interface ConnectionLogEntry {
    readonly connectionId: string;
    readonly start: number;
    readonly end?: number;
    readonly reason?: string;
}

export interface SessionTotals {
    readonly filesSent: number;
    readonly bytesSent: number;
    readonly filesReceived: number;
    readonly bytesReceived: number;
}

export interface SessionRecord {
    readonly sessionId: string;
    readonly peerDeviceId: string;
    readonly peerName: string;
    // The peer's platform from its last `hello`, e.g. "Android"; missing while it never sent one this build knows.
    readonly peerPlatform?: DevicePlatform;
    readonly createdAt: number;
    readonly lastConnectedAt: number;
    readonly connections: readonly ConnectionLogEntry[];
    readonly transferSettings?: Partial<TransferSettings>;
    readonly totals: SessionTotals;
    // Start fresh ran while the link was down: the peer is told at the next connection, so it clears its copy too.
    readonly resetPending?: boolean;
}

export interface SessionSummary extends SessionRecord {
    readonly unfinishedCount: number;
    readonly connected: boolean;
}

export interface TransferSettings {
    readonly pageSize: number;
    readonly chunkSize: number;
    readonly maxConcurrentFiles: number;
    readonly maxBuffered: number;
}

export interface BatchRecord {
    readonly sessionId: string;
    readonly batchId: string;
    readonly direction: Direction;
    readonly itemCount: number;
    readonly totalBytes: number;
    readonly received: number;
    readonly saved: number;
    readonly failed: number;
    // Files stopped before they finished: canceled one by one, or by stopping the batch.
    readonly canceled: number;
    readonly createdAt: number;
    // Set once received + failed + canceled reaches itemCount.
    readonly finishedAt?: number;
}

// One picked file before and after its fileId is known (BK-06 prepares IDs just ahead of sending).
export interface FileHandle {
    readonly localId: string;
    readonly name: string;
    readonly size: number;
    readonly relativePath?: string;
    readonly fileId?: string;
}

export interface Batch {
    readonly batchId: string;
    readonly files: readonly FileHandle[];
}

export interface SendFilesOptions {
    // PK-03: webkitRelativePath per file, same order as the files.
    readonly relativePaths?: readonly (string | undefined)[];
}

// Which file a call is about. A FileRecord fits as it is; the direction picks the side when the session
// both sent and received the same file (left out: the unfinished one, else the sent one).
export interface FileRef {
    readonly sessionId: string;
    readonly fileId: string;
    readonly direction?: Direction;
}

export interface ResumeMatch {
    readonly matched: readonly FileRecord[];
    readonly unmatched: readonly File[];
}

export type GalleryFilter = 'all' | 'photos' | 'videos' | 'not-saved' | 'failed';

// GL-04, GL-07.
export type GalleryStatus =
    | 'waiting'
    | 'receiving'
    | 'received'
    | 'saved'
    | 'failed'
    | 'queued'
    | 'sending'
    | 'sent';

export interface GalleryItem {
    readonly fileId: string;
    readonly sessionId: string;
    readonly direction: Direction;
    readonly batchId?: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    readonly kind: MediaKind;
    readonly takenAt?: string;
    readonly durationSeconds?: number;
    readonly status: GalleryStatus;
    // 0..1 while moving.
    readonly progress?: number;
    readonly hasThumbnail: boolean;
    readonly hasData: boolean;
}

export interface GalleryGroup {
    // 'YYYY-MM-DD', or 'no-date'.
    readonly day: string;
    readonly items: readonly GalleryItem[];
}

export interface ListGalleryOptions {
    readonly sessionId: string;
    readonly batchId?: string;
    readonly direction?: Direction;
    readonly filter: GalleryFilter;
    readonly groupBy: 'day';
}

export interface ListFilesOptions {
    readonly sessionId: string;
    readonly direction?: Direction;
    readonly states?: readonly FileState[];
}

// TR-10, CL-08.
export interface ProgressInfo {
    readonly fileId: string;
    readonly sessionId: string;
    readonly direction: Direction;
    readonly batchId?: string;
    readonly pagesDone: number;
    readonly totalPages: number;
    readonly bytesDone: number;
    readonly size: number;
    readonly percent: number;
    readonly bytesPerSecond: number;
    // Live estimate from the rate the bytes cross the link, updated twice a second, slow links included.
    readonly secondsLeft?: number;
    // Nothing has moved for a while; the estimate is on hold until it does.
    readonly stalled?: boolean;
}

// BK-03.
export interface BatchIncoming {
    // The session the batch comes from; always set by the client.
    readonly sessionId?: string;
    readonly batchId: string;
    readonly peerName: string;
    readonly itemCount: number;
    readonly totalBytes: number;
    readonly freeBytes?: number;
    // The first N files that fit in the free space.
    readonly fitsCount: number;
    readonly fitsBytes: number;
    // Free space under 1.1 × the batch size.
    readonly spaceIsShort: boolean;
}

export interface BatchProgress {
    readonly batchId: string;
    readonly sessionId: string;
    readonly direction: Direction;
    readonly total: number;
    readonly done: number;
    readonly saved: number;
    readonly failed: number;
    readonly canceled: number;
    readonly bytesDone: number;
    readonly totalBytes: number;
    readonly bytesPerSecond: number;
    // Live estimate from the rate the bytes cross the link, updated twice a second, slow links included.
    readonly secondsLeft?: number;
    // Nothing has moved for a while; the estimate is on hold until it does.
    readonly stalled?: boolean;
}

export type SyncDecisionKind = 'resume' | 'restart' | 'needs-file' | 'adopted' | 'data-lost' | 'already-done';

export interface SyncDecision {
    // The session the decision belongs to; always set by the client.
    readonly sessionId?: string;
    readonly fileId: string;
    readonly name: string;
    readonly direction: Direction;
    readonly decision: SyncDecisionKind;
    readonly fromPage: number;
    readonly totalPages: number;
}

export interface Diagnostics {
    readonly state: ConnectionState;
    readonly health?: HealthInfo;
    readonly pairs: readonly CandidatePairStats[];
    readonly slots: ReadonlyArray<{ readonly slot: number; readonly fileId?: string; readonly direction?: Direction; readonly buffered: number }>;
    readonly maxMessageSize?: number;
    readonly checkCode?: string;
}

export interface StorageInfo {
    readonly usedBytes?: number;
    readonly quotaBytes?: number;
    readonly freeBytes?: number;
    readonly persisted: boolean;
}

export type ClientErrorCode =
    | 'not-connected'
    | 'busy'
    | 'code-invalid'
    | 'code-expired'
    | 'code-version'
    | 'code-used'
    | 'gathering-timeout'
    | 'connect-timeout'
    | 'ice-failed'
    | 'protocol-version'
    | 'no-space'
    | 'storage-full'
    | 'file-not-found'
    | 'file-unreadable'
    | 'not-supported'
    | 'invalid-state'
    | 'canceled'
    | 'timeout'
    | 'internal'
    | 'invalid-argument'
    | 'verify-failed';

export class ClientError extends Error {
    override readonly name = 'ClientError';

    constructor(
        readonly code: ClientErrorCode,
        message: string,
        readonly fileId?: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

// Unfinished outgoing files of another paired device, offered to send to the connected one instead.
export interface UnfinishedElsewhere {
    readonly sessionId: string;
    readonly peerName: string;
    readonly lastConnectedAt: number;
    readonly fileCount: number;
    readonly totalBytes: number;
    // Files whose File is still held by this page; the rest need picking again.
    readonly readyCount: number;
}

// A device this one already has history with connected again (§6 of the UI plan): what the Restore prompt shows.
// Its transfers wait until restoreSessionAsync or startFreshAsync answers.
export interface SessionKnown {
    readonly sessionId: string;
    readonly peerName: string;
    // When the connection before this one started.
    readonly lastConnectedAt: number;
    // Finished files of each side (done, failed or canceled), as the Received and Sent lists hold them.
    readonly receivedCount: number;
    readonly sentCount: number;
    // Files that resume on Restore.
    readonly unfinishedCount: number;
}

// The peer started fresh, so this device cleared its history with it too.
export interface SessionReset {
    readonly sessionId: string;
    readonly peerName: string;
    // File records removed here.
    readonly removed: number;
}

export interface StartFreshResult {
    // File records removed here.
    readonly removed: number;
    // False when the link was down: the peer clears its copy when the two connect again.
    readonly isPeerNotified: boolean;
}

export interface CodeInfo {
    readonly kind: 'offer' | 'answer';
    // The normalised code: upper case, no spaces, dashes or URL.
    readonly code: string;
    readonly expired: boolean;
}

export type PeerEventKind = 'connected' | 'renamed' | 'left';

// Housekeeping the UI may show once, e.g. "3 partial files older than 7 days were deleted".
export type ClientNotice =
    | { readonly kind: 'partials-expired'; readonly count: number }
    | { readonly kind: 'history-trimmed'; readonly count: number };

// §16.3 test tools; each stays on until turned off, and the UI shows a banner meanwhile.
export type TestTool = 'corrupt-pages' | 'drop-ack' | 'fill-storage';

export interface ClientEvents {
    state(state: ConnectionState): void;
    peer(kind: PeerEventKind, peer: Peer): void;
    health(health: HealthInfo): void;
    'batch-incoming'(info: BatchIncoming): void;
    'batch-progress'(progress: BatchProgress): void;
    thumb(fileId: string, sessionId: string): void;
    'file-queued'(record: FileRecord): void;
    'file-incoming'(record: FileRecord): void;
    // Batched: at most 10 per second per file, one event per frame for many files (CL-08).
    progress(items: readonly ProgressInfo[]): void;
    'file-state'(record: FileRecord): void;
    'file-done'(record: FileRecord): void;
    'file-failed'(record: FileRecord, error: ClientError): void;
    'needs-file'(record: FileRecord): void;
    sync(decisions: readonly SyncDecision[]): void;
    settings(settings: Settings): void;
    'test-tools'(active: readonly TestTool[]): void;
    // Once per connection, after hello and sync, when other sessions hold unfinished outgoing files.
    'unfinished-elsewhere'(groups: readonly UnfinishedElsewhere[]): void;
    // A session's files of this scope were removed; lists of that session should be read again.
    'session-cleared'(sessionId: string, scope: ClearScope): void;
    // After hello, when the session already existed and holds files: this device's transfers wait for the answer.
    // Not emitted on a reconnect after link loss within the same page run once the prompt was answered.
    'session-known'(info: SessionKnown): void;
    // The peer's Start fresh cleared this device's copy of the session; a Restore prompt for it is answered.
    'session-reset'(reset: SessionReset): void;
    error(error: ClientError): void;
    notice(notice: ClientNotice): void;
}

export interface Client {
    readonly deviceId: string;
    readonly settings: Settings;
    readonly state: ConnectionState;
    readonly peer: Peer | undefined;
    readonly activeTestTools: readonly TestTool[];

    // Pairing.
    // What a scanned or pasted code is, without touching the connection; undefined when it isn't a code.
    // Lets the app forward an answer opened in a new tab to the page that made the offer (HS-07).
    inspectCode(codeOrUrl: string): CodeInfo | undefined;
    startPairingAsync(): Promise<{ code: string; url: string; expiresAt: number }>;
    joinWithCodeAsync(codeOrUrl: string): Promise<{ answerCode: string; answerUrl: string }>;
    completePairingAsync(answerCodeOrUrl: string): Promise<Peer>;
    cancelPairing(): void;
    disconnectAsync(): Promise<void>;
    renameAsync(name: string): Promise<void>;

    // Sending.
    sendFilesAsync(files: readonly File[], options?: SendFilesOptions): Promise<Batch>;
    // Every call about a file or batch names its session; one the session doesn't have rejects with file-not-found.
    pauseAsync(file: FileRef): Promise<void>;
    resumeAsync(file: FileRef): Promise<void>;
    // Cancels on both sides and deletes the partial file on both.
    cancelAsync(file: FileRef): Promise<void>;
    // Delete what arrived: cancels every unfinished file of one batch on this side and the peer's, deleting their
    // partial files, and finishes the batch on both. Resolves with the number of files canceled here.
    cancelBatchAsync(sessionId: string, batchId: string, direction: Direction): Promise<number>;
    // Stop: stops every unfinished file of one batch on this side and the peer's, keeping what arrived, so Resume
    // continues from the saved pages. Resolves with the number of files stopped here.
    stopBatchAsync(sessionId: string, batchId: string, direction: Direction): Promise<number>;
    // Resume: the stopped files of one batch move again on both sides, from the receiver's saved pages; one whose
    // File this page no longer holds needs picking again. Needs the connection. Resolves with the number resumed here.
    resumeBatchAsync(sessionId: string, batchId: string, direction: Direction): Promise<number>;
    // With a session, only that session's waiting files are matched.
    resumeWithFilesAsync(files: readonly File[], options?: { readonly sessionId?: string }): Promise<ResumeMatch>;
    sendAgainAsync(file: FileRef): Promise<void>;
    retryFailedAsync(sessionId: string, batchId: string): Promise<void>;
    // While connected: other sessions' unfinished outgoing files, per session, newest first; empty when not connected.
    listUnfinishedElsewhereAsync(): Promise<UnfinishedElsewhere[]>;
    // Moves those sessions' unfinished outgoing files into the connected session as one new batch.
    sendUnfinishedHereAsync(sessionIds: readonly string[]): Promise<{ readonly queued: number; readonly needsFile: number }>;

    // Receiving.
    acceptIncomingAsync(file: FileRef): Promise<void>;
    rejectIncomingAsync(file: FileRef, reason: 'declined' | 'space'): Promise<void>;
    acceptBatchAsync(batchId: string, options: { mode: 'all' | 'fits' }): Promise<void>;
    declineBatchAsync(batchId: string): Promise<void>;
    getReceivedFileAsync(file: FileRef): Promise<File>;
    getThumbnailAsync(file: FileRef): Promise<Blob | undefined>;
    // One session per ZIP.
    buildZipAsync(sessionId: string, fileIds: readonly string[]): Promise<Blob>;
    // Records that the files left the app (savedAt); it never deletes anything.
    markSavedAsync(sessionId: string, fileIds: readonly string[]): Promise<void>;
    // The standard whole-file SHA-256: from the stored pages ('in', the default when both exist) or the File this page holds ('out').
    computeSha256Async(
        file: FileRef,
        options?: { readonly onProgress?: (fraction: number) => void; readonly signal?: AbortSignal },
    ): Promise<string>;
    deleteReceivedAsync(file: FileRef): Promise<void>;
    // Bulk Delete (N): the same for several received files of one session; any that session lacks rejects with file-not-found first.
    deleteReceivedManyAsync(sessionId: string, fileIds: readonly string[]): Promise<void>;
    // Deletes what arrived of an unfinished file that isn't moving, here and, while connected, on the peer.
    deletePartialAsync(file: FileRef): Promise<void>;

    // History.
    listSessionsAsync(): Promise<SessionSummary[]>;
    getSessionAsync(sessionId: string): Promise<SessionSummary | undefined>;
    listFilesAsync(options: ListFilesOptions): Promise<FileRecord[]>;
    listBatchesAsync(sessionId: string): Promise<BatchRecord[]>;
    listGalleryAsync(options: ListGalleryOptions): Promise<GalleryGroup[]>;
    clearSessionAsync(sessionId: string): Promise<void>;
    // Counts for the confirmation dialog.
    getClearSummaryAsync(sessionId: string, scope: ClearScope): Promise<ClearSummary>;
    // Removes a session's files of this scope, connected or not; the session, its peer and the connection log stay.
    clearSessionFilesAsync(
        sessionId: string,
        options: { readonly scope: ClearScope; readonly includeUnfinished?: boolean },
    ): Promise<{ readonly removed: number }>;
    clearAllAsync(): Promise<void>;
    // The Restore prompt's answers (`session-known`). Restore sends this device's sync, so transfers resume once
    // both devices chose it; without a held connection to the session it only spares the next reconnect the prompt.
    restoreSessionAsync(sessionId: string): Promise<void>;
    // Start fresh: clears the session on both devices, like Reset this device, canceling transfers in progress,
    // and tells the peer with `session-reset`; while the link is down the peer is told at the next connection.
    startFreshAsync(sessionId: string): Promise<StartFreshResult>;

    // Settings and diagnostics.
    configureAsync(changes: Partial<Settings>): Promise<Settings>;
    // Per-session transfer overrides while connected (AP-05).
    configureSessionAsync(changes: Partial<TransferSettings>): Promise<void>;
    getDiagnosticsAsync(): Promise<Diagnostics>;
    getStorageInfoAsync(): Promise<StorageInfo>;
    setPeerLogs(on: boolean): void;
    setTestTool(tool: TestTool, on: boolean): void;
    // Test tool: drops the link now, as if the Wi‑Fi went away.
    dropConnectionForTest(): void;

    on<Name extends keyof ClientEvents>(name: Name, handler: ClientEvents[Name]): Unsubscribe;
    dispose(): void;
}

export interface ClientOptions {
    readonly database: IDBDatabase;
    readonly logger: Logger;
    // For the peer sink (DL-15) and live routing changes (LG-05).
    readonly loggerController?: LoggerController;
    readonly createNetwork: CreateNetwork;
    readonly media: MediaToolkit;
    // The page address pairing codes are appended to.
    readonly appUrl: string;
    readonly exposeLocalIps?: () => Promise<(() => void) | null>;
    // Platform defaults for a first run (the device name).
    readonly defaultSettings: Partial<Settings>;
    // What this device says it is in `hello`, e.g. "iPhone".
    readonly platform?: DevicePlatform;
    readonly isPhone: boolean;
    // Test seams.
    readonly now?: () => number;
    readonly storageEstimateAsync?: () => Promise<{ usage?: number; quota?: number }>;
    readonly persistStorageAsync?: () => Promise<boolean>;
    readonly randomId?: () => string;
}
