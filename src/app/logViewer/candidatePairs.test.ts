import { describe, expect, it } from 'vitest';
import { createSampleDiagnostics } from '../testing/adminFakes.js';
import { buildPairRows, formatAddress, isMdnsAddress, summarizeDiagnostics, summarizeSlots } from './candidatePairs.js';

describe('buildPairRows', () => {
    it('puts the selected pair first and failed pairs last', () => {
        // Act
        const rows = buildPairRows(createSampleDiagnostics().pairs);

        // Assert
        expect(rows.map(row => row.id)).toEqual(['pair-1', 'pair-3', 'pair-2']);
        expect(rows[0]?.selected).toBe(true);
    });

    it('labels candidate types and flags hidden .local addresses (DL-06)', () => {
        // Act
        const rows = buildPairRows(createSampleDiagnostics().pairs);
        const selected = rows[0];
        const mdns = rows.find(row => row.id === 'pair-2');

        // Assert
        expect(selected?.remote.typeLabel).toBe('peer-reflexive');
        expect(selected?.local.address).toBe('192.168.1.23:52344');
        expect(mdns?.local.isHidden).toBe(true);
        expect(mdns?.local.address).toBe('3f2a9c1e-77b0-4c1d-9a51-2b7f0e3d8c44.local:52344');
    });

    it('formats round-trip time and bytes', () => {
        // Act
        const rows = buildPairRows(createSampleDiagnostics().pairs);

        // Assert
        expect(rows[0]?.rtt).toBe('4 ms');
        expect(rows[0]?.sent).toBe('1.3 GiB');
        expect(rows[1]?.rtt).toBe('—');
    });
});

describe('formatAddress', () => {
    it('brackets IPv6 addresses', () => {
        // Act & Assert
        expect(formatAddress('fe80::1', 5000)).toBe('[fe80::1]:5000');
        expect(formatAddress('10.0.0.2', 5000)).toBe('10.0.0.2:5000');
        expect(isMdnsAddress('ABC.LOCAL')).toBe(true);
    });
});

describe('summaries', () => {
    it('describes the link and busy slots', () => {
        // Arrange
        const diagnostics = createSampleDiagnostics();

        // Act & Assert
        expect(summarizeDiagnostics(diagnostics)).toBe('connected · health good · rtt 4 ms · max message 256 KiB');
        expect(summarizeSlots(diagnostics)).toEqual(['slot 1 out 1.9 MiB buffered']);
    });
});
