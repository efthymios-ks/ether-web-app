// UI-07: the on-screen keyboard shrinks the visual viewport, not the layout one. Its height becomes the
// custom property --keyboard-inset so the code input stays above it, and the focused field stays in view.

interface VisualViewportLike extends EventTarget {
    readonly height: number;
    readonly offsetTop: number;
}

export function watchKeyboardInset(
    root: HTMLElement = document.documentElement,
    viewport: VisualViewportLike | null | undefined = globalThis.visualViewport,
): () => void {
    if (viewport == null) {
        return () => undefined;
    }

    const update = (): void => {
        const inset = Math.max(0, Math.round(globalThis.innerHeight - viewport.height - viewport.offsetTop));
        root.style.setProperty('--keyboard-inset', `${inset}px`);
        const active = document.activeElement;
        if (inset > 0 && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
            active.scrollIntoView({ block: 'center' });
        }
    };

    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    update();

    return () => {
        viewport.removeEventListener('resize', update);
        viewport.removeEventListener('scroll', update);
        root.style.removeProperty('--keyboard-inset');
    };
}
