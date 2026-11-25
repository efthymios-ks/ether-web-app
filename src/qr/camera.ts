// UI-04: the scanning camera, with the torch where the track supports it.

export interface CameraSession {
    readonly stream: MediaStream;
    readonly track: MediaStreamTrack;
    // Read live: some Android cameras report the torch only once frames flow.
    readonly torchSupported: boolean;
    setTorchAsync(on: boolean): Promise<void>;
    stop(): void;
}

type CameraDevices = Pick<MediaDevices, 'getUserMedia'>;

interface TorchCapabilities extends MediaTrackCapabilities {
    readonly torch?: boolean;
}

interface TorchConstraintSet extends MediaTrackConstraintSet {
    readonly torch?: boolean;
}

// Rejects like getUserMedia (NotAllowedError, NotFoundError…), so the caller can fall back to the paste box.
export async function openCameraAsync(
    constraints: MediaTrackConstraints,
    mediaDevices: CameraDevices = navigator.mediaDevices,
): Promise<CameraSession> {
    const stream = await mediaDevices.getUserMedia({ video: constraints, audio: false });
    const track = stream.getVideoTracks()[0];
    if (track == null) {
        stopTracks(stream);
        throw new Error('The camera returned no video track');
    }

    return {
        stream,
        track,
        get torchSupported() {
            return supportsTorch(track);
        },
        setTorchAsync: async on => {
            if (!supportsTorch(track)) {
                return;
            }

            const torch: TorchConstraintSet = { torch: on };
            await track.applyConstraints({ advanced: [torch] });
        },
        stop: () => stopTracks(stream),
    };
}

function supportsTorch(track: MediaStreamTrack): boolean {
    if (typeof track.getCapabilities !== 'function' || track.readyState === 'ended') {
        return false;
    }

    try {
        return (track.getCapabilities() as TorchCapabilities).torch === true;
    } catch {
        return false;
    }
}

function stopTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
        track.stop();
    }
}
