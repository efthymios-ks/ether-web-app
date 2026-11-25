import { UNFINISHED_STATES } from '../../client/clientTypes.js';
import type { FileRecord, ProgressInfo } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { categoryOf, createFileIcon, createThumbImage } from '../fileIcon.js';
import { formatPercent, formatShortWhen, formatSize } from '../format.js';
import { ICONS } from '../icons.js';
import type { FileActions } from '../transfers/fileActions.js';
import { peerNameFor } from '../transfers/fileErrors.js';
import { fileRef } from '../transfers/fileRef.js';
import { createRowCheck, NAME_LENGTH, progressOf } from '../transfers/fileRow.js';
import type { FileRow, RowSelectable } from '../transfers/fileRow.js';
import { createProgressMemory, exceptionStatus, isDownloaded, listStatus, percentOf } from '../transfers/fileStatus.js';
import { hasRowMenu, openRowMenu } from './rowMenu.js';

// One row of the Sent and Received lists (§4.5): a 40 px thumbnail or the file's category icon, the name on one
// line (UI-09) and one meta line, size · date, then the status only when it is an exception: Failed, Damaged
// (in red), "Skipped · already on <peer>", Paused, Not sent yet, and Downloaded with a ✓. Sent and Not downloaded
// yet go unsaid. A moving file shows its status, its own bar and its percent instead. Tapping a finished row
// opens its Details; the row's actions sit behind its single ⋯, as a sheet. Every part is updated in place.

// The fixed height of a row, also the virtualised height; the stylesheet's .gallery-list .file-row matches it.
export const LIST_ROW_HEIGHT = 56;

export interface GalleryRowOptions {
    readonly context: AppContext;
    readonly actions: FileActions;
    readonly selectable: RowSelectable;
    readonly onDetails: (record: FileRecord) => void;
}

export function createGalleryRow(options: GalleryRowOptions): FileRow {
    const { context, actions } = options;
    const thumb = h('span', { class: 'file-thumb', attrs: { 'aria-hidden': 'true' } });
    const name = h('span', { class: 'file-name' });
    const meta = h('span', { class: 'file-meta' });
    const status = h('span', { class: 'file-list-status', attrs: { hidden: true } });
    const fill = h('span', { class: 'progress-fill' });
    // A moving file's own bar, between its status and its percent.
    const bar = h('span', {
        class: 'progress-bar',
        attrs: { 'role': 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'hidden': true },
        children: [fill],
    });
    const memory = createProgressMemory();
    const open = h('button', {
        class: 'file-open',
        attrs: { type: 'button' },
        children: [
            thumb,
            h('span', {
                class: 'file-lines',
                children: [name, h('span', { class: 'file-meta-line', children: [meta, status, bar] })],
            }),
        ],
        on: { click: event => openRow(event as MouseEvent) },
    });
    const more = h('button', {
        class: 'icon-button file-more',
        html: ICONS.more,
        dataset: { action: 'more' },
        attrs: { 'type': 'button', 'aria-haspopup': 'dialog' },
        on: { click: () => openMenu() },
    });
    let current: FileRecord | undefined;
    const check = createRowCheck(isShift => {
        if (current != null) {
            options.selectable.pick(current, isShift);
        }
    });
    const element = h('li', { class: 'file-row', children: [check.element, open, more] });
    let shownStatus = '';
    let thumbFor = '';
    let thumbUrl: string | undefined;
    let isDisposed = false;

    const releaseThumb = (): void => {
        if (thumbUrl != null) {
            URL.revokeObjectURL(thumbUrl);
            thumbUrl = undefined;
        }
    };

    const loadThumbAsync = async (record: FileRecord, key: string): Promise<void> => {
        const blob = await context.client.getThumbnailAsync(fileRef(record)).catch(() => undefined);
        if (blob == null || isDisposed || key !== thumbFor) {
            return;
        }

        releaseThumb();
        thumbUrl = URL.createObjectURL(blob);
        thumb.replaceChildren(createThumbImage({
            src: thumbUrl,
            className: 'file-thumb-image',
            onBroken: () => showIcon(record),
        }));
    };

    // The category's fixed icon, for a file without a thumbnail or one this browser can't draw.
    const showIcon = (record: FileRecord): void => {
        releaseThumb();
        thumb.replaceChildren(createFileIcon(categoryOf(record)));
    };

    const openMenu = (): void => {
        const record = current;
        if (record == null) {
            return;
        }

        openRowMenu({ context, actions, record: () => current ?? record, onDetails: options.onDetails });
    };

    const openRow = (event: MouseEvent): void => {
        if (current == null) {
            return;
        }

        // While selecting, the row picks itself instead of opening.
        if (check.isSelecting) {
            options.selectable.pick(current, event.shiftKey);

            return;
        }

        if (current.state === 'done' && current.note !== 'moved') {
            options.onDetails(current);

            return;
        }

        openMenu();
    };

    // The exception's word in its colour, with a ✓ before Downloaded; changed only when it changes.
    const showStatus = (text: string | undefined, tone: string, isDone: boolean): void => {
        const key = text == null ? '' : `${tone}:${isDone}:${text}`;
        if (key === shownStatus) {
            return;
        }

        shownStatus = key;
        status.hidden = text == null;
        status.dataset.tone = tone;
        status.replaceChildren(
            ...(isDone ? [h('span', { class: 'file-list-done', html: ICONS.check })] : []),
            text ?? '',
        );
    };

    const update = (record: FileRecord, progress?: ProgressInfo): void => {
        current = record;
        element.dataset.state = record.state;
        element.dataset.direction = record.direction;
        name.textContent = context.services.truncateMiddle(record.name, NAME_LENGTH);

        const peer = peerNameFor(context, record.sessionId);
        const isUnfinished = UNFINISHED_STATES.includes(record.state);
        const fullStatus = listStatus(record, peer);
        const shown = exceptionStatus(record, peer);
        const moving = memory.show(record, progressOf(record, progress));
        const isMoving = isUnfinished && moving != null;
        const when = record.completedAt ?? record.updatedAt;
        const metaText = isMoving
            ? formatPercent(percentOf(moving))
            : `${formatSize(record.size)} · ${formatShortWhen(when)}`;
        meta.textContent = metaText;
        showStatus(shown?.text, shown?.tone ?? 'muted', isDownloaded(record));
        element.dataset.moving = String(isMoving);
        bar.hidden = !isMoving;
        if (isMoving) {
            const percent = percentOf(moving);
            fill.style.setProperty('--progress', `${percent}%`);
            bar.setAttribute('aria-valuenow', String(Math.round(percent)));
            bar.setAttribute('aria-label', `${record.name}: ${formatPercent(percent)}`);
        }

        // The visible name is shortened; screen readers get it whole with its full status, plain or not, and
        // what tapping does.
        const opensDetails = record.state === 'done' && record.note !== 'moved';
        const tapAction = check.isSelecting ? 'Select' : (opensDetails ? 'Details' : 'Actions');
        open.setAttribute('aria-label', `${record.name}, ${metaText}, ${fullStatus.text}. ${tapAction}`);
        open.title = record.relativePath ?? record.name;
        more.setAttribute('aria-label', `More actions: ${record.name}`);
        more.hidden = check.isSelecting || !hasRowMenu(record, context);

        const key = `${record.sessionId}/${record.direction}/${record.fileId}`;
        if (key !== thumbFor) {
            thumbFor = key;
            showIcon(record);
            if (record.hasThumbnail) {
                void loadThumbAsync(record, key);
            }
        }
    };

    return {
        element,
        update,
        setProgress: progress => {
            const shown = current;
            if (shown != null && shown.sessionId === progress.sessionId && shown.direction === progress.direction
                && shown.fileId === progress.fileId) {
                update(shown, progress);
            }
        },
        setSelection: (isSelecting, isSelected) => {
            element.dataset.selecting = String(isSelecting);
            check.set(isSelecting, isSelected, current?.name ?? '');
            if (current != null) {
                update(current);
            }
        },
        refreshThumbnail: () => {
            if (current != null && thumbUrl == null) {
                void loadThumbAsync(current, thumbFor);
            }
        },
        dispose: () => {
            isDisposed = true;
            releaseThumb();
        },
    };
}
