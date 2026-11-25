// HS-09: most desktops have no camera. Without one, Scan a code and Scan reply give way to the Paste buttons.

interface MediaDevicesLike {
    getUserMedia?: unknown;
    enumerateDevices?: () => Promise<ReadonlyArray<{ readonly kind: string }>>;
}

export async function detectCameraAsync(
    mediaDevices: MediaDevicesLike | undefined = globalThis.navigator?.mediaDevices,
): Promise<boolean> {
    if (mediaDevices?.getUserMedia == null) {
        return false;
    }

    if (mediaDevices.enumerateDevices == null) {
        return true;
    }

    try {
        const devices = await mediaDevices.enumerateDevices();

        return devices.some(device => device.kind === 'videoinput');
    } catch {
        // Can't tell: offer the camera and let the scan screen fall back if it fails.
        return true;
    }
}
