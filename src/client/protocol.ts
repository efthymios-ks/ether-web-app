import { LOG_CATEGORIES, LOG_LEVELS } from '../core/logger.js';
import type { LogEntry } from '../core/logger.js';
import type { FileMetadata } from '../media/metadataTypes.js';
import type { ChannelName, Message } from '../network/networkTypes.js';
import type { Direction, FileState } from './clientTypes.js';
import { countPages } from './pagination.js';

// The typed messages of §17.3 and their validation (CL-01, CL-03, SP-05).
// Requests carry `id`; replies carry `re` with the id they answer (CL-02).

// The integer part is the major version: peers with different majors refuse to talk (CL-01).
export const PROTOCOL_VERSION = 1;

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 255;
export const MAX_BATCH_MESSAGE_BYTES = 60 * 1024;
export const BATCH_WINDOW = 200;
export const MAX_THUMB_BASE64_LENGTH = 32 * 1024;
export const MAX_LOG_ENTRIES = 200;
const MAX_REASON_LENGTH = 500;
export const MIN_PAGE_SIZE = 16 * 1024;
export const MAX_PAGE_SIZE = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 64;
const MAX_PATH_LENGTH = 4096;
const MAX_MIME_LENGTH = 255;
const MAX_LOG_MESSAGE_LENGTH = 4096;
const MAX_PLATFORM_LENGTH = 32;
// A resume names a few files picked from a list; a whole batch goes without a list.
export const MAX_RESUME_FILE_IDS = 1000;

export type RejectReason = 'space' | 'declined' | 'invalid' | 'paused';
export type CancelReason = 'canceled' | 'paused' | 'failed' | 'storage-full';

const REJECT_REASONS: readonly RejectReason[] = Object.freeze(['space', 'declined', 'invalid', 'paused']);
const CANCEL_REASONS: readonly CancelReason[] = Object.freeze(['canceled', 'paused', 'failed', 'storage-full']);
const DIRECTIONS: readonly Direction[] = Object.freeze(['out', 'in']);
const FILE_STATES: readonly FileState[] = Object.freeze([
    'queued',
    'offered',
    'incoming',
    'active',
    'paused',
    'needs-file',
    'verifying',
    'done',
    'failed',
    'canceled',
]);

// What the receiver needs to record a file before any byte arrives (§8: the metadata summary rides along).
export type FileManifest = {
    readonly fileId: string;
    // The content and the name without the folder: the receiver skips a file it already holds from another send.
    readonly contentId?: string;
    readonly name: string;
    readonly size: number;
    readonly mime: string;
    readonly lastModified: number;
    readonly relativePath?: string;
    readonly pageSize: number;
    readonly totalPages: number;
    readonly metadata?: FileMetadata;
    // A thumbnail follows on control (TH-02), so the receiver doesn't make its own (TH-04).
    readonly thumb?: boolean;
};

export type HelloMessage = {
    readonly t: 'hello';
    readonly protocol: number;
    readonly deviceId: string;
    readonly name: string;
    readonly connectionId: string;
    // What the device says it is, e.g. "iPhone" (DEVICE_PLATFORMS). Older builds don't send it, and the receiver
    // drops a value it doesn't know, so neither side refuses the other over it.
    readonly platform?: string;
};

// One ongoing file, from the point of view of the device that sends the sync (§7.4 step 2).
export type SyncEntry = {
    readonly fileId: string;
    readonly direction: Direction;
    readonly name: string;
    readonly size: number;
    readonly pageSize: number;
    readonly totalPages: number;
    readonly pagesDone: number;
    readonly prefixHash?: string;
    readonly state: FileState;
    // Paused by the user on that device; the other side doesn't resume it.
    readonly held?: boolean;
    // Stopped with its batch on that device (Stop): only Resume moves it again. A device that missed the Stop,
    // because the link was down, stops the file's batch too.
    readonly stopped?: boolean;
};

export type SyncMessage = {
    readonly t: 'sync';
    readonly files: readonly SyncEntry[];
    readonly index: number;
    readonly last: boolean;
};

export type NameMessage = { readonly t: 'name'; readonly name: string };

// Start fresh: the device that chose it cleared the session, and the other clears its copy too.
export type SessionResetMessage = { readonly t: 'session-reset'; readonly sessionId: string };

export type LogMessage = { readonly t: 'log'; readonly entries: readonly LogEntry[] };

// A thumbnail, or `none` when the sender could not make one, so the receiver makes its own without waiting.
export type ThumbMessage = { readonly t: 'thumb'; readonly fileId: string; readonly jpeg?: string; readonly none?: boolean };

export type OfferMessage = FileManifest & {
    readonly t: 'offer';
    readonly id: string;
    readonly resume?: boolean;
    // The sender found the receiver's saved pages don't match: discard them and start at page 0.
    readonly restart?: boolean;
    // "Send again": skip the already-received check.
    readonly again?: boolean;
    // The user resumed this file after a Stop, or picked it again: take it even though your copy is stopped.
    readonly resumed?: boolean;
    readonly batchId?: string;
};

export type AcceptMessage = {
    readonly t: 'accept';
    readonly re: string;
    readonly fileId: string;
    readonly fromPage: number;
    readonly pageSize: number;
    readonly prefixHash?: string;
};

export type HaveMessage = {
    readonly t: 'have';
    readonly re: string;
    readonly fileId: string;
    readonly verified: boolean;
    // The receiver's rootHash and the page size it was computed with; the sender skips the file only if its own copy matches.
    readonly rootHash?: string;
    readonly pageSize?: number;
};

export type RejectMessage = {
    readonly t: 'reject';
    readonly re: string;
    readonly fileId: string;
    readonly reason: RejectReason;
    // TR-07: "needs X, has Y".
    readonly needed?: number;
    readonly free?: number;
};

// The receiver is asking its user (SP-07, BK-03): the sender stops the reply timer and waits.
export type WaitMessage = { readonly t: 'wait'; readonly re: string; readonly fileId?: string; readonly batchId?: string };

export type PageEndMessage = {
    readonly t: 'page-end';
    readonly id: string;
    readonly fileId: string;
    readonly page: number;
    readonly sha256: string;
};

export type AckMessage = { readonly t: 'ack'; readonly re: string; readonly fileId: string; readonly page: number };

export type NackMessage = { readonly t: 'nack'; readonly re: string; readonly fileId: string; readonly page: number };

export type FileEndMessage = { readonly t: 'file-end'; readonly id: string; readonly fileId: string; readonly rootHash: string };

export type DoneMessage = { readonly t: 'done'; readonly re: string; readonly fileId: string; readonly ok: boolean };

export type OfferBatchMessage = {
    readonly t: 'offer-batch';
    readonly id: string;
    readonly batchId: string;
    readonly index: number;
    readonly last: boolean;
    readonly files: readonly FileManifest[];
    // On the first message only: what the receiver's prompt shows (BK-03).
    readonly itemCount?: number;
    readonly totalBytes?: number;
    // Every file size in order, when it fits, so "Accept what fits" can count files exactly.
    readonly sizes?: readonly number[];
};

export type BatchReplyEntry = {
    readonly fileId: string;
    readonly reply: 'accept' | 'have' | 'reject';
    readonly fromPage?: number;
    // accept: the page size to send with; have: the one rootHash was computed with.
    readonly pageSize?: number;
    readonly rootHash?: string;
    readonly reason?: RejectReason;
};

export type BatchReplyMessage = {
    readonly t: 'batch-reply';
    readonly re: string;
    readonly batchId: string;
    readonly files: readonly BatchReplyEntry[];
};

// A request that could not be read at all: the sender fails what it asked for at once instead of waiting.
export type ErrorMessage = { readonly t: 'error'; readonly re: string; readonly reason: string };

export type CancelMessage = {
    readonly t: 'cancel';
    readonly fileId: string;
    // The direction of the file on the device that cancels.
    readonly direction: Direction;
    readonly keepPartial: boolean;
    readonly reason?: CancelReason;
};

// Delete what arrived: the device that does it tells the other, which cancels its files of the batch too,
// deleting their pages.
export type CancelBatchMessage = {
    readonly t: 'cancel-batch';
    readonly batchId: string;
    // The direction of the batch on the device that cancels it.
    readonly direction: Direction;
};

// Stop: the device that stops a batch tells the other, which stops its files of the batch too, keeping their pages.
export type StopBatchMessage = {
    readonly t: 'stop-batch';
    readonly batchId: string;
    // The direction of the batch on the device that stops it.
    readonly direction: Direction;
};

// Resume: the stopped files of a batch, or only `fileIds`, move again; the other device resumes its copies too.
export type ResumeBatchMessage = {
    readonly t: 'resume-batch';
    readonly batchId: string;
    // The direction of the batch on the device that resumes it.
    readonly direction: Direction;
    readonly fileIds?: readonly string[];
};

export type ControlMessage =
    | HelloMessage
    | SyncMessage
    | NameMessage
    | SessionResetMessage
    | LogMessage
    | ThumbMessage;

export type SlotMessage =
    | OfferMessage
    | AcceptMessage
    | HaveMessage
    | RejectMessage
    | WaitMessage
    | PageEndMessage
    | AckMessage
    | NackMessage
    | FileEndMessage
    | DoneMessage
    | OfferBatchMessage
    | BatchReplyMessage
    | CancelMessage
    | CancelBatchMessage
    | StopBatchMessage
    | ResumeBatchMessage
    | ErrorMessage;

export type ProtocolMessage = ControlMessage | SlotMessage;
export type MessageType = ProtocolMessage['t'];

export type ValidationResult =
    | { readonly ok: true; readonly message: ProtocolMessage }
    | { readonly ok: false; readonly reason: string };

type Check = (value: unknown) => boolean;

interface FieldSpec {
    readonly check: Check;
    readonly optional?: boolean;
}

interface MessageSpec {
    // 'any' for replies that answer a request on whichever channel it came.
    readonly channel: 'control' | 'slot' | 'any';
    readonly fields: Readonly<Record<string, FieldSpec>>;
    // Cross-field rules; returns the problem, if any.
    readonly refine?: (message: Readonly<Record<string, unknown>>) => string | undefined;
}

const isText = (max: number): Check => value => typeof value === 'string' && value.length <= max;
const isFilled = (max: number): Check => value => typeof value === 'string' && value.length > 0 && value.length <= max;
const isFileId: Check = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const isHash: Check = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isCount: Check = value => Number.isSafeInteger(value) && (value as number) >= 0;
const isFiniteNumber: Check = value => typeof value === 'number' && Number.isFinite(value);
const isPositiveNumber: Check = value => isFiniteNumber(value) && (value as number) > 0;
const isBoolean: Check = value => typeof value === 'boolean';
const isPageSize: Check = value => isCount(value) && (value as number) >= MIN_PAGE_SIZE && (value as number) <= MAX_PAGE_SIZE;
const isOneOf = (choices: readonly unknown[]): Check => value => choices.includes(value);
const isPlainObject: Check = value => value != null && typeof value === 'object' && !Array.isArray(value);
const isListOf = (check: Check, max = Number.MAX_SAFE_INTEGER): Check => value => (
    Array.isArray(value) && value.length <= max && value.every(item => check(item))
);

const required = (check: Check): FieldSpec => ({ check });
const optional = (check: Check): FieldSpec => ({ check, optional: true });

const MANIFEST_FIELDS: Readonly<Record<string, FieldSpec>> = Object.freeze({
    fileId: required(isFileId),
    contentId: optional(isFileId),
    name: required(isFilled(MAX_NAME_LENGTH)),
    size: required(isCount),
    mime: required(isText(MAX_MIME_LENGTH)),
    lastModified: required(isFiniteNumber),
    relativePath: optional(isText(MAX_PATH_LENGTH)),
    pageSize: required(isPageSize),
    totalPages: required(isCount),
    metadata: optional(isPlainObject),
    thumb: optional(isBoolean),
});

const checkManifestPages = (message: Readonly<Record<string, unknown>>): string | undefined => {
    if (message.totalPages !== countPages(message.size as number, message.pageSize as number)) {
        return 'totalPages does not match size and pageSize';
    }

    return undefined;
};

const SYNC_ENTRY_FIELDS: Readonly<Record<string, FieldSpec>> = Object.freeze({
    fileId: required(isFileId),
    direction: required(isOneOf(DIRECTIONS)),
    name: required(isFilled(MAX_NAME_LENGTH)),
    size: required(isCount),
    pageSize: required(isCount),
    totalPages: required(isCount),
    pagesDone: required(isCount),
    prefixHash: optional(isHash),
    state: required(isOneOf(FILE_STATES)),
    held: optional(isBoolean),
    stopped: optional(isBoolean),
});

const isSyncEntry: Check = value => isPlainObject(value)
    && checkFields(value as Record<string, unknown>, SYNC_ENTRY_FIELDS) === undefined
    && (value as SyncEntry).pagesDone <= (value as SyncEntry).totalPages;

const BATCH_REPLY_FIELDS: Readonly<Record<string, FieldSpec>> = Object.freeze({
    fileId: required(isFileId),
    reply: required(isOneOf(['accept', 'have', 'reject'])),
    fromPage: optional(isCount),
    pageSize: optional(isPageSize),
    rootHash: optional(isHash),
    reason: optional(isOneOf(REJECT_REASONS)),
});

const isBatchReplyEntry: Check = value => isPlainObject(value)
    && checkFields(value as Record<string, unknown>, BATCH_REPLY_FIELDS) === undefined;

const LOG_ENTRY_FIELDS: Readonly<Record<string, FieldSpec>> = Object.freeze({
    t: required(isFiniteNumber),
    wall: required(isFiniteNumber),
    level: required(isOneOf(LOG_LEVELS)),
    cat: required(isOneOf(LOG_CATEGORIES)),
    msg: required(isText(MAX_LOG_MESSAGE_LENGTH)),
});

const isLogEntry: Check = value => isPlainObject(value)
    && checkFields(value as Record<string, unknown>, LOG_ENTRY_FIELDS) === undefined;

const MESSAGE_SPECS: Readonly<Record<MessageType, MessageSpec>> = Object.freeze({
    hello: {
        channel: 'control',
        fields: {
            protocol: required(isPositiveNumber),
            deviceId: required(isFilled(MAX_ID_LENGTH)),
            name: required(isFilled(MAX_NAME_LENGTH)),
            connectionId: required(isFilled(MAX_ID_LENGTH)),
            platform: optional(isText(MAX_PLATFORM_LENGTH)),
        },
    },
    sync: {
        channel: 'control',
        fields: { files: required(isListOf(isSyncEntry)), index: required(isCount), last: required(isBoolean) },
    },
    name: { channel: 'control', fields: { name: required(isFilled(MAX_NAME_LENGTH)) } },
    'session-reset': { channel: 'control', fields: { sessionId: required(isFilled(MAX_ID_LENGTH)) } },
    log: { channel: 'control', fields: { entries: required(isListOf(isLogEntry, MAX_LOG_ENTRIES)) } },
    thumb: {
        channel: 'control',
        fields: { fileId: required(isFileId), jpeg: optional(isFilled(MAX_THUMB_BASE64_LENGTH)), none: optional(isBoolean) },
        refine: message => {
            if (message.jpeg == null) {
                return message.none === true ? undefined : 'jpeg or none is needed';
            }

            return /^[A-Za-z0-9+/]+=*$/.test(message.jpeg as string) ? undefined : 'jpeg is not base64';
        },
    },
    offer: {
        channel: 'slot',
        fields: {
            ...MANIFEST_FIELDS,
            id: required(isFilled(MAX_ID_LENGTH)),
            resume: optional(isBoolean),
            restart: optional(isBoolean),
            again: optional(isBoolean),
            resumed: optional(isBoolean),
            batchId: optional(isFilled(MAX_ID_LENGTH)),
        },
        refine: message => checkManifestPages(message) ?? checkManifestSize(message),
    },
    accept: {
        channel: 'slot',
        fields: {
            re: required(isFilled(MAX_ID_LENGTH)),
            fileId: required(isFileId),
            fromPage: required(isCount),
            pageSize: required(isPageSize),
            prefixHash: optional(isHash),
        },
    },
    have: {
        channel: 'slot',
        fields: {
            re: required(isFilled(MAX_ID_LENGTH)),
            fileId: required(isFileId),
            verified: required(isBoolean),
            rootHash: optional(isHash),
            pageSize: optional(isPageSize),
        },
    },
    reject: {
        channel: 'slot',
        fields: {
            re: required(isFilled(MAX_ID_LENGTH)),
            fileId: required(isFileId),
            reason: required(isOneOf(REJECT_REASONS)),
            needed: optional(isCount),
            free: optional(isCount),
        },
    },
    wait: {
        channel: 'slot',
        fields: {
            re: required(isFilled(MAX_ID_LENGTH)),
            fileId: optional(isFileId),
            batchId: optional(isFilled(MAX_ID_LENGTH)),
        },
    },
    'page-end': {
        channel: 'slot',
        fields: {
            id: required(isFilled(MAX_ID_LENGTH)),
            fileId: required(isFileId),
            page: required(isCount),
            sha256: required(isHash),
        },
    },
    ack: {
        channel: 'slot',
        fields: { re: required(isFilled(MAX_ID_LENGTH)), fileId: required(isFileId), page: required(isCount) },
    },
    nack: {
        channel: 'slot',
        fields: { re: required(isFilled(MAX_ID_LENGTH)), fileId: required(isFileId), page: required(isCount) },
    },
    'file-end': {
        channel: 'slot',
        fields: { id: required(isFilled(MAX_ID_LENGTH)), fileId: required(isFileId), rootHash: required(isHash) },
    },
    done: {
        channel: 'slot',
        fields: { re: required(isFilled(MAX_ID_LENGTH)), fileId: required(isFileId), ok: required(isBoolean) },
    },
    'offer-batch': {
        channel: 'slot',
        fields: {
            id: required(isFilled(MAX_ID_LENGTH)),
            batchId: required(isFilled(MAX_ID_LENGTH)),
            index: required(isCount),
            last: required(isBoolean),
            files: required(isListOf(isPlainObject)),
            itemCount: optional(isCount),
            totalBytes: optional(isCount),
            sizes: optional(isListOf(isCount)),
        },
        refine: message => checkManifestSize(message),
    },
    'batch-reply': {
        channel: 'slot',
        fields: {
            re: required(isFilled(MAX_ID_LENGTH)),
            batchId: required(isFilled(MAX_ID_LENGTH)),
            files: required(isListOf(isBatchReplyEntry)),
        },
    },
    cancel: {
        channel: 'slot',
        fields: {
            fileId: required(isFileId),
            direction: required(isOneOf(DIRECTIONS)),
            keepPartial: required(isBoolean),
            reason: optional(isOneOf(CANCEL_REASONS)),
        },
    },
    'cancel-batch': {
        channel: 'slot',
        fields: {
            batchId: required(isFilled(MAX_ID_LENGTH)),
            direction: required(isOneOf(DIRECTIONS)),
        },
    },
    'stop-batch': {
        channel: 'slot',
        fields: {
            batchId: required(isFilled(MAX_ID_LENGTH)),
            direction: required(isOneOf(DIRECTIONS)),
        },
    },
    'resume-batch': {
        channel: 'slot',
        fields: {
            batchId: required(isFilled(MAX_ID_LENGTH)),
            direction: required(isOneOf(DIRECTIONS)),
            fileIds: optional(isListOf(isFileId, MAX_RESUME_FILE_IDS)),
        },
    },
    error: {
        channel: 'any',
        fields: { re: required(isFilled(MAX_ID_LENGTH)), reason: required(isText(MAX_REASON_LENGTH)) },
    },
});

function checkManifestSize(message: Readonly<Record<string, unknown>>): string | undefined {
    if (jsonByteLength(message) > MAX_MANIFEST_BYTES) {
        return `manifest over ${MAX_MANIFEST_BYTES} bytes`;
    }

    return undefined;
}

function checkFields(message: Readonly<Record<string, unknown>>, fields: Readonly<Record<string, FieldSpec>>): string | undefined {
    for (const [name, spec] of Object.entries(fields)) {
        const value = message[name];
        if (value === undefined && spec.optional) {
            continue;
        }

        if (!spec.check(value)) {
            return `bad field ${name}`;
        }
    }

    return undefined;
}

export function isKnownMessageType(type: string): type is MessageType {
    return Object.hasOwn(MESSAGE_SPECS, type);
}

// Shape, types, sizes and ranges that need no state; known fileIds and page ranges are checked by the receiver.
export function validateMessage(channel: ChannelName, raw: Message): ValidationResult {
    if (!isKnownMessageType(raw.t)) {
        return { ok: false, reason: `unknown type ${String(raw.t).slice(0, 32)}` };
    }

    const spec = MESSAGE_SPECS[raw.t];
    const expectedChannel = channel === 'control' ? 'control' : 'slot';
    if (spec.channel !== 'any' && spec.channel !== expectedChannel) {
        return { ok: false, reason: `${raw.t} on the wrong channel` };
    }

    const problem = checkFields(raw, spec.fields) ?? spec.refine?.(raw);
    if (problem) {
        return { ok: false, reason: `${raw.t}: ${problem}` };
    }

    return { ok: true, message: raw as unknown as ProtocolMessage };
}

export function isMajorCompatible(peerVersion: number, ownVersion: number = PROTOCOL_VERSION): boolean {
    return Math.floor(peerVersion) === Math.floor(ownVersion);
}

// UTF-8 bytes of a text, as the data channel counts them: a Greek letter is two bytes, an emoji four.
export function utf8Length(text: string): number {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit < 0x80) {
            bytes += 1;
            continue;
        }

        if (unit < 0x800) {
            bytes += 2;
            continue;
        }

        const isPairStart = unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length;
        const next = isPairStart ? text.charCodeAt(index + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
            bytes += 4;
            index++;
            continue;
        }

        bytes += 3;
    }

    return bytes;
}

// The size of a value as a message on the wire, in UTF-8 bytes (NW-03 limits messages to 64 KiB).
export function jsonByteLength(value: unknown): number {
    return utf8Length(JSON.stringify(value) ?? '');
}

// What is wrong with one manifest, naming the field; undefined when it is fine.
export function validateManifest(value: unknown): string | undefined {
    if (!isPlainObject(value)) {
        return 'not an object';
    }

    const manifest = value as Readonly<Record<string, unknown>>;

    return checkFields(manifest, MANIFEST_FIELDS) ?? checkManifestPages(manifest) ?? checkManifestSize(manifest);
}

// A message that carries an id asks for a reply: the id to answer when the message can't be read.
export function requestIdOf(raw: Message): string | undefined {
    return typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_LENGTH ? raw.id : undefined;
}

// Splits peer log entries into messages under the batch budget; an entry too big alone loses its data.
export function splitLogEntries(entries: readonly LogEntry[]): LogEntry[][] {
    const budget = MAX_BATCH_MESSAGE_BYTES - 256;
    const fitting = entries.map(entry => {
        if (jsonByteLength(entry) <= budget) {
            return entry;
        }

        const { data: _, ...rest } = entry;

        return { ...rest, msg: rest.msg.slice(0, 1000) };
    });
    const chunks: LogEntry[][] = [];
    for (let start = 0; start < fitting.length;) {
        const count = countFitting(fitting.slice(start, start + MAX_LOG_ENTRIES), budget, MAX_LOG_ENTRIES);
        chunks.push(fitting.slice(start, start + count));
        start += count;
    }

    return chunks;
}

// How many items, from the start, fit in one message under the byte budget and the count limit.
export function countFitting(items: readonly unknown[], budget: number, maxCount: number): number {
    let used = 0;
    let count = 0;
    for (const item of items) {
        const length = jsonByteLength(item) + 1;
        if (count >= maxCount || (count > 0 && used + length > budget)) {
            break;
        }

        used += length;
        count++;
    }

    return count;
}

// Splits ongoing files into sync messages that each stay under the batch message budget.
export function splitSync(entries: readonly SyncEntry[]): SyncMessage[] {
    const messages: SyncMessage[] = [];
    let start = 0;
    do {
        const count = countFitting(entries.slice(start), MAX_BATCH_MESSAGE_BYTES - 256, Number.MAX_SAFE_INTEGER);
        const files = entries.slice(start, start + count);
        start += count;
        messages.push({ t: 'sync', files, index: messages.length, last: start >= entries.length });
    } while (start < entries.length);

    return messages;
}
