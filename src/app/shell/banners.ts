import type { TestTool } from '../../client/clientTypes.js';
import type { RelayAllowanceNotice } from '../../discovery/discoveryTypes.js';
import type { InstallMethod } from '../../platform/platform.js';
import { h } from '../dom.js';
import { formatTime } from '../format.js';
import { ICONS } from '../icons.js';

// The notice under the header, one at a time, from one table in order of priority: in-app browsers (DD-08),
// test tools (§16.3), keep the app open (WL-03, WL-04), update ready (PW-03), the nearby-devices relay's daily
// allowance, install (PW-05) and identity (DN-05). The first that applies and isn't dismissed shows; the next one
// shows once it goes. Safari's storage limit (PW-07) gets no banner.

export interface BannerState {
    readonly updateReady: boolean;
    readonly isTransferring: boolean;
    readonly testTools: readonly TestTool[];
    // WL-03: the screen should stay on but this browser has no Wake Lock.
    readonly wakeUnsupported: boolean;
    readonly backgroundWarning?: string;
    readonly identityNote?: string;
    readonly install?: { readonly method: InstallMethod; readonly canPrompt: boolean };
    readonly inAppNote?: string;
    // Ether's own relay for nearby devices used up its free daily allowance, or stopped answering.
    readonly relayAllowance?: RelayAllowanceNotice;
}

export interface BannerHandlers {
    applyUpdate(): void;
    turnOffTestTools(): void;
    promptInstall(): void;
    showInstallSteps(): void;
    copyLink(): void;
}

interface BannerAction {
    readonly label: string;
    run(handlers: BannerHandlers): void;
}

interface BannerDefinition {
    readonly id: string;
    readonly tone: 'info' | 'warn' | 'fail';
    // Remembered across visits when set; otherwise hidden until the next page load.
    readonly rememberDismissal?: boolean;
    readonly isDismissible?: boolean;
    // A dismissal that holds until this time (epoch ms), across visits, instead of for good.
    dismissUntil?(state: BannerState): number;
    // The text follows the clock, e.g. a countdown, so it is drawn again every minute while shown.
    readonly followsClock?: boolean;
    when(state: BannerState): boolean;
    // A short lead in bold before the text, so the gist fits the first line or two on a phone.
    title?(state: BannerState): string;
    text(state: BannerState): string;
    actions?(state: BannerState): readonly BannerAction[];
}

const TEST_TOOL_LABELS: Readonly<Record<TestTool, string>> = Object.freeze({
    'corrupt-pages': 'corrupt pages',
    'drop-ack': 'drop acks',
    'fill-storage': 'fill storage',
});

export const DISMISS_KEY_PREFIX = 'ether.dismissed.';

const MINUTE_MS = 60_000;

export const RELAY_USED_UP_TEXT = 'The nearby-devices relay has used up today’s free Cloudflare allowance.';
export const RELAY_SILENT_TEXT = 'The nearby-devices relay isn’t answering. '
    + 'Today’s free Cloudflare allowance is probably used up.';

// "5 h 12 min", "12 min"; at least a minute.
function formatWait(ms: number): string {
    const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) {
        return `${minutes} min`;
    }

    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function relayResetText(notice: RelayAllowanceNotice | undefined, now: number): string {
    const fallback = 'Nearby devices still show through public relays, and the QR code always works.';
    if (notice == null) {
        return fallback;
    }

    const reset = notice.resetsAt > now
        ? `It starts again at ${formatTime(notice.resetsAt)} (in ${formatWait(notice.resetsAt - now)}).`
        : 'It should start again any minute now.';

    return `${reset} ${fallback}`;
}

// Order is the priority: the first that applies shows.
export const BANNERS: readonly BannerDefinition[] = [
    {
        id: 'in-app',
        tone: 'warn',
        when: state => state.inAppNote != null,
        text: state => state.inAppNote ?? '',
        actions: () => [{ label: 'Copy link', run: handlers => handlers.copyLink() }],
    },
    {
        id: 'test-tools',
        tone: 'fail',
        when: state => state.testTools.length > 0,
        text: state => `Test tool active: ${state.testTools.map(tool => TEST_TOOL_LABELS[tool]).join(', ')}.`,
        actions: () => [{ label: 'Turn off', run: handlers => handlers.turnOffTestTools() }],
    },
    {
        id: 'keep-open',
        tone: 'warn',
        when: state => state.isTransferring && state.backgroundWarning != null,
        text: state => state.backgroundWarning ?? '',
    },
    {
        id: 'wake',
        tone: 'warn',
        when: state => state.wakeUnsupported,
        text: () => 'Keep this screen open: this browser can’t keep it on by itself.',
    },
    {
        id: 'update',
        tone: 'info',
        when: state => state.updateReady,
        text: state => (state.isTransferring
            ? 'An update is ready. It can install once the transfer finishes.'
            : 'An update is ready.'),
        actions: state => (state.isTransferring ? [] : [{ label: 'Update now', run: handlers => handlers.applyUpdate() }]),
    },
    {
        id: 'relay-allowance',
        tone: 'info',
        isDismissible: true,
        followsClock: true,
        dismissUntil: state => state.relayAllowance?.resetsAt ?? 0,
        when: state => state.relayAllowance != null,
        title: state => (state.relayAllowance?.isCertain === true ? RELAY_USED_UP_TEXT : RELAY_SILENT_TEXT),
        text: state => relayResetText(state.relayAllowance, Date.now()),
    },
    {
        id: 'install',
        tone: 'info',
        isDismissible: true,
        rememberDismissal: true,
        when: state => state.install != null && (state.install.canPrompt || state.install.method === 'instructions'),
        text: () => 'Install Ether to open it offline, with its own storage.',
        actions: state => [state.install?.canPrompt === true
            ? { label: 'Install', run: handlers => handlers.promptInstall() }
            : { label: 'How?', run: handlers => handlers.showInstallSteps() }],
    },
    {
        id: 'identity',
        tone: 'info',
        isDismissible: true,
        rememberDismissal: true,
        when: state => state.identityNote != null,
        text: state => state.identityNote ?? '',
    },
];

export interface Banners {
    readonly element: HTMLElement;
    update(state: BannerState): void;
    visibleIds(): string[];
    dispose(): void;
}

// A banner's id with its words and its buttons: the same key draws the same notice.
function bannerKey(banner: BannerDefinition, state: BannerState): string {
    const actions = (banner.actions?.(state) ?? []).map(action => action.label);

    return JSON.stringify([banner.id, banner.title?.(state) ?? '', banner.text(state), actions]);
}

// Until when each banner stays dismissed (epoch ms): Infinity for good, or the time its dismissUntil gave.
function readDismissals(): Map<string, number> {
    const dismissals = new Map<string, number>();
    try {
        for (const banner of BANNERS) {
            const stored = globalThis.localStorage?.getItem(`${DISMISS_KEY_PREFIX}${banner.id}`);
            if (stored == null) {
                continue;
            }

            if (banner.dismissUntil != null && Number.isFinite(Number(stored))) {
                dismissals.set(banner.id, Number(stored));
            }

            if (banner.rememberDismissal === true && stored === '1') {
                dismissals.set(banner.id, Number.POSITIVE_INFINITY);
            }
        }
    } catch {
        // Storage blocked: every banner shows.
    }

    return dismissals;
}

export function createBanners(handlers: BannerHandlers): Banners {
    const element = h('div', { class: 'app-banners', attrs: { 'role': 'region', 'aria-label': 'Notices' } });
    const dismissals = readDismissals();
    let lastState: BannerState | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    // What the shown notice says, so an update that changes nothing leaves it alone.
    let shownKey = '';

    const isDismissed = (banner: BannerDefinition, now: number): boolean =>
        now < (dismissals.get(banner.id) ?? 0);

    const remember = (banner: BannerDefinition, until: number): void => {
        if (banner.dismissUntil == null && banner.rememberDismissal !== true) {
            return;
        }

        try {
            const stored = banner.dismissUntil == null ? '1' : String(until);
            globalThis.localStorage?.setItem(`${DISMISS_KEY_PREFIX}${banner.id}`, stored);
        } catch {
            // Shows again next visit.
        }
    };

    const dismiss = (banner: BannerDefinition, state: BannerState): void => {
        const until = banner.dismissUntil?.(state) ?? Number.POSITIVE_INFINITY;
        dismissals.set(banner.id, until);
        remember(banner, until);
        if (lastState != null) {
            update(lastState);
        }
    };

    const renderBanner = (banner: BannerDefinition, state: BannerState): HTMLElement => {
        const title = banner.title?.(state);

        return h('div', {
            class: 'banner',
            dataset: { tone: banner.tone, banner: banner.id },
            children: [
                h('span', { class: 'banner-icon', html: banner.tone === 'info' ? ICONS.info : ICONS.warning }),
                h('p', {
                    class: 'banner-text',
                    children: [
                        title == null ? null : h('strong', { class: 'banner-title', text: title }),
                        title == null ? null : ' ',
                        banner.text(state),
                    ],
                }),
                ...(banner.actions?.(state) ?? []).map(action => h('button', {
                    class: 'button button-small',
                    text: action.label,
                    attrs: { type: 'button' },
                    on: { click: () => action.run(handlers) },
                })),
                banner.isDismissible === true
                    ? h('button', {
                        class: 'icon-button icon-button-small',
                        html: ICONS.close,
                        attrs: { 'type': 'button', 'aria-label': 'Dismiss', 'data-tooltip': 'Dismiss' },
                        on: { click: () => dismiss(banner, state) },
                    })
                    : null,
            ],
        });
    };

    // Draws again when a timed dismissal runs out, or on the next minute while a countdown shows.
    const scheduleRefresh = (state: BannerState, now: number): void => {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        const wakeTimes = BANNERS
            .filter(banner => banner.when(state))
            .flatMap(banner => {
                const until = dismissals.get(banner.id) ?? 0;
                if (banner.dismissUntil != null && until > now) {
                    return [until];
                }

                const isCountingDown = banner.followsClock === true && !isDismissed(banner, now);

                return isCountingDown ? [now + MINUTE_MS - (now % MINUTE_MS)] : [];
            });
        if (wakeTimes.length === 0) {
            return;
        }

        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            if (lastState != null) {
                update(lastState);
            }
        }, Math.min(...wakeTimes) - now);
    };

    // The same notice with the same words keeps its element, so a tap on its button is never lost to a redraw.
    const update = (state: BannerState): void => {
        const now = Date.now();
        lastState = state;
        const shown = BANNERS.find(banner => !isDismissed(banner, now) && banner.when(state));
        const key = shown == null ? '' : bannerKey(shown, state);
        if (key !== shownKey) {
            shownKey = key;
            element.replaceChildren(...(shown == null ? [] : [renderBanner(shown, state)]));
        }

        element.hidden = shown == null;
        scheduleRefresh(state, now);
    };

    return {
        element,
        update,
        visibleIds: () => [...element.querySelectorAll<HTMLElement>('.banner')].map(banner => banner.dataset.banner ?? ''),
        dispose: () => {
            clearTimeout(refreshTimer);
            refreshTimer = undefined;
        },
    };
}
