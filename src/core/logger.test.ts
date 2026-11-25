import { describe, expect, it, vi } from 'vitest';
import { createLogger, DEFAULT_LOG_ROUTING, installGlobalErrorHandlers } from './logger.js';
import type { LogRouting } from './logger.js';
import { createConsoleSink, createMemorySink, createPeerSink } from './logSinks.js';

function createClock() {
    let time = 0;

    return {
        now: () => time,
        advance: (ms: number) => {
            time += ms;
        },
    };
}

const DEBUG_ROUTING: LogRouting = { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] };

describe('createLogger', () => {
    it('keeps handshake categories at info and the rest at warn while debug logging is off', () => {
        // Arrange
        const memory = createMemorySink(10);
        const { logger } = createLogger({ sinks: [memory], routing: DEFAULT_LOG_ROUTING });

        // Act
        logger.info('pair', 'offer created');
        logger.info('xfer', 'page 1 of 2');
        logger.warn('xfer', 'nack');
        logger.debug('ice', 'candidate');

        // Assert
        expect(memory.entries().map(entry => entry.msg)).toEqual(['offer created', 'nack']);
    });

    it('runs only the memory sink while debug logging is off', () => {
        // Arrange
        const memory = createMemorySink(10);
        const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const { logger } = createLogger({
            sinks: [memory, createConsoleSink(target)],
            routing: { ...DEFAULT_LOG_ROUTING, sinks: ['console', 'memory'] },
        });

        // Act
        logger.error('app', 'boom');

        // Assert
        expect(memory.entries()).toHaveLength(1);
        expect(target.error).not.toHaveBeenCalled();
    });

    it('drops everything when debug logging is on with only the none sink', () => {
        // Arrange
        const memory = createMemorySink(10);
        const { logger } = createLogger({ sinks: [memory], routing: { ...DEBUG_ROUTING, sinks: ['none'] } });

        // Act
        logger.error('app', 'boom');

        // Assert
        expect(memory.entries()).toHaveLength(0);
        expect(logger.isEnabled('app', 'error')).toBe(false);
    });

    it('ignores none when other sinks are selected', () => {
        // Arrange
        const memory = createMemorySink(10);
        const { logger } = createLogger({ sinks: [memory], routing: { ...DEBUG_ROUTING, sinks: ['none', 'memory'] } });

        // Act
        logger.debug('xfer', 'page');

        // Assert
        expect(memory.entries()).toHaveLength(1);
    });

    it('calls a data function only when the entry is kept', () => {
        // Arrange
        const memory = createMemorySink(10);
        const { logger } = createLogger({ sinks: [memory], routing: DEFAULT_LOG_ROUTING });
        const build = vi.fn(() => ({ page: 3 }));

        // Act
        logger.debug('xfer', 'page', build);
        logger.warn('xfer', 'nack', build);

        // Assert
        expect(build).toHaveBeenCalledTimes(1);
        expect(memory.entries()[0]?.data).toEqual({ page: 3 });
    });

    it('adds child context and redacts secrets before sinks see them', () => {
        // Arrange
        const memory = createMemorySink(10);
        const { logger } = createLogger({ sinks: [memory], routing: DEBUG_ROUTING });

        // Act
        logger.with({ sessionId: 's1', fileId: 'f1' }).info('pair', 'decoded', {
            icePwd: 'secret',
            code: 'ABCDEFGHIJKLMNOP',
            fingerprint: '0123456789abcdef',
        });

        // Assert
        const entry = memory.entries()[0];
        expect(entry?.sessionId).toBe('s1');
        expect(entry?.fileId).toBe('f1');
        expect(entry?.data).toEqual({ icePwd: '[redacted]', code: '[code, 16 chars]', fingerprint: '01234567…' });
    });

    it('measures spans and restarts t at the origin', () => {
        // Arrange
        const clock = createClock();
        const memory = createMemorySink(10);
        const controller = createLogger({ sinks: [memory], routing: DEBUG_ROUTING, now: clock.now });
        clock.advance(500);
        controller.markOrigin();

        // Act
        const end = controller.logger.span('pair', 'gathering');
        clock.advance(289);
        end({ candidates: 2 });

        // Assert
        expect(memory.entries()[0]).toMatchObject({ t: 289, msg: 'gathering 289 ms', data: { durationMs: 289, candidates: 2 } });
    });

    it('samples with every()', () => {
        // Arrange
        const clock = createClock();
        const { logger } = createLogger({ now: clock.now });

        // Act
        const first = logger.every('rtt', 10_000);
        clock.advance(5000);
        const second = logger.every('rtt', 10_000);
        clock.advance(5000);
        const third = logger.every('rtt', 10_000);

        // Assert
        expect([first, second, third]).toEqual([true, false, true]);
    });

    it('turns off a failing sink and warns once through the others', () => {
        // Arrange
        const memory = createMemorySink(10);
        const broken = { name: 'console' as const, write: vi.fn(() => { throw new Error('quota'); }) };
        const { logger } = createLogger({ sinks: [memory, broken], routing: { ...DEBUG_ROUTING, sinks: ['memory', 'console'] } });

        // Act
        logger.info('app', 'one');
        logger.info('app', 'two');

        // Assert
        expect(broken.write).toHaveBeenCalledTimes(1);
        expect(memory.entries().map(entry => entry.msg)).toEqual(['one', 'log sink "console" failed and was turned off', 'two']);
    });

    it('reconfigures live', () => {
        // Arrange
        const memory = createMemorySink(10);
        const controller = createLogger({ sinks: [memory], routing: DEFAULT_LOG_ROUTING });

        // Act
        controller.logger.debug('xfer', 'before');
        controller.configure(DEBUG_ROUTING);
        controller.logger.debug('xfer', 'after');

        // Assert
        expect(memory.entries().map(entry => entry.msg)).toEqual(['after']);
    });

    it('logs uncaught errors in category app', () => {
        // Arrange
        const memory = createMemorySink(10);
        const { logger } = createLogger({ sinks: [memory], routing: DEFAULT_LOG_ROUTING });
        const target = new EventTarget();
        const uninstall = installGlobalErrorHandlers(logger, target);

        // Act
        const event = new Event('error') as Event & { message: string };
        event.message = 'bad';
        target.dispatchEvent(event);
        uninstall();
        target.dispatchEvent(event);

        // Assert
        expect(memory.entries()).toHaveLength(1);
        expect(memory.entries()[0]).toMatchObject({ level: 'error', cat: 'app', msg: 'uncaught: bad' });
    });
});

describe('createMemorySink', () => {
    it('wraps and counts dropped entries', () => {
        // Arrange
        const memory = createMemorySink(2);
        const { logger } = createLogger({ sinks: [memory], routing: DEBUG_ROUTING });

        // Act
        logger.info('app', 'one');
        logger.info('app', 'two');
        logger.info('app', 'three');

        // Assert
        expect(memory.entries().map(entry => entry.msg)).toEqual(['two', 'three']);
        expect(memory.dropped).toBe(1);
    });

    it('keeps the newest entries when it shrinks', () => {
        // Arrange
        const memory = createMemorySink(3);
        const { logger } = createLogger({ sinks: [memory], routing: DEBUG_ROUTING });
        logger.info('app', 'one');
        logger.info('app', 'two');
        logger.info('app', 'three');

        // Act
        memory.resize(2);

        // Assert
        expect(memory.entries().map(entry => entry.msg)).toEqual(['two', 'three']);
    });
});

describe('createPeerSink', () => {
    it('buffers handshake categories until attached, then forwards them', () => {
        // Arrange
        const peer = createPeerSink(10, 2);
        const { logger } = createLogger({ sinks: [peer], routing: { ...DEBUG_ROUTING, sinks: ['peer'] } });
        const sent: string[][] = [];

        // Act
        logger.info('pair', 'offer created');
        logger.info('xfer', 'page');
        peer.attach(entries => sent.push(entries.map(entry => entry.msg)));
        logger.info('ice', 'candidate');
        logger.info('resume', 'sync');

        // Assert
        expect(sent).toEqual([['offer created'], ['candidate', 'sync']]);
    });
});
