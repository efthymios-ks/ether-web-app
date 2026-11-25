// Why a nearby call could not go ahead; the outcomes of a request that did go out are PairRequestOutcome.
// not-listening: discovery is off, starting or offline. unknown-device: the device is no longer in the list.
// invalid-code: the code is not a pairing code. request-ended: the request was withdrawn, expired or answered.
// send-failed: no relay took the message.
export type DiscoveryErrorCode =
    | 'not-listening'
    | 'unknown-device'
    | 'invalid-code'
    | 'request-ended'
    | 'send-failed';

export class DiscoveryError extends Error {
    override readonly name = 'DiscoveryError';

    constructor(readonly code: DiscoveryErrorCode, message: string) {
        super(message);
    }
}
