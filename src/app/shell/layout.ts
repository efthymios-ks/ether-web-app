import type { Client } from '../../client/clientTypes.js';

// UI plan §4.9, D8, D9: whether Home's sidebar shows beside the pane. It does on wide screens (≥ 900 px) and on
// landscape phones (≥ 600 px wide) while not connected; once connected, the session and Home take the whole width.
// On that layout the pane of Home offers Pair with a code, so its link under the nearby devices goes.

// The same query as the split mixin in styles/_layout.scss.
const SPLIT_MEDIA = '(min-width: 900px), (orientation: landscape) and (min-width: 600px)';

export interface ShellLayout {
    // Wide enough for the sidebar, and not connected.
    readonly hasSidebar: boolean;
    // Follows the window's size and orientation, and the connection.
    onChange(handler: () => void): () => void;
    dispose(): void;
}

export function createShellLayout(client: Client): ShellLayout {
    const handlers = new Set<() => void>();
    const query = globalThis.matchMedia?.(SPLIT_MEDIA);

    const emit = (): void => {
        for (const handler of handlers) {
            handler();
        }
    };

    query?.addEventListener?.('change', emit);
    const unsubscribe = client.on('state', emit);

    return {
        // Read afresh each time, so it is right straight after a resize.
        get hasSidebar() {
            return globalThis.matchMedia?.(SPLIT_MEDIA).matches === true && client.state !== 'connected';
        },
        onChange: handler => {
            handlers.add(handler);

            return () => {
                handlers.delete(handler);
            };
        },
        dispose: () => {
            query?.removeEventListener?.('change', emit);
            unsubscribe();
            handlers.clear();
        },
    };
}
