import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, validateFrameHeader } from './frame.js';
import { FRAME_HEADER_SIZE } from './networkTypes.js';
import type { FrameHeader } from './networkTypes.js';

const HEADER: FrameHeader = { slot: 3, page: 1312, offset: 65520, flags: 0x8001 };

describe('encodeFrame', () => {
    it('writes the 16-byte header in network byte order before the payload', () => {
        // Arrange
        const payload = Uint8Array.from([0xde, 0xad]);

        // Act
        const frame = encodeFrame(HEADER, payload);

        // Assert
        expect(Array.from(frame)).toEqual([
            1, 3, 0x80, 0x01,
            0, 0, 0x05, 0x20,
            0, 0, 0xff, 0xf0,
            0, 0, 0, 2,
            0xde, 0xad,
        ]);
    });

    it.each([
        ['slot 0', { ...HEADER, slot: 0 }],
        ['slot 5', { ...HEADER, slot: 5 }],
        ['a negative page', { ...HEADER, page: -1 }],
        ['a fractional offset', { ...HEADER, offset: 1.5 }],
        ['a page above 32 bits', { ...HEADER, page: 2 ** 32 }],
        ['flags above 16 bits', { ...HEADER, flags: 0x10000 }],
    ])('refuses %s', (_, header) => {
        // Act
        const encode = () => encodeFrame(header as FrameHeader, new Uint8Array(1));

        // Assert
        expect(encode).toThrow(RangeError);
    });
});

describe('decodeFrame', () => {
    it('round-trips the header and returns the payload as a view', () => {
        // Arrange
        const payload = Uint8Array.from({ length: 1000 }, (_, index) => index & 0xff);
        const frame = encodeFrame(HEADER, payload);

        // Act
        const decoded = decodeFrame(frame.buffer);

        // Assert
        expect(decoded?.header).toEqual(HEADER);
        expect(decoded?.payload).toEqual(payload);
        expect(decoded?.payload.buffer).toBe(frame.buffer);
    });

    it('accepts an empty payload', () => {
        // Arrange
        const frame = encodeFrame(HEADER, new Uint8Array());

        // Act
        const decoded = decodeFrame(frame.buffer);

        // Assert
        expect(decoded?.payload).toHaveLength(0);
    });

    it('returns undefined for a buffer shorter than the header', () => {
        // Act
        const decoded = decodeFrame(new ArrayBuffer(FRAME_HEADER_SIZE - 1));

        // Assert
        expect(decoded).toBeUndefined();
    });

    it('returns undefined for another version', () => {
        // Arrange
        const frame = encodeFrame(HEADER, new Uint8Array(4));
        frame[0] = 2;

        // Act
        const decoded = decodeFrame(frame.buffer);

        // Assert
        expect(decoded).toBeUndefined();
    });

    it('returns undefined for an unknown slot', () => {
        // Arrange
        const frame = encodeFrame(HEADER, new Uint8Array(4));
        frame[1] = 9;

        // Act
        const decoded = decodeFrame(frame.buffer);

        // Assert
        expect(decoded).toBeUndefined();
    });

    it('returns undefined when the payload length does not match', () => {
        // Arrange
        const frame = encodeFrame(HEADER, new Uint8Array(4));

        // Act
        const decoded = decodeFrame(frame.buffer.slice(0, frame.length - 1));

        // Assert
        expect(decoded).toBeUndefined();
    });
});

describe('validateFrameHeader', () => {
    it('accepts the largest values', () => {
        // Arrange
        const header: FrameHeader = { slot: 4, page: 2 ** 32 - 1, offset: 2 ** 32 - 1, flags: 0xffff };

        // Act
        const validate = () => validateFrameHeader(header);

        // Assert
        expect(validate).not.toThrow();
    });
});
