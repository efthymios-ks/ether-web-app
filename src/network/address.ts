// Host candidate addresses in their binary form for the pairing code (HS-03).

export type AddressKind = 'ipv4' | 'ipv6' | 'mdns';

export interface BinaryAddress {
    readonly kind: AddressKind;
    readonly bytes: Uint8Array;
}

export const ADDRESS_LENGTHS: Readonly<Record<AddressKind, number>> = Object.freeze({
    ipv4: 4,
    ipv6: 16,
    mdns: 16,
});

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MDNS_PATTERN = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const IPV6_GROUP_PATTERN = /^[0-9a-f]{1,4}$/i;
const IPV6_GROUPS = 8;

// Order is priority: the first parser that understands the text wins.
const PARSERS: readonly ((text: string) => BinaryAddress | undefined)[] = [
    parseIpv4,
    parseMdnsName,
    parseIpv6,
];

export function addressToBytes(text: string): BinaryAddress | undefined {
    for (const parse of PARSERS) {
        const address = parse(text);
        if (address != null) {
            return address;
        }
    }

    return undefined;
}

const FORMATTERS: Readonly<Record<AddressKind, (bytes: Uint8Array) => string>> = Object.freeze({
    ipv4: formatIpv4,
    ipv6: formatIpv6,
    mdns: formatMdnsName,
});

export function bytesToAddress(kind: AddressKind, bytes: Uint8Array): string {
    return FORMATTERS[kind](bytes);
}

function parseIpv4(text: string): BinaryAddress | undefined {
    const octets = parseIpv4Octets(text);

    return octets == null ? undefined : { kind: 'ipv4', bytes: Uint8Array.from(octets) };
}

function parseIpv4Octets(text: string): number[] | undefined {
    const match = IPV4_PATTERN.exec(text);
    if (match == null) {
        return undefined;
    }

    const octets = match.slice(1).map(Number);

    return octets.every(octet => octet <= 255) ? octets : undefined;
}

function parseMdnsName(text: string): BinaryAddress | undefined {
    const match = MDNS_PATTERN.exec(text);
    if (match == null) {
        return undefined;
    }

    return { kind: 'mdns', bytes: hexToBytes(match.slice(1).join('')) };
}

function parseIpv6(text: string): BinaryAddress | undefined {
    const groups = parseIpv6Groups(text);
    if (groups == null) {
        return undefined;
    }

    const bytes = new Uint8Array(16);
    groups.forEach((group, index) => {
        bytes[index * 2] = group >> 8;
        bytes[index * 2 + 1] = group & 0xff;
    });

    return { kind: 'ipv6', bytes };
}

function parseIpv6Groups(text: string): number[] | undefined {
    if (!text.includes(':')) {
        return undefined;
    }

    const halves = text.split('::');
    if (halves.length > 2) {
        return undefined;
    }

    const head = splitIpv6Half(halves[0] ?? '');
    const tail = halves.length === 2 ? splitIpv6Half(halves[1] ?? '') : [];
    if (head == null || tail == null) {
        return undefined;
    }

    const missing = IPV6_GROUPS - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) {
        return undefined;
    }

    return [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
}

// The last group may be an embedded IPv4 address, e.g. ::ffff:192.168.1.23.
function splitIpv6Half(half: string): number[] | undefined {
    if (half === '') {
        return [];
    }

    const parts = half.split(':');
    const last = parts.at(-1) ?? '';
    const embedded = last.includes('.') ? parseIpv4Octets(last) : undefined;
    if (last.includes('.') && embedded == null) {
        return undefined;
    }

    const hexParts = embedded == null ? parts : parts.slice(0, -1);
    if (!hexParts.every(part => IPV6_GROUP_PATTERN.test(part))) {
        return undefined;
    }

    const groups = hexParts.map(part => parseInt(part, 16));
    if (embedded == null) {
        return groups;
    }

    const [first = 0, second = 0, third = 0, fourth = 0] = embedded;

    return [...groups, (first << 8) | second, (third << 8) | fourth];
}

function formatIpv4(bytes: Uint8Array): string {
    return Array.from(bytes).join('.');
}

// RFC 5952: lowercase, no leading zeros, the longest run of two or more zero groups as "::".
function formatIpv6(bytes: Uint8Array): string {
    const groups = Array.from({ length: IPV6_GROUPS }, (_, index) => readGroup(bytes, index));
    const run = findLongestZeroRun(groups);
    const hex = groups.map(group => group.toString(16));
    if (run.length < 2) {
        return hex.join(':');
    }

    const head = hex.slice(0, run.start).join(':');
    const tail = hex.slice(run.start + run.length).join(':');

    return `${head}::${tail}`;
}

function readGroup(bytes: Uint8Array, index: number): number {
    return ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0);
}

function findLongestZeroRun(groups: readonly number[]): { start: number; length: number } {
    const best = { start: 0, length: 0 };
    let start = -1;

    groups.forEach((group, index) => {
        if (group !== 0) {
            start = -1;
            return;
        }

        if (start < 0) {
            start = index;
        }

        const length = index - start + 1;
        if (length > best.length) {
            best.start = start;
            best.length = length;
        }
    });

    return best;
}

function formatMdnsName(bytes: Uint8Array): string {
    const hex = bytesToHex(bytes);
    const groups = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)];

    return `${groups.join('-')}.local`;
}

function hexToBytes(hex: string): Uint8Array {
    const pairs = hex.match(/../g) ?? [];

    return Uint8Array.from(pairs, pair => parseInt(pair, 16));
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
