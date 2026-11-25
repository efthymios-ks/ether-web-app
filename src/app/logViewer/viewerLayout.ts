// DL-02: where the log viewer sits. It follows the available size, like the layouts in §13.
export type ViewerLayout = 'drawer' | 'side' | 'dock';

export interface Viewport {
    readonly width: number;
    readonly height: number;
}

export interface ViewerSizeState {
    // Drawer height as a share of the window height.
    readonly drawerFraction: number;
    // Docked width in pixels.
    readonly dockWidth: number;
}

export interface PanelSize {
    readonly inline: number;
    readonly block: number;
}

export const VIEWER_SIZES = Object.freeze({
    drawerFraction: 0.4,
    minDrawerHeight: 160,
    maxDrawerFraction: 0.9,
    sideFraction: 0.5,
    dockWidth: 380,
    minDockWidth: 280,
    maxDockFraction: 0.7,
});

export const DEFAULT_SIZE_STATE: ViewerSizeState = Object.freeze({
    drawerFraction: VIEWER_SIZES.drawerFraction,
    dockWidth: VIEWER_SIZES.dockWidth,
});

// Order is priority: a landscape phone first, then narrow or tall screens get the bottom drawer.
interface LayoutRule {
    readonly layout: ViewerLayout;
    matches(viewport: Viewport): boolean;
}

const LAYOUT_RULES: readonly LayoutRule[] = Object.freeze([
    { layout: 'side', matches: viewport => viewport.height < 500 && viewport.width > viewport.height },
    { layout: 'drawer', matches: viewport => viewport.width < 600 },
    { layout: 'drawer', matches: viewport => viewport.width < 900 && viewport.height > viewport.width },
] satisfies LayoutRule[]);

export function resolveViewerLayout(viewport: Viewport): ViewerLayout {
    return LAYOUT_RULES.find(rule => rule.matches(viewport))?.layout ?? 'dock';
}

export function clampDrawerHeight(height: number, viewportHeight: number): number {
    const max = Math.max(VIEWER_SIZES.minDrawerHeight, viewportHeight * VIEWER_SIZES.maxDrawerFraction);

    return Math.round(Math.min(max, Math.max(VIEWER_SIZES.minDrawerHeight, height)));
}

export function clampDockWidth(width: number, viewportWidth: number): number {
    const max = Math.max(VIEWER_SIZES.minDockWidth, viewportWidth * VIEWER_SIZES.maxDockFraction);

    return Math.round(Math.min(max, Math.max(VIEWER_SIZES.minDockWidth, width)));
}

// The size the shell keeps clear: inline for side panels, block for the drawer.
export function panelSize(layout: ViewerLayout, viewport: Viewport, state: ViewerSizeState): PanelSize {
    if (layout === 'drawer') {
        return { inline: 0, block: clampDrawerHeight(viewport.height * state.drawerFraction, viewport.height) };
    }

    if (layout === 'side') {
        return { inline: Math.round(viewport.width * VIEWER_SIZES.sideFraction), block: 0 };
    }

    return { inline: clampDockWidth(state.dockWidth, viewport.width), block: 0 };
}
