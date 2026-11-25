import type { LogEntry } from '../../core/logger.js';
import type { DeviceInfo } from '../../core/deviceInfo.js';
import { maskIpAddresses, redact } from '../../core/redact.js';
import type { Settings } from '../../core/settings.js';
import { entryDetails, formatLine, safeStringify } from './logFormat.js';

export type ExportFormat = 'txt' | 'json';

export type LogSource = 'live' | 'previous-run';

export interface ExportInput {
    readonly entries: readonly LogEntry[];
    readonly deviceInfo: DeviceInfo;
    readonly settings: Settings;
    readonly buildVersion: string;
    readonly serviceWorkerVersion?: string;
    readonly source: LogSource;
    readonly dropped: number;
    // A readable summary of the active filters, empty for none.
    readonly filter: string;
    readonly exportedAt: number;
    // DL-14: hides the last part of every IP address.
    readonly maskIps: boolean;
    readonly peerName?: (entry: LogEntry) => string | undefined;
}

const MIME_TYPES: Readonly<Record<ExportFormat, string>> = Object.freeze({
    txt: 'text/plain;charset=utf-8',
    json: 'application/json;charset=utf-8',
});

const SOURCE_NAMES: Readonly<Record<LogSource, string>> = Object.freeze({
    'live': 'this run',
    'previous-run': 'previous run',
});

const BUILDERS: Readonly<Record<ExportFormat, (input: ExportInput) => string>> = Object.freeze({
    txt: buildText,
    json: buildJson,
});

// PW-00: ether-logs-<date>.json, local time so it sorts and reads naturally.
export function exportFileName(format: ExportFormat, date: Date): string {
    const pad = (value: number): string => `${value}`.padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

    return `ether-logs-${day}-${time}.${format}`;
}

export function exportMimeType(format: ExportFormat): string {
    return MIME_TYPES[format];
}

// DL-13: entries plus device info and settings; nothing leaves the device unless the user shares the file.
// The settings go through the logger's redaction, so the PIN never leaves in an export.
export function buildExport(format: ExportFormat, input: ExportInput): string {
    const entries = input.maskIps ? input.entries.map(maskEntry) : input.entries;

    return BUILDERS[format]({ ...input, entries });
}

// DL-14: masks only what entries say, so timestamps such as 13:05:09 are never mistaken for addresses.
export function maskEntry(entry: LogEntry): LogEntry {
    if (entry.data === undefined) {
        return { ...entry, msg: maskIpAddresses(entry.msg) };
    }

    return { ...entry, msg: maskIpAddresses(entry.msg), data: maskData(entry.data) };
}

function maskData(data: unknown): unknown {
    const masked = maskIpAddresses(safeStringify(data));
    try {
        return JSON.parse(masked) as unknown;
    } catch {
        return masked;
    }
}

function buildJson(input: ExportInput): string {
    const document = {
        app: 'Ether',
        build: input.buildVersion,
        serviceWorker: input.serviceWorkerVersion ?? null,
        exportedAt: new Date(input.exportedAt).toISOString(),
        source: input.source,
        filter: input.filter === '' ? null : input.filter,
        dropped: input.dropped,
        device: input.deviceInfo,
        settings: redact(input.settings),
        entries: input.entries.map(entry => {
            const peerName = input.peerName?.(entry);

            return peerName == null ? entryDetails(entry) : { ...entryDetails(entry), peerName };
        }),
    };

    return `${safeStringify(document, 2)}\n`;
}

function buildText(input: ExportInput): string {
    const device = input.deviceInfo;
    const system = [
        `${device.os} ${device.osVersion ?? ''}`.trim(),
        `${device.browser} ${device.browserVersion ?? ''}`.trim(),
        device.engine,
        device.displayMode,
    ];
    const capabilities = Object.entries(device.capabilities)
        .filter(([, isOn]) => isOn)
        .map(([name]) => name);
    const header = [
        `Ether logs, build ${input.buildVersion}`,
        `Exported ${new Date(input.exportedAt).toISOString()} (${SOURCE_NAMES[input.source]})`,
        `Service worker ${input.serviceWorkerVersion ?? 'not active'}`,
        `Device ${device.label}: ${system.join(', ')}`,
        `Capabilities ${capabilities.join(', ')}`,
        `Settings ${safeStringify(redact(input.settings))}`,
        input.filter === '' ? null : `Filter ${input.filter}`,
        input.dropped > 0 ? `${input.dropped.toLocaleString('en')} older entries dropped` : null,
        `${input.entries.length.toLocaleString('en')} entries`,
    ];
    const lines = input.entries.map(entry => formatLine(entry, {
        peerName: input.peerName?.(entry),
        withData: true,
    }));

    return `${[...header.filter(line => line != null), '', ...lines].join('\n')}\n`;
}

// Saves text as a file through a temporary object URL; nothing is uploaded.
export function downloadText(fileName: string, text: string, mimeType: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
