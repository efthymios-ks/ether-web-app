import { afterEach, describe, expect, it } from 'vitest';
import type { BatchIncoming, GalleryItem } from '../client/clientTypes.js';
import { formatDay } from './format.js';
import { FILES_GROUP_BY_KEY, FILES_VIEW_KEY } from './gallery/filesPanel.js';
import { PAUSED_TEXT } from './shell/homePanel.js';
import { buttonByText, createTestApp, openPairMenuAsync, settleAsync, WIDE_VIEWPORT } from './testing/appHarness.js';
import type { TestApp, TestAppOptions } from './testing/appHarness.js';
import { createBatchRecord, createFileRecord, createSession } from './testing/fakeClient.js';

let harness: TestApp | undefined;

async function startAsync(options: TestAppOptions = {}): Promise<TestApp> {
    harness = createTestApp(options);
    await harness.app.startAsync();

    return harness;
}

async function connectAsync(options: TestAppOptions = {}): Promise<TestApp> {
    const app = await startAsync({ ...options, client: { sessions: [createSession()], ...options.client } });
    app.client.connect();
    await settleAsync();

    return app;
}

function galleryItem(fileId: string, overrides: Partial<GalleryItem> = {}): GalleryItem {
    return {
        fileId,
        sessionId: 'session-1',
        direction: 'in',
        name: `${fileId}.jpg`,
        mime: 'image/jpeg',
        size: 3_000_000,
        kind: 'image',
        status: 'received',
        hasThumbnail: false,
        hasData: true,
        ...overrides,
    };
}

describe('app shell', () => {
    afterEach(() => {
        harness?.dispose();
        harness = undefined;
        localStorage.clear();
    });

    it('opens the Settings sheet from the gear, beside Previous sessions, with no theme or admin button (AP-01)', async () => {
        // Arrange
        const { root } = await startAsync();
        const button = root.querySelector<HTMLButtonElement>('.app-header [data-role="settings"]');

        // Act
        button?.click();
        const sheet = document.querySelector<HTMLElement>('[role="dialog"][data-sheet="settings"]');

        // Assert
        expect([...root.querySelectorAll<HTMLElement>('.header-tools button')].map(tool => tool.dataset.role))
            .toEqual(['history-toggle', 'settings']);
        expect(root.querySelector('[data-role="theme-toggle"], [data-role="admin-toggle"]')).toBeNull();
        expect(button?.getAttribute('aria-label')).toBe('Settings');
        expect(button?.dataset.tooltip).toBe('Settings');
        expect(sheet?.querySelector('.dialog-title')?.textContent).toBe('Settings');
        expect(document.querySelector('.admin-panel')).toBeNull();
    });

    it('switches the theme from Settings: System, Light or Dark (UI-12)', async () => {
        // Arrange
        const { root, theme } = await startAsync();
        root.querySelector<HTMLButtonElement>('[data-role="settings"]')?.click();
        const dark = document.querySelector<HTMLButtonElement>('[data-sheet="settings"] [data-theme="dark"]');

        // Act
        dark?.click();

        // Assert
        expect(document.documentElement.dataset.theme).toBe('dark');
        expect(theme.preference).toBe('dark');
        expect(dark?.getAttribute('aria-pressed')).toBe('true');
    });

    it('shows the peer’s health once, in the peer bar, with no pill in the header (§4.1)', async () => {
        // Arrange
        const { root, client } = await connectAsync();

        // Act
        client.emit('health', { status: 'weak', rttMs: 41.6, lastSeenMs: 7000, peerHidden: false });

        // Assert
        expect(root.querySelector('.peer-pill')).toBeNull();
        expect([...root.querySelectorAll('.app-header button')].map(button => button.getAttribute('aria-label')))
            .toEqual(['Ether, home', 'Previous sessions', 'Settings']);
        expect(root.querySelector('.health-text')?.textContent).toBe('Weak · 42 ms');
        expect(root.textContent?.match(/Weak/g)).toHaveLength(1);
    });

    it('shows who this device is on Home; a tap on the name renames it and a tap on the PIN sets one (R10)', async () => {
        // Arrange
        const { root, client } = await startAsync({ client: { settings: { deviceName: 'Swift Perseus' } } });
        const name = root.querySelector<HTMLButtonElement>('.me [data-action="rename"]');
        const pin = root.querySelector<HTMLButtonElement>('.me [data-action="set-pin"]');
        const before = {
            text: root.querySelector('.me')?.textContent,
            nameLabel: name?.getAttribute('aria-label'),
            pinLabel: pin?.getAttribute('aria-label'),
        };

        // Act
        name?.focus();
        name?.click();
        const renameTitle = document.querySelector('[role="dialog"] .dialog-title')?.textContent;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        const focusAfterRename = document.activeElement;
        pin?.click();
        const pinTitle = document.querySelector('[role="dialog"] .dialog-title')?.textContent;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await client.configureAsync({ pin: '2468' });

        // Assert
        expect(before).toEqual({
            text: 'You areSwift PerseusPINnone',
            nameLabel: 'Device name: Swift Perseus, change it',
            pinLabel: 'PIN: none, set one',
        });
        expect(renameTitle).toBe('Device name');
        expect(focusAfterRename).toBe(name);
        expect(pinTitle).toBe('Set a PIN');
        expect(root.querySelector('.me')?.textContent).toBe('You areSwift PerseusPIN••••');
        expect(pin?.getAttribute('aria-label')).toBe('PIN: set, change it');
        expect(root.textContent).not.toContain('2468');
    });

    it('goes Home from the logo while connected, where the Connected card opens the session (R9)', async () => {
        // Arrange
        const { root, client } = await connectAsync();
        client.emit('file-state', createFileRecord({ state: 'active' }));
        await settleAsync(150);

        // Act
        root.querySelector<HTMLButtonElement>('.app-header [data-role="home"]')?.click();
        await settleAsync();
        const home = {
            screen: root.dataset.screen,
            card: root.querySelector('.connected-card')?.getAttribute('aria-label'),
            tags: [...root.querySelectorAll('.connected-card .badge:not([hidden])')].map(tag => tag.textContent),
            paused: root.querySelector<HTMLElement>('.home-paused')?.hidden === false
                ? root.querySelector('.home-paused')?.textContent
                : undefined,
            isNearbyHidden: root.querySelector<HTMLElement>('.home-nearby')?.hidden,
            isCodeLinkHidden: root.querySelector('[data-action="pair-with-code"]')?.closest('[hidden]') != null,
        };
        root.querySelector<HTMLButtonElement>('.connected-card')?.click();
        await settleAsync();

        // Assert
        expect(home).toEqual({
            screen: 'home',
            card: 'Open session with Pixel 8 · Blue Otter',
            tags: ['Connected', 'Transferring'],
            paused: PAUSED_TEXT,
            isNearbyHidden: true,
            isCodeLinkHidden: true,
        });
        expect(root.dataset.screen).toBe('session');
    });

    it('says Connection lost on Home’s card, and lists nearby devices again, once the link drops', async () => {
        // Arrange
        const { root, client } = await connectAsync();
        root.querySelector<HTMLButtonElement>('.app-header [data-role="home"]')?.click();
        await settleAsync();

        // Act
        client.setState('lost');
        await settleAsync();

        // Assert
        expect([...root.querySelectorAll('.connected-card .badge:not([hidden])')].map(tag => tag.textContent)).toEqual(['Connection lost']);
        expect(root.querySelector('.connected-card .badge')?.getAttribute('data-tone')).toBe('fail');
        expect(root.querySelector<HTMLElement>('.home-paused')?.hidden).toBe(true);
        expect(root.querySelector<HTMLElement>('.home-nearby')?.hidden).toBe(false);
        expect(root.querySelector('[data-action="pair-with-code"]')?.closest('[hidden]')).toBeNull();
    });

    it('offers Pair with a code in Home’s pane beside the sidebar, with one orbit and no link to it (D9)', async () => {
        // Arrange
        const { root, client } = await startAsync({ viewport: WIDE_VIEWPORT });
        const pane = (): HTMLElement | null => root.querySelector<HTMLElement>('.app-pane');
        const visibleOrbits = (): number => [...root.querySelectorAll('.orbit')]
            .filter(orbit => orbit.closest('[hidden]') == null).length;
        const home = {
            split: root.dataset.split,
            title: pane()?.querySelector('.home-pane h2')?.textContent,
            tiles: [...(pane()?.querySelectorAll('.pair-tile') ?? [])].map(tile => tile.textContent),
            paste: pane()?.querySelector('.link-button')?.textContent,
            paneOrbits: pane()?.querySelectorAll('.orbit').length,
            orbits: visibleOrbits(),
        };

        // Act
        pane()?.querySelector<HTMLButtonElement>('[data-action="show-code"]')?.click();
        await settleAsync();
        const shown = root.dataset.screen;
        pane()?.querySelector<HTMLButtonElement>('[data-action="back"]')?.click();
        await settleAsync();
        const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
        Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'hello' } });
        document.body.dispatchEvent(event);
        await settleAsync();

        // Assert
        expect(home).toEqual({
            split: 'true',
            title: 'Or pair with a code',
            tiles: ['Show my code', 'Scan a code'],
            paste: 'Paste a code',
            paneOrbits: 0,
            orbits: 1,
        });
        expect(shown).toBe('offer');
        expect(root.dataset.screen).toBe('home');
        expect(client.callsTo('cancelPairing').length).toBeGreaterThan(0);
        expect(pane()?.querySelector('.code-message')?.textContent).toBe('That isn’t an Ether code. Copy it again and try once more.');
        expect(root.querySelector('.home-panel .home-message')?.children).toHaveLength(0);
    });

    it('lets Home and pairing with a code split into a sidebar and a pane, but not a session or a connected Home (§4.9, D8)', async () => {
        // Arrange
        const { root, client } = await startAsync({ client: { sessions: [createSession()] } });
        const layouts: Array<[string | undefined, string | undefined]> = [[root.dataset.screen, root.dataset.split]];

        // Act
        await openPairMenuAsync(root);
        layouts.push([root.dataset.screen, root.dataset.split]);
        harness?.app.navigate({ name: 'session', sessionId: 'session-1' });
        layouts.push([root.dataset.screen, root.dataset.split]);
        client.connect();
        await settleAsync();
        harness?.app.navigate({ name: 'home' });
        layouts.push([root.dataset.screen, root.dataset.split]);

        // Assert
        expect(layouts).toEqual([['home', 'true'], ['pair', 'true'], ['session', 'false'], ['home', 'false']]);
        expect(root.querySelector('main > .home-panel + .app-pane')).not.toBeNull();
    });

    it('offers the platform’s pickers as tiles on the Send tab, with no action bar and no picking tips (§5)', async () => {
        // Act
        const { root } = await connectAsync({ platform: 'ios' });
        const tiles = (app: HTMLElement): string[] => [...app.querySelectorAll('#panel-send .picker-tile')].map(tile => tile.textContent ?? '');

        // Assert
        expect(tiles(root)).toEqual(['Photos & videos', 'Files']);
        expect(root.querySelector('.action-bar')).toBeNull();
        expect(root.textContent).not.toMatch(/Tips for picking|Pick a few hundred|Options/);
        harness?.dispose();
        const desktop = await connectAsync({ platform: 'desktop' });
        expect(tiles(desktop.root)).toEqual(['Files', 'Folder']);
        expect(desktop.root.querySelector('.action-bar')).toBeNull();
        expect(desktop.root.textContent).not.toMatch(/Tips for picking|drag|drop/i);
    });

    it('says nothing in a toast about connecting or sending, which the screen already shows', async () => {
        // Arrange
        const { root, client } = await connectAsync();
        const input = root.querySelector<HTMLInputElement>('[data-picker="files"]');
        Object.defineProperty(input, 'files', { value: [new File(['x'], 'IMG_1.jpg')], configurable: true });

        // Act
        input?.dispatchEvent(new Event('change'));
        await settleAsync();

        // Assert
        expect(client.callsTo('sendFilesAsync')).toHaveLength(1);
        expect(document.querySelectorAll('.toast')).toHaveLength(0);
    });

    it('sends picked files with their folder paths and switches to the Send tab (PK-03)', async () => {
        // Arrange
        const { root, client } = await connectAsync();
        const input = root.querySelector<HTMLInputElement>('[data-picker="folder"]');
        const file = new File(['x'], 'IMG_1.jpg');
        Object.defineProperty(file, 'webkitRelativePath', { value: 'Trip/IMG_1.jpg' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });

        // Act
        input?.dispatchEvent(new Event('change'));
        await settleAsync();

        // Assert
        expect(client.callsTo('sendFilesAsync')).toEqual([[[file], { relativePaths: ['Trip/IMG_1.jpg'] }]]);
        expect(root.querySelector('[data-tab="send"]')?.getAttribute('aria-selected')).toBe('true');
    });

    it('lists paused transfers when the link is lost and offers to pair again on the peer bar (HC-05, UI-11)', async () => {
        // Arrange
        const { root, client } = await connectAsync({
            client: { files: [createFileRecord({ state: 'paused', pausedBy: 'link', name: 'IMG_2231.MOV' })] },
        });

        // Act
        client.setState('lost');
        await settleAsync();

        // Assert
        expect(root.querySelector('.peer-bar')?.getAttribute('data-link')).toBe('lost');
        expect(root.querySelector('.peer-bar .status-sub')?.textContent).toBe('Connection lost · 1 paused');
        expect(root.querySelector<HTMLElement>('.peer-bar .status-sub')?.title).toBe('IMG_2231.MOV');
        expect(root.querySelector('.peer-bar [data-action="use-code"]')?.textContent).toBe('Use a code');
    });

    it('asks in a dialog for a batch, with Accept what fits when space is short (BK-03, D7, test 33)', async () => {
        // Arrange
        const { root, client } = await connectAsync();
        const batch: BatchIncoming = {
            batchId: 'batch-big',
            peerName: 'Pixel 8',
            itemCount: 1240,
            totalBytes: 3_800_000_000,
            freeBytes: 2_000_000_000,
            fitsCount: 600,
            fitsBytes: 1_900_000_000,
            spaceIsShort: true,
        };

        // Act
        client.emit('batch-incoming', batch);
        const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-prompt="receive"]');
        const asked = {
            title: dialog?.querySelector('.dialog-title')?.textContent,
            message: dialog?.querySelector('.dialog-message')?.textContent,
            answers: [...(dialog?.querySelectorAll<HTMLButtonElement>('[data-answer]') ?? [])].map(button => button.textContent),
        };
        buttonByText(dialog ?? document.body, 'Accept what fits (600)')?.click();
        await settleAsync();

        // Assert
        expect(asked).toEqual({
            title: 'Pixel 8 wants to send you 1,240 items',
            message: '3.8 GB · Free: 2.0 GB. Not everything fits.',
            answers: ['Decline', 'Accept what fits (600)', 'Accept all'],
        });
        expect(root.querySelector('.prompt-card')).toBeNull();
        expect(client.callsTo('acceptBatchAsync')).toEqual([['batch-big', { mode: 'fits' }]]);
        expect(document.querySelector('[data-prompt="receive"]')).toBeNull();
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent).toBe('Receiving the 600 items that fit. The rest are skipped.');
        expect(root.querySelector('[data-tab="send"]')?.getAttribute('aria-selected')).toBe('true');
    });

    it('asks only Decline or Accept when the batch fits, and declines on Escape (D7)', async () => {
        // Arrange
        const { client } = await connectAsync();
        const batch: BatchIncoming = {
            batchId: 'batch-small',
            peerName: 'Pixel 8',
            itemCount: 24,
            totalBytes: 186_000_000,
            freeBytes: 21_000_000_000,
            fitsCount: 24,
            fitsBytes: 186_000_000,
            spaceIsShort: false,
        };

        // Act
        client.emit('batch-incoming', batch);
        const dialog = document.querySelector<HTMLElement>('[data-prompt="receive"]');
        const asked = {
            message: dialog?.querySelector('.dialog-message')?.textContent,
            answers: [...(dialog?.querySelectorAll<HTMLButtonElement>('[data-answer]') ?? [])].map(button => button.textContent),
            focused: document.activeElement?.textContent,
        };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settleAsync();

        // Assert
        expect(asked).toEqual({ message: '186 MB · Free: 21.0 GB.', answers: ['Decline', 'Accept'], focused: 'Accept' });
        expect(client.callsTo('declineBatchAsync')).toEqual([['batch-small']]);
        expect([...document.querySelectorAll('.toast')].at(-1)?.textContent).toBe('Declined 24 items from Pixel 8.');
    });

    it('stops receiving a file after one confirm and deletes what arrived, without asking about the partial (TR-09)', async () => {
        // Arrange
        const record = createFileRecord({
            direction: 'in',
            state: 'active',
            pagination: { pageSize: 1_048_576, totalPages: 10, currentPage: 3, pagesDone: 3, slot: 1 },
        });
        const { root, client } = await connectAsync({ client: { files: [record] } });
        await settleAsync(350);

        // Act
        root.querySelector<HTMLButtonElement>('#panel-send .progress-line .line-open')?.click();
        await settleAsync();
        document.querySelector<HTMLButtonElement>('.files-row-menu [data-action="cancel"]')?.click();
        await settleAsync();
        const title = document.querySelector('[role="dialog"] h2')?.textContent;
        const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [data-choice]')].map(button => button.textContent);
        document.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();
        await settleAsync();

        // Assert
        expect(title).toBe('Stop receiving?');
        expect(choices).toEqual(['Keep receiving', 'Stop']);
        expect(client.callsTo('cancelAsync')).toEqual([[{ sessionId: record.sessionId, fileId: record.fileId, direction: 'in' }]]);
    });

    it('asks nothing when the sender stops a file this device was receiving (TR-09)', async () => {
        // Arrange
        const { client } = await connectAsync();
        const record = createFileRecord({
            direction: 'in',
            state: 'canceled',
            pagination: { pageSize: 1_048_576, totalPages: 10, currentPage: 3, pagesDone: 3, slot: null },
        });

        // Act
        client.emit('file-state', record);
        await settleAsync(150);

        // Assert
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(client.callsTo('deletePartialAsync')).toEqual([]);
    });

    it('resumes needs-file items from files picked again, and offers to send the rest (PK-05, test 9)', async () => {
        // Arrange
        const record = createFileRecord({ state: 'needs-file', pagination: { pageSize: 1_048_576, totalPages: 10, currentPage: 3, pagesDone: 3, slot: null } });
        const { root, client } = await connectAsync({ client: { files: [record] } });
        await settleAsync(350);
        const resumeInput = root.querySelector<HTMLInputElement>('[data-picker="resume"]');
        const picked = [new File(['x'], 'IMG_2231.MOV'), new File(['y'], 'other.txt')];
        client.behaviour.resumeWithFilesAsync = async () => ({ matched: [record], unmatched: [picked[1] as File] });

        // Act
        root.querySelector<HTMLButtonElement>('[data-action="pick-again"]')?.click();
        Object.defineProperty(resumeInput, 'files', { value: picked, configurable: true });
        resumeInput?.dispatchEvent(new Event('change'));
        await settleAsync();
        document.querySelector<HTMLButtonElement>('[data-choice="confirm"]')?.click();
        await settleAsync();

        // Assert
        expect(client.callsTo('resumeWithFilesAsync').map(([, options]) => options)).toEqual([{ sessionId: 'session-1' }]);
        expect(client.callsTo('sendFilesAsync')).toEqual([[[picked[1]], undefined]]);
    });

    it('asks in the same dialog for files waiting under Ask before receiving (SP-07)', async () => {
        // Arrange
        const { client } = await connectAsync();
        const record = createFileRecord({ direction: 'in', state: 'incoming', name: 'contract.pdf', size: 120_000 });

        // Act
        client.emit('file-incoming', record);
        await settleAsync(150);
        const dialog = document.querySelector<HTMLElement>('[data-prompt="receive"]');
        const asked = {
            title: dialog?.querySelector('.dialog-title')?.textContent,
            message: dialog?.querySelector('.dialog-message')?.textContent,
        };
        buttonByText(dialog ?? document.body, 'Accept')?.click();
        await settleAsync();

        // Assert
        expect(asked).toEqual({ title: 'Pixel 8 · Blue Otter wants to send you contract.pdf', message: '120 kB' });
        expect(client.callsTo('acceptIncomingAsync')).toEqual([[{ sessionId: record.sessionId, fileId: record.fileId, direction: 'in' }]]);
        expect(document.querySelector('[data-prompt="receive"]')).toBeNull();
    });

    it('holds the wake lock during a transfer and warns iPhone users to keep the app open (WL-01, WL-04)', async () => {
        // Arrange
        const { root, client, wakeLock } = await connectAsync({ platform: 'ios' });

        // Act
        client.emit('file-state', createFileRecord({ state: 'active' }));
        await settleAsync(150);

        // Assert
        expect(wakeLock.isWanted).toBe(true);
        expect(root.querySelector('[data-banner="keep-open"]')?.textContent).toContain('Keep the app open until done');
    });

    it('shows Keep this screen open when the browser has no Wake Lock (WL-03)', async () => {
        // Arrange
        Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });
        const { root, client } = await connectAsync({ wakeLockSupported: false });

        // Act
        client.emit('file-state', createFileRecord({ state: 'active' }));
        await settleAsync(150);

        // Assert
        expect(root.querySelector('[data-banner="wake"]')).not.toBeNull();
    });

    it('holds an update until the transfer ends (PW-03)', async () => {
        // Arrange
        let notifyUpdate: () => void = () => undefined;
        let applied = 0;
        const { root, client } = await connectAsync({
            app: {
                serviceWorker: {
                    onUpdateReady: handler => {
                        notifyUpdate = handler;

                        return () => undefined;
                    },
                    applyUpdate: () => applied++,
                },
            },
        });
        client.emit('file-state', createFileRecord({ state: 'active' }));
        await settleAsync(150);

        // Act
        notifyUpdate();
        const duringTransfer = root.querySelector('[data-banner="update"]')?.textContent;
        client.emit('file-done', createFileRecord({ state: 'done' }));
        await settleAsync(150);
        buttonByText(root, 'Update now')?.click();

        // Assert
        expect(duringTransfer).toContain('once the transfer finishes');
        expect(applied).toBe(1);
    });

    it('shows a banner while a test tool is on (§16.3)', async () => {
        // Arrange
        const { root, client } = await connectAsync();

        // Act
        client.setTestTool('corrupt-pages', true);

        // Assert
        expect(root.querySelector('[data-banner="test-tools"]')?.textContent).toContain('corrupt pages');
    });

    it('lists sessions in the Previous sessions drawer and opens one’s files when it isn’t nearby (§7.6, §4.8)', async () => {
        // Arrange
        const { root } = await startAsync({
            client: { sessions: [createSession({ unfinishedCount: 3 })], files: [createFileRecord({ direction: 'in', state: 'done', hasData: true })] },
        });

        // Act
        root.querySelector<HTMLButtonElement>('[data-role="history-toggle"]')?.click();
        const drawer = document.querySelector<HTMLElement>('.dialog[data-variant="drawer"]');
        const tags = [...(drawer?.querySelectorAll<HTMLElement>('.session-tags .badge:not([hidden])') ?? [])].map(tag => tag.textContent);
        drawer?.querySelector<HTMLButtonElement>('[data-action="open-session"]')?.click();
        await settleAsync();
        buttonByText(document.body, 'See files')?.click();
        await settleAsync();

        // Assert
        expect(drawer?.querySelector('.session-name')?.textContent).toBe('Pixel 8 · Blue Otter');
        expect(tags).toEqual(['3 unfinished']);
        expect(document.querySelector('.dialog')).toBeNull();
        expect(root.dataset.screen).toBe('session');
        expect([...root.querySelectorAll('[role="tab"] .tab-label')].map(tab => tab.textContent)).toEqual(['Send', 'Received', 'Sent']);
        expect([...root.querySelectorAll('[role="tab"] .tab-count')].map(count => count.textContent)).toEqual(['', '1', '0']);
        expect(root.querySelector('[data-tab="received"]')?.getAttribute('aria-label')).toBe('Received, 1 files');
        expect(root.querySelector('[data-tab="received"]')?.getAttribute('aria-selected')).toBe('true');
        expect(root.querySelector('#panel-received .file-row')).not.toBeNull();
    });

    it('virtualises a received list above 200 rows (UI-10)', async () => {
        // Arrange
        const files = Array.from({ length: 450 }, (_, index) => createFileRecord({
            fileId: `file-${index}`,
            direction: 'in',
            state: 'done',
            hasData: true,
            completedAt: index,
        }));
        const { root } = await startAsync({ client: { sessions: [createSession()], files } });

        // Act
        harness?.app.navigate({ name: 'session', sessionId: 'session-1' });
        await settleAsync(20);

        // Assert
        const rendered = root.querySelectorAll('#panel-received .file-row').length;
        expect(rendered).toBeGreaterThan(0);
        expect(rendered).toBeLessThan(100);
    });

    it('shows the peer bar, then the tabs, with no connection log', async () => {
        // Arrange
        const { root } = await startAsync({
            client: {
                sessions: [createSession({
                    connections: [{ connectionId: 'c-1', start: Date.parse('2026-11-23T14:02:00'), end: Date.parse('2026-11-23T14:20:00') }],
                })],
            },
        });

        // Act
        harness?.app.navigate({ name: 'session', sessionId: 'session-1' });
        await settleAsync();

        // Assert
        const screen = root.querySelector('.session-screen');
        expect(screen?.firstElementChild?.classList.contains('session-status')).toBe(true);
        expect(screen?.lastElementChild?.classList.contains('tab-panels')).toBe(true);
        expect(screen?.querySelector('details')).toBeNull();
        expect(screen?.textContent).not.toContain('Connection log');
    });

    it('shows a BK-01 batch with its count, and always the counts, bytes, speed and time left', async () => {
        // Arrange
        const { root, client } = await connectAsync({
            client: {
                batches: [createBatchRecord({ itemCount: 12, received: 8, saved: 3, failed: 1 })],
                files: [createFileRecord({ direction: 'in', state: 'active', batchId: 'batch-1' })],
            },
        });
        await settleAsync(350);

        // Act
        client.emit('batch-progress', {
            batchId: 'batch-1',
            sessionId: 'session-1',
            direction: 'in',
            total: 12,
            done: 9,
            saved: 3,
            failed: 1,
            canceled: 0,
            bytesDone: 6_000_000,
            totalBytes: 9_000_000,
            bytesPerSecond: 2_000_000,
            secondsLeft: 2,
        });
        await settleAsync(150);
        const card = root.querySelector('.batch-card');

        // Assert
        expect(card?.querySelector('.batch-title')?.textContent).toBe('Receiving from Pixel 8 · Blue Otter');
        expect(card?.querySelector('.batch-count')?.textContent).toBe('9 of 12 · 1 failed');
        expect(root.querySelector('.transfer-total .total-counts')?.textContent).toBe('9 of 12 done · 3 downloaded · 1 failed');
        expect(root.querySelector('.transfer-total .total-bytes')?.textContent).toBe('6.0 MB of 9.0 MB · 2.0 MB/s');
        expect(root.querySelector('.transfer-total .total-left')?.textContent).toBe('2 s left');
    });

    it('shows Received as tiles by day and downloads a selected day as one ZIP (GL-03, SV-04)', async () => {
        // Arrange
        localStorage.setItem(FILES_VIEW_KEY, 'tiles');
        localStorage.setItem(FILES_GROUP_BY_KEY, 'day');
        const { root, client } = await startAsync({
            platform: 'ios',
            client: {
                sessions: [createSession()],
                gallery: [{ day: '2026-11-23', items: [galleryItem('a'), galleryItem('b'), galleryItem('c', { kind: 'video', mime: 'video/quicktime', durationSeconds: 42 })] }],
            },
        });
        harness?.app.navigate({ name: 'session', sessionId: 'session-1' });
        await settleAsync();

        // Act
        root.querySelector<HTMLButtonElement>('[data-tab="received"]')?.click();
        await settleAsync();
        const received = root.querySelector<HTMLElement>('#panel-received') ?? root;
        buttonByText(received, 'Select')?.click();
        buttonByText(received, 'Select day')?.click();
        const selected = received.querySelector('.selection-count')?.textContent;
        buttonByText(received, 'Download ZIP (3)')?.click();
        await settleAsync();

        // Assert
        expect(root.querySelector('.gallery-day-title')?.textContent).toBe(formatDay('2026-11-23'));
        expect(root.querySelectorAll('.gallery-cell')).toHaveLength(3);
        expect(root.querySelector('.gallery-duration:not([hidden])')?.textContent).toBe('0:42');
        expect(selected).toBe('3 selected');
        expect(client.callsTo('buildZipAsync')).toEqual([['session-1', ['a', 'b', 'c']]]);
        expect(client.callsTo('markSavedAsync')).toEqual([['session-1', ['a', 'b', 'c']]]);
    });

    it('opens Details on a tap and the viewer from its preview, never by itself, with Open in Maps on tap only (GL-06, MD-07, SP-06)', async () => {
        // Arrange
        const record = createFileRecord({
            fileId: 'a',
            direction: 'in',
            state: 'done',
            hasData: true,
            name: 'a.jpg',
            mime: 'image/jpeg',
            kind: 'image',
            rootHash: '5d2c8e7f9a0b1c2d',
            metadata: { takenAt: '2026-11-23T14:05:42+01:00', latitude: 37.97153, longitude: 23.72575, make: 'Apple', model: 'iPhone 15' },
        });
        localStorage.setItem(FILES_VIEW_KEY, 'tiles');
        const { root, client } = await startAsync({
            platform: 'ios',
            client: { sessions: [createSession()], files: [record], gallery: [{ day: '2026-11-23', items: [galleryItem('a'), galleryItem('b')] }] },
        });
        harness?.app.navigate({ name: 'session', sessionId: 'session-1' });
        await settleAsync();
        root.querySelector<HTMLButtonElement>('[data-tab="received"]')?.click();
        await settleAsync();
        const filesBefore = client.callsTo('getReceivedFileAsync').length;

        // Act
        root.querySelector<HTMLButtonElement>('.gallery-cell')?.click();
        await settleAsync(20);
        const details = document.querySelector('.files-details');
        const detailsText = details?.textContent;
        const detailsLink = details?.querySelector<HTMLAnchorElement>('.files-map-link');
        const filesWithDetails = client.callsTo('getReceivedFileAsync').length;
        details?.querySelector<HTMLButtonElement>('.files-details-preview')?.click();
        await settleAsync(20);
        const viewer = document.querySelector('.viewer');
        const link = viewer?.querySelector<HTMLAnchorElement>('.viewer-map-link');

        // Assert
        expect(filesBefore).toBe(0);
        expect(filesWithDetails).toBe(0);
        expect(detailsText).toContain('Apple iPhone 15');
        expect(detailsText).toContain('Every page matched (5d2c8e7f…)');
        expect(details?.querySelector('[data-action="compute-sha256"]')?.textContent).toBe('Compute');
        expect(detailsLink?.href).toContain('maps.apple.com');
        expect([...(details?.querySelectorAll('.files-sheet-actions button') ?? [])].map(button => button.textContent))
            .toEqual(['Download ZIP', 'Delete']);
        expect(viewer?.querySelector('.viewer-position')?.textContent).toBe('1 of 2');
        expect(viewer?.querySelector('.viewer-image')).not.toBeNull();
        expect(viewer?.textContent).toContain('Apple iPhone 15');
        expect(viewer?.textContent).toContain('Every page matched (5d2c8e7f…)');
        expect(viewer?.querySelector('[data-action="compute-sha256"]')?.textContent).toBe('Compute');
        expect(link?.href).toContain('maps.apple.com');
        expect(link?.target).toBe('_blank');
        expect([...(viewer?.querySelectorAll('.viewer-actions button') ?? [])].map(button => button.textContent)).toEqual(['Download ZIP', 'Delete']);
    });
});
