import { describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger.js';
import type { LogEntry } from '../core/logger.js';
import { createMemorySink } from '../core/logSinks.js';
import { FAKE_WALL_START, FakeClock } from '../network/fakeEnvironment.js';
import { createDiscovery, NEARBY_EVENT_KIND, ROOM_TAG_NAME } from './discovery.js';
import type { DiscoveryTimings } from './discovery.js';
import { DiscoveryError } from './discoveryError.js';
import type {
    Discovery,
    DiscoveryStatus,
    NearbyDevice,
    PairRequest,
    PairRequestOutcome,
    RelayAllowanceNotice,
} from './discoveryTypes.js';
import { createFakeDiscoveryEnvironment, FakeSessionStore, FakeStun } from './fakeDiscoveryEnvironment.js';
import type { FakeDiscoveryEnvironment } from './fakeDiscoveryEnvironment.js';
import { FakeRelayNetwork } from './fakeRelay.js';
import { deriveRoomAsync, sealAsync } from './nearbyCrypto.js';
import { createNostrSigner, createSecretKey } from './nostrEvent.js';
import type { NostrEvent } from './nostrEvent.js';
import { nextUtcMidnight } from './relayAllowance.js';

// The first stands for Ether's own relay, watched for its free allowance.
const RELAYS = ['wss://relay-one.test', 'wss://relay-two.test', 'wss://relay-three.test'];
const OWN_RELAY = RELAYS[0] ?? '';
const STUN_SERVERS = ['stun:one.test:3478', 'stun:two.test:3478', 'stun:three.test:3478'];
const HOME = '203.0.113.7';
const OTHER_HOME = '198.51.100.23';
const OFFER = 'AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYUCULBOGAZDINRYHI6D4QA';
const ANSWER = 'AEQCGBAFAYDQQCIKBMGA2DQPCAIREEYUCULBOGAZDINRYHI6D4QB';
const TIMINGS: DiscoveryTimings = {
    presenceMs: 30_000,
    presenceJitterMs: 5000,
    deviceTimeoutMs: 75_000,
    sweepMs: 5000,
    requestTimeoutMs: 60_000,
    answerGraceMs: 10_000,
    stunTimeoutMs: 5000,
    addressRecheckMs: 300_000,
    lookupRetryMs: [5000, 15_000],
    greetingDelayMs: [500, 2500],
    replaceQuietAfterMs: 40_000,
};
// The run of the messages the tests forge.
const RUN = 'R'.repeat(22);

interface TestDevice {
    readonly name: string;
    readonly discovery: Discovery;
    readonly sessionStore: FakeSessionStore;
    readonly fake: FakeDiscoveryEnvironment;
    readonly stun: FakeStun;
    readonly statuses: DiscoveryStatus[];
    readonly requests: PairRequest[];
    readonly ended: string[];
    readonly deviceLists: (readonly NearbyDevice[])[];
    entries(): LogEntry[];
}

interface DeviceOptions {
    readonly address?: string;
    readonly start?: boolean;
    readonly isHidden?: boolean;
    // Its sockets' name, so a page that stays behind and its reload can be told apart.
    readonly client?: string;
    // The tab's sessionStorage: the same one again is a reload in that tab.
    readonly sessionStore?: FakeSessionStore;
}

interface World {
    readonly clock: FakeClock;
    readonly relays: FakeRelayNetwork;
    addDevice(name: string, options?: DeviceOptions): TestDevice;
}

// Two of the three relays keep ephemeral events and replay them to new subscriptions, as public relays do.
function createWorld(): World {
    const clock = new FakeClock();
    const relays = new FakeRelayNetwork(RELAYS);
    for (const relay of relays.relays.slice(1)) {
        relay.storesEvents = true;
    }

    return {
        clock,
        relays,
        addDevice: (name, options = {}) => {
            const stun = new FakeStun(options.address ?? HOME);
            const sessionStore = options.sessionStore ?? new FakeSessionStore();
            const client = options.client ?? name;
            const fake = createFakeDiscoveryEnvironment({ clock, relays, stun, client, sessionStore });
            if (options.isHidden === true) {
                fake.setHidden(true);
            }

            const memory = createMemorySink(2000);
            const { logger } = createLogger({
                sinks: [memory],
                routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
                now: clock.now,
            });
            const discovery = createDiscovery({
                logger,
                environment: fake.environment,
                relayUrls: RELAYS,
                ownRelayUrls: [OWN_RELAY],
                stunServers: STUN_SERVERS,
                timings: TIMINGS,
            });
            const device: TestDevice = {
                name,
                discovery,
                sessionStore,
                fake,
                stun,
                statuses: [],
                requests: [],
                ended: [],
                deviceLists: [],
                entries: () => memory.entries(),
            };
            discovery.on('status', status => device.statuses.push(status));
            discovery.on('request', request => device.requests.push(request));
            discovery.on('request-ended', requestId => device.ended.push(requestId));
            discovery.on('devices', devices => device.deviceLists.push(devices));
            if (options.start !== false) {
                discovery.start({ name, deviceType: name.startsWith('Phone') ? 'phone' : 'desktop' });
            }

            return device;
        },
    };
}

// WebCrypto settles on the real event loop, so the tests poll real time for what follows a fake-clock step.
async function waitForAsync(condition: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }

        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

// For checks that something does not happen: long enough for any message in flight to land.
async function settleAsync(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 60));
}

// Moves the shared clock in steps, letting each step's messages land before the next, as real time would.
async function passAsync(world: World, ms: number, stepMs = 5000): Promise<void> {
    for (let passed = 0; passed < ms; passed += stepMs) {
        world.clock.advance(Math.min(stepMs, ms - passed));
        await new Promise(resolve => setTimeout(resolve, 15));
    }
}

function names(device: TestDevice): string[] {
    return device.discovery.devices().map(entry => entry.name);
}

function ids(device: TestDevice): string[] {
    return device.discovery.devices().map(entry => entry.nearbyId);
}

function idOf(observer: TestDevice, name: string): string {
    const found = observer.discovery.devices().find(entry => entry.name === name);
    if (found == null) {
        throw new Error(`${observer.name} does not list ${name}`);
    }

    return found.nearbyId;
}

async function meetAsync(world: World, ...names: string[]): Promise<TestDevice[]> {
    const devices = names.map(name => world.addDevice(name));
    await waitForAsync(
        () => devices.every(device => device.discovery.devices().length === devices.length - 1),
        'every device to list the others',
    );

    return devices;
}

async function requestAsync(asker: TestDevice, target: TestDevice, signal?: AbortSignal): Promise<{
    readonly outcome: Promise<PairRequestOutcome>;
    readonly request: PairRequest;
}> {
    const before = target.requests.length;
    const options = signal == null ? {} : { signal };
    const outcome = asker.discovery.requestPairingAsync(idOf(asker, target.name), OFFER, options);
    outcome.catch(() => undefined);
    await waitForAsync(() => target.requests.length > before, `${target.name} to receive the request`);
    const request = target.requests.at(-1);
    if (request == null) {
        throw new Error('no request');
    }

    return { outcome, request };
}

// Builds events as another device in the room would, for malformed and hostile input.
async function createIntruderAsync(address = HOME): Promise<{
    eventAsync(plaintext: string, options?: { readonly createdAt?: number }): Promise<NostrEvent>;
    readonly signer: ReturnType<typeof createNostrSigner>;
}> {
    const room = await deriveRoomAsync(address);
    const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));
    const signer = createNostrSigner(createSecretKey(random), random);

    return {
        signer,
        eventAsync: async (plaintext, options = {}) => signer.sign({
            createdAt: options.createdAt ?? Math.floor(FAKE_WALL_START / 1000),
            kind: NEARBY_EVENT_KIND,
            tags: [[ROOM_TAG_NAME, room.tag]],
            content: await sealAsync(room.key, plaintext, room.tag),
        }),
    };
}

const PRESENCE_KEY = `B${'A'.repeat(86)}`;

describe('createDiscovery presence', () => {
    it('finds the room, listens, and lists the other device but not itself', async () => {
        // Arrange
        const world = createWorld();

        // Act
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Assert
        expect(phone?.discovery.status()).toBe('listening');
        expect(phone?.statuses).toEqual(['starting', 'listening']);
        expect(names(phone as TestDevice)).toEqual(['Laptop B']);
        expect(names(laptop as TestDevice)).toEqual(['Phone A']);
        expect(laptop?.discovery.devices()[0]).toMatchObject({ deviceType: 'phone', lastSeenAt: FAKE_WALL_START });
    });

    it('carries the platform, lists a device that sends none, and announces a new platform', async () => {
        // Arrange
        const world = createWorld();
        const phone = world.addDevice('Phone A', { start: false });
        phone.discovery.start({ name: 'Phone A', deviceType: 'phone', platform: 'Android' });
        const laptop = world.addDevice('Laptop B');
        await waitForAsync(
            () => phone.discovery.devices().length === 1 && laptop.discovery.devices().length === 1,
            'both devices to list each other',
        );
        const first = laptop.discovery.devices()[0];

        // Act
        phone.discovery.start({ name: 'Phone A', deviceType: 'phone', platform: 'Phone' });
        await waitForAsync(() => laptop.discovery.devices()[0]?.platform === 'Phone', 'the new platform');

        // Assert
        expect(first).toMatchObject({ name: 'Phone A', deviceType: 'phone', platform: 'Android' });
        expect(phone.discovery.devices()[0]).toMatchObject({ name: 'Laptop B', deviceType: 'desktop' });
        expect(phone.discovery.devices()[0]?.platform).toBeUndefined();
    });

    it('subscribes on every relay with an ephemeral kind, the room tag and since', async () => {
        // Arrange
        const world = createWorld();
        const room = await deriveRoomAsync(HOME);

        // Act
        await meetAsync(world, 'Phone A', 'Laptop B');

        // Assert
        for (const relay of world.relays.relays) {
            const request = relay.frames
                .map(frame => JSON.parse(frame) as unknown[])
                .find(frame => frame[0] === 'REQ');
            expect(request?.[2]).toEqual({
                kinds: [NEARBY_EVENT_KIND],
                '#x': [room.tag],
                since: Math.floor(FAKE_WALL_START / 1000) - 600,
            });
            expect(relay.published.every(event => event.kind >= 20_000 && event.kind < 30_000)).toBe(true);
        }
    });

    it('keeps names, the address and pairing codes out of what the relays see', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);
        await laptop?.discovery.acceptAsync(request.requestId, ANSWER);
        await outcome;
        const seen = world.relays.relays.flatMap(relay => relay.frames).join('\n');

        // Assert
        for (const secret of ['Phone A', 'Laptop B', HOME, OFFER, ANSWER, 'phone', 'desktop']) {
            expect(seen).not.toContain(secret);
        }
    });

    it('drops a device that stays silent for 75 s and keeps one that keeps announcing', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop, tablet] = await meetAsync(world, 'Phone A', 'Laptop B', 'Tablet C');
        world.relays.cut('Laptop B');
        await settleAsync();

        // Act
        world.clock.advance(70_000);
        await settleAsync();
        const before = names(phone as TestDevice);
        world.clock.advance(10_000);
        await waitForAsync(() => phone?.discovery.devices().length === 1, 'the phone to drop the laptop');

        // Assert
        expect(before).toEqual(['Laptop B', 'Tablet C']);
        expect(names(phone as TestDevice)).toEqual(['Tablet C']);
        expect(names(tablet as TestDevice)).toEqual(['Phone A']);
        expect(laptop?.discovery.status()).toBe('offline');
    });

    it('drops a device at once when it says goodbye on stop', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        laptop?.discovery.stop();
        await waitForAsync(() => phone?.discovery.devices().length === 0, 'the goodbye to arrive');

        // Assert
        expect(laptop?.discovery.status()).toBe('off');
        expect(laptop?.discovery.devices()).toEqual([]);
        expect(laptop?.statuses.at(-1)).toBe('off');
        expect(world.relays.socketsOf('Laptop B')).toEqual([]);
    });

    it('ignores what relays replay from before it subscribed, so a closed page leaves no ghost', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        phone?.discovery.stop();
        laptop?.discovery.stop();
        await settleAsync();

        // Act
        const tablet = world.addDevice('Tablet C');
        await waitForAsync(() => tablet.discovery.status() === 'listening', 'the tablet to listen');
        await settleAsync();

        // Assert
        expect(world.relays.relays[1]?.published.length).toBeGreaterThan(2);
        expect(tablet.discovery.devices()).toEqual([]);
    });

    it('does not bring back a run whose presence arrives after its goodbye, but welcomes a new run', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const relay = world.relays.relay(RELAYS[0] ?? '');
        relay.sendsOk = false;
        const intruder = await createIntruderAsync();
        const now = Math.floor(FAKE_WALL_START / 1000);
        const bye = JSON.stringify({ v: 1, t: 'bye', from: 'L'.repeat(22), run: RUN });
        const presence = (run: string): string => JSON.stringify({
            v: 1,
            t: 'here',
            from: 'L'.repeat(22),
            run,
            name: 'Late',
            device: 'phone',
            key: PRESENCE_KEY,
        });

        // Act
        relay.inject(await intruder.eventAsync(presence(RUN), { createdAt: now }));
        await waitForAsync(() => names(phone as TestDevice).includes('Late'), 'the late device');
        relay.inject(await intruder.eventAsync(bye, { createdAt: now }));
        await waitForAsync(() => !names(phone as TestDevice).includes('Late'), 'the goodbye');
        relay.inject(await intruder.eventAsync(presence(RUN), { createdAt: now }));
        await settleAsync();
        const afterLatePresence = names(phone as TestDevice);
        relay.inject(await intruder.eventAsync(presence('N'.repeat(22)), { createdAt: now }));
        await waitForAsync(() => names(phone as TestDevice).includes('Late'), 'the new run');

        // Assert
        expect(afterLatePresence).toEqual(['Laptop B']);
        expect(names(phone as TestDevice)).toEqual(['Laptop B', 'Late']);
    });

    it('says goodbye on pagehide and comes back on pageshow as the same device', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const before = ids(phone as TestDevice);

        // Act
        laptop?.fake.pageHide();
        await waitForAsync(() => phone?.discovery.devices().length === 0, 'the goodbye to arrive');
        const hiddenStatus = laptop?.discovery.status();
        laptop?.fake.pageShow();
        await waitForAsync(() => phone?.discovery.devices().length === 1, 'the laptop to come back');

        // Assert
        expect(hiddenStatus).toBe('off');
        expect(laptop?.discovery.status()).toBe('listening');
        expect(ids(phone as TestDevice)).toEqual(before);
    });

    it('announces a name change at once', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        phone?.discovery.start({ name: '  Kitchen\u202e  Phone ', deviceType: 'phone' });
        await waitForAsync(() => names(laptop as TestDevice)[0] === 'Kitchen Phone', 'the new name');

        // Assert
        expect(laptop?.discovery.devices()).toHaveLength(1);
        expect(phone?.statuses).toEqual(['starting', 'listening']);
    });

    it('greets a newcomer so it sees the room within seconds, not at the next presence', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A');

        // Act
        const laptop = world.addDevice('Laptop B');
        await waitForAsync(() => phone?.discovery.devices().length === 1, 'the phone to hear the laptop');
        world.clock.advance(2500);
        await waitForAsync(() => laptop.discovery.devices().length === 1, 'the laptop to hear the greeting');

        // Assert
        expect(names(laptop)).toEqual(['Phone A']);
    });

    it('moves to the new room when the public address changes', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const tablet = world.addDevice('Tablet C', { address: OTHER_HOME });
        await waitForAsync(() => tablet.discovery.status() === 'listening', 'the tablet to listen');

        // Act
        if (phone != null) {
            phone.stun.address = OTHER_HOME;
        }

        // Five minutes in steps of 15 s, so the real time the steps take stays well inside the test timeout.
        await passAsync(world, 300_000, 15_000);
        await waitForAsync(
            () => laptop?.discovery.devices().length === 0 && names(tablet).includes('Phone A'),
            'the phone to leave the old room and join the new one',
        );
        await passAsync(world, 5000);
        await waitForAsync(() => names(phone as TestDevice).includes('Tablet C'), 'the phone to hear the tablet');

        // Assert
        expect(names(phone as TestDevice)).toEqual(['Tablet C']);
        expect(names(laptop as TestDevice)).toEqual([]);
        expect(phone?.discovery.status()).toBe('listening');
    });
});

describe('createDiscovery pairing requests', () => {
    it('delivers the offer and returns the answer when the other device accepts', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);
        await laptop?.discovery.acceptAsync(request.requestId, ANSWER);

        // Assert
        expect(request.offerCode).toBe(OFFER);
        expect(request.from).toMatchObject({
            name: 'Phone A',
            deviceType: 'phone',
            nearbyId: idOf(laptop as TestDevice, 'Phone A'),
        });
        expect(request.expiresAt).toBe(FAKE_WALL_START + 60_000);
        await expect(outcome).resolves.toEqual({ kind: 'accepted', answerCode: ANSWER });
    });

    it.each([
        ['declined', 'declined'],
        ['busy', 'busy'],
    ] as const)('resolves %s when the other device says so', async (reason, kind) => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);

        // Act
        await laptop?.discovery.declineAsync(request.requestId, reason);

        // Assert
        await expect(outcome).resolves.toEqual({ kind });
    });

    it('expires an unanswered request on both sides, so no pairing happens', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);

        // Act
        world.clock.advance(60_000);
        const endedOnTime = [...(laptop?.ended ?? [])];
        const late = laptop?.discovery.acceptAsync(request.requestId, ANSWER);
        world.clock.advance(10_000);

        // Assert
        expect(endedOnTime).toEqual([request.requestId]);
        await expect(late).rejects.toMatchObject({ code: 'request-ended' });
        await expect(outcome).resolves.toEqual({ kind: 'no-answer' });
    });

    it('withdraws a request when the signal aborts, and the other side hears it', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const controller = new AbortController();
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice, controller.signal);

        // Act
        controller.abort();
        await waitForAsync(() => laptop?.ended.includes(request.requestId) === true, 'the cancel to arrive');

        // Assert
        await expect(outcome).resolves.toEqual({ kind: 'canceled' });
        await expect(laptop?.discovery.acceptAsync(request.requestId, ANSWER)).rejects.toBeInstanceOf(DiscoveryError);
    });

    it('resolves canceled at once for a signal that is already aborted, without sending', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const controller = new AbortController();
        controller.abort();
        const laptopId = idOf(phone as TestDevice, 'Laptop B');

        // Act
        const outcome = await phone?.discovery.requestPairingAsync(laptopId, OFFER, { signal: controller.signal });
        await settleAsync();

        // Assert
        expect(outcome).toEqual({ kind: 'canceled' });
        expect(laptop?.requests).toEqual([]);
    });

    it('ends the request when the asking device says goodbye', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);

        // Act
        phone?.discovery.stop();
        await waitForAsync(() => laptop?.ended.includes(request.requestId) === true, 'the request to end');

        // Assert
        await expect(outcome).resolves.toEqual({ kind: 'canceled' });
    });

    it('answers no-answer when the asked device leaves', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);

        // Act
        laptop?.discovery.stop();

        // Assert
        await expect(outcome).resolves.toEqual({ kind: 'no-answer' });
        expect(laptop?.ended).toEqual([request.requestId]);
    });

    it('refuses requests it can not send', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const laptopId = idOf(phone as TestDevice, 'Laptop B');
        const stopped = world.addDevice('Desk D', { start: false });

        // Act
        const unknown = phone?.discovery.requestPairingAsync('A'.repeat(22), OFFER);
        const badCode = phone?.discovery.requestPairingAsync(laptopId, 'not a code');
        const notListening = stopped.discovery.requestPairingAsync(laptopId, OFFER);

        // Assert
        await expect(unknown).rejects.toMatchObject({ code: 'unknown-device' });
        await expect(badCode).rejects.toMatchObject({ code: 'invalid-code' });
        await expect(notListening).rejects.toMatchObject({ code: 'not-listening' });
    });

    it('keeps the pairing codes from a third device in the room', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop, tablet] = await meetAsync(world, 'Phone A', 'Laptop B', 'Tablet C');

        // Act
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);
        await laptop?.discovery.acceptAsync(request.requestId, ANSWER);
        await outcome;
        await settleAsync();

        // Assert
        expect(tablet?.requests).toEqual([]);
    });

    it('keeps working when a relay dies, and goes offline only when all of them are gone', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        world.relays.relay(RELAYS[0] ?? '').kill();
        await settleAsync();
        const { outcome, request } = await requestAsync(phone as TestDevice, laptop as TestDevice);
        await laptop?.discovery.acceptAsync(request.requestId, ANSWER);
        const accepted = await outcome;
        const statusWithTwo = phone?.discovery.status();
        for (const relay of world.relays.relays) {
            relay.kill();
        }

        await waitForAsync(() => phone?.discovery.status() === 'offline', 'the phone to go offline');
        for (const relay of world.relays.relays) {
            relay.revive();
        }

        world.clock.advance(4000);
        await waitForAsync(() => phone?.discovery.status() === 'listening', 'the phone to reconnect');

        // Assert
        expect(accepted).toEqual({ kind: 'accepted', answerCode: ANSWER });
        expect(statusWithTwo).toBe('listening');
    });
});

describe('createDiscovery status', () => {
    it('is offline while no STUN server answers, and retries until one does', async () => {
        // Arrange
        const world = createWorld();
        const phone = world.addDevice('Phone A', { address: 'silent' });
        await waitForAsync(() => phone.discovery.status() === 'offline', 'offline');

        // Act
        phone.stun.address = HOME;
        world.clock.advance(5000);
        await waitForAsync(() => phone.discovery.status() === 'listening', 'listening');

        // Assert
        expect(phone.statuses).toEqual(['starting', 'offline', 'starting', 'listening']);
    });

    it('goes offline with the browser and reconnects when it is back online', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        world.relays.cut('Phone A');
        phone?.fake.setOnline(false);
        const offline = phone?.discovery.status();
        world.relays.restore('Phone A');
        phone?.fake.setOnline(true);
        await waitForAsync(() => phone?.discovery.status() === 'listening', 'listening again');

        // Assert
        expect(offline).toBe('offline');
    });

    it('stops everything: timers, sockets and the list', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        phone?.discovery.stop();
        phone?.discovery.stop();
        world.clock.advance(600_000);
        await settleAsync();

        // Assert
        expect(phone?.statuses).toEqual(['starting', 'listening', 'off']);
        expect(phone?.discovery.devices()).toEqual([]);
        expect(world.relays.socketsOf('Phone A')).toEqual([]);
    });
});

describe('createDiscovery hostile input', () => {
    it('drops malformed frames, forged events and messages it can not open', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const relay = world.relays.relay(RELAYS[0] ?? '');
        const intruder = await createIntruderAsync();
        const stranger = await createIntruderAsync(OTHER_HOME);
        const presence = (from: string, name: string): string => JSON.stringify({
            v: 1,
            t: 'here',
            from,
            run: RUN,
            name,
            device: 'phone',
            key: PRESENCE_KEY,
        });
        const valid = await intruder.eventAsync(presence('X'.repeat(22), 'Fake'));
        const hourAgo = Math.floor(FAKE_WALL_START / 1000) - 3600;
        const before = phone?.deviceLists.length ?? 0;

        // Act
        relay.broadcast('not json');
        relay.broadcast('{"an":"object"}');
        relay.broadcast(JSON.stringify(['EVENT', 'nearby-1', { id: 'short' }]));
        relay.broadcast('x'.repeat(70_000));
        relay.inject({ ...valid, content: `${valid.content}A` });
        relay.inject({ ...valid, sig: valid.sig.replace(/^./, valid.sig.startsWith('0') ? '1' : '0') });
        relay.inject(await stranger.eventAsync(JSON.stringify({ v: 1, t: 'bye', from: 'Y'.repeat(22), run: RUN })));
        relay.inject(await intruder.eventAsync(JSON.stringify({ v: 1, t: 'here', from: 'short', run: RUN })));
        relay.inject(await intruder.eventAsync('[1,2,3]'));
        const inherited = JSON.stringify({ v: 1, t: 'constructor', from: 'Z'.repeat(22), run: RUN });
        relay.inject(await intruder.eventAsync(inherited));
        relay.inject(await intruder.eventAsync(presence('W'.repeat(22), 'Old'), { createdAt: hourAgo }));
        await settleAsync();

        // Assert
        expect(names(phone as TestDevice)).toEqual(['Laptop B']);
        expect(phone?.deviceLists.length).toBe(before);
        expect(phone?.entries().some(entry => entry.cat === 'nearby' && entry.msg.startsWith('dropped'))).toBe(true);
    });

    it('cleans names, ignores unknown fields, and lets no other key speak for a listed device', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const relay = world.relays.relay(RELAYS[1] ?? '');
        const intruder = await createIntruderAsync();
        const laptopId = idOf(phone as TestDevice, 'Laptop B');
        const presence = (from: string, name: string): string => JSON.stringify({
            v: 1,
            t: 'here',
            from,
            run: RUN,
            name,
            device: 'fridge',
            key: PRESENCE_KEY,
            extra: { nested: true },
        });

        // Act
        relay.inject(await intruder.eventAsync(presence('Q'.repeat(22), `\u0007Tab\nlet\u2066 ${'x'.repeat(60)}`)));
        relay.inject(await intruder.eventAsync(presence(laptopId, 'Impostor')));
        await waitForAsync(() => phone?.discovery.devices().length === 2, 'the cleaned device');

        // Assert
        const listed = phone?.discovery.devices() ?? [];
        expect(listed.map(device => device.name)).toEqual(['Laptop B', `Tab let ${'x'.repeat(24)}`]);
        expect(listed[1]?.deviceType).toBe('desktop');
    });

    it('rate-limits a flood from one device', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const relay = world.relays.relay(RELAYS[2] ?? '');
        const intruder = await createIntruderAsync();
        const events = await Promise.all(Array.from({ length: 40 }, (_, index) => intruder.eventAsync(JSON.stringify({
            v: 1,
            t: 'here',
            from: 'F'.repeat(22),
            run: RUN,
            name: `Flood ${index + 1}`,
            device: 'phone',
            key: PRESENCE_KEY,
        }))));

        const isFlooded = (list: readonly NearbyDevice[]): boolean => list
            .some(device => device.name.startsWith('Flood'));

        // Act
        for (const event of events) {
            relay.inject(event);
        }

        await waitForAsync(() => isFlooded(phone?.discovery.devices() ?? []), 'the first flood message');
        await new Promise(resolve => setTimeout(resolve, 400));

        // Assert
        expect(phone?.deviceLists.filter(isFlooded)).toHaveLength(10);
        expect(phone?.entries().some(entry => entry.msg.startsWith('dropped'))).toBe(true);
    });

    it('caps open requests per sender', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const laptopId = idOf(phone as TestDevice, 'Laptop B');

        // Act
        const outcomes = [0, 1, 2].map(() => phone?.discovery.requestPairingAsync(laptopId, OFFER));
        await waitForAsync(() => laptop?.requests.length === 2, 'two requests');
        await settleAsync();
        phone?.discovery.stop();

        // Assert
        expect(laptop?.requests).toHaveLength(2);
        await expect(Promise.all(outcomes)).resolves.toEqual([
            { kind: 'canceled' },
            { kind: 'canceled' },
            { kind: 'canceled' },
        ]);
    });
});

describe('createDiscovery relay allowance', () => {
    it('shows a notice when its own relay is out of its allowance, and clears it once the relay works', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const notices: (RelayAllowanceNotice | undefined)[] = [];
        phone?.discovery.on('relay-allowance', notice => notices.push(notice));
        if (phone != null) {
            phone.fake.respondAsync = async () => Response.json({ status: 'limit' }, { status: 503 });
        }

        const ownRelay = world.relays.relay(OWN_RELAY);

        // Act
        ownRelay.kill();
        await passAsync(world, 3000, 500);
        await waitForAsync(() => notices.length === 1, 'the notice');
        const notice = phone?.discovery.relayAllowance();
        const statusWhileOut = phone?.discovery.status();
        ownRelay.revive();
        if (phone != null) {
            phone.fake.respondAsync = async () => Response.json({ status: 'ok' });
        }

        // Ten minutes in steps of 30 s: each step costs real time, and 5 s steps could outlast the test timeout.
        await passAsync(world, 10 * 60_000, 30_000);
        await waitForAsync(
            () => notices.length === 2 && ownRelay.sockets.size === 2,
            'the notice to clear and the relay to reconnect',
        );

        // Assert
        expect(notice).toEqual({ relayUrl: OWN_RELAY, isCertain: true, resetsAt: nextUtcMidnight(FAKE_WALL_START) });
        expect(notices).toEqual([notice, undefined]);
        expect(phone?.fake.fetches[0]).toBe('https://relay-one.test/status');
        expect(statusWhileOut).toBe('listening');
        expect(phone?.discovery.relayAllowance()).toBeUndefined();
    });

    it('raises no notice when its own relay only blips', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const ownRelay = world.relays.relay(OWN_RELAY);

        // Act
        ownRelay.kill();
        await passAsync(world, 3000, 500);
        ownRelay.revive();
        await passAsync(world, 15_000, 1000);

        // Assert
        expect(phone?.fake.fetches).toEqual(['https://relay-one.test/status']);
        expect(phone?.discovery.relayAllowance()).toBeUndefined();
        expect(ownRelay.sockets.size).toBe(2);
    });

    it('forgets the notice when stopped', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A', 'Laptop B');
        const notices: (RelayAllowanceNotice | undefined)[] = [];
        phone?.discovery.on('relay-allowance', notice => notices.push(notice));
        if (phone != null) {
            phone.fake.respondAsync = async () => {
                throw new TypeError('Failed to fetch');
            };
        }

        world.relays.relay(OWN_RELAY).kill();
        await passAsync(world, 3000, 500);
        await waitForAsync(() => notices.length === 1, 'the notice');

        // Act
        phone?.discovery.stop();

        // Assert
        expect(notices[0]?.isCertain).toBe(false);
        expect(notices).toHaveLength(2);
        expect(phone?.discovery.relayAllowance()).toBeUndefined();
    });
});

describe('createDiscovery page lifecycle', () => {
    it('keeps one row when a page reloads in the same tab without saying goodbye', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const before = ids(laptop as TestDevice);

        // Act
        world.relays.cut('Phone A');
        const reloaded = world.addDevice('Phone A', {
            client: 'Phone A reloaded',
            sessionStore: phone?.sessionStore,
        });
        await passAsync(world, 3000, 500);
        await waitForAsync(() => reloaded.discovery.devices().length === 1, 'the reloaded page to hear the laptop');
        await passAsync(world, 90_000);

        // Assert
        expect(ids(laptop as TestDevice)).toEqual(before);
        expect(names(laptop as TestDevice)).toEqual(['Phone A']);
        expect(laptop?.deviceLists.every(list => list.length <= 1)).toBe(true);
    });

    it('takes requests in the reloaded page, under its new keys', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        world.relays.cut('Phone A');
        const reloaded = world.addDevice('Phone A', { client: 'Phone A reloaded', sessionStore: phone?.sessionStore });
        await passAsync(world, 3000, 500);
        await waitForAsync(() => reloaded.discovery.devices().length === 1, 'the reloaded page to hear the laptop');

        // Act
        const { outcome, request } = await requestAsync(laptop as TestDevice, reloaded);
        await reloaded.discovery.acceptAsync(request.requestId, ANSWER);

        // Assert
        await expect(outcome).resolves.toEqual({ kind: 'accepted', answerCode: ANSWER });
        expect(phone?.requests).toEqual([]);
    });

    it('welcomes the reloaded page back after the goodbye the old page did send', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const before = ids(laptop as TestDevice);

        // Act
        phone?.fake.setHidden(true);
        await waitForAsync(() => laptop?.discovery.devices().length === 0, 'the goodbye');
        const reloaded = world.addDevice('Phone A', { client: 'Phone A reloaded', sessionStore: phone?.sessionStore });
        await waitForAsync(() => laptop?.discovery.devices().length === 1, 'the reloaded page');

        // Assert
        expect(ids(laptop as TestDevice)).toEqual(before);
        expect(reloaded.discovery.status()).toBe('listening');
    });

    it('leaves while hidden and comes back as the same row when visible', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const before = ids(phone as TestDevice);

        // Act
        laptop?.fake.setHidden(true);
        await waitForAsync(() => phone?.discovery.devices().length === 0, 'the laptop to leave');
        const hiddenStatus = laptop?.discovery.status();
        await passAsync(world, 60_000);
        const quietWhileHidden = world.relays.socketsOf('Laptop B').length;
        laptop?.fake.setHidden(false);
        await waitForAsync(() => phone?.discovery.devices().length === 1, 'the laptop to come back');

        // Assert
        expect(hiddenStatus).toBe('off');
        expect(quietWhileHidden).toBe(0);
        expect(laptop?.statuses.slice(-3)).toEqual(['off', 'starting', 'listening']);
        expect(ids(phone as TestDevice)).toEqual(before);
    });

    it('ends its open prompt and the request it sent when it hides', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop, tablet] = await meetAsync(world, 'Phone A', 'Laptop B', 'Tablet C');
        const incoming = await requestAsync(phone as TestDevice, laptop as TestDevice);
        const outgoing = await requestAsync(laptop as TestDevice, tablet as TestDevice);

        // Act
        laptop?.fake.setHidden(true);
        await waitForAsync(() => tablet?.ended.includes(outgoing.request.requestId) === true, 'the prompt to end');

        // Assert
        expect(laptop?.ended).toEqual([incoming.request.requestId]);
        await expect(incoming.outcome).resolves.toEqual({ kind: 'no-answer' });
        await expect(outgoing.outcome).resolves.toEqual({ kind: 'canceled' });
    });

    it('waits for the page to be visible before joining', async () => {
        // Arrange
        const world = createWorld();
        const [phone] = await meetAsync(world, 'Phone A');
        const laptop = world.addDevice('Laptop B', { isHidden: true });
        await settleAsync();
        const hiddenStatus = laptop.discovery.status();

        // Act
        laptop.fake.setHidden(false);
        await waitForAsync(() => phone?.discovery.devices().length === 1, 'the laptop to join');

        // Assert
        expect(hiddenStatus).toBe('off');
        expect(world.relays.relays[0]?.published.length).toBeGreaterThan(0);
    });

    it('falls back to a new identity for each page load when session storage is blocked', async () => {
        // Arrange
        const world = createWorld();
        const blocked = new FakeSessionStore();
        blocked.isBlocked = true;
        const phone = world.addDevice('Phone A', { sessionStore: blocked });
        const laptop = world.addDevice('Laptop B');
        await waitForAsync(() => laptop.discovery.devices().length === 1, 'the laptop to list the phone');
        const firstId = ids(laptop)[0];

        // Act
        world.relays.cut('Phone A');
        const reloaded = world.addDevice('Phone A', { client: 'Phone A reloaded', sessionStore: blocked });
        await waitForAsync(() => ids(laptop).some(id => id !== firstId), 'the reloaded page');

        // Assert
        expect(reloaded.discovery.status()).toBe('listening');
        expect(phone.entries().some(entry => entry.msg.startsWith('session storage unavailable'))).toBe(true);
        expect(phone.entries().some(entry => entry.level === 'error')).toBe(false);
    });

    it('gives a duplicated tab, which copied the identity, a new one, so both show', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const copied = new FakeSessionStore();
        for (const [key, value] of phone?.sessionStore.values ?? []) {
            copied.values.set(key, value);
        }

        // Act
        const duplicate = world.addDevice('Phone A', { client: 'Phone A duplicate', sessionStore: copied });
        await passAsync(world, 5000, 500);
        await waitForAsync(() => laptop?.discovery.devices().length === 2, 'two phone rows');

        // Assert
        expect(names(laptop as TestDevice)).toEqual(['Phone A', 'Phone A']);
        expect(new Set(ids(laptop as TestDevice)).size).toBe(2);
        expect(duplicate.discovery.status()).toBe('listening');
        const stored = [phone?.sessionStore.values, copied.values].map(values => values?.get('ether.nearby.identity'));
        expect(stored[0]).not.toBe(stored[1]);
    });
});

describe('createDiscovery rows for one device', () => {
    it('lets a new device take the row of a quiet one with the same name and type', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        const oldId = idOf(laptop as TestDevice, 'Phone A');
        world.relays.cut('Phone A');
        await passAsync(world, 45_000);
        const stillListed = names(laptop as TestDevice);

        // Act
        world.addDevice('Phone A', { client: 'Phone A new tab' });
        await waitForAsync(() => !ids(laptop as TestDevice).includes(oldId), 'the new tab to take the row');

        // Assert
        expect(stillListed).toEqual(['Phone A']);
        expect(names(laptop as TestDevice)).toEqual(['Phone A']);
        expect(phone?.discovery.status()).not.toBe('listening');
    });

    it('keeps both rows for two live devices that share a name', async () => {
        // Arrange
        const world = createWorld();
        const [, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');

        // Act
        world.addDevice('Phone A', { client: 'Another Phone A' });
        await waitForAsync(() => laptop?.discovery.devices().length === 2, 'both phones');
        await passAsync(world, 120_000);

        // Assert
        expect(names(laptop as TestDevice)).toEqual(['Phone A', 'Phone A']);
    });

    it('keeps a quiet row when the new device has another name', async () => {
        // Arrange
        const world = createWorld();
        const [, laptop] = await meetAsync(world, 'Phone A', 'Laptop B');
        world.relays.cut('Phone A');
        await passAsync(world, 45_000);

        // Act
        world.addDevice('Phone C');
        await waitForAsync(() => laptop?.discovery.devices().length === 2, 'the new phone');

        // Assert
        expect(names(laptop as TestDevice)).toEqual(['Phone A', 'Phone C']);
    });
});

describe('createDiscovery PIN', () => {
    const PIN = '86420975';
    const WRONG_PIN = '13579024';

    // Laptop B has a PIN, and Phone A lists it with the PIN flag.
    async function meetWithPinAsync(world: World): Promise<{
        readonly phone: TestDevice;
        readonly laptop: TestDevice;
    }> {
        const [phone, laptop] = (await meetAsync(world, 'Phone A', 'Laptop B')) as [TestDevice, TestDevice];
        laptop.discovery.start({ name: 'Laptop B', deviceType: 'desktop', pin: PIN });
        await waitForAsync(() => phone.discovery.devices()[0]?.hasPin === true, 'the PIN flag');

        return { phone, laptop };
    }

    function askAsync(phone: TestDevice, pin?: string): Promise<PairRequestOutcome> {
        const options = pin == null ? {} : { pin };

        return phone.discovery.requestPairingAsync(idOf(phone, 'Laptop B'), OFFER, options);
    }

    it('says at once that a device has a PIN, and that it has none once removed, never the PIN', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = (await meetAsync(world, 'Phone A', 'Laptop B')) as [TestDevice, TestDevice];
        const before = phone.discovery.devices()[0]?.hasPin;

        // Act
        laptop.discovery.start({ name: 'Laptop B', deviceType: 'desktop', pin: PIN });
        await waitForAsync(() => phone.discovery.devices()[0]?.hasPin === true, 'the PIN flag');
        laptop.discovery.start({ name: 'Laptop B', deviceType: 'desktop' });
        await waitForAsync(() => phone.discovery.devices()[0]?.hasPin === undefined, 'the PIN flag to go');
        const seen = world.relays.relays.flatMap(relay => relay.frames).join('\n');

        // Assert
        expect(before).toBeUndefined();
        expect(seen).not.toContain(PIN);
        expect(laptop.entries().some(entry => entry.msg === 'name, device type or PIN changed; announcing')).toBe(true);
    });

    it('takes a request with the right PIN as verified, so the asker connects without an Accept', async () => {
        // Arrange
        const world = createWorld();
        const { phone, laptop } = await meetWithPinAsync(world);

        // Act
        const outcome = askAsync(phone, PIN);
        await waitForAsync(() => laptop.requests.length === 1, 'the request');
        const request = laptop.requests[0];
        await laptop.discovery.acceptAsync(request?.requestId ?? '', ANSWER);

        // Assert
        expect(request).toMatchObject({ offerCode: OFFER, isPinVerified: true, from: { name: 'Phone A' } });
        await expect(outcome).resolves.toEqual({ kind: 'accepted', answerCode: ANSWER });
    });

    it.each([
        ['no PIN, as from an older build', undefined, 'pin-required'],
        ['a wrong PIN', WRONG_PIN, 'wrong-pin'],
    ] as const)('turns down a request with %s without asking', async (_, pin, kind) => {
        // Arrange
        const world = createWorld();
        const { phone, laptop } = await meetWithPinAsync(world);

        // Act
        const outcome = await askAsync(phone, pin);
        await settleAsync();

        // Assert
        expect(outcome).toEqual({ kind });
        expect(laptop.requests).toEqual([]);
    });

    it('ignores the proof when it has no PIN, as an older build does, and asks as usual', async () => {
        // Arrange
        const world = createWorld();
        const [phone, laptop] = (await meetAsync(world, 'Phone A', 'Laptop B')) as [TestDevice, TestDevice];

        // Act
        const outcome = askAsync(phone, PIN);
        await waitForAsync(() => laptop.requests.length === 1, 'the request');
        await laptop.discovery.declineAsync(laptop.requests[0]?.requestId ?? '');

        // Assert
        expect(laptop.requests[0]?.isPinVerified).toBe(false);
        await expect(outcome).resolves.toEqual({ kind: 'declined' });
    });

    it('answers busy for a minute after 5 wrong PINs, the right one too, and logs it without the PIN', async () => {
        // Arrange
        const world = createWorld();
        const { phone, laptop } = await meetWithPinAsync(world);
        const wrong: PairRequestOutcome[] = [];
        for (let attempt = 0; attempt < 5; attempt++) {
            wrong.push(await askAsync(phone, WRONG_PIN));
        }

        // Act
        const whileLocked = await askAsync(phone, PIN);
        await passAsync(world, 60_000);
        const afterwards = askAsync(phone, PIN);
        await waitForAsync(() => laptop.requests.length === 1, 'the request after the lockout');
        const logged = JSON.stringify(laptop.entries().map(entry => [entry.msg, entry.data]));

        // Assert
        expect(wrong.map(outcome => outcome.kind)).toEqual(Array.from({ length: 5 }, () => 'wrong-pin'));
        expect(whileLocked).toEqual({ kind: 'busy' });
        expect(laptop.requests[0]?.isPinVerified).toBe(true);
        expect(logged).toContain('5 wrong PINs from one device; answering it busy');
        expect(logged).not.toContain(PIN);
        expect(logged).not.toContain(WRONG_PIN);
        expect(logged).not.toContain(idOf(laptop, 'Phone A'));
        await laptop.discovery.declineAsync(laptop.requests[0]?.requestId ?? '');
        await afterwards;
    });
});
