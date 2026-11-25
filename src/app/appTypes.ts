// Types the UI parts share, so the shell and the panels can be built side by side.

export interface ConfirmOptions {
    readonly title: string;
    readonly message: string;
    readonly confirmLabel?: string;
    readonly cancelLabel?: string;
    // Paints the confirm button as destructive.
    readonly danger?: boolean;
}

export type ConfirmAsync = (options: ConfirmOptions) => Promise<boolean>;

// The root attribute the log viewer sets so the shell keeps the QR and camera clear (DL-02, test 26):
// data-log-viewer="open" on <html>, and the CSS properties below.
export const PANEL_SIZE_PROPERTIES = Object.freeze({
    logViewerInline: '--log-viewer-inline-size',
    logViewerBlock: '--log-viewer-block-size',
});
