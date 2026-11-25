import { formatBytes } from '../core/settings.js';
import type { SlotId } from '../network/networkTypes.js';
import { ClientError } from './clientTypes.js';
import type { FileNote } from './clientTypes.js';
import { HASH_BYTES, PageHashList, computeRootHashAsync, hashPageAsync, prefixHashAsync, readPageAsync, rootHashAsync, toHex } from './hashing.js';
import { Mailbox, TIMED_OUT } from './mailbox.js';
import { bytesForPages, countPages } from './pagination.js';
import { sanitizeMetadata } from './metadataSanitizer.js';
import type {
    AcceptMessage,
    AckMessage,
    DoneMessage,
    ErrorMessage,
    FileManifest,
    HaveMessage,
    NackMessage,
    OfferMessage,
    RejectMessage,
    WaitMessage,
} from './protocol.js';
import type { StoredFile, StoredPagination } from './storage.js';
import { emitFileState } from './transferContext.js';
import type { Link, TransferContext } from './transferContext.js';

// One outgoing file on one slot: offer → accept/have/reject → pages with page-end → ack/nack → file-end → done (TR-05).

// Pages sent ahead of their ack, so hashing and the receiver's write overlap with the next page.
export const PAGES_IN_FLIGHT = 2;
export const FRAME_FLAG_LAST_CHUNK = 1;
const PERSIST_INTERVAL_MS = 1000;
// §7.3: verifying → failed after one full retry.
const VERIFY_RETRIES = 1;
// An unanswered offer is sent once more, after this pause, before the file fails (CL-02).
const OFFER_RETRIES = 1;
const OFFER_RETRY_BACKOFF_MS = 1000;

export type SenderReply = AcceptMessage | HaveMessage | RejectMessage | WaitMessage | AckMessage | NackMessage | DoneMessage | ErrorMessage;

export type SendOutcome =
    | { readonly kind: 'done'; readonly record: StoredFile }
    | { readonly kind: 'failed'; readonly record: StoredFile; readonly error: ClientError; readonly isPeerAware: boolean }
    | { readonly kind: 'needs-file'; readonly record: StoredFile }
    | { readonly kind: 'paused-by-peer'; readonly record: StoredFile }
    | { readonly kind: 'stopped' };

export interface SendFileOptions {
    readonly context: TransferContext;
    readonly link: Link;
    readonly slot: SlotId;
    readonly file: File;
    readonly record: StoredFile;
    // "Send again" skips the receiver's already-received check.
    readonly again: boolean;
    // The file moved in an earlier connection, so the receiver's saved pages are expected (§7.4 step 4).
    readonly resume: boolean;
    // Resumed after a Stop, or picked again: the offer says so, so a receiver whose copy is stopped takes it.
    readonly resumed?: boolean;
    readonly batchId?: string;
    // The thumbnail will follow on control once the receiver accepts.
    readonly sendsThumbnail?: boolean;
    // Every change of the record, so the queue always holds the latest one.
    readonly onRecord: (record: StoredFile) => void;
    // The receiver accepted: it knows the file now, so its thumbnail can follow (TH-02).
    readonly onAccepted?: () => void;
}

export interface SendFileRun {
    readonly fileId: string;
    readonly slot: SlotId;
    deliver(message: SenderReply): void;
    // Stops at the next step; the caller decides the file's new state.
    stop(): void;
    // The record with the live pagination, for pausing.
    snapshot(): StoredFile;
    // Changes made elsewhere meanwhile (a thumbnail, a whole-file hash); the run's next save keeps them.
    amend(changes: Partial<StoredFile>): StoredFile;
    readonly outcome: Promise<SendOutcome>;
}

type SenderEvent =
    | { readonly kind: 'message'; readonly message: SenderReply }
    | { readonly kind: 'ack-timeout'; readonly page: number; readonly id: string };

interface OfferMode {
    readonly resume: boolean;
    readonly restart: boolean;
    readonly again: boolean;
}

interface PageWindow {
    readonly fromPage: number;
    readonly pageSize: number;
    readonly totalPages: number;
}

interface InFlightPage {
    readonly id: string;
    readonly hash: Uint8Array;
    readonly sentAt: number;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly bytes: number;
}

const NOTES_BY_REASON: Readonly<Partial<Record<RejectMessage['reason'], FileNote>>> = Object.freeze({
    space: 'no-space',
    declined: 'declined',
});

class StopSignal extends Error {
    override readonly name = 'StopSignal';
}

class FileUnreadable extends Error {
    override readonly name = 'FileUnreadable';
}

export function startSendFile(options: SendFileOptions): SendFileRun {
    const { context, link, slot, file } = options;
    const fileId = options.record.fileId;
    const mailbox = new Mailbox<SenderEvent>();
    const logger = context.logger.with({ sessionId: link.sessionId, connectionId: link.connectionId, fileId });
    const name = options.record.name;
    const size = options.record.size;
    let record = options.record;
    let hashes = new PageHashList();
    let live: { pageSize: number; totalPages: number; pagesDone: number } | undefined;
    let isStopped = false;
    let rejectStop: (error: unknown) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
        rejectStop = reject;
    });
    stopped.catch(() => undefined);

    const throwIfStopped = (): void => {
        if (isStopped) {
            throw new StopSignal();
        }
    };

    const untilStoppedAsync = async <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped]);

    const livePagination = (): StoredPagination | undefined => {
        if (!live) {
            return record.pagination;
        }

        return {
            pageSize: live.pageSize,
            totalPages: live.totalPages,
            currentPage: live.pagesDone,
            pagesDone: live.pagesDone,
            slot,
            lastConnectionId: link.connectionId,
            pageHashes: hashes.copy(),
        };
    };

    const detachedPagination = (): StoredPagination | undefined => {
        const pagination = livePagination();

        return pagination ? { ...pagination, slot: null } : undefined;
    };

    const snapshot = (): StoredFile => ({ ...record, pagination: detachedPagination() });

    const saveAsync = async (changes: Partial<StoredFile>, isVisible = true): Promise<void> => {
        record = { ...record, ...changes, updatedAt: context.now() };
        options.onRecord(record);
        try {
            await context.storage.putFileAsync(record);
        } catch (error) {
            logger.warn('store', `${name} file record not saved`, error);
        }

        if (isVisible) {
            emitFileState(context, record);
        }
    };

    const send = (message: Parameters<Link['send']>[1]): void => {
        if (!link.send(slot, message)) {
            throw new StopSignal();
        }
    };

    const manifestFor = (pageSize: number): FileManifest => {
        const metadata = sanitizeMetadata(record.metadata);

        return {
            fileId,
            ...(record.contentId == null ? {} : { contentId: record.contentId }),
            name,
            size,
            mime: record.mime,
            lastModified: record.lastModified,
            ...(record.relativePath == null ? {} : { relativePath: record.relativePath }),
            pageSize,
            totalPages: countPages(size, pageSize),
            ...(metadata ? { metadata } : {}),
            ...(options.sendsThumbnail ? { thumb: true } : {}),
        };
    };

    // The peer could not read a request at all: the file fails now with its reason, instead of after a timeout.
    const refusedBy = (message: ErrorMessage, what: string): ClientError => (
        new ClientError('invalid-state', `${link.peerName} could not read ${what} of ${name}: ${message.reason}`, fileId)
    );

    const delayAsync = (ms: number): Promise<void> => untilStoppedAsync(new Promise(resolve => setTimeout(resolve, ms)));

    const offerAsync = async (mode: OfferMode): Promise<AcceptMessage | HaveMessage | RejectMessage> => {
        const settings = context.settings();
        const pageSize = record.pagination?.pageSize ?? context.transferSettings().pageSize;
        await saveAsync({ state: 'offered', note: mode.restart ? 'restarted' : undefined });

        for (let attempt = 0; attempt <= OFFER_RETRIES; attempt++) {
            if (attempt > 0) {
                await delayAsync(OFFER_RETRY_BACKOFF_MS * attempt);
            }

            // Stopped while the record was written (Stop on its batch): the offer never goes.
            throwIfStopped();
            const id = context.randomId();
            const offer: OfferMessage = {
                t: 'offer',
                id,
                ...manifestFor(pageSize),
                ...(mode.resume ? { resume: true } : {}),
                ...(mode.restart ? { restart: true } : {}),
                ...(mode.again ? { again: true } : {}),
                ...(options.resumed ? { resumed: true } : {}),
                ...(options.batchId == null ? {} : { batchId: options.batchId }),
            };
            const result = link.trySend(slot, offer);
            if (result === 'closed') {
                throw new StopSignal();
            }

            // Over 64 KiB: the summary is the only part that can go; without it the offer always fits.
            if (result === 'too-large') {
                if (record.metadata == null) {
                    throw new ClientError('invalid-argument', `${name} is too large to offer`, fileId);
                }

                logger.warn('xfer', `${name} offer too large, sending it without its metadata summary`);
                await saveAsync({ metadata: undefined }, false);
                attempt--;
                continue;
            }

            logger.info('xfer', `${name} offer slot=${slot}${mode.resume ? ' resume' : ''}${mode.restart ? ' restart' : ''}`);

            let timeoutMs: number | undefined = settings.offerReplyTimeoutMs;
            for (;;) {
                const event = await mailbox.nextAsync(timeoutMs);
                if (event === TIMED_OUT) {
                    logger.warn('xfer', `${name} no reply to the offer after ${timeoutMs ?? 0} ms`);
                    break;
                }

                if (event.kind !== 'message' || event.message.re !== id) {
                    continue;
                }

                const message = event.message;
                if (message.t === 'error') {
                    throw refusedBy(message, 'the offer');
                }

                if (message.t === 'wait') {
                    timeoutMs = undefined;
                    logger.info('xfer', `${name} waiting for ${link.peerName} to accept`);
                    continue;
                }

                if (
                    message.t === 'accept'
                    || message.t === 'have'
                    || message.t === 'reject'
                ) {
                    return message;
                }
            }
        }

        throw new ClientError('timeout', `No answer from ${link.peerName} to the offer of ${name}`, fileId);
    };

    const knownHashes = (pageSize: number): PageHashList => {
        const pagination = record.pagination;
        if (!pagination?.pageHashes || pagination.pageSize !== pageSize) {
            return new PageHashList();
        }

        const count = Math.min(pagination.pagesDone, Math.floor(pagination.pageHashes.length / HASH_BYTES));

        return new PageHashList(pagination.pageHashes, count);
    };

    const readAsync = async (pageSize: number, page: number): Promise<Uint8Array<ArrayBuffer>> => {
        try {
            return await untilStoppedAsync(readPageAsync(file, pageSize, page));
        } catch (error) {
            if (error instanceof StopSignal || isStopped) {
                throw new StopSignal();
            }

            throw new FileUnreadable(error instanceof Error ? error.message : 'File unreadable', { cause: error });
        }
    };

    // §7.4 step 4 and 6: the receiver's saved pages win; check they match this file before continuing. A receiver
    // asks for its last saved page again, so fromPage may be below the pages acknowledged here: the hashes from
    // fromPage on are dropped and those pages go again.
    const startFromAcceptAsync = async (accept: AcceptMessage, mode: OfferMode): Promise<PageWindow | 'restart'> => {
        const pageSize = accept.pageSize;
        const totalPages = countPages(size, pageSize);
        const fromPage = accept.fromPage;
        if (fromPage > totalPages) {
            throw new ClientError('internal', `${link.peerName} asked for page ${fromPage} of ${totalPages}`, fileId);
        }

        const previousDone = record.pagination?.pagesDone ?? 0;
        hashes = knownHashes(pageSize);
        let note: FileNote | undefined;
        if (fromPage > 0) {
            if (hashes.count < fromPage) {
                await saveAsync({ note: 'checking' });
                logger.info('resume', `${name} checking pages ${hashes.count + 1}–${fromPage} before resuming`);
                for (let page = hashes.count; page < fromPage; page++) {
                    throwIfStopped();
                    hashes.set(page, await hashPageAsync(await readAsync(pageSize, page)));
                }
            }

            const prefixHash = await prefixHashAsync(hashes.bytes, fromPage);
            if (accept.prefixHash != null && prefixHash !== accept.prefixHash) {
                logger.warn('resume', `${name} prefixHash mismatch at page ${fromPage}, restarting from page 0`);
                context.emitSync([{ sessionId: link.sessionId, fileId, name, direction: 'out', decision: 'restart', fromPage: 0, totalPages }]);

                return 'restart';
            }

            logger.info('resume', `${name} prefixHash match, ${fromPage} pages`);
        }

        if (mode.resume || fromPage > 0) {
            logger.info('resume', `${name} resume fromPage=${fromPage} pageSize=${formatBytes(pageSize)}`);
        }

        // One page back is the receiver sending its last saved page again, not lost data.
        if (
            mode.resume
            && fromPage === 0
            && previousDone > 1
        ) {
            note = 'data-lost';
            logger.warn('resume', `${name} ${link.peerName} lost its partial data, restarting from page 0`);
            context.emitSync([{ sessionId: link.sessionId, fileId, name, direction: 'out', decision: 'data-lost', fromPage: 0, totalPages }]);
        }

        if (
            !mode.resume
            && !mode.restart
            && fromPage > 0
        ) {
            note = 'adopted';
            context.emitSync([{ sessionId: link.sessionId, fileId, name, direction: 'out', decision: 'adopted', fromPage, totalPages }]);
        }

        hashes.truncate(fromPage);
        live = { pageSize, totalPages, pagesDone: fromPage };
        await saveAsync({ state: 'active', note, pagination: livePagination() });
        logger.info('xfer', `${name} accept fromPage=${fromPage} pageSize=${formatBytes(pageSize)} slot=${slot}`);
        context.ensurePersistentStorage();
        options.onAccepted?.();

        return { fromPage, pageSize, totalPages };
    };

    const reportProgress = (window: PageWindow, pagesDone: number, inFlightBytes: number): void => {
        context.progress.update({
            fileId,
            sessionId: link.sessionId,
            direction: 'out',
            ...(record.batchId == null ? {} : { batchId: record.batchId }),
            name,
            pagesDone,
            totalPages: window.totalPages,
            bytesDone: Math.min(size, bytesForPages(size, window.pageSize, pagesDone) + inFlightBytes),
            size,
        });
    };

    const sendPagesAsync = async (window: PageWindow): Promise<void> => {
        const settings = context.settings();
        const inFlight = new Map<number, InFlightPage>();
        const resends = new Map<number, number>();
        let nextPage = window.fromPage;
        let pagesDone = window.fromPage;
        let lastPersistAt = context.now();
        // Bytes handed to the channel since this run started; minus what is still buffered, they crossed the link.
        let handedBytes = 0;
        const startBytes = bytesForPages(size, window.pageSize, window.fromPage);

        const inFlightBytes = (): number => [...inFlight.values()].reduce((sum, page) => sum + page.bytes, 0);

        reportProgress(window, pagesDone, 0);
        context.progress.trackPosition(link.sessionId, 'out', fileId, () => startBytes + handedBytes - link.network.bufferedAmount(slot));

        const goBack = (page: number): void => {
            for (const flight of inFlight.values()) {
                clearTimeout(flight.timer);
            }

            inFlight.clear();
            nextPage = page;
        };

        const countResend = (page: number): number => {
            const tries = (resends.get(page) ?? 0) + 1;
            resends.set(page, tries);

            return tries;
        };

        const sendPageAsync = async (page: number): Promise<void> => {
            const bytes = await readAsync(window.pageSize, page);
            const hash = await hashPageAsync(bytes);
            throwIfStopped();
            if (bytes.length > 0 && context.consumeTestTool('corrupt-pages')) {
                bytes[0] = (bytes[0] ?? 0) ^ 0xff;
                logger.warn('xfer', `${name} page ${page + 1} corrupted by the test tool`);
            }

            let offset = 0;
            while (offset < bytes.length) {
                await untilStoppedAsync(link.waitDrainedAsync(slot));
                throwIfStopped();
                const end = Math.min(bytes.length, offset + Math.max(1, link.network.maxFramePayload));
                const header = { slot, page, offset, flags: end >= bytes.length ? FRAME_FLAG_LAST_CHUNK : 0 };
                if (!link.sendFrame(header, bytes.subarray(offset, end))) {
                    throw new StopSignal();
                }

                handedBytes += end - offset;
                offset = end;
            }

            const id = context.randomId();
            send({ t: 'page-end', id, fileId, page, sha256: toHex(hash) });
            const timer = setTimeout(() => mailbox.push({ kind: 'ack-timeout', page, id }), settings.pageAckTimeoutMs);
            inFlight.set(page, { id, hash, sentAt: context.now(), timer, bytes: bytes.length });
            reportProgress(window, pagesDone, inFlightBytes());
        };

        const acknowledge = (message: AckMessage): void => {
            const entry = inFlight.get(message.page);
            if (!entry || entry.id !== message.re) {
                logger.debug('xfer', `${name} late ack for page ${message.page + 1} ignored`);

                return;
            }

            // Pages are saved in order, so an ack covers every page before it too.
            const covered = [...inFlight.keys()].filter(page => page <= message.page).sort((first, second) => first - second);
            for (const page of covered) {
                const flight = inFlight.get(page);
                if (flight) {
                    clearTimeout(flight.timer);
                    hashes.set(page, flight.hash);
                    inFlight.delete(page);
                }
            }

            pagesDone = message.page + 1;
            if (live) {
                live.pagesDone = pagesDone;
            }

            if (logger.isEnabled('xfer', 'debug')) {
                const ackMs = Math.round(context.now() - entry.sentAt);
                const buffered = formatBytes(link.network.bufferedAmount(slot));
                logger.debug('xfer', `${name} page ${pagesDone}/${window.totalPages} ack ${ackMs} ms hash ${toHex(entry.hash).slice(0, 8)}… buf ${buffered}`, {
                    page: message.page,
                });
            }

            reportProgress(window, pagesDone, inFlightBytes());
            const now = context.now();
            if (now - lastPersistAt >= PERSIST_INTERVAL_MS) {
                lastPersistAt = now;
                void saveAsync({ pagination: livePagination() }, false);
            }
        };

        try {
            while (pagesDone < window.totalPages) {
                throwIfStopped();
                if (nextPage < window.totalPages && inFlight.size < PAGES_IN_FLIGHT) {
                    await sendPageAsync(nextPage);
                    nextPage++;
                    continue;
                }

                const event = await mailbox.nextAsync();
                if (event === TIMED_OUT) {
                    continue;
                }

                if (event.kind === 'ack-timeout') {
                    if (inFlight.get(event.page)?.id !== event.id) {
                        continue;
                    }

                    const tries = countResend(event.page);
                    if (tries > settings.pageResendTries) {
                        throw new ClientError('timeout', `No ack for page ${event.page + 1} from ${link.peerName}`, fileId);
                    }

                    logger.warn('xfer', `${name} page ${event.page + 1}/${window.totalPages} no ack, resending (${tries}/${settings.pageResendTries})`);
                    goBack(event.page);
                    continue;
                }

                const message = event.message;
                if (message.t === 'ack') {
                    acknowledge(message);
                    continue;
                }

                if (message.t === 'error' && [...inFlight.values()].some(flight => flight.id === message.re)) {
                    throw refusedBy(message, 'a page');
                }

                if (message.t === 'nack') {
                    if (inFlight.get(message.page)?.id !== message.re) {
                        continue;
                    }

                    const tries = countResend(message.page);
                    if (tries > settings.pageResendTries) {
                        throw new ClientError('verify-failed', `Page ${message.page + 1} arrived damaged ${tries} times`, fileId);
                    }

                    logger.warn('xfer', `${name} nack page ${message.page + 1}/${window.totalPages}, resending (${tries}/${settings.pageResendTries})`);
                    goBack(message.page);
                }
            }
        } finally {
            goBack(nextPage);
        }
    };

    const verifyAsync = async (window: PageWindow): Promise<{ readonly isVerified: boolean; readonly rootHash: string }> => {
        const settings = context.settings();
        await saveAsync({ state: 'verifying', pagination: livePagination() });
        const rootHash = await rootHashAsync(hashes.bytes, window.totalPages);

        for (let attempt = 0; attempt <= settings.pageResendTries; attempt++) {
            const id = context.randomId();
            send({ t: 'file-end', id, fileId, rootHash });
            for (;;) {
                const event = await mailbox.nextAsync(settings.pageAckTimeoutMs);
                if (event === TIMED_OUT) {
                    break;
                }

                if (event.kind !== 'message' || event.message.re !== id) {
                    continue;
                }

                if (event.message.t === 'error') {
                    throw refusedBy(event.message, 'the final check');
                }

                if (event.message.t === 'done') {
                    return { isVerified: event.message.ok, rootHash };
                }
            }
        }

        throw new ClientError('timeout', `No answer from ${link.peerName} to the final check`, fileId);
    };

    const finishAsync = async (changes: Partial<StoredFile>): Promise<StoredFile> => {
        live = undefined;
        context.progress.remove(link.sessionId, 'out', fileId);
        await saveAsync({ ...changes, pagination: undefined, completedAt: context.now() }, false);

        return record;
    };

    // The receiver has a file with this ID. IDs come from samples, so it counts as the same file only if the
    // whole of this one hashes to the receiver's rootHash at the receiver's page size.
    const isOnPeerAsync = async (reply: HaveMessage): Promise<boolean> => {
        const pageSize = reply.pageSize;
        if (reply.rootHash == null || pageSize == null) {
            logger.info('xfer', `${name} is on ${link.peerName} without a hash to check against`);

            return false;
        }

        await saveAsync({ state: 'verifying', note: 'checking' });
        logger.info('xfer', `${name} is on ${link.peerName}, checking the whole file`);
        const rootHash = await computeRootHashAsync(size, pageSize, page => {
            throwIfStopped();

            return readAsync(pageSize, page);
        });

        return rootHash === reply.rootHash;
    };

    const rejectionError = (reply: RejectMessage): ClientError => {
        if (reply.reason === 'space') {
            const detail = reply.needed != null && reply.free != null
                ? `Needs ${formatBytes(reply.needed)}, has ${formatBytes(reply.free)}`
                : `Not enough space on ${link.peerName}`;

            return new ClientError('no-space', detail, fileId);
        }

        if (reply.reason === 'declined') {
            return new ClientError('canceled', `${link.peerName} declined`, fileId);
        }

        return new ClientError('invalid-state', `${link.peerName} refused the file`, fileId);
    };

    const runAsync = async (): Promise<SendOutcome> => {
        let mode: OfferMode = { resume: options.resume || (record.pagination?.pagesDone ?? 0) > 0, restart: false, again: options.again };
        let verifyRetries = 0;
        for (;;) {
            const reply = await offerAsync(mode);
            if (reply.t === 'have') {
                if (await isOnPeerAsync(reply)) {
                    logger.info('xfer', `${name} already on ${link.peerName}, root hash matches`);
                    const done = await finishAsync({ state: 'done', note: 'already-on-peer', rootHash: reply.rootHash });

                    return { kind: 'done', record: done };
                }

                // A send-again offer is never answered with have; a peer that does would loop.
                if (mode.again) {
                    throw new ClientError('invalid-state', `${link.peerName} refused to take ${name} again`, fileId);
                }

                logger.warn('xfer', `${name} differs from the copy on ${link.peerName}, sending it anyway`);
                mode = { resume: false, restart: false, again: true };
                continue;
            }

            if (reply.t === 'reject') {
                logger.info('xfer', `${name} reject reason=${reply.reason}`);
                if (reply.reason === 'paused') {
                    await saveAsync({ state: 'paused', pausedBy: 'peer', pagination: detachedPagination() }, false);

                    return { kind: 'paused-by-peer', record };
                }

                const error = rejectionError(reply);
                context.progress.remove(link.sessionId, 'out', fileId);
                await saveAsync({ state: 'failed', lastError: error.message, note: NOTES_BY_REASON[reply.reason] }, false);

                return { kind: 'failed', record, error, isPeerAware: true };
            }

            const window = await startFromAcceptAsync(reply, mode);
            if (window === 'restart') {
                mode = { resume: false, restart: true, again: false };
                continue;
            }

            await sendPagesAsync(window);
            const { isVerified, rootHash } = await verifyAsync(window);
            if (isVerified) {
                logger.info('xfer', `${name} verified, root hash ${rootHash.slice(0, 8)}…`);
                const done = await finishAsync({ state: 'done', rootHash, note: record.note === 'checking' ? undefined : record.note });

                return { kind: 'done', record: done };
            }

            if (verifyRetries >= VERIFY_RETRIES) {
                throw new ClientError('verify-failed', `${name} did not match after a full retry`, fileId);
            }

            verifyRetries++;
            logger.warn('xfer', `${name} root hash mismatch, sending again from page 0`);
            await saveAsync({ attempts: record.attempts + 1 }, false);
            mode = { resume: false, restart: true, again: false };
        }
    };

    const outcome = (async (): Promise<SendOutcome> => {
        try {
            return await runAsync();
        } catch (error) {
            // A link that drops mid-call is a pause, not a failure; the connection pauses the file (CL-09).
            if (
                error instanceof StopSignal
                || isStopped
                || !link.isOpen
            ) {
                return { kind: 'stopped' };
            }

            const pagination = detachedPagination();
            live = undefined;
            context.progress.remove(link.sessionId, 'out', fileId);
            if (error instanceof FileUnreadable) {
                logger.warn('xfer', `${name} could not be read: ${error.message}`);
                await saveAsync({ state: 'needs-file', pagination, lastError: error.message }, false);

                return { kind: 'needs-file', record };
            }

            const clientError = error instanceof ClientError
                ? error
                : new ClientError('internal', error instanceof Error ? error.message : 'Send failed', fileId, { cause: error });
            logger.error('xfer', `${name} failed: ${clientError.message}`);
            await saveAsync({ state: 'failed', pagination, lastError: clientError.message, attempts: record.attempts + 1 }, false);

            return { kind: 'failed', record, error: clientError, isPeerAware: false };
        }
    })();

    return {
        fileId,
        slot,
        deliver: message => mailbox.push({ kind: 'message', message }),
        stop: () => {
            if (isStopped) {
                return;
            }

            isStopped = true;
            const signal = new StopSignal();
            mailbox.close(signal);
            rejectStop(signal);
        },
        snapshot,
        amend: changes => {
            record = { ...record, ...changes };
            options.onRecord(record);

            return { ...record, pagination: livePagination() };
        },
        outcome,
    };
}
