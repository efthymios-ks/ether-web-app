import { describe, expect, it } from 'vitest';
import { bytesToBase64Url, bytesToHex, utf8Bytes } from './encoding.js';
import {
    createPinGuard,
    createPinProof,
    hmacSha256,
    isPinProofValid,
    PIN_ATTEMPT_WINDOW_MS,
    PIN_ATTEMPTS_IN_TOTAL,
    PIN_ATTEMPTS_PER_ASKER,
    PIN_LOCKOUT_MS,
} from './nearbyPin.js';
import type { PinAsker } from './nearbyPin.js';

const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const OFFER = 'AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYUCULBOGAZDINRYHI6D4QA';
const ASKER: PinAsker = { nearbyId: 'NeArByIdNeArByIdNeArBy', run: 'RuNrUnRuNrUnRuNrUnRuN0' };

function asker(index: number): PinAsker {
    return { nearbyId: `nearby-${index}-`.padEnd(22, 'x'), run: `run-${index}-`.padEnd(22, 'y') };
}

// A clock the test moves by hand.
function createClock(): { now: () => number; advance(ms: number): void } {
    let time = 1000;

    return {
        now: () => time,
        advance: ms => {
            time += ms;
        },
    };
}

describe('hmacSha256', () => {
    it.each([
        [
            'RFC 4231 case 1',
            new Uint8Array(20).fill(0x0b),
            utf8Bytes('Hi There'),
            'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
        ],
        [
            'RFC 4231 case 2',
            utf8Bytes('Jefe'),
            utf8Bytes('what do ya want for nothing?'),
            '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
        ],
        [
            'RFC 4231 case 6, a key longer than a block',
            new Uint8Array(131).fill(0xaa),
            utf8Bytes('Test Using Larger Than Block-Size Key - Hash Key First'),
            '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
        ],
    ])('matches %s', (_, key, message, expected) => {
        // Act
        const mac = hmacSha256(key, message);

        // Assert
        expect(bytesToHex(mac)).toBe(expected);
    });

    it('matches WebCrypto for a PIN and a request', async () => {
        // Arrange
        const key = utf8Bytes('2468');
        const message = utf8Bytes(`${REQUEST_ID}|${'ab'.repeat(32)}`);
        const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

        // Act
        const expected = new Uint8Array(await crypto.subtle.sign('HMAC', imported, message));

        // Assert
        expect(hmacSha256(key, message)).toEqual(expected);
    });
});

describe('PIN proofs', () => {
    it('is the base64url HMAC of the request id and the offer code’s hex SHA-256, keyed with the PIN', async () => {
        // Arrange
        const offerHash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Bytes(OFFER))));
        const key = await crypto.subtle.importKey(
            'raw',
            utf8Bytes('2468'),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const mac = await crypto.subtle.sign('HMAC', key, utf8Bytes(`${REQUEST_ID}|${offerHash}`));

        // Act
        const proof = createPinProof('2468', REQUEST_ID, OFFER);

        // Assert
        expect(proof).toBe(bytesToBase64Url(new Uint8Array(mac)));
        expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('checks out for the same PIN, request and offer only', () => {
        // Arrange
        const proof = createPinProof('2468', REQUEST_ID, OFFER);

        // Act
        const results = [
            isPinProofValid('2468', REQUEST_ID, OFFER, proof),
            isPinProofValid('2469', REQUEST_ID, OFFER, proof),
            isPinProofValid('2468', 'ZyXwVuTsRqPoNmLkJiHgFe', OFFER, proof),
            isPinProofValid('2468', REQUEST_ID, `${OFFER}A`, proof),
            isPinProofValid('2468', REQUEST_ID, OFFER, proof.slice(0, 40)),
            isPinProofValid('2468', REQUEST_ID, OFFER, '!'.repeat(43)),
        ];

        // Assert
        expect(results).toEqual([true, false, false, false, false, false]);
    });
});

describe('createPinGuard', () => {
    it(`locks one asker out for a minute after ${PIN_ATTEMPTS_PER_ASKER} wrong PINs, and leaves others alone`, () => {
        // Arrange
        const clock = createClock();
        const guard = createPinGuard(clock.now);

        // Act
        const results = Array.from({ length: PIN_ATTEMPTS_PER_ASKER }, () => guard.recordWrong(ASKER));
        const isLocked = guard.isLockedOut(ASKER);
        const isOtherLocked = guard.isLockedOut(asker(1));
        clock.advance(PIN_LOCKOUT_MS - 1);
        const isStillLocked = guard.isLockedOut(ASKER);
        clock.advance(1);

        // Assert
        expect(results).toEqual(['counted', 'counted', 'counted', 'counted', 'asker-locked']);
        expect([isLocked, isOtherLocked, isStillLocked]).toEqual([true, false, true]);
        expect(guard.isLockedOut(ASKER)).toBe(false);
    });

    it('locks again at once for each wrong PIN after a lockout while the earlier ones are recent', () => {
        // Arrange
        const clock = createClock();
        const guard = createPinGuard(clock.now);
        for (let attempt = 0; attempt < PIN_ATTEMPTS_PER_ASKER; attempt++) {
            guard.recordWrong(ASKER);
        }

        clock.advance(PIN_LOCKOUT_MS);

        // Act
        const again = guard.recordWrong(ASKER);
        const isLocked = guard.isLockedOut(ASKER);
        clock.advance(PIN_ATTEMPT_WINDOW_MS);
        const afterWindow = guard.recordWrong(ASKER);

        // Assert
        expect(again).toBe('asker-locked');
        expect(isLocked).toBe(true);
        expect(afterWindow).toBe('counted');
    });

    it('counts by nearbyId and by run, so a new id or a new run alone gets no new guesses', () => {
        // Arrange
        const guard = createPinGuard(createClock().now);
        const newIds = Array.from({ length: PIN_ATTEMPTS_PER_ASKER }, (_, index) => ({
            nearbyId: asker(index).nearbyId,
            run: ASKER.run,
        }));
        const newRuns = Array.from({ length: PIN_ATTEMPTS_PER_ASKER }, (_, index) => ({
            nearbyId: ASKER.nearbyId,
            run: asker(index).run,
        }));

        // Act
        const byRun = newIds.map(entry => guard.recordWrong(entry)).at(-1);
        const otherGuard = createPinGuard(createClock().now);
        const byId = newRuns.map(entry => otherGuard.recordWrong(entry)).at(-1);

        // Assert
        expect([byRun, byId]).toEqual(['asker-locked', 'asker-locked']);
        expect(guard.isLockedOut({ nearbyId: 'fresh'.padEnd(22, 'z'), run: ASKER.run })).toBe(true);
        expect(otherGuard.isLockedOut({ nearbyId: ASKER.nearbyId, run: 'fresh'.padEnd(22, 'z') })).toBe(true);
    });

    it(`locks everyone out after ${PIN_ATTEMPTS_IN_TOTAL} wrong PINs from any askers together`, () => {
        // Arrange
        const clock = createClock();
        const guard = createPinGuard(clock.now);

        // Act
        const results = Array.from({ length: PIN_ATTEMPTS_IN_TOTAL }, (_, index) => guard.recordWrong(asker(index)));
        const isNewcomerLocked = guard.isLockedOut(asker(99));
        clock.advance(PIN_LOCKOUT_MS);

        // Assert
        expect(results.slice(0, -1).every(result => result === 'counted')).toBe(true);
        expect(results.at(-1)).toBe('all-locked');
        expect(isNewcomerLocked).toBe(true);
        expect(guard.isLockedOut(asker(99))).toBe(false);
    });

    it('forgets wrong PINs older than the window, and a right PIN clears that asker’s count', () => {
        // Arrange
        const clock = createClock();
        const guard = createPinGuard(clock.now);
        for (let index = 1; index < PIN_ATTEMPTS_PER_ASKER; index++) {
            guard.recordWrong(ASKER);
        }

        // Act
        clock.advance(PIN_ATTEMPT_WINDOW_MS);
        const afterWindow = guard.recordWrong(ASKER);
        guard.recordRight(ASKER);
        const afterRight = Array.from({ length: PIN_ATTEMPTS_PER_ASKER - 1 }, () => guard.recordWrong(ASKER));

        // Assert
        expect(afterWindow).toBe('counted');
        expect(afterRight.every(result => result === 'counted')).toBe(true);
        expect(guard.isLockedOut(ASKER)).toBe(false);
    });
});
