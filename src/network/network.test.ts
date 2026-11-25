import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../core/logger.js';
import type { LogEntry } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { decodeBase32, encodeBase32 } from './base32.js';
import { connectFakePeers, createFakeEnvironment, FAKE_WALL_START, FakeClock } from './fakeEnvironment.js';
import type { FakeEnvironment, FakeGathering, FakePeerConnection, FakeProfile } from './fakeEnvironment.js';
import { encodeFrame } from './frame.js';
import { createNetwork, inspectCode } from './network.js';
import { NetworkError } from './networkTypes.js';
import type {
    FrameHeader,
    Health,
    LinkState,
    Message,
    Network,
    NetworkOptions,
    NetworkTimeouts,
} from './networkTypes.js';
import { parseSdp } from './sdp.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const HEADER: FrameHeader = { slot: 1, page: 0, offset: 0, flags: 0 };

const TIMEOUTS: NetworkTimeouts = {
    gatheringMs: 3000,
    codeExpiryMs: 120_000,
    connectMs: 15_000,
    pingMs: 2000,
    weakMs: 6000,
    lostMs: 10_000,
};

const PROFILE_A: FakeProfile = {
    iceUfrag: 'x9cK',
    icePwd: 'fJ4o0P2q7vG2nW+3bLk/XyZa',
    fingerprint: Uint8Array.from({ length: 32 }, (_, index) => index * 7),
    mid: '0',
    candidates: [
        { address: '192.168.1.23', port: 52344 },
        { address: '3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local', port: 52345 },
    ],
};

const PROFILE_B: FakeProfile = {
    iceUfrag: 'Qm7T',
    icePwd: 'Zr0bH5kVd2yWq9Lx/Ae+1sGu',
    fingerprint: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
    mid: '0',
    candidates: [{ address: '192.168.1.41', port: 60111 }],
};

interface Side {
    readonly network: Network;
    readonly fake: FakeEnvironment;
    readonly states: LinkState[];
    readonly healths: Health[];
    readonly errors: NetworkError[];
    readonly messages: [string, Message][];
    readonly frames: [FrameHeader, Uint8Array][];
    entries(): LogEntry[];
    connection(): FakePeerConnection;
}

interface SideOptions {
    readonly clock?: FakeClock;
    readonly profile?: FakeProfile;
    readonly gathering?: FakeGathering;
    readonly options?: Partial<NetworkOptions>;
}

function createSide(sideOptions: SideOptions = {}): Side {
    const clock = sideOptions.clock ?? new FakeClock();
    const memory = createMemorySink(1000);
    const { logger } = createLogger({
        sinks: [memory],
        routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
        now: clock.now,
    });
    const fake = createFakeEnvironment({
        clock,
        profile: sideOptions.profile ?? PROFILE_A,
        ...(sideOptions.gathering == null ? {} : { gathering: sideOptions.gathering }),
    });
    const network = createNetwork({
        chunkSize: 64 * KIB,
        maxBuffered: 4 * MIB,
        timeouts: TIMEOUTS,
        appUrl: 'https://example.github.io/ether-web-app/',
        logger,
        environment: fake.environment,
        ...sideOptions.options,
    });
    const side: Side = {
        network,
        fake,
        states: [],
        healths: [],
        errors: [],
        messages: [],
        frames: [],
        entries: () => memory.entries(),
        connection: () => {
            const connection = fake.peerConnections[0];
            if (connection == null) {
                throw new Error('no peer connection yet');
            }

            return connection;
        },
    };
    network.on('state', state => side.states.push(state));
    network.on('health', health => side.healths.push(health));
    network.on('error', error => side.errors.push(error));
    network.on('message', (channel, message) => side.messages.push([String(channel), message]));
    network.on('frame', (header, payload) => side.frames.push([header, payload]));

    return side;
}

function createPair(): { clock: FakeClock; offerer: Side; answerer: Side } {
    const clock = new FakeClock();

    return {
        clock,
        offerer: createSide({ clock, profile: PROFILE_A }),
        answerer: createSide({ clock, profile: PROFILE_B }),
    };
}

async function flushAsync(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

async function pairAsync(offerer: Side, answerer: Side): Promise<{ offerCode: string; answerCode: string }> {
    const offer = await offerer.network.createOfferAsync();
    const answer = await answerer.network.acceptOfferAsync(offer.url);
    const connecting = offerer.network.acceptAnswerAsync(answer.code);
    await flushAsync();
    connectFakePeers(offerer.connection(), answerer.connection());
    await connecting;
    await flushAsync();

    return { offerCode: offer.code, answerCode: answer.code };
}

async function connectedPairAsync() {
    const pair = createPair();
    const codes = await pairAsync(pair.offerer, pair.answerer);

    return { ...pair, ...codes };
}

async function expectNetworkErrorAsync(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    await expect(promise).rejects.toMatchObject({ code });
}

function expectNetworkError(action: () => unknown, code: string): void {
    expect(action).toThrow(NetworkError);
    try {
        action();
    } catch (error) {
        expect((error as NetworkError).code).toBe(code);
    }
}

function withFirstByte(code: string, value: number): string {
    const bytes = decodeBase32(code) ?? new Uint8Array();
    bytes[0] = value;

    return encodeBase32(bytes);
}

describe('createNetwork pairing', () => {
    it('creates five negotiated channels before the offer, without ICE servers (HS-01, NW-01)', async () => {
        // Arrange
        const side = createSide();

        // Act
        await side.network.createOfferAsync();

        // Assert
        const connection = side.connection();
        expect(connection.configuration).toEqual({ iceServers: [] });
        expect(connection.calls.slice(0, 6)).toEqual([
            'createDataChannel control 0',
            'createDataChannel slot1 1',
            'createDataChannel slot2 2',
            'createDataChannel slot3 3',
            'createDataChannel slot4 4',
            'createOffer',
        ]);
        expect(connection.channels.map(channel => [channel.negotiated, channel.binaryType])).toEqual(
            new Array(5).fill([true, 'arraybuffer']),
        );
    });

    it('returns the offer as a code and an app URL, then awaits the answer', async () => {
        // Arrange
        const side = createSide();

        // Act
        const offer = await side.network.createOfferAsync();

        // Assert
        expect(offer.url).toBe(`https://example.github.io/ether-web-app/#${offer.code}`);
        expect(offer.expiresAt).toBe(FAKE_WALL_START + TIMEOUTS.codeExpiryMs);
        expect(side.states).toEqual(['gathering', 'awaiting-answer']);
        expect(inspectCode(offer.url)).toEqual({
            kind: 'offer',
            version: 1,
            code: offer.code,
            createdAt: FAKE_WALL_START,
            candidateCount: 2,
        });
    });

    it('opens the camera hook before gathering and stops it once gathering ends (HS-05, NW-06)', async () => {
        // Arrange
        const events: string[] = [];
        const clock = new FakeClock();
        const holder: { side?: Side } = {};
        const exposeLocalIps = vi.fn(async () => {
            events.push(`hook, connections: ${holder.side?.fake.peerConnections.length}`);

            return () => events.push(`stop, gathering: ${holder.side?.connection().iceGatheringState}`);
        });
        holder.side = createSide({ clock, options: { exposeLocalIps } });

        // Act
        await holder.side.network.createOfferAsync();

        // Assert
        expect(events).toEqual(['hook, connections: 0', 'stop, gathering: complete']);
        const messages = holder.side.entries().map(entry => entry.msg);
        expect(messages).toContain('camera permission: granted (real local IPs exposed)');
    });

    it('continues with .local names when the camera hook is denied', async () => {
        // Arrange
        const side = createSide({ options: { exposeLocalIps: async () => null } });

        // Act
        const offer = await side.network.createOfferAsync();

        // Assert
        expect(offer.code).not.toBe('');
        const messages = side.entries().map(entry => entry.msg);
        expect(messages).toContain('camera permission: denied or unavailable (.local names)');
    });

    it('uses what was gathered when gathering reaches its cap (HS-02)', async () => {
        // Arrange
        const side = createSide({ gathering: 'hang' });
        const creating = side.network.createOfferAsync();
        await flushAsync();

        // Act
        side.fake.clock.advance(TIMEOUTS.gatheringMs);
        const offer = await creating;

        // Assert
        expect(inspectCode(offer.code).candidateCount).toBe(2);
        expect(side.entries().map(entry => entry.msg)).toContain('gathering capped at 3000 ms');
    });

    it('fails with gathering-timeout when no address was gathered', async () => {
        // Arrange
        const side = createSide({ profile: { ...PROFILE_A, candidates: [] } });

        // Act
        const creating = side.network.createOfferAsync();

        // Assert
        await expectNetworkErrorAsync(creating, 'gathering-timeout');
        expect(side.network.state).toBe('closed');
        expect(side.errors).toEqual([]);
    });

    it('answers an offer by rebuilding the full description from the code', async () => {
        // Arrange
        const { offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();

        // Act
        const answer = await answerer.network.acceptOfferAsync(offer.url);

        // Assert
        const remote = answerer.connection().remoteDescription;
        expect(remote?.type).toBe('offer');
        expect(parseSdp(remote?.sdp ?? '')).toMatchObject({
            iceUfrag: PROFILE_A.iceUfrag,
            icePwd: PROFILE_A.icePwd,
            fingerprint: PROFILE_A.fingerprint,
            setup: 'actpass',
            mid: '0',
        });
        expect(inspectCode(answer.url).kind).toBe('answer');
        expect(answerer.states).toEqual(['answering', 'connecting']);
    });

    it('rejects an answer code given as an offer and stays idle', async () => {
        // Arrange
        const { offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();
        const answer = await answerer.network.acceptOfferAsync(offer.code);
        const third = createSide();

        // Act
        const accepting = third.network.acceptOfferAsync(answer.code);

        // Assert
        await expectNetworkErrorAsync(accepting, 'code-invalid');
        expect(third.network.state).toBe('idle');
    });

    it('rejects another version with code-version and garbage with code-invalid (HS-04)', async () => {
        // Arrange
        const { offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();

        // Act
        const newer = answerer.network.acceptOfferAsync(withFirstByte(offer.code, 0xe2));
        const garbage = answerer.network.acceptOfferAsync('hello, world');

        // Assert
        await expectNetworkErrorAsync(newer, 'code-version');
        await expectNetworkErrorAsync(garbage, 'code-invalid');
    });

    it('rejects an expired offer, allowing a minute of clock skew (HS-08)', async () => {
        // Arrange
        const { clock, offerer } = createPair();
        const offer = await offerer.network.createOfferAsync();
        const late = createSide({ clock, profile: PROFILE_B });
        const tooLate = createSide({ clock, profile: PROFILE_B });

        // Act
        clock.advance(TIMEOUTS.codeExpiryMs + 59_000);
        const accepted = late.network.acceptOfferAsync(offer.code);
        clock.advance(2000);
        // Checked at once, so the refusal never sits unhandled while the other side finishes.
        const refused = expectNetworkErrorAsync(tooLate.network.acceptOfferAsync(offer.code), 'code-expired');

        // Assert
        await expect(accepted).resolves.toMatchObject({ code: expect.any(String) });
        await refused;
    });

    it('connects both sides with the same check code (SP-02)', async () => {
        // Act
        const { offerer, answerer } = await connectedPairAsync();

        // Assert
        expect(offerer.states).toEqual(['gathering', 'awaiting-answer', 'connecting', 'connected']);
        expect(answerer.states).toEqual(['answering', 'connecting', 'connected']);
        expect(offerer.network.checkCode).toMatch(/^[A-Z2-7]{4}$/);
        expect(answerer.network.checkCode).toBe(offerer.network.checkCode);
        expect(offerer.network.maxMessageSize).toBe(262144);
        expect(offerer.network.maxFramePayload).toBe(64 * KIB - 16);
    });

    it('applies the answer as a rebuilt description of type answer', async () => {
        // Act
        const { offerer } = await connectedPairAsync();

        // Assert
        const remote = offerer.connection().remoteDescription;
        expect(remote?.type).toBe('answer');
        expect(parseSdp(remote?.sdp ?? '')).toMatchObject({ iceUfrag: PROFILE_B.iceUfrag, setup: 'active' });
    });

    it('rejects a second answer with code-used (HS-08, HC-07)', async () => {
        // Arrange
        const { offerer, answerCode } = await connectedPairAsync();

        // Act
        const second = offerer.network.acceptAnswerAsync(answerCode);

        // Assert
        await expectNetworkErrorAsync(second, 'code-used');
    });

    it('expires an unanswered offer and rejects a late answer with code-expired', async () => {
        // Arrange
        const { clock, offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();
        const answer = await answerer.network.acceptOfferAsync(offer.code);

        // Act
        clock.advance(TIMEOUTS.codeExpiryMs);
        const late = offerer.network.acceptAnswerAsync(answer.code);

        // Assert
        await expectNetworkErrorAsync(late, 'code-expired');
        expect(offerer.errors.map(error => error.code)).toEqual(['code-expired']);
        expect(offerer.network.state).toBe('closed');
    });

    it('keeps waiting for another answer when the browser refuses one', async () => {
        // Arrange
        const { offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();
        const answer = await answerer.network.acceptOfferAsync(offer.code);
        offerer.connection().refusesRemote = true;

        // Act
        const refused = offerer.network.acceptAnswerAsync(answer.code);

        // Assert
        await expectNetworkErrorAsync(refused, 'code-invalid');
        expect(offerer.network.state).toBe('awaiting-answer');
    });

    it('refuses an answer made for another code and keeps waiting for its own', async () => {
        // Arrange
        const { clock, offerer, answerer } = createPair();
        const otherOfferer = createSide({ clock, profile: { ...PROFILE_A, iceUfrag: 'Ot7h' } });
        const otherAnswerer = createSide({ clock, profile: PROFILE_B });
        const offer = await offerer.network.createOfferAsync();
        const otherOffer = await otherOfferer.network.createOfferAsync();
        const answer = await answerer.network.acceptOfferAsync(offer.code);
        const strayAnswer = await otherAnswerer.network.acceptOfferAsync(otherOffer.code);

        // Act
        const stray = offerer.network.acceptAnswerAsync(strayAnswer.code);
        await expect(stray).rejects.toMatchObject({
            code: 'code-invalid',
            message: 'This answer belongs to another code. Scan the answer shown for this code.',
        });
        const stateAfterStray = offerer.network.state;
        const connecting = offerer.network.acceptAnswerAsync(answer.code);
        await flushAsync();
        connectFakePeers(offerer.connection(), answerer.connection());

        // Assert
        await expect(connecting).resolves.toBeUndefined();
        expect(stateAfterStray).toBe('awaiting-answer');
        expect(offerer.connection().calls.filter(call => call === 'setRemoteDescription')).toHaveLength(1);
    });

    it('refuses to pair twice on one instance', async () => {
        // Arrange
        const side = createSide();
        await side.network.createOfferAsync();

        // Act
        const again = side.network.createOfferAsync();

        // Assert
        await expectNetworkErrorAsync(again, 'code-used');
    });

    it('fails with connect-timeout connectMs after the answer is applied (HS-10)', async () => {
        // Arrange
        const { clock, offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();
        const answer = await answerer.network.acceptOfferAsync(offer.code);
        const connecting = offerer.network.acceptAnswerAsync(answer.code);
        await flushAsync();

        // Act
        clock.advance(TIMEOUTS.connectMs);

        // Assert
        await expectNetworkErrorAsync(connecting, 'connect-timeout');
        expect(offerer.network.state).toBe('closed');
        expect(offerer.errors).toEqual([]);
        const failure = offerer.entries().find(entry => entry.msg === 'not connected after 15000 ms');
        expect(failure?.level).toBe('error');
    });

    it('fails the answerer with connect-timeout once the offer could no longer connect', async () => {
        // Arrange
        const { clock, offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();
        await answerer.network.acceptOfferAsync(offer.code);

        // Act
        clock.advance(TIMEOUTS.codeExpiryMs + TIMEOUTS.connectMs - 1);
        const before = answerer.network.state;
        clock.advance(1);

        // Assert
        expect(before).toBe('connecting');
        expect(answerer.errors.map(error => error.code)).toEqual(['connect-timeout']);
        expect(answerer.network.state).toBe('closed');
    });

    it('fails with ice-failed when the connection fails while connecting', async () => {
        // Arrange
        const { offerer, answerer } = createPair();
        const offer = await offerer.network.createOfferAsync();
        const answer = await answerer.network.acceptOfferAsync(offer.code);
        const connecting = offerer.network.acceptAnswerAsync(answer.code);
        await flushAsync();

        // Act
        offerer.connection().setConnectionState('failed');

        // Assert
        await expectNetworkErrorAsync(connecting, 'ice-failed');
    });
});

describe('createNetwork messaging', () => {
    it('delivers JSON messages both ways on control and the slots', async () => {
        // Arrange
        const { offerer, answerer } = await connectedPairAsync();

        // Act
        offerer.network.send('control', { t: 'hello', name: 'Pixel' });
        answerer.network.send(2, { t: 'accept', id: '7', fromPage: 3 });
        await flushAsync();

        // Assert
        expect(answerer.messages).toEqual([['control', { t: 'hello', name: 'Pixel' }]]);
        expect(offerer.messages).toEqual([['2', { t: 'accept', id: '7', fromPage: 3 }]]);
    });

    it('answers pings itself and never emits ping, pong, vis or bye (NW-02)', async () => {
        // Arrange
        const { clock, offerer, answerer } = await connectedPairAsync();

        // Act
        clock.advance(TIMEOUTS.pingMs);
        await flushAsync();
        answerer.fake.setHidden(true);
        await flushAsync();

        // Assert
        expect(offerer.messages).toEqual([]);
        expect(answerer.messages).toEqual([]);
        expect(offerer.network.health.rttMs).toBe(0);
        expect(offerer.network.health.peerHidden).toBe(true);
    });

    it('drops JSON over 64 KiB, unparsable text and messages without a string t (NW-03)', async () => {
        // Arrange
        const { answerer } = await connectedPairAsync();
        const control = answerer.connection().channels[0];

        // Act
        control?.receive('{"t":"big","data":"' + 'x'.repeat(64 * KIB) + '"}');
        control?.receive('not json');
        control?.receive('{"type":"hello"}');
        control?.receive('{"t":1}');
        control?.receive('["t"]');
        control?.receive('{"t":"hello"}');

        // Assert
        expect(answerer.messages).toEqual([['control', { t: 'hello' }]]);
        const drops = answerer.entries().filter(entry => entry.msg.startsWith('dropped a message on control'));
        expect(drops.length).toBeGreaterThan(0);
    });

    it('refuses to send JSON over 64 KiB with message-too-large', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();

        // Act
        const send = () => offerer.network.send('control', { t: 'big', data: 'x'.repeat(64 * KIB) });

        // Assert
        expectNetworkError(send, 'message-too-large');
    });

    it('carries frames on all four slots, up to the largest payload', async () => {
        // Arrange
        const { offerer, answerer } = await connectedPairAsync();
        const length = offerer.network.maxFramePayload;
        const payload = Uint8Array.from({ length }, (_, index) => index & 0xff);

        // Act
        for (const slot of [1, 2, 3, 4] as const) {
            offerer.network.sendFrame({ slot, page: slot * 10, offset: 0, flags: slot }, payload);
        }

        await flushAsync();

        // Assert
        expect(answerer.frames.map(([header]) => header)).toEqual([
            { slot: 1, page: 10, offset: 0, flags: 1 },
            { slot: 2, page: 20, offset: 0, flags: 2 },
            { slot: 3, page: 30, offset: 0, flags: 3 },
            { slot: 4, page: 40, offset: 0, flags: 4 },
        ]);
        expect(answerer.frames.every(([, received]) => received.length === payload.length)).toBe(true);
        expect(answerer.frames[3]?.[1]).toEqual(payload);
    });

    it('drops a frame on the wrong slot, a malformed frame and binary data on control', async () => {
        // Arrange
        const { answerer } = await connectedPairAsync();
        const [control, slot1] = answerer.connection().channels;

        // Act
        slot1?.receive(encodeFrame({ slot: 2, page: 0, offset: 0, flags: 0 }, new Uint8Array(4)));
        slot1?.receive(new Uint8Array(5));
        control?.receive(encodeFrame({ slot: 1, page: 0, offset: 0, flags: 0 }, new Uint8Array(4)));
        await flushAsync();

        // Assert
        expect(answerer.frames).toEqual([]);
    });

    it('throws message-too-large when a frame is over chunkSize (NW-04)', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        offerer.network.configure({ chunkSize: 16 * KIB });
        const payload = new Uint8Array(offerer.network.maxFramePayload + 1);

        // Act
        const send = () => offerer.network.sendFrame({ slot: 1, page: 0, offset: 0, flags: 0 }, payload);

        // Assert
        expect(offerer.network.maxFramePayload).toBe(16 * KIB - 16);
        expectNetworkError(send, 'message-too-large');
    });

    it('throws RangeError for a malformed frame header', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        const header = { slot: 1, page: -1, offset: 0, flags: 0 } as const;

        // Act
        const send = () => offerer.network.sendFrame(header, new Uint8Array(1));

        // Assert
        expect(send).toThrow(RangeError);
    });

    it('throws channel-closed before connecting and after closing (NW-05)', async () => {
        // Arrange
        const idle = createSide();
        const { offerer } = await connectedPairAsync();
        offerer.network.close();

        // Act
        const sendIdle = () => idle.network.send('control', { t: 'hello' });
        const sendClosed = () => offerer.network.sendFrame(HEADER, new Uint8Array(1));

        // Assert
        expectNetworkError(sendIdle, 'channel-closed');
        expectNetworkError(sendClosed, 'channel-closed');
    });

    it('throws send-failed when the browser refuses to send', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        const control = offerer.connection().channels[0];
        if (control != null) {
            control.failsSend = true;
        }

        // Act
        const send = () => offerer.network.send('control', { t: 'hello' });

        // Assert
        expectNetworkError(send, 'send-failed');
    });
});

describe('createNetwork backpressure (TR-04)', () => {
    it('resolves at once while the slot is under its share', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();

        // Act
        const waiting = offerer.network.waitDrainedAsync(1);

        // Assert
        await expect(waiting).resolves.toBeUndefined();
    });

    it('waits for bufferedamountlow when the slot is over maxBuffered', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        const slot1 = offerer.connection().channels[1];
        if (slot1 == null) {
            throw new Error('no slot 1');
        }

        slot1.bufferedAmount = 5 * MIB;
        const resolved = vi.fn();

        // Act
        const waiting = offerer.network.waitDrainedAsync(1).then(resolved);
        await flushAsync();
        const before = resolved.mock.calls.length;
        slot1.drain(MIB);
        await waiting;

        // Assert
        expect(before).toBe(0);
        expect(slot1.bufferedAmountLowThreshold).toBe(4 * MIB);
        expect(resolved).toHaveBeenCalledOnce();
        expect(offerer.network.bufferedAmount(1)).toBe(MIB);
    });

    it('shares maxBuffered between the slots that have bytes queued', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        const [, slot1, slot2] = offerer.connection().channels;
        if (slot1 == null || slot2 == null) {
            throw new Error('no slots');
        }

        slot1.bufferedAmount = 3 * MIB;
        slot2.bufferedAmount = 3 * MIB;
        const resolved = vi.fn();

        // Act
        const waiting = offerer.network.waitDrainedAsync(1).then(resolved);
        await flushAsync();
        const before = resolved.mock.calls.length;
        slot1.drain(2 * MIB);
        await waiting;

        // Assert
        expect(before).toBe(0);
        expect(slot1.bufferedAmountLowThreshold).toBe(2 * MIB);
        expect(resolved).toHaveBeenCalledOnce();
    });

    it('rejects a waiting sender with channel-closed when the link closes', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        const slot1 = offerer.connection().channels[1];
        if (slot1 != null) {
            slot1.bufferedAmount = 5 * MIB;
        }

        const waiting = offerer.network.waitDrainedAsync(1);

        // Act
        offerer.network.close();

        // Assert
        await expectNetworkErrorAsync(waiting, 'channel-closed');
    });
});

describe('createNetwork health', () => {
    it('reports Weak after weakMs and Lost after lostMs of silence (HC-02)', async () => {
        // Arrange
        const { clock, offerer, answerer } = await connectedPairAsync();
        for (const channel of answerer.connection().channels) {
            channel.peer = undefined;
        }

        // Act
        clock.advance(TIMEOUTS.weakMs);
        await flushAsync();
        const weak = offerer.network.health.status;
        clock.advance(TIMEOUTS.lostMs - TIMEOUTS.weakMs + 1000);
        await flushAsync();

        // Assert
        expect(weak).toBe('weak');
        expect(offerer.healths.map(health => health.status)).toEqual(['good', 'weak', 'lost']);
        expect(offerer.network.state).toBe('lost');
        expect(offerer.entries().map(entry => entry.msg)).toContain('good → weak');
    });

    it('suspends the timeout while the peer page is hidden (HC-04)', async () => {
        // Arrange
        const { clock, offerer, answerer } = await connectedPairAsync();
        answerer.fake.setHidden(true);
        await flushAsync();
        for (const channel of answerer.connection().channels) {
            channel.peer = undefined;
        }

        // Act
        clock.advance(60_000);
        await flushAsync();

        // Assert
        expect(offerer.network.state).toBe('connected');
        expect(offerer.network.health).toMatchObject({ status: 'good', peerHidden: true });
    });

    it('keeps waiting while disconnected and is lost when the connection fails (HC-03)', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();

        // Act
        offerer.connection().setConnectionState('disconnected');
        const whileDisconnected = offerer.network.state;
        offerer.connection().setConnectionState('failed');

        // Assert
        expect(whileDisconnected).toBe('connected');
        expect(offerer.network.state).toBe('lost');
        expect(offerer.network.health.status).toBe('lost');
    });

    it('treats a channel closed without bye as lost', async () => {
        // Arrange
        const { offerer, answerer } = await connectedPairAsync();

        // Act
        answerer.connection().channels[3]?.close();
        await flushAsync();

        // Assert
        expect(offerer.network.state).toBe('lost');
    });

    it('applies a new ping interval live', async () => {
        // Arrange
        const { clock, offerer } = await connectedPairAsync();
        const control = offerer.connection().channels[0];
        const isPing = (data: string | Uint8Array): boolean => typeof data === 'string' && data.includes('"ping"');
        const pings = () => (control?.sent ?? []).filter(isPing).length;

        // Act
        offerer.network.configure({ timeouts: { ...TIMEOUTS, pingMs: 5000 } });
        clock.advance(4999);
        const early = pings();
        clock.advance(1);

        // Assert
        expect(early).toBe(0);
        expect(pings()).toBe(1);
    });
});

describe('createNetwork close', () => {
    it('sends bye and the peer closes at once (HC-06)', async () => {
        // Arrange
        const { offerer, answerer } = await connectedPairAsync();

        // Act
        offerer.network.close('user disconnect');
        await flushAsync();

        // Assert
        expect(offerer.network.state).toBe('closed');
        expect(answerer.network.state).toBe('closed');
        expect(answerer.errors).toEqual([]);
        expect(answerer.entries().map(entry => entry.msg)).toContain('bye received');
    });

    it('stops every timer and listener and leaves the instance unusable (NW-07)', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        const connection = offerer.connection();

        // Act
        offerer.network.close();

        // Assert
        expect(offerer.fake.pendingTimerCount).toBe(0);
        expect(offerer.fake.subscriptionCount).toBe(0);
        expect(connection.listenerCount).toBe(0);
        expect(connection.channels.every(channel => channel.listenerCount === 0)).toBe(true);
        expect(connection.sctp?.listenerCount).toBe(0);
        expect(connection.calls.at(-1)).toBe('close');
        await expectNetworkErrorAsync(offerer.network.createOfferAsync(), 'closed');
        await expectNetworkErrorAsync(offerer.network.waitDrainedAsync(1), 'channel-closed');
    });

    it('stops a pairing step that is still running', async () => {
        // Arrange
        const side = createSide({ gathering: 'hang' });
        const creating = side.network.createOfferAsync();
        await flushAsync();

        // Act
        side.network.close();

        // Assert
        await expectNetworkErrorAsync(creating, 'closed');
        expect(side.fake.pendingTimerCount).toBe(0);
        expect(side.states).toEqual(['gathering', 'closed']);
    });

    it('sends bye on pagehide (HC-06)', async () => {
        // Arrange
        const { offerer, answerer } = await connectedPairAsync();

        // Act
        offerer.fake.pageHide();
        await flushAsync();

        // Assert
        expect(offerer.network.state).toBe('closed');
        expect(answerer.network.state).toBe('closed');
    });
});

describe('createNetwork logging', () => {
    it('never logs the ICE password or a full code (SP-03, DL-14)', async () => {
        // Act
        const { offerer, answerer, offerCode, answerCode } = await connectedPairAsync();

        // Assert
        const logged = JSON.stringify([...offerer.entries(), ...answerer.entries()]);
        expect(logged).not.toContain(PROFILE_A.icePwd);
        expect(logged).not.toContain(PROFILE_B.icePwd);
        expect(logged).not.toContain(offerCode);
        expect(logged).not.toContain(answerCode);
    });

    it('logs the handshake steps for the timeline (DL-07)', async () => {
        // Act
        const { offerer } = await connectedPairAsync();

        // Assert
        const messages = offerer.entries().map(entry => entry.msg);
        expect(messages).toEqual(expect.arrayContaining([
            'camera permission: not asked (.local names)',
            'offer created, gathering…',
            expect.stringMatching(/^gathering \d+ ms$/),
            expect.stringMatching(/^offer code \d+ B, \d+ chars$/),
            'answer code decoded',
            'remote host udp 192.168.1.41:60111',
            'answer applied',
            'channels open: control, slot1, slot2, slot3, slot4',
            expect.stringMatching(/^connect \d+ ms$/),
            'connected; sctp maxMessageSize 262144',
        ]));
    });
});

describe('createNetwork stats', () => {
    it('maps the candidate pairs of the connection (DL-06)', async () => {
        // Arrange
        const { offerer } = await connectedPairAsync();
        offerer.connection().statsRecords = [
            { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
            { id: 'L', type: 'local-candidate', candidateType: 'host', address: '192.168.1.23', port: 52344 },
            { id: 'R', type: 'remote-candidate', candidateType: 'prflx', address: '192.168.1.41', port: 60111 },
            { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', nominated: true },
        ];

        // Act
        const pairs = await offerer.network.getStatsAsync();

        // Assert
        expect(pairs).toHaveLength(1);
        expect(pairs[0]).toMatchObject({ selected: true, nominated: true, remote: { type: 'prflx' } });
    });
});

describe('inspectCode', () => {
    it('throws NetworkError for garbage', () => {
        // Act
        const inspect = () => inspectCode('not a code');

        // Assert
        expectNetworkError(inspect, 'code-invalid');
    });
});
