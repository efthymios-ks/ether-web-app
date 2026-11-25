import { afterEach, describe, expect, it } from 'vitest';
import type { FileRecord } from '../../client/clientTypes.js';
import { createTestApp } from '../testing/appHarness.js';
import type { TestApp } from '../testing/appHarness.js';
import { createFileRecord } from '../testing/fakeClient.js';
import { needsFileHint, needsFileText, noteFor, pausedText, rowActionsFor } from './fileRow.js';

// The action table and the wording every file row shares (§7.6).

let harness: TestApp | undefined;

function actionIds(record: FileRecord, isConnected = true): string[] {
    harness = createTestApp();
    if (isConnected) {
        harness.client.connect();
    }

    return rowActionsFor(record, harness.app.context).map(action => action.id);
}

describe('row actions', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
    });

    it('tells the sender which file to pick again and from where, and lets it delete what arrived (§7.4, test 9)', () => {
        // Arrange
        const record = createFileRecord({
            state: 'needs-file',
            pagination: { pageSize: 1_048_576, totalPages: 2048, currentPage: 1312, pagesDone: 1312, slot: null },
        });

        // Act
        const ids = actionIds(record);

        // Assert
        expect(needsFileText(record)).toBe('Pick IMG_2231.MOV again to resume from page 1312 of 2048 (64%).');
        expect(needsFileHint(record)).toBe('Pick it again to resume from page 1312 of 2048 (64%).');
        expect(ids).toEqual(['pick-again', 'cancel', 'delete-partial']);
    });

    it('offers Resume and Delete partial for a stopped file, and says where it stopped and that what arrived is kept', () => {
        // Arrange
        const record = createFileRecord({
            state: 'paused',
            pausedBy: 'stop',
            pagination: { pageSize: 1_048_576, totalPages: 2048, currentPage: 1312, pagesDone: 1312, slot: null },
        });

        // Act
        const ids = actionIds(record);
        const note = harness == null ? undefined : noteFor(record, 'Pixel 8', harness.app.context);

        // Assert
        expect(ids).toEqual(['resume', 'delete-partial']);
        expect(note).toBe('Stopped at page 1312 of 2048 (64%). What arrived is kept; Resume continues from there.');
    });

    it('offers Cancel instead of Delete partial for a stopped file nothing of which arrived, and Resume only while connected', () => {
        // Arrange
        const record = createFileRecord({ direction: 'in', state: 'paused', pausedBy: 'stop' });

        // Act
        const connected = actionIds(record);
        harness?.dispose();
        const offline = actionIds(record, false);
        const note = harness == null ? undefined : noteFor(record, 'Pixel 8', harness.app.context);

        // Assert
        expect(connected).toEqual(['resume', 'cancel']);
        expect(offline).toEqual(['cancel']);
        expect(note).toBe('Stopped before any of it arrived. Resume sends it.');
    });

    it('offers Pause and Cancel while sending', () => {
        // Arrange
        const record = createFileRecord({ state: 'active' });

        // Act
        const ids = actionIds(record);

        // Assert
        expect(ids).toEqual(['pause', 'cancel']);
    });

    it('offers Send again and Details for a skipped file (§7.5, test 12)', () => {
        // Arrange
        const record = createFileRecord({ state: 'done', note: 'already-on-peer' });

        // Act
        const ids = actionIds(record);

        // Assert
        expect(ids).toEqual(['send-again', 'details']);
    });

    it('offers Delete and Details for received files not downloaded yet (§9)', () => {
        // Arrange
        const record = createFileRecord({ direction: 'in', state: 'done', hasData: true, name: 'IMG_2230.HEIC', mime: 'image/heic', kind: 'image' });

        // Act
        const ids = actionIds(record, false);

        // Assert
        expect(ids).toEqual(['delete', 'details']);
    });

    it('lets the receiver delete a paused partial, and says why it is paused (§7.6)', () => {
        // Arrange
        const record = createFileRecord({
            direction: 'in',
            state: 'paused',
            pausedBy: 'link',
            pagination: { pageSize: 1_048_576, totalPages: 10, currentPage: 4, pagesDone: 4, slot: null },
        });

        // Act
        const ids = actionIds(record, false);

        // Assert
        expect(pausedText(record, 'Pixel 8')).toBe('Paused: connection lost');
        expect(pausedText({ ...record, pausedBy: 'peer' }, 'Pixel 8')).toBe('Paused by Pixel 8');
        expect(ids).toEqual(['cancel', 'delete-partial']);
    });

    it('offers Accept and Decline for a file waiting under Ask before receiving (SP-07)', () => {
        // Arrange
        const record = createFileRecord({ direction: 'in', state: 'incoming' });

        // Act
        const ids = actionIds(record);

        // Assert
        expect(ids).toEqual(['accept', 'decline']);
    });

    it('says where a moved file went, and offers nothing for it', () => {
        // Arrange
        harness = createTestApp();
        harness.client.connect();
        const record = createFileRecord({ sessionId: 'session-old', state: 'canceled', note: 'moved' });

        // Act
        const note = noteFor(record, 'iPhone · Old Fox', harness.app.context);

        // Assert
        expect(note).toBe('Moved to Pixel 8 · Blue Otter');
        expect(rowActionsFor(record, harness.app.context)).toEqual([]);
    });
});
