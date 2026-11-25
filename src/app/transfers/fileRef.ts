import type { Direction, FileRef } from '../../client/clientTypes.js';

// Every client call about a file names its session and direction: file IDs repeat across sessions.
export function fileRef(item: { readonly sessionId: string; readonly fileId: string; readonly direction: Direction }): FileRef {
    return { sessionId: item.sessionId, fileId: item.fileId, direction: item.direction };
}
