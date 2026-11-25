import type { Client, Diagnostics } from '../../client/clientTypes.js';
import type { DeviceInfo } from '../../core/deviceInfo.js';
import type { DatabaseSink } from '../../core/logDatabaseSink.js';
import type { LogCategory, LogEntry, Logger } from '../../core/logger.js';
import type { MemorySink } from '../../core/logSinks.js';
import { PANEL_SIZE_PROPERTIES } from '../appTypes.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import { renderPairs, renderTimeline, timelineSummary } from './diagnosticsView.js';
import { buildTimeline } from './handshakeTimeline.js';
import { buildExport, downloadText, exportFileName, exportMimeType } from './logExport.js';
import type { ExportFormat, LogSource } from './logExport.js';
import {
    CATEGORY_FILTERS,
    collectFiles,
    createMatcher,
    DEFAULT_FILTER,
    describeFilter,
    isFilterActive,
    LEVEL_FILTERS,
} from './logFilter.js';
import type { LogFilter } from './logFilter.js';
import { peerLabel } from './logFormat.js';
import { createLogList } from './logList.js';
import { buildRows } from './pageCollapse.js';
import { createRenderScheduler } from './renderScheduler.js';
import { createStatsPoller } from './statsPoller.js';
import {
    clampDockWidth,
    clampDrawerHeight,
    DEFAULT_SIZE_STATE,
    panelSize,
    resolveViewerLayout,
} from './viewerLayout.js';
import type { ViewerLayout, ViewerSizeState } from './viewerLayout.js';

export interface LogViewerOptions {
    readonly container: HTMLElement;
    readonly client: Client;
    readonly memorySink: MemorySink;
    readonly databaseSink?: DatabaseSink;
    readonly deviceInfo: DeviceInfo;
    readonly buildVersion: string;
    readonly logger: Logger;
    // Whether debug logging is on; the setting unless ?debug=1 turns it on for the page.
    readonly isDebugLogging?: () => boolean;
}

export interface LogViewer {
    open(): void;
    close(): void;
    toggle(): void;
    readonly isOpen: boolean;
    // Opens the viewer at the handshake timeline, e.g. from the pairing failure screen (DL-07).
    showTimeline(): void;
    dispose(): void;
}

// What survives closing and reopening the viewer, and rotating the device (DL-02).
interface ViewerState {
    filter: LogFilter;
    source: LogSource;
    size: ViewerSizeState;
    // Undefined until the user opens or closes the handshake section; the layout decides until then.
    diagnosticsOpen: boolean | undefined;
    maskIps: boolean;
}

interface ViewerView {
    readonly element: HTMLElement;
    showTimeline(): void;
    dispose(): void;
}

const ROOT_ATTRIBUTE = 'data-log-viewer';
const TIMELINE_CATEGORIES: readonly LogCategory[] = Object.freeze(['pair', 'ice', 'dtls']);
const TIMELINE_ENTRY_LIMIT = 2000;
const SEARCH_DELAY_MS = 150;
const STATUS_DURATION_MS = 3000;
const RESIZE_STEP = 24;

export function createLogViewer(options: LogViewerOptions): LogViewer {
    const state: ViewerState = {
        filter: DEFAULT_FILTER,
        source: 'live',
        size: DEFAULT_SIZE_STATE,
        diagnosticsOpen: undefined,
        maskIps: false,
    };
    let view: ViewerView | undefined;

    const open = (): void => {
        if (view != null) {
            return;
        }

        view = createViewerView({ options, state, onClose: () => close() });
        options.container.append(view.element);
        document.documentElement.setAttribute(ROOT_ATTRIBUTE, 'open');
    };

    // DL-11: a closed viewer leaves the page, stops its timers and drops its subscriptions.
    const close = (): void => {
        if (view == null) {
            return;
        }

        view.dispose();
        view.element.remove();
        view = undefined;
        const root = document.documentElement;
        root.removeAttribute(ROOT_ATTRIBUTE);
        root.style.removeProperty(PANEL_SIZE_PROPERTIES.logViewerInline);
        root.style.removeProperty(PANEL_SIZE_PROPERTIES.logViewerBlock);
    };

    return {
        open,
        close,
        toggle: () => (view == null ? open() : close()),
        get isOpen() {
            return view != null;
        },
        showTimeline: () => {
            open();
            view?.showTimeline();
        },
        dispose: close,
    };
}

function createViewerView(context: {
    readonly options: LogViewerOptions;
    readonly state: ViewerState;
    onClose(): void;
}): ViewerView {
    const { options, state } = context;
    const { client, memorySink, logger } = options;
    const isDebugLogging = options.isDebugLogging ?? ((): boolean => client.settings.debugLogging);
    const root = document.documentElement;
    const disposers: Array<() => void> = [];
    const expandedGroups = new Set<LogEntry>();
    let liveEntries = memorySink.entries();
    let pending: LogEntry[] = [];
    let filtered: LogEntry[] = [];
    let previousEntries: LogEntry[] | undefined;
    let timelineEntries = liveEntries.filter(isTimelineEntry).slice(-TIMELINE_ENTRY_LIMIT);
    let isTimelineDirty = true;
    let isFollowing = true;
    let wasAutoPaused = false;
    let layout: ViewerLayout = 'dock';
    let diagnostics: Diagnostics | undefined;
    let pairsError: string | undefined;
    let pollInterval = client.settings.statsIntervalMs;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeFrame: number | undefined;
    let dragPointer: number | undefined;
    const files = collectFiles(liveEntries);

    const peerNameOf = (entry: LogEntry): string | undefined => peerLabel(entry, client.peer);
    let matcher = createMatcher(state.filter, peerNameOf);
    const sourceEntries = (): readonly LogEntry[] => {
        return state.source === 'live' ? liveEntries : previousEntries ?? [];
    };

    const list = createLogList({
        peerName: peerNameOf,
        onToggleGroup: first => {
            if (!expandedGroups.delete(first)) {
                expandedGroups.add(first);
            }

            renderRows();
        },
        onUserScroll: atEnd => {
            // DL-04: scrolling up pauses auto-scroll; coming back to the end resumes it.
            if (!atEnd && isFollowing) {
                isFollowing = false;
                wasAutoPaused = true;
                updateFollowButton();
            }

            if (atEnd && !isFollowing && wasAutoPaused) {
                isFollowing = true;
                wasAutoPaused = false;
                updateFollowButton();
            }
        },
    });

    const status = h('span', { class: 'log-viewer-status' });
    const setStatus = (text: string): void => {
        status.textContent = text;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            status.textContent = '';
        }, STATUS_DURATION_MS);
    };

    const liveButton = h('button', {
        class: 'button button-small log-viewer-source',
        text: 'Live',
        attrs: { type: 'button' },
        on: { click: () => void switchSourceAsync('live') },
    });
    const previousButton = h('button', {
        class: 'button button-small log-viewer-source',
        text: 'Previous run',
        attrs: { type: 'button', hidden: options.databaseSink == null },
        on: { click: () => void switchSourceAsync('previous-run') },
    });
    const updateSourceButtons = (): void => {
        liveButton.setAttribute('aria-pressed', `${state.source === 'live'}`);
        previousButton.setAttribute('aria-pressed', `${state.source === 'previous-run'}`);
        clearButton.disabled = state.source !== 'live';
    };

    const toOption = (item: { readonly id: string; readonly label: string }) => ({ value: item.id, label: item.label });
    const categorySelect = createSelect('Category', CATEGORY_FILTERS.map(toOption));
    const levelSelect = createSelect('Level', LEVEL_FILTERS.map(toOption));
    const fileSelect = createSelect('File', [{ value: '', label: 'All files' }]);
    const searchInput = h('input', {
        class: 'log-viewer-search',
        attrs: { type: 'search', placeholder: 'Search', autocomplete: 'off', spellcheck: 'false' },
        aria: { label: 'Search logs' },
    });
    const followButton = h('button', {
        class: 'button button-small log-viewer-button',
        text: 'Auto-scroll',
        attrs: { type: 'button', title: 'Follow new lines' },
        on: { click: () => setFollowing(!isFollowing) },
    });
    const clearButton = h('button', {
        class: 'button button-small log-viewer-button',
        text: 'Clear',
        attrs: { type: 'button' },
        on: { click: () => clearEntries() },
    });
    const maskBox = h('input', { attrs: { type: 'checkbox' } });
    const exportMenu = h('details', {
        class: 'log-export',
        children: [
            h('summary', { class: 'button button-small log-export-toggle', text: 'Export' }),
            h('div', {
                class: 'log-export-menu',
                children: [
                    h('label', { class: 'log-export-option', children: [maskBox, 'Mask IP addresses'] }),
                    exportButton('Copy', () => void copyAsync()),
                    exportButton('Download .txt', () => download('txt')),
                    exportButton('Download .json', () => download('json')),
                ],
            }),
        ],
    });
    const toolbar = h('div', {
        class: 'log-viewer-toolbar',
        children: [categorySelect, levelSelect, fileSelect, searchInput, followButton, clearButton],
    });

    const header = h('header', {
        class: 'log-viewer-header',
        children: [
            h('h2', { class: 'log-viewer-title', text: 'Logs', attrs: { id: 'log-viewer-title' } }),
            h('div', {
                class: 'log-viewer-sources',
                attrs: { role: 'group' },
                aria: { label: 'Log source' },
                children: [liveButton, previousButton],
            }),
            status,
            exportMenu,
            h('button', {
                class: 'icon-button log-viewer-close',
                html: ICONS.close,
                attrs: { 'type': 'button', 'data-tooltip': 'Close log viewer' },
                aria: { label: 'Close log viewer' },
                on: { click: () => context.onClose() },
            }),
        ],
    });

    const outcome = h('span', { class: 'log-diagnostics-outcome' });
    const timelineHeading = h('h3', {
        class: 'log-diagnostics-heading',
        text: 'Timeline',
        attrs: { tabindex: '-1' },
    });
    const timelineHost = h('div', { class: 'log-timeline-host' });
    const pairsHeading = h('h3', { class: 'log-diagnostics-heading', text: 'Candidate pairs' });
    const pairsHost = h('div', { class: 'log-pairs-host' });
    const diagnosticsBlock = h('details', {
        class: 'log-diagnostics',
        children: [
            h('summary', {
                class: 'log-diagnostics-summary',
                children: [h('span', { class: 'log-diagnostics-title', text: 'Handshake' }), outcome],
            }),
            h('div', {
                class: 'log-diagnostics-body',
                children: [timelineHeading, timelineHost, pairsHeading, pairsHost],
            }),
        ],
    });
    diagnosticsBlock.addEventListener('toggle', () => {
        state.diagnosticsOpen = diagnosticsBlock.open;
    });

    const notice = h('p', { class: 'log-viewer-notice', attrs: { hidden: true } });
    const handle = h('div', {
        class: 'log-viewer-handle',
        attrs: { role: 'separator', tabindex: '0' },
        aria: { label: 'Resize log viewer' },
    });

    // DL-05: a labelled region; no aria-live, which would flood screen readers.
    const element = h('section', {
        class: 'log-viewer',
        aria: { labelledby: 'log-viewer-title' },
        children: [handle, header, toolbar, diagnosticsBlock, notice, list.element],
    });

    const renderTimelineNow = (): void => {
        isTimelineDirty = false;
        const timeline = buildTimeline(state.source === 'live' ? timelineEntries : previousEntries ?? []);
        outcome.textContent = timelineSummary(timeline);
        outcome.dataset.outcome = timeline.outcome;
        timelineHost.replaceChildren(renderTimeline(timeline));
    };

    const renderPairsNow = (): void => {
        const isLive = state.source === 'live';
        pairsHeading.hidden = !isLive;
        pairsHost.hidden = !isLive;
        pairsHost.replaceChildren(renderPairs({
            isPolling: poller.isRunning,
            ...(diagnostics == null ? {} : { diagnostics }),
            ...(pairsError == null ? {} : { error: pairsError }),
        }));
    };

    const updateNotice = (): void => {
        const parts = state.source === 'live' ? liveNotices() : previousNotices();
        notice.textContent = parts.join(' · ');
        notice.hidden = parts.length === 0;
    };

    const liveNotices = (): string[] => [
        memorySink.dropped > 0 ? `${memorySink.dropped.toLocaleString('en')} older entries dropped` : null,
        isDebugLogging() ? null : 'Debug logging is off: handshake steps, warnings and errors only',
    ].filter((part): part is string => part != null);

    const previousNotices = (): string[] => {
        const entries = previousEntries ?? [];
        const last = entries.at(-1);
        if (last == null) {
            return ['No previous run saved'];
        }

        const count = entries.length.toLocaleString('en');

        return [`Previous run: ${count} entries, last at ${new Date(last.wall).toLocaleString()}`];
    };

    const emptyText = (): string | undefined => {
        if (filtered.length > 0) {
            return undefined;
        }

        if (sourceEntries().length === 0) {
            return state.source === 'live' ? 'Nothing logged yet.' : 'No previous run saved.';
        }

        return 'No entries match the filters.';
    };

    const renderRows = (): void => {
        list.setRows(buildRows(filtered, { expandedGroups }));
        list.setEmptyText(emptyText());
        if (isFollowing) {
            list.scrollToEnd();
        } else {
            list.render();
        }

        updateNotice();
        if (isTimelineDirty) {
            renderTimelineNow();
        }
    };

    const refilter = (): void => {
        matcher = createMatcher(state.filter, peerNameOf);
        filtered = sourceEntries().filter(matcher);
        renderRows();
    };

    const updateFileOptions = (): void => {
        const current = state.filter.fileId;
        const options = [{ value: '', label: 'All files' }, ...[...files].map(([value, label]) => ({ value, label }))];
        const elements = options.map(option => h('option', { text: option.label, attrs: { value: option.value } }));
        fileSelect.replaceChildren(...elements);
        fileSelect.value = current;
    };

    // DL-10: entries queue up and are appended at most once per frame, 10 times a second.
    const flush = (): void => {
        if (pending.length > 0) {
            appendEntries(pending);
            pending = [];
        }

        renderRows();
    };

    const appendEntries = (added: readonly LogEntry[]): void => {
        const knownFiles = files.size;
        for (const entry of added) {
            liveEntries.push(entry);
            if (state.source === 'live' && matcher(entry)) {
                filtered.push(entry);
            }

            if (isTimelineEntry(entry)) {
                timelineEntries.push(entry);
                isTimelineDirty = true;
            }
        }

        collectFiles(added, files);
        if (files.size !== knownFiles) {
            updateFileOptions();
        }

        if (timelineEntries.length > TIMELINE_ENTRY_LIMIT) {
            timelineEntries = timelineEntries.slice(-TIMELINE_ENTRY_LIMIT);
        }

        const overflow = liveEntries.length - memorySink.capacity;
        if (overflow > 0) {
            const removed = liveEntries.splice(0, overflow);
            if (state.source === 'live') {
                filtered.splice(0, removed.filter(matcher).length);
            }

            list.forget(removed);
            for (const entry of removed) {
                expandedGroups.delete(entry);
            }
        }
    };

    const scheduler = createRenderScheduler({ render: flush });

    const poller = createStatsPoller({
        getDiagnosticsAsync: () => client.getDiagnosticsAsync(),
        intervalMs: () => client.settings.statsIntervalMs,
        onResult: result => {
            diagnostics = result;
            pairsError = undefined;
            renderPairsNow();
        },
        onError: error => {
            pairsError = 'Could not read connection stats.';
            logger.debug('pairs', 'stats poll failed', error);
            renderPairsNow();
        },
    });

    // DL-11: stats are polled only while the viewer is open and debug logging is on.
    const updatePolling = (): void => {
        const shouldPoll = isDebugLogging();
        const hasNewInterval = client.settings.statsIntervalMs !== pollInterval;
        pollInterval = client.settings.statsIntervalMs;
        if (shouldPoll && (!poller.isRunning || hasNewInterval)) {
            poller.start();
        }

        if (!shouldPoll && poller.isRunning) {
            poller.stop();
            diagnostics = undefined;
        }

        renderPairsNow();
    };

    const setFollowing = (isOn: boolean): void => {
        isFollowing = isOn;
        wasAutoPaused = false;
        updateFollowButton();
        if (isOn) {
            list.scrollToEnd();
        }
    };

    const updateFollowButton = (): void => {
        followButton.setAttribute('aria-pressed', `${isFollowing}`);
        followButton.textContent = isFollowing ? 'Auto-scroll' : 'Paused';
    };

    const clearEntries = (): void => {
        memorySink.clear();
        list.forget(liveEntries);
        liveEntries = [];
        pending = [];
        filtered = [];
        timelineEntries = [];
        expandedGroups.clear();
        isTimelineDirty = true;
        renderRows();
    };

    const switchSourceAsync = async (source: LogSource): Promise<void> => {
        if (source === 'previous-run' && previousEntries == null) {
            setStatus('Loading previous run…');
            try {
                previousEntries = (await options.databaseSink?.readPreviousRunAsync()) ?? [];
            } catch (error) {
                logger.warn('app', 'could not read the previous run', error);
                setStatus('Could not read the previous run.');

                return;
            }

            setStatus('');
        }

        state.source = source;
        isTimelineDirty = true;
        isFollowing = true;
        updateSourceButtons();
        updateFollowButton();
        refilter();
        renderPairsNow();
    };

    const exportText = (format: ExportFormat): string => buildExport(format, {
        entries: filtered,
        deviceInfo: options.deviceInfo,
        settings: client.settings,
        buildVersion: options.buildVersion,
        source: state.source,
        dropped: state.source === 'live' ? memorySink.dropped : 0,
        filter: isFilterActive(state.filter)
            ? describeFilter(state.filter, files.get(state.filter.fileId))
            : '',
        exportedAt: Date.now(),
        maskIps: state.maskIps,
        peerName: peerNameOf,
    });

    const copyAsync = async (): Promise<void> => {
        exportMenu.open = false;
        try {
            await navigator.clipboard.writeText(exportText('txt'));
            setStatus(`Copied ${filtered.length.toLocaleString('en')} lines`);
        } catch (error) {
            logger.warn('app', 'copying logs failed', error);
            setStatus('Copy failed');
        }
    };

    const download = (format: ExportFormat): void => {
        exportMenu.open = false;
        downloadText(exportFileName(format, new Date()), exportText(format), exportMimeType(format));
        setStatus(`Saved ${filtered.length.toLocaleString('en')} lines`);
    };

    const applyLayout = (): void => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        layout = resolveViewerLayout(viewport);
        const size = panelSize(layout, viewport, state.size);
        element.dataset.layout = layout;
        element.style.inlineSize = layout === 'drawer' ? '' : `${size.inline}px`;
        element.style.blockSize = layout === 'drawer' ? `${size.block}px` : '';
        root.style.setProperty(PANEL_SIZE_PROPERTIES.logViewerInline, `${size.inline}px`);
        root.style.setProperty(PANEL_SIZE_PROPERTIES.logViewerBlock, `${size.block}px`);
        const isDrawer = layout === 'drawer';
        const clamp = (value: number): number => (isDrawer
            ? clampDrawerHeight(value, viewport.height)
            : clampDockWidth(value, viewport.width));
        handle.hidden = layout === 'side';
        handle.setAttribute('aria-orientation', isDrawer ? 'horizontal' : 'vertical');
        handle.setAttribute('aria-valuenow', `${isDrawer ? size.block : size.inline}`);
        handle.setAttribute('aria-valuemin', `${clamp(0)}`);
        handle.setAttribute('aria-valuemax', `${clamp(Number.POSITIVE_INFINITY)}`);
        diagnosticsBlock.open = state.diagnosticsOpen ?? layout === 'dock';
        if (isFollowing) {
            list.scrollToEnd();
        } else {
            list.render();
        }
    };

    const resizeTo = (pixels: number): void => {
        if (layout === 'drawer') {
            const height = clampDrawerHeight(pixels, window.innerHeight);
            state.size = { ...state.size, drawerFraction: height / window.innerHeight };
        }

        if (layout === 'dock') {
            state.size = { ...state.size, dockWidth: clampDockWidth(pixels, window.innerWidth) };
        }

        applyLayout();
    };

    const currentSize = (): number => (layout === 'drawer' ? element.offsetHeight : element.offsetWidth);

    handle.addEventListener('pointerdown', event => {
        if (layout === 'side') {
            return;
        }

        dragPointer = event.pointerId;
        handle.setPointerCapture(event.pointerId);
        element.dataset.resizing = 'true';
        event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
        if (dragPointer !== event.pointerId) {
            return;
        }

        resizeTo(layout === 'drawer' ? window.innerHeight - event.clientY : window.innerWidth - event.clientX);
    });
    const endDrag = (event: PointerEvent): void => {
        if (dragPointer !== event.pointerId) {
            return;
        }

        dragPointer = undefined;
        delete element.dataset.resizing;
        if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId);
        }
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('keydown', event => {
        const step = RESIZE_KEYS[layout]?.[event.key];
        if (step == null) {
            return;
        }

        event.preventDefault();
        resizeTo(currentSize() + step * RESIZE_STEP);
    });

    const onWindowResize = (): void => {
        if (resizeFrame != null) {
            return;
        }

        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = undefined;
            applyLayout();
        });
    };
    window.addEventListener('resize', onWindowResize);

    element.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }

        if (exportMenu.open) {
            exportMenu.open = false;

            return;
        }

        context.onClose();
    });

    categorySelect.addEventListener('change', () => {
        state.filter = { ...state.filter, category: categorySelect.value };
        refilter();
    });
    levelSelect.addEventListener('change', () => {
        state.filter = { ...state.filter, level: levelSelect.value as LogFilter['level'] };
        refilter();
    });
    fileSelect.addEventListener('change', () => {
        state.filter = { ...state.filter, fileId: fileSelect.value };
        refilter();
    });
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.filter = { ...state.filter, text: searchInput.value };
            refilter();
        }, SEARCH_DELAY_MS);
    });
    maskBox.addEventListener('change', () => {
        state.maskIps = maskBox.checked;
    });

    disposers.push(memorySink.subscribe(entry => {
        pending.push(entry);
        // A hidden tab gets no animation frames; keep the queue bounded by what the sink itself keeps.
        if (pending.length > memorySink.capacity * 2) {
            pending.splice(0, pending.length - memorySink.capacity);
        }

        scheduler.schedule();
    }));
    disposers.push(client.on('settings', () => {
        updatePolling();
        updateNotice();
    }));
    disposers.push(client.on('peer', () => list.render()));

    categorySelect.value = state.filter.category;
    levelSelect.value = state.filter.level;
    searchInput.value = state.filter.text;
    maskBox.checked = state.maskIps;
    updateFileOptions();
    updateSourceButtons();
    updateFollowButton();
    filtered = sourceEntries().filter(matcher);
    applyLayout();
    renderRows();
    updatePolling();

    return {
        element,
        showTimeline: () => {
            state.diagnosticsOpen = true;
            diagnosticsBlock.open = true;
            const failed = timelineHost.querySelector<HTMLElement>('.timeline-step[data-status="failed"]');
            (failed ?? timelineHeading).scrollIntoView({ block: 'nearest' });
            timelineHeading.focus({ preventScroll: true });
        },
        dispose: () => {
            for (const dispose of disposers) {
                dispose();
            }

            scheduler.cancel();
            poller.stop();
            list.dispose();
            clearTimeout(statusTimer);
            clearTimeout(searchTimer);
            if (resizeFrame != null) {
                cancelAnimationFrame(resizeFrame);
            }

            window.removeEventListener('resize', onWindowResize);
        },
    };
}

// Arrow keys on the resize handle: the drawer grows upwards, the dock grows to the left.
const RESIZE_KEYS: Readonly<Partial<Record<ViewerLayout, Readonly<Record<string, number>>>>> = Object.freeze({
    drawer: { ArrowUp: 1, ArrowDown: -1 },
    dock: { ArrowLeft: 1, ArrowRight: -1 },
});

function isTimelineEntry(entry: LogEntry): boolean {
    return entry.peer == null && TIMELINE_CATEGORIES.includes(entry.cat);
}

function createSelect(
    label: string,
    options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
): HTMLSelectElement {
    return h('select', {
        class: 'log-viewer-select',
        aria: { label },
        children: options.map(option => h('option', { text: option.label, attrs: { value: option.value } })),
    });
}

function exportButton(text: string, onClick: () => void): HTMLButtonElement {
    return h('button', {
        class: 'button button-small button-quiet log-export-action',
        text,
        attrs: { type: 'button' },
        on: { click: onClick },
    });
}
