// The licence texts of the libraries bundled into the site, as one plain-text file (licenses.txt) beside it.
// MIT and Apache-2.0 ask that a library's notice travels with every copy of it, minified or not. The build
// fails when a bundled package has no licence text it can find, so a new dependency can't ship without one.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const PACKAGE_IN_PATH = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/g;

const MIT_PERMISSION = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software '
    + 'and associated documentation files (the "Software"), to deal in the Software without restriction, including '
    + 'without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies '
    + 'of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following '
    + 'conditions:\n\n'
    + 'The above copyright notice and this permission notice shall be included in all copies or substantial portions '
    + 'of the Software.\n\n'
    + 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED '
    + 'TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL '
    + 'THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF '
    + 'CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER '
    + 'DEALINGS IN THE SOFTWARE.';

// The packages that bundled files come from, by name ("jsqr", "@scope/name"), from esbuild's input paths;
// a package nested in another's node_modules counts as itself.
export function bundledPackages(inputPaths) {
    const names = new Set();
    for (const path of inputPaths) {
        const name = [...path.matchAll(PACKAGE_IN_PATH)].at(-1)?.[1];
        if (name != null) {
            names.add(name.replace('\\', '/'));
        }
    }

    return [...names].sort();
}

// "// Copyright (c) 2009 Kazuhiko Arase" in the head of a package's entry file, without the comment marks.
export function findCopyrightLine(source) {
    const line = /^[\s/*#!]*(copyright\b.*)$/im.exec(source.slice(0, 4000))?.[1];

    return line?.replace(/\s*\*\/\s*$/, '').trim();
}

// A package's name, version, licence id and licence text: its own licence file, or for an MIT package without
// one, the MIT text under the copyright line of its entry file.
export async function readNoticeAsync(packageDirectory) {
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf-8'));
    const licenseFile = (await readdir(packageDirectory)).find(name => LICENSE_FILE.test(name));
    if (licenseFile != null) {
        const text = await readFile(join(packageDirectory, licenseFile), 'utf-8');

        return { name: manifest.name, version: manifest.version, license: manifest.license, text: text.trim() };
    }

    const entry = await readFile(join(packageDirectory, manifest.main ?? 'index.js'), 'utf-8').catch(() => '');
    const copyright = findCopyrightLine(entry);
    if (manifest.license === 'MIT' && copyright != null) {
        const text = `MIT License\n\n${copyright}\n\n${MIT_PERMISSION}`;

        return { name: manifest.name, version: manifest.version, license: manifest.license, text };
    }

    const license = manifest.license ?? 'no licence';

    throw new Error(`No licence text found for the bundled package ${manifest.name} (${license})`);
}

export function formatNotices(notices) {
    const intro = 'Ether bundles these open-source libraries. Each one\'s licence follows its name and version.';
    const sections = notices.map(notice => `${notice.name} ${notice.version} (${notice.license})\n\n${notice.text}`);

    return `${[intro, ...sections].join('\n\n\n')}\n`;
}

export async function buildNoticesAsync(inputPaths, rootDirectory) {
    const notices = await Promise.all(bundledPackages(inputPaths)
        .map(name => readNoticeAsync(join(rootDirectory, 'node_modules', ...name.split('/')))));

    return formatNotices(notices);
}
