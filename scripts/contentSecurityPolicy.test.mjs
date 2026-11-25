// The page's connect-src and the nearby relay pool come from one list (src/discovery/relays.json);
// these tests fail when they drift apart, or when the policy opens more than those relays.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWN_RELAY_URLS, PUBLIC_RELAY_URLS, RELAY_URLS } from '../src/discovery/relayPool.ts';
import { buildContentSecurityPolicy, readRelayListAsync, validateRelayList } from './contentSecurityPolicy.mjs';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');

function directive(policy, name) {
    const found = policy.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `));

    return found?.split(/\s+/).slice(1) ?? [];
}

describe('content security policy', () => {
    it('lets the page reach exactly the pool\'s relays, and the own ones over https for their status', async () => {
        // Arrange
        const relayList = await readRelayListAsync();

        // Act
        const sources = directive(buildContentSecurityPolicy(relayList), 'connect-src');

        // Assert
        const ownStatus = OWN_RELAY_URLS.map(url => url.replace(/^wss:/, 'https:'));
        const ownSources = OWN_RELAY_URLS.flatMap((url, index) => [url, ownStatus[index]]);
        expect(sources).toEqual(["'self'", ...ownSources, ...PUBLIC_RELAY_URLS]);
        expect(sources.filter(source => source.startsWith('wss://'))).toEqual([...RELAY_URLS]);
        expect(relayList.own).toEqual([...OWN_RELAY_URLS]);
        expect(relayList.public).toEqual([...PUBLIC_RELAY_URLS]);
    });

    it('opens nothing wider than named hosts', async () => {
        // Act
        const policy = buildContentSecurityPolicy(await readRelayListAsync());

        // Assert
        expect(directive(policy, 'connect-src')).not.toContain('wss:');
        expect(directive(policy, 'connect-src')).not.toContain('https:');
        expect(directive(policy, 'connect-src').some(source => source.includes('*'))).toBe(false);
        expect(directive(policy, 'default-src')).toEqual(["'self'"]);
        expect(directive(policy, 'script-src')).toEqual(["'self'"]);
    });

    it('puts Ether\'s own relay first', async () => {
        // Act
        const relayList = await readRelayListAsync();

        // Assert
        expect(relayList.own[0]).toBe('wss://ether-relay.ether-web-app.workers.dev');
        expect(RELAY_URLS[0]).toBe(relayList.own[0]);
    });

    it.each([
        ['a flat list', ['wss://relay.example.org']],
        ['a URL with a path', { own: [], public: ['wss://relay.example.org/nostr'] }],
        ['an insecure URL', { own: ['ws://relay.example.org'], public: [] }],
        ['a source list injection', { own: [], public: ["wss://relay.example.org 'unsafe-eval'"] }],
    ])('refuses a relay list that is %s', (_, list) => {
        // Act
        const validate = () => validateRelayList(list);

        // Assert
        expect(validate).toThrow();
    });

    it('is what the build writes into index.html', async () => {
        // Arrange
        const build = await readFile(join(ROOT_DIRECTORY, 'scripts', 'build.mjs'), 'utf-8');
        const template = await readFile(join(ROOT_DIRECTORY, 'src', 'app', 'index.html'), 'utf-8');

        // Act & Assert
        expect(build).toContain('buildContentSecurityPolicy(await readRelayListAsync())');
        expect(build).not.toMatch(/connect-src/);
        expect(template).toContain('{{csp}}');
    });
});
