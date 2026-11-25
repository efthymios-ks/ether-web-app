import { redact } from './redact.js';

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'] as const);
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_CATEGORIES = Object.freeze([
    'app',
    'device',
    'pair',
    'ice',
    'pairs',
    'dtls',
    'health',
    'nearby',
    'resume',
    'xfer',
    'store',
    'wake',
    'sw',
] as const);
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const LOG_SINK_NAMES = Object.freeze(['none', 'console', 'memory', 'indexeddb', 'peer'] as const);
export type LogSinkName = (typeof LOG_SINK_NAMES)[number];

export interface LogContext {
    readonly sessionId?: string;
    readonly connectionId?: string;
    readonly fileId?: string;
    readonly page?: number;
}

export interface LogEntry extends LogContext {
    // Milliseconds since the origin (the start of the current pairing).
    readonly t: number;
    // Epoch milliseconds.
    readonly wall: number;
    readonly level: LogLevel;
    readonly cat: LogCategory;
    readonly msg: string;
    readonly data?: unknown;
    // Set on entries that came from the peer (DL-15).
    readonly peer?: string;
}

// Pass a function when building the data costs something; it runs only if the entry is kept.
export type LogData = unknown;

export interface Logger {
    debug(cat: LogCategory, msg: string, data?: LogData): void;
    info(cat: LogCategory, msg: string, data?: LogData): void;
    warn(cat: LogCategory, msg: string, data?: LogData): void;
    error(cat: LogCategory, msg: string, data?: LogData): void;
    // A child logger that adds this context to every entry.
    with(context: LogContext): Logger;
    // Logs the duration when the returned function is called.
    span(cat: LogCategory, name: string, level?: LogLevel): (data?: LogData) => void;
    // True at most once per `ms` for each key; for sampling high-frequency events.
    every(key: string, ms: number): boolean;
    isEnabled(cat: LogCategory, level: LogLevel): boolean;
}

export interface LogSink {
    readonly name: LogSinkName;
    write(entry: LogEntry): void;
    dispose?(): void;
}

export interface LogRouting {
    readonly debugLogging: boolean;
    readonly level: LogLevel;
    readonly categoryLevels: Readonly<Partial<Record<LogCategory, LogLevel>>>;
    readonly sinks: readonly LogSinkName[];
}

// LG-11: with debug logging off, the memory sink keeps the handshake categories at info and the rest at warn.
export const DEFAULT_CATEGORY_LEVELS: Readonly<Record<LogCategory, LogLevel>> = Object.freeze({
    app: 'info',
    device: 'warn',
    pair: 'info',
    ice: 'info',
    pairs: 'warn',
    dtls: 'info',
    health: 'warn',
    nearby: 'info',
    resume: 'info',
    xfer: 'warn',
    store: 'warn',
    wake: 'warn',
    sw: 'warn',
});

export const DEFAULT_LOG_ROUTING: LogRouting = Object.freeze({
    debugLogging: false,
    level: 'debug',
    categoryLevels: {},
    sinks: ['memory', 'console'] as LogSinkName[],
});

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
});
const OFF = 99;

export interface LoggerOptions {
    readonly sinks?: readonly LogSink[];
    readonly routing?: LogRouting;
    // Monotonic clock in milliseconds, `performance.now()` by default.
    readonly now?: () => number;
    // Wall clock in epoch milliseconds, `Date.now()` by default.
    readonly wallClock?: () => number;
}

export interface LoggerController {
    readonly logger: Logger;
    configure(routing: LogRouting): void;
    readonly routing: LogRouting;
    addSink(sink: LogSink): void;
    removeSink(name: LogSinkName): void;
    getSink<Sink extends LogSink>(name: LogSinkName): Sink | undefined;
    // Restarts `t` at zero, called when a pairing starts.
    markOrigin(): void;
    // Writes an entry as it is, e.g. one received from the peer; it still goes through the routing.
    append(entry: LogEntry): void;
}

export function createLogger(options: LoggerOptions = {}): LoggerController {
    const now = options.now ?? (() => performance.now());
    const wallClock = options.wallClock ?? (() => Date.now());
    const sinks = new Map<LogSinkName, LogSink>();
    const thresholds: Record<string, number> = {};
    const lastSeen = new Map<string, number>();
    let routing = options.routing ?? DEFAULT_LOG_ROUTING;
    let activeSinks: LogSink[] = [];
    let origin = now();

    for (const sink of options.sinks ?? []) {
        sinks.set(sink.name, sink);
    }

    const recompute = (): void => {
        activeSinks = selectSinks(routing, sinks);

        for (const cat of LOG_CATEGORIES) {
            thresholds[cat] = activeSinks.length === 0 ? OFF : LEVEL_RANK[categoryLevel(routing, cat)];
        }
    };

    const dispatch = (entry: LogEntry): void => {
        for (const sink of activeSinks) {
            try {
                sink.write(entry);
            } catch (error) {
                disableFailedSink(sink, error);
            }
        }
    };

    const disableFailedSink = (sink: LogSink, error: unknown): void => {
        sinks.delete(sink.name);
        recompute();
        dispatch(createEntry('warn', 'app', `log sink "${sink.name}" failed and was turned off`, redact(error), {}));
    };

    const createEntry = (
        level: LogLevel,
        cat: LogCategory,
        msg: string,
        data: unknown,
        context: LogContext,
    ): LogEntry => ({
        ...context,
        t: Math.round((now() - origin) * 1000) / 1000,
        wall: wallClock(),
        level,
        cat,
        msg,
        ...(data === undefined ? {} : { data }),
    });

    const write = (level: LogLevel, cat: LogCategory, msg: string, data: LogData, context: LogContext): void => {
        if (LEVEL_RANK[level] < (thresholds[cat] ?? OFF)) {
            return;
        }

        try {
            const value = typeof data === 'function' ? (data as () => unknown)() : data;
            dispatch(createEntry(level, cat, msg, redact(value), context));
        } catch {
            // Logging never throws (LG-07).
        }
    };

    const createChild = (context: LogContext): Logger => ({
        debug: (cat, msg, data) => write('debug', cat, msg, data, context),
        info: (cat, msg, data) => write('info', cat, msg, data, context),
        warn: (cat, msg, data) => write('warn', cat, msg, data, context),
        error: (cat, msg, data) => write('error', cat, msg, data, context),
        with: extra => createChild({ ...context, ...extra }),
        span: (cat, name, level = 'info') => {
            const started = now();

            return data => {
                if (LEVEL_RANK[level] < (thresholds[cat] ?? OFF)) {
                    return;
                }

                const durationMs = Math.round(now() - started);
                const value = typeof data === 'function' ? (data as () => unknown)() : data;
                write(level, cat, `${name} ${durationMs} ms`, { durationMs, ...asRecord(value) }, context);
            };
        },
        every: (key, ms) => {
            const time = now();
            const last = lastSeen.get(key);
            if (last != null && time - last < ms) {
                return false;
            }

            lastSeen.set(key, time);

            return true;
        },
        isEnabled: (cat, level) => LEVEL_RANK[level] >= (thresholds[cat] ?? OFF),
    });

    recompute();

    return {
        logger: createChild({}),
        get routing() {
            return routing;
        },
        configure: next => {
            routing = next;
            recompute();
        },
        addSink: sink => {
            sinks.get(sink.name)?.dispose?.();
            sinks.set(sink.name, sink);
            recompute();
        },
        removeSink: name => {
            sinks.get(name)?.dispose?.();
            sinks.delete(name);
            recompute();
        },
        getSink: <Sink extends LogSink>(name: LogSinkName) => sinks.get(name) as Sink | undefined,
        markOrigin: () => {
            origin = now();
        },
        append: entry => {
            if (LEVEL_RANK[entry.level] < (thresholds[entry.cat] ?? OFF)) {
                return;
            }

            dispatch(entry);
        },
    };
}

function selectSinks(routing: LogRouting, sinks: ReadonlyMap<LogSinkName, LogSink>): LogSink[] {
    // LG-11: with debug logging off only the memory sink runs.
    const wanted: readonly LogSinkName[] = routing.debugLogging ? routing.sinks : ['memory'];
    const named = wanted.filter(name => name !== 'none');

    return named
        .map(name => sinks.get(name))
        .filter((sink): sink is LogSink => sink != null);
}

function categoryLevel(routing: LogRouting, cat: LogCategory): LogLevel {
    if (!routing.debugLogging) {
        return DEFAULT_CATEGORY_LEVELS[cat];
    }

    return routing.categoryLevels[cat] ?? routing.level;
}

function asRecord(value: unknown): Record<string, unknown> {
    if (value == null) {
        return {};
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    return { value };
}

// LG-10: uncaught errors and rejections land in category `app`.
export function installGlobalErrorHandlers(logger: Logger, target: EventTarget = globalThis): () => void {
    const onError = (event: Event): void => {
        const errorEvent = event as ErrorEvent;
        logger.error('app', `uncaught: ${errorEvent.message ?? 'error'}`, () => ({
            error: errorEvent.error,
            source: errorEvent.filename,
            line: errorEvent.lineno,
        }));
    };
    const onRejection = (event: Event): void => {
        const reason = (event as PromiseRejectionEvent).reason as unknown;
        logger.error('app', 'unhandled rejection', () => ({ reason }));
    };

    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);

    return () => {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
    };
}

// A logger that keeps nothing, for code paths and tests that don't care.
export const SILENT_LOGGER: Logger = Object.freeze({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    with: () => SILENT_LOGGER,
    span: () => () => undefined,
    every: () => false,
    isEnabled: () => false,
});
