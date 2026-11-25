import type { GalleryItem } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { categoryOf, createFileIcon } from '../fileIcon.js';
import { formatClock } from '../format.js';
import { ICONS } from '../icons.js';
import { fileRef } from '../transfers/fileRef.js';
import type { FileStatus } from '../transfers/fileStatus.js';

// One tile of the Tiles view: the thumbnail, or the file's category icon large and centred, a moving file's ring
// and percent, a tag only for an exception (Failed, Damaged, Skipped, Paused, Not sent yet…), a small ✓ once
// downloaded, a video's or a song's length, and the selection check. A tile is updated in place for as long as
// its file is on screen, so its thumbnail, its ring and its badges carry on through progress, state changes and
// new layouts.

export type TileStatus = Pick<FileStatus, 'text' | 'tone'>;

export interface TileView {
    readonly item: GalleryItem;
    // The full status, for the tile's name and tooltip.
    readonly status: TileStatus;
    // What the tag says: an exception or a moving file's percent; none at the plain end of a transfer.
    readonly tag: TileStatus | undefined;
    readonly isDownloaded: boolean;
    // 0 to 1 while the file moves; no ring otherwise.
    readonly progress: number | undefined;
    // Undefined while not selecting.
    readonly isSelected: boolean | undefined;
}

export interface GalleryTile {
    readonly element: HTMLButtonElement;
    update(view: TileView): void;
    // A thumbnail the client prepared after the tile was drawn.
    loadThumbnail(): void;
    // Revokes the thumbnail's object URL once the tile has left the screen (GL-02).
    dispose(): void;
}

export interface GalleryTileOptions {
    readonly context: AppContext;
    readonly onClick: (fileId: string, event: MouseEvent) => void;
}

const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

interface Ring {
    readonly element: SVGSVGElement;
    set(progress: number): void;
}

function createRing(): Ring {
    const namespace = 'http://www.w3.org/2000/svg';
    const element = document.createElementNS(namespace, 'svg');
    element.setAttribute('class', 'progress-ring');
    element.setAttribute('viewBox', '0 0 36 36');
    element.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(namespace, 'circle');
    const value = document.createElementNS(namespace, 'circle');
    for (const circle of [track, value]) {
        circle.setAttribute('cx', '18');
        circle.setAttribute('cy', '18');
        circle.setAttribute('r', String(RING_RADIUS));
    }

    track.setAttribute('class', 'progress-ring-track');
    value.setAttribute('class', 'progress-ring-value');
    value.setAttribute('stroke-dasharray', `${RING_LENGTH}`);
    element.append(track, value);

    return {
        element,
        set: progress => {
            const offset = `${RING_LENGTH * (1 - Math.min(1, Math.max(0, progress)))}`;
            if (value.getAttribute('stroke-dashoffset') !== offset) {
                value.setAttribute('stroke-dashoffset', offset);
            }
        },
    };
}

// Sets an attribute only when it differs, so an update that changes nothing leaves the tile alone.
function syncAttribute(element: Element, name: string, value: string | undefined): void {
    if (value == null) {
        element.removeAttribute(name);

        return;
    }

    if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
    }
}

// Shows a badge with this text, or hides it without one; touched only when that differs.
function syncText(element: HTMLElement, text: string | undefined): void {
    const isHidden = text == null;
    if (element.hidden !== isHidden) {
        element.hidden = isHidden;
    }

    if (text != null && element.textContent !== text) {
        element.textContent = text;
    }
}

export function createGalleryTile(options: GalleryTileOptions): GalleryTile {
    const { context } = options;
    const placeholder = h('span', { class: 'gallery-placeholder' });
    const image = h('img', {
        class: 'gallery-thumb',
        attrs: { alt: '', decoding: 'async', draggable: 'false' },
    });
    const tag = h('span', { class: 'gallery-tag', attrs: { hidden: true } });
    const length = h('span', { class: 'gallery-duration', attrs: { hidden: true } });
    const badges = h('span', { class: 'gallery-badges', attrs: { 'aria-hidden': 'true' }, children: [tag, length] });
    const done = h('span', {
        class: 'gallery-done',
        html: ICONS.check,
        attrs: { 'aria-hidden': 'true', 'hidden': true },
    });
    const check = h('span', { class: 'gallery-check', attrs: { 'aria-hidden': 'true' } });
    const element = h('button', {
        class: 'gallery-cell',
        attrs: { type: 'button', role: 'gridcell' },
        children: [placeholder, image, badges, done, check],
    });
    let current: GalleryItem | undefined;
    let ring: Ring | undefined;
    let thumbUrl: string | undefined;
    let isThumbRequested = false;
    let isDisposed = false;

    // A thumbnail this browser can't draw leaves the tile its icon, which sits under the picture.
    image.addEventListener('error', () => {
        if (thumbUrl == null) {
            return;
        }

        URL.revokeObjectURL(thumbUrl);
        thumbUrl = undefined;
        image.removeAttribute('src');
        delete element.dataset.hasThumb;
    });

    const loadThumbnailAsync = async (item: GalleryItem): Promise<void> => {
        isThumbRequested = true;
        const blob = await context.client.getThumbnailAsync(fileRef(item)).catch(() => undefined);
        if (blob == null || isDisposed || thumbUrl != null) {
            return;
        }

        thumbUrl = URL.createObjectURL(blob);
        image.src = thumbUrl;
        element.dataset.hasThumb = 'true';
    };

    // The badges keep their elements and change only what changed, so a percent ticking up rewrites one text.
    const updateBadges = (view: TileView): void => {
        syncText(tag, view.tag?.text);
        syncAttribute(tag, 'data-tone', view.tag?.tone);
        const seconds = view.item.durationSeconds;
        syncText(length, seconds == null ? undefined : formatClock(seconds));
        if (done.hidden === view.isDownloaded) {
            done.hidden = !view.isDownloaded;
        }
    };

    const updateRing = (progress: number | undefined): void => {
        syncAttribute(element, 'data-moving', progress == null ? undefined : 'true');
        if (progress == null) {
            ring?.element.remove();
            ring = undefined;

            return;
        }

        if (ring == null) {
            ring = createRing();
            element.insertBefore(ring.element, check);
        }

        ring.set(progress);
    };

    element.addEventListener('click', event => {
        if (current != null) {
            options.onClick(current.fileId, event);
        }
    });

    return {
        element,
        update: view => {
            const { item } = view;
            if (current == null) {
                const category = categoryOf(item);
                placeholder.replaceChildren(createFileIcon(category));
                element.dataset.fileId = item.fileId;
                element.dataset.kind = item.kind;
                element.dataset.category = category;
            }

            current = item;
            const name = `${item.name}, ${view.status.text}`;
            syncAttribute(element, 'data-status', item.status);
            syncAttribute(element, 'aria-label', name);
            syncAttribute(element, 'title', name);
            const selected = view.isSelected == null ? undefined : String(view.isSelected);
            syncAttribute(element, 'aria-selected', selected);
            updateBadges(view);
            updateRing(view.progress);
            if (item.hasThumbnail && !isThumbRequested) {
                void loadThumbnailAsync(item);
            }
        },
        loadThumbnail: () => {
            if (current != null && thumbUrl == null) {
                void loadThumbnailAsync(current);
            }
        },
        dispose: () => {
            isDisposed = true;
            if (thumbUrl != null) {
                URL.revokeObjectURL(thumbUrl);
                thumbUrl = undefined;
            }
        },
    };
}
