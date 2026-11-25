// Puts the children in order and leaves the ones already in place attached. Moving an element restarts its
// animations and, when it holds the browser's scroll anchor, lets the page jump; so only what changed moves.
export function syncChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
    const wanted = new Set<Element>(children);
    for (const child of [...parent.children]) {
        if (!wanted.has(child)) {
            child.remove();
        }
    }

    children.forEach((child, index) => {
        const atIndex = parent.children.item(index);
        if (atIndex !== child) {
            parent.insertBefore(child, atIndex);
        }
    });
}
