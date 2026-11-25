import { describe, expect, it } from 'vitest';
import type { Diagnostics } from '../../client/clientTypes.js';
import { createStatsPoller } from './statsPoller.js';

const DIAGNOSTICS: Diagnostics = { state: 'connected', pairs: [], slots: [] };

function createHarness(intervalMs = 1000) {
    const timers: Array<{ ms: number; callback: () => void } | undefined> = [];
    const results: Diagnostics[] = [];
    let calls = 0;
    const poller = createStatsPoller({
        getDiagnosticsAsync: async () => {
            calls++;

            return DIAGNOSTICS;
        },
        intervalMs: () => intervalMs,
        onResult: diagnostics => results.push(diagnostics),
        setTimer: (callback, ms) => timers.push({ ms, callback }) - 1,
        clearTimer: handle => {
            timers[handle as number] = undefined;
        },
    });

    return {
        poller,
        timers,
        results,
        get calls() {
            return calls;
        },
        fireLastTimer: () => {
            const timer = timers.at(-1);
            timer?.callback();
        },
    };
}

async function settleAsync(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

describe('createStatsPoller', () => {
    it('polls once at start and again an interval after each answer (DL-06)', async () => {
        // Arrange
        const harness = createHarness(1000);

        // Act
        harness.poller.start();
        await settleAsync();
        harness.fireLastTimer();
        await settleAsync();

        // Assert
        expect(harness.calls).toBe(2);
        expect(harness.results).toHaveLength(2);
        expect(harness.timers.at(-1)?.ms).toBe(1000);
    });

    it('stops polling and ignores late answers when stopped (DL-11)', async () => {
        // Arrange
        const harness = createHarness();
        harness.poller.start();

        // Act
        harness.poller.stop();
        await settleAsync();

        // Assert
        expect(harness.poller.isRunning).toBe(false);
        expect(harness.results).toHaveLength(0);
        expect(harness.timers.filter(timer => timer != null)).toHaveLength(0);
    });
});
