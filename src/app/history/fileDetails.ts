import type { Direction, FileRecord } from '../../client/clientTypes.js';
import { isPreviewCategory } from '../../media/fileCategory.js';
import type { AppContext } from '../appContext.js';
import { copyTextAsync } from '../clipboard.js';
import { h } from '../dom.js';
import { categoryOf, createFileIcon, createThumbImage } from '../fileIcon.js';
import { formatClock, formatCoordinates, formatDateTime, formatSize, formatTakenAt } from '../format.js';
import { openFilesSheet } from '../gallery/filesSheet.js';
import { canDownloadZip } from '../gallery/rowMenu.js';
import { ICONS } from '../icons.js';
import type { FileActions } from '../transfers/fileActions.js';
import { isVerifyFailed, peerNameFor, reportDamaged } from '../transfers/fileErrors.js';
import { fileRef } from '../transfers/fileRef.js';
import { rowActionsFor } from '../transfers/fileRow.js';
import { listStatus } from '../transfers/fileStatus.js';

// The standard whole-file SHA-256, so a copy can be checked outside Ether. Computing it reads the whole file,
// so it runs only when asked, shows its progress and can be canceled; a computed value is kept by the client.

export const SHA256_HELP = 'Compare with Get-FileHash (Windows) or shasum -a 256 (Mac).';

export interface Sha256DetailOptions {
    readonly context: AppContext;
    readonly fileId: string;
    readonly sessionId: string;
    readonly direction: Direction;
    readonly name: string;
    readonly sha256?: string;
}

export interface Sha256Detail {
    // A <dt> and a <dd> for a details list.
    readonly term: HTMLElement;
    readonly detail: HTMLElement;
    dispose(): void;
}

export function createSha256Detail(options: Sha256DetailOptions): Sha256Detail {
    const { context } = options;
    const detail = h('dd', { class: 'sha256-detail' });
    let controller: AbortController | undefined;

    const showValue = (value: string): void => {
        const copyLabel = h('span', { text: 'Copy' });
        const copyButton = h('button', {
            class: 'button button-small',
            dataset: { action: 'copy-sha256' },
            attrs: { 'type': 'button', 'aria-label': `Copy the SHA-256 of ${options.name}` },
            children: [h('span', { class: 'button-icon', html: ICONS.copy }), copyLabel],
        });
        const copyAsync = async (): Promise<void> => {
            copyLabel.textContent = (await copyTextAsync(value)) ? 'Copied' : 'Select and copy it';
        };

        copyButton.addEventListener('click', () => {
            void copyAsync();
        });
        detail.replaceChildren(
            h('code', { class: 'sha256-value', text: value }),
            copyButton,
            h('span', { class: 'sha256-help', text: SHA256_HELP }),
        );
    };

    const showCompute = (message?: string): void => {
        const button = h('button', {
            class: 'button button-small',
            text: 'Compute',
            dataset: { action: 'compute-sha256' },
            attrs: { 'type': 'button', 'aria-label': `Compute the SHA-256 of ${options.name}` },
            on: {
                click: () => {
                    void computeAsync();
                },
            },
        });
        detail.replaceChildren(
            button,
            message == null ? h('span', { class: 'sha256-help', text: SHA256_HELP }) : h('span', { class: 'sha256-error', text: message }),
        );
    };

    const computeAsync = async (): Promise<void> => {
        controller = new AbortController();
        const fill = h('span', { class: 'progress-fill' });
        const bar = h('span', {
            class: 'progress-bar',
            attrs: { 'role': 'progressbar', 'aria-label': 'Computing SHA-256', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 },
            children: [fill],
        });
        const cancel = h('button', {
            class: 'button button-small',
            text: 'Cancel',
            dataset: { action: 'cancel-sha256' },
            attrs: { type: 'button' },
            on: { click: () => controller?.abort() },
        });
        detail.replaceChildren(h('span', { class: 'sha256-progress', children: [bar, cancel] }));
        try {
            const value = await context.client.computeSha256Async(fileRef(options), {
                signal: controller.signal,
                onProgress: fraction => {
                    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
                    fill.style.setProperty('--progress', `${percent}%`);
                    bar.setAttribute('aria-valuenow', String(percent));
                },
            });
            showValue(value);
        } catch (error) {
            if (controller.signal.aborted) {
                showCompute();

                return;
            }

            showCompute(isVerifyFailed(error)
                ? reportDamaged(context, options.name, options.sessionId)
                : 'The hash could not be computed. The file may no longer be on this device.');
        } finally {
            controller = undefined;
        }
    };

    if (options.sha256 != null) {
        showValue(options.sha256);
    } else {
        showCompute();
    }

    return {
        term: h('dt', { text: 'SHA-256' }),
        detail,
        dispose: () => controller?.abort(),
    };
}

export interface FileDetailsOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    readonly record: FileRecord;
    // The preview's tap: the full-size viewer at this file (GL-06). Without it the preview is a picture only.
    readonly onView?: () => void;
    // After Delete took the file out of the app.
    readonly onChanged?: () => void;
}

const CANNOT_PLAY_TEXT = 'This browser can’t play this format.';
const CANNOT_OPEN_TEXT = 'The file could not be opened. It may no longer be on this device.';

function detailRow(term: string, value: Node | string): HTMLElement[] {
    return [h('dt', { text: term }), h('dd', { children: [value] })];
}

// The camera's make and model, with the lens after a dot.
function cameraOf(metadata: FileRecord['metadata']): string | undefined {
    const camera = [metadata?.make, metadata?.model].filter(part => part != null && part.length > 0).join(' ');
    if (camera.length === 0) {
        return undefined;
    }

    return metadata?.lens == null ? camera : `${camera} · ${metadata.lens}`;
}

// Size, dates, location with Open in Maps (opened only on a tap), camera, length, tags, folder, type, status
// and Ether's own page verification.
function describe(context: AppContext, record: FileRecord): HTMLElement[] {
    const peer = peerNameFor(context, record.sessionId);
    const metadata = record.metadata;
    const rows: HTMLElement[] = [];
    const hasDimensions = metadata?.width != null && metadata.height != null;
    const dimensions = hasDimensions ? ` · ${metadata.width} × ${metadata.height}` : '';
    const bytes = `${record.size.toLocaleString('en')} bytes`;
    rows.push(...detailRow('Size', `${formatSize(record.size)} (${bytes})${dimensions}`));
    if (record.completedAt != null) {
        rows.push(...detailRow(record.direction === 'in' ? 'Received' : 'Sent', formatDateTime(record.completedAt)));
    }

    if (metadata?.takenAt != null) {
        const suffix = metadata.takenAtSource === 'file' ? ' (file date)' : '';
        rows.push(...detailRow('Date taken', `${formatTakenAt(metadata.takenAt)}${suffix}`));
    }

    if (metadata?.latitude != null && metadata.longitude != null) {
        rows.push(...detailRow('Location', h('span', {
            children: [
                `${formatCoordinates(metadata.latitude, metadata.longitude)} · `,
                h('a', {
                    class: 'files-map-link',
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

    const camera = cameraOf(metadata);
    if (camera != null) {
        rows.push(...detailRow('Camera', camera));
    }

    if (metadata?.durationSeconds != null) {
        rows.push(...detailRow('Length', formatClock(metadata.durationSeconds)));
    }

    if (metadata?.tags != null && metadata.tags.length > 0) {
        rows.push(...detailRow('Tags', metadata.tags.join(', ')));
    }

    if (record.relativePath != null) {
        rows.push(...detailRow('Folder', record.relativePath));
    }

    if (record.mime.length > 0) {
        rows.push(...detailRow('Type', record.mime));
    }

    const status = listStatus(record, peer);
    rows.push(...detailRow('Status', h('span', {
        class: 'files-details-status',
        text: status.text,
        dataset: { tone: status.tone },
    })));
    if (record.note === 'damaged') {
        rows.push(...detailRow('Verified', h('span', {
            class: 'files-details-damaged',
            text: `Stored copy is damaged. Ask ${peer} to send it again.`,
        })));
    } else if (record.rootHash != null) {
        rows.push(...detailRow('Verified', `Every page matched (${record.rootHash.slice(0, 8)}…)`));
    }

    return rows;
}

// MD-07: the Details sheet of one file, from a list row or a tile: a preview (a photo's or a video's thumbnail,
// else the file's category icon; a tap opens the full-size viewer for photos, videos and audio), the file's
// details and its SHA-256 (Compute, then Copy), and Download ZIP, Send again and Delete as the file's state
// allows. A received video or song this browser plays has a Play button that plays it right in the sheet,
// reading the file only then.
export function openFileDetails(options: FileDetailsOptions): void {
    const { context, actions, record } = options;
    const category = categoryOf(record);
    let thumbUrl: string | undefined;
    let mediaUrl: string | undefined;
    let isClosed = false;
    const sha256 = record.direction === 'in' && !record.hasData
        ? undefined
        : createSha256Detail({
            context,
            fileId: record.fileId,
            sessionId: record.sessionId,
            direction: record.direction,
            name: record.name,
            ...(record.sha256 == null ? {} : { sha256: record.sha256 }),
        });

    const deleteAsync = async (): Promise<void> => {
        if (await actions.deleteReceivedAsync(record)) {
            context.notifyDataChanged();
            options.onChanged?.();
        }
    };

    // Each action closes the sheet first, so its confirmation or toast shows over the list.
    const actionButton = (id: string, label: string, icon: string, tone: string, run: () => void): HTMLElement => {
        const button = h('button', {
            class: tone.length === 0 ? 'button' : `button ${tone}`,
            dataset: { action: id },
            attrs: { type: 'button' },
            children: [h('span', { class: 'button-icon', html: icon }), label],
        });
        button.addEventListener('click', () => {
            sheet.close();
            run();
        });

        return button;
    };
    const allowed = new Set(rowActionsFor(record, context).map(action => action.id));
    const buttons = [
        canDownloadZip(record)
            ? actionButton('download-zip', 'Download ZIP', ICONS.download, 'button-primary', () => {
                void actions.downloadZipAsync([record.fileId], record.sessionId);
            })
            : null,
        allowed.has('send-again')
            ? actionButton('send-again', 'Send again', ICONS.retry, '', () => void actions.sendAgainAsync(record))
            : null,
        allowed.has('delete')
            ? actionButton('delete', 'Delete', ICONS.trash, 'button-danger', () => void deleteAsync())
            : null,
    ].filter(button => button != null);

    const releaseUrls = (): void => {
        for (const url of [thumbUrl, mediaUrl]) {
            if (url != null) {
                URL.revokeObjectURL(url);
            }
        }

        thumbUrl = undefined;
        mediaUrl = undefined;
    };

    const createIcon = (): HTMLElement => h('span', {
        class: 'files-details-icon',
        children: [createFileIcon(category)],
    });

    // The icon until the thumbnail is ready, and again when this browser can't draw it.
    const face = h('span', { class: 'files-details-face', children: [createIcon()] });

    const loadThumbnailAsync = async (): Promise<void> => {
        const blob = await context.client.getThumbnailAsync(fileRef(record)).catch(() => undefined);
        if (blob == null || isClosed) {
            return;
        }

        const url = URL.createObjectURL(blob);
        thumbUrl = url;
        face.replaceChildren(createThumbImage({
            src: url,
            className: 'files-details-thumb',
            onBroken: () => {
                URL.revokeObjectURL(url);
                thumbUrl = undefined;
                face.replaceChildren(createIcon());
            },
        }));
    };

    // A received video or song that is stored whole, not damaged, in a format this browser plays.
    const canPlay = (category === 'video' || category === 'audio')
        && record.direction === 'in'
        && record.hasData
        && record.note !== 'damaged'
        && context.services.canPreview(record.mime, record.name);

    // The full-size viewer, for photos, videos and audio when the sheet was opened from a list.
    const createViewButton = (className: string): HTMLElement | undefined => {
        const { onView } = options;
        if (onView == null || !isPreviewCategory(category)) {
            return undefined;
        }

        const label = category === 'audio' ? `Open ${record.name} in the viewer` : `View ${record.name} full size`;

        return h('button', {
            class: className,
            dataset: { action: 'view' },
            attrs: { 'type': 'button', 'aria-label': label },
            children: [face],
            on: {
                click: () => {
                    sheet.close();
                    onView();
                },
            },
        });
    };

    const showMessage = (preview: HTMLElement, message: string): void => {
        preview.dataset.state = 'message';
        preview.replaceChildren(createIcon(), h('p', { class: 'files-details-message', text: message }));
    };

    const createPlayer = (preview: HTMLElement, src: string): HTMLMediaElement => {
        const player = category === 'video'
            ? h('video', {
                class: 'files-details-video',
                attrs: {
                    'src': src,
                    'poster': thumbUrl,
                    'controls': true,
                    'playsinline': true,
                    'preload': 'metadata',
                    'aria-label': record.name,
                },
            })
            : h('audio', {
                class: 'files-details-audio',
                attrs: { 'src': src, 'controls': true, 'preload': 'metadata', 'aria-label': record.name },
            });
        // A file this browser turns out not to play gives way to the icon, never to a broken player.
        player.addEventListener('error', () => {
            if (!isClosed) {
                showMessage(preview, CANNOT_PLAY_TEXT);
            }
        });

        return player;
    };

    const playAsync = async (preview: HTMLElement, play: HTMLButtonElement): Promise<void> => {
        play.disabled = true;
        play.setAttribute('aria-busy', 'true');
        let file: File;
        try {
            file = await context.client.getReceivedFileAsync(fileRef(record));
        } catch (error) {
            if (!isClosed) {
                const message = isVerifyFailed(error)
                    ? reportDamaged(context, record.name, record.sessionId)
                    : CANNOT_OPEN_TEXT;
                showMessage(preview, message);
            }

            return;
        }

        if (isClosed) {
            return;
        }

        mediaUrl = URL.createObjectURL(file);
        const player = createPlayer(preview, mediaUrl);
        preview.dataset.state = 'playing';
        preview.replaceChildren(...(category === 'audio' ? [createIcon(), player] : [player]));
        player.focus();
        // Started by the tap; where the browser wants a tap of its own, its controls take it.
        void player.play().catch(() => undefined);
    };

    const createPreview = (): HTMLElement => {
        if (record.hasThumbnail) {
            void loadThumbnailAsync();
        }

        if (!canPlay) {
            return createViewButton('files-details-preview')
                ?? h('div', { class: 'files-details-preview', children: [face] });
        }

        const play = h('button', {
            class: 'files-details-play',
            html: ICONS.play,
            dataset: { action: 'play' },
            attrs: { 'type': 'button', 'aria-label': `Play ${record.name}` },
        });
        const preview = h('div', {
            class: 'files-details-preview',
            dataset: { category },
            children: [createViewButton('files-details-view') ?? face, play],
        });
        play.addEventListener('click', () => {
            void playAsync(preview, play);
        });

        return preview;
    };

    const sheet = openFilesSheet({
        context,
        title: record.name,
        className: 'files-details',
        children: [
            createPreview(),
            h('dl', {
                class: 'file-details',
                children: [...describe(context, record), ...(sha256 == null ? [] : [sha256.term, sha256.detail])],
            }),
            buttons.length === 0 ? null : h('div', { class: 'files-sheet-actions', children: buttons }),
        ],
        onClose: () => {
            isClosed = true;
            sha256?.dispose();
            releaseUrls();
        },
    });
}
