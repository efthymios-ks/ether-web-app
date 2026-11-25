import { describe, expect, it } from 'vitest';
import type { FileRecord, FileState } from '../../client/clientTypes.js';
import { createFileRecord } from '../testing/fakeClient.js';
import { createProgressMemory, exceptionStatus, fileStatus, isDownloaded, isPlainFinish, listStatus } from './fileStatus.js';

function statusFor(direction: 'in' | 'out', state: FileState, overrides: Partial<FileRecord> = {}): string {
    const status = fileStatus(createFileRecord({ direction, state, ...overrides }), 'Pixel 8');

    return `${status.text}/${status.tone}`;
}

function listStatusFor(direction: 'in' | 'out', state: FileState, overrides: Partial<FileRecord> = {}): string {
    const status = listStatus(createFileRecord({ direction, state, ...overrides }), 'Pixel 8');

    return `${status.text}/${status.tone}`;
}

describe('fileStatus', () => {
    it('words every sending state with a status colour', () => {
        // Act & Assert
        expect(statusFor('out', 'queued')).toBe('Not sent yet/muted');
        expect(statusFor('out', 'offered')).toBe('Not sent yet/muted');
        expect(statusFor('out', 'active')).toBe('Sending/accent');
        expect(statusFor('out', 'verifying')).toBe('Sending/accent');
        expect(statusFor('out', 'done')).toBe('Sent/ok');
        expect(statusFor('out', 'paused')).toBe('Paused/warn');
        expect(statusFor('out', 'needs-file')).toBe('Needs picking again/warn');
        expect(statusFor('out', 'failed')).toBe('Failed/fail');
        expect(statusFor('out', 'canceled')).toBe('Cancelled/muted');
        expect(statusFor('out', 'done', { note: 'already-on-peer' })).toBe('Skipped · already on Pixel 8/muted');
        expect(statusFor('out', 'verifying', { note: 'checking' })).toBe('Checking…/accent');
        expect(statusFor('out', 'verifying', { note: 'check-waiting' })).toBe('Waiting to check/muted');
    });

    it('words every receiving state with a status colour', () => {
        // Act & Assert
        expect(statusFor('in', 'queued')).toBe('Waiting/muted');
        expect(statusFor('in', 'incoming')).toBe('Waiting/muted');
        expect(statusFor('in', 'active')).toBe('Receiving/accent');
        expect(statusFor('in', 'done')).toBe('Received/ok');
        expect(statusFor('in', 'paused')).toBe('Paused/warn');
        expect(statusFor('in', 'failed')).toBe('Failed/fail');
        expect(statusFor('in', 'canceled')).toBe('Cancelled/muted');
    });
});

describe('listStatus', () => {
    it('words a finished file by what happened to it after the transfer', () => {
        // Act & Assert
        expect(listStatusFor('out', 'done')).toBe('Sent/ok');
        expect(listStatusFor('out', 'done', { note: 'already-on-peer' }))
            .toBe('Skipped · already on Pixel 8/muted');
        expect(listStatusFor('in', 'done', { hasData: true })).toBe('Not downloaded yet/warn');
        expect(listStatusFor('in', 'done', { hasData: true, savedAt: 1 })).toBe('Downloaded/ok');
        expect(listStatusFor('in', 'done', { hasData: false })).toBe('Deleted from app/muted');
        expect(listStatusFor('in', 'done', { hasData: true, note: 'damaged' })).toBe('Damaged/fail');
        expect(listStatusFor('in', 'done', { note: 'moved' })).toBe('Moved/muted');
        expect(listStatusFor('out', 'failed')).toBe('Failed/fail');
        expect(listStatusFor('in', 'canceled')).toBe('Cancelled/muted');
    });

    it('words an unfinished file by its transfer, as fileStatus does', () => {
        // Act & Assert
        expect(listStatusFor('out', 'queued')).toBe('Not sent yet/muted');
        expect(listStatusFor('out', 'active')).toBe('Sending/accent');
        expect(listStatusFor('in', 'incoming')).toBe('Waiting/muted');
        expect(listStatusFor('in', 'paused')).toBe('Paused/warn');
    });
});

describe('exceptionStatus', () => {
    function shown(direction: 'in' | 'out', state: FileState, overrides: Partial<FileRecord> = {}): string {
        const status = exceptionStatus(createFileRecord({ direction, state, ...overrides }), 'Pixel 8');

        return status == null ? 'none' : `${status.text}/${status.tone}`;
    }

    it('says nothing at the plain end of a transfer: Sent, or Not downloaded yet', () => {
        // Act & Assert
        expect(shown('out', 'done')).toBe('none');
        expect(shown('in', 'done', { hasData: true })).toBe('none');
    });

    it('words every exception: Failed, Damaged, Skipped, Paused, Not sent yet and the rest', () => {
        // Act & Assert
        expect(shown('out', 'failed')).toBe('Failed/fail');
        expect(shown('in', 'done', { hasData: true, note: 'damaged' })).toBe('Damaged/fail');
        expect(shown('out', 'done', { note: 'already-on-peer' })).toBe('Skipped · already on Pixel 8/muted');
        expect(shown('in', 'paused')).toBe('Paused/warn');
        expect(shown('out', 'queued')).toBe('Not sent yet/muted');
        expect(shown('in', 'done', { hasData: true, savedAt: 1 })).toBe('Downloaded/ok');
        expect(shown('in', 'done', { hasData: false })).toBe('Deleted from app/muted');
        expect(shown('in', 'done', { note: 'moved' })).toBe('Moved/muted');
    });
});

describe('isPlainFinish and isDownloaded', () => {
    it('tells the plain end of a transfer and a downloaded copy apart from everything else', () => {
        // Arrange
        const records = [
            createFileRecord({ direction: 'out', state: 'done' }),
            createFileRecord({ direction: 'in', state: 'done', hasData: true }),
            createFileRecord({ direction: 'in', state: 'done', hasData: true, savedAt: 1 }),
            createFileRecord({ direction: 'in', state: 'done', hasData: true, savedAt: 1, note: 'damaged' }),
            createFileRecord({ direction: 'out', state: 'done', note: 'already-on-peer' }),
            createFileRecord({ direction: 'in', state: 'active' }),
        ];

        // Act
        const flags = records.map(record => [isPlainFinish(record), isDownloaded(record)]);

        // Assert
        expect(flags).toEqual([
            [true, false],
            [true, false],
            [false, true],
            [false, false],
            [false, false],
            [false, false],
        ]);
    });
});

describe('createProgressMemory', () => {
    it('never goes backwards after a resume, but starts over on a real restart', () => {
        // Arrange
        const memory = createProgressMemory();
        const record = createFileRecord({ state: 'active' });

        // Act
        memory.show(record, { pagesDone: 6, totalPages: 10, percent: 60 });
        const afterResume = memory.show(record, { pagesDone: 4, totalPages: 10, percent: 40 });
        const later = memory.show(record, { pagesDone: 7, totalPages: 10, percent: 70 });
        const restarted = memory.show({ ...record, note: 'restarted' }, { pagesDone: 1, totalPages: 10, percent: 10 });

        // Assert
        expect(afterResume?.percent).toBe(60);
        expect(later?.percent).toBe(70);
        expect(restarted?.percent).toBe(10);
    });
});
