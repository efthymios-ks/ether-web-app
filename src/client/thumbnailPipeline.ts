import type { Logger } from '../core/logger.js';
import { formatBytes } from '../core/settings.js';
import type { Link } from './transferContext.js';

// TH-02: thumbnails run ahead of the file data on their own, at most two made at a time and each sent as soon as
// it is made, so nothing is kept after sending. The only brake is the control channel: above 256 KiB queued they
// wait until it drains, so pings are never delayed (§4).

export const CONTROL_BUFFER_LIMIT = 256 * 1024;
const MAKE_CONCURRENCY = 2;
const DRAIN_POLL_MS = 20;

export interface ThumbnailJob {
    // The session the file belongs to: its thumbnail only ever goes to that device.
    readonly sessionId: string;
    readonly fileId: string;
    readonly name: string;
    // Makes or loads the thumbnail; undefined when the file has none, and the receiver is told so.
    makeAsync(): Promise<Blob | undefined>;
}

export interface ThumbnailPipelineOptions {
    // The link to send on; undefined while it is down, and the jobs then wait for pump().
    readonly link: () => Link | undefined;
    readonly logger: Logger;
    readonly concurrency?: number;
    readonly bufferLimit?: number;
    readonly pollMs?: number;
}

export interface ThumbnailPipeline {
    add(job: ThumbnailJob): void;
    // Starts again once the link is back.
    pump(): void;
    // Drops the jobs of every other session and returns them.
    retain(sessionId: string): ThumbnailJob[];
    // Drops the jobs of one session.
    removeSession(sessionId: string): void;
    clear(): void;
    readonly pending: number;
}

export function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode(...bytes.subarray(index, index + step));
    }

    return btoa(binary);
}

export function createThumbnailPipeline(options: ThumbnailPipelineOptions): ThumbnailPipeline {
    const concurrency = options.concurrency ?? MAKE_CONCURRENCY;
    const bufferLimit = options.bufferLimit ?? CONTROL_BUFFER_LIMIT;
    const pollMs = options.pollMs ?? DRAIN_POLL_MS;
    const queue: ThumbnailJob[] = [];
    let running = 0;
    let generation = 0;
    let isHeld = false;

    const waitForRoomAsync = async (): Promise<Link | undefined> => {
        for (;;) {
            const link = options.link();
            if (!link) {
                return undefined;
            }

            const buffered = link.network.bufferedAmount('control');
            if (buffered <= bufferLimit) {
                if (isHeld) {
                    isHeld = false;
                    options.logger.debug('xfer', 'thumbnails flowing again');
                }

                return link;
            }

            if (!isHeld) {
                isHeld = true;
                options.logger.debug('xfer', `thumbnails held: control has ${formatBytes(buffered)} queued`);
            }

            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
    };

    // Returns false when the link went away and the job should wait for the next pump.
    const runAsync = async (job: ThumbnailJob, started: number): Promise<boolean> => {
        if (!await waitForRoomAsync()) {
            return false;
        }

        const thumbnail = await job.makeAsync();
        if (started !== generation) {
            return true;
        }

        const link = await waitForRoomAsync();
        if (!link) {
            return false;
        }

        if (!thumbnail) {
            if (link.sessionId !== job.sessionId) {
                return false;
            }

            link.send('control', { t: 'thumb', fileId: job.fileId, none: true });

            return true;
        }

        if (link.sessionId !== job.sessionId) {
            return false;
        }

        const jpeg = encodeBase64(new Uint8Array(await thumbnail.arrayBuffer()));
        link.send('control', { t: 'thumb', fileId: job.fileId, jpeg });

        return true;
    };

    const pump = (): void => {
        while (running < concurrency) {
            const sessionId = options.link()?.sessionId;
            const index = queue.findIndex(candidate => candidate.sessionId === sessionId);
            if (sessionId == null || index < 0) {
                return;
            }

            const [job] = queue.splice(index, 1) as [ThumbnailJob];
            const started = generation;
            running++;
            void runAsync(job, started)
                .then(isFinished => {
                    if (!isFinished && started === generation) {
                        queue.unshift(job);
                    }
                })
                .catch(error => options.logger.warn('xfer', `${job.name} thumbnail not sent`, error))
                .finally(() => {
                    running--;
                    pump();
                });
        }
    };

    return {
        add: job => {
            queue.push(job);
            pump();
        },
        pump,
        removeSession: sessionId => {
            const kept = queue.filter(job => job.sessionId !== sessionId);
            queue.splice(0, queue.length, ...kept);
        },
        retain: sessionId => {
            const dropped = queue.filter(job => job.sessionId !== sessionId);
            const kept = queue.filter(job => job.sessionId === sessionId);
            queue.splice(0, queue.length, ...kept);

            return dropped;
        },
        clear: () => {
            generation++;
            queue.splice(0);
        },
        get pending() {
            return queue.length + running;
        },
    };
}
