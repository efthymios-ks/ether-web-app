import { ClientError } from '../../client/clientTypes.js';
import type { AppContext } from '../appContext.js';

// A received copy that no longer matches its hash ('verify-failed', note 'damaged'): nothing is downloaded,
// shared or saved from it, and the user is told to ask for it again.

export function isVerifyFailed(error: unknown): boolean {
    return error instanceof ClientError && error.code === 'verify-failed';
}

export function peerNameFor(context: AppContext, sessionId: string): string {
    const peer = context.client.peer;
    if (peer != null && peer.sessionId === sessionId) {
        return peer.displayName;
    }

    return context.sessions.find(sessionId)?.peerName ?? 'the other device';
}

export function damagedText(name: string, peerName: string): string {
    return `The stored copy of ${name} is damaged. Ask ${peerName} to send it again.`;
}

// Shows the damaged-copy message as a toast and returns it for the row or status line.
export function reportDamaged(context: AppContext, name: string, sessionId: string): string {
    const text = damagedText(name, peerNameFor(context, sessionId));
    context.dialogs.toast(text, { tone: 'fail', durationMs: 8000 });

    return text;
}
