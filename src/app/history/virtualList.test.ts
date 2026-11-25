import { afterEach, describe, expect, it } from 'vitest';
import { createVirtualList } from './virtualList.js';
import type { VirtualList } from './virtualList.js';

// The reader's place: rows added above what they look at don't move it, and rows added below move nothing.

interface Row {
    readonly id: string;
}

const ROW_HEIGHT = 50;
// The list starts this far into the scroller's content, e.g. under the connection card and the tabs.
const LIST_OFFSET = 100;

let list: VirtualList<Row> | undefined;

function rows(ids: readonly string[]): Row[] {
    return ids.map(id => ({ id }));
}

// A scroller whose geometry the test controls, since the test DOM has no layout.
function setUp(): { scroller: HTMLElement; list: VirtualList<Row> } {
    const scroller = document.createElement('div');
    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTop, set: (value: number) => (scrollTop = value), configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { get: () => 400, configurable: true });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400);
    document.body.append(scroller);
    list = createVirtualList<Row>({
        scroller,
        rowHeight: () => ROW_HEIGHT,
        renderRow: row => Object.assign(document.createElement('div'), { textContent: row.id }),
    });
    const element = list.element;
    element.getBoundingClientRect = () => new DOMRect(0, LIST_OFFSET - scroller.scrollTop, 400, 0);
    scroller.append(element);

    return { scroller, list };
}

const keyOf = (row: Row): string => row.id;
const hasKey = (row: Row, key: string): boolean => row.id === key;

describe('keeping the reader’s place', () => {
    afterEach(() => {
        list?.dispose();
        list = undefined;
        document.body.replaceChildren();
    });

    it('keeps the row the reader looks at in the same spot when rows are added above it', () => {
        // Arrange
        const { scroller, list: virtual } = setUp();
        virtual.setRows(rows(['a', 'b', 'c', 'd', 'e', 'f']));
        scroller.scrollTop = LIST_OFFSET + 3 * ROW_HEIGHT + 10;
        const place = virtual.place(keyOf);

        // Act
        virtual.setRows(rows(['new-1', 'new-2', 'a', 'b', 'c', 'd', 'e', 'f']));
        if (place != null) {
            virtual.restorePlace(place, hasKey);
        }

        // Assert
        expect(place).toEqual({ key: 'd', offset: -10 });
        expect(scroller.scrollTop).toBe(LIST_OFFSET + 5 * ROW_HEIGHT + 10);
        expect(virtual.place(keyOf)).toEqual(place);
    });

    it('moves nothing when rows are added below, or while the list’s own top is still in view', () => {
        // Arrange
        const { scroller, list: virtual } = setUp();
        virtual.setRows(rows(['a', 'b', 'c', 'd']));
        scroller.scrollTop = LIST_OFFSET + ROW_HEIGHT;
        const inside = virtual.place(keyOf);
        scroller.scrollTop = 40;
        const above = virtual.place(keyOf);

        // Act
        virtual.setRows(rows(['a', 'b', 'c', 'd', 'e', 'f']));
        scroller.scrollTop = LIST_OFFSET + ROW_HEIGHT;
        if (inside != null) {
            virtual.restorePlace(inside, hasKey);
        }

        // Assert
        expect(above).toBeUndefined();
        expect(scroller.scrollTop).toBe(LIST_OFFSET + ROW_HEIGHT);
    });
});
