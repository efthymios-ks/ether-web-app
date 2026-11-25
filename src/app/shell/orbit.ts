import { h } from '../dom.js';

// R8: the orbit shown while nearby devices are looked for: a core dot, a thin ring and two satellites circling
// it once every 2.4 s in the accent colour. Reduced motion stops the satellites where they start.

export const ORBIT_LABEL = 'Looking for nearby devices';

// Trusted, generated markup; the size is a number.
function orbitSvg(size: number): string {
    return `<svg class="orbit-svg" width="${size}" height="${size}" viewBox="0 0 24 24"`
        + ' aria-hidden="true" focusable="false">'
        + '<circle class="orbit-ring" cx="12" cy="12" r="8.5"/>'
        + '<circle class="orbit-core" cx="12" cy="12" r="3"/>'
        + '<g class="orbit-satellite"><circle cx="12" cy="3.5" r="2"/></g>'
        + '<g class="orbit-satellite orbit-satellite-second"><circle cx="12" cy="3.5" r="1.4"/></g>'
        + '</svg>';
}

// A labelled orbit is an image for screen readers; without a label it is decoration.
export function createOrbit(size: number, label?: string): HTMLElement {
    return h('span', {
        class: 'orbit',
        html: orbitSvg(size),
        attrs: label == null ? { 'aria-hidden': 'true' } : { 'role': 'img', 'aria-label': label },
    });
}
