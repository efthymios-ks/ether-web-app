export type Unsubscribe = () => void;

// Every value is a listener signature, e.g. `{ state(state: LinkState): void }`.
export type EventMap<Events> = { [Name in keyof Events]: (...args: never[]) => void };

export interface Emitter<Events extends EventMap<Events>> {
    on<Name extends keyof Events>(name: Name, handler: Events[Name]): Unsubscribe;
    emit<Name extends keyof Events>(name: Name, ...args: Parameters<Events[Name]>): void;
    clear(): void;
}

// A listener that throws never stops the others; `onListenerError` sees the error.
export function createEmitter<Events extends EventMap<Events>>(
    onListenerError?: (error: unknown, name: keyof Events) => void,
): Emitter<Events> {
    const listeners = new Map<keyof Events, Set<Events[keyof Events]>>();

    const on = <Name extends keyof Events>(name: Name, handler: Events[Name]): Unsubscribe => {
        const set = listeners.get(name) ?? new Set();
        set.add(handler);
        listeners.set(name, set);

        return () => {
            set.delete(handler);
        };
    };

    const emit = <Name extends keyof Events>(name: Name, ...args: Parameters<Events[Name]>): void => {
        const set = listeners.get(name);
        if (!set) {
            return;
        }

        for (const handler of [...set]) {
            try {
                (handler as (...values: Parameters<Events[Name]>) => void)(...args);
            } catch (error) {
                onListenerError?.(error, name);
            }
        }
    };

    const clear = (): void => {
        listeners.clear();
    };

    return { on, emit, clear };
}
