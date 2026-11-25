import { describe, expect, it } from 'vitest';
import { flattenRelativePath, sanitizeFileName, splitExtension, truncateMiddle, uniqueFileName } from './fileNames.js';

describe('splitExtension', () => {
    it('splits at the last dot', () => {
        // Act
        const parts = splitExtension('archive.tar.gz');

        // Assert
        expect(parts).toEqual({ base: 'archive.tar', extension: '.gz' });
    });

    it('treats a leading dot and a long or spaced tail as part of the name', () => {
        // Act
        const hidden = splitExtension('.gitignore');
        const sentence = splitExtension('Mr. Smith goes to town');

        // Assert
        expect(hidden).toEqual({ base: '.gitignore', extension: '' });
        expect(sentence).toEqual({ base: 'Mr. Smith goes to town', extension: '' });
    });
});

describe('sanitizeFileName', () => {
    it('replaces characters that file systems refuse and keeps the extension', () => {
        // Act
        const name = sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.JPG');

        // Assert
        expect(name).toBe('a_b_c_d_e_f_g_h_i_j.JPG');
    });

    it('replaces control and direction-override characters', () => {
        // Act
        const name = sanitizeFileName('bad\u0000name\u0007‮gpj.exe');

        // Assert
        expect(name).toBe('bad_name__gpj.exe');
    });

    it('drops trailing dots and spaces and falls back when nothing is left', () => {
        // Act
        const trailing = sanitizeFileName('  notes.txt. . ');
        const empty = sanitizeFileName(' .. ');

        // Assert
        expect(trailing).toBe('notes.txt');
        expect(empty).toBe('file');
    });

    it('avoids reserved Windows names whatever the extension', () => {
        // Act
        const names = ['CON', 'nul.txt', 'Com1.tar.gz', 'lpt9', 'console.log'].map(sanitizeFileName);

        // Assert
        expect(names).toEqual(['CON_', 'nul_.txt', 'Com1_.tar.gz', 'lpt9_', 'console.log']);
    });

    it('normalises to NFC so the same name from macOS and Windows compares equal', () => {
        // Act
        const name = sanitizeFileName('Café.jpg');

        // Assert
        expect(name).toBe('Café.jpg');
    });

    it('limits the name to 255 UTF-8 bytes and keeps the extension', () => {
        // Arrange
        const longName = `${'ä'.repeat(300)}.jpeg`;

        // Act
        const name = sanitizeFileName(longName);

        // Assert
        expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
        expect(name.endsWith('ä.jpeg')).toBe(true);
    });
});

describe('uniqueFileName', () => {
    it('adds a counter before the extension on clashes, ignoring case', () => {
        // Arrange
        const taken = new Set<string>();

        // Act
        const names = ['IMG_1.jpg', 'img_1.JPG', 'IMG_1.jpg', 'README', 'README'].map(name => uniqueFileName(name, taken));

        // Assert
        expect(names).toEqual(['IMG_1.jpg', 'img_1 (2).JPG', 'IMG_1 (3).jpg', 'README', 'README (2)']);
        expect(taken.has('img_1 (3).jpg')).toBe(true);
    });
});

describe('flattenRelativePath', () => {
    it('joins folder names into the file name', () => {
        // Act
        const name = flattenRelativePath('Trip/Day 1/IMG_0001.JPG');

        // Assert
        expect(name).toBe('Trip - Day 1 - IMG_0001.JPG');
    });

    it('ignores empty, current and parent segments and backslashes', () => {
        // Act
        const name = flattenRelativePath('/../Trip\\\\./day:2/clip.mov');

        // Assert
        expect(name).toBe('Trip - day_2 - clip.mov');
    });
});

describe('truncateMiddle', () => {
    it('keeps short names unchanged', () => {
        // Act
        const name = truncateMiddle('IMG_1.jpg', 9);

        // Assert
        expect(name).toBe('IMG_1.jpg');
    });

    it('cuts the middle of the base name and keeps the extension', () => {
        // Act
        const name = truncateMiddle('IMG_20261123_140542_holiday.jpeg', 16);

        // Assert
        expect(name).toBe('IMG_2…liday.jpeg');
        expect(Array.from(name)).toHaveLength(16);
    });

    it('cuts the whole name when the extension leaves no room', () => {
        // Act
        const name = truncateMiddle('abcdefghij.extension', 6);

        // Assert
        expect(name).toBe('abc…on');
    });

    it('never splits an emoji', () => {
        // Act
        const name = truncateMiddle('😀😀😀😀😀😀😀😀.png', 8);

        // Assert
        expect(name).toBe('😀😀…😀.png');
    });

    it('handles tiny limits', () => {
        // Act
        const one = truncateMiddle('photo.jpg', 1);
        const zero = truncateMiddle('photo.jpg', 0);

        // Assert
        expect(one).toBe('…');
        expect(zero).toBe('');
    });
});
