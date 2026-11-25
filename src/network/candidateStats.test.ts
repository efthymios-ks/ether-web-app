import { describe, expect, it } from 'vitest';
import { mapCandidatePairStats } from './candidateStats.js';
import type { StatsRecord } from './candidateStats.js';

const LOCAL_HOST: StatsRecord = {
    id: 'L1',
    type: 'local-candidate',
    candidateType: 'host',
    protocol: 'udp',
    address: '3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local',
    port: 52344,
};

const REMOTE_PRFLX: StatsRecord = {
    id: 'R1',
    type: 'remote-candidate',
    candidateType: 'prflx',
    protocol: 'udp',
    address: '192.168.1.41',
    port: 60111,
};

const REMOTE_HOST: StatsRecord = {
    id: 'R2',
    type: 'remote-candidate',
    candidateType: 'host',
    protocol: 'udp',
    ip: '192.168.1.42',
    port: 60112,
};

const PAIR_SUCCEEDED: StatsRecord = {
    id: 'P1',
    type: 'candidate-pair',
    localCandidateId: 'L1',
    remoteCandidateId: 'R1',
    state: 'succeeded',
    nominated: true,
    currentRoundTripTime: 0.0042,
    bytesSent: 1200,
    bytesReceived: 3400,
};

const PAIR_FAILED: StatsRecord = {
    id: 'P2',
    type: 'candidate-pair',
    localCandidateId: 'L1',
    remoteCandidateId: 'R2',
    state: 'failed',
};

describe('mapCandidatePairStats', () => {
    it('maps every candidate pair with both candidates (Chrome and Safari)', () => {
        // Arrange
        const transport: StatsRecord = { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' };
        const records = [transport, LOCAL_HOST, REMOTE_PRFLX, REMOTE_HOST, PAIR_SUCCEEDED, PAIR_FAILED];

        // Act
        const pairs = mapCandidatePairStats(records);

        // Assert
        expect(pairs).toEqual([
            {
                id: 'P1',
                local: { type: 'host', protocol: 'udp', address: '3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local', port: 52344 },
                remote: { type: 'prflx', protocol: 'udp', address: '192.168.1.41', port: 60111 },
                state: 'succeeded',
                nominated: true,
                selected: true,
                rttMs: 4,
                bytesSent: 1200,
                bytesReceived: 3400,
            },
            {
                id: 'P2',
                local: { type: 'host', protocol: 'udp', address: '3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local', port: 52344 },
                remote: { type: 'host', protocol: 'udp', address: '192.168.1.42', port: 60112 },
                state: 'failed',
                nominated: false,
                selected: false,
                bytesSent: 0,
                bytesReceived: 0,
            },
        ]);
    });

    it('falls back to the selected flag without a transport entry (Firefox)', () => {
        // Arrange
        const firefoxPair: StatsRecord = { ...PAIR_SUCCEEDED, selected: true };

        // Act
        const pairs = mapCandidatePairStats([LOCAL_HOST, REMOTE_PRFLX, REMOTE_HOST, firefoxPair, PAIR_FAILED]);

        // Assert
        expect(pairs.map(pair => pair.selected)).toEqual([true, false]);
    });

    it('falls back to the nominated succeeded pair when nothing says which is selected', () => {
        // Act
        const pairs = mapCandidatePairStats([LOCAL_HOST, REMOTE_PRFLX, REMOTE_HOST, PAIR_FAILED, PAIR_SUCCEEDED]);

        // Assert
        expect(pairs.map(pair => [pair.id, pair.selected])).toEqual([
            ['P2', false],
            ['P1', true],
        ]);
    });

    it('maps unknown states and candidate types to safe values', () => {
        // Arrange
        const odd: StatsRecord = { ...PAIR_FAILED, state: 'cancelled' };
        const local: StatsRecord = { ...LOCAL_HOST, candidateType: 'serverreflexive' };

        // Act
        const [pair] = mapCandidatePairStats([local, REMOTE_HOST, odd]);

        // Assert
        expect(pair?.state).toBe('failed');
        expect(pair?.local.type).toBe('srflx');
    });

    it('keeps a pair whose candidates are missing, with empty candidate details', () => {
        // Act
        const [pair] = mapCandidatePairStats([PAIR_FAILED]);

        // Assert
        expect(pair?.local).toEqual({ type: 'host', protocol: '', address: '', port: 0 });
    });
});
