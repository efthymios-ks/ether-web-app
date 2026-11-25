import type { RelaySocket, RelaySocketFactory, RelaySocketHandlers } from './relayConnection.js';

// Test doubles: in-memory Nostr relays (NIP-01: EVENT, REQ, CLOSE; OK, EVENT, EOSE, NOTICE, CLOSED)
// reached through fake WebSockets. Like a real relay, one passes an event to every matching subscription,
// the sender's included. By default it keeps no ephemeral event; with `storesEvents`, it replays what it kept
// to each new subscription before EOSE, as many public relays do. Frames arrive in a microtask.

export interface RelayEventShape {
    readonly id: string;
    readonly pubkey: string;
    readonly created_at: number;
    readonly kind: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
    readonly sig: string;
}

type Filter = Readonly<Record<string, unknown>>;

export class FakeRelaySocket implements RelaySocket {
    isOpen = false;
    readonly sent: string[] = [];
    readonly subscriptions = new Map<string, readonly Filter[]>();

    constructor(
        readonly relay: FakeRelay,
        readonly client: string,
        private readonly handlers: RelaySocketHandlers,
    ) {}

    send(text: string): void {
        if (!this.isOpen) {
            throw new DOMException('The socket is not open', 'InvalidStateError');
        }

        this.sent.push(text);
        queueMicrotask(() => this.relay.receive(this, text));
    }

    // Closed by the client: no close event comes back to it, and what it sent before still arrives.
    close(): void {
        this.isOpen = false;
        queueMicrotask(() => this.relay.forget(this));
    }

    open(): void {
        this.isOpen = true;
        this.handlers.onOpen();
    }

    deliver(text: string): void {
        queueMicrotask(() => {
            if (this.isOpen) {
                this.handlers.onMessage(text);
            }
        });
    }

    // Closed by the relay or the network.
    drop(): void {
        if (!this.isOpen) {
            return;
        }

        this.isOpen = false;
        this.relay.forget(this);
        queueMicrotask(() => this.handlers.onClose());
    }
}

export class FakeRelay {
    isDown = false;
    // When set, every EVENT gets OK false with this message.
    refusal?: string;
    // When set, every REQ gets CLOSED with this message.
    subscriptionRefusal?: string;
    // When false, no OK comes back at all.
    sendsOk = true;
    storesEvents = false;
    readonly published: RelayEventShape[] = [];
    readonly sockets = new Set<FakeRelaySocket>();
    readonly frames: string[] = [];

    constructor(readonly url: string) {}

    get subscriptionCount(): number {
        return [...this.sockets].reduce((total, socket) => total + socket.subscriptions.size, 0);
    }

    receive(socket: FakeRelaySocket, text: string): void {
        if (!this.sockets.has(socket)) {
            return;
        }

        this.frames.push(text);
        const message = JSON.parse(text) as unknown[];
        const [type, first, ...rest] = message;
        if (type === 'REQ' && typeof first === 'string') {
            this.subscribe(socket, first, rest as Filter[]);
            return;
        }

        if (type === 'CLOSE' && typeof first === 'string') {
            socket.subscriptions.delete(first);
            return;
        }

        if (type === 'EVENT') {
            this.publish(socket, first as RelayEventShape);
        }
    }

    // Sends this event to every matching subscription, as if another client had published it.
    inject(event: RelayEventShape): void {
        for (const socket of this.sockets) {
            for (const [subscriptionId, filters] of socket.subscriptions) {
                if (filters.some(filter => matchesFilter(event, filter))) {
                    socket.deliver(JSON.stringify(['EVENT', subscriptionId, event]));
                }
            }
        }
    }

    // Raw text to every socket, for malformed frames.
    broadcast(text: string): void {
        for (const socket of this.sockets) {
            socket.deliver(text);
        }
    }

    // Closes every socket and refuses new ones until revived.
    kill(): void {
        this.isDown = true;
        for (const socket of [...this.sockets]) {
            socket.drop();
        }
    }

    revive(): void {
        this.isDown = false;
    }

    forget(socket: FakeRelaySocket): void {
        this.sockets.delete(socket);
    }

    private subscribe(socket: FakeRelaySocket, subscriptionId: string, filters: readonly Filter[]): void {
        if (this.subscriptionRefusal != null) {
            socket.deliver(JSON.stringify(['CLOSED', subscriptionId, this.subscriptionRefusal]));
            return;
        }

        socket.subscriptions.set(subscriptionId, filters);
        if (this.storesEvents) {
            for (const event of [...this.published].reverse()) {
                if (filters.some(filter => matchesFilter(event, filter))) {
                    socket.deliver(JSON.stringify(['EVENT', subscriptionId, event]));
                }
            }
        }

        socket.deliver(JSON.stringify(['EOSE', subscriptionId]));
    }

    private publish(socket: FakeRelaySocket, event: RelayEventShape): void {
        if (this.refusal != null) {
            socket.deliver(JSON.stringify(['OK', event.id, false, this.refusal]));
            return;
        }

        this.published.push(event);
        if (this.sendsOk) {
            socket.deliver(JSON.stringify(['OK', event.id, true, '']));
        }

        this.inject(event);
    }
}

// A set of relays, and a socket factory per client so a test can cut one device off the network.
export class FakeRelayNetwork {
    readonly relays: FakeRelay[];
    private readonly cutClients = new Set<string>();

    constructor(urls: readonly string[]) {
        this.relays = urls.map(url => new FakeRelay(url));
    }

    relay(url: string): FakeRelay {
        const relay = this.relays.find(candidate => candidate.url === url);
        if (relay == null) {
            throw new Error(`No fake relay at ${url}`);
        }

        return relay;
    }

    socketFactory(client: string): RelaySocketFactory {
        return (url, handlers) => {
            const relay = this.relays.find(candidate => candidate.url === url);
            const socket = new FakeRelaySocket(relay ?? new FakeRelay(url), client, handlers);
            const isReachable = relay != null && !relay.isDown && !this.cutClients.has(client);
            queueMicrotask(() => {
                if (!isReachable || relay == null) {
                    handlers.onClose();
                    return;
                }

                relay.sockets.add(socket);
                socket.open();
            });

            return socket;
        };
    }

    // The client's sockets drop and new ones fail, as when a device loses its connection.
    cut(client: string): void {
        this.cutClients.add(client);
        for (const relay of this.relays) {
            for (const socket of [...relay.sockets]) {
                if (socket.client === client) {
                    socket.drop();
                }
            }
        }
    }

    restore(client: string): void {
        this.cutClients.delete(client);
    }

    socketsOf(client: string): FakeRelaySocket[] {
        return this.relays.flatMap(relay => [...relay.sockets].filter(socket => socket.client === client));
    }
}

// NIP-01 matching for the fields the nearby filter uses: kinds, ids, authors, #<letter> tags, since, until.
export function matchesFilter(event: RelayEventShape, filter: Filter): boolean {
    for (const [key, value] of Object.entries(filter)) {
        if (!matchesField(event, key, value)) {
            return false;
        }
    }

    return true;
}

function matchesField(event: RelayEventShape, key: string, value: unknown): boolean {
    if (key === 'kinds') {
        return (value as number[]).includes(event.kind);
    }

    if (key === 'ids') {
        return (value as string[]).includes(event.id);
    }

    if (key === 'authors') {
        return (value as string[]).includes(event.pubkey);
    }

    if (key === 'since') {
        return event.created_at >= (value as number);
    }

    if (key === 'until') {
        return event.created_at <= (value as number);
    }

    if (key.startsWith('#') && key.length === 2) {
        const wanted = value as string[];

        return event.tags.some(tag => tag[0] === key.slice(1) && wanted.includes(tag[1] ?? ''));
    }

    return true;
}
