import { describe, expect, it } from 'vitest';
import { buildSdp, formatFingerprint, parseCandidate, parseSdp } from './sdp.js';
import type { RemoteDescription } from './sdp.js';

const SHA256 = '7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08';
const SHA384 = Array.from({ length: 48 }, (_, index) => (index * 5 + 3).toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
const SHA512 = Array.from({ length: 64 }, (_, index) => (255 - index).toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();

const CHROME_OFFER = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 52344 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 192.168.1.23',
    'a=candidate:2999745851 1 udp 2122260223 192.168.1.23 52344 typ host generation 0 network-id 1 network-cost 10',
    'a=candidate:1532871321 1 udp 2122194687 10.84.2.7 61021 typ host generation 0 network-id 2 network-cost 10',
    'a=candidate:4233069003 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-id 1',
    'a=ice-ufrag:x9cK',
    'a=ice-pwd:fJ4o0P2q7vG2nW+3bLk/XyZa',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${SHA256}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
].join('\r\n');

const CHROME_MDNS_ANSWER = [
    'v=0',
    'o=- 1830948823471092384 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 60111 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1467250027 1 udp 2122260223 3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local 60111 typ host generation 0 network-id 1',
    'a=candidate:1467250028 1 udp 2122262783 9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a.local 60112 typ host generation 0 network-id 2',
    'a=ice-ufrag:Qm7T',
    'a=ice-pwd:Zr0bH5kVd2yWq9Lx/Ae+1sGu',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${SHA256}`,
    'a=setup:active',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
].join('\r\n');

// Firefox puts the fingerprint at session level and writes the transport in upper case.
const FIREFOX_OFFER = [
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-126.0 6383766224345823937 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=sendrecv',
    `a=fingerprint:sha-512 ${SHA512}`,
    'a=group:BUNDLE data',
    'a=ice-options:trickle',
    'a=msid-semantic:WMS *',
    'm=application 54321 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 192.168.1.41',
    'a=candidate:0 1 UDP 2122252543 192.168.1.41 54321 typ host',
    'a=candidate:2 1 UDP 2122187007 fe80::1c2d:3e4f:5a6b:7c8d 54322 typ host',
    'a=candidate:1 1 TCP 2105524479 192.168.1.41 9 typ host tcptype active',
    'a=sendrecv',
    'a=end-of-candidates',
    'a=ice-pwd:4f1c0d2e9a8b7c6d5e4f3a2b1c0d9e8f',
    'a=ice-ufrag:1a2b3c4d',
    'a=mid:data',
    'a=setup:actpass',
    'a=sctp-port:5000',
    'a=max-message-size:1073741823',
    '',
].join('\r\n');

const FIREFOX_ANSWER = FIREFOX_OFFER.replace('a=setup:actpass', 'a=setup:passive');

const SAFARI_ANSWER = [
    'v=0',
    'o=- 7395874150201472119 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 1',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:842163049 1 udp 2122194687 5b6c7d8e-9fa0-4b1c-8d2e-3f4a5b6c7d8e.local 57412 typ host generation 0 network-cost 999',
    'a=candidate:1997543200 1 udp 2122129151 2a02:587:1234:5600:8c1:2b3c:4d5e:6f70 57413 typ host generation 0',
    'a=ice-ufrag:aB3+',
    'a=ice-pwd:Kq7/Ws0nRf2Jd9Vx4Lm8Ty1Z',
    'a=ice-options:trickle',
    `a=fingerprint:sha-384 ${SHA384}`,
    'a=setup:active',
    'a=mid:1',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
].join('\r\n');

describe('parseSdp', () => {
    it('reads a Chrome offer with IPv4 host candidates', () => {
        // Act
        const description = parseSdp(CHROME_OFFER);

        // Assert
        expect(description).toMatchObject({
            iceUfrag: 'x9cK',
            icePwd: 'fJ4o0P2q7vG2nW+3bLk/XyZa',
            setup: 'actpass',
            mid: '0',
            maxMessageSize: 262144,
        });
        expect(description?.fingerprint).toHaveLength(32);
        expect(description?.candidates.map(candidate => `${candidate.protocol} ${candidate.address}:${candidate.port}`)).toEqual([
            'udp 192.168.1.23:52344',
            'udp 10.84.2.7:61021',
            'tcp 192.168.1.23:9',
        ]);
    });

    it('reads a Chrome answer with mDNS names', () => {
        // Act
        const description = parseSdp(CHROME_MDNS_ANSWER);

        // Assert
        expect(description?.setup).toBe('active');
        expect(description?.candidates.map(candidate => candidate.address)).toEqual([
            '3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local',
            '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a.local',
        ]);
    });

    it('reads a Firefox offer with a session-level SHA-512 fingerprint, IPv6 and a non-zero mid', () => {
        // Act
        const description = parseSdp(FIREFOX_OFFER);

        // Assert
        expect(description).toMatchObject({
            iceUfrag: '1a2b3c4d',
            icePwd: '4f1c0d2e9a8b7c6d5e4f3a2b1c0d9e8f',
            setup: 'actpass',
            mid: 'data',
            maxMessageSize: 1073741823,
        });
        expect(description?.fingerprint).toHaveLength(64);
        expect(description?.candidates.map(candidate => candidate.protocol)).toEqual(['udp', 'udp', 'tcp']);
        expect(description?.candidates[1]?.address).toBe('fe80::1c2d:3e4f:5a6b:7c8d');
    });

    it('reads a Firefox answer', () => {
        // Act
        const description = parseSdp(FIREFOX_ANSWER);

        // Assert
        expect(description?.setup).toBe('passive');
    });

    it('reads a Safari answer with a SHA-384 fingerprint and mid 1', () => {
        // Act
        const description = parseSdp(SAFARI_ANSWER);

        // Assert
        expect(description?.mid).toBe('1');
        expect(description?.fingerprint).toHaveLength(48);
        expect(description?.iceUfrag).toBe('aB3+');
        expect(description?.candidates).toHaveLength(2);
    });

    it('leaves maxMessageSize out when the description has none', () => {
        // Arrange
        const sdp = CHROME_OFFER.replace('a=max-message-size:262144\r\n', '');

        // Act
        const description = parseSdp(sdp);

        // Assert
        expect(description?.maxMessageSize).toBeUndefined();
    });

    it.each([
        ['ice-ufrag', 'a=ice-ufrag:x9cK\r\n'],
        ['ice-pwd', 'a=ice-pwd:fJ4o0P2q7vG2nW+3bLk/XyZa\r\n'],
        ['fingerprint', `a=fingerprint:sha-256 ${SHA256}\r\n`],
        ['mid', 'a=mid:0\r\n'],
        ['setup', 'a=setup:actpass\r\n'],
    ])('returns undefined without %s', (_, line) => {
        // Arrange
        const sdp = CHROME_OFFER.replace(line, '');

        // Act
        const description = parseSdp(sdp);

        // Assert
        expect(description).toBeUndefined();
    });

    it('returns undefined when the fingerprint length does not match its algorithm', () => {
        // Arrange
        const sdp = CHROME_OFFER.replace('a=fingerprint:sha-256', 'a=fingerprint:sha-384');

        // Act
        const description = parseSdp(sdp);

        // Assert
        expect(description).toBeUndefined();
    });

    it('returns undefined without a data section', () => {
        // Act
        const description = parseSdp('v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n');

        // Assert
        expect(description).toBeUndefined();
    });
});

describe('parseCandidate', () => {
    it('reads a candidate attribute with or without the a= prefix', () => {
        // Act
        const withPrefix = parseCandidate('a=candidate:0 1 UDP 2122252543 192.168.1.41 54321 typ host');
        const without = parseCandidate('candidate:0 1 UDP 2122252543 192.168.1.41 54321 typ host');

        // Assert
        expect(withPrefix).toEqual({
            foundation: '0',
            component: 1,
            protocol: 'udp',
            priority: 2122252543,
            address: '192.168.1.41',
            port: 54321,
            type: 'host',
        });
        expect(without).toEqual(withPrefix);
    });

    it('returns undefined for a malformed candidate', () => {
        // Act
        const candidate = parseCandidate('candidate:0 1 UDP 2122252543 192.168.1.41');

        // Assert
        expect(candidate).toBeUndefined();
    });
});

describe('buildSdp', () => {
    const REMOTE: RemoteDescription = {
        iceUfrag: 'x9cK',
        icePwd: 'fJ4o0P2q7vG2nW+3bLk/XyZa',
        fingerprint: Uint8Array.from({ length: 32 }, (_, index) => index),
        setup: 'actpass',
        mid: 'data',
        maxMessageSize: 262144,
        candidates: [
            { address: '192.168.1.23', port: 52344 },
            { address: 'fe80::1c2d:3e4f:5a6b:7c8d', port: 52345 },
            { address: '3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local', port: 52346 },
        ],
    };

    it('writes only the standard lines of the template', () => {
        // Act
        const sdp = buildSdp(REMOTE, 1234);

        // Assert
        expect(sdp.split('\r\n')).toEqual([
            'v=0',
            'o=- 1234 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            'a=group:BUNDLE data',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
            'c=IN IP4 0.0.0.0',
            'a=candidate:1 1 udp 2130706431 192.168.1.23 52344 typ host',
            'a=candidate:2 1 udp 2130706175 fe80::1c2d:3e4f:5a6b:7c8d 52345 typ host',
            'a=candidate:3 1 udp 2130705919 3f2a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b.local 52346 typ host',
            'a=end-of-candidates',
            'a=ice-ufrag:x9cK',
            'a=ice-pwd:fJ4o0P2q7vG2nW+3bLk/XyZa',
            `a=fingerprint:sha-256 ${formatFingerprint(REMOTE.fingerprint)}`,
            'a=setup:actpass',
            'a=mid:data',
            'a=sctp-port:5000',
            'a=max-message-size:262144',
            '',
        ]);
    });

    it('names the fingerprint algorithm by its length', () => {
        // Arrange
        const sha384 = { ...REMOTE, fingerprint: new Uint8Array(48) };
        const sha512 = { ...REMOTE, fingerprint: new Uint8Array(64) };

        // Act
        const sdp384 = buildSdp(sha384, 1);
        const sdp512 = buildSdp(sha512, 1);

        // Assert
        expect(sdp384).toContain('a=fingerprint:sha-384 00:00:');
        expect(sdp512).toContain('a=fingerprint:sha-512 00:00:');
    });

    it('leaves out max-message-size when it is unknown', () => {
        // Arrange
        const remote = { ...REMOTE, maxMessageSize: undefined };

        // Act
        const sdp = buildSdp(remote, 1);

        // Assert
        expect(sdp).not.toContain('max-message-size');
    });

    it.each([
        ['Chrome offer', CHROME_OFFER],
        ['Chrome mDNS answer', CHROME_MDNS_ANSWER],
        ['Firefox offer', FIREFOX_OFFER],
        ['Firefox answer', FIREFOX_ANSWER],
        ['Safari answer', SAFARI_ANSWER],
    ])('rebuilds a %s that parses back to the same fields', (_, original) => {
        // Arrange
        const parsed = parseSdp(original);
        if (parsed == null) {
            throw new Error('fixture did not parse');
        }

        const udpHosts = parsed.candidates.filter(candidate => candidate.protocol === 'udp');

        // Act
        const rebuilt = parseSdp(buildSdp({ ...parsed, candidates: udpHosts }, 99));

        // Assert
        expect(rebuilt).toMatchObject({
            iceUfrag: parsed.iceUfrag,
            icePwd: parsed.icePwd,
            setup: parsed.setup,
            mid: parsed.mid,
            maxMessageSize: parsed.maxMessageSize,
        });
        expect(rebuilt?.fingerprint).toEqual(parsed.fingerprint);
        expect(rebuilt?.candidates.map(candidate => [candidate.address, candidate.port])).toEqual(
            udpHosts.map(candidate => [candidate.address, candidate.port]),
        );
    });
});
