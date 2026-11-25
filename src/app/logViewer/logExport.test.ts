import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../core/settings.js';
import { createFakeDeviceInfo, createSampleLogEntries } from '../testing/adminFakes.js';
import { buildExport, exportFileName } from './logExport.js';
import type { ExportInput } from './logExport.js';

function input(overrides: Partial<ExportInput> = {}): ExportInput {
    return {
        entries: createSampleLogEntries().slice(0, 4),
        deviceInfo: createFakeDeviceInfo(),
        settings: createDefaultSettings({ deviceName: 'iPhone · Blue Otter' }),
        buildVersion: '0.1.0+abcd1234',
        source: 'live',
        dropped: 0,
        filter: '',
        exportedAt: Date.UTC(2026, 10, 23, 13, 5, 9),
        maskIps: false,
        ...overrides,
    };
}

describe('exportFileName', () => {
    it('follows ether-logs-<date> (PW-00)', () => {
        // Act
        const name = exportFileName('json', new Date(2026, 10, 23, 9, 5, 7));

        // Assert
        expect(name).toBe('ether-logs-2026-11-23-090507.json');
    });
});

describe('buildExport', () => {
    it('writes JSON with device info, settings and entries (DL-13)', () => {
        // Act
        const document = JSON.parse(buildExport('json', input())) as Record<string, unknown>;

        // Assert
        expect(document.app).toBe('Ether');
        expect(document.build).toBe('0.1.0+abcd1234');
        expect((document.device as { label: string }).label).toBe('iPhone · Safari');
        expect((document.settings as { pageSize: number }).pageSize).toBe(1024 * 1024);
        expect((document.entries as unknown[]).length).toBe(4);
        expect(document.exportedAt).toBe('2026-11-23T13:05:09.000Z');
    });

    it.each(['json', 'txt'] as const)('never writes the PIN into a %s export', format => {
        // Arrange
        const settings = createDefaultSettings({ deviceName: 'Swift Perseus', pin: '86420975' });

        // Act
        const exported = buildExport(format, input({ settings }));

        // Assert
        expect(exported).not.toContain('86420975');
        expect(exported).toContain('[redacted]');
        expect(exported).toContain('Swift Perseus');
    });

    it('writes text with a header and one line per entry', () => {
        // Act
        const text = buildExport('txt', input({ dropped: 1200, filter: 'category ice' }));
        const lines = text.trimEnd().split('\n');

        // Assert
        expect(lines[0]).toBe('Ether logs, build 0.1.0+abcd1234');
        expect(text).toContain('Device iPhone · Safari: iOS 18.4, Safari 18.4, WebKit, browser');
        expect(text).toContain('Filter category ice');
        expect(text).toContain('1,200 older entries dropped');
        expect(lines.at(-1)).toContain('ice    debug local host udp 10.84.2.7:61021');
    });

    it('masks IP addresses when asked (DL-14)', () => {
        // Act
        const plain = buildExport('txt', input());
        const masked = buildExport('txt', input({ maskIps: true }));

        // Assert
        expect(plain).toContain('192.168.1.23:52344');
        expect(masked).not.toContain('192.168.1.23');
        expect(masked).toContain('192.168.1.x:52344');
        expect(masked).toContain('Exported 2026-11-23T13:05:09.000Z');
    });

    it('masks addresses inside entry data too', () => {
        // Act
        const document = JSON.parse(buildExport('json', input({ maskIps: true }))) as { entries: Array<{ data?: unknown }> };

        // Assert
        expect(JSON.stringify(document.entries[2]?.data)).toContain('"address":"192.168.1.x"');
    });

    it('labels peer entries with the peer name', () => {
        // Arrange
        const entries = createSampleLogEntries({ peerName: 'peer-device-8f2c' }).filter(entry => entry.peer != null);

        // Act
        const text = buildExport('txt', input({ entries, peerName: entry => (entry.peer == null ? undefined : 'Pixel 8') }));

        // Assert
        expect(text).toContain('[Pixel 8] peer sync');
    });
});
