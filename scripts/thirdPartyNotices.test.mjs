// The licences shipped beside the site: every bundled library's text, found or composed, and never left out.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledPackages, buildNoticesAsync, findCopyrightLine, readNoticeAsync } from './thirdPartyNotices.mjs';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');

let scratchDirectory;

async function packageDirectoryAsync(manifest, files = {}) {
    scratchDirectory = await mkdtemp(join(tmpdir(), 'ether-notices-'));
    await writeFile(join(scratchDirectory, 'package.json'), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) {
        await writeFile(join(scratchDirectory, name), text);
    }

    return scratchDirectory;
}

describe('third-party notices', () => {
    afterEach(async () => {
        if (scratchDirectory != null) {
            await rm(scratchDirectory, { recursive: true, force: true });
            scratchDirectory = undefined;
        }
    });

    it('names each bundled package once, scoped and nested ones included, and skips the app\'s own files', () => {
        // Arrange
        const inputs = [
            'src/app/main.ts',
            'node_modules/jsqr/dist/jsQR.js',
            'node_modules/jsqr/dist/other.js',
            'node_modules\\exifr\\dist\\full.umd.js',
            'node_modules/@scope/name/index.js',
            'node_modules/outer/node_modules/inner/index.js',
        ];

        // Act
        const names = bundledPackages(inputs);

        // Assert
        expect(names).toEqual(['@scope/name', 'exifr', 'inner', 'jsqr']);
    });

    it('reads the copyright line out of a file\'s opening comment', () => {
        // Act & Assert
        expect(findCopyrightLine('//---\n//\n// Copyright (c) 2009 Kazuhiko Arase\n//\nvar a;'))
            .toBe('Copyright (c) 2009 Kazuhiko Arase');
        expect(findCopyrightLine('/*!\n * Copyright 2020 Someone */\n')).toBe('Copyright 2020 Someone');
        expect(findCopyrightLine('export const a = 1;')).toBeUndefined();
    });

    it('uses a package\'s own licence file when it has one', async () => {
        // Arrange
        const directory = await packageDirectoryAsync(
            { name: 'lib', version: '1.2.3', license: 'Apache-2.0' },
            { 'LICENSE': '  Apache License\nVersion 2.0  \n' },
        );

        // Act
        const notice = await readNoticeAsync(directory);

        // Assert
        expect(notice).toEqual({ name: 'lib', version: '1.2.3', license: 'Apache-2.0', text: 'Apache License\nVersion 2.0' });
    });

    it('composes the MIT text under the entry file\'s copyright line for an MIT package without a licence file', async () => {
        // Arrange
        const directory = await packageDirectoryAsync(
            { name: 'qr', version: '2.0.4', license: 'MIT', main: 'qr.js' },
            { 'qr.js': '// Copyright (c) 2009 Kazuhiko Arase\nvar qr = 1;\n' },
        );

        // Act
        const notice = await readNoticeAsync(directory);

        // Assert
        expect(notice.text.startsWith('MIT License\n\nCopyright (c) 2009 Kazuhiko Arase\n\nPermission is hereby granted'))
            .toBe(true);
        expect(notice.text).toContain('shall be included in all copies or substantial portions');
    });

    it('fails rather than ship a package whose licence text it can\'t find', async () => {
        // Arrange
        const directory = await packageDirectoryAsync({ name: 'mystery', version: '0.0.1', license: 'GPL-3.0' });

        // Act & Assert
        await expect(readNoticeAsync(directory)).rejects.toThrow('No licence text found for the bundled package mystery');
    });

    it('covers the libraries the app bundles today, with each one\'s licence', async () => {
        // Arrange
        const inputs = ['node_modules/exifr/dist/full.umd.js', 'node_modules/jsqr/dist/jsQR.js', 'node_modules/qrcode-generator/dist/qrcode.js'];

        // Act
        const text = await buildNoticesAsync(inputs, ROOT_DIRECTORY);

        // Assert
        expect(text).toMatch(/^exifr \S+ \(MIT\)$/m);
        expect(text).toMatch(/^jsqr \S+ \(Apache-2.0\)$/m);
        expect(text).toMatch(/^qrcode-generator \S+ \(MIT\)$/m);
        expect(text).toContain('Copyright (c) 2009 Kazuhiko Arase');
        expect(text).toContain('Apache License');
    });
});
