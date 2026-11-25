import { FRAME_HEADER_SIZE, SLOT_IDS } from './networkTypes.js';
import type { FrameHeader } from './networkTypes.js';

// Binary frame (TR-02), big-endian, layout in docs/Network.md:
// version u8 · slot u8 · flags u16 · page u32 · offset in page u32 · payload length u32 · payload.

export const FRAME_VERSION = 1;

export interface DecodedFrame {
    readonly header: FrameHeader;
    readonly payload: Uint8Array;
}

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const OFFSETS = Object.freeze({
    version: 0,
    slot: 1,
    flags: 2,
    page: 4,
    offset: 8,
    payloadLength: 12,
});

// Throws RangeError: a bad header is a bug in the caller, not a network condition.
export function validateFrameHeader(header: FrameHeader): void {
    if (!SLOT_IDS.includes(header.slot)) {
        throw new RangeError(`Frame slot ${header.slot} is not 1–4`);
    }

    if (!isUnsigned(header.page, MAX_UINT32) || !isUnsigned(header.offset, MAX_UINT32)) {
        throw new RangeError('Frame page and offset must be 32-bit unsigned integers');
    }

    if (!isUnsigned(header.flags, MAX_UINT16)) {
        throw new RangeError('Frame flags must be a 16-bit unsigned integer');
    }
}

export function encodeFrame(header: FrameHeader, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    validateFrameHeader(header);

    const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint8(OFFSETS.version, FRAME_VERSION);
    view.setUint8(OFFSETS.slot, header.slot);
    view.setUint16(OFFSETS.flags, header.flags);
    view.setUint32(OFFSETS.page, header.page);
    view.setUint32(OFFSETS.offset, header.offset);
    view.setUint32(OFFSETS.payloadLength, payload.byteLength);
    frame.set(payload, FRAME_HEADER_SIZE);

    return frame;
}

// Returns undefined for anything that is not a well-formed frame; the payload is a view, not a copy.
export function decodeFrame(data: ArrayBuffer): DecodedFrame | undefined {
    if (data.byteLength < FRAME_HEADER_SIZE) {
        return undefined;
    }

    const view = new DataView(data);
    const slot = SLOT_IDS.find(id => id === view.getUint8(OFFSETS.slot));
    const payloadLength = view.getUint32(OFFSETS.payloadLength);
    if (view.getUint8(OFFSETS.version) !== FRAME_VERSION || slot == null) {
        return undefined;
    }

    if (payloadLength !== data.byteLength - FRAME_HEADER_SIZE) {
        return undefined;
    }

    return {
        header: {
            slot,
            page: view.getUint32(OFFSETS.page),
            offset: view.getUint32(OFFSETS.offset),
            flags: view.getUint16(OFFSETS.flags),
        },
        payload: new Uint8Array(data, FRAME_HEADER_SIZE, payloadLength),
    };
}

function isUnsigned(value: number, maximum: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= maximum;
}
