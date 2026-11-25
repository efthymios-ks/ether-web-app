// Inline SVG icons: trusted, generated markup for `h(…, { html })`. They inherit the text colour.

function svg(paths: string): string {
    return `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

export const ICONS = Object.freeze({
    // The app's own icon (public/icons/icon.svg) in its fixed colours, the same in both themes.
    brand: '<svg class="icon" viewBox="0 0 100 100" width="24" height="24" aria-hidden="true" focusable="false">'
        + '<defs><linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1">'
        + '<stop offset="0" stop-color="#005fb8"/><stop offset="1" stop-color="#4ec9b0"/></linearGradient></defs>'
        + '<rect width="100" height="100" rx="22" fill="url(#brand-gradient)"/>'
        + '<circle cx="50" cy="66" r="6.5" fill="#fff"/>'
        + '<g fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round">'
        + '<path d="M37.98 53.98A17 17 0 0 1 62.02 53.98"/>'
        + '<path d="M30.2 46.2A28 28 0 0 1 69.8 46.2"/><path d="M22.42 38.42A39 39 0 0 1 77.58 38.42"/></g></svg>',
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>'),
    camera: svg('<path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    photo: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
    video: svg('<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4z"/>'),
    audio: svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    document: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
    archive: svg('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>'),
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    download: svg('<path d="M12 3v12M8 11l4 4 4-4"/><path d="M5 21h14"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
    retry: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
    pause: svg('<path d="M9 5v14M15 5v14"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
    play: svg('<path d="m7 4 12 8-12 8z"/>'),
    torch: svg('<path d="M8 2h8v4l-2 4v12h-4V10L8 6z"/><path d="M12 14v2"/>'),
    chevronLeft: svg('<path d="m15 18-6-6 6-6"/>'),
    chevronRight: svg('<path d="m9 18 6-6-6-6"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    warning: svg('<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    disconnect: svg('<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>'),
    select: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>'),
    paste: svg('<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6"/>'),
    sliders: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
    more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    phone: svg('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>'),
    tablet: svg('<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M11 18h2"/>'),
    desktop: svg('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
});
