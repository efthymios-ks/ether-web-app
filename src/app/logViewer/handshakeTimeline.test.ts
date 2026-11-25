import { describe, expect, it } from 'vitest';
import type { LogCategory, LogEntry, LogLevel } from '../../core/logger.js';
import { createSampleLogEntries } from '../testing/adminFakes.js';
import { buildTimeline, latestAttempt } from './handshakeTimeline.js';
import type { Timeline } from './handshakeTimeline.js';

function entry(t: number, cat: LogCategory, msg: string, level: LogLevel = 'info', data?: unknown): LogEntry {
    return { t, wall: 1_000_000 + t, level, cat, msg, ...(data === undefined ? {} : { data }) };
}

function statuses(timeline: Timeline): string[] {
    return timeline.steps.map(step => `${step.id}:${step.status}`);
}

describe('buildTimeline', () => {
    it('builds every step from the §16.7 example', () => {
        // Act
        const timeline = buildTimeline(createSampleLogEntries());

        // Assert
        expect(statuses(timeline)).toEqual([
            'camera:done',
            'gathering:done',
            'code:done',
            'answer:done',
            'ice:done',
            'dtls:done',
            'channels:done',
        ]);
        expect(timeline.outcome).toBe('connected');
        expect(timeline.totalMs).toBe(10020);
    });

    it('takes span durations from the data and the rest from the step before', () => {
        // Act
        const steps = buildTimeline(createSampleLogEntries()).steps;

        // Assert
        expect(steps.find(step => step.id === 'gathering')?.durationMs).toBe(289);
        expect(steps.find(step => step.id === 'answer')?.durationMs).toBe(9880 - 302);
        expect(steps.find(step => step.id === 'dtls')?.durationMs).toBe(10010 - 9960);
    });

    it('keeps the rest of the line as detail', () => {
        // Act
        const steps = buildTimeline(createSampleLogEntries()).steps;

        // Assert
        expect(steps.find(step => step.id === 'camera')?.detail).toBe('granted (real local IPs exposed)');
        expect(steps.find(step => step.id === 'code')?.detail).toBe('code 86 B → 138 chars, QR v6');
        expect(steps.find(step => step.id === 'answer')?.detail).toMatch(/^remote host 192\.168\.1\.41:60111/);
    });

    it('marks a denied camera as a warning, not a failure', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'camera permission: denied (.local names only)'),
            entry(300, 'pair', 'gathering complete 300 ms'),
        ];

        // Act
        const timeline = buildTimeline(entries);

        // Assert
        expect(timeline.steps[0]?.status).toBe('warn');
        expect(timeline.steps[1]?.durationMs).toBe(300);
        expect(timeline.outcome).toBe('in-progress');
    });

    it('shows a failed ICE step in red with the last state reached (test 25)', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'camera permission: denied'),
            entry(290, 'pair', 'gathering 290 ms', 'info', { durationMs: 290 }),
            entry(300, 'pair', 'code 70 B → 112 chars, QR v5'),
            entry(9000, 'pair', 'answer applied; remote host 4b1c….local:5000'),
            entry(9010, 'ice', 'iceConnectionState checking'),
            entry(24000, 'ice', 'iceConnectionState failed', 'warn'),
        ];

        // Act
        const timeline = buildTimeline(entries);
        const ice = timeline.steps.find(step => step.id === 'ice');

        // Assert
        expect(timeline.outcome).toBe('failed');
        expect(timeline.failedStep).toBe('ice');
        expect(ice?.status).toBe('failed');
        expect(ice?.lastState).toBe('iceConnectionState checking');
        expect(statuses(timeline).slice(5)).toEqual(['dtls:pending', 'channels:pending']);
    });

    it('blames the first missing step for a connect timeout', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'camera permission: granted'),
            entry(200, 'pair', 'gathering 200 ms'),
            entry(9000, 'pair', 'answer applied'),
            entry(24000, 'pair', 'connect timeout after 15 s', 'error'),
        ];

        // Act
        const timeline = buildTimeline(entries);

        // Assert
        expect(statuses(timeline)).toEqual([
            'camera:done',
            'gathering:done',
            'code:skipped',
            'answer:done',
            'ice:failed',
            'dtls:pending',
            'channels:pending',
        ]);
        expect(timeline.steps[4]?.lastState).toBe('answer applied');
    });

    it('skips "answer applied" on the device that scanned the offer', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'code decoded: offer, 2 candidates'),
            entry(10, 'pair', 'answer created'),
            entry(250, 'pair', 'gathering 240 ms'),
            entry(260, 'pair', 'code 80 B → 128 chars, QR v6'),
            entry(4000, 'ice', 'iceConnectionState connected'),
            entry(4050, 'dtls', 'connected'),
            entry(4060, 'dtls', 'channels open: control, slot1'),
        ];

        // Act
        const timeline = buildTimeline(entries);

        // Assert
        expect(timeline.role).toBe('joiner');
        expect(statuses(timeline)).toEqual([
            'camera:skipped',
            'gathering:done',
            'code:done',
            'answer:skipped',
            'ice:done',
            'dtls:done',
            'channels:done',
        ]);
        expect(timeline.outcome).toBe('connected');
    });

    it('accepts connectionState connected as DTLS connected', () => {
        // Act
        const timeline = buildTimeline([entry(10, 'ice', 'connectionState connected')]);

        // Assert
        expect(timeline.steps.find(step => step.id === 'dtls')?.status).toBe('done');
        expect(timeline.steps.find(step => step.id === 'ice')?.status).toBe('skipped');
    });

    it('is empty without handshake lines', () => {
        // Act
        const timeline = buildTimeline([entry(0, 'xfer', 'page 1/2', 'debug')]);

        // Assert
        expect(timeline.outcome).toBe('none');
        expect(timeline.steps.every(step => step.status === 'pending')).toBe(true);
    });
});

// The lines src/network/network.ts writes, in the order a real pairing writes them.
describe('buildTimeline with the network layer wording', () => {
    it('follows the device that showed the offer', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'camera permission: granted (real local IPs exposed)'),
            entry(14, 'pair', 'offer created, gathering…'),
            entry(120, 'ice', 'local host udp 192.168.1.23:52344', 'debug'),
            entry(300, 'pair', 'gathering 286 ms', 'info', { durationMs: 286, complete: true, candidates: 2 }),
            entry(302, 'pair', 'offer code 86 B, 138 chars', 'info', { bytes: 86, chars: 138, candidates: 2 }),
            entry(310, 'pair', 'offer shown', 'info', { expiresAt: 0 }),
            entry(9000, 'pair', 'answer code decoded', 'info'),
            entry(9004, 'ice', 'remote host udp 192.168.1.41:60111', 'info'),
            entry(9010, 'pair', 'answer applied'),
            entry(9020, 'ice', 'iceConnectionState checking'),
            entry(9070, 'ice', 'iceConnectionState connected'),
            entry(9090, 'dtls', 'DTLS connecting'),
            entry(9120, 'dtls', 'DTLS connected; fingerprint verified'),
            entry(9125, 'ice', 'connectionState connected'),
            entry(9140, 'dtls', 'SCTP connected', 'info', { maxMessageSize: 262_144 }),
            entry(9160, 'dtls', 'channels open: control, slot1, slot2, slot3, slot4'),
            entry(9170, 'pair', 'connect 160 ms', 'info', { durationMs: 160 }),
            entry(9171, 'dtls', 'connected; sctp maxMessageSize 262144', 'info', { maxMessageSize: 262_144 }),
        ];

        // Act
        const timeline = buildTimeline(entries);

        // Assert
        expect(timeline.role).toBe('offerer');
        expect(statuses(timeline)).toEqual([
            'camera:done',
            'gathering:done',
            'code:done',
            'answer:done',
            'ice:done',
            'dtls:done',
            'channels:done',
        ]);
        expect(timeline.steps.find(step => step.id === 'code')?.detail).toBe('offer code 86 B, 138 chars');
        expect(timeline.steps.find(step => step.id === 'dtls')?.t).toBe(9120);
        expect(timeline.totalMs).toBe(9160);
    });

    it('follows the device that scanned the offer', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'offer code decoded', 'info', { candidates: 2 }),
            entry(5, 'pair', 'camera permission: denied or unavailable (.local names)'),
            entry(20, 'pair', 'answer created, gathering…'),
            entry(3020, 'pair', 'gathering 3000 ms', 'info', { durationMs: 3000, complete: false, candidates: 1 }),
            entry(3021, 'pair', 'gathering capped at 3000 ms', 'warn'),
            entry(3030, 'pair', 'answer code 70 B, 112 chars'),
            entry(9000, 'ice', 'iceConnectionState connected'),
            entry(9040, 'dtls', 'DTLS connected; fingerprint verified'),
            entry(9060, 'dtls', 'channels open: control, slot1, slot2, slot3, slot4'),
        ];

        // Act
        const timeline = buildTimeline(entries);

        // Assert
        expect(timeline.role).toBe('joiner');
        expect(statuses(timeline)).toEqual([
            'camera:warn',
            'gathering:warn',
            'code:done',
            'answer:skipped',
            'ice:done',
            'dtls:done',
            'channels:done',
        ]);
    });

    it('shows the states the network reports when the connect timer runs out', () => {
        // Arrange
        const states = {
            linkState: 'connecting',
            signalingState: 'stable',
            iceGatheringState: 'complete',
            iceConnectionState: 'checking',
            connectionState: 'connecting',
            dtlsState: 'new',
            openChannels: 0,
        };
        const entries = [
            entry(0, 'pair', 'camera permission: not asked (.local names)'),
            entry(300, 'pair', 'gathering 290 ms', 'info', { durationMs: 290, complete: true }),
            entry(301, 'pair', 'offer code 80 B, 128 chars'),
            entry(8000, 'pair', 'answer applied'),
            entry(8010, 'ice', 'iceConnectionState checking'),
            entry(23_000, 'pair', 'not connected after 15000 ms', 'error', states),
        ];

        // Act
        const timeline = buildTimeline(entries);
        const ice = timeline.steps.find(step => step.id === 'ice');

        // Assert
        expect(timeline.steps[0]?.status).toBe('warn');
        expect(ice?.status).toBe('failed');
        expect(ice?.detail).toBe('not connected after 15000 ms');
        expect(ice?.lastState).toBe('linkState connecting, signalingState stable, iceGatheringState complete, '
            + 'iceConnectionState checking, connectionState connecting, dtlsState new, openChannels 0');
    });

    it('marks DTLS failed on a fingerprint mismatch', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'answer applied'),
            entry(50, 'ice', 'iceConnectionState connected'),
            entry(60, 'dtls', 'DTLS connecting'),
            entry(80, 'dtls', 'DTLS failed: fingerprint mismatch or handshake error', 'error'),
        ];

        // Act
        const dtls = buildTimeline(entries).steps.find(step => step.id === 'dtls');

        // Assert
        expect(dtls?.status).toBe('failed');
        expect(dtls?.lastState).toBe('DTLS connecting');
    });
});

describe('latestAttempt', () => {
    it('starts at the last pairing, where t restarted, and ignores peer entries', () => {
        // Arrange
        const entries = [
            entry(0, 'pair', 'camera permission: granted'),
            entry(50_000, 'xfer', 'done'),
            { ...entry(1, 'pair', 'peer line'), peer: 'peer-1' },
            entry(0, 'pair', 'camera permission: denied'),
            entry(40, 'pair', 'gathering 40 ms'),
        ];

        // Act
        const attempt = latestAttempt(entries);

        // Assert
        expect(attempt.map(item => item.msg)).toEqual(['camera permission: denied', 'gathering 40 ms']);
    });
});
