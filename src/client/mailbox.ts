// A single-reader queue of events with an optional timeout per read; closing it rejects the reader.

export const TIMED_OUT = Symbol('timed out');

interface Waiter<Item> {
    resolve(item: Item | typeof TIMED_OUT): void;
    reject(error: unknown): void;
    timer?: ReturnType<typeof setTimeout>;
}

export class Mailbox<Item> {
    #items: Item[] = [];
    #waiter: Waiter<Item> | undefined;
    #closedWith: { readonly error: unknown } | undefined;

    get isClosed(): boolean {
        return this.#closedWith !== undefined;
    }

    push(item: Item): void {
        if (this.#closedWith) {
            return;
        }

        const waiter = this.#waiter;
        if (!waiter) {
            this.#items.push(item);

            return;
        }

        this.#waiter = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(item);
    }

    nextAsync(timeoutMs?: number): Promise<Item | typeof TIMED_OUT> {
        if (this.#closedWith) {
            return Promise.reject(this.#closedWith.error);
        }

        if (this.#items.length > 0) {
            return Promise.resolve(this.#items.shift() as Item);
        }

        return new Promise((resolve, reject) => {
            const waiter: Waiter<Item> = { resolve, reject };
            if (timeoutMs != null) {
                waiter.timer = setTimeout(() => {
                    if (this.#waiter === waiter) {
                        this.#waiter = undefined;
                    }

                    resolve(TIMED_OUT);
                }, timeoutMs);
            }

            this.#waiter = waiter;
        });
    }

    close(error: unknown): void {
        if (this.#closedWith) {
            return;
        }

        this.#closedWith = { error };
        this.#items = [];
        const waiter = this.#waiter;
        this.#waiter = undefined;
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    }
}
