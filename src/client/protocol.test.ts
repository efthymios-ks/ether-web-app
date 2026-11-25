import { describe, expect, it } from 'vitest';
import type { Message } from '../network/networkTypes.js';
import {
    MAX_BATCH_MESSAGE_BYTES,
    PROTOCOL_VERSION,
    countFitting,
    isMajorCompatible,
    jsonByteLength,
    splitLogEntries,
    splitSync,
    utf8Length,
    validateManifest,
    validateMessage,
} from './protocol.js';
import type { LogEntry } from '../core/logger.js';
import type { SyncEntry } from './protocol.js';

const FILE_ID = '0123456789abcdef0123456789abcdef';
const HASH = 'a'.repeat(64);

const MANIFEST = Object.freeze({
    fileId: FILE_ID,
    name: 'IMG_2231.MOV',
    size: 3 * 1024 * 1024,
    mime: 'video/quicktime',
    lastModified: 1_700_000_000_000,
    pageSize: 1024 * 1024,
    totalPages: 3,
});

describe('validateMessage', () => {
    it.each<[string, 'control' | 1, Message]>([
        ['hello', 'control', { t: 'hello', protocol: 1, deviceId: 'device', name: 'Pixel 8', connectionId: 'c-1' }],
        ['hello with a platform', 'control', { t: 'hello', protocol: 1, deviceId: 'device', name: 'Pixel 8', connectionId: 'c-1', platform: 'Android' }],
        ['hello with a platform this build does not know', 'control', { t: 'hello', protocol: 1, deviceId: 'd', name: 'W', connectionId: 'c', platform: 'Watch' }],
        ['offer', 1, { t: 'offer', id: 'r1', ...MANIFEST, resume: true }],
        ['accept', 1, { t: 'accept', re: 'r1', fileId: FILE_ID, fromPage: 0, pageSize: 1024 * 1024 }],
        ['page-end', 1, { t: 'page-end', id: 'r2', fileId: FILE_ID, page: 2, sha256: HASH }],
        ['ack', 1, { t: 'ack', re: 'r2', fileId: FILE_ID, page: 2 }],
        ['file-end', 1, { t: 'file-end', id: 'r3', fileId: FILE_ID, rootHash: HASH }],
        ['offer-batch', 1, { t: 'offer-batch', id: 'r4', batchId: 'b', index: 0, last: true, files: [MANIFEST], itemCount: 1, totalBytes: MANIFEST.size }],
        ['batch-reply', 1, { t: 'batch-reply', re: 'r4', batchId: 'b', files: [{ fileId: FILE_ID, reply: 'accept', fromPage: 0, pageSize: 1024 * 1024 }] }],
        ['thumb', 'control', { t: 'thumb', fileId: FILE_ID, jpeg: 'AAAA' }],
        ['thumb without one', 'control', { t: 'thumb', fileId: FILE_ID, none: true }],
        ['cancel', 1, { t: 'cancel', fileId: FILE_ID, direction: 'in', keepPartial: true, reason: 'storage-full' }],
        ['error on a slot', 1, { t: 'error', re: 'r1', reason: 'offer: bad field mime' }],
        ['error on control', 'control', { t: 'error', re: 'r1', reason: 'sync: bad field files' }],
        ['session-reset', 'control', { t: 'session-reset', sessionId: 'b41f9e0c2a7d4e11a0c3f5d6e7a8b9c0' }],
        ['offer-batch with one broken manifest (checked per file)', 1, { t: 'offer-batch', id: 'r5', batchId: 'b', index: 0, last: true, files: [MANIFEST, { ...MANIFEST, totalPages: 9 }] }],
    ])('accepts a well-formed %s', (_, channel, message) => {
        // Act
        const result = validateMessage(channel, message);

        // Assert
        expect(result.ok).toBe(true);
    });

    it.each<[string, 'control' | 1, Message, string]>([
        ['an unknown type', 'control', { t: 'teleport' }, 'unknown type teleport'],
        ['a hello platform that is not text', 'control', { t: 'hello', protocol: 1, deviceId: 'd', name: 'A', connectionId: 'c', platform: 7 }, 'hello: bad field platform'],
        ['a slot message on control', 'control', { t: 'ack', re: 'r', fileId: FILE_ID, page: 0 }, 'ack on the wrong channel'],
        ['a bad fileId', 1, { t: 'ack', re: 'r', fileId: 'nope', page: 0 }, 'ack: bad field fileId'],
        ['a negative page', 1, { t: 'nack', re: 'r', fileId: FILE_ID, page: -1 }, 'nack: bad field page'],
        ['a name over 255 characters', 1, { t: 'offer', id: 'r', ...MANIFEST, name: 'x'.repeat(256) }, 'offer: bad field name'],
        ['totalPages that do not match', 1, { t: 'offer', id: 'r', ...MANIFEST, totalPages: 4 }, 'offer: totalPages does not match size and pageSize'],
        ['a manifest over 64 KiB', 1, { t: 'offer', id: 'r', ...MANIFEST, metadata: { description: 'x'.repeat(70_000) } }, 'offer: manifest over 65536 bytes'],
        ['a manifest over 64 KiB of UTF-8 but not of characters', 1, { t: 'offer', id: 'r', ...MANIFEST, metadata: { description: 'Ω'.repeat(40_000) } }, 'offer: manifest over 65536 bytes'],
        ['an error reply without its reason', 1, { t: 'error', re: 'r1' }, 'error: bad field reason'],
        ['a thumbnail that is not base64', 'control', { t: 'thumb', fileId: FILE_ID, jpeg: '<svg>' }, 'thumb: jpeg is not base64'],
        ['a thumbnail message with neither jpeg nor none', 'control', { t: 'thumb', fileId: FILE_ID }, 'thumb: jpeg or none is needed'],
        ['a sync entry past its total', 'control', {
            t: 'sync',
            index: 0,
            last: true,
            files: [{ fileId: FILE_ID, direction: 'in', name: 'a', size: 1, pageSize: 1, totalPages: 1, pagesDone: 2, state: 'paused' }],
        }, 'sync: bad field files'],
        ['a session-reset on a slot', 1, { t: 'session-reset', sessionId: 'b41f9e0c2a7d4e11a0c3f5d6e7a8b9c0' }, 'session-reset on the wrong channel'],
        ['a session-reset without its session', 'control', { t: 'session-reset' }, 'session-reset: bad field sessionId'],
        ['a session-reset with an empty session', 'control', { t: 'session-reset', sessionId: '' }, 'session-reset: bad field sessionId'],
    ])('rejects %s', (_, channel, message, reason) => {
        // Act
        const result = validateMessage(channel, message);

        // Assert
        expect(result).toEqual({ ok: false, reason });
    });
});

describe('isMajorCompatible', () => {
    it('accepts minor differences and refuses another major version', () => {
        // Act
        const results = [isMajorCompatible(PROTOCOL_VERSION + 0.3), isMajorCompatible(PROTOCOL_VERSION + 1)];

        // Assert
        expect(results).toEqual([true, false]);
    });
});

describe('splitSync', () => {
    it('keeps every sync message under the batch budget and marks the last one', () => {
        // Arrange
        const entries: SyncEntry[] = Array.from({ length: 900 }, (_, index) => ({
            fileId: index.toString(16).padStart(32, '0'),
            direction: 'out',
            name: `IMG_${index}.JPG`,
            size: 3_000_000,
            pageSize: 1024 * 1024,
            totalPages: 3,
            pagesDone: 1,
            prefixHash: HASH,
            state: 'paused',
        }));

        // Act
        const messages = splitSync(entries);

        // Assert
        expect(messages.length).toBeGreaterThan(1);
        expect(messages.every(message => JSON.stringify(message).length < MAX_BATCH_MESSAGE_BYTES)).toBe(true);
        expect(messages.map(message => message.last)).toEqual([...messages.slice(1).map(() => false), true]);
        expect(messages.flatMap(message => message.files)).toHaveLength(900);
    });

    it('sends one empty message when nothing is ongoing', () => {
        // Act
        const messages = splitSync([]);

        // Assert
        expect(messages).toEqual([{ t: 'sync', files: [], index: 0, last: true }]);
    });
});

describe('countFitting', () => {
    it('stops at the count limit and at the byte budget, but always takes one item', () => {
        // Arrange
        const items = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)];

        // Act
        const results = [countFitting(items, 1000, 2), countFitting(items, 25, 10), countFitting(items, 1, 10)];

        // Assert
        expect(results).toEqual([2, 1, 1]);
    });
});

describe('UTF-8 sizes', () => {
    it('counts bytes as the data channel does', () => {
        // Act
        const lengths = [utf8Length('abc'), utf8Length('Ωμέγα'), utf8Length('€'), utf8Length('🎵'), utf8Length('a🎵b')];

        // Assert
        expect(lengths).toEqual([3, 10, 3, 4, 6]);
        expect(jsonByteLength({ name: 'Ωμέγα' })).toBe(new TextEncoder().encode(JSON.stringify({ name: 'Ωμέγα' })).byteLength);
    });

    it('fits Greek-named items by bytes, not by characters', () => {
        // Arrange
        const items = Array.from({ length: 100 }, () => ({ name: 'Ω'.repeat(400) }));

        // Act
        const count = countFitting(items, 10_000, 1000);

        // Assert
        expect(count).toBe(12);
        expect(jsonByteLength(items.slice(0, count))).toBeLessThanOrEqual(10_000);
    });

    it('splits peer log entries by bytes and trims an entry too big alone', () => {
        // Arrange
        const entry = (msg: string, data?: unknown): LogEntry => ({ t: 1, wall: 2, level: 'info', cat: 'resume', msg, ...(data === undefined ? {} : { data }) });
        const entries = [...Array.from({ length: 60 }, () => entry('Ω'.repeat(2000))), entry('huge', { blob: 'x'.repeat(100_000) })];

        // Act
        const chunks = splitLogEntries(entries);

        // Assert
        expect(chunks.flat()).toHaveLength(61);
        expect(chunks.every(chunk => jsonByteLength({ t: 'log', entries: chunk }) < MAX_BATCH_MESSAGE_BYTES)).toBe(true);
        expect(chunks.flat().at(-1)).not.toHaveProperty('data');
    });
});

describe('validateManifest', () => {
    it('names the field that is wrong', () => {
        // Act
        const problems = [
            validateManifest(MANIFEST),
            validateManifest({ ...MANIFEST, name: '' }),
            validateManifest({ ...MANIFEST, size: -1 }),
            validateManifest('text'),
            validateManifest({ ...MANIFEST, contentId: 'c'.repeat(32) }),
            validateManifest({ ...MANIFEST, contentId: 'not-an-id' }),
        ];

        // Assert
        expect(problems).toEqual([undefined, 'bad field name', 'bad field size', 'not an object', undefined, 'bad field contentId']);
    });
});
