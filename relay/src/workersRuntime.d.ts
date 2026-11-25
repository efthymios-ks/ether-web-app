// The few Cloudflare Workers runtime types the relay uses, so it type-checks without another dependency.
// Wrangler builds against the real runtime; these only describe the parts in use.

declare module 'cloudflare:workers' {
    export abstract class DurableObject<Env = unknown> {
        protected readonly ctx: DurableObjectState;
        protected readonly env: Env;
        constructor(ctx: DurableObjectState, env: Env);
        fetch?(request: Request): Response | Promise<Response>;
        webSocketMessage?(socket: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
        webSocketClose?(socket: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
        webSocketError?(socket: WebSocket, error: unknown): void | Promise<void>;
    }
}

interface DurableObjectState {
    acceptWebSocket(socket: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
}

interface DurableObjectId {
    toString(): string;
}

interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
}

interface WebSocket {
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
}

interface ResponseInit {
    webSocket?: WebSocket | null;
}

declare class WebSocketPair {
    0: WebSocket;
    1: WebSocket;
}

interface ExportedHandler<Env = unknown> {
    fetch?(request: Request, env: Env): Response | Promise<Response>;
}
