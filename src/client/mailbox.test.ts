import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mailbox, TIMED_OUT } from './mailbox.js';

describe('Mailbox', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('hands out queued items in order, then waits for the next one', async () => {
        // Arrange
        const mailbox = new Mailbox<number>();
        mailbox.push(1);
        mailbox.push(2);

        // Act
        const first = await mailbox.nextAsync();
        const second = await mailbox.nextAsync();
        const third = mailbox.nextAsync();
        mailbox.push(3);

        // Assert
        expect([first, second, await third]).toEqual([1, 2, 3]);
    });

    it('times out a read and ignores the late item until the next read', async () => {
        // Arrange
        const mailbox = new Mailbox<string>();

        // Act
        const read = mailbox.nextAsync(1000);
        vi.advanceTimersByTime(1000);
        const result = await read;
        mailbox.push('late');

        // Assert
        expect(result).toBe(TIMED_OUT);
        expect(await mailbox.nextAsync()).toBe('late');
    });

    it('rejects the waiting and later reads once closed', async () => {
        // Arrange
        const mailbox = new Mailbox<string>();
        const read = mailbox.nextAsync();

        // Act
        mailbox.close(new Error('stopped'));

        // Assert
        await expect(read).rejects.toThrow('stopped');
        await expect(mailbox.nextAsync()).rejects.toThrow('stopped');
        expect(mailbox.isClosed).toBe(true);
    });
});
