import { describe, expect, it } from 'vitest';
import { fileCategoryOf, isPreviewCategory } from './fileCategory.js';
import type { FileCategory } from './fileCategory.js';
import { mediaKindOf } from './mediaKind.js';

// Each case: the MIME type a picker reported, the file name and the category it belongs to.
type Case = readonly [mime: string, name: string, category: FileCategory];

function categorize(cases: readonly Case[]): Array<readonly [string, FileCategory]> {
    return cases.map(([mime, name]) => [`${mime} ${name}`, fileCategoryOf(mime, name)] as const);
}

function expected(cases: readonly Case[]): Array<readonly [string, FileCategory]> {
    return cases.map(([mime, name, category]) => [`${mime} ${name}`, category] as const);
}

describe('fileCategoryOf', () => {
    it('sorts photos and videos as mediaKindOf does, by MIME type and else by extension', () => {
        // Arrange
        const cases: Case[] = [
            ['image/jpeg', 'IMG_1.JPG', 'image'],
            ['image/heic', 'IMG_2.HEIC', 'image'],
            ['', 'IMG_3.heic', 'image'],
            ['image/svg+xml', 'logo.svg', 'image'],
            ['application/octet-stream', 'raw.dng', 'image'],
            ['video/quicktime', 'IMG_4.MOV', 'video'],
            ['video/mp4', 'clip.mp4', 'video'],
            ['', 'clip.mkv', 'video'],
            ['video/webm', 'screen.webm', 'video'],
        ];

        // Act
        const categories = categorize(cases);

        // Assert
        expect(categories).toEqual(expected(cases));
        expect(cases.every(([mime, name, category]) => mediaKindOf(mime, name) === category)).toBe(true);
    });

    it('sorts audio by its MIME type, its aliases and its extension', () => {
        // Arrange
        const cases: Case[] = [
            ['audio/mpeg', 'song.mp3', 'audio'],
            ['audio/mp3', 'song.mp3', 'audio'],
            ['audio/x-m4a', 'voice.m4a', 'audio'],
            ['audio/aac', 'track.aac', 'audio'],
            ['audio/wav', 'take.wav', 'audio'],
            ['audio/flac', 'album.flac', 'audio'],
            ['audio/ogg', 'podcast.ogg', 'audio'],
            ['audio/webm', 'recording.weba', 'audio'],
            ['audio/x-ms-wma', 'old.wma', 'audio'],
            ['', 'song.MP3', 'audio'],
            ['', 'voice.opus', 'audio'],
            ['application/octet-stream', 'take.aiff', 'audio'],
            ['application/ogg', 'podcast.oga', 'audio'],
        ];

        // Act
        const categories = categorize(cases);

        // Assert
        expect(categories).toEqual(expected(cases));
    });

    it('gives every kind of document one category: PDF, Office, OpenDocument, iWork, e-books, text and its kin', () => {
        // Arrange
        const cases: Case[] = [
            ['application/pdf', 'report.pdf', 'document'],
            ['application/msword', 'letter.doc', 'document'],
            ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx', 'document'],
            ['application/vnd.ms-word.document.macroEnabled.12', 'macro.docm', 'document'],
            ['application/vnd.ms-excel', 'budget.xls', 'document'],
            ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'budget.xlsx', 'document'],
            ['application/vnd.ms-excel.sheet.macroEnabled.12', 'budget.xlsm', 'document'],
            ['application/vnd.ms-powerpoint', 'deck.ppt', 'document'],
            ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx', 'document'],
            ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', 'show.ppsx', 'document'],
            ['application/vnd.oasis.opendocument.text', 'essay.odt', 'document'],
            ['application/vnd.oasis.opendocument.spreadsheet', 'sheet.ods', 'document'],
            ['application/vnd.oasis.opendocument.presentation', 'talk.odp', 'document'],
            ['application/vnd.apple.pages', 'story.pages', 'document'],
            ['application/epub+zip', 'novel.epub', 'document'],
            ['application/rtf', 'notes.rtf', 'document'],
            ['text/rtf', 'notes.rtf', 'document'],
            ['text/plain', 'notes.txt', 'document'],
            ['text/markdown', 'README.md', 'document'],
            ['text/csv', 'export.csv', 'document'],
            ['text/html', 'page.html', 'document'],
            ['application/json', 'data.json', 'document'],
            ['application/xml', 'feed.xml', 'document'],
        ];

        // Act
        const categories = categorize(cases);

        // Assert
        expect(categories).toEqual(expected(cases));
    });

    it('reads the extension of a document whose picker reported no type', () => {
        // Arrange
        const cases: Case[] = [
            ['', 'report.PDF', 'document'],
            ['', 'letter.docx', 'document'],
            ['application/octet-stream', 'budget.xlsx', 'document'],
            ['', 'deck.pptx', 'document'],
            ['', 'essay.odt', 'document'],
            ['', 'numbers.numbers', 'document'],
            ['', 'keynote.key', 'document'],
            ['', 'README.md', 'document'],
            ['', 'export.tsv', 'document'],
            ['', 'notes.rtf', 'document'],
            ['', 'app.log', 'document'],
            ['', 'book.mobi', 'document'],
        ];

        // Act
        const categories = categorize(cases);

        // Assert
        expect(categories).toEqual(expected(cases));
    });

    it('sorts archives by MIME type, including the names Windows and older tools use, and by extension', () => {
        // Arrange
        const cases: Case[] = [
            ['application/zip', 'photos.zip', 'archive'],
            ['application/x-zip-compressed', 'photos.zip', 'archive'],
            ['application/gzip', 'logs.gz', 'archive'],
            ['application/x-tar', 'backup.tar', 'archive'],
            ['application/x-7z-compressed', 'bundle.7z', 'archive'],
            ['application/vnd.rar', 'bundle.rar', 'archive'],
            ['application/x-rar-compressed', 'bundle.rar', 'archive'],
            ['', 'backup.tar.gz', 'archive'],
            ['', 'backup.tgz', 'archive'],
            ['', 'bundle.7z', 'archive'],
            ['application/octet-stream', 'disk.iso', 'archive'],
            ['', 'source.tar.zst', 'archive'],
        ];

        // Act
        const categories = categorize(cases);

        // Assert
        expect(categories).toEqual(expected(cases));
    });

    it('calls everything else a file', () => {
        // Arrange
        const cases: Case[] = [
            ['application/octet-stream', 'firmware.bin', 'other'],
            ['', 'README', 'other'],
            ['application/x-msdownload', 'setup.exe', 'other'],
            ['application/vnd.android.package-archive', 'app.apk', 'other'],
            ['font/woff2', 'font.woff2', 'other'],
            ['', 'font.ttf', 'other'],
            ['', '.bashrc', 'other'],
            ['application/x-unknown', 'photo.jpg', 'other'],
        ];

        // Act
        const categories = categorize(cases);

        // Assert
        expect(categories).toEqual(expected(cases));
    });

    it('trusts a MIME type that names a category over the extension, and the extension over an unknown type', () => {
        // Act
        const categories = [
            fileCategoryOf('application/pdf', 'scan.jpg'),
            fileCategoryOf('video/mp4', 'song.mp3'),
            fileCategoryOf('audio/mpeg', 'notes.txt'),
            fileCategoryOf('Application/PDF; charset=binary', 'scan'),
            fileCategoryOf('application/x-unknown', 'song.mp3'),
            fileCategoryOf('application/x-unknown', 'report.pdf'),
        ];

        // Assert
        expect(categories).toEqual(['document', 'video', 'audio', 'document', 'audio', 'document']);
    });
});

describe('isPreviewCategory', () => {
    it('is true for photos, videos and audio only', () => {
        // Arrange
        const categories: FileCategory[] = ['image', 'video', 'audio', 'document', 'archive', 'other'];

        // Act
        const answers = categories.map(isPreviewCategory);

        // Assert
        expect(answers).toEqual([true, true, true, false, false, false]);
    });
});
