import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../core/logger.js';
import type { LogEntry } from '../../core/logger.js';
import { createMemorySink } from '../../core/logSinks.js';
import { PANEL_SIZE_PROPERTIES } from '../appTypes.js';
import {
    createFakeAdminClient,
    createFakeDatabaseSink,
    createFakeDeviceInfo,
    createSampleDiagnostics,
    createSampleLogEntries,
    SAMPLE_PEER,
} from '../testing/adminFakes.js';
import type { FakeAdminClientOptions } from '../testing/adminFakes.js';
import { createLogViewer } from './logViewer.js';

async function waitAsync(ms = 150): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

interface Viewport {
    setViewport(viewport: { width: number; height: number }): void;
}

function setViewport(width: number, height: number): void {
    (window as unknown as { happyDOM: Viewport }).happyDOM.setViewport({ width, height });
    window.dispatchEvent(new Event('resize'));
}

function setup(options: {
    entries?: LogEntry[];
    capacity?: number;
    client?: FakeAdminClientOptions;
    previousRun?: LogEntry[];
    isDebugLogging?: () => boolean;
} = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const memorySink = createMemorySink(options.capacity ?? 5000);
    for (const entry of options.entries ?? []) {
        memorySink.write(entry);
    }

    const client = createFakeAdminClient(options.client);
    const { logger } = createLogger({ sinks: [] });
    const viewer = createLogViewer({
        container,
        client,
        memorySink,
        databaseSink: createFakeDatabaseSink(options.previousRun ?? []),
        deviceInfo: createFakeDeviceInfo(),
        buildVersion: '0.1.0+abcd1234',
        logger,
        ...(options.isDebugLogging == null ? {} : { isDebugLogging: options.isDebugLogging }),
    });

    const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.log-row')];
    const messages = (): string[] => rows().map(row => row.querySelector('.log-msg')?.textContent ?? '');
    const select = (label: string): HTMLSelectElement => {
        const found = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
        if (!found) {
            throw new Error(`No select ${label}`);
        }

        return found;
    };

    return { container, memorySink, client, viewer, rows, messages, select };
}

describe('createLogViewer', () => {
    afterEach(() => {
        document.body.replaceChildren();
        setViewport(1024, 768);
    });

    it('shows what the memory sink already holds when opened mid-session (DL-01)', () => {
        // Arrange
        const entries = createSampleLogEntries();
        const { viewer, messages } = setup({ entries });

        // Act
        viewer.open();

        // Assert
        expect(messages()).toHaveLength(entries.length);
        expect(messages()[0]).toBe('camera permission: granted (real local IPs exposed)');
    });

    it('is a labelled region without aria-live (DL-05)', () => {
        // Arrange
        const { container, viewer } = setup();

        // Act
        viewer.open();
        const region = container.querySelector<HTMLElement>('.log-viewer');

        // Assert
        expect(region?.tagName).toBe('SECTION');
        expect(region?.getAttribute('aria-labelledby')).toBe('log-viewer-title');
        expect(container.querySelector('[aria-live]')).toBeNull();
    });

    it('marks the root and sizes the docked panel, then cleans up when closed (DL-02, DL-11)', () => {
        // Arrange
        setViewport(1280, 800);
        const { container, viewer, memorySink } = setup();

        // Act
        viewer.open();
        const style = document.documentElement.style;
        const opened = {
            attribute: document.documentElement.dataset.logViewer,
            inline: style.getPropertyValue(PANEL_SIZE_PROPERTIES.logViewerInline),
            layout: container.querySelector<HTMLElement>('.log-viewer')?.dataset.layout,
        };
        viewer.close();
        memorySink.write({ t: 1, wall: 1, level: 'info', cat: 'app', msg: 'after close' });

        // Assert
        expect(opened).toEqual({ attribute: 'open', inline: '380px', layout: 'dock' });
        expect(container.querySelector('.log-viewer')).toBeNull();
        expect(document.documentElement.hasAttribute('data-log-viewer')).toBe(false);
        expect(style.getPropertyValue(PANEL_SIZE_PROPERTIES.logViewerInline)).toBe('');
    });

    it('uses a 40% drawer in portrait and half the width in landscape, keeping filters on rotation', async () => {
        // Arrange
        setViewport(390, 844);
        const { container, viewer, select } = setup({ entries: createSampleLogEntries() });
        viewer.open();
        const viewerElement = container.querySelector<HTMLElement>('.log-viewer');
        const portrait = {
            layout: viewerElement?.dataset.layout,
            block: document.documentElement.style.getPropertyValue(PANEL_SIZE_PROPERTIES.logViewerBlock),
        };
        const level = select('Level');
        level.value = 'warn';
        level.dispatchEvent(new Event('change'));

        // Act
        setViewport(844, 390);
        await waitAsync(50);
        const landscape = {
            layout: viewerElement?.dataset.layout,
            inline: document.documentElement.style.getPropertyValue(PANEL_SIZE_PROPERTIES.logViewerInline),
        };

        // Assert
        expect(portrait).toEqual({ layout: 'drawer', block: '338px' });
        expect(landscape).toEqual({ layout: 'side', inline: '422px' });
        expect(select('Level').value).toBe('warn');
    });

    it('appends new entries in a batch, not one by one (DL-10)', async () => {
        // Arrange
        const { viewer, memorySink, messages, rows } = setup();
        viewer.open();

        // Act
        for (let index = 0; index < 50; index++) {
            memorySink.write({ t: index, wall: index, level: 'info', cat: 'xfer', msg: `line ${index}` });
        }

        const synchronous = messages().length;
        await waitAsync();

        // Assert
        expect(synchronous).toBe(0);
        expect(rows()[0]?.getAttribute('aria-setsize')).toBe('50');
        expect(messages().at(-1)).toBe('line 49');
    });

    it('renders only the visible part of a long list', () => {
        // Arrange
        const entries = Array.from({ length: 3000 }, (_, index): LogEntry => ({
            t: index,
            wall: index * 100,
            level: 'info',
            cat: 'app',
            msg: `line ${index}`,
        }));
        const { viewer, rows } = setup({ entries });

        // Act
        viewer.open();

        // Assert
        expect(rows().length).toBeLessThan(100);
        expect(rows()[0]?.getAttribute('aria-setsize')).toBe('3000');
        expect(rows().at(-1)?.textContent).toContain('line 2999');
    });

    it('filters by level, category and file, and searches', async () => {
        // Arrange
        const { viewer, messages, select, container } = setup({ entries: createSampleLogEntries() });
        viewer.open();
        const change = (target: HTMLSelectElement, value: string): void => {
            target.value = value;
            target.dispatchEvent(new Event('change'));
        };

        // Act
        change(select('Level'), 'warn');
        const warnings = messages();
        change(select('Level'), 'debug');
        change(select('Category'), 'dtls');
        const dtls = messages();
        change(select('Category'), 'all');
        change(select('File'), 'f1c2a9e07b3d4411');
        const file = messages();
        change(select('File'), '');
        const search = container.querySelector<HTMLInputElement>('input[type="search"]');
        if (search) {
            search.value = 'nominated';
            search.dispatchEvent(new Event('input'));
        }

        await waitAsync(200);

        // Assert
        expect(warnings).toEqual(['weak: 6.2 s since last message']);
        expect(dtls).toHaveLength(2);
        expect(file).toHaveLength(4);
        expect(select('File').textContent).toContain('IMG_2231.MOV');
        expect(messages()).toEqual(['192.168.1.23:52344 ↔ 192.168.1.41:60111 succeeded, nominated, rtt 4 ms']);
    });

    it('expands a line to its JSON when clicked (DL-03)', () => {
        // Arrange
        const { viewer, rows } = setup({ entries: createSampleLogEntries() });
        viewer.open();
        const line = rows()[2]?.querySelector<HTMLButtonElement>('.log-line');

        // Act
        line?.click();
        const expanded = rows()[2];

        // Assert
        expect(expanded?.dataset.expanded).toBe('true');
        expect(expanded?.querySelector('.log-json')?.textContent).toContain('"address": "192.168.1.23"');
        expect(expanded?.querySelector('.json-key')).not.toBeNull();
    });

    it('collapses a busy second of page lines into "+N pages" (DL-09)', () => {
        // Arrange
        const { viewer, messages } = setup({ entries: createSampleLogEntries({ pageBurst: 87 }) });

        // Act
        viewer.open();

        // Assert
        expect(messages()).toContain('+87 pages');
        expect(messages().at(-1)).toContain('summary');
    });

    it('says how many older entries were dropped (DL-08)', () => {
        // Arrange
        const entries = Array.from({ length: 25 }, (_, index): LogEntry => ({ t: index, wall: index, level: 'warn', cat: 'app', msg: `line ${index}` }));
        const { container, viewer } = setup({ entries, capacity: 10 });

        // Act
        viewer.open();

        // Assert
        expect(container.querySelector('.log-viewer-notice')?.textContent).toContain('15 older entries dropped');
    });

    it('labels peer entries with the peer name (DL-15)', () => {
        // Arrange
        const entries = createSampleLogEntries({ peerName: SAMPLE_PEER.deviceId });
        const { container, viewer } = setup({ entries, client: { state: 'connected', peer: SAMPLE_PEER } });

        // Act
        viewer.open();

        // Assert
        expect(container.querySelector('.log-peer')?.textContent).toBe('[Pixel 8]');
    });

    it('shows the previous run from IndexedDB (DL-12)', async () => {
        // Arrange
        const previousRun: LogEntry[] = [{ t: 5, wall: Date.UTC(2026, 10, 22), level: 'error', cat: 'app', msg: 'crash before reload' }];
        const { container, viewer, messages } = setup({ entries: createSampleLogEntries(), previousRun });
        viewer.open();
        const previous = [...container.querySelectorAll<HTMLButtonElement>('.log-viewer-source')].find(item => item.textContent === 'Previous run');

        // Act
        previous?.click();
        await waitAsync(20);

        // Assert
        expect(previous?.getAttribute('aria-pressed')).toBe('true');
        expect(messages()).toEqual(['crash before reload']);
        expect(container.querySelector('.log-viewer-notice')?.textContent).toContain('Previous run: 1 entries');
    });

    it('draws the handshake timeline from the entries (DL-07)', () => {
        // Arrange
        const { container, viewer } = setup({ entries: createSampleLogEntries() });

        // Act
        viewer.open();
        const steps = [...container.querySelectorAll<HTMLElement>('.timeline-step')];

        // Assert
        expect(container.querySelector('.log-diagnostics-outcome')?.textContent).toBe('Connected in 10.0 s');
        expect(steps.map(step => step.dataset.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done']);
    });

    it('opens at the timeline for the pairing failure screen', () => {
        // Arrange
        setViewport(390, 844);
        const { container, viewer } = setup();

        // Act
        viewer.showTimeline();

        // Assert
        expect(viewer.isOpen).toBe(true);
        expect(container.querySelector<HTMLDetailsElement>('.log-diagnostics')?.open).toBe(true);
    });

    it('polls stats only with debug logging on, and stops when closed (DL-06, DL-11, test 24)', async () => {
        // Arrange
        const { client, container, viewer } = setup({ client: { diagnostics: createSampleDiagnostics() } });
        viewer.open();
        await waitAsync(20);
        const callsWhileOff = client.calls.diagnosticsCount;
        const offText = container.querySelector('.pairs')?.textContent;

        // Act
        await client.configureAsync({ debugLogging: true, statsIntervalMs: 500 });
        await waitAsync(20);
        const selected = container.querySelector<HTMLElement>('.pairs-row[data-selected="true"]');
        const notes = container.querySelector('.pairs-notes')?.textContent;
        viewer.close();
        const callsAtClose = client.calls.diagnosticsCount;
        await waitAsync(600);

        // Assert
        expect(callsWhileOff).toBe(0);
        expect(offText).toContain('Debug logging is off, so connection stats aren’t polled.');
        expect(selected?.textContent).toContain('peer-reflexive');
        expect(notes).toContain('.local = this browser hid its IP (no camera permission)');
        expect(notes).toContain("peer-reflexive = address learned from the other device's checks");
        expect(client.calls.diagnosticsCount).toBe(callsAtClose);
    });

    it('polls stats when ?debug=1 turns debug logging on for the page, whatever the setting says (DL-01)', async () => {
        // Arrange
        const { client, container, viewer } = setup({
            client: { diagnostics: createSampleDiagnostics() },
            isDebugLogging: () => true,
        });

        // Act
        viewer.open();
        await waitAsync(20);
        const selected = container.querySelector('.pairs-row[data-selected="true"]');
        const text = container.textContent;
        viewer.close();

        // Assert
        expect(client.settings.debugLogging).toBe(false);
        expect(client.calls.diagnosticsCount).toBeGreaterThan(0);
        expect(selected).not.toBeNull();
        expect(text).not.toContain('Debug logging is off');
    });

    it('pauses auto-scroll from the button and clears the sink', async () => {
        // Arrange
        const { container, viewer, memorySink, messages } = setup({ entries: createSampleLogEntries() });
        viewer.open();
        const buttons = [...container.querySelectorAll<HTMLButtonElement>('.log-viewer-button')];
        const follow = buttons.find(item => item.textContent === 'Auto-scroll');
        const clear = buttons.find(item => item.textContent === 'Clear');

        // Act
        follow?.click();
        clear?.click();

        // Assert
        expect(follow?.getAttribute('aria-pressed')).toBe('false');
        expect(follow?.textContent).toBe('Paused');
        expect(memorySink.entries()).toHaveLength(0);
        expect(messages()).toHaveLength(0);
        expect(container.querySelector('.log-list-empty')?.textContent).toBe('Nothing logged yet.');
    });
});
