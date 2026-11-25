import { describe, expect, it } from 'vitest';
import { SILENT_LOGGER } from '../core/logger.js';
import type { ChannelName, FrameHeader, LinkState, Message, NetworkOptions } from '../network/networkTypes.js';
import { createConnectedPairAsync, createFakeNetworkHub } from './fakeNetwork.js';

const OPTIONS: NetworkOptions = Object.freeze({
    chunkSize: 64 * 1024,
    maxBuffered: 4 * 1024 * 1024,
    timeouts: { gatheringMs: 3000, codeExpiryMs: 120_000, connectMs: 15_000, pingMs: 2000, weakMs: 6000, lostMs: 10_000 },
    appUrl: 'https://example.test/ether/',
    logger: SILENT_LOGGER,
});

describe('createFakeNetworkHub', () => {
    it('pairs two networks by fake codes and moves messages and frames in order per channel', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const [offerer, answerer] = await createConnectedPairAsync(hub, OPTIONS);
        const received: Array<[ChannelName, Message]> = [];
        const frames: FrameHeader[] = [];
        answerer.on('message', (channel, message) => received.push([channel, message]));
        answerer.on('frame', header => frames.push(header));

        // Act
        offerer.send('control', { t: 'hello', n: 1 });
        offerer.sendFrame({ slot: 2, page: 0, offset: 0, flags: 0 }, new Uint8Array(10));
        offerer.send(2, { t: 'page-end', n: 2 });
        await hub.settleAsync();

        // Assert
        expect([offerer.state, answerer.state]).toEqual(['connected', 'connected']);
        expect(received).toEqual([['control', { t: 'hello', n: 1 }], [2, { t: 'page-end', n: 2 }]]);
        expect(frames).toEqual([{ slot: 2, page: 0, offset: 0, flags: 0 }]);
        expect(offerer.checkCode).toBe('FAKE');
    });

    it('refuses a used code', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const offerer = hub.createNetwork(OPTIONS);
        const offer = await offerer.createOfferAsync();
        await hub.createNetwork(OPTIONS).acceptOfferAsync(offer.url);

        // Act
        const second = hub.createNetwork(OPTIONS).acceptOfferAsync(offer.code);

        // Assert
        await expect(second).rejects.toMatchObject({ code: 'code-used' });
    });

    it('lets an interceptor drop or change single messages and frames', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const [offerer, answerer] = await createConnectedPairAsync(hub, OPTIONS);
        const received: Message[] = [];
        const payloads: number[] = [];
        answerer.on('message', (_, message) => received.push(message));
        answerer.on('frame', (_, payload) => payloads.push(payload[0] ?? -1));
        hub.intercept(traffic => {
            if (traffic.kind === 'message' && traffic.message.t === 'ack') {
                return 'drop';
            }

            if (traffic.kind === 'frame') {
                return { payload: new Uint8Array([99]) };
            }

            return traffic.message.t === 'name' ? { message: { t: 'name', name: 'changed' } } : undefined;
        });

        // Act
        offerer.send(1, { t: 'ack' });
        offerer.send('control', { t: 'name', name: 'original' });
        offerer.sendFrame({ slot: 1, page: 0, offset: 0, flags: 0 }, new Uint8Array([1]));
        await hub.settleAsync();

        // Assert
        expect(received).toEqual([{ t: 'name', name: 'changed' }]);
        expect(payloads).toEqual([99]);
    });

    it('simulates buffered amounts and resolves drain waits once delivered', async () => {
        // Arrange
        const hub = createFakeNetworkHub({ delayMs: 5 });
        const [offerer] = await createConnectedPairAsync(hub, { ...OPTIONS, maxBuffered: 4 * 1024 });
        const payload = new Uint8Array(1000);

        // Act
        for (let index = 0; index < 3; index++) {
            offerer.sendFrame({ slot: 1, page: 0, offset: index * 1000, flags: 0 }, payload);
        }

        const buffered = offerer.bufferedAmount(1);
        await offerer.waitDrainedAsync(1);

        // Assert
        expect(buffered).toBe(3 * 1016);
        expect(offerer.bufferedAmount(1)).toBe(0);
    });

    it('drops links: queued traffic is lost, both ends go lost and sending throws', async () => {
        // Arrange
        const hub = createFakeNetworkHub({ delayMs: 5 });
        const [offerer, answerer] = await createConnectedPairAsync(hub, OPTIONS);
        const states: LinkState[] = [];
        const received: Message[] = [];
        answerer.on('state', state => states.push(state));
        answerer.on('message', (_, message) => received.push(message));
        offerer.send('control', { t: 'late' });

        // Act
        hub.dropLinks();
        await new Promise(resolve => setTimeout(resolve, 20));

        // Assert
        expect(states).toEqual(['lost']);
        expect(received).toEqual([]);
        expect(() => offerer.send('control', { t: 'x' })).toThrow(expect.objectContaining({ code: 'channel-closed' }));
    });

    it('delivers what was sent before close, then closes the peer', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const [offerer, answerer] = await createConnectedPairAsync(hub, OPTIONS);
        const events: string[] = [];
        answerer.on('message', (_, message) => events.push(message.t));
        answerer.on('state', state => events.push(state));

        // Act
        offerer.send('control', { t: 'last-words' });
        offerer.close('bye');
        await hub.settleAsync();

        // Assert
        expect(events).toEqual(['last-words', 'closed']);
        expect(offerer.closeReason).toBe('bye');
    });

    it('refuses frames over the payload limit and messages over 64 KiB', async () => {
        // Arrange
        const hub = createFakeNetworkHub();
        const [offerer] = await createConnectedPairAsync(hub, { ...OPTIONS, chunkSize: 16 * 1024 });

        // Act
        const sendFrame = (): void => offerer.sendFrame({ slot: 1, page: 0, offset: 0, flags: 0 }, new Uint8Array(offerer.maxFramePayload + 1));
        const sendLarge = (): void => offerer.send('control', { t: 'big', text: 'x'.repeat(70_000) });

        // Assert
        expect(offerer.maxFramePayload).toBe(16 * 1024 - 16);
        expect(sendFrame).toThrow(expect.objectContaining({ code: 'message-too-large' }));
        expect(sendLarge).toThrow(expect.objectContaining({ code: 'message-too-large' }));
    });

    it('loses traffic at the configured rate', async () => {
        // Arrange
        const hub = createFakeNetworkHub({ lossRate: 0.5, random: (() => {
            let toggle = false;

            return () => {
                toggle = !toggle;

                return toggle ? 0.1 : 0.9;
            };
        })() });
        const [offerer, answerer] = await createConnectedPairAsync(hub, OPTIONS);
        const received: Message[] = [];
        answerer.on('message', (_, message) => received.push(message));

        // Act
        for (let index = 0; index < 4; index++) {
            offerer.send('control', { t: 'ping', index });
        }

        await hub.settleAsync();

        // Assert
        expect(received.map(message => message.index)).toEqual([1, 3]);
    });
});
