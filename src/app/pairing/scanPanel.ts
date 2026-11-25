import type { AppContext, QrScannerHandle } from '../appContext.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';
import type { CameraLease } from './cameraHub.js';

// UI-04: the camera view, rear camera on phones, torch where the track supports it.
// Layout changes on rotation are CSS only, so the stream never restarts (UI-05).

export type ScanState = 'starting' | 'live' | 'unavailable';

export interface ScanPanelOptions {
    readonly label: string;
    readonly onCode: (text: string) => void;
}

export interface ScanPanel {
    readonly element: HTMLElement;
    readonly state: ScanState;
    startAsync(): Promise<void>;
    // No camera on this device: the paste box below takes over (HS-09).
    showUnavailable(message: string): void;
    // Stops decoding but keeps the camera on, e.g. while gathering needs it (HS-05).
    pause(): void;
    resume(): void;
    dispose(): void;
}

const REPEAT_WINDOW_MS = 2500;

const CAMERA_ERRORS: ReadonlyArray<{ readonly names: readonly string[]; readonly message: string }> = [
    {
        names: ['NotAllowedError', 'SecurityError'],
        message: 'The camera is blocked. Allow it in the site settings, or use Paste instead.',
    },
    {
        names: ['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'],
        message: 'No camera found. Use Paste instead.',
    },
    {
        names: ['NotReadableError', 'AbortError'],
        message: 'Another app is using the camera. Close it, or use Paste instead.',
    },
];

export function createScanPanel(context: AppContext, options: ScanPanelOptions): ScanPanel {
    const plan = context.platform.cameraPlan();
    const video = h('video', {
        class: 'scan-video',
        attrs: { 'playsinline': true, 'muted': true, 'autoplay': true, 'aria-hidden': 'true' },
    });
    video.muted = true;
    const status = h('p', { class: 'scan-status', text: 'Starting the camera…', attrs: { role: 'status' } });
    const torch = h('button', {
        class: 'icon-button scan-torch',
        html: ICONS.torch,
        attrs: { 'type': 'button', 'aria-label': 'Torch', 'aria-pressed': 'false', 'hidden': true, 'data-tooltip': 'Torch' },
    });
    const frame = h('div', {
        class: 'scan-frame',
        dataset: { state: 'starting', facing: plan.preferRear ? 'environment' : 'user' },
        attrs: { 'role': 'group', 'aria-label': options.label },
        children: [
            video,
            h('div', { class: 'scan-viewfinder', attrs: { 'aria-hidden': 'true' } }),
            status,
            torch,
        ],
    });
    let state: ScanState = 'starting';
    let lease: CameraLease | undefined;
    let scanner: QrScannerHandle | undefined;
    let isDisposed = false;
    let isPaused = false;
    let lastCode: { text: string; at: number } | undefined;

    const setState = (next: ScanState, message: string): void => {
        state = next;
        frame.dataset.state = next;
        status.textContent = message;
    };

    const onCode = (text: string): void => {
        const now = Date.now();
        if (isPaused || (lastCode?.text === text && now - lastCode.at < REPEAT_WINDOW_MS)) {
            return;
        }

        lastCode = { text, at: now };
        options.onCode(text);
    };

    const toggleTorchAsync = async (): Promise<void> => {
        const isOn = torch.getAttribute('aria-pressed') !== 'true';
        try {
            await lease?.session.setTorchAsync(isOn);
            torch.setAttribute('aria-pressed', String(isOn));
        } catch {
            context.dialogs.toast('The torch could not be switched.', { tone: 'warn' });
        }
    };

    torch.addEventListener('click', () => {
        void toggleTorchAsync();
    });

    const startAsync = async (): Promise<void> => {
        if (lease != null || isDisposed) {
            return;
        }

        setState('starting', 'Starting the camera…');
        try {
            const acquired = await context.camera.acquireAsync(plan.constraints);
            if (isDisposed) {
                acquired.release();

                return;
            }

            lease = acquired;
            video.srcObject = acquired.session.stream;
            try {
                await video.play();
            } catch {
                // Autoplay rules: the muted inline stream usually plays; decoding works on paused frames too.
            }

            scanner = context.services.createScanner({ video, onCode, logger: context.logger });
            scanner.start();
            torch.hidden = !acquired.session.torchSupported;
            setState('live', 'Point the camera at the code.');
            context.logger.info('pair', 'scanner started', { torch: acquired.session.torchSupported });
        } catch (error) {
            const name = error instanceof Error ? error.name : '';
            const message = CAMERA_ERRORS.find(item => item.names.includes(name))?.message
                ?? 'The camera could not start. Use Paste instead.';
            setState('unavailable', message);
            context.logger.info('pair', 'camera unavailable for scanning', { error: name });
        }
    };

    return {
        element: frame,
        get state() {
            return state;
        },
        startAsync,
        showUnavailable: message => setState('unavailable', message),
        pause: () => {
            isPaused = true;
        },
        resume: () => {
            isPaused = false;
            lastCode = undefined;
        },
        dispose: () => {
            isDisposed = true;
            scanner?.stop();
            scanner = undefined;
            video.srcObject = null;
            lease?.release();
            lease = undefined;
        },
    };
}
