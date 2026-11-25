import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../core/logger.js';
import { createMemorySink } from '../../core/logSinks.js';
import { registerServiceWorker } from './serviceWorkerClient.js';

class FakeWorker extends EventTarget {
    readonly messages: unknown[] = [];

    constructor(public state: ServiceWorkerState, private readonly version = '0.1.0+abcd1234') {
        super();
    }

    postMessage(message: { type?: string }, transfer: MessagePort[] = []): void {
        this.messages.push(message);
        if (message.type === 'version') {
            transfer[0]?.postMessage({ type: 'version', version: this.version });
        }
    }

    moveTo(state: ServiceWorkerState): void {
        this.state = state;
        this.dispatchEvent(new Event('statechange'));
    }
}

class FakeRegistration extends EventTarget {
    readonly scope = 'http://localhost/';
    installing: FakeWorker | null = null;
    waiting: FakeWorker | null = null;
    active: FakeWorker | null = null;
}

class FakeContainer extends EventTarget {
    controller: FakeWorker | null = null;
    readonly registration = new FakeRegistration();
    readonly register = vi.fn(async (_url: string, _options: RegistrationOptions) => this.registration);
}

function setup(options: { secure?: boolean; supported?: boolean } = {}) {
    const memory = createMemorySink(100);
    const { logger } = createLogger({
        sinks: [memory],
        routing: { debugLogging: true, level: 'debug', categoryLevels: {}, sinks: ['memory'] },
    });
    const container = new FakeContainer();
    const reload = vi.fn();
    const start = (): ReturnType<typeof registerServiceWorker> => registerServiceWorker({
        logger,
        environment: {
            ...(options.supported === false ? {} : { container: container as unknown as ServiceWorkerContainer }),
            isSecureContext: options.secure ?? true,
            reload,
        },
    });

    return { container, reload, start, messages: () => memory.entries().map(entry => `${entry.cat} ${entry.msg}`) };
}

async function settleAsync(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 10));
}

describe('registerServiceWorker', () => {
    it('skips quietly where service workers are missing', () => {
        // Arrange
        const { start, messages } = setup({ supported: false });

        // Act
        const handle = start();
        handle.applyUpdate();

        // Assert
        expect(handle.getVersion()).toBeUndefined();
        expect(messages()).toContain('sw service worker unavailable; offline use is off');
    });

    it('skips on a page that is not a secure context', () => {
        // Arrange
        const { container, start } = setup({ secure: false });

        // Act
        start();

        // Assert
        expect(container.register).not.toHaveBeenCalled();
    });

    it('registers ./sw.js for the app folder and reads the controller version', async () => {
        // Arrange
        const { container, start } = setup();
        container.controller = new FakeWorker('activated');

        // Act
        const handle = start();
        await settleAsync();

        // Assert
        expect(container.register).toHaveBeenCalledWith('./sw.js', { scope: './' });
        expect(handle.getVersion()).toBe('0.1.0+abcd1234');
    });

    it('reports "Update ready" for a worker already waiting (PW-03)', async () => {
        // Arrange
        const { container, start } = setup();
        container.controller = new FakeWorker('activated');
        container.registration.waiting = new FakeWorker('installed', '0.2.0+ffff0000');
        const handler = vi.fn();

        // Act
        const handle = start();
        handle.onUpdateReady(handler);
        await settleAsync();

        // Assert
        expect(handler).toHaveBeenCalledOnce();
    });

    it('reports an update found while the page is open', async () => {
        // Arrange
        const { container, start, messages } = setup();
        container.controller = new FakeWorker('activated');
        const handler = vi.fn();
        const handle = start();
        handle.onUpdateReady(handler);
        await settleAsync();
        const installing = new FakeWorker('installing');

        // Act
        container.registration.installing = installing;
        container.registration.dispatchEvent(new Event('updatefound'));
        installing.moveTo('installed');

        // Assert
        expect(handler).toHaveBeenCalledOnce();
        expect(messages()).toContain('sw update waiting');
    });

    it('treats the first install as offline-ready, not as an update', async () => {
        // Arrange
        const { container, start, messages } = setup();
        const installing = new FakeWorker('installing');
        container.registration.installing = installing;
        const handler = vi.fn();
        start().onUpdateReady(handler);
        await settleAsync();

        // Act
        installing.moveTo('installed');

        // Assert
        expect(handler).not.toHaveBeenCalled();
        expect(messages()).toContain('sw installed; the app now works offline');
    });

    it('activates the waiting worker and reloads once when it takes over', async () => {
        // Arrange
        const { container, reload, start } = setup();
        container.controller = new FakeWorker('activated');
        const waiting = new FakeWorker('installed');
        container.registration.waiting = waiting;
        const handle = start();
        await settleAsync();

        // Act
        handle.applyUpdate();
        container.controller = waiting;
        container.dispatchEvent(new Event('controllerchange'));
        container.dispatchEvent(new Event('controllerchange'));

        // Assert
        expect(waiting.messages).toContainEqual({ type: 'skip-waiting' });
        expect(reload).toHaveBeenCalledOnce();
    });

    it('never reloads for a controller change nobody asked for', async () => {
        // Arrange
        const { container, reload, start } = setup();
        start();
        await settleAsync();

        // Act
        container.controller = new FakeWorker('activated');
        container.dispatchEvent(new Event('controllerchange'));

        // Assert
        expect(reload).not.toHaveBeenCalled();
    });
});
