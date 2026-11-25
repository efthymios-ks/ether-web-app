// Repository rules that a linter would check, kept as tests so Invoke-Test.ps1 enforces them.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRECTORY = join(ROOT_DIRECTORY, 'src');

// LG-01: the console sink is the only code that writes to the console.
const CONSOLE_ALLOWED = ['src/core/logSinks.ts'];

async function listSourceFilesAsync(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listSourceFilesAsync(path)));
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
            files.push(path);
        }
    }

    return files;
}

function toRepoPath(path) {
    return relative(ROOT_DIRECTORY, path).split(sep).join('/');
}

describe('source conventions', () => {
    it('never calls console outside the console sink (no-console)', async () => {
        // Arrange
        const files = await listSourceFilesAsync(SOURCE_DIRECTORY);
        const offenders = [];

        // Act
        for (const file of files) {
            const repoPath = toRepoPath(file);
            if (CONSOLE_ALLOWED.includes(repoPath)) {
                continue;
            }

            const text = await readFile(file, 'utf-8');
            if (/\bconsole\s*\./.test(text)) {
                offenders.push(repoPath);
            }
        }

        // Assert
        expect(offenders).toEqual([]);
    });

    it('names TypeScript files in camelCase', async () => {
        // Arrange
        const files = await listSourceFilesAsync(SOURCE_DIRECTORY);

        // Act
        const offenders = files
            .map(toRepoPath)
            .filter(path => !/^[a-z][a-zA-Z0-9]*(\.d)?\.ts$/.test(path.split('/').at(-1)));

        // Assert
        expect(offenders).toEqual([]);
    });

    it('keeps the network layer free of client, storage, media and UI imports (AR-01)', async () => {
        // Arrange
        const files = (await listSourceFilesAsync(join(SOURCE_DIRECTORY, 'network'))).map(toRepoPath);
        const offenders = [];

        // Act
        for (const path of files) {
            const text = await readFile(join(ROOT_DIRECTORY, path), 'utf-8');
            if (/from '\.\.\/(client|media|app|platform|qr)\//.test(text)) {
                offenders.push(path);
            }
        }

        // Assert
        expect(offenders).toEqual([]);
    });

    it('keeps nearby discovery free of UI, client, media and QR imports (AR-01)', async () => {
        // Arrange
        const files = (await listSourceFilesAsync(join(SOURCE_DIRECTORY, 'discovery'))).map(toRepoPath);
        const offenders = [];

        // Act
        for (const path of files) {
            const text = await readFile(join(ROOT_DIRECTORY, path), 'utf-8');
            if (/from '\.\.\/(app|client|media|qr)\//.test(text)) {
                offenders.push(path);
            }
        }

        // Assert
        expect(files.length).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });

    it('keeps the client free of UI imports (AR-01)', async () => {
        // Arrange
        const files = (await listSourceFilesAsync(join(SOURCE_DIRECTORY, 'client'))).map(toRepoPath);
        const offenders = [];

        // Act
        for (const path of files) {
            const text = await readFile(join(ROOT_DIRECTORY, path), 'utf-8');
            if (/from '\.\.\/(app|platform)\//.test(text)) {
                offenders.push(path);
            }
        }

        // Assert
        expect(offenders).toEqual([]);
    });
});
