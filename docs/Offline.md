# Offline, install and updates

After the first visit, Ether opens with no internet: a service worker keeps every built file (§12).  
The Wi‑Fi is still needed to reach the other device, but nothing is ever fetched from a server to do so.

## Service worker (PW-02)

`src/sw/serviceWorker.ts` is bundled by `scripts/build.mjs` into `dist/sw.js`,  
with two values put in at build time: `__PRECACHE__`, the list of every built file (`./`, `index.html`, the hashed scripts and styles,  
the manifest and the icons; source maps and licence files left out), and `__BUILD_VERSION__`, e.g. `0.1.0+7d1025df`,  
which changes whenever any built file changes.

| Event | What the worker does |
| --- | --- |
| `install` | Opens the cache `ether-<build version>` and adds every precached file, bypassing the HTTP cache so an update never stores an older copy. If one file fails, the install fails and the old version keeps running. |
| `activate` | Deletes every other cache whose name starts with `ether-`, then claims the open pages, so the first install works offline without a reload. |
| `fetch` | Same-origin `GET` only: the cached file first, the network otherwise. A page navigation ignores the query (`?debug=1`) and falls back to the cached `./`. Other origins and other methods are left to the browser. |
| `message` `skip-waiting` | Calls `skipWaiting()`, so a waiting version takes over. |
| `message` `version` | Answers `{ type: 'version', version }` on the message port, or to the sender. |

Every path is relative to the worker's scope, so the site works under `https://<user>.github.io/ether-web-app/` (PW-04).  
The `#` part of an address, which carries pairing codes, never reaches the worker.  
The worker type-checks on its own with `npx tsc --noEmit -p src/sw/tsconfig.json` (WebWorker library).

## Registration

`registerServiceWorker({ logger })` in `src/app/pwa/serviceWorkerClient.ts` registers `./sw.js` with scope `./`.  
It skips quietly, with one line in the log, where service workers are missing or the page is not a secure context  
(plain `http` on a LAN address); the app then works online only.  
It logs in category `sw`: registered, installed (offline ready), update found, update waiting, activated, applying update, reloading.

It returns three functions for the shell:

- `getVersion()`: the build version the controlling worker reported, for diagnostics.
- `onUpdateReady(handler)`: called when a new version is installed and waiting, also when one was already waiting at load.
- `applyUpdate()`: sends `skip-waiting` to the waiting worker and reloads the page once, when the new worker takes control.  
  A controller change nobody asked for (the first install claiming the page) never reloads.

## Updates (PW-03)

The browser looks for a new `sw.js` when the page loads; Ether makes no update requests of its own (§1).  
When a new version is waiting, the shell shows "An update is ready." with **Update now**.  
During a transfer the banner says it can install once the transfer finishes and has no button,  
and the shell refuses to call `applyUpdate()` until then, so a page never reloads mid-transfer.  
After the reload, the new version answers `version`, and the old cache is gone.

## Install (PW-05)

`createInstallController({ platform, logger })` in `src/app/pwa/installController.ts` keeps the browser's `beforeinstallprompt` event  
(and stops the browser's own mini bar), so the shell can offer its own button,  
and listens for `appinstalled`. The shell shows an install banner while installing is possible.

| Platform | `method` | What the user sees |
| --- | --- | --- |
| Android, Chrome | `prompt` | **Install** once the browser offers its prompt, which it opens once (`promptAsync()` resolves `true` when accepted); `steps()` gives the browser-menu way |
| Desktop Chrome and Edge | `prompt` | **Install**, once the browser offers the prompt |
| iPhone and iPad, Safari tab | `instructions` | **How?**: Share → Add to Home Screen → open Ether from the Home Screen (there is no prompt API on iPhone) |
| Desktop Safari and Firefox | `none` | Nothing; neither installs web apps from a page |
| Any installed app | `none` | Nothing |

`steps()` returns the platform's steps (`Platform.installSteps()`), and `on('change', handler)` fires when the prompt arrives,  
is used, or the app gets installed.  
The installed app on iPhone has its own storage and identity, separate from Safari's (DN-05, §7.5).

## Storage persistence (PW-06 to PW-08)

- The client calls `navigator.storage.persist()` once, at the first transfer (PW-06),  
  and logs `persistent storage granted` or `not granted` in category `device`.  
  Settings → Storage shows the storage used and free.
- Safari deletes script-written storage after 7 days without a visit to the site; home-screen apps count their own days (PW-07).  
  Ether shows no warning about it.
- A full quota makes writes fail with `QuotaExceededError`, handled as "Storage full" (PW-08).  
  The `fill-storage` test tool (`client.setTestTool`, code only) simulates it.
- **Clear all data…** removes sessions, files, history and saved logs; the cached app files stay until the next version replaces them.

## Checking it

1. `node scripts/build.mjs`, then `node scripts/serve.mjs` and open `http://127.0.0.1:5173/` (localhost counts as a secure context).
2. In the developer tools, Application → Service workers shows `sw.js` activated, and Cache storage shows `ether-<version>`  
   with every built file.
3. Turn the network off (Network → Offline) and reload: the app opens. `?debug=1` opens it with the log viewer.
4. Change any source file, build again and reload: the version at the bottom of Settings stays the old one  
   until **Update now** in the banner, after which it shows the new one and the old cache is gone.
