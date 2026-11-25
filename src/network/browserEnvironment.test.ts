import { describe, expect, it, vi } from 'vitest';
import { createBrowserEnvironment } from './browserEnvironment.js';

describe('createBrowserEnvironment', () => {
    it('can be built where the page globals are missing', () => {
        // Act
        const environment = createBrowserEnvironment();

        // Assert
        expect(environment.isHidden()).toBe(false);
        expect(environment.onVisibilityChange(() => undefined)).toBeTypeOf('function');
        expect(environment.onPageHide(() => undefined)).toBeTypeOf('function');
    });

    it('gives random bytes of the asked length', () => {
        // Arrange
        const environment = createBrowserEnvironment();

        // Act
        const bytes = environment.randomBytes(16);

        // Assert
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes).toHaveLength(16);
    });

    it('runs and cancels timers through the global timer functions', () => {
        // Arrange
        vi.useFakeTimers();
        const environment = createBrowserEnvironment();
        const kept = vi.fn();
        const cancelled = vi.fn();

        // Act
        environment.setTimeout(kept, 10);
        environment.clearTimeout(environment.setTimeout(cancelled, 10));
        vi.advanceTimersByTime(10);
        vi.useRealTimers();

        // Assert
        expect(kept).toHaveBeenCalledOnce();
        expect(cancelled).not.toHaveBeenCalled();
    });
});
