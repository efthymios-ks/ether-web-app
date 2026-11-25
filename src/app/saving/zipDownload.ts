import { ClientError } from '../../client/clientTypes.js';
import { sanitizeFileName } from '../../media/fileNames.js';
import type { AppContext } from '../appContext.js';
import { h } from '../dom.js';
import { formatCount } from '../format.js';
import { isVerifyFailed, peerNameFor, reportDamaged } from '../transfers/fileErrors.js';

// Received files leave the app as one ZIP, which carries each file's modified date as sent (SV-04).
// The ZIP is a Blob the client builds from the stored pages; the browser downloads it through an object URL.

const OBJECT_URL_LIFETIME_MS = 60_000;

export function downloadBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = h('a', { attrs: { href: url, download: name, hidden: true } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}

// "<peer name>-<YYYY-MM-DD HH.mm>.zip", safe on every file system.
export function zipFileName(peerName: string, now: Date = new Date()): string {
    const pad = (value: number): string => `${value}`.padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;

    return sanitizeFileName(`${peerName}-${stamp}.zip`);
}

export interface ZipDownloadOptions {
    readonly fileIds: readonly string[];
    readonly sessionId: string;
}

// Builds the ZIP, downloads it and marks the files saved. A damaged stored copy stops it before any download.
export async function downloadZipAsync(context: AppContext, options: ZipDownloadOptions): Promise<boolean> {
    const { client, dialogs } = context;
    if (options.fileIds.length === 0) {
        return false;
    }

    try {
        const blob = await client.buildZipAsync(options.sessionId, options.fileIds);
        downloadBlob(blob, zipFileName(peerNameFor(context, options.sessionId)));
        await client.markSavedAsync(options.sessionId, options.fileIds);
        context.logger.info('store', 'received files downloaded as a ZIP', { count: options.fileIds.length, bytes: blob.size });
        context.notifyDataChanged();
        dialogs.toast(`${formatCount(options.fileIds.length, 'file')} downloaded as a ZIP.`, { tone: 'ok' });

        return true;
    } catch (error) {
        if (isVerifyFailed(error)) {
            const fileId = error instanceof ClientError ? error.fileId : undefined;
            const records = await client.listFilesAsync({ sessionId: options.sessionId, direction: 'in' }).catch(() => []);
            const name = records.find(record => record.fileId === fileId)?.name ?? 'a file';
            reportDamaged(context, name, options.sessionId);

            return false;
        }

        context.logger.warn('store', 'ZIP download failed', { error });
        dialogs.toast(`The ZIP could not be built. ${error instanceof Error ? error.message : ''}`.trim(), { tone: 'fail' });

        return false;
    }
}
