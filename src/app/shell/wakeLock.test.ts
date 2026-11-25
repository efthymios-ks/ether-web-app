import { describe, expect, it } from 'vitest';
import { createLogger } from '../../core/logger.js';
import { createMemorySink } from '../../core/logSinks.js';
import { createFakeWakeLockApi, settleAsync } from '../testing/appHarness.js';
import { createWakeLock } from './wakeLock.js';

function createTestLogger() {
    const memory = createMemorySink(50);
    const { logger } = createLogger({ sinks: [memory], routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] } });

    return { logger, memory };
}

describe('createWakeLock', () => {
    it('holds the screen while any reason asks and releases when idle (WL-01)', async () => {
        // Arrange
        const { logger, memory } = createTestLogger();
        const { api, counts } = createFakeWakeLockApi();
        const wakeLock = createWakeLock({ logger, wakeLock: api });

        // Act
        wakeLock.set('transfer', true);
        await settleAsync();
        wakeLock.set('qr', true);
        await settleAsync();
        const heldWhileBusy = wakeLock.isHeld;
        wakeLock.set('transfer', false);
        wakeLock.set('qr', false);
        await settleAsync();

        // Assert
        expect(counts.requests).toBe(1);
        expect(heldWhileBusy).toBe(true);
        expect(counts.releases).toBe(1);
        expect(wakeLock.isHeld).toBe(false);
        expect(memory.entries().every(entry => entry.cat === 'wake')).toBe(true);
    });

    it('takes the lock again when the page becomes visible (WL-02)', async () => {
        // Arrange
        const { logger } = createTestLogger();
        const { api, counts, sentinels } = createFakeWakeLockApi();
        const wakeLock = createWakeLock({ logger, wakeLock: api });
        wakeLock.set('transfer', true);
        await settleAsync();

        // Act
        sentinels[0]?.dispatchEvent(new Event('release'));
        const isHeldWhileHidden = wakeLock.isHeld;
        document.dispatchEvent(new Event('visibilitychange'));
        await settleAsync();

        // Assert
        expect(isHeldWhileHidden).toBe(false);
        expect(counts.requests).toBe(2);
        expect(wakeLock.isHeld).toBe(true);
    });

    it('reports when the screen should stay on but the browser can’t keep it on (WL-03)', () => {
        // Arrange
        const { logger } = createTestLogger();
        Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });
        const wakeLock = createWakeLock({ logger });

        // Act
        wakeLock.set('transfer', true);

        // Assert
        expect(wakeLock.isSupported).toBe(false);
        expect(wakeLock.isWanted).toBe(true);
        expect(wakeLock.isHeld).toBe(false);
    });
});
