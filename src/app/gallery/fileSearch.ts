import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import { createDebounce } from '../throttle.js';

// The search field of the Sent and Received toolbars, and its matching: every word of the search must appear
// in the file's name or folder path, in any order, regardless of case and accents. Greek is read without its
// tonos and dialytika and with final sigma as sigma, so "αθηναι" finds "Αθηναίισσα.mp3".

// Typing waits this long for a pause before the list follows.
export const SEARCH_DELAY_MS = 150;

const COMBINING_MARKS = /\p{M}/gu;

export function normalizeForSearch(text: string): string {
    return text
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .toLowerCase()
        .replaceAll('ς', 'σ');
}

// The search's words, normalised; none at all matches everything.
export function searchWords(query: string): string[] {
    return normalizeForSearch(query)
        .split(/\s+/)
        .filter(word => word.length > 0);
}

export function matchesSearch(words: readonly string[], texts: ReadonlyArray<string | undefined>): boolean {
    if (words.length === 0) {
        return true;
    }

    const normalized = texts.flatMap(text => (text == null ? [] : [normalizeForSearch(text)]));

    return words.every(word => normalized.some(text => text.includes(word)));
}

export interface SearchFieldOptions {
    // After a pause in typing, and at once when the field is cleared.
    readonly onChange: () => void;
}

export interface SearchField {
    readonly element: HTMLElement;
    // The text the list follows, which trails typing by SEARCH_DELAY_MS.
    readonly query: string;
    clear(): void;
    focus(): void;
    dispose(): void;
}

export function createSearchField(options: SearchFieldOptions): SearchField {
    let query = '';
    const input = h('input', {
        class: 'files-search-input',
        attrs: {
            'type': 'search',
            'aria-label': 'Search files',
            'placeholder': 'Search',
            'autocomplete': 'off',
            'autocapitalize': 'off',
            'spellcheck': 'false',
            'enterkeyhint': 'search',
        },
    });
    const cross = h('button', {
        class: 'files-search-clear',
        html: ICONS.close,
        dataset: { action: 'clear-search' },
        attrs: { 'type': 'button', 'aria-label': 'Clear search', 'hidden': true },
    });
    const element = h('div', {
        class: 'files-search',
        children: [h('span', { class: 'files-search-icon', html: ICONS.search }), input, cross],
    });

    const apply = (): void => {
        if (input.value === query) {
            return;
        }

        query = input.value;
        options.onChange();
    };
    const debounce = createDebounce(apply, SEARCH_DELAY_MS);

    const clear = (): void => {
        input.value = '';
        cross.hidden = true;
        debounce.cancel();
        apply();
    };

    input.addEventListener('input', () => {
        cross.hidden = input.value.length === 0;
        debounce.schedule();
    });
    // Escape empties a field with text and goes no further, so it doesn't also clear the selection.
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            debounce.flush();

            return;
        }

        if (event.key !== 'Escape' || input.value.length === 0) {
            return;
        }

        event.preventDefault();
        clear();
    });
    cross.addEventListener('click', () => {
        clear();
        input.focus();
    });

    return {
        element,
        get query() {
            return query;
        },
        clear,
        focus: () => input.focus(),
        dispose: () => debounce.cancel(),
    };
}
