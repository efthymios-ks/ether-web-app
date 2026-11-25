import { fileCategoryOf } from '../media/fileCategory.js';
import type { FileCategory } from '../media/fileCategory.js';
import type { MediaKind } from '../media/metadataTypes.js';
import { h } from './dom.js';
import { ICONS } from './icons.js';

// A file looks the same on every surface (tiles, list rows, progress lines, Details and the viewer): its
// thumbnail when it has one this browser can draw, else its category's fixed icon, coloured by the theme's
// file-type tokens. Photos and videos show their icon only until the thumbnail arrives, or when it can't be drawn.

export const CATEGORY_ICONS: Readonly<Record<FileCategory, string>> = Object.freeze({
    image: ICONS.photo,
    video: ICONS.video,
    audio: ICONS.audio,
    document: ICONS.document,
    archive: ICONS.archive,
    other: ICONS.file,
});

export interface TypedFile {
    readonly mime: string;
    readonly name: string;
    readonly kind: MediaKind;
}

// A record's stored kind settles photo or video, since its thumbnail and metadata were made by it;
// the MIME type and name sort the rest.
export function categoryOf(file: TypedFile): FileCategory {
    if (file.kind !== 'other') {
        return file.kind;
    }

    const category = fileCategoryOf(file.mime, file.name);

    return category === 'image' || category === 'video' ? 'other' : category;
}

// <span class="file-icon" data-category="audio"><svg …></span>; the slot it sits in sets its size.
export function createFileIcon(category: FileCategory): HTMLElement {
    return h('span', { class: 'file-icon', dataset: { category }, html: CATEGORY_ICONS[category] });
}

export interface ThumbImageOptions {
    readonly src: string;
    readonly className: string;
    // The thumbnail can't be drawn: the caller puts the icon back, so a broken picture never shows.
    readonly onBroken: () => void;
}

export function createThumbImage(options: ThumbImageOptions): HTMLImageElement {
    const image = h('img', {
        class: options.className,
        attrs: { src: options.src, alt: '', decoding: 'async', draggable: 'false' },
    });
    image.addEventListener('error', () => options.onBroken(), { once: true });

    return image;
}
