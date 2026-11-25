// Reads what the pairing code needs from a local description and rebuilds a full remote one (HS-03).
// The rebuilt description uses only standard lines, so Chrome, Firefox and Safari all accept it.

export type SetupRole = 'actpass' | 'active' | 'passive';

export const SETUP_ROLES: readonly SetupRole[] = Object.freeze(['actpass', 'active', 'passive']);

export interface HostCandidate {
    readonly address: string;
    readonly port: number;
}

export interface SdpCandidate extends HostCandidate {
    readonly foundation: string;
    readonly component: number;
    // Lower case: "udp" or "tcp".
    readonly protocol: string;
    readonly priority: number;
    readonly type: string;
}

export interface RemoteDescription {
    readonly iceUfrag: string;
    readonly icePwd: string;
    readonly fingerprint: Uint8Array;
    readonly setup: SetupRole;
    readonly mid: string;
    readonly maxMessageSize?: number;
    readonly candidates: readonly HostCandidate[];
}

export interface ParsedDescription extends RemoteDescription {
    readonly candidates: readonly SdpCandidate[];
}

// The algorithm follows from the digest length, so the code only carries the bytes.
const FINGERPRINT_ALGORITHMS: readonly { readonly name: string; readonly length: number }[] = Object.freeze([
    { name: 'sha-256', length: 32 },
    { name: 'sha-384', length: 48 },
    { name: 'sha-512', length: 64 },
]);

export const FINGERPRINT_LENGTHS: readonly number[] = Object.freeze(
    FINGERPRINT_ALGORITHMS.map(algorithm => algorithm.length),
);

const SCTP_PORT = 5000;
const HOST_TYPE_PREFERENCE = 126;
const MAX_LOCAL_PREFERENCE = 65535;
const CANDIDATE_PATTERN = /^(?:a=)?candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/i;
const FINGERPRINT_PATTERN = /^(\S+) ([0-9a-f]{2}(?::[0-9a-f]{2})*)$/i;

interface Sections {
    readonly session: readonly string[];
    readonly media: readonly string[];
}

export function parseSdp(sdp: string): ParsedDescription | undefined {
    const sections = splitSections(sdp);
    if (sections == null) {
        return undefined;
    }

    const attribute = (name: string): string | undefined => findAttribute(sections.media, name)
        ?? findAttribute(sections.session, name);
    const iceUfrag = attribute('ice-ufrag');
    const icePwd = attribute('ice-pwd');
    const mid = attribute('mid');
    const setup = SETUP_ROLES.find(role => role === attribute('setup'));
    const fingerprint = findFingerprint(sections);
    if (!iceUfrag || !icePwd || !mid || setup == null || fingerprint == null) {
        return undefined;
    }

    const maxMessageSize = Number(attribute('max-message-size') ?? Number.NaN);
    const candidates = sections.media
        .map(line => parseCandidate(line))
        .filter((candidate): candidate is SdpCandidate => candidate != null);

    return {
        iceUfrag,
        icePwd,
        fingerprint,
        setup,
        mid,
        ...(Number.isInteger(maxMessageSize) && maxMessageSize > 0 ? { maxMessageSize } : {}),
        candidates,
    };
}

// Accepts an SDP line ("a=candidate:…") or RTCIceCandidate.candidate ("candidate:…").
export function parseCandidate(text: string): SdpCandidate | undefined {
    const match = CANDIDATE_PATTERN.exec(text.trim());
    if (match == null) {
        return undefined;
    }

    const [, foundation = '', component = '', protocol = '', priority = '', address = '', port = ''] = match;

    return {
        foundation,
        component: Number(component),
        protocol: protocol.toLowerCase(),
        priority: Number(priority),
        address,
        port: Number(port),
        type: (match[7] ?? '').toLowerCase(),
    };
}

export function buildSdp(description: RemoteDescription, sessionId: number): string {
    const fingerprint = description.fingerprint;
    const candidates = description.candidates.map((candidate, index) => {
        const priority = hostPriority(index);

        return `a=candidate:${index + 1} 1 udp ${priority} ${candidate.address} ${candidate.port} typ host`;
    });
    const lines = [
        'v=0',
        `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
        's=-',
        't=0 0',
        `a=group:BUNDLE ${description.mid}`,
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        ...candidates,
        'a=end-of-candidates',
        `a=ice-ufrag:${description.iceUfrag}`,
        `a=ice-pwd:${description.icePwd}`,
        `a=fingerprint:${fingerprintAlgorithm(fingerprint)} ${formatFingerprint(fingerprint)}`,
        `a=setup:${description.setup}`,
        `a=mid:${description.mid}`,
        `a=sctp-port:${SCTP_PORT}`,
        ...(description.maxMessageSize == null ? [] : [`a=max-message-size:${description.maxMessageSize}`]),
    ];

    return `${lines.join('\r\n')}\r\n`;
}

export function formatFingerprint(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function fingerprintAlgorithm(bytes: Uint8Array): string {
    const algorithm = FINGERPRINT_ALGORITHMS.find(candidate => candidate.length === bytes.length);
    if (algorithm == null) {
        throw new RangeError(`A ${bytes.length}-byte fingerprint has no algorithm`);
    }

    return algorithm.name;
}

// RFC 8445 priority for host candidates, keeping the order of the code.
function hostPriority(index: number): number {
    return HOST_TYPE_PREFERENCE * 2 ** 24 + (MAX_LOCAL_PREFERENCE - index) * 2 ** 8 + 255;
}

function splitSections(sdp: string): Sections | undefined {
    const lines = sdp.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    const firstMedia = lines.findIndex(line => line.startsWith('m='));
    const dataMedia = lines.findIndex(line => line.startsWith('m=application'));
    if (firstMedia < 0 || dataMedia < 0) {
        return undefined;
    }

    const nextMedia = lines.findIndex((line, index) => index > dataMedia && line.startsWith('m='));

    return {
        session: lines.slice(0, firstMedia),
        media: lines.slice(dataMedia, nextMedia < 0 ? lines.length : nextMedia),
    };
}

function findAttribute(lines: readonly string[], name: string): string | undefined {
    const prefix = `a=${name}:`;
    const line = lines.find(candidate => candidate.startsWith(prefix));

    return line?.slice(prefix.length).trim();
}

function findFingerprint(sections: Sections): Uint8Array | undefined {
    const values = [...sections.media, ...sections.session]
        .filter(line => line.startsWith('a=fingerprint:'))
        .map(line => parseFingerprint(line.slice('a=fingerprint:'.length).trim()));

    return values.find((value): value is Uint8Array => value != null);
}

function parseFingerprint(value: string): Uint8Array | undefined {
    const match = FINGERPRINT_PATTERN.exec(value);
    if (match == null) {
        return undefined;
    }

    const [, name = '', hex = ''] = match;
    const bytes = Uint8Array.from(hex.split(':'), pair => parseInt(pair, 16));
    const algorithm = FINGERPRINT_ALGORITHMS.find(candidate => candidate.name === name.toLowerCase());

    return algorithm?.length === bytes.length ? bytes : undefined;
}
