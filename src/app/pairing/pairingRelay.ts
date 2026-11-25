// HS-06, HS-07: a code opened from the system Camera lands in a new tab. The tab holding the pending
// offer listens on BroadcastChannel('ether'); the new tab forwards the code there and waits for a reply.

export const RELAY_CHANNEL = 'ether';
export const RELAY_TIMEOUT_MS = 1500;

interface ChannelLike {
    postMessage(message: unknown): void;
    addEventListener(type: 'message', listener: (event: Event) => void): void;
    removeEventListener(type: 'message', listener: (event: Event) => void): void;
    close(): void;
}

type RelayMessage =
    | { readonly type: 'code'; readonly id: string; readonly code: string }
    | { readonly type: 'code-taken'; readonly id: string };

export interface PairingRelayOptions {
    // Returns true when this tab takes the code.
    readonly onCode?: (code: string) => boolean;
    readonly createChannel?: (name: string) => ChannelLike | undefined;
    readonly randomId?: () => string;
}

export interface PairingRelay {
    // Resolves to true when another tab took the code within the timeout.
    forwardAsync(code: string, timeoutMs?: number): Promise<boolean>;
    dispose(): void;
}

export function createPairingRelay(options: PairingRelayOptions = {}): PairingRelay {
    const createChannel = options.createChannel ?? defaultChannel;
    const randomId = options.randomId ?? (() => crypto.randomUUID());
    const channel = createChannel(RELAY_CHANNEL);

    const onMessage = (event: Event): void => {
        const message = parseMessage((event as MessageEvent).data);
        if (message?.type !== 'code' || options.onCode == null) {
            return;
        }

        if (options.onCode(message.code)) {
            channel?.postMessage({ type: 'code-taken', id: message.id } satisfies RelayMessage);
        }
    };

    channel?.addEventListener('message', onMessage);

    return {
        forwardAsync: (code, timeoutMs = RELAY_TIMEOUT_MS) => {
            if (channel == null) {
                return Promise.resolve(false);
            }

            const id = randomId();

            return new Promise(resolve => {
                const onReply = (event: Event): void => {
                    const message = parseMessage((event as MessageEvent).data);
                    if (message?.type === 'code-taken' && message.id === id) {
                        finish(true);
                    }
                };
                const timer = setTimeout(() => finish(false), timeoutMs);
                const finish = (isTaken: boolean): void => {
                    clearTimeout(timer);
                    channel.removeEventListener('message', onReply);
                    resolve(isTaken);
                };

                channel.addEventListener('message', onReply);
                channel.postMessage({ type: 'code', id, code } satisfies RelayMessage);
            });
        },
        dispose: () => {
            channel?.removeEventListener('message', onMessage);
            channel?.close();
        },
    };
}

// Reads `#<code>` once and removes it from the address, so a reload doesn't reuse the code (HS-08).
export function takeHashCode(location: Location = globalThis.location, history: History = globalThis.history): string | undefined {
    const raw = location.hash.replace(/^#/, '');
    if (raw.length === 0) {
        return undefined;
    }

    try {
        history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    } catch {
        location.hash = '';
    }

    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function parseMessage(data: unknown): RelayMessage | undefined {
    if (data == null || typeof data !== 'object') {
        return undefined;
    }

    const record = data as Record<string, unknown>;
    if (typeof record.id !== 'string') {
        return undefined;
    }

    if (record.type === 'code' && typeof record.code === 'string') {
        return { type: 'code', id: record.id, code: record.code };
    }

    return record.type === 'code-taken' ? { type: 'code-taken', id: record.id } : undefined;
}

function defaultChannel(name: string): ChannelLike | undefined {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : undefined;
}
