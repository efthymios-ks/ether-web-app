import type { LogCategory, LogEntry, LogSink } from './logger.js';

export interface MemorySink extends LogSink {
    readonly name: 'memory';
    readonly capacity: number;
    // Entries pushed out since the last clear (DL-08: "N older entries dropped").
    readonly dropped: number;
    entries(): LogEntry[];
    clear(): void;
    resize(capacity: number): void;
    // Called once per written entry; the viewer batches them per animation frame (DL-10).
    subscribe(listener: (entry: LogEntry) => void): () => void;
}

export function createMemorySink(capacity = 5000): MemorySink {
    let buffer: (LogEntry | undefined)[] = new Array(capacity);
    let size = capacity;
    let start = 0;
    let count = 0;
    let dropped = 0;
    const listeners = new Set<(entry: LogEntry) => void>();

    const entries = (): LogEntry[] => {
        const result: LogEntry[] = [];
        for (let index = 0; index < count; index++) {
            const entry = buffer[(start + index) % size];
            if (entry) {
                result.push(entry);
            }
        }

        return result;
    };

    return {
        name: 'memory',
        get capacity() {
            return size;
        },
        get dropped() {
            return dropped;
        },
        write: entry => {
            if (count < size) {
                buffer[(start + count) % size] = entry;
                count++;
            } else {
                buffer[start] = entry;
                start = (start + 1) % size;
                dropped++;
            }

            for (const listener of listeners) {
                listener(entry);
            }
        },
        entries,
        clear: () => {
            buffer = new Array(size);
            start = 0;
            count = 0;
            dropped = 0;
        },
        resize: capacity => {
            const kept = entries().slice(-capacity);
            dropped += Math.max(0, count - kept.length);
            size = capacity;
            buffer = new Array(capacity);
            kept.forEach((entry, index) => {
                buffer[index] = entry;
            });
            start = 0;
            count = kept.length;
        },
        subscribe: listener => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    };
}

const CATEGORY_COLORS: Readonly<Record<LogCategory, string>> = Object.freeze({
    app: '#767676',
    device: '#6f42c1',
    pair: '#005fb8',
    ice: '#267f99',
    pairs: '#098658',
    dtls: '#af00db',
    health: '#2e7d32',
    nearby: '#00796b',
    resume: '#b1420c',
    xfer: '#0451a5',
    store: '#8a6100',
    wake: '#ad1457',
    sw: '#616161',
});

export interface ConsoleLike {
    debug(...values: unknown[]): void;
    info(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
}

// The only place in the app that writes to the console (LG-01).
export function createConsoleSink(target: ConsoleLike = globalThis.console): LogSink {
    return {
        name: 'console',
        write: entry => {
            const time = `+${(entry.t / 1000).toFixed(3)}`;
            const peer = entry.peer ? ` [${entry.peer}]` : '';
            const label = `%c${time} ${entry.cat}${peer}%c ${entry.msg}`;
            const style = `color: ${CATEGORY_COLORS[entry.cat]}; font-weight: 600`;
            const values: unknown[] = [label, style, ''];
            if (entry.data !== undefined) {
                values.push(entry.data);
            }

            target[entry.level](...values);
        },
    };
}

// DL-15: the categories the peer sink forwards.
export const PEER_LOG_CATEGORIES: readonly LogCategory[] = Object.freeze(['pair', 'ice', 'pairs', 'resume']);

export interface PeerSink extends LogSink {
    readonly name: 'peer';
    // Starts forwarding: buffered entries go first, then new ones in batches.
    attach(send: (entries: LogEntry[]) => void): void;
    detach(): void;
    // Sends what is queued now; the client also calls it on a timer.
    flush(): void;
}

export function createPeerSink(bufferLimit = 500, batchSize = 50): PeerSink {
    let queue: LogEntry[] = [];
    let sender: ((entries: LogEntry[]) => void) | undefined;

    const flush = (): void => {
        if (!sender || queue.length === 0) {
            return;
        }

        const pending = queue;
        queue = [];
        for (let index = 0; index < pending.length; index += batchSize) {
            sender(pending.slice(index, index + batchSize));
        }
    };

    return {
        name: 'peer',
        write: entry => {
            if (entry.peer || !PEER_LOG_CATEGORIES.includes(entry.cat)) {
                return;
            }

            queue.push(entry);
            if (queue.length > bufferLimit) {
                queue.splice(0, queue.length - bufferLimit);
            }

            if (sender && queue.length >= batchSize) {
                flush();
            }
        },
        attach: send => {
            sender = send;
            flush();
        },
        detach: () => {
            sender = undefined;
        },
        flush,
        dispose: () => {
            sender = undefined;
            queue = [];
        },
    };
}
