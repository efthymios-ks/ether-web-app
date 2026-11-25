import type { Unsubscribe } from '../core/events.js';
import type { Logger } from '../core/logger.js';

// The low-level link (§17.2): pairing by codes, five data channels, frames, health.
// It knows nothing about files, sessions, pages or storage (AR-02).

export type LinkState =
    | 'idle'
    | 'gathering'
    | 'awaiting-answer'
    | 'answering'
    | 'connecting'
    | 'connected'
    | 'lost'
    | 'closed';

export type HealthStatus = 'good' | 'weak' | 'lost';

export interface Health {
    readonly status: HealthStatus;
    readonly rttMs?: number;
    // Milliseconds since anything arrived from the peer.
    readonly lastSeenMs: number;
    readonly peerHidden: boolean;
}

export type SlotId = 1 | 2 | 3 | 4;
export const SLOT_IDS: readonly SlotId[] = Object.freeze([1, 2, 3, 4]);

export type ChannelName = 'control' | SlotId;

// JSON envelope. `id` on requests, `re` on replies.
export interface Message {
    readonly t: string;
    readonly id?: string;
    readonly re?: string;
    readonly [key: string]: unknown;
}

// 16 bytes on the wire (TR-02).
export interface FrameHeader {
    readonly slot: SlotId;
    readonly page: number;
    readonly offset: number;
    readonly flags: number;
}

export const FRAME_HEADER_SIZE = 16;
export const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

export interface NetworkTimeouts {
    readonly gatheringMs: number;
    readonly codeExpiryMs: number;
    readonly connectMs: number;
    readonly pingMs: number;
    readonly weakMs: number;
    readonly lostMs: number;
}

export interface NetworkOptions {
    // Header plus payload of one frame.
    readonly chunkSize: number;
    // Unsent bytes across all slots (TR-04).
    readonly maxBuffered: number;
    readonly timeouts: NetworkTimeouts;
    // The page address the codes are appended to: the QR is `${appUrl}#${code}` (HS-04).
    readonly appUrl: string;
    // NW-06: opens the camera so the browser shows real local IPs; resolves to "stop" or null.
    readonly exposeLocalIps?: () => Promise<(() => void) | null>;
    readonly logger: Logger;
    // Test seams; browser defaults otherwise.
    readonly environment?: Partial<NetworkEnvironment>;
}

// Everything the network takes from the browser, so tests can swap any part.
export interface NetworkEnvironment {
    createPeerConnection(configuration: RTCConfiguration): RTCPeerConnection;
    now(): number;
    wallClock(): number;
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    // Page visibility, for HC-04. Returns an unsubscribe.
    onVisibilityChange(handler: (hidden: boolean) => void): Unsubscribe;
    isHidden(): boolean;
    // HC-06: bye on pagehide.
    onPageHide(handler: () => void): Unsubscribe;
    randomBytes(length: number): Uint8Array;
}

export interface PairingCode {
    readonly code: string;
    readonly url: string;
    readonly expiresAt: number;
}

export interface AnswerCode {
    readonly code: string;
    readonly url: string;
}

export type CodeKind = 'offer' | 'answer';

// What a code holds without a peer connection, e.g. to route an answer scanned in a new tab (HS-07).
export interface CodeSummary {
    readonly kind: CodeKind;
    readonly version: number;
    // The code alone, normalised (upper case, no spaces or dashes), even when a URL was given.
    readonly code: string;
    // Epoch milliseconds, from the creating device's clock.
    readonly createdAt?: number;
    readonly candidateCount: number;
}

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

export interface CandidateInfo {
    readonly type: CandidateType;
    readonly protocol: string;
    // An IP address or a `.local` name.
    readonly address: string;
    readonly port: number;
}

export type CandidatePairState = 'waiting' | 'in-progress' | 'succeeded' | 'failed' | 'frozen';

// One row of the IP matching table (DL-06).
export interface CandidatePairStats {
    readonly id: string;
    readonly local: CandidateInfo;
    readonly remote: CandidateInfo;
    readonly state: CandidatePairState;
    readonly nominated: boolean;
    readonly selected: boolean;
    readonly rttMs?: number;
    readonly bytesSent: number;
    readonly bytesReceived: number;
}

export type NetworkErrorCode =
    | 'code-invalid'
    | 'code-expired'
    | 'code-version'
    | 'code-used'
    | 'gathering-timeout'
    | 'connect-timeout'
    | 'ice-failed'
    | 'channel-closed'
    | 'message-too-large'
    | 'send-failed'
    | 'closed';

export class NetworkError extends Error {
    override readonly name = 'NetworkError';

    constructor(
        readonly code: NetworkErrorCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

export interface NetworkEvents {
    state(state: LinkState): void;
    health(health: Health): void;
    message(channel: ChannelName, message: Message): void;
    frame(header: FrameHeader, payload: Uint8Array): void;
    error(error: NetworkError): void;
}

export interface Network {
    // Pairing (§3).
    createOfferAsync(): Promise<PairingCode>;
    // Returns the answer to show as a QR.
    acceptOfferAsync(codeOrUrl: string): Promise<AnswerCode>;
    // Resolves when connected.
    acceptAnswerAsync(codeOrUrl: string): Promise<void>;

    // Messaging. Both throw NetworkError (channel-closed, message-too-large, send-failed); nothing is dropped silently.
    send(channel: ChannelName, message: Message): void;
    sendFrame(header: FrameHeader, payload: Uint8Array): void;
    // Resolves when the slot is below its share of maxBuffered (TR-04).
    waitDrainedAsync(slot: SlotId): Promise<void>;
    bufferedAmount(channel: ChannelName): number;

    readonly state: LinkState;
    readonly health: Health;
    readonly maxMessageSize: number;
    // SP-02: 4 characters derived from both DTLS fingerprints, the same on both devices once connected.
    readonly checkCode: string | undefined;
    // The largest payload sendFrame accepts with the current options and link.
    readonly maxFramePayload: number;

    getStatsAsync(): Promise<CandidatePairStats[]>;
    configure(options: Partial<Omit<NetworkOptions, 'logger' | 'environment'>>): void;
    // NW-07: sends bye when it can and leaves the instance unusable.
    close(reason?: string): void;
    on<Name extends keyof NetworkEvents>(name: Name, handler: NetworkEvents[Name]): Unsubscribe;
}

export type CreateNetwork = (options: NetworkOptions) => Network;
