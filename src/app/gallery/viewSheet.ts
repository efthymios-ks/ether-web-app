import type { Direction } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { STATUS_CHOICES, TYPE_CHOICES } from './fileFilter.js';
import type { FileFilter, FilterChoice, FilterStatus, FilterType } from './fileFilter.js';
import { openFilesSheet } from './filesSheet.js';
import type { FilesSheet } from './filesSheet.js';

// The View & filter sheet behind the toolbar's one button: Group by Day | Month | Year, Show as List | Tiles,
// and the Type and Status boxes (the side's own statuses). Every change applies at once behind the sheet; Clear filters
// unchecks the boxes and Done closes it.

export type FilesView = 'list' | 'tiles';
export type FilesGroupBy = 'day' | 'month' | 'year';

export interface ViewSheetOptions {
    readonly context: AppContext;
    readonly direction: Direction;
    readonly view: FilesView;
    readonly groupBy: FilesGroupBy;
    readonly filter: FileFilter;
    readonly onView: (view: FilesView) => void;
    readonly onGroupBy: (groupBy: FilesGroupBy) => void;
    readonly onFilter: (filter: FileFilter) => void;
}

interface Segment<T extends string> {
    readonly id: T;
    readonly label: string;
}

// A small segmented control with aria-pressed.
function createSegmented<T extends string>(
    label: string,
    segments: ReadonlyArray<Segment<T>>,
    value: T,
    onChange: (next: T) => void,
): HTMLElement {
    const buttons = segments.map(segment => h('button', {
        class: 'segment',
        text: segment.label,
        dataset: { choice: segment.id },
        attrs: { 'type': 'button', 'aria-pressed': String(segment.id === value) },
        on: {
            click: () => {
                for (const button of buttons) {
                    button.setAttribute('aria-pressed', String(button.dataset.choice === segment.id));
                }

                onChange(segment.id);
            },
        },
    }));

    return h('div', { class: 'segmented', attrs: { 'role': 'group', 'aria-label': label }, children: buttons });
}

function field(label: string, control: HTMLElement): HTMLElement {
    return h('div', {
        class: 'files-sheet-field',
        children: [h('span', { class: 'files-sheet-label', text: label, attrs: { 'aria-hidden': 'true' } }), control],
    });
}

export function openViewSheet(options: ViewSheetOptions): FilesSheet {
    const types = new Set<FilterType>(options.filter.types);
    const statuses = new Set<FilterStatus>(options.filter.statuses);
    const boxes: HTMLInputElement[] = [];
    const clear = h('button', {
        class: 'button',
        text: 'Clear filters',
        dataset: { action: 'clear-filters' },
        attrs: { type: 'button' },
    });

    const changed = (): void => {
        clear.disabled = types.size + statuses.size === 0;
        options.onFilter({ types: new Set(types), statuses: new Set(statuses) });
    };

    const checks = <Id extends string>(
        legend: string,
        choices: ReadonlyArray<FilterChoice<Id>>,
        chosen: Set<Id>,
    ): HTMLElement => h('fieldset', {
        class: 'files-sheet-field files-sheet-checks',
        children: [
            h('legend', { class: 'files-sheet-label', text: legend }),
            ...choices.map(choice => {
                const box = h('input', { attrs: { type: 'checkbox', value: choice.id } });
                box.checked = chosen.has(choice.id);
                box.addEventListener('change', () => {
                    if (box.checked) {
                        chosen.add(choice.id);
                    } else {
                        chosen.delete(choice.id);
                    }

                    changed();
                });
                boxes.push(box);

                return h('label', { class: 'filter-option', children: [box, h('span', { text: choice.label })] });
            }),
        ],
    });

    clear.addEventListener('click', () => {
        types.clear();
        statuses.clear();
        for (const box of boxes) {
            box.checked = false;
        }

        changed();
        boxes[0]?.focus();
    });
    clear.disabled = types.size + statuses.size === 0;
    const done = h('button', {
        class: 'button button-primary',
        text: 'Done',
        dataset: { action: 'done' },
        attrs: { type: 'button' },
    });
    const sheet = openFilesSheet({
        context: options.context,
        title: 'View & filter',
        className: 'files-view-sheet',
        children: [
            field('Group by', createSegmented<FilesGroupBy>('Group by', [
                { id: 'day', label: 'Day' },
                { id: 'month', label: 'Month' },
                { id: 'year', label: 'Year' },
            ], options.groupBy, options.onGroupBy)),
            field('Show as', createSegmented<FilesView>('Show as', [
                { id: 'list', label: 'List' },
                { id: 'tiles', label: 'Tiles' },
            ], options.view, options.onView)),
            checks('Type', TYPE_CHOICES, types),
            checks('Status', STATUS_CHOICES[options.direction], statuses),
            h('div', { class: 'files-sheet-actions', children: [clear, done] }),
        ],
    });
    done.addEventListener('click', () => sheet.close());

    return sheet;
}
