import type { LogEntry } from '../../core/logger.js';
import { h } from '../dom.js';
import { entryDetails, lineParts, safeStringify, tokenizeJson } from './logFormat.js';
import type { LogRow } from './pageCollapse.js';
import { computeWindow, indexAtOffset, rowOffset, totalHeight } from './virtualWindow.js';
import type { ExtraHeight } from './virtualWindow.js';

export interface LogListOptions {
    peerName(entry: LogEntry): string | undefined;
    // A "+87 pages" row was clicked; the viewer re-groups the rows.
    onToggleGroup(first: LogEntry): void;
    // The user scrolled the list (not the viewer); atEnd is true at the newest line.
    onUserScroll(atEnd: boolean): void;
}

export interface LogList {
    readonly element: HTMLElement;
    setRows(rows: readonly LogRow[]): void;
    setEmptyText(text: string | undefined): void;
    render(): void;
    scrollToEnd(): void;
    isAtEnd(): boolean;
    firstVisibleIndex(): number;
    scrollToIndex(index: number): void;
    // Drops expanded state for entries that left the buffer.
    forget(entries: readonly LogEntry[]): void;
    dispose(): void;
}

const FALLBACK_ROW_HEIGHT = 18;
const FALLBACK_VIEWPORT_HEIGHT = 600;
const END_TOLERANCE = 8;
const TIME_WIDTH = 7;
const CATEGORY_WIDTH = 6;
const LEVEL_WIDTH = 5;

// DL-03, DL-10: a virtualised, monospace list, one line per entry, horizontally scrollable.
export function createLogList(options: LogListOptions): LogList {
    let rows: readonly LogRow[] = [];
    let rowHeight = FALLBACK_ROW_HEIGHT;
    let expectedScrollTop: number | undefined;
    let frame: number | undefined;
    let focusIndex: number | undefined;
    const expanded = new Set<LogEntry>();
    const extraHeights = new Map<LogEntry, number>();

    const windowElement = h('div', { class: 'log-list-window' });
    const spacer = h('div', { class: 'log-list-spacer', children: [windowElement] });
    const scroller = h('div', {
        class: 'log-list',
        attrs: { 'role': 'list', 'aria-label': 'Log entries', 'tabindex': '0' },
        children: [spacer],
    });
    const empty = h('p', { class: 'log-list-empty', attrs: { hidden: true } });
    const element = h('div', { class: 'log-list-frame', children: [scroller, empty] });

    const extras = (): ExtraHeight[] => {
        if (expanded.size === 0) {
            return [];
        }

        const result: ExtraHeight[] = [];
        rows.forEach((row, index) => {
            if (row.kind === 'entry' && expanded.has(row.entry)) {
                result.push({ index, extra: extraHeights.get(row.entry) ?? 0 });
            }
        });

        return result;
    };

    const viewportHeight = (): number => {
        const height = scroller.clientHeight;

        return height > 0 ? height : FALLBACK_VIEWPORT_HEIGHT;
    };

    const renderNow = (isMeasuring = false): void => {
        frame = undefined;
        const rowExtras = extras();
        const range = computeWindow({
            scrollTop: scroller.scrollTop,
            viewportHeight: viewportHeight(),
            rowHeight,
            count: rows.length,
            extras: rowExtras,
        });
        spacer.style.blockSize = `${range.totalHeight}px`;
        windowElement.style.transform = `translateY(${range.offset}px)`;

        const fragment = document.createDocumentFragment();
        for (let index = range.start; index < range.end; index++) {
            const row = rows[index];
            if (row != null) {
                fragment.append(renderRow(row, index));
            }
        }

        windowElement.replaceChildren(fragment);
        restoreFocus();
        if (!isMeasuring && measure()) {
            renderNow(true);
        }
    };

    const scheduleRender = (): void => {
        if (frame != null) {
            return;
        }

        frame = globalThis.requestAnimationFrame(() => renderNow());
    };

    // Reads the real line height (it scales with the text size) and the height of expanded lines.
    const measure = (): boolean => {
        let hasChanged = false;
        const plain = windowElement.querySelector<HTMLElement>('.log-row:not([data-expanded="true"])');
        const measured = plain?.offsetHeight ?? 0;
        if (measured > 0 && measured !== rowHeight) {
            rowHeight = measured;
            hasChanged = true;
        }

        const expandedRows = windowElement.querySelectorAll<HTMLElement>('.log-row[data-expanded="true"]');
        for (const rowElement of expandedRows) {
            const row = rows[Number(rowElement.dataset.index)];
            const extra = Math.max(0, rowElement.offsetHeight - rowHeight);
            if (row?.kind === 'entry' && rowElement.offsetHeight > 0 && extraHeights.get(row.entry) !== extra) {
                extraHeights.set(row.entry, extra);
                hasChanged = true;
            }
        }

        return hasChanged;
    };

    const restoreFocus = (): void => {
        if (focusIndex == null) {
            return;
        }

        const line = windowElement.querySelector<HTMLElement>(`.log-row[data-index="${focusIndex}"] .log-line`);
        focusIndex = undefined;
        line?.focus({ preventScroll: true });
    };

    const renderRow = (row: LogRow, index: number): HTMLElement => {
        const position = {
            'role': 'listitem',
            'aria-posinset': `${index + 1}`,
            'aria-setsize': `${rows.length}`,
        };
        if (row.kind === 'pages') {
            const parts = lineParts(row.first);

            return h('div', {
                class: 'log-row',
                dataset: { index: `${index}`, kind: 'pages', level: 'debug' },
                attrs: position,
                children: [
                    h('button', {
                        class: 'log-line',
                        attrs: { 'type': 'button', 'aria-expanded': 'false', 'title': 'Show every page line' },
                        children: [
                            ...lineHead(parts.time, 'xfer', 'debug'),
                            h('span', { class: 'log-msg log-pages', text: `+${row.entries.length} pages` }),
                        ],
                    }),
                ],
            });
        }

        const entry = row.entry;
        const isExpanded = expanded.has(entry);
        const parts = lineParts(entry, options.peerName(entry));

        return h('div', {
            class: 'log-row',
            dataset: {
                index: `${index}`,
                kind: 'entry',
                level: entry.level,
                expanded: `${isExpanded}`,
                ...(parts.peer == null ? {} : { peer: 'true' }),
            },
            attrs: position,
            children: [
                h('button', {
                    class: 'log-line',
                    attrs: { 'type': 'button', 'aria-expanded': `${isExpanded}` },
                    children: [
                        ...lineHead(parts.time, parts.cat, parts.level),
                        parts.peer == null ? null : h('span', { class: 'log-peer', text: `[${parts.peer}]` }),
                        parts.peer == null ? null : ' ',
                        h('span', { class: 'log-msg', text: parts.msg }),
                        parts.hasData ? h('span', { class: 'log-data-mark', text: ' {…}' }) : null,
                    ],
                }),
                isExpanded ? renderJson(entryDetails(entry)) : null,
            ],
        });
    };

    scroller.addEventListener('click', event => {
        const target = event.target as Element | null;
        const line = target?.closest<HTMLElement>('.log-line');
        const rowElement = line?.closest<HTMLElement>('.log-row');
        if (!rowElement) {
            return;
        }

        const index = Number(rowElement.dataset.index);
        const row = rows[index];
        if (row == null) {
            return;
        }

        focusIndex = index;
        if (row.kind === 'pages') {
            options.onToggleGroup(row.first);

            return;
        }

        if (expanded.has(row.entry)) {
            expanded.delete(row.entry);
            extraHeights.delete(row.entry);
        } else {
            expanded.add(row.entry);
        }

        renderNow();
    });

    scroller.addEventListener('scroll', () => {
        const isProgrammatic = expectedScrollTop != null
            && Math.abs(scroller.scrollTop - expectedScrollTop) < 2;
        expectedScrollTop = undefined;
        // A scroll the list made itself was already rendered at its new position.
        if (isProgrammatic) {
            return;
        }

        options.onUserScroll(isAtEnd());
        scheduleRender();
    }, { passive: true });

    const isAtEnd = (): boolean => {
        return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - END_TOLERANCE;
    };

    const scrollTo = (top: number): void => {
        const clamped = Math.max(0, Math.round(top));
        if (Math.abs(scroller.scrollTop - clamped) >= 1) {
            expectedScrollTop = clamped;
            scroller.scrollTop = clamped;
        }

        renderNow();
    };

    return {
        element,
        setRows: next => {
            rows = next;
            spacer.style.blockSize = `${totalHeight(rows.length, rowHeight, extras())}px`;
        },
        setEmptyText: text => {
            empty.textContent = text ?? '';
            empty.hidden = text == null;
        },
        render: () => renderNow(),
        scrollToEnd: () => {
            const total = totalHeight(rows.length, rowHeight, extras());
            scrollTo(total - viewportHeight());
        },
        isAtEnd,
        firstVisibleIndex: () => indexAtOffset(scroller.scrollTop, rowHeight, rows.length, extras()),
        scrollToIndex: index => scrollTo(rowOffset(index, rowHeight, extras())),
        forget: entries => {
            for (const entry of entries) {
                expanded.delete(entry);
                extraHeights.delete(entry);
            }
        },
        dispose: () => {
            if (frame != null) {
                globalThis.cancelAnimationFrame(frame);
                frame = undefined;
            }
        },
    };
}

function lineHead(time: string, category: string, level: string): Array<HTMLElement | string> {
    return [
        h('span', { class: 'log-time', text: time.padEnd(TIME_WIDTH) }),
        ' ',
        h('span', { class: 'log-cat', dataset: { cat: category }, text: category.padEnd(CATEGORY_WIDTH) }),
        ' ',
        h('span', { class: 'log-level', dataset: { level }, text: level.padEnd(LEVEL_WIDTH) }),
        ' ',
    ];
}

const JSON_CLASSES = Object.freeze({
    key: 'json-key',
    string: 'json-string',
    number: 'json-number',
    boolean: 'json-boolean',
    null: 'json-null',
    punct: 'json-punct',
});

function renderJson(value: unknown): HTMLElement {
    const tokens = tokenizeJson(safeStringify(value, 2));

    return h('pre', {
        class: 'log-json',
        children: tokens.map(token => (token.kind === 'space'
            ? token.text
            : h('span', { class: JSON_CLASSES[token.kind], text: token.text }))),
    });
}
