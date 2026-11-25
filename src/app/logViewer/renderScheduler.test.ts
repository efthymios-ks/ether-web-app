import { describe, expect, it } from 'vitest';
import { createRenderScheduler } from './renderScheduler.js';

function createHarness() {
    let time = 0;
    let nextFrame = 1;
    const frames = new Map<number, () => void>();
    const timers: Array<{ at: number; callback: () => void }> = [];
    let renders = 0;
    const scheduler = createRenderScheduler({
        render: () => {
            renders++;
        },
        now: () => time,
        requestFrame: callback => {
            frames.set(nextFrame, callback);

            return nextFrame++;
        },
        cancelFrame: handle => {
            frames.delete(handle);
        },
        setTimer: (callback, ms) => timers.push({ at: time + ms, callback }),
        clearTimer: () => undefined,
    });

    return {
        scheduler,
        get renders() {
            return renders;
        },
        advance: (ms: number) => {
            time += ms;
            const due = timers.filter(item => item.at <= time);
            const later = timers.filter(item => item.at > time);
            timers.splice(0, timers.length, ...later);
            for (const timer of due) {
                timer.callback();
            }
        },
        runFrames: () => {
            const pending = [...frames.values()];
            frames.clear();
            for (const frame of pending) {
                frame();
            }
        },
    };
}

describe('createRenderScheduler', () => {
    it('renders once per frame however many entries arrive (DL-10)', () => {
        // Arrange
        const harness = createHarness();

        // Act
        for (let index = 0; index < 500; index++) {
            harness.scheduler.schedule();
        }

        harness.runFrames();

        // Assert
        expect(harness.renders).toBe(1);
    });

    it('waits until 100 ms after the last render, so at most 10 renders a second', () => {
        // Arrange
        const harness = createHarness();
        harness.scheduler.schedule();
        harness.runFrames();

        // Act
        harness.advance(16);
        harness.scheduler.schedule();
        harness.runFrames();
        const rendersBeforeInterval = harness.renders;
        harness.advance(90);
        harness.runFrames();

        // Assert
        expect(rendersBeforeInterval).toBe(1);
        expect(harness.renders).toBe(2);
    });

    it('drops a pending render when cancelled', () => {
        // Arrange
        const harness = createHarness();
        harness.scheduler.schedule();

        // Act
        harness.scheduler.cancel();
        harness.runFrames();

        // Assert
        expect(harness.renders).toBe(0);
        expect(harness.scheduler.isPending).toBe(false);
    });
});
