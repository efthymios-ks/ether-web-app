import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { formatCount } from '../format.js';
import { ICONS } from '../icons.js';
import type { Selection } from './gallerySelection.js';

// GL-03, shared by the Sent and Received tabs in every view so they select and unselect the same way:
// the toolbar's Select icon turns selecting on and off, headers offer Select day ↔ Unselect day (or month, year)
// while selecting, and the sticky bar reads "N selected · Select all · Range · ZIP (N) · Delete".
// Range (tap the first and the last) and Shift-click give the range the first item's new state.

export interface SelectionControlsOptions {
    readonly context: AppContext;
    readonly selection: Selection;
    // The items on screen, in order, under the current search and filter.
    readonly orderedIds: () => readonly string[];
    // The selected items Download ZIP takes.
    readonly zippableIds: () => readonly string[];
    readonly onSelectingChange: (isSelecting: boolean) => void;
    readonly onZip: () => void;
    // What a group header selects ('day', 'month' or 'year'), and the header's name for a group key.
    readonly groupNoun: () => string;
    readonly groupLabel: (key: string) => string;
}

export interface SelectionControls {
    readonly isSelecting: boolean;
    // The toolbar's Select toggle.
    readonly selectButton: HTMLButtonElement;
    readonly selectAll: HTMLButtonElement;
    readonly range: HTMLButtonElement;
    readonly count: HTMLElement;
    readonly zip: HTMLButtonElement;
    setSelecting(isOn: boolean): void;
    // A tap or click on an item: a range after Shift or after Range's first tap, otherwise a toggle.
    pick(fileId: string, isShift: boolean): void;
    // A group header's Select day ↔ Unselect day (or month, year), shown while selecting.
    groupButton(key: string, ids: readonly string[]): HTMLButtonElement;
    // Brings the labels, the count and the group buttons in `root` up to date.
    sync(root: ParentNode, idsByGroup: ReadonlyMap<string, readonly string[]>): void;
}

export function isAllSelected(selection: Selection, ids: readonly string[]): boolean {
    return ids.length > 0 && ids.every(id => selection.has(id));
}

// Words for screen readers that the icons or a shorter label stand for on screen.
export function hiddenText(text: string): HTMLElement {
    return h('span', { class: 'files-sr-only', text });
}

export function createSelectionControls(options: SelectionControlsOptions): SelectionControls {
    const { selection } = options;
    let isSelecting = false;
    let isRangeMode = false;
    // Range by taps: the first tap sets the anchor, the second applies its state to the range.
    let hasRangeStart = false;

    const setRangeMode = (isOn: boolean): void => {
        isRangeMode = isOn;
        hasRangeStart = false;
        range.setAttribute('aria-pressed', String(isOn));
    };

    const setSelecting = (isOn: boolean): void => {
        isSelecting = isOn;
        selectButton.setAttribute('aria-pressed', String(isOn));
        if (!isOn) {
            selection.clear();
            setRangeMode(false);
        }

        options.onSelectingChange(isOn);
    };

    const selectButton = h('button', {
        class: 'icon-button files-tool',
        dataset: { action: 'select', tooltip: 'Select' },
        attrs: { 'type': 'button', 'aria-pressed': 'false' },
        children: [h('span', { class: 'button-icon', html: ICONS.select }), hiddenText('Select')],
        on: { click: () => setSelecting(!isSelecting) },
    });
    const selectAll = h('button', {
        class: 'button button-small',
        text: 'Select all',
        dataset: { action: 'select-all' },
        attrs: { type: 'button' },
        on: {
            click: () => {
                const ids = options.orderedIds();
                selection.setMany(ids, !isAllSelected(selection, ids));
            },
        },
    });
    const range = h('button', {
        class: 'button button-small',
        text: 'Range',
        dataset: { action: 'range' },
        attrs: { 'type': 'button', 'aria-pressed': 'false', 'data-tooltip': 'Tap the first and the last item' },
        on: {
            click: () => {
                setRangeMode(!isRangeMode);
                if (isRangeMode) {
                    options.context.dialogs.toast('Tap the first and the last item.');
                }
            },
        },
    });
    const count = h('span', { class: 'selection-count', attrs: { 'aria-live': 'polite' } });
    // "ZIP (N)" on screen, "Download ZIP (N)" for screen readers.
    const zipLabel = h('span', { text: 'ZIP' });
    const zip = h('button', {
        class: 'button button-small button-primary',
        dataset: { action: 'download-zip' },
        attrs: { type: 'button' },
        children: [h('span', { class: 'button-icon', html: ICONS.download }), hiddenText('Download '), zipLabel],
        on: { click: () => options.onZip() },
    });

    const syncGroupButton = (button: HTMLButtonElement, key: string, ids: readonly string[]): void => {
        const label = `${isSelecting && isAllSelected(selection, ids) ? 'Unselect' : 'Select'} ${options.groupNoun()}`;
        if (button.textContent !== label) {
            button.textContent = label;
        }

        button.setAttribute('aria-label', `${label}: ${options.groupLabel(key)}`);
        button.hidden = !isSelecting;
    };

    return {
        get isSelecting() {
            return isSelecting;
        },
        selectButton,
        selectAll,
        range,
        count,
        zip,
        setSelecting,
        pick: (fileId, isShift) => {
            if (!isSelecting) {
                setSelecting(true);
            }

            const ordered = options.orderedIds();
            if (isShift && selection.anchor != null) {
                selection.applyRange(ordered, fileId);

                return;
            }

            if (isRangeMode && hasRangeStart) {
                selection.applyRange(ordered, fileId);
                setRangeMode(false);

                return;
            }

            selection.toggle(fileId);
            hasRangeStart = isRangeMode;
        },
        groupButton: (key, ids) => {
            const button = h('button', {
                class: 'files-link',
                dataset: { action: 'select-group', group: key },
                attrs: { type: 'button' },
                on: {
                    click: () => {
                        // Select day selects the rest of a partly selected day; a fully selected day offers Unselect day.
                        const isUnselect = isSelecting && isAllSelected(selection, ids);
                        if (!isSelecting) {
                            setSelecting(true);
                        }

                        selection.setMany(ids, !isUnselect);
                    },
                },
            });
            syncGroupButton(button, key, ids);

            return button;
        },
        sync: (root, idsByGroup) => {
            const ids = options.orderedIds();
            const isEverything = isAllSelected(selection, ids);
            count.textContent = `${selection.size.toLocaleString('en')} selected`;
            selectAll.textContent = isEverything ? 'Unselect all' : 'Select all';
            const allLabel = `${isEverything ? 'Unselect' : 'Select'} all ${formatCount(ids.length, 'item')}`;
            selectAll.setAttribute('aria-label', allLabel);
            for (const button of root.querySelectorAll<HTMLButtonElement>('[data-action="select-group"]')) {
                const key = button.dataset.group ?? '';
                syncGroupButton(button, key, idsByGroup.get(key) ?? []);
            }

            const zipCount = options.zippableIds().length;
            zipLabel.textContent = zipCount === 0 ? 'ZIP' : `ZIP (${zipCount.toLocaleString('en')})`;
            zip.disabled = zipCount === 0;
        },
    };
}
