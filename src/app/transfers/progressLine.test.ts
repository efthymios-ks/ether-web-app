import { afterEach, describe, expect, it } from 'vitest';
import type { FileRecord, ProgressInfo } from '../../client/clientTypes.js';
import { createTestApp, settleAsync } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createFileRecord } from '../testing/fakeClient.js';
import { createFileActions } from './fileActions.js';
import type { FileActions } from './fileActions.js';
import { createProgressLine, lineStatus } from './progressLine.js';
import type { ProgressLine } from './progressLine.js';

// A file of the progress view: "name (size)" with Done, Queue, Checking… and the exceptions, or its bar.

let harness: TestApp | undefined;

const PEER = 'Pixel 8 · Blue Otter';

function progressOf(record: FileRecord, overrides: Partial<ProgressInfo> = {}): ProgressInfo {
    return {
        fileId: record.fileId,
        sessionId: record.sessionId,
        direction: record.direction,
        pagesDone: 1340,
        totalPages: 2048,
        bytesDone: 1340 * 1_048_576,
        size: record.size,
        percent: 65.4,
        bytesPerSecond: 28_000_000,
        secondsLeft: 25,
        ...overrides,
    };
}

function renderLine(
    record: FileRecord,
    options: {
        readonly progress?: ProgressInfo;
        readonly isNeedsPick?: boolean;
        readonly actions?: Partial<FileActions>;
        // What the client's thumbnail store holds, from before the line is drawn.
        readonly thumbnail?: () => Blob;
    } = {},
): ProgressLine {
    harness = createTestApp();
    if (options.thumbnail != null) {
        harness.client.behaviour.thumbnail = options.thumbnail;
    }

    harness.client.connect();
    const context = harness.app.context;
    const line = createProgressLine({
        context,
        actions: { ...createFileActions(context), ...options.actions },
        ...(options.isNeedsPick == null ? {} : { isNeedsPick: options.isNeedsPick }),
    });
    line.update(record, options.progress);
    document.body.append(line.element);

    return line;
}

describe('progress line words', () => {
    it.each([
        [createFileRecord({ state: 'done' }), 'Done', 'ok'],
        [createFileRecord({ state: 'queued' }), 'Queue', 'muted'],
        [createFileRecord({ state: 'queued', metadata: { latitude: 37.97, longitude: 23.72 } }), 'Queue · Location included', 'muted'],
        [createFileRecord({ state: 'verifying', note: 'check-waiting' }), 'Waiting to check', 'muted'],
        [createFileRecord({ state: 'verifying', note: 'checking' }), 'Checking…', 'accent'],
        [createFileRecord({ state: 'done', note: 'already-on-peer' }), `Skipped · already on ${PEER}`, 'muted'],
        [createFileRecord({ state: 'paused', pausedBy: 'link' }), 'Paused: connection lost', 'warn'],
        [createFileRecord({ state: 'paused', pausedBy: 'stop' }), 'Stopped', 'warn'],
        [createFileRecord({
            state: 'queued',
            pagination: { pageSize: 1_048_576, totalPages: 2048, currentPage: 1312, pagesDone: 1312, slot: null },
        }), 'Resuming from 64%', 'muted'],
        [createFileRecord({ state: 'needs-file' }), 'Needs picking again', 'warn'],
        [createFileRecord({ state: 'failed' }), 'Failed', 'fail'],
        [createFileRecord({ state: 'canceled' }), 'Cancelled', 'muted'],
        [createFileRecord({ state: 'canceled', note: 'declined' }), `Declined by ${PEER}`, 'muted'],
        [createFileRecord({ direction: 'in', state: 'incoming' }), 'Waiting for you to accept', 'muted'],
        [createFileRecord({ direction: 'in', state: 'done', note: 'damaged' }), 'Damaged', 'fail'],
    ] as ReadonlyArray<readonly [FileRecord, string, string]>)('says %#: "%s"', (record, text, tone) => {
        // Act
        const shown = lineStatus(record, PEER);

        // Assert
        expect(shown.text).toBe(text);
        expect(shown.tone).toBe(tone);
        expect(shown.isMoving).toBe(false);
    });

    it('moves while sending or receiving, with the spinner only for the file being checked', () => {
        // Act
        const sending = lineStatus(createFileRecord({ state: 'active' }), PEER);
        const checking = lineStatus(createFileRecord({ state: 'verifying', note: 'checking' }), PEER);

        // Assert
        expect(sending).toEqual({ text: 'Sending', tone: 'accent', isMoving: true, isChecking: false });
        expect(checking.isChecking).toBe(true);
        expect(checking.isMoving).toBe(false);
    });
});

describe('progress line', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('shows "name (size)" and the status words, the bar hidden', () => {
        // Arrange
        const record = createFileRecord({ state: 'done', size: 2_000_000 });

        // Act
        const line = renderLine(record);

        // Assert
        expect(line.element.querySelector('.line-name')?.textContent).toBe('IMG_2231.MOV');
        expect(line.element.querySelector('.line-size')?.textContent).toBe(' (2.0 MB)');
        expect(line.element.querySelector('.line-words')?.textContent).toBe('Done');
        expect(line.element.dataset.tone).toBe('ok');
        expect(line.element.querySelector<HTMLElement>('[role="progressbar"]')?.hidden).toBe(true);
    });

    it('shows a moving file’s bar with its percent, page X of Y, speed and time left (TR-10)', () => {
        // Arrange
        const record = createFileRecord({ state: 'active' });

        // Act
        const line = renderLine(record, { progress: progressOf(record) });

        // Assert
        expect(line.element.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('65');
        expect(line.element.querySelector<HTMLElement>('.line-status')?.hidden).toBe(true);
        expect(line.element.querySelector('.line-detail')?.textContent).toBe('65% · page 1340 of 2048 · 28.0 MB/s · 25 s left');
    });

    it('swaps the icon for a thumbnail made after the file finished', async () => {
        // Arrange
        const record = createFileRecord({ direction: 'in', state: 'done', name: 'IMG_2231.PNG', mime: 'image/png' });
        const line = renderLine(record);
        const { client } = harness as TestApp;
        const before = line.element.querySelector('.file-thumb .file-icon') != null;
        client.behaviour.thumbnail = () => new Blob(['thumb'], { type: 'image/jpeg' });

        // Act
        client.emit('thumb', record.fileId, record.sessionId);
        await settleAsync();

        // Assert
        expect(before).toBe(true);
        expect(line.element.querySelector('.file-thumb .file-thumb-image')).not.toBeNull();
    });

    it('shows a received photo’s thumbnail made before the line was drawn, though its record doesn’t flag it', async () => {
        // Arrange
        const record = createFileRecord({
            direction: 'in',
            state: 'done',
            name: 'IMG_2231.PNG',
            mime: 'image/png',
            kind: 'image',
            hasThumbnail: false,
        });

        // Act
        const line = renderLine(record, { thumbnail: () => new Blob(['thumb'], { type: 'image/jpeg' }) });
        await settleAsync();

        // Assert
        expect(line.element.querySelector('.file-thumb .file-thumb-image')).not.toBeNull();
        expect(line.element.querySelector('.file-thumb .file-icon')).toBeNull();
    });

    it('keeps the icon of a document, without asking for a thumbnail it can’t have', async () => {
        // Arrange
        const record = createFileRecord({
            direction: 'in',
            state: 'done',
            name: 'Contract.pdf',
            mime: 'application/pdf',
            kind: 'other',
            hasThumbnail: false,
        });

        // Act
        const line = renderLine(record, { thumbnail: () => new Blob(['thumb'], { type: 'image/jpeg' }) });
        await settleAsync();

        // Assert
        expect(line.element.querySelector('.file-thumb .file-icon')?.getAttribute('data-category')).toBe('document');
        expect((harness as TestApp).client.callsTo('getThumbnailAsync')).toEqual([]);
    });

    it('keeps the details to moving files: a queued or finished one says only its state', () => {
        // Arrange
        const record = createFileRecord({ state: 'active' });
        const line = renderLine(record, { progress: progressOf(record) });

        // Act
        line.update({ ...record, state: 'done' });

        // Assert
        expect(line.element.querySelector<HTMLElement>('.line-detail')?.hidden).toBe(true);
        expect(line.element.querySelector('.line-words')?.textContent).toBe('Done');
        expect(line.element.querySelector<HTMLElement>('.line-status')?.hidden).toBe(false);
    });

    it('never moves its bar backwards after a resume', () => {
        // Arrange
        const record = createFileRecord({ state: 'active' });
        const line = renderLine(record, { progress: progressOf(record, { percent: 60 }) });

        // Act
        line.setProgress(progressOf(record, { percent: 40 }));

        // Assert
        expect(line.element.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
    });

    it('truncates long names in the middle, with the whole name and folder in its tooltip and accessible name (UI-09)', () => {
        // Arrange
        const name = 'A very long holiday video name that keeps going and going.MOV';
        const record = createFileRecord({ name, relativePath: `Trip/${name}`, state: 'queued', size: 2_000_000 });

        // Act
        const line = renderLine(record);
        const label = line.element.querySelector<HTMLElement>('.line-name');
        const open = line.element.querySelector<HTMLButtonElement>('.line-open');

        // Assert
        expect(label?.textContent?.endsWith('.MOV')).toBe(true);
        expect(label?.textContent?.length).toBeLessThanOrEqual(44);
        expect(open?.title).toBe(`Trip/${name}`);
        expect(open?.getAttribute('aria-label')).toBe(`Trip/${name} (2.0 MB), Queue. Actions`);
    });

    it('opens the file’s actions as the row ⋯ sheet on a tap: Pause and Cancel while it moves', async () => {
        // Arrange
        const record = createFileRecord({ state: 'active' });
        const line = renderLine(record);

        // Act
        line.element.querySelector<HTMLButtonElement>('.line-open')?.click();
        await settleAsync();
        const sheet = document.querySelector('.files-row-menu');

        // Assert
        expect([...(sheet?.querySelectorAll<HTMLButtonElement>('[data-action]') ?? [])].map(button => button.dataset.action))
            .toEqual(['pause', 'cancel']);
    });

    it('says where a file needing picking resumes, with its own Pick button (PK-05)', () => {
        // Arrange
        let picks = 0;
        const record = createFileRecord({
            state: 'needs-file',
            pagination: { pageSize: 1_048_576, totalPages: 2048, currentPage: 1312, pagesDone: 1312, slot: null },
        });
        const line = renderLine(record, { isNeedsPick: true, actions: { pickAgain: () => picks++ } });

        // Act
        line.element.querySelector<HTMLButtonElement>('[data-action="pick-again"]')?.click();

        // Assert
        expect(line.element.querySelector('.line-words')?.textContent).toBe('Pick it again to resume from page 1312 of 2048 (64%).');
        expect(line.element.querySelector('[data-action="pick-again"]')?.getAttribute('aria-label')).toBe('Pick IMG_2231.MOV again');
        expect(picks).toBe(1);
    });

    it('changes in place, keeping its elements while the file moves and ends', () => {
        // Arrange
        const record = createFileRecord({ state: 'active' });
        const line = renderLine(record, { progress: progressOf(record, { percent: 10 }) });
        const open = line.element.querySelector('.line-open');
        const bar = line.element.querySelector('[role="progressbar"]');

        // Act
        line.setProgress(progressOf(record, { percent: 50 }));
        line.update({ ...record, state: 'done' });

        // Assert
        expect(line.element.querySelector('.line-open')).toBe(open);
        expect(line.element.querySelector('[role="progressbar"]')).toBe(bar);
        expect(line.element.querySelector('.line-words')?.textContent).toBe('Done');
    });
});
