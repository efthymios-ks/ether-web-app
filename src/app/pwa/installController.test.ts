import { describe, expect, it, vi } from 'vitest';
import { SILENT_LOGGER } from '../../core/logger.js';
import { createFakeDeviceInfo, createFakePlatform } from '../testing/adminFakes.js';
import { createInstallController } from './installController.js';

function promptEvent(outcome: 'accepted' | 'dismissed') {
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt,
        userChoice: Promise.resolve({ outcome }),
    });

    return { event, prompt };
}

describe('createInstallController', () => {
    it('gives iPhone the Add to Home Screen steps (PW-05)', () => {
        // Arrange
        const platform = createFakePlatform({ installMethod: 'instructions' });

        // Act
        const controller = createInstallController({ platform, logger: SILENT_LOGGER, target: new EventTarget() });

        // Assert
        expect(controller.method).toBe('instructions');
        expect(controller.canPrompt).toBe(false);
        expect(controller.steps()).toEqual(['Tap the Share button in Safari.', 'Tap Add to Home Screen.']);
    });

    it('keeps the browser prompt for a custom button', () => {
        // Arrange
        const target = new EventTarget();
        const controller = createInstallController({
            platform: createFakePlatform({ installMethod: 'prompt' }),
            logger: SILENT_LOGGER,
            target,
        });
        const onChange = vi.fn();
        controller.on('change', onChange);
        const { event } = promptEvent('accepted');

        // Act
        target.dispatchEvent(event);

        // Assert
        expect(event.defaultPrevented).toBe(true);
        expect(controller.canPrompt).toBe(true);
        expect(onChange).toHaveBeenCalledOnce();
    });

    it('prompts once and reports whether the user accepted', async () => {
        // Arrange
        const target = new EventTarget();
        const controller = createInstallController({
            platform: createFakePlatform({ installMethod: 'prompt' }),
            logger: SILENT_LOGGER,
            target,
        });
        const { event, prompt } = promptEvent('accepted');
        target.dispatchEvent(event);

        // Act
        const first = await controller.promptAsync();
        const second = await controller.promptAsync();

        // Assert
        expect(prompt).toHaveBeenCalledOnce();
        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(controller.canPrompt).toBe(false);
    });

    it('stops offering install once the app is installed', () => {
        // Arrange
        const target = new EventTarget();
        const controller = createInstallController({
            platform: createFakePlatform({ installMethod: 'prompt' }),
            logger: SILENT_LOGGER,
            target,
        });
        target.dispatchEvent(promptEvent('accepted').event);

        // Act
        target.dispatchEvent(new Event('appinstalled'));

        // Assert
        expect(controller.method).toBe('none');
        expect(controller.canPrompt).toBe(false);
    });

    it('offers nothing in the installed app', () => {
        // Act
        const controller = createInstallController({
            platform: createFakePlatform({ installMethod: 'instructions', info: createFakeDeviceInfo({ installed: true }) }),
            logger: SILENT_LOGGER,
            target: new EventTarget(),
        });

        // Assert
        expect(controller.method).toBe('none');
    });
});
