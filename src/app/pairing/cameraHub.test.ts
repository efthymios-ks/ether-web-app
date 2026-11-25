import { describe, expect, it } from 'vitest';
import { SILENT_LOGGER } from '../../core/logger.js';
import { createFakeServices } from '../testing/appHarness.js';
import { createCameraHub } from './cameraHub.js';

describe('createCameraHub', () => {
    it('lends the open scanner camera to the local-IP hook instead of opening a second one (HS-05)', async () => {
        // Arrange
        const services = createFakeServices();
        const hub = createCameraHub({ openCameraAsync: services.openCameraAsync, logger: SILENT_LOGGER });
        const lease = await hub.acquireAsync({ facingMode: { ideal: 'environment' } });

        // Act
        const releaseHook = hub.retainOpen();
        lease.release();
        const isOpenDuringGathering = hub.isOpen;
        releaseHook?.();

        // Assert
        expect(services.cameraOpens).toHaveLength(1);
        expect(isOpenDuringGathering).toBe(true);
        expect(hub.isOpen).toBe(false);
        expect(services.cameraStops).toEqual([1]);
    });

    it('returns null to the hook when no camera is open', () => {
        // Arrange
        const hub = createCameraHub({ openCameraAsync: createFakeServices().openCameraAsync, logger: SILENT_LOGGER });

        // Act & Assert
        expect(hub.retainOpen()).toBeNull();
    });

    it('ignores a second release from the same holder', async () => {
        // Arrange
        const services = createFakeServices();
        const hub = createCameraHub({ openCameraAsync: services.openCameraAsync, logger: SILENT_LOGGER });
        const first = await hub.acquireAsync({});
        const second = await hub.acquireAsync({});

        // Act
        first.release();
        first.release();

        // Assert
        expect(hub.isOpen).toBe(true);
        second.release();
        expect(hub.isOpen).toBe(false);
        expect(services.cameraOpens).toHaveLength(1);
    });
});
