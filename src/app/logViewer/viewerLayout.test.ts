import { describe, expect, it } from 'vitest';
import { clampDockWidth, clampDrawerHeight, DEFAULT_SIZE_STATE, panelSize, resolveViewerLayout } from './viewerLayout.js';

describe('resolveViewerLayout', () => {
    it('picks the placement of DL-02 for each layout of §13', () => {
        // Act & Assert
        expect(resolveViewerLayout({ width: 390, height: 844 })).toBe('drawer');
        expect(resolveViewerLayout({ width: 844, height: 390 })).toBe('side');
        expect(resolveViewerLayout({ width: 1280, height: 800 })).toBe('dock');
        expect(resolveViewerLayout({ width: 768, height: 1024 })).toBe('drawer');
        expect(resolveViewerLayout({ width: 1024, height: 768 })).toBe('dock');
    });
});

describe('panelSize', () => {
    it('uses 40% height for the drawer, half the width at the side and 380 px docked', () => {
        // Act & Assert
        expect(panelSize('drawer', { width: 390, height: 844 }, DEFAULT_SIZE_STATE)).toEqual({ inline: 0, block: 338 });
        expect(panelSize('side', { width: 844, height: 390 }, DEFAULT_SIZE_STATE)).toEqual({ inline: 422, block: 0 });
        expect(panelSize('dock', { width: 1280, height: 800 }, DEFAULT_SIZE_STATE)).toEqual({ inline: 380, block: 0 });
    });

    it('keeps resized panels within limits', () => {
        // Act & Assert
        expect(clampDrawerHeight(40, 844)).toBe(160);
        expect(clampDrawerHeight(2000, 844)).toBe(760);
        expect(clampDockWidth(100, 1280)).toBe(280);
        expect(clampDockWidth(2000, 1280)).toBe(896);
    });
});
