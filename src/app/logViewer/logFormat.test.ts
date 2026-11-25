import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../core/logger.js';
import { entryDetails, formatLine, formatOffset, peerLabel, safeStringify, tokenizeJson } from './logFormat.js';

const ENTRY: LogEntry = {
    t: 9902,
    wall: Date.UTC(2026, 10, 23, 13, 2, 9, 902),
    level: 'info',
    cat: 'pairs',
    msg: '192.168.1.23:52344 ↔ 192.168.1.41:60111 in-progress',
};

describe('formatLine', () => {
    it('matches the §16.7 layout', () => {
        // Act & Assert
        expect(formatOffset(10010)).toBe('+10.010');
        expect(formatLine(ENTRY)).toBe('+9.902  pairs  info  192.168.1.23:52344 ↔ 192.168.1.41:60111 in-progress');
        expect(formatLine({ ...ENTRY, t: 10031, cat: 'resume', msg: 'peer sync' })).toBe('+10.031 resume info  peer sync');
    });

    it('adds the peer label and, for exports, the data', () => {
        // Arrange
        const entry = { ...ENTRY, peer: 'peer-1', data: { rttMs: 4 } };

        // Act
        const line = formatLine(entry, { peerName: 'Pixel 8', withData: true });

        // Assert
        expect(line).toBe('+9.902  pairs  info  [Pixel 8] 192.168.1.23:52344 ↔ 192.168.1.41:60111 in-progress {"rttMs":4}');
    });
});

describe('peerLabel', () => {
    it('shows the peer name for entries from the peer (DL-15)', () => {
        // Arrange
        const peer = { deviceId: 'peer-1', name: 'Pixel 8', displayName: 'Pixel 8 (8f2c)' };

        // Act & Assert
        expect(peerLabel({ ...ENTRY, peer: 'peer-1' }, peer)).toBe('Pixel 8 (8f2c)');
        expect(peerLabel({ ...ENTRY, peer: 'Old phone' }, peer)).toBe('Old phone');
        expect(peerLabel(ENTRY, peer)).toBeUndefined();
    });
});

describe('entryDetails', () => {
    it('lists every field that is set, with ISO wall time', () => {
        // Act
        const details = entryDetails({ ...ENTRY, fileId: 'f1', page: 3 });

        // Assert
        expect(details).toEqual({
            t: 9902,
            wall: '2026-11-23T13:02:09.902Z',
            level: 'info',
            cat: 'pairs',
            msg: ENTRY.msg,
            fileId: 'f1',
            page: 3,
        });
    });
});

describe('safeStringify', () => {
    it('survives cycles and bigints', () => {
        // Arrange
        const value: Record<string, unknown> = { size: 10n };
        value.self = value;

        // Act
        const text = safeStringify(value);

        // Assert
        expect(text).toBe('{"size":"10n","self":"[circular]"}');
    });
});

describe('tokenizeJson', () => {
    it('splits keys, strings, numbers, booleans and null', () => {
        // Act
        const tokens = tokenizeJson('{"a": "x", "b": 1.5, "c": true, "d": null}').filter(token => token.kind !== 'space');

        // Assert
        expect(tokens.map(token => `${token.kind}:${token.text}`)).toEqual([
            'punct:{',
            'key:"a"',
            'punct::',
            'string:"x"',
            'punct:,',
            'key:"b"',
            'punct::',
            'number:1.5',
            'punct:,',
            'key:"c"',
            'punct::',
            'boolean:true',
            'punct:,',
            'key:"d"',
            'punct::',
            'null:null',
            'punct:}',
        ]);
    });

    it('keeps every character', () => {
        // Arrange
        const text = safeStringify({ msg: 'quote " and \\ slash', list: [1, -2e3] }, 2);

        // Act
        const joined = tokenizeJson(text).map(token => token.text).join('');

        // Assert
        expect(joined).toBe(text);
    });
});
