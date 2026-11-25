import { describe, expect, it, vi } from 'vitest';
import { openCameraAsync } from './camera.js';

function createTrack(capabilities?: Record<string, unknown>) {
    return {
        kind: 'video',
        readyState: 'live',
        stop: vi.fn(),
        applyConstraints: vi.fn(async () => undefined),
        getCapabilities: capabilities == null ? undefined : vi.fn(() => capabilities),
    };
}

function createDevices(tracks: readonly ReturnType<typeof createTrack>[]) {
    const stream = {
        getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
        getTracks: () => [...tracks],
    } as unknown as MediaStream;

    return { stream, getUserMedia: vi.fn(async () => stream) };
}

describe('openCameraAsync', () => {
    it('asks for video only with the given constraints', async () => {
        // Arrange
        const track = createTrack();
        const devices = createDevices([track]);

        // Act
        const session = await openCameraAsync({ facingMode: { ideal: 'environment' } }, devices);

        // Assert
        expect(devices.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        expect(session.stream).toBe(devices.stream);
        expect(session.track).toBe(track);
    });

    it('switches the torch through advanced constraints where the track supports it', async () => {
        // Arrange
        const track = createTrack({ torch: true });
        const session = await openCameraAsync({}, createDevices([track]));

        // Act
        await session.setTorchAsync(true);
        await session.setTorchAsync(false);

        // Assert
        expect(session.torchSupported).toBe(true);
        expect(track.applyConstraints.mock.calls).toEqual([[{ advanced: [{ torch: true }] }], [{ advanced: [{ torch: false }] }]]);
    });

    it('reports no torch and ignores torch requests without the capability', async () => {
        // Arrange
        const withoutCapabilities = createTrack();
        const withoutTorch = createTrack({ zoom: { min: 1, max: 4 } });
        const first = await openCameraAsync({}, createDevices([withoutCapabilities]));
        const second = await openCameraAsync({}, createDevices([withoutTorch]));

        // Act
        await first.setTorchAsync(true);
        await second.setTorchAsync(true);

        // Assert
        expect([first.torchSupported, second.torchSupported]).toEqual([false, false]);
        expect(withoutCapabilities.applyConstraints).not.toHaveBeenCalled();
        expect(withoutTorch.applyConstraints).not.toHaveBeenCalled();
    });

    it('notices a torch the camera reports only after it starts', async () => {
        // Arrange
        const capabilities: Record<string, unknown> = {};
        const session = await openCameraAsync({}, createDevices([createTrack(capabilities)]));
        const before = session.torchSupported;

        // Act
        capabilities.torch = true;

        // Assert
        expect([before, session.torchSupported]).toEqual([false, true]);
    });

    it('stops every track', async () => {
        // Arrange
        const video = createTrack();
        const audio = { ...createTrack(), kind: 'audio' };
        const session = await openCameraAsync({}, createDevices([video, audio]));

        // Act
        session.stop();

        // Assert
        expect(video.stop).toHaveBeenCalledTimes(1);
        expect(audio.stop).toHaveBeenCalledTimes(1);
    });

    it('rejects like getUserMedia and when there is no video track', async () => {
        // Arrange
        const denied = { getUserMedia: vi.fn(async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))) };
        const audioOnly = createDevices([{ ...createTrack(), kind: 'audio' }]);

        // Act
        const deniedOpen = openCameraAsync({}, denied);
        const audioOnlyOpen = openCameraAsync({}, audioOnly);

        // Assert
        await expect(deniedOpen).rejects.toMatchObject({ name: 'NotAllowedError' });
        await expect(audioOnlyOpen).rejects.toThrow('no video track');
    });
});
