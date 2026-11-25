import type { Logger } from '../core/logger.js';
import { parseCandidate } from '../network/sdp.js';

// The public IPv4 address, from several STUN servers at once. Only this lookup uses STUN:
// pairing itself keeps `iceServers: []` and local addresses (HS-01).

// Cloudflare first; Google's servers back it up and outvote a server that answers oddly.
export const STUN_SERVERS: readonly string[] = Object.freeze([
    'stun:stun.cloudflare.com:3478',
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
]);

export interface StunEnvironment {
    createPeerConnection(configuration: RTCConfiguration): RTCPeerConnection;
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface PublicAddressOptions {
    readonly servers: readonly string[];
    readonly environment: StunEnvironment;
    readonly logger: Logger;
    readonly timeoutMs: number;
}

export interface PublicAddressResult {
    // Undefined when no server gave an IPv4 address in time.
    readonly address?: string;
    readonly answered: readonly string[];
    readonly silent: readonly string[];
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

interface Vote {
    readonly servers: Set<string>;
    // Arrival order, so a tie goes to the address heard first.
    readonly order: number;
}

// One throwaway peer connection per server, all at once; resolves as soon as no answer still missing could
// change the winner, or at the timeout. IPv6 is left out: each device has its own, so it can't group a home.
export function findPublicAddressAsync(options: PublicAddressOptions): Promise<PublicAddressResult> {
    const { servers, environment, logger } = options;
    const votes = new Map<string, Vote>();
    const answers = new Map<string, string>();
    const finished = new Set<string>();
    const connections: RTCPeerConnection[] = [];

    return new Promise(resolve => {
        let isDone = false;
        const finish = (): void => {
            if (isDone) {
                return;
            }

            isDone = true;
            environment.clearTimeout(timer);
            for (const connection of connections) {
                closeQuietly(connection);
            }

            const result = summarize(servers, answers, votes);
            logResult(logger, servers, result);
            resolve(result);
        };
        const decideIfClear = (): void => {
            if (isDecided(votes, servers.length - finished.size)) {
                finish();
            }
        };
        const onAddress = (server: string, address: string): void => {
            if (answers.has(server)) {
                return;
            }

            answers.set(server, address);
            const vote = votes.get(address) ?? { servers: new Set<string>(), order: votes.size };
            vote.servers.add(server);
            votes.set(address, vote);
            finished.add(server);
            decideIfClear();
        };
        const onFinished = (server: string): void => {
            finished.add(server);
            decideIfClear();
        };
        const timer = environment.setTimeout(finish, options.timeoutMs);

        for (const server of servers) {
            const connection = askServer({ server, environment, logger, onAddress, onFinished });
            if (connection != null) {
                connections.push(connection);
            }
        }

        decideIfClear();
    });
}

interface AskOptions {
    readonly server: string;
    readonly environment: StunEnvironment;
    readonly logger: Logger;
    readonly onAddress: (server: string, address: string) => void;
    readonly onFinished: (server: string) => void;
}

// A data channel gives the offer a section to gather for; nothing is ever connected.
function askServer(options: AskOptions): RTCPeerConnection | undefined {
    const { server, onAddress, onFinished } = options;
    let connection: RTCPeerConnection;
    try {
        connection = options.environment.createPeerConnection({ iceServers: [{ urls: server }] });
    } catch (error) {
        options.logger.warn('nearby', `STUN ${server} refused by the browser`, { error });
        onFinished(server);

        return undefined;
    }

    connection.addEventListener('icecandidate', event => {
        const line = (event as RTCPeerConnectionIceEvent).candidate?.candidate;
        if (line == null || line === '') {
            return;
        }

        const candidate = parseCandidate(line);
        if (candidate?.type === 'srflx' && isPublicIpv4(candidate.address)) {
            onAddress(server, candidate.address);
        }
    });
    connection.addEventListener('icegatheringstatechange', () => {
        if (connection.iceGatheringState === 'complete') {
            onFinished(server);
        }
    });
    void gatherAsync(connection).catch((error: unknown) => {
        options.logger.debug('nearby', `STUN ${server} offer failed`, { error });
        onFinished(server);
    });

    return connection;
}

async function gatherAsync(connection: RTCPeerConnection): Promise<void> {
    connection.createDataChannel('stun');
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
}

// Clear once the leader would still lead, or win the tie it reached first, if every missing answer went
// to the strongest rival or to an address not heard yet.
function isDecided(votes: ReadonlyMap<string, Vote>, remaining: number): boolean {
    const ranked = rank(votes);
    const leader = ranked[0];
    if (leader == null) {
        return remaining === 0;
    }

    const leaderCount = leader.servers.size;
    const rivals = ranked.slice(1);
    const canRivalOvertake = rivals.some(rival => {
        const best = rival.servers.size + remaining;

        return best > leaderCount || (best === leaderCount && rival.order < leader.order);
    });

    return !canRivalOvertake && remaining <= leaderCount;
}

function rank(votes: ReadonlyMap<string, Vote>): (Vote & { readonly address: string })[] {
    return [...votes.entries()]
        .map(([address, vote]) => ({ ...vote, address }))
        .sort((first, second) => second.servers.size - first.servers.size || first.order - second.order);
}

function summarize(
    servers: readonly string[],
    answers: ReadonlyMap<string, string>,
    votes: ReadonlyMap<string, Vote>,
): PublicAddressResult {
    const address = rank(votes)[0]?.address;
    const answered = servers.filter(server => answers.has(server));
    const silent = servers.filter(server => !answers.has(server));

    return address == null ? { answered, silent } : { address, answered, silent };
}

// The address itself never reaches the log: it locates the home.
function logResult(logger: Logger, servers: readonly string[], result: PublicAddressResult): void {
    if (result.address == null) {
        logger.warn('nearby', `no STUN server gave a public IPv4 address (${servers.length} asked)`, {
            silent: result.silent,
        });

        return;
    }

    logger.info('nearby', `public address from ${result.answered.length} of ${servers.length} STUN servers`, {
        answered: result.answered,
        silent: result.silent,
    });
}

function isPublicIpv4(address: string): boolean {
    const match = IPV4_PATTERN.exec(address);
    if (match == null) {
        return false;
    }

    const octets = match.slice(1).map(Number);
    if (octets.some(octet => octet > 255)) {
        return false;
    }

    // 0.0.0.0/8 and loopback are never what a STUN server saw.
    return octets[0] !== 0 && octets[0] !== 127;
}

function closeQuietly(connection: RTCPeerConnection): void {
    try {
        connection.close();
    } catch {
        // Closing a connection that already failed may throw; it is closed either way.
    }
}
