import { afterEach, describe, expect, it } from 'vitest';
import {
    canPreview,
    extensionOf,
    mediaKindOf,
    mediaTypeOf,
    normalizeMime,
    probePreviewSupportAsync,
} from './mediaKind.js';

describe('mediaKindOf', () => {
    it('trusts the MIME type when it names an image or a video', () => {
        // Act
        const kinds = [
            mediaKindOf('image/heic', 'IMG_1.HEIC'),
            mediaKindOf('video/quicktime', 'IMG_2.MOV'),
            mediaKindOf('application/pdf', 'scan.jpg'),
        ];

        // Assert
        expect(kinds).toEqual(['image', 'video', 'other']);
    });

    it('falls back to the extension when the MIME type is missing or generic', () => {
        // Act
        const kinds = [
            mediaKindOf('', 'IMG_1.HEIC'),
            mediaKindOf('application/octet-stream', 'clip.mov'),
            mediaKindOf('', 'notes.txt'),
            mediaKindOf('', 'README'),
            mediaKindOf('', 'song.mp3'),
        ];

        // Assert
        expect(kinds).toEqual(['image', 'video', 'other', 'other', 'other']);
    });
});

describe('normalizeMime', () => {
    it('lower-cases, drops parameters and maps aliases', () => {
        // Act
        const types = [
            normalizeMime('Image/JPG'),
            normalizeMime('video/mp4; codecs="avc1"'),
            normalizeMime('audio/x-m4a'),
            normalizeMime('audio/MP3'),
            normalizeMime('audio/x-wav'),
        ];

        // Assert
        expect(types).toEqual(['image/jpeg', 'video/mp4', 'audio/mp4', 'audio/mpeg', 'audio/wav']);
    });
});

describe('mediaTypeOf', () => {
    it('keeps a named MIME type and reads the extension only without one', () => {
        // Act
        const types = [
            mediaTypeOf('audio/x-m4a', 'voice.m4a'),
            mediaTypeOf('', 'voice.M4A'),
            mediaTypeOf('application/octet-stream', 'take.flac'),
            mediaTypeOf('', 'IMG_1.heic'),
            mediaTypeOf('application/pdf', 'scan.jpg'),
            mediaTypeOf('', 'notes.txt'),
        ];

        // Assert
        expect(types).toEqual(['audio/mp4', 'audio/mp4', 'audio/flac', 'image/heic', 'application/pdf', '']);
    });
});

describe('extensionOf', () => {
    it('reads the text after the last dot in lower case, and nothing without a dot', () => {
        // Act
        const extensions = ['Song.MP3', 'archive.tar.gz', 'README', '.bashrc'].map(extensionOf);

        // Assert
        expect(extensions).toEqual(['mp3', 'gz', '', 'bashrc']);
    });
});

describe('canPreview', () => {
    afterEach(async () => {
        await probePreviewSupportAsync({ canPlayMedia: () => false, canDecodeImageAsync: async () => false });
    });

    it('previews the image types every engine decodes and nothing else before probing', () => {
        // Arrange
        const types = ['image/jpeg', 'image/png', 'image/heic', 'image/svg+xml', 'video/mp4', 'audio/mpeg', 'text/plain'];

        // Act
        const answers = types.map(mime => canPreview(mime));

        // Assert
        expect(answers).toEqual([true, true, false, false, false, false, false]);
    });

    it('previews HEIC, QuickTime and audio only where the probe says the engine decodes or plays them', async () => {
        // Arrange
        const playable = new Set(['video/quicktime', 'video/mp4', 'audio/mpeg', 'audio/mp4']);
        const probe = {
            canPlayMedia: (mime: string) => playable.has(mime),
            canDecodeImageAsync: async (mime: string) => mime === 'image/heic',
        };

        // Act
        await probePreviewSupportAsync(probe);

        // Assert
        expect(canPreview('image/heic')).toBe(true);
        expect(canPreview('image/heif')).toBe(false);
        expect(canPreview('video/quicktime')).toBe(true);
        expect(canPreview('video/webm')).toBe(false);
        expect(canPreview('audio/mpeg')).toBe(true);
        expect(canPreview('audio/x-m4a')).toBe(true);
        expect(canPreview('audio/flac')).toBe(false);
    });

    it('asks about audio and video types with canPlayType and about images by decoding', async () => {
        // Arrange
        const played: string[] = [];
        const decoded: string[] = [];
        const probe = {
            canPlayMedia: (mime: string) => {
                played.push(mime);

                return false;
            },
            canDecodeImageAsync: async (mime: string) => {
                decoded.push(mime);

                return false;
            },
        };

        // Act
        await probePreviewSupportAsync(probe);

        // Assert
        expect(played).toContain('audio/mpeg');
        expect(played).toContain('video/quicktime');
        expect(played.every(mime => mime.startsWith('audio/') || mime.startsWith('video/'))).toBe(true);
        expect(decoded).toEqual(['image/avif', 'image/heic', 'image/heif', 'image/jxl']);
    });

    it('reads the extension of a file without a MIME type', async () => {
        // Arrange
        await probePreviewSupportAsync({
            canPlayMedia: mime => mime === 'audio/mpeg',
            canDecodeImageAsync: async () => false,
        });

        // Act
        const answers = [
            canPreview('', 'song.mp3'),
            canPreview('application/octet-stream', 'photo.PNG'),
            canPreview('', 'take.flac'),
            canPreview('', 'notes.txt'),
            canPreview(''),
        ];

        // Assert
        expect(answers).toEqual([true, true, false, false, false]);
    });

    it('treats a failing image probe as not decodable', async () => {
        // Arrange
        const probe = {
            canPlayMedia: () => false,
            canDecodeImageAsync: async () => {
                throw new Error('blocked');
            },
        };

        // Act
        await probePreviewSupportAsync(probe);

        // Assert
        expect(canPreview('image/avif')).toBe(false);
    });

    it('skips probing outside a browser', async () => {
        // Act
        await probePreviewSupportAsync();

        // Assert
        expect(canPreview('image/heic')).toBe(false);
    });
});
