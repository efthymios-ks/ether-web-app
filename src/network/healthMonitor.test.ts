import { describe, expect, it } from 'vitest';
import { createHealthMonitor } from './healthMonitor.js';

function createClock(start = 1000) {
    const clock = { time: start };

    return {
        now: () => clock.time,
        advance: (ms: number) => {
            clock.time += ms;
        },
    };
}

function createStartedMonitor() {
    const clock = createClock();
    const monitor = createHealthMonitor({ now: clock.now, weakMs: 6000, lostMs: 10_000 });
    monitor.start();

    return { clock, monitor };
}

describe('createHealthMonitor', () => {
    it('is Good below weakMs of silence', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        clock.advance(7000);
        monitor.received();
        clock.advance(5999);

        // Act
        const health = monitor.evaluate();

        // Assert
        expect(health).toEqual({ status: 'good', lastSeenMs: 5999, peerHidden: false });
    });

    it('is Weak from weakMs to lostMs of silence', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        clock.advance(6000);

        // Act
        const atWeak = monitor.evaluate().status;
        clock.advance(4000);
        const atLost = monitor.evaluate().status;

        // Assert
        expect(atWeak).toBe('weak');
        expect(atLost).toBe('weak');
    });

    it('is Lost after more than lostMs of silence and stays Lost', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        clock.advance(10_001);

        // Act
        const lost = monitor.evaluate().status;
        monitor.received();
        const afterMessage = monitor.evaluate().status;

        // Assert
        expect(lost).toBe('lost');
        expect(afterMessage).toBe('lost');
    });

    it('never reports Weak in the first 5 s after connecting', () => {
        // Arrange
        const clock = createClock();
        const monitor = createHealthMonitor({ now: clock.now, weakMs: 3000, lostMs: 10_000 });
        monitor.start();
        clock.advance(4999);

        // Act
        const early = monitor.evaluate().status;
        clock.advance(1);
        const later = monitor.evaluate().status;

        // Assert
        expect(early).toBe('good');
        expect(later).toBe('weak');
    });

    it('counts any received message as proof of life', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        clock.advance(9000);

        // Act
        monitor.received();
        const health = monitor.evaluate();

        // Assert
        expect(health.status).toBe('good');
        expect(health.lastSeenMs).toBe(0);
    });

    it('suspends the timeout while the peer is hidden', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        monitor.setPeerHidden(true);
        clock.advance(60_000);

        // Act
        const health = monitor.evaluate();

        // Assert
        expect(health).toEqual({ status: 'good', lastSeenMs: 60_000, peerHidden: true });
    });

    it('restarts the timeout when the peer is visible again', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        monitor.setPeerHidden(true);
        clock.advance(60_000);
        monitor.setPeerHidden(false);
        clock.advance(5000);

        // Act
        const health = monitor.evaluate();

        // Assert
        expect(health).toEqual({ status: 'good', lastSeenMs: 5000, peerHidden: false });
    });

    it('keeps waiting while the connection is disconnected', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        monitor.setConnectionState('disconnected');
        clock.advance(2000);

        // Act
        const health = monitor.evaluate();

        // Assert
        expect(health.status).toBe('good');
    });

    it.each(['failed', 'closed'] as const)('is Lost at once when the connection is %s', state => {
        // Arrange
        const { monitor } = createStartedMonitor();

        // Act
        monitor.setConnectionState(state);

        // Assert
        expect(monitor.evaluate().status).toBe('lost');
    });

    it('reports the last round-trip time', () => {
        // Arrange
        const { monitor } = createStartedMonitor();

        // Act
        monitor.recordRtt(12.4);
        monitor.recordRtt(4.2);

        // Assert
        expect(monitor.evaluate().rttMs).toBe(4);
    });

    it('applies new timeouts live', () => {
        // Arrange
        const { clock, monitor } = createStartedMonitor();
        clock.advance(7000);

        // Act
        monitor.configure({ weakMs: 8000, lostMs: 12_000 });

        // Assert
        expect(monitor.evaluate().status).toBe('good');
    });

    it('is Good with nothing seen before it starts', () => {
        // Arrange
        const clock = createClock();
        const monitor = createHealthMonitor({ now: clock.now, weakMs: 6000, lostMs: 10_000 });
        clock.advance(60_000);

        // Act
        const health = monitor.evaluate();

        // Assert
        expect(health).toEqual({ status: 'good', lastSeenMs: 0, peerHidden: false });
    });
});
