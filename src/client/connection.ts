import { toDevicePlatform } from '../core/deviceInfo.js';
import type { DevicePlatform } from '../core/deviceInfo.js';
import type { Emitter, Unsubscribe } from '../core/events.js';
import type { LogEntry, Logger, LoggerController } from '../core/logger.js';
import { createPeerSink } from '../core/logSinks.js';
import type { PeerSink } from '../core/logSinks.js';
import type { Settings } from '../core/settings.js';
import { NetworkError } from '../network/networkTypes.js';
import type {
    ChannelName,
    CreateNetwork,
    FrameHeader,
    LinkState,
    Message,
    Network,
    NetworkOptions,
    PairingCode,
} from '../network/networkTypes.js';
import { ClientError } from './clientTypes.js';
import type {
    ClientErrorCode,
    ClientEvents,
    ConnectionState,
    Peer,
    SessionKnown,
    SessionRecord,
    StartFreshResult,
} from './clientTypes.js';
import { computeSessionIdAsync } from './hashing.js';
import { PROTOCOL_VERSION, isMajorCompatible, requestIdOf, splitLogEntries, splitSync, validateMessage } from './protocol.js';
import type { HelloMessage, LogMessage, ProtocolMessage, SyncEntry, SyncMessage } from './protocol.js';
import type { SessionStore } from './sessionStore.js';
import type { Link, SendResult } from './transferContext.js';

// Pairing, hello, the session record and its connection log, sync, message validation and dispatch,
// the Restore prompt's hold and Start fresh, and what happens when the link goes
// (§3, §7.4 steps 1–2, CL-03, CL-09).

const MAX_CONNECTION_LOG = 100;
// CL-03: this many invalid messages within the window ends the connection.
const INVALID_LIMIT = 10;
const INVALID_WINDOW_MS = 10_000;
const PEER_LOG_FLUSH_MS = 1000;
const MAX_PEER_LOG_DATA = 2000;

const NETWORK_ERROR_CODES: Readonly<Partial<Record<NetworkError['code'], ClientErrorCode>>> = Object.freeze({
    'code-invalid': 'code-invalid',
    'code-expired': 'code-expired',
    'code-version': 'code-version',
    'code-used': 'code-used',
    'gathering-timeout': 'gathering-timeout',
    'connect-timeout': 'connect-timeout',
    'ice-failed': 'ice-failed',
    'channel-closed': 'not-connected',
    closed: 'not-connected',
});

export type RestoreCounts = Pick<SessionKnown, 'receivedCount' | 'sentCount' | 'unfinishedCount'>;

export interface ConnectionRouter {
    // The link is open and the session known, before sync goes out.
    linkUpAsync(link: Link): Promise<void>;
    // What the Restore prompt counts; undefined when the session holds no files, so there is nothing to ask.
    restoreCountsAsync(sessionId: string): Promise<RestoreCounts | undefined>;
    // Start fresh on this side: every file of the session goes, transfers in progress canceled.
    // Resolves to the number of file records removed.
    resetSessionAsync(sessionId: string): Promise<number>;
    syncEntriesAsync(sessionId: string): Promise<SyncEntry[]>;
    applyPeerSyncAsync(sessionId: string, entries: readonly SyncEntry[]): Promise<void>;
    handleMessage(channel: ChannelName, message: ProtocolMessage): void;
    handleFrame(header: FrameHeader, payload: Uint8Array): void;
    linkDownAsync(reason: string): Promise<void>;
}

export interface ConnectionOptions {
    readonly deviceId: string;
    readonly platform?: DevicePlatform;
    readonly logger: Logger;
    readonly loggerController?: LoggerController;
    readonly events: Emitter<ClientEvents>;
    readonly sessions: SessionStore;
    readonly createNetwork: CreateNetwork;
    readonly networkOptions: () => NetworkOptions;
    readonly settings: () => Settings;
    readonly now: () => number;
    readonly randomId: () => string;
    readonly router: ConnectionRouter;
}

export interface Connection {
    readonly state: ConnectionState;
    readonly peer: Peer | undefined;
    readonly link: Link | undefined;
    // The session of the last connection in this page, so files can still be queued while the link is down.
    readonly lastSessionId: string | undefined;
    readonly network: Network | undefined;
    startPairingAsync(): Promise<PairingCode>;
    joinWithCodeAsync(codeOrUrl: string): Promise<{ answerCode: string; answerUrl: string }>;
    completePairingAsync(answerCodeOrUrl: string): Promise<Peer>;
    cancelPairing(): void;
    disconnectAsync(): Promise<void>;
    dropForTest(): void;
    sendSyncAsync(): Promise<void>;
    restoreSessionAsync(sessionId: string): Promise<void>;
    startFreshAsync(sessionId: string): Promise<StartFreshResult>;
    sendName(name: string): void;
    configureNetwork(): void;
    refreshPeerLogs(): void;
    dispose(): void;
}

interface Attempt {
    readonly network: Network;
    readonly role: 'offerer' | 'answerer';
    readonly unsubscribes: Unsubscribe[];
    readonly buffered: Array<{ readonly channel: ChannelName; readonly message: ProtocolMessage }>;
    hello?: HelloMessage;
    onHello?: (hello: HelloMessage) => void;
    handshake?: Promise<Peer>;
    current?: Current;
    syncEntries: SyncEntry[];
    syncChain: Promise<void>;
    isClosedByUs: boolean;
    downPromise?: Promise<void>;
}

// While the Restore prompt is open this device sends no sync and keeps the peer's, so nothing resumes on either
// side: a sender resumes only on the receiver's sync, and each device's sync waits for its own Restore.
interface RestoreHold {
    // 'asking' until this device answers, or until the peer's Start fresh answers for it.
    choice: 'asking' | 'restore' | 'fresh';
    isReleased: boolean;
    peerSync?: SyncEntry[];
}

interface Current {
    readonly link: Link & { isOpen: boolean };
    peer: Peer;
    readonly sessionId: string;
    readonly connectionId: string;
    readonly hold?: RestoreHold;
    // This connection already started fresh, here or on the peer: another session-reset has nothing left to clear.
    isFresh: boolean;
}

export function toClientError(error: unknown): ClientError {
    if (error instanceof ClientError) {
        return error;
    }

    if (error instanceof NetworkError) {
        return new ClientError(NETWORK_ERROR_CODES[error.code] ?? 'internal', error.message, undefined, { cause: error });
    }

    return new ClientError('internal', error instanceof Error ? error.message : 'Unexpected error', undefined, { cause: error });
}

export function displayNameFor(peerName: string, peerDeviceId: string, ownName: string): string {
    if (peerName.trim().toLowerCase() !== ownName.trim().toLowerCase()) {
        return peerName;
    }

    return `${peerName} (${peerDeviceId.slice(-4)})`;
}

function trimForPeer(entry: LogEntry): LogEntry {
    if (entry.data === undefined || JSON.stringify(entry.data).length <= MAX_PEER_LOG_DATA) {
        return entry;
    }

    const { data: _, ...rest } = entry;

    return rest;
}

export function createConnection(options: ConnectionOptions): Connection {
    const { logger, events, router } = options;
    let state: ConnectionState = 'idle';
    let attempt: Attempt | undefined;
    let lastSessionId: string | undefined;
    let peerLogTimer: ReturnType<typeof setInterval> | undefined;
    let invalidTimes: number[] = [];
    // Sessions whose Restore prompt this page run answered, or never needed: a reconnect after link loss resumes
    // them without asking again. A link that closes (Disconnect, or the peer left) takes the session out.
    const answeredSessions = new Set<string>();

    const setState = (next: ConnectionState): void => {
        if (state === next) {
            return;
        }

        state = next;
        events.emit('state', next);
    };

    const current = (): Current | undefined => attempt?.current;

    const peerSink = (): PeerSink | undefined => {
        const controller = options.loggerController;
        if (!controller) {
            return undefined;
        }

        const existing = controller.getSink<PeerSink>('peer');
        if (existing) {
            return existing;
        }

        const sink = createPeerSink();
        controller.addSink(sink);

        return sink;
    };

    const detachPeerLogs = (): void => {
        clearInterval(peerLogTimer);
        peerLogTimer = undefined;
        options.loggerController?.getSink<PeerSink>('peer')?.detach();
    };

    // DL-15: the peer sink streams this device's handshake and resume entries over control.
    const refreshPeerLogs = (): void => {
        detachPeerLogs();
        const live = current();
        if (!options.settings().peerLogs || !live) {
            return;
        }

        const sink = peerSink();
        if (!sink) {
            return;
        }

        sink.attach(entries => {
            for (const chunk of splitLogEntries(entries.map(trimForPeer))) {
                live.link.send('control', { t: 'log', entries: chunk });
            }
        });
        peerLogTimer = setInterval(() => sink.flush(), PEER_LOG_FLUSH_MS);
    };

    const createLink = (network: Network, sessionId: string, connectionId: string, peerName: () => string): Link & { isOpen: boolean } => {
        let isOpen = true;
        const fail = (error: unknown): SendResult => {
            if (error instanceof NetworkError && error.code === 'message-too-large') {
                logger.warn('app', error.message);

                return 'too-large';
            }

            logger.warn('app', 'send failed, treating the link as lost', error);
            isOpen = false;
            void linkDownAsync(network, 'lost', 'send failed');

            return 'closed';
        };

        const trySend = (channel: ChannelName, message: Message): SendResult => {
            if (!isOpen) {
                return 'closed';
            }

            try {
                network.send(channel, message);

                return 'sent';
            } catch (error) {
                return fail(error);
            }
        };

        return {
            network,
            sessionId,
            connectionId,
            get peerName() {
                return peerName();
            },
            get isOpen() {
                return isOpen && network.state === 'connected';
            },
            set isOpen(value: boolean) {
                isOpen = value;
            },
            send: (channel, message) => trySend(channel, message as Message) === 'sent',
            trySend: (channel, message) => trySend(channel, message as Message),
            sendFrame: (header, payload) => {
                if (!isOpen) {
                    return false;
                }

                try {
                    network.sendFrame(header, payload);

                    return true;
                } catch (error) {
                    return fail(error) === 'sent';
                }
            },
            waitDrainedAsync: slot => network.waitDrainedAsync(slot),
        };
    };

    const recordInvalid = (network: Network, reason: string): void => {
        const now = options.now();
        invalidTimes = [...invalidTimes.filter(time => now - time < INVALID_WINDOW_MS), now];
        logger.warn('app', `invalid message dropped: ${reason}`);
        if (invalidTimes.length >= INVALID_LIMIT) {
            logger.error('app', `${invalidTimes.length} invalid messages in ${INVALID_WINDOW_MS / 1000} s, disconnecting`);
            invalidTimes = [];
            network.close('protocol-errors');
        }
    };

    const applySyncAsync = async (entries: readonly SyncEntry[]): Promise<void> => {
        const live = current();
        if (!live) {
            return;
        }

        logger.info('resume', `sync received: ${entries.length} ongoing files`, { sessionId: live.sessionId });
        await router.applyPeerSyncAsync(live.sessionId, entries);
    };

    // Sync, Start fresh and the peer's session-reset run one after another, so a sync never applies to files
    // that a reset is still clearing.
    const runInOrderAsync = <Result>(
        owner: Attempt,
        failure: string,
        work: () => Promise<Result>,
    ): Promise<Result> => {
        const result = owner.syncChain.then(work);
        owner.syncChain = result.then(() => undefined, error => logger.error('resume', failure, error));

        return result;
    };

    const applyInOrder = (owner: Attempt, entries: readonly SyncEntry[]): void => {
        void runInOrderAsync(owner, 'sync not applied', () => applySyncAsync(entries)).catch(() => undefined);
    };

    const handleSync = (owner: Attempt, message: SyncMessage): void => {
        if (message.index === 0) {
            owner.syncEntries = [];
        }

        owner.syncEntries.push(...message.files);
        if (!message.last) {
            return;
        }

        const entries = owner.syncEntries;
        owner.syncEntries = [];
        const hold = owner.current?.hold;
        if (hold != null && !hold.isReleased) {
            hold.peerSync = entries;
            logger.info('resume', `peer sync kept until Restore is answered: ${entries.length} ongoing files`);

            return;
        }

        applyInOrder(owner, entries);
    };

    // The answer is in: this device's sync goes out and the peer's, when it came meanwhile, applies.
    const releaseHoldAsync = async (owner: Attempt, live: Current): Promise<void> => {
        const hold = live.hold;
        if (hold == null || hold.isReleased) {
            return;
        }

        hold.isReleased = true;
        const peerSync = hold.peerSync;
        hold.peerSync = undefined;
        if (attempt !== owner || owner.current !== live || !live.link.isOpen) {
            return;
        }

        await sendSyncAsync();
        if (peerSync != null) {
            applyInOrder(owner, peerSync);
        }
    };

    // The peer started fresh: this device clears its copy the same way, once per connection.
    const handleReset = (owner: Attempt, sessionId: string): void => {
        const live = owner.current;
        if (live == null) {
            return;
        }

        if (sessionId !== live.sessionId) {
            logger.warn('store', 'session-reset for another session ignored');

            return;
        }

        if (live.isFresh) {
            logger.info('store', `${live.peer.displayName} started fresh too; nothing more to clear`, { sessionId });

            return;
        }

        live.isFresh = true;
        answeredSessions.add(sessionId);
        if (live.hold?.choice === 'asking') {
            live.hold.choice = 'fresh';
        }

        void runInOrderAsync(owner, 'the peer’s start fresh not applied', async () => {
            const removed = await router.resetSessionAsync(sessionId);
            logger.info('store', `${live.peer.displayName} started fresh: ${removed} files cleared`, { sessionId });
            events.emit('session-reset', { sessionId, peerName: live.peer.displayName, removed });
            await releaseHoldAsync(owner, live);
        }).catch(() => undefined);
    };

    const handleRename = (owner: Attempt, name: string): void => {
        const live = owner.current;
        if (!live) {
            return;
        }

        live.peer = { ...live.peer, name, displayName: displayNameFor(name, live.peer.deviceId, options.settings().deviceName) };
        void options.sessions.updateAsync(live.sessionId, session => (session ? { ...session, peerName: name } : session));
        events.emit('peer', 'renamed', live.peer);
    };

    const handlePeerLog = (owner: Attempt, message: LogMessage): void => {
        const live = owner.current;
        const controller = options.loggerController;
        if (
            !live
            || !controller
            || !options.settings().peerLogs
        ) {
            return;
        }

        for (const entry of message.entries) {
            controller.append({ ...entry, peer: live.peer.displayName });
        }
    };

    const dispatch = (owner: Attempt, channel: ChannelName, message: ProtocolMessage): void => {
        if (message.t === 'sync') {
            handleSync(owner, message);

            return;
        }

        if (message.t === 'name') {
            handleRename(owner, message.name);

            return;
        }

        if (message.t === 'session-reset') {
            handleReset(owner, message.sessionId);

            return;
        }

        if (message.t === 'log') {
            handlePeerLog(owner, message);

            return;
        }

        if (message.t === 'hello') {
            return;
        }

        router.handleMessage(channel, message);
    };

    const onMessage = (owner: Attempt, channel: ChannelName, raw: Message): void => {
        const result = validateMessage(channel, raw);
        if (!result.ok) {
            // A request is answered even when unreadable, so its sender fails it at once rather than waiting.
            const requestId = requestIdOf(raw);
            if (requestId != null && owner.current) {
                owner.current.link.send(channel, { t: 'error', re: requestId, reason: result.reason });
            }

            recordInvalid(owner.network, result.reason);

            return;
        }

        const message = result.message;
        if (message.t === 'hello') {
            owner.hello ??= message;
            owner.onHello?.(message);

            return;
        }

        if (!owner.current) {
            owner.buffered.push({ channel, message });

            return;
        }

        dispatch(owner, channel, message);
    };

    const linkDownAsync = (network: Network, linkState: 'lost' | 'closed', reason: string): Promise<void> => {
        const owner = attempt;
        if (!owner || owner.network !== network) {
            return Promise.resolve();
        }

        owner.downPromise ??= (async () => {
            const live = owner.current;
            for (const unsubscribe of owner.unsubscribes) {
                unsubscribe();
            }

            attempt = undefined;
            network.close(reason);
            if (!live) {
                logger.warn('pair', `pairing ended: ${reason}`);
                setState('idle');

                return;
            }

            live.link.isOpen = false;
            detachPeerLogs();
            const end = options.now();
            const why = owner.isClosedByUs ? 'disconnected' : reason;
            logger.info('health', `link ${linkState}: ${why}`, { sessionId: live.sessionId, connectionId: live.connectionId });
            await router.linkDownAsync(why);
            await options.sessions.updateAsync(live.sessionId, session => (session
                ? {
                    ...session,
                    connections: session.connections.map(entry => (entry.connectionId === live.connectionId ? { ...entry, end, reason: why } : entry)),
                }
                : session));
            events.emit('peer', 'left', live.peer);
            const isLost = linkState === 'lost' && !owner.isClosedByUs;
            if (!isLost) {
                answeredSessions.delete(live.sessionId);
            }

            setState(isLost ? 'lost' : 'closed');
        })();

        return owner.downPromise;
    };

    const waitForHelloAsync = (owner: Attempt): Promise<HelloMessage> => {
        if (owner.hello) {
            return Promise.resolve(owner.hello);
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                owner.onHello = undefined;
                reject(new ClientError('connect-timeout', 'The other device did not say hello'));
            }, options.settings().connectTimeoutMs);
            owner.onHello = hello => {
                clearTimeout(timer);
                owner.onHello = undefined;
                resolve(hello);
            };
        });
    };

    // Resolves to the session as it was before this connection, or undefined on the first pairing.
    const openSessionAsync = async (hello: HelloMessage, sessionId: string, connectionId: string): Promise<SessionRecord | undefined> => {
        const now = options.now();
        const peerPlatform = toDevicePlatform(hello.platform);
        // A peer that sends no platform this build knows keeps the last one it sent.
        const platform = peerPlatform == null ? {} : { peerPlatform };
        let previous: SessionRecord | undefined;
        await options.sessions.updateAsync(sessionId, session => {
            previous = session;
            const entry = { connectionId, start: now };
            if (session) {
                return {
                    ...session,
                    peerDeviceId: hello.deviceId,
                    peerName: hello.name,
                    ...platform,
                    lastConnectedAt: now,
                    connections: [...session.connections, entry].slice(-MAX_CONNECTION_LOG),
                };
            }

            return {
                sessionId,
                peerDeviceId: hello.deviceId,
                peerName: hello.name,
                ...platform,
                createdAt: now,
                lastConnectedAt: now,
                connections: [entry],
                totals: { filesSent: 0, bytesSent: 0, filesReceived: 0, bytesReceived: 0 },
            };
        });

        return previous;
    };

    // A Start fresh made while the link was down goes first, before any sync, so the peer clears its copy too.
    const sendPendingResetAsync = async (live: Current): Promise<void> => {
        if (!live.link.send('control', { t: 'session-reset', sessionId: live.sessionId })) {
            return;
        }

        logger.info('store', `start fresh sent to ${live.peer.displayName}`, { sessionId: live.sessionId });
        await options.sessions.updateAsync(live.sessionId, session => {
            if (session?.resetPending !== true) {
                return session;
            }

            const { resetPending: _, ...rest } = session;

            return rest;
        });
    };

    const sendSyncAsync = async (): Promise<void> => {
        const live = current();
        if (!live || (live.hold != null && !live.hold.isReleased)) {
            return;
        }

        const entries = await router.syncEntriesAsync(live.sessionId);
        for (const message of splitSync(entries)) {
            live.link.send('control', message);
        }

        logger.info('resume', `sync sent: ${entries.length} ongoing files`, { sessionId: live.sessionId });
    };

    // §7.4 step 1: hello both ways, then both compute the sessionId and reopen or create the session.
    const handshakeAsync = async (owner: Attempt): Promise<Peer> => {
        const network = owner.network;
        const settings = options.settings();
        const ownConnectionId = options.randomId();
        const hello: HelloMessage = {
            t: 'hello',
            protocol: PROTOCOL_VERSION,
            deviceId: options.deviceId,
            name: settings.deviceName,
            connectionId: ownConnectionId,
            ...(options.platform == null ? {} : { platform: options.platform }),
        };
        network.send('control', hello);
        const peerHello = await waitForHelloAsync(owner);
        if (!isMajorCompatible(peerHello.protocol)) {
            const where = peerHello.protocol > PROTOCOL_VERSION ? 'this device' : peerHello.name;
            const error = new ClientError('protocol-version', `Update the app on ${where}`);
            logger.error('pair', error.message, { peerProtocol: peerHello.protocol, protocol: PROTOCOL_VERSION });
            events.emit('error', error);
            network.close('protocol-version');
            throw error;
        }

        const connectionId = owner.role === 'offerer' ? ownConnectionId : peerHello.connectionId;
        const sessionId = await computeSessionIdAsync(options.deviceId, peerHello.deviceId);
        const previous = await openSessionAsync(peerHello, sessionId, connectionId);
        const peerPlatform = toDevicePlatform(peerHello.platform);
        const isResetPending = previous?.resetPending === true;
        // Asked only about a session that already held files, and not again after a link loss in this page run.
        const counts = previous == null || isResetPending || answeredSessions.has(sessionId)
            ? undefined
            : await router.restoreCountsAsync(sessionId);
        const peer: Peer = {
            deviceId: peerHello.deviceId,
            name: peerHello.name,
            displayName: displayNameFor(peerHello.name, peerHello.deviceId, settings.deviceName),
            sessionId,
            connectionId,
            ...(network.checkCode == null ? {} : { checkCode: network.checkCode }),
            protocol: peerHello.protocol,
            ...(peerPlatform == null ? {} : { platform: peerPlatform }),
        };
        // The hold is in place before any message is dispatched, so a sync that arrived early waits as well.
        const live: Current = {
            link: createLink(network, sessionId, connectionId, () => live.peer.displayName),
            peer,
            sessionId,
            connectionId,
            hold: counts == null ? undefined : { choice: 'asking', isReleased: false },
            isFresh: isResetPending,
        };
        if (attempt !== owner || network.state !== 'connected') {
            throw new ClientError('not-connected', 'The link closed during the handshake');
        }

        owner.current = live;
        lastSessionId = sessionId;
        if (counts == null) {
            answeredSessions.add(sessionId);
        }

        logger.info('pair', `hello from ${peer.displayName}, session ${sessionId.slice(0, 8)}`, { sessionId, connectionId });
        if (isResetPending) {
            await sendPendingResetAsync(live);
        }

        await router.linkUpAsync(live.link);
        setState('connected');
        events.emit('peer', 'connected', peer);
        refreshPeerLogs();
        const buffered = owner.buffered.splice(0);
        for (const { channel, message } of buffered) {
            dispatch(owner, channel, message);
        }

        // A session-reset among the buffered messages answered the prompt already: it releases the hold itself.
        if (counts != null && live.hold?.choice === 'asking' && previous != null) {
            logger.info('resume', `known session with ${peer.displayName}, asking`, { sessionId, ...counts });
            events.emit('session-known', {
                sessionId,
                peerName: peer.displayName,
                lastConnectedAt: previous.lastConnectedAt,
                ...counts,
            });

            return peer;
        }

        await sendSyncAsync();

        return peer;
    };

    const restoreSessionAsync = async (sessionId: string): Promise<void> => {
        answeredSessions.add(sessionId);
        const owner = attempt;
        const live = owner?.current;
        if (owner == null || live?.sessionId !== sessionId || live.hold?.choice !== 'asking') {
            return;
        }

        live.hold.choice = 'restore';
        logger.info('resume', 'restore chosen', { sessionId });
        await releaseHoldAsync(owner, live);
    };

    const startFreshAsync = async (sessionId: string): Promise<StartFreshResult> => {
        answeredSessions.add(sessionId);
        const owner = attempt;
        const live = owner?.current?.sessionId === sessionId ? owner.current : undefined;
        if (live?.isFresh === true) {
            // This connection started fresh already (from the peer, most likely): there is nothing left to clear.
            return { removed: 0, isPeerNotified: true };
        }

        if (live != null) {
            live.isFresh = true;
            if (live.hold?.choice === 'asking') {
                live.hold.choice = 'fresh';
            }
        }

        const clearAsync = (): Promise<number> => router.resetSessionAsync(sessionId);
        const removed = owner != null && live != null
            ? await runInOrderAsync(owner, 'start fresh failed', clearAsync)
            : await clearAsync();
        const isPeerNotified = live != null
            && attempt === owner
            && live.link.send('control', { t: 'session-reset', sessionId });
        if (!isPeerNotified) {
            await options.sessions.updateAsync(sessionId, session => (session == null
                ? session
                : { ...session, resetPending: true }));
        }

        const later = isPeerNotified ? '' : ', the peer is told at the next connection';
        logger.info('store', `started fresh: ${removed} files cleared${later}`, { sessionId });
        if (owner != null && live != null) {
            await releaseHoldAsync(owner, live);
        }

        return { removed, isPeerNotified };
    };

    const startHandshakeAsync = (owner: Attempt): Promise<Peer> => {
        owner.handshake ??= handshakeAsync(owner);
        owner.handshake.catch(error => {
            logger.warn('pair', 'handshake failed', error);
            if (attempt === owner && !owner.current) {
                void linkDownAsync(owner.network, 'closed', 'handshake failed');
            }
        });

        return owner.handshake;
    };

    const onLinkState = (owner: Attempt, linkState: LinkState): void => {
        if (linkState === 'connected' && !owner.current) {
            void startHandshakeAsync(owner);

            return;
        }

        if (linkState === 'lost' || linkState === 'closed') {
            void linkDownAsync(owner.network, linkState, linkState === 'lost' ? 'link lost' : 'peer left');
        }
    };

    const discardAttempt = (): void => {
        const owner = attempt;
        if (!owner || owner.current) {
            return;
        }

        for (const unsubscribe of owner.unsubscribes) {
            unsubscribe();
        }

        attempt = undefined;
        owner.network.close('pairing canceled');
    };

    const beginAttempt = (role: Attempt['role']): Attempt => {
        if (attempt?.current) {
            throw new ClientError('busy', 'Already connected; disconnect first');
        }

        discardAttempt();
        // Nothing logged before this pairing (another device's files and sessions) may reach the new peer (DL-15).
        options.loggerController?.getSink<PeerSink>('peer')?.dispose?.();
        invalidTimes = [];
        const network = options.createNetwork(options.networkOptions());
        const owner: Attempt = {
            network,
            role,
            unsubscribes: [],
            buffered: [],
            syncEntries: [],
            syncChain: Promise.resolve(),
            isClosedByUs: false,
        };
        owner.unsubscribes.push(
            network.on('state', linkState => onLinkState(owner, linkState)),
            network.on('message', (channel, message) => onMessage(owner, channel, message)),
            network.on('frame', (header, payload) => {
                if (owner.current) {
                    router.handleFrame(header, payload);
                }
            }),
            network.on('health', health => {
                if (owner.current) {
                    events.emit('health', health);
                }
            }),
            network.on('error', error => {
                logger.warn('pair', `network error ${error.code}: ${error.message}`);
                events.emit('error', toClientError(error));
            }),
        );
        attempt = owner;
        options.loggerController?.markOrigin();

        return owner;
    };

    return {
        get state() {
            return state;
        },
        get peer() {
            return current()?.peer;
        },
        get link() {
            return current()?.link;
        },
        get lastSessionId() {
            return lastSessionId;
        },
        get network() {
            return attempt?.network;
        },
        startPairingAsync: async () => {
            const owner = beginAttempt('offerer');
            setState('creating-offer');
            try {
                const offer = await owner.network.createOfferAsync();
                setState('awaiting-answer');
                logger.info('pair', 'offer ready, waiting for the answer');

                return offer;
            } catch (error) {
                discardAttempt();
                setState('idle');
                throw toClientError(error);
            }
        },
        joinWithCodeAsync: async codeOrUrl => {
            const owner = beginAttempt('answerer');
            setState('answering');
            try {
                const answer = await owner.network.acceptOfferAsync(codeOrUrl);
                if (state === 'answering') {
                    setState('connecting');
                }

                return { answerCode: answer.code, answerUrl: answer.url };
            } catch (error) {
                discardAttempt();
                setState('idle');
                throw toClientError(error);
            }
        },
        completePairingAsync: async answerCodeOrUrl => {
            const owner = attempt;
            if (
                !owner
                || owner.role !== 'offerer'
                || owner.current
            ) {
                throw new ClientError('invalid-state', 'No offer is waiting for an answer');
            }

            setState('connecting');
            try {
                await owner.network.acceptAnswerAsync(answerCodeOrUrl);
            } catch (error) {
                const clientError = toClientError(error);
                if (attempt === owner && owner.network.state === 'awaiting-answer') {
                    setState('awaiting-answer');
                }

                throw clientError;
            }

            return startHandshakeAsync(owner);
        },
        cancelPairing: () => {
            if (attempt && !attempt.current) {
                discardAttempt();
                setState('idle');
            }
        },
        disconnectAsync: async () => {
            const owner = attempt;
            if (!owner) {
                return;
            }

            if (!owner.current) {
                discardAttempt();
                setState('idle');

                return;
            }

            owner.isClosedByUs = true;
            await linkDownAsync(owner.network, 'closed', 'disconnect');
        },
        dropForTest: () => {
            const owner = attempt;
            if (!owner?.current) {
                return;
            }

            logger.warn('health', 'test tool: dropping the connection');
            void linkDownAsync(owner.network, 'lost', 'test-drop');
        },
        sendSyncAsync,
        restoreSessionAsync,
        startFreshAsync,
        sendName: name => {
            current()?.link.send('control', { t: 'name', name });
        },
        configureNetwork: () => {
            const { logger: _, ...changes } = options.networkOptions();
            attempt?.network.configure(changes);
        },
        refreshPeerLogs,
        dispose: () => {
            detachPeerLogs();
            const owner = attempt;
            attempt = undefined;
            if (owner) {
                for (const unsubscribe of owner.unsubscribes) {
                    unsubscribe();
                }

                owner.network.close('dispose');
            }
        },
    };
}
