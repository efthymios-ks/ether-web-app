import type { Logger } from '../core/logger.js';
import { createCanvasImaging } from './canvasImaging.js';
import { extractFileMetadataAsync } from './fileMetadata.js';
import { probePreviewSupportAsync } from './mediaKind.js';
import type { MediaToolkit } from './metadataTypes.js';
import { createThumbnailAsync } from './thumbnail.js';

// The media layer as the client sees it in the browser; tests inject their own MediaToolkit.
export function createBrowserMediaToolkit(logger: Logger): MediaToolkit {
    const imaging = createCanvasImaging();
    void probePreviewSupportAsync();

    return {
        extractMetadataAsync: file => extractFileMetadataAsync(file, { logger }),
        createThumbnailAsync: (file, metadata) => createThumbnailAsync(file, metadata, { imaging, logger }),
    };
}
