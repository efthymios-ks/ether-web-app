import { DurableObject } from 'cloudflare:workers';
import {
    INITIAL_STATE,
    STATUS_PATH,
    handleMessage,
    isOriginAllowed,
    matchingSubscriptions,
    statusFromError,
    statusHeaders,
} from './relayRules.js';
import type { ConnectionState, NostrEvent, RelayStatus } from './relayRules.js';

// Ether's relay on Cloudflare: the Worker takes WebSocket handshakes from Ether's own pages and hands them to one
// Durable Object, which passes each accepted event to every connection subscribed to it. The hibernation API
// keeps idle connections free: the object sleeps between messages, and each connection's subscriptions live in
// its WebSocket attachment, so they survive the sleep.

interface Env {
    readonly RELAY_HUB: DurableObjectNamespace;
    // Space-separated origins allowed to connect, from wrangler.toml.
    readonly ALLOWED_ORIGINS: string;
}

// The one object every connection meets in, whatever room it subscribes to.
const HUB_NAME = 'hub';
const NORMAL_CLOSURE = 1000;
const INTERNAL_ERROR = 1011;

export class RelayHub extends DurableObject<Env> {
    override fetch(request: Request): Response {
        // The status check's sign of life: answering at all shows the object is within its free allowance.
        if (new URL(request.url).pathname === STATUS_PATH) {
            return new Response(null, { status: 204 });
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment(INITIAL_STATE);

        return new Response(null, { status: 101, webSocket: client });
    }

    override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
        const state = (socket.deserializeAttachment() as ConnectionState | null) ?? INITIAL_STATE;
        const outcome = handleMessage(state, typeof message === 'string' ? message : undefined, Date.now());
        socket.serializeAttachment(outcome.state);
        for (const relayReply of outcome.replies) {
            sendQuietly(socket, JSON.stringify(relayReply));
        }

        if (outcome.event != null) {
            this.deliver(outcome.event);
        }
    }

    override webSocketClose(socket: WebSocket, code: number, reason: string): void {
        // 1005 and 1006 only describe a close that had no code; they can't be sent back.
        closeQuietly(socket, code === 1005 || code === 1006 ? NORMAL_CLOSURE : code, reason);
    }

    override webSocketError(socket: WebSocket): void {
        closeQuietly(socket, INTERNAL_ERROR, 'error');
    }

    private deliver(event: NostrEvent): void {
        for (const socket of this.ctx.getWebSockets()) {
            const state = socket.deserializeAttachment() as ConnectionState | null;
            for (const subscriptionId of matchingSubscriptions(state ?? INITIAL_STATE, event)) {
                sendQuietly(socket, JSON.stringify(['EVENT', subscriptionId, event]));
            }
        }
    }
}

function hubOf(env: Env): DurableObjectStub {
    return env.RELAY_HUB.get(env.RELAY_HUB.idFromName(HUB_NAME));
}

// Asks the Durable Object for a sign of life. When the Worker itself is past its daily requests, this never runs:
// Cloudflare answers in its place, without the CORS header, so Ether can't read that answer.
async function probeHubAsync(env: Env): Promise<RelayStatus> {
    try {
        const answer = await hubOf(env).fetch(new Request(`https://relay${STATUS_PATH}`));

        return answer.ok ? 'ok' : 'error';
    } catch (error) {
        return statusFromError(error);
    }
}

const HTTP_STATUS = Object.freeze({ ok: 200, limit: 503, error: 503, forbidden: 403 });

// Every origin may read the answer, so a page the relay doesn't serve learns that ('forbidden') instead of
// mistaking an unreadable refusal for a used-up allowance.
async function statusResponseAsync(env: Env, origin: string, isAllowed: boolean): Promise<Response> {
    const status: RelayStatus = isAllowed ? await probeHubAsync(env) : 'forbidden';

    return new Response(JSON.stringify({ status }), { status: HTTP_STATUS[status], headers: statusHeaders(origin) });
}

// A connection that is closing can't take a message; the others still get theirs.
function sendQuietly(socket: WebSocket, text: string): void {
    try {
        socket.send(text);
    } catch {
        // Closing; nothing to do.
    }
}

function closeQuietly(socket: WebSocket, code: number, reason: string): void {
    try {
        socket.close(code, reason);
    } catch {
        // Already closed.
    }
}

export default {
    fetch(request: Request, env: Env): Response | Promise<Response> {
        const origin = request.headers.get('Origin');
        const isAllowed = origin != null && isOriginAllowed(origin, env.ALLOWED_ORIGINS);
        if (new URL(request.url).pathname === STATUS_PATH && request.method === 'GET') {
            return origin == null ? new Response(null, { status: 403 }) : statusResponseAsync(env, origin, isAllowed);
        }

        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
            return new Response('Ether relay: WebSocket connections only.\n', { status: 426, headers: { Upgrade: 'websocket' } });
        }

        if (!isAllowed) {
            return new Response('This origin may not use the relay.\n', { status: 403 });
        }

        return hubOf(env).fetch(request);
    },
} satisfies ExportedHandler<Env>;
