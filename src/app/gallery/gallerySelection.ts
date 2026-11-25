// GL-03: tap to select or unselect, a range from the last tapped item to this one (tap first and last, or
// Shift-click) that takes that item's state, a whole day, or everything; unselecting is as easy as selecting.

export interface Selection {
    readonly size: number;
    readonly anchor: string | undefined;
    has(fileId: string): boolean;
    ids(): string[];
    toggle(fileId: string): void;
    // Gives every item between the anchor and `fileId` in `orderedIds`, both included, the anchor's state:
    // a range from a selected item selects, a range from an unselected one unselects.
    applyRange(orderedIds: readonly string[], fileId: string): void;
    setMany(fileIds: readonly string[], isSelected: boolean): void;
    // Keeps only ids that still exist, e.g. after a filter or a delete.
    retain(fileIds: readonly string[]): void;
    clear(): void;
    onChange(handler: () => void): () => void;
}

export function createSelection(): Selection {
    const selected = new Set<string>();
    const handlers = new Set<() => void>();
    let anchor: string | undefined;

    const emit = (): void => {
        for (const handler of handlers) {
            handler();
        }
    };

    return {
        get size() {
            return selected.size;
        },
        get anchor() {
            return anchor;
        },
        has: fileId => selected.has(fileId),
        ids: () => [...selected],
        toggle: fileId => {
            if (selected.has(fileId)) {
                selected.delete(fileId);
            } else {
                selected.add(fileId);
            }

            anchor = fileId;
            emit();
        },
        applyRange: (orderedIds, fileId) => {
            const from = anchor == null ? -1 : orderedIds.indexOf(anchor);
            const to = orderedIds.indexOf(fileId);
            if (to < 0) {
                return;
            }

            const isSelecting = anchor == null || selected.has(anchor);
            const start = from < 0 ? to : Math.min(from, to);
            const end = from < 0 ? to : Math.max(from, to);
            for (const id of orderedIds.slice(start, end + 1)) {
                if (isSelecting) {
                    selected.add(id);
                } else {
                    selected.delete(id);
                }
            }

            anchor = fileId;
            emit();
        },
        setMany: (fileIds, isSelected) => {
            for (const id of fileIds) {
                if (isSelected) {
                    selected.add(id);
                } else {
                    selected.delete(id);
                }
            }

            emit();
        },
        retain: fileIds => {
            const keep = new Set(fileIds);
            const before = selected.size;
            for (const id of [...selected]) {
                if (!keep.has(id)) {
                    selected.delete(id);
                }
            }

            if (selected.size !== before) {
                emit();
            }
        },
        clear: () => {
            selected.clear();
            anchor = undefined;
            emit();
        },
        onChange: handler => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
    };
}
