import type { Direction } from '../../client/clientTypes.js';
import { SESSION_TABS } from '../appContext.js';
import type { AppContext, Screen, SessionTab } from '../appContext.js';
import { h } from '../dom.js';
import { createFilesPanel } from '../gallery/filesPanel.js';
import type { FilesPanel } from '../gallery/filesPanel.js';
import type { PairingFlow } from '../pairing/pairingFlow.js';
import { createDebounce } from '../throttle.js';
import type { FileActions } from '../transfers/fileActions.js';
import { createProgressPanel } from '../transfers/progressPanel.js';
import { createSessionStatus } from './sessionStatus.js';

// One paired device (§4.5, §7.6): the peer bar across the top, then the tabs Send · Received N · Sent N.
// On wide screens the session takes the whole width (D8), so the files get the room. Send shows a static accent
// dot while files of this session move. Picking lives on the Send tab, and pairing again on the peer bar.
// Clearing this session's files rebuilds the tabs' panels, so no list, line, progress or selection outlives
// what it showed.

export interface SessionScreenOptions {
    readonly context: AppContext;
    readonly flow: PairingFlow;
    readonly actions: FileActions;
    readonly sessionId: string;
    readonly tab: SessionTab;
    readonly scroller: HTMLElement;
}

export interface SessionScreen extends Screen {
    readonly sessionId: string;
    setTab(tab: SessionTab): void;
}

interface Panel {
    readonly element: HTMLElement;
    dispose(): void;
}

const COUNTED_TABS: Readonly<Partial<Record<SessionTab, Direction>>> = Object.freeze({ received: 'in', sent: 'out' });

export function createSessionScreen(options: SessionScreenOptions): SessionScreen {
    const { context, flow, actions, sessionId } = options;
    const { client, tracker } = context;
    const status = createSessionStatus(context, flow, sessionId);
    const panels = new Map<SessionTab, Panel>();
    const filesPanels = new Map<Direction, FilesPanel>();
    let current: SessionTab = options.tab;
    let isDisposed = false;

    const movingDot = h('span', { class: 'tab-dot', attrs: { 'aria-hidden': 'true', 'hidden': true } });
    const counts = new Map<SessionTab, HTMLElement>();
    const tabButtons = SESSION_TABS.map(tab => {
        const count = h('span', { class: 'tab-count' });
        if (COUNTED_TABS[tab.id] != null) {
            counts.set(tab.id, count);
        }

        return h('button', {
            class: 'tab',
            dataset: { tab: tab.id },
            attrs: {
                'type': 'button',
                'role': 'tab',
                'id': `tab-${tab.id}`,
                'aria-controls': `panel-${tab.id}`,
            },
            children: [tab.id === 'send' ? movingDot : null, h('span', { class: 'tab-label', text: tab.label }), count],
            on: { click: () => setTab(tab.id) },
        });
    });
    const tabList = h('div', {
        class: 'tabs',
        attrs: { 'role': 'tablist', 'aria-label': 'Files' },
        children: tabButtons,
    });
    const panelHost = h('div', { class: 'tab-panels' });
    const element = h('section', {
        class: 'screen session-screen',
        attrs: { 'aria-labelledby': 'session-title' },
        children: [status.element, tabList, panelHost],
    });

    const filesPanelFor = (direction: Direction, scroller: HTMLElement): FilesPanel => {
        const panel = createFilesPanel({ context, actions, sessionId, direction, scroller });
        filesPanels.set(direction, panel);

        return panel;
    };

    const createPanel = (tab: SessionTab): Panel => {
        const scroller = options.scroller;
        const factories: Readonly<Record<SessionTab, () => Panel>> = {
            send: () => createProgressPanel({
                context,
                actions,
                sessionId,
                scroller,
                onShowBatch: batch => {
                    setTab(batch.direction === 'in' ? 'received' : 'sent');
                    filesPanels.get(batch.direction)?.setBatch(batch.batchId);
                },
            }),
            sent: () => filesPanelFor('out', scroller),
            received: () => filesPanelFor('in', scroller),
        };

        return factories[tab]();
    };

    const mountPanel = (tab: SessionTab): void => {
        const panel = createPanel(tab);
        panel.element.setAttribute('role', 'tabpanel');
        panel.element.id = `panel-${tab}`;
        panel.element.setAttribute('aria-labelledby', `tab-${tab}`);
        panels.set(tab, panel);
        panelHost.append(panel.element);
    };

    const setTab = (tab: SessionTab): void => {
        current = tab;
        for (const button of tabButtons) {
            const isSelected = button.dataset.tab === tab;
            button.setAttribute('aria-selected', String(isSelected));
            button.tabIndex = isSelected ? 0 : -1;
        }

        if (!panels.has(tab)) {
            mountPanel(tab);
        }

        for (const [id, item] of panels) {
            item.element.hidden = id !== tab;
        }

        element.dataset.currentTab = tab;
    };

    tabList.addEventListener('keydown', event => {
        const steps: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowLeft: -1 };
        const step = steps[event.key];
        if (step == null) {
            return;
        }

        event.preventDefault();
        const index = SESSION_TABS.findIndex(tab => tab.id === current);
        const nextTab = SESSION_TABS[(index + step + SESSION_TABS.length) % SESSION_TABS.length];
        if (nextTab != null) {
            setTab(nextTab.id);
            tabButtons.find(button => button.dataset.tab === nextTab.id)?.focus();
        }
    });

    // The static dot on Send while this session's files move; changed only when it flips.
    const renderMoving = (): void => {
        const isMoving = client.state === 'connected' && client.peer?.sessionId === sessionId && tracker.isTransferring;
        if (movingDot.hidden === isMoving) {
            movingDot.hidden = !isMoving;
            tabButtons[0]?.setAttribute('aria-label', isMoving ? 'Send, files moving' : 'Send');
        }
    };

    // "Received 13", "Sent 10": every file of the tab's list, unfinished ones included.
    const loadCountsAsync = async (): Promise<void> => {
        const records = await client.listFilesAsync({ sessionId }).catch(() => undefined);
        if (records == null || isDisposed) {
            return;
        }

        for (const [tab, count] of counts) {
            const direction = COUNTED_TABS[tab];
            const total = records.filter(record => record.direction === direction).length;
            const text = total.toLocaleString('en');
            if (count.textContent !== text) {
                count.textContent = text;
            }

            const label = SESSION_TABS.find(item => item.id === tab)?.label ?? tab;
            tabButtons.find(button => button.dataset.tab === tab)
                ?.setAttribute('aria-label', `${label}, ${text} files`);
        }
    };

    const countsSoon = createDebounce(() => {
        void loadCountsAsync();
    }, 400);

    const unsubscribers = [
        tracker.onChange(change => {
            renderMoving();
            if (change.isStructural && change.records.some(record => record.sessionId === sessionId)) {
                countsSoon.schedule();
            }
        }),
        client.on('state', renderMoving),
        context.onDataChanged(() => countsSoon.schedule()),
        client.on('session-cleared', clearedId => {
            if (clearedId !== sessionId) {
                return;
            }

            for (const panel of panels.values()) {
                panel.dispose();
                panel.element.remove();
            }

            panels.clear();
            filesPanels.clear();
            setTab(current);
            countsSoon.schedule();
        }),
    ];

    setTab(options.tab);
    renderMoving();
    void loadCountsAsync();

    return {
        element,
        sessionId,
        title: context.sessions.find(sessionId)?.peerName ?? 'Device',
        setTab,
        dispose: () => {
            isDisposed = true;
            countsSoon.cancel();
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }

            status.dispose();
            for (const panel of panels.values()) {
                panel.dispose();
            }
        },
    };
}
