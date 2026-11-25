import type { Unsubscribe } from '../core/events.js';
import type { DevicePlatform, DeviceType } from '../core/deviceInfo.js';

// Nearby devices: devices behind the same public IPv4 address (the same router, so usually the same Wi-Fi)
// find each other through public relays and pair only when the other side accepts.
// Each device learns its public address from a pool of STUN servers, hashes it into a room name, and says
// "I'm here" in that room every so often; the relays only pass encrypted messages along. Pairing itself still
// swaps the usual pairing codes, so the devices then connect directly and show the check code as with a QR code.

// off: the setting is off, or stopped. starting: finding the public address and reaching the relays.
// listening: in the room, saying "I'm here" (the list may be empty). offline: no STUN server or no relay answered;
// it keeps retrying.
export type DiscoveryStatus = 'off' | 'starting' | 'listening' | 'offline';

export interface NearbyIdentity {
    readonly name: string;
    readonly deviceType: DeviceType;
    // Shown as a tag beside the name, e.g. "iPad"; devices on older builds don't send it.
    readonly platform?: DevicePlatform;
}

// This device as discovery announces it. The PIN (4–8 digits) stays here: presence says only that there is one,
// and a request to this device must prove it knows the PIN, or it is turned down without asking.
export interface OwnNearbyIdentity extends NearbyIdentity {
    readonly pin?: string;
}

export interface NearbyDevice extends NearbyIdentity {
    // Random for each browser tab of that device, kept across reloads of the tab so a reload doesn't list it twice;
    // nothing stable about the device itself reaches the relays.
    readonly nearbyId: string;
    readonly lastSeenAt: number;
    // The device has a PIN: a request to it needs the PIN, and then connects without an Accept there.
    readonly hasPin?: boolean;
}

// A request to pair that reached this device; the UI asks to accept or decline it.
export interface PairRequest {
    readonly requestId: string;
    readonly from: NearbyDevice;
    // The asker's pairing offer, as a QR code would carry it.
    readonly offerCode: string;
    readonly expiresAt: number;
    // This device has a PIN and the asker proved it knows it, so the UI connects without asking (SP-11).
    readonly isPinVerified: boolean;
}

// accepted: the other device took the offer and answered. declined: it said no. busy: it is connected or pairing,
// or turned away too many wrong PINs. pin-required: it has a PIN and none came. wrong-pin: the PIN was wrong.
// no-answer: nobody answered before the request expired. canceled: this device withdrew the request.
export type PairRequestOutcome =
    | { readonly kind: 'accepted'; readonly answerCode: string }
    | { readonly kind: 'declined' }
    | { readonly kind: 'busy' }
    | { readonly kind: 'pin-required' }
    | { readonly kind: 'wrong-pin' }
    | { readonly kind: 'no-answer' }
    | { readonly kind: 'canceled' };

// Ether's own relay (a Cloudflare Worker, relay/) was refused for a used-up free daily allowance.
// isCertain is true when the relay's status check said so; false when the relay gave no readable answer while the
// internet works, which is how Cloudflare answers once the Worker itself is past its daily requests.
export interface RelayAllowanceNotice {
    readonly relayUrl: string;
    readonly isCertain: boolean;
    // The next 00:00 UTC, when Cloudflare's free allowances start again.
    readonly resetsAt: number;
}

export interface DiscoveryEvents {
    status(status: DiscoveryStatus): void;
    // The whole list, after every change; devices that went quiet are already gone from it.
    devices(devices: readonly NearbyDevice[]): void;
    request(request: PairRequest): void;
    // The asker withdrew a request, or it expired, before this device answered.
    'request-ended'(requestId: string): void;
    // Ether's own relay ran out of its free daily allowance (a notice), or works again (undefined).
    'relay-allowance'(notice: RelayAllowanceNotice | undefined): void;
}

export interface PairRequestOptions {
    readonly signal?: AbortSignal;
    // The PIN typed for the asked device; it never leaves this device, only a proof of it does.
    readonly pin?: string;
}

export interface Discovery {
    status(): DiscoveryStatus;
    devices(): readonly NearbyDevice[];
    relayAllowance(): RelayAllowanceNotice | undefined;
    on<Name extends keyof DiscoveryEvents>(name: Name, handler: DiscoveryEvents[Name]): Unsubscribe;
    // Starts saying "I'm here" (again, after stop); calling it while started only updates the name and the PIN.
    start(identity: OwnNearbyIdentity): void;
    // Says goodbye, leaves the relays and forgets the list; open requests end.
    stop(): void;
    // Sends this device's offer code to one nearby device and waits for its answer, its no, or the request to expire.
    // With `pin`, the request proves it knows that device's PIN, so a device with one connects without asking.
    requestPairingAsync(
        nearbyId: string,
        offerCode: string,
        options?: PairRequestOptions,
    ): Promise<PairRequestOutcome>;
    acceptAsync(requestId: string, answerCode: string): Promise<void>;
    declineAsync(requestId: string, reason?: 'declined' | 'busy'): Promise<void>;
}
