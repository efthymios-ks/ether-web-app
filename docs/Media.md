# Media and QR

The media layer (`src/media`) reads metadata, makes thumbnails, sorts files into categories, builds ZIP files and cleans file names.  
The QR layer (`src/qr`) draws the pairing code and reads it back from the camera.  
Neither layer changes the bytes that are sent (MD-01): metadata is read from the file, and thumbnails are drawn from a decoded copy.

The client receives the media layer as a `MediaToolkit` (`src/media/metadataTypes.ts`),  
so it runs under Node in tests with a fake toolkit.  
In the browser, `createBrowserMediaToolkit(logger)` wires the real readers and the canvas code.

## Metadata summary

Each file's `offer` carries a `FileMetadata` summary, so the receiver can show it without parsing the file (§8).  
Fields without a value are left out, never stored as `null` (MD-02).

| Field | Images | Videos | Audio |
| --- | --- | --- | --- |
| `takenAt`, `takenAtSource` | EXIF `DateTimeOriginal` + `OffsetTimeOriginal` | QuickTime `creationdate`, then `mvhd` creation time | File date only |
| `latitude`, `longitude`, `altitude` | EXIF GPS (altitude below sea level is negative) | `com.apple.quicktime.location.ISO6709`, or `©xyz` in `udta` | — |
| `make`, `model` | EXIF `Make`, `Model` | `com.apple.quicktime.make` / `model`, or `©mak` / `©mod` | — |
| `lens` | EXIF `LensModel`, XMP `aux:Lens` | — | — |
| `width`, `height` | EXIF `ExifImageWidth` / `Height`, TIFF size, PNG `IHDR`, WebP `VP8X` | `tkhd` of the first track with a picture | — |
| `orientation` | EXIF orientation 1–8 | — | — |
| `rotation` | — | Clockwise degrees from the `tkhd` matrix (0, 90, 180, 270) | — |
| `durationSeconds` | — | `mvhd` duration ÷ timescale | `<audio>` `duration`, where the browser plays the format |
| `tags` | IPTC `Keywords`, XMP `dc:subject`, Windows `XPKeywords` | — | — |
| `title` | XMP `dc:title`, IPTC `ObjectName`, Windows `XPTitle` | — | — |
| `description` | XMP `dc:description`, IPTC `Caption`, EXIF `ImageDescription`, Windows `XPComment` / `XPSubject` | — | — |
| `rating` | XMP `xmp:Rating`, Windows `Rating` (1–5) | — | — |
| `originalName`, `relativePath` | `File.name`, `File.webkitRelativePath` | Same | Same |

Dates are ISO 8601.  
They carry the offset when the file has one (`2026-11-23T14:05:42+01:00`),  
and stay as wall-clock time without an offset when it doesn't (`2026-11-23T14:05:42`).  
`mvhd` times are UTC by definition (`…Z`).  
QuickTime's `+0100` becomes `+01:00`.  
Placeholders such as `0000:00:00 00:00:00` and impossible dates are dropped.

Values are kept small, because a manifest may not exceed 64 KiB (SP-05):  
coordinates are rounded to 6 decimals (about 0.1 m), altitude to 0.1 m and durations to 1 ms,  
at most 30 tags of 64 characters, titles up to 200 characters and descriptions up to 1,000.  
GPS `0, 0` counts as "no fix" and is left out.

### Date taken

`takenAt` comes from the first source that has a valid date (MD-05):

1. EXIF `DateTimeOriginal` (then `CreateDate`, then XMP `photoshop:DateCreated` and `xmp:CreateDate`): `takenAtSource: 'exif'`
2. QuickTime `com.apple.quicktime.creationdate`: `'quicktime'`
3. `mvhd` creation time: `'mvhd'`
4. `File.lastModified`, written in this device's time zone: `'file'`, shown as "file date"

Never trust the file name or `lastModified` as the date a photo was taken; they are only the last resort.

### Time limit

`extractMetadataAsync(file)` resolves within 2 seconds (MD-06).  
On timeout or failure it resolves `undefined` and logs a `warn` in category `xfer`; it never rejects,  
so the file is sent without a summary.  
Each file category has at most one reader (`METADATA_READERS`): images, videos and audio.  
Documents, archives and other files get the file-level fields only.

### Images

[exifr](https://github.com/MikeKovarik/exifr) reads EXIF, GPS, XMP, IPTC and the PNG header from JPEG, HEIC, AVIF, TIFF and PNG.  
It reads a `File` in 64 KiB slices and stops once it has the segments it needs,  
so a 2 MB photo costs at most 128 KiB of reading (MD-03).  
Values are read raw (no translated enums and no `Date` objects), so dates keep their wall-clock time and offset.  
The library is loaded with a dynamic `import()`, which keeps it out of the start-up bundle.

exifr has no WebP reader.  
For WebP, the RIFF chunk headers are walked with `File.slice()`:  
the `EXIF` chunk goes to exifr as raw TIFF data, the `XMP ` chunk as an XMP sidecar,  
and `VP8X` gives the canvas size.

### Videos

MP4 and MOV metadata lives in the `moov` box, which may sit after the media data at the end of the file (MD-04).  
`findMovieBoxAsync` walks only the 16-byte top-level box headers with `File.slice()`:  
it follows 64-bit sizes (size field `1`), treats size `0` as "to the end of the file" and skips `mdat` without reading it.  
A file whose first header is not four printable characters is not ISO media and gets no video metadata.

The `moov` payload is then read in one slice, up to 16 MiB, and parsed in memory:

- `mvhd`: creation time (seconds since 1904-01-01 UTC; `0` means unset) and duration, version 0 and 1;
- `tkhd`: width and height (16.16 fixed point) and the rotation, `atan2(b, a)` of the display matrix;
- `meta` with `keys` and `ilst`: Apple's `com.apple.quicktime.*` values,  
  with or without the version field that ISO `meta` boxes carry;
- `udta`: the QuickTime text atoms `©xyz`, `©mak` and `©mod` that Android and older cameras write.

A `moov` with `mvex` belongs to a fragmented MP4 and yields file-level fields only.

ISO 6709 locations are read in all three forms:

| Form | Example |
| --- | --- |
| Degrees | `+37.3317-122.0302+012.345/` |
| Degrees and minutes | `+4851.5040+00217.6700/` |
| Degrees, minutes and seconds | `+485130.24+0021740.20CRSWGS_84/` |

### Audio

Audio files carry no date taken, place or camera that Ether reads, so their summary adds only the length (MD-09).  
`readAudioMetadataAsync` reads it the way a player does:  
an `<audio preload="metadata">` loads the header from an object URL, and `duration` is kept to the millisecond.  
So the length is known wherever the sender's browser plays the format, and left out elsewhere.  
A header without a length (`Infinity`, common in recordings made in a browser) leaves it out too.  
The reader gives up after 1 second, well inside the 2-second limit,  
so a slow file still goes with its file date; the element and the object URL are released either way.

## Thumbnails

`createThumbnailAsync(file, metadata)` returns a JPEG of at most 256 px on the longest side and at most 24 KiB (TH-01).  
It starts at quality 0.7 and steps down by 0.1 to 0.2 until the JPEG fits.  
It never enlarges, it draws on white so transparent images don't turn black,  
and it resolves `undefined` when the browser can't decode the file; the UI then shows its category's icon.

The first source that decodes wins:

1. **Photos, embedded preview:** the JPEG preview in EXIF (`exifr.thumbnail`).  
   Its pixels are stored unrotated, so the EXIF orientation from the metadata is applied with a canvas transform.  
   It is skipped when the metadata is missing, because the orientation is then unknown.
2. **Photos, full decode:** `createImageBitmap(file)`.  
   The browser applies the EXIF orientation itself.  
   When the metadata gives the size, the decoder is asked for the longest displayed side only (`resizeWidth: 256` or `resizeHeight: 256`),  
   so a stale stored size can't distort the aspect ratio.
3. **Videos:** a `<video>` loads the file from an object URL, seeks to 1 s (the middle of clips shorter than 2 s),  
   and that frame is drawn.  
   The object URL is revoked afterwards, and every wait gives up after 5 seconds.

Drawing uses `OffscreenCanvas` where it exists and a `<canvas>` elsewhere.  
The decisions (order, layout, orientation transforms, quality steps) live in `thumbnail.ts` and run under Node in tests;  
the browser calls live in `canvasImaging.ts`.

## Previews

`canPreview(mime, name)` answers whether the browser can show an image, or play a video or audio type, itself (RX-06, SP-06).  
JPEG, PNG, GIF, WebP and BMP are always previewed; SVG never is.  
Engine-specific types are probed once at start-up by `probePreviewSupportAsync()`:  
videos and audio (MP3, M4A and AAC, WAV, FLAC, Ogg and WebM audio) with an element's `canPlayType`,  
and images with a `<picture>` whose `<source type>` the engine skips when it can't decode that type.  
So HEIC previews appear on Safari and fall back to an icon on Chrome and Firefox, and FLAC plays only where the engine has the codec,  
without sniffing the browser name.  
Aliases such as `audio/x-m4a`, `audio/mp3` and `audio/x-wav` count as their standard names.

`mediaTypeOf(mime, name)` is the type a file is judged by: its MIME type,  
or, when the picker reports none (common for HEIC on Windows) or `application/octet-stream`, the type its extension stands for.  
`mediaKindOf(mime, name)` sorts files into `image`, `video` and `other` by that type; the client stores it as the record's `kind`.

## File categories and icons

`fileCategoryOf(mime, name)` (`media/fileCategory.ts`) gives every file one category,  
which decides its icon, its preview and the Type filter (MD-10):

| Category | What | Preview |
| --- | --- | --- |
| `image` | Photos and pictures, as `mediaKindOf` says | Thumbnail; full size in the viewer where the browser decodes it |
| `video` | Videos, as `mediaKindOf` says | Poster thumbnail; plays in Details and the viewer where the browser plays it |
| `audio` | `audio/*`, or `.mp3`, `.m4a`, `.aac`, `.wav`, `.flac`, `.ogg`, `.opus`, `.weba`, `.aiff`, `.wma`… | Fixed icon; plays in Details and the viewer where the browser plays it |
| `document` | PDF, Word, Excel, PowerPoint, OpenDocument, iWork, e-books, RTF, `text/*` (plain text, Markdown, CSV, HTML), JSON, XML | One fixed icon for every kind |
| `archive` | ZIP, gzip, tar, bzip2, xz, Zstandard, 7-Zip, RAR, CAB, disk images | Fixed icon |
| `other` | Everything else | Fixed icon |

Photos and videos are what `mediaKindOf` says, so a file's category always agrees with its stored kind.  
For the rest, the MIME type decides when it names a category, including the names Windows and older tools use  
(`application/x-zip-compressed`, `application/vnd.ms-excel` for CSV), and the extension decides when it doesn't.  
The UI reads it through `categoryOf(record)` in `app/fileIcon.ts`, which lets the record's stored kind settle photo or video.

`app/fileIcon.ts` turns a category into its icon: `<span class="file-icon" data-category="audio">` around the SVG from `app/icons.ts`,  
coloured by the theme's file-type tokens (`--ft-image`, `--ft-video`, `--ft-audio`, `--ft-word` for documents, `--ft-archive`, `--ft-unknown`),  
which are defined for both themes.  
Tiles, list rows, progress lines, Details and the viewer all use it, so a file looks the same everywhere.  
A thumbnail is drawn over the icon once it arrives; one this browser can't draw (its `<img>` fails) gives the icon back,  
and a player that fails (`error` on the `<audio>` or `<video>`) gives way to the icon with "This browser can’t play this format."  
Nothing is ever shown broken.

Audio and video play from an object URL of the stored file, which the Content Security Policy allows (`media-src 'self' blob:`).

## ZIP

`createZipBlob(entries)` builds a store-only ZIP as a `Blob` made of the headers and each entry's own `Blob` (SV-04).  
File data is never read or copied into memory, so a 3 GB selection is ready at once.  
The CRC-32 of each file is computed while its pages arrive (`crc32Update`), so every size and CRC is known up front.

| Detail | Choice |
| --- | --- |
| Method | 0 (stored) |
| Names | UTF-8, general-purpose flag bit 11 |
| Data descriptors | None: CRC and sizes are in the local header |
| Date and time | DOS format from `lastModified` in local time, 2-second steps, clamped to 1980–2107 |
| Extended timestamp (`0x5455`, "UT") | Unix seconds, signed 32-bit (1901–2038). Local header: modified, accessed (= modified) and created, flags `0x07`. Central directory: modified only, same flags |
| NTFS times (`0x000A`) | Tag 1: modified, accessed (= modified) and created as Windows FILETIME (100 ns since 1601-01-01 UTC), in both headers |
| Extra field order | ZIP64 (when present), then UT, then NTFS |
| Version made by | Unix, so the file mode `0644` in the external attributes applies |
| Version needed | 2.0, or 4.5 for entries with ZIP64 fields |
| ZIP64 extra field | When a size or a local header offset reaches `0xFFFFFFFF`; it lists only the fields whose 32-bit slot holds `0xFFFFFFFF` |
| ZIP64 end record and locator | When there are 65,535 entries or more, or the central directory's size or offset reaches `0xFFFFFFFF` |

An entry whose `size` differs from its `Blob` throws a `RangeError` instead of producing a broken archive.  
The tests parse the output (headers, CRCs, offsets, ZIP64 records and time fields), including a forced ZIP64 archive and 65,535 entries.  
The archives were also checked by hand with Python's `zipfile` (`testzip()` and a byte-for-byte comparison) and with `bsdtar`.

### Dates in the ZIP

Received files leave the app as a ZIP, so each entry carries its dates as sent:  
`lastModified`, and `created` when the sender knew it (otherwise the modified time).  
The same instant is written three ways, because unzip tools each read a different field:

| Tool | Modified time | Created time |
| --- | --- | --- |
| Windows `tar -xf` (libarchive 3.x) | Restored to the second, from UT; the NTFS field is ignored | Not restored: the file gets the extraction time |
| PowerShell `Expand-Archive` (.NET) | From the DOS field: 2-second steps, local time | Not restored |
| Python `zipfile` | Read from the DOS field (`date_time`); `extractall` doesn't set file times | Not read |
| Info-ZIP `unzip`, macOS `ditto` and Archive Utility | Expected from UT, to the second | UT created time is read by Info-ZIP builds that support it |
| Windows Explorer and 7-Zip | Expected from the NTFS field, to 100 ns | Expected from the NTFS field |

The first three rows were checked on Windows 11; the last two follow the tools' documentation and were not tested here.  
Without an accessed time in UT, libarchive sets the accessed time to 1970-01-01,  
so UT carries the modified time as the accessed time too.  
On iPhone, photo apps sort by the date inside the file (EXIF), not by these fields (RX-04).

```ts
const archive = createZipBlob(
    receivedFiles.map(received => ({
        name: uniqueFileName(sanitizeFileName(received.name), takenNames),
        data: received.blob,
        size: received.size,
        crc32: received.crc32,
        lastModified: received.lastModified,
        created: received.created,
    })),
);
```

## File names

| Function | Rule | Example |
| --- | --- | --- |
| `sanitizeFileName` | `/ \ : * ? " < > \|`, control and text-direction characters become `_` | `a:b?.jpg` → `a_b_.jpg` |
| `sanitizeFileName` | Trailing dots and spaces go; an empty name becomes `file` | `notes.txt. ` → `notes.txt` |
| `sanitizeFileName` | Reserved Windows names gain `_`, whatever the extension | `nul.txt` → `nul_.txt` |
| `sanitizeFileName` | NFC normalisation and at most 255 UTF-8 bytes, keeping the extension | — |
| `uniqueFileName` | ` (2)`, ` (3)`… before the extension, ignoring case; `taken` holds lower-case names and gains the result | `IMG_1.jpg` → `IMG_1 (2).jpg` |
| `flattenRelativePath` | Folders joined with ` - ` for phones, where Photos and Downloads have no folders | `Trip/Day 1/IMG_1.jpg` → `Trip - Day 1 - IMG_1.jpg` |
| `truncateMiddle` | Cuts the middle of the name and keeps the extension, by code point (UI-09) | `IMG_20261123_140542_holiday.jpeg`, 16 → `IMG_2…liday.jpeg` |

An extension is a final dot followed by 1–12 characters without spaces or dots, so `Mr. Smith goes to town` has none.

## QR codes

The pairing QR holds the app URL, `#` and the Base32 code (HS-04).  
`createQrMatrix(text)` splits that into two segments:  
the URL up to and including `#` in byte mode (as UTF-8, because the path is case-sensitive),  
and the code in alphanumeric mode, which needs 5.5 bits per character instead of 8.  
Text that isn't a URL with a Base32 code goes in as one byte segment.  
Error correction is level M, and the smallest version that fits is chosen.

| Text | Mixed segments | Byte mode only |
| --- | --- | --- |
| `https://example.github.io/ether-web-app/#` + 112 characters (70 bytes) | Version 7 | Version 9 |
| `https://example.github.io/ether-web-app/#` + 140 characters | Version 8 (49 × 49) | Version 10 |
| `https://example.github.io/ether-web-app/#` + 176 characters (110 bytes) | Version 9 | Version 11 |

`renderQrSvg(matrix)` returns an SVG with a white background, black modules as one `<path>` of horizontal runs,  
a 4-module quiet zone and `shape-rendering="crispEdges"` (UI-03).  
It has no `width`, `height` or `style` attributes: the page's CSS sizes it, and the Content Security Policy forbids inline styles.  
It stays black on white in every theme.

```ts
const matrix = createQrMatrix(offer.url);
qrContainer.innerHTML = renderQrSvg(matrix);
```

### Scanning

`openCameraAsync(constraints)` opens the camera with video only and rejects like `getUserMedia`,  
so the UI can fall back to the paste box (UI-04).  
`torchSupported` is read live from `getCapabilities().torch`, because some Android cameras report the torch only once frames flow;  
`setTorchAsync(on)` applies `{ advanced: [{ torch: on }] }` and does nothing without a torch.

`createQrScanner({ video, onCode, logger })` reads about 8 frames a second (HS-09):

- with `BarcodeDetector` (`qr_code`) where the browser has it;
- otherwise, and after the first `detect()` failure, with jsQR on a frame scaled down to at most 640 px;
- a code is reported once while it stays in view, and again only after it has been out of view for 3 seconds;
- a frame that fails is logged at most once every 10 seconds, and scanning goes on.

```ts
const camera = await openCameraAsync(platform.cameraPlan().constraints);
cameraView.srcObject = camera.stream;
const scanner = createQrScanner({ video: cameraView, logger, onCode: text => joinWithCodeAsync(text) });
scanner.start();
```

`decodeQrImageData(imageData)` decodes one RGBA frame with jsQR; the tests use it to read back codes drawn by `createQrMatrix`.

## Modules

| File | Exports |
| --- | --- |
| `media/metadataTypes.ts` | `FileMetadata`, `MediaToolkit`, `MediaKind`, `EmbeddedMetadata`, `EmbeddedDateSource` |
| `media/mediaToolkit.ts` | `createBrowserMediaToolkit` |
| `media/fileMetadata.ts` | `extractFileMetadataAsync`, `buildFileMetadata`, `METADATA_READERS`, `METADATA_TIMEOUT_MS` |
| `media/imageMetadata.ts` | `readImageMetadataAsync`, `readEmbeddedThumbnailAsync`, `mapExifrOutput` |
| `media/videoMetadata.ts` | `readVideoMetadataAsync`, `findMovieBoxAsync`, `parseMovieBox`, `parseIso6709`, `readBoxes` |
| `media/metadataDates.ts` | `parseMetadataDate`, `normalizeOffset`, `formatUtcDate`, `formatLocalDate`, `quickTimeSecondsToDate` |
| `media/metadataValues.ts` | `withoutUndefined`, `cleanText`, `cleanTags`, `toCoordinates` and the text limits |
| `media/thumbnail.ts` | `createThumbnailAsync`, `thumbnailLayout`, `decodeHint`, `encodeWithinBudgetAsync`, `videoFrameTime` |
| `media/canvasImaging.ts` | `createCanvasImaging` (browser only) |
| `media/mediaKind.ts` | `mediaKindOf`, `mediaTypeOf`, `extensionOf`, `canPreview`, `probePreviewSupportAsync`, `normalizeMime` |
| `media/fileCategory.ts` | `fileCategoryOf`, `isPreviewCategory`, `FileCategory`, `FILE_CATEGORIES` |
| `media/audioMetadata.ts` | `readAudioMetadataAsync`, `readAudioDurationAsync`, `AUDIO_TIMEOUT_MS` |
| `media/zip.ts` | `createZipBlob`, `ZipEntry`, `toDosDateTime`, `toFileTime` |
| `media/fileNames.ts` | `sanitizeFileName`, `uniqueFileName`, `flattenRelativePath`, `truncateMiddle`, `splitExtension` |
| `media/crc32.ts` | `crc32`, `crc32Update`, `CRC32_INITIAL` |
| `qr/qrCode.ts` | `createQrMatrix`, `renderQrSvg`, `splitQrSegments`, `QrMatrix` |
| `qr/qrScanner.ts` | `createQrScanner`, `decodeQrImageData`, `createRepeatFilter`, `frameSize` |
| `qr/camera.ts` | `openCameraAsync`, `CameraSession` |
