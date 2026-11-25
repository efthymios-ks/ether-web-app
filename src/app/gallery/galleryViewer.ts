import type { FileRecord, GalleryItem } from '../../client/clientTypes.js';
import { isPreviewCategory } from '../../media/fileCategory.js';
import type { FileCategory } from '../../media/fileCategory.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { categoryOf, createFileIcon } from '../fileIcon.js';
import { formatClock, formatCoordinates, formatSize, formatTakenAt } from '../format.js';
import { createSha256Detail } from '../history/fileDetails.js';
import type { Sha256Detail } from '../history/fileDetails.js';
import { ICONS } from '../icons.js';
import type { FileActions } from '../transfers/fileActions.js';
import { isVerifyFailed, reportDamaged } from '../transfers/fileErrors.js';
import { fileRef } from '../transfers/fileRef.js';

// GL-06: one full-size item at a time (plus its neighbours), swipe or arrow keys, details and actions.
// Photos show full size, videos and audio play with the browser's controls. Received files are never opened by
// themselves (SP-06); a format this browser can't show or play, and every other kind of file, shows its
// category's icon (RX-06).

export interface GalleryViewerOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    readonly sessionId: string;
    readonly items: readonly GalleryItem[];
    readonly index: number;
    readonly onChanged: () => void;
}

const SWIPE_DISTANCE = 50;
const CANNOT_SHOW_TEXT = 'This browser can’t show this format.';
const CANNOT_PLAY_TEXT = 'This browser can’t play this format.';
const NO_PREVIEW_TEXT = 'There’s no preview for this kind of file.';
const THUMBNAIL_ONLY_TEXT = 'Only the thumbnail is kept for this item.';
const DETAILS_ONLY_TEXT = 'Only the details are kept for this item.';

interface LoadedMedia {
    readonly file?: File;
    readonly url?: string;
    // The stored copy no longer matches its hash ('verify-failed').
    readonly isDamaged?: boolean;
}

export function openGalleryViewer(options: GalleryViewerOptions): void {
    const { context, actions, sessionId } = options;
    const items = [...options.items];
    const loaded = new Map<string, Promise<LoadedMedia>>();
    const urls = new Map<string, string>();
    const records = new Map<string, FileRecord>();
    let index = Math.max(0, Math.min(items.length - 1, options.index));
    let recordsLoaded: Promise<void> | undefined;
    let sha256: Sha256Detail | undefined;
    let isClosed = false;

    const position = h('span', { class: 'viewer-position', attrs: { 'aria-live': 'polite' } });
    const name = h('h3', { class: 'viewer-name' });
    const stage = h('div', { class: 'viewer-stage' });
    const details = h('dl', { class: 'viewer-details' });
    const actionBar = h('div', { class: 'viewer-actions' });
    const status = h('p', { class: 'save-status', attrs: { role: 'status', hidden: true } });
    const previous = h('button', {
        class: 'icon-button viewer-previous',
        html: ICONS.chevronLeft,
        attrs: { 'type': 'button', 'aria-label': 'Previous', 'data-tooltip': 'Previous' },
        on: { click: () => show(index - 1) },
    });
    const next = h('button', {
        class: 'icon-button viewer-next',
        html: ICONS.chevronRight,
        attrs: { 'type': 'button', 'aria-label': 'Next', 'data-tooltip': 'Next' },
        on: { click: () => show(index + 1) },
    });
    const closeButton = h('button', {
        class: 'icon-button',
        html: ICONS.close,
        attrs: { 'type': 'button', 'aria-label': 'Close', 'data-tooltip': 'Close' },
    });
    const content = h('div', {
        class: 'viewer',
        children: [
            h('div', { class: 'viewer-bar', children: [position, name, closeButton] }),
            h('div', { class: 'viewer-body', children: [previous, stage, next] }),
            h('section', { class: 'viewer-info', attrs: { 'aria-label': 'Details' }, children: [details, status, actionBar] }),
        ],
    });

    const setStatus = (text: string, tone: 'info' | 'ok' | 'warn' | 'fail' = 'info'): void => {
        status.textContent = text;
        status.dataset.tone = tone;
        status.hidden = text.length === 0;
    };

    const loadRecordsAsync = (): Promise<void> => {
        recordsLoaded ??= (async () => {
            const directions = [...new Set(items.map(item => item.direction))];
            for (const direction of directions) {
                const list = await context.client.listFilesAsync({ sessionId, direction });
                for (const record of list) {
                    records.set(`${record.direction}:${record.fileId}`, record);
                }
            }
        })();

        return recordsLoaded;
    };

    const canShowFull = (item: GalleryItem): boolean => item.direction === 'in'
        && item.hasData
        && context.services.canPreview(item.mime, item.name);

    const loadAsync = (item: GalleryItem): Promise<LoadedMedia> => {
        const key = `${item.direction}:${item.fileId}`;
        const existing = loaded.get(key);
        if (existing != null) {
            return existing;
        }

        const promise = (async (): Promise<LoadedMedia> => {
            try {
                if (item.direction === 'in' && item.hasData) {
                    const file = await context.client.getReceivedFileAsync(fileRef(item));
                    if (!canShowFull(item) || isClosed) {
                        return { file };
                    }

                    const url = URL.createObjectURL(file);
                    urls.set(key, url);

                    return { file, url };
                }

                const thumbnail = item.hasThumbnail ? await context.client.getThumbnailAsync(fileRef(item)) : undefined;
                if (thumbnail == null || isClosed) {
                    return {};
                }

                const url = URL.createObjectURL(thumbnail);
                urls.set(key, url);

                return { url };
            } catch (error) {
                return isVerifyFailed(error) ? { isDamaged: true } : {};
            }
        })();
        loaded.set(key, promise);

        return promise;
    };

    // GL-02: only the current item and its neighbours keep object URLs.
    const releaseFar = (): void => {
        const keep = new Set([index - 1, index, index + 1]
            .map(position => items[position])
            .filter((item): item is GalleryItem => item != null)
            .map(item => `${item.direction}:${item.fileId}`));
        for (const [key, url] of urls) {
            if (!keep.has(key)) {
                URL.revokeObjectURL(url);
                urls.delete(key);
                loaded.delete(key);
            }
        }
    };

    const iconFallback = (category: FileCategory, text: string): HTMLElement => h('div', {
        class: 'viewer-fallback',
        children: [
            h('span', { class: 'viewer-fallback-icon', children: [createFileIcon(category)] }),
            h('p', { text }),
        ],
    });

    // Why an item has nothing to show: its kind never previews, this browser can't decode it, or this device
    // keeps only its thumbnail or only its details (sent files, and received ones deleted from the app).
    const fallbackText = (item: GalleryItem, category: FileCategory): string => {
        if (!isPreviewCategory(category)) {
            return NO_PREVIEW_TEXT;
        }

        if (item.direction === 'in' && item.hasData) {
            return category === 'image' ? CANNOT_SHOW_TEXT : CANNOT_PLAY_TEXT;
        }

        return item.hasThumbnail ? THUMBNAIL_ONLY_TEXT : DETAILS_ONLY_TEXT;
    };

    // A player this browser turns out not to manage gives way to the icon, never to a broken player.
    const playerFallback = (player: HTMLMediaElement, category: FileCategory): void => {
        player.addEventListener('error', () => {
            if (player.isConnected) {
                stage.replaceChildren(iconFallback(category, CANNOT_PLAY_TEXT));
            }
        });
    };

    const createAudioStage = (item: GalleryItem, url: string): HTMLElement => {
        const player = h('audio', {
            class: 'viewer-audio',
            attrs: { 'src': url, 'controls': true, 'preload': 'metadata', 'aria-label': item.name },
        });
        playerFallback(player, 'audio');

        return h('div', {
            class: 'viewer-audio-stage',
            children: [h('span', { class: 'viewer-fallback-icon', children: [createFileIcon('audio')] }), player],
        });
    };

    const renderMedia = (item: GalleryItem, media: LoadedMedia): void => {
        const category = categoryOf(item);
        if (media.isDamaged === true) {
            stage.replaceChildren(iconFallback(category, reportDamaged(context, item.name, sessionId)));

            return;
        }

        if (media.url == null) {
            stage.replaceChildren(iconFallback(category, fallbackText(item, category)));

            return;
        }

        if (category === 'video' && canShowFull(item)) {
            const video = h('video', {
                class: 'viewer-video',
                attrs: { src: media.url, controls: true, playsinline: true, preload: 'metadata' },
            });
            playerFallback(video, 'video');
            stage.replaceChildren(video);

            return;
        }

        if (category === 'audio' && canShowFull(item)) {
            stage.replaceChildren(createAudioStage(item, media.url));

            return;
        }

        const image = h('img', { class: 'viewer-image', attrs: { src: media.url, alt: item.name } });
        image.addEventListener('error', () => {
            if (image.isConnected) {
                stage.replaceChildren(iconFallback(category, CANNOT_SHOW_TEXT));
            }
        });
        stage.replaceChildren(image);
    };

    const detailRow = (term: string, value: Node | string): HTMLElement[] => [
        h('dt', { text: term }),
        h('dd', { children: [value] }),
    ];

    const renderDetails = (item: GalleryItem): void => {
        const record = records.get(`${item.direction}:${item.fileId}`);
        const metadata = record?.metadata;
        const rows: HTMLElement[] = [...detailRow('Name', record?.relativePath ?? item.name)];
        if (metadata?.takenAt != null) {
            const suffix = metadata.takenAtSource === 'file' ? ' (file date)' : '';
            rows.push(...detailRow('Taken', `${formatTakenAt(metadata.takenAt)}${suffix}`));
        }

        if (metadata?.latitude != null && metadata.longitude != null) {
            rows.push(...detailRow('Location', h('span', {
                children: [
                    `${formatCoordinates(metadata.latitude, metadata.longitude)} `,
                    h('a', {
                        class: 'viewer-map-link',
                        text: 'Open in Maps',
                        attrs: {
                            href: context.platform.mapsUrl(metadata.latitude, metadata.longitude),
                            target: '_blank',
                            rel: 'noopener noreferrer',
                        },
                    }),
                ],
            })));
        }

        const camera = [metadata?.make, metadata?.model].filter(part => part != null && part.length > 0).join(' ');
        if (camera.length > 0) {
            rows.push(...detailRow('Camera', metadata?.lens == null ? camera : `${camera} · ${metadata.lens}`));
        }

        const dimensions = metadata?.width != null && metadata.height != null ? ` · ${metadata.width} × ${metadata.height}` : '';
        rows.push(...detailRow('Size', `${formatSize(item.size)}${dimensions}`));
        if (item.durationSeconds != null) {
            rows.push(...detailRow('Length', formatClock(item.durationSeconds)));
        }

        if (metadata?.tags != null && metadata.tags.length > 0) {
            rows.push(...detailRow('Tags', metadata.tags.join(', ')));
        }

        if (record?.rootHash != null) {
            rows.push(...detailRow('Verified', `Every page matched (${record.rootHash.slice(0, 8)}…)`));
        }

        sha256?.dispose();
        sha256 = record == null || (item.direction === 'in' && !item.hasData)
            ? undefined
            : createSha256Detail({
                context,
                fileId: item.fileId,
                sessionId,
                direction: item.direction,
                name: item.name,
                sha256: record.sha256,
            });
        details.replaceChildren(...rows, ...(sha256 == null ? [] : [sha256.term, sha256.detail]));
    };

    const renderActions = (item: GalleryItem, media: Promise<LoadedMedia>): void => {
        if (item.direction !== 'in' || !item.hasData) {
            actionBar.replaceChildren();

            return;
        }

        const zip = h('button', {
            class: 'button button-primary',
            dataset: { action: 'download-zip' },
            attrs: { type: 'button' },
            children: [h('span', { class: 'button-icon', html: ICONS.download }), 'Download ZIP'],
        });
        const zipAsync = async (): Promise<void> => {
            zip.disabled = true;
            try {
                if (await actions.downloadZipAsync([item.fileId], sessionId)) {
                    setStatus('Downloaded as a ZIP.', 'ok');
                }
            } finally {
                zip.disabled = false;
            }
        };

        zip.addEventListener('click', () => {
            void zipAsync();
        });
        const remove = h('button', {
            class: 'button button-danger',
            attrs: { type: 'button' },
            children: [h('span', { class: 'button-icon', html: ICONS.trash }), 'Delete'],
            on: { click: () => void deleteAsync(item) },
        });
        actionBar.replaceChildren(zip, remove);
        const disableIfDamagedAsync = async (): Promise<void> => {
            zip.disabled = (await media).isDamaged === true;
        };

        void disableIfDamagedAsync();
    };

    const deleteAsync = async (item: GalleryItem): Promise<void> => {
        await loadRecordsAsync();
        const record = records.get(`${item.direction}:${item.fileId}`);
        if (record == null || !(await actions.deleteReceivedAsync(record))) {
            return;
        }

        items.splice(index, 1);
        options.onChanged();
        context.notifyDataChanged();
        if (items.length === 0) {
            handle.close();

            return;
        }

        show(Math.min(index, items.length - 1));
    };

    const show = (target: number): void => {
        if (target < 0 || target >= items.length) {
            return;
        }

        index = target;
        const item = items[index];
        if (item == null) {
            return;
        }

        setStatus('');
        position.textContent = `${index + 1} of ${items.length}`;
        name.textContent = context.services.truncateMiddle(item.name, 48);
        name.title = item.name;
        previous.disabled = index === 0;
        next.disabled = index === items.length - 1;
        stage.replaceChildren(h('span', { class: 'spinner', attrs: { 'aria-label': 'Loading' } }));
        const media = loadAsync(item);
        renderActions(item, media);
        void (async () => {
            const result = await media;
            if (items[index] === item && !isClosed) {
                renderMedia(item, result);
            }
        })();
        void (async () => {
            await loadRecordsAsync();
            if (items[index] === item && !isClosed) {
                renderDetails(item);
            }
        })();
        renderDetails(item);
        for (const neighbour of [items[index - 1], items[index + 1]]) {
            if (neighbour != null && canShowFull(neighbour)) {
                void loadAsync(neighbour);
            }
        }

        releaseFar();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            show(index - 1);
        }

        if (event.key === 'ArrowRight') {
            event.preventDefault();
            show(index + 1);
        }
    };

    let swipeStart: { x: number; y: number } | undefined;
    stage.addEventListener('pointerdown', event => {
        swipeStart = { x: event.clientX, y: event.clientY };
    });
    stage.addEventListener('pointerup', event => {
        if (swipeStart == null) {
            return;
        }

        const deltaX = event.clientX - swipeStart.x;
        const deltaY = event.clientY - swipeStart.y;
        swipeStart = undefined;
        if (Math.abs(deltaX) < SWIPE_DISTANCE || Math.abs(deltaY) > Math.abs(deltaX)) {
            return;
        }

        show(deltaX < 0 ? index + 1 : index - 1);
    });

    const cleanUp = (): void => {
        isClosed = true;
        sha256?.dispose();
        for (const url of urls.values()) {
            URL.revokeObjectURL(url);
        }

        urls.clear();
        loaded.clear();
    };

    const handle = context.dialogs.openModal({
        title: 'Viewer',
        hideTitle: true,
        content,
        variant: 'fullscreen',
        onDismiss: cleanUp,
        initialFocus: closeButton,
    });
    closeButton.addEventListener('click', () => {
        cleanUp();
        handle.close();
    });
    handle.element.addEventListener('keydown', onKeyDown);
    show(index);
}
