import { describe, expect, it } from 'vitest';
import { createPairingRelay, RELAY_CHANNEL, takeHashCode } from './pairingRelay.js';

class LocalChannel extends EventTarget {
    static readonly all = new Set<LocalChannel>();

    constructor(readonly name: string) {
        super();
        LocalChannel.all.add(this);
    }

    postMessage(message: unknown): void {
        for (const other of LocalChannel.all) {
            if (other !== this && other.name === this.name) {
                queueMicrotask(() => other.dispatchEvent(new MessageEvent('message', { data: message })));
            }
        }
    }

    close(): void {
        LocalChannel.all.delete(this);
    }
}

function createChannel(name: string): LocalChannel {
    return new LocalChannel(name);
}

describe('createPairingRelay', () => {
    it('hands an answer to the tab with the pending offer, which confirms it (HS-07)', async () => {
        // Arrange
        const received: string[] = [];
        const holder = createPairingRelay({ createChannel, onCode: code => received.push(code) > 0 });
        const opener = createPairingRelay({ createChannel });

        // Act
        const isTaken = await opener.forwardAsync('ANSWER1234', 200);

        // Assert
        expect(isTaken).toBe(true);
        expect(received).toEqual(['ANSWER1234']);
        holder.dispose();
        opener.dispose();
    });

    it('gives up when no tab answers in time', async () => {
        // Arrange
        const names: string[] = [];
        const opener = createPairingRelay({
            createChannel: name => {
                names.push(name);

                return createChannel(name);
            },
        });

        // Act
        const isTaken = await opener.forwardAsync('ANSWER1234', 20);

        // Assert
        expect(isTaken).toBe(false);
        expect(names).toEqual([RELAY_CHANNEL]);
        opener.dispose();
    });

    it('stays quiet when the holder doesn’t take the code', async () => {
        // Arrange
        const holder = createPairingRelay({ createChannel, onCode: () => false });
        const opener = createPairingRelay({ createChannel });

        // Act
        const isTaken = await opener.forwardAsync('OFFER1234', 30);

        // Assert
        expect(isTaken).toBe(false);
        holder.dispose();
        opener.dispose();
    });
});

describe('takeHashCode', () => {
    it('reads the #code once and clears it from the address (HS-08)', () => {
        // Arrange
        history.replaceState(null, '', '/ether/?debug=1#ABCD-EFGH');

        // Act
        const code = takeHashCode();
        const again = takeHashCode();

        // Assert
        expect(code).toBe('ABCD-EFGH');
        expect(again).toBeUndefined();
        expect(location.search).toBe('?debug=1');
    });
});
