import type { Emitter } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import type { Settings } from '../core/settings.js';
import type { MediaToolkit } from '../media/metadataTypes.js';
import type { ChannelName, FrameHeader, Network, SlotId } from '../network/networkTypes.js';
import type { BatchStore } from './batchStore.js';
import type { ClientEvents, FileRecord, Pagination, SyncDecision, TestTool, TransferSettings } from './clientTypes.js';
import type { ProgressTracker } from './progress.js';
import type { ProtocolMessage } from './protocol.js';
import type { ClientStorage, StoredFile, StoredPagination } from './storage.js';

// What the sender, receiver and scheduler share; client.ts builds it once.

// What became of a send: on the wire, refused for its size (nothing else is wrong), or not sent because the link is gone.
export type SendResult = 'sent' | 'too-large' | 'closed';

// The current connection after hello: the network plus the session it belongs to.
export interface Link {
    readonly network: Network;
    readonly sessionId: string;
    readonly connectionId: string;
    readonly peerName: string;
    readonly isOpen: boolean;
    // False when the link is gone; the connection then pauses everything (CL-09).
    send(channel: ChannelName, message: ProtocolMessage): boolean;
    // Like send, saying why a message didn't go, so a too-large one can be split instead of waited on.
    trySend(channel: ChannelName, message: ProtocolMessage): SendResult;
    sendFrame(header: FrameHeader, payload: Uint8Array): boolean;
    waitDrainedAsync(slot: SlotId): Promise<void>;
}

export interface TransferContext {
    readonly storage: ClientStorage;
    readonly batches: BatchStore;
    readonly logger: Logger;
    readonly media: MediaToolkit;
    readonly events: Emitter<ClientEvents>;
    readonly progress: ProgressTracker;
    now(): number;
    randomId(): string;
    settings(): Settings;
    // Settings with this session's overrides (AP-05).
    transferSettings(): TransferSettings;
    link(): Link | undefined;
    // corrupt-pages and drop-ack act once each time they are turned on.
    consumeTestTool(tool: TestTool): boolean;
    freeSpaceAsync(): Promise<number | undefined>;
    // PW-06: asks for persistent storage once, at the first transfer.
    ensurePersistentStorage(): void;
    emitSync(decisions: readonly SyncDecision[]): void;
}

export const SLOT_MESSAGE_CHANNEL: SlotId = 1;

// Stopped with its batch (Stop, on either device): what arrived stays, and only Resume moves it again.
export function isStoppedRecord(record: Pick<StoredFile, 'state' | 'pausedBy'> | undefined): boolean {
    return record?.state === 'paused' && record.pausedBy === 'stop';
}

// What a Stop did on one side: how many files stopped, and which of them were moving.
export interface BatchStop {
    readonly count: number;
    readonly movingFileIds: readonly string[];
}

function omitField<Value extends object, Key extends keyof Value>(value: Value, key: Key): Omit<Value, Key> {
    const { [key]: _, ...rest } = value;

    return rest;
}

// The stored-only fields (crc32, rootPageSize, contentId) stay in storage.
export function toFileRecord(file: StoredFile): FileRecord {
    const record = omitField(omitField(omitField(file, 'crc32'), 'rootPageSize'), 'contentId');
    if (!file.pagination) {
        return record;
    }

    return { ...record, pagination: toPublicPagination(file.pagination) };
}

function toPublicPagination(pagination: StoredPagination): Pagination {
    return {
        pageSize: pagination.pageSize,
        totalPages: pagination.totalPages,
        currentPage: pagination.currentPage,
        pagesDone: pagination.pagesDone,
        ...(pagination.prefixHash == null ? {} : { prefixHash: pagination.prefixHash }),
        slot: pagination.slot,
        ...(pagination.lastConnectionId == null ? {} : { lastConnectionId: pagination.lastConnectionId }),
    };
}

export function emitFileState(context: TransferContext, file: StoredFile): void {
    context.events.emit('file-state', toFileRecord(file));
}

export function withoutPagination(file: StoredFile): StoredFile {
    const { pagination: _, ...rest } = file;

    return rest;
}
