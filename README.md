# Ether

Send files between two devices on the same Wi‑Fi, straight from one browser to the other.  
Ether is a static web page, and no file ever passes through a server.  
Devices with Ether open find each other on Home; tap one to connect. Or pair with a code:
one device shows a QR code, the other scans it and shows one back.
Either way the two browsers connect over WebRTC,
and photos, videos and files move directly across the local network, encrypted.

- **No server, no account:** files go straight from one device to the other; pairing with a code travels in two QR codes,
  or in copy-and-paste text when there is no camera.
- **Nearby devices:** devices on the same Wi‑Fi with Ether open show up on Home, found through public relays that pass
  only encrypted messages; tap one, and they pair once the other device accepts,
  or at once when that device has a PIN and you enter it.
- **Resumes after anything:** each pair of devices has a session that survives reconnects;
  files move in saved, hashed pages, so a dropped link, a locked iPhone, a reload or a Stop picks up where it stopped,
  and Reconnect pairs again with a nearby device as soon as it shows up.
- **Keeps metadata:** files are sent byte for byte, so date taken, location and camera stay inside them.
- **Many files:** thousands of photos per batch, listed by day, month or year in Sent and Received, as a list or as thumbnails.
- **Nothing sent twice:** sending the same files again skips what the other device already has, checked by its hash,
  and Stop halts a batch at once on both devices, keeping what arrived for Resume.
- **Dates kept:** received files download as a ZIP that keeps each file's modified date as sent, and every OS unzips it.
- **Installable and offline:** add it to the Home Screen; it opens with no internet, and only needs the Wi‑Fi.

## Contents

- [Requirements](docs/Requirements.md): the full specification, with the IDs the code and tests refer to
- [Overview](docs/Overview.md): layers, folders, platforms, naming and the build
- [Network](docs/Network.md): pairing codes, the rebuilt SDP, channels, frames, health and errors
- [Client](docs/Client.md): the use-case API, the protocol, sessions, storage and resume
- [Media](docs/Media.md): metadata, thumbnails, ZIP, file names and QR codes
- [Screens](docs/Screens.md): every screen in portrait, landscape and desktop, and how platforms differ
- [Settings and logs](docs/AdminAndLogs.md): the Settings sheet, the settings kept in code, debug logging, the log viewer and test tools
- [Offline](docs/Offline.md): the service worker, updates, installing and storage

## Quick start

Needs Windows PowerShell 5.1.

```powershell
powershell -File .\Start-Debug.ps1             # one browser window
powershell -File .\Start-Debug.ps1 -Peers 2    # two windows with separate profiles, to pair with each other
powershell -File .\Start-Debug.ps1 -Tunnel     # an HTTPS dev tunnel address for phones, with a QR in the terminal
powershell -File .\Start-Debug.ps1 -Lan        # HTTPS on the LAN with a self-signed certificate
```

Installs Node.js and the npm packages when they're missing, rebuilds on every save, serves `dist` and opens the browser.  
`http://localhost` is a secure context, so the camera, the service worker and `crypto.subtle` work there.

Phones need HTTPS.  
`-Tunnel` hosts the local server through a Microsoft dev tunnel, a real HTTPS address with a valid certificate,
and prints it as a QR code to scan with the phone.  
The page loads through the tunnel; files still travel straight across the Wi‑Fi between the two devices.  
When `devtunnel` isn't on `PATH`, the script downloads a pinned build into `%LOCALAPPDATA%\ether-web-app\tools`,
checks its SHA256 and records it in `installed.json` there;
`-RemoveTools` removes it again and `-NoInstall` fails with the download address instead.  
The first run asks you to sign in to dev tunnels in the browser, with GitHub unless you pass `-TunnelAccount Microsoft`.  
The tunnel is kept in `.devtunnel`, so its address stays the same between runs,
and the phone keeps its device ID, history and Home Screen install; `-NewTunnel` starts over with a new address.  
Anyone with the address can open the page, and the first visit on each device shows a dev tunnels notice: tap Continue.

`-Lan` creates a self-signed certificate in `.certificates` and serves on every interface instead;
accept the certificate warning on the phone once.  
The service worker doesn't install on a page with a certificate error, so prefer `-Tunnel`.

With `-Tunnel` or `-Lan`, the browser on the computer opens the same address the phone uses,
so the links inside pairing QR codes work when the phone's camera app scans them.

## Test

```powershell
powershell -File .\Invoke-Test.ps1                                # type checks, then every test
powershell -File .\Invoke-Test.ps1 -Path .\src\client             # one folder
powershell -File .\Invoke-Test.ps1 -Path .\src\network,.\scripts  # several, comma-separated
powershell -File .\Invoke-Test.ps1 -TestName 'resume'             # by name
powershell -File .\Invoke-Test.ps1 -Watch                         # rerun on save
```

Node.js is installed with winget when it is missing or older than 20,
and `npm ci` runs when `node_modules` is missing or older than `package-lock.json`.  
Then it type-checks the page and the service worker, and runs Vitest:
the `logic` project runs `src/core`, `src/platform`, `src/network`, `src/client`, `src/media`, `src/qr` and `scripts/*.test.mjs` under Node,
and the `ui` project runs `src/app` under happy-dom.  
`scripts/conventions.test.mjs` enforces the layer rules and that only the console sink writes to the console.  
Exit codes: `0` passed, `1` type errors or failures, `2` no tests discovered, `3` Node.js or the npm packages unavailable.

Three checks drive real Chromium (Playwright's cached build, or Chrome; set `CHROME_PATH` to pick one):

```powershell
npm run check:network   # two Network instances in one page: pairing, messages, frames on all four slots, close
npm run check:app       # builds, then two isolated browsers pair by Copy and Paste, send a file, and unzip the ZIP to compare
npm run check:nearby    # needs the internet: two pages meet through the real relays, ask, accept, decline and use a PIN
```

## Deploy

The site is published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`:
it installs, type-checks, tests, builds and uploads `dist`.  
One-time setup in the repository: **Settings → Pages → Source: GitHub Actions**.  
Every path in the build is relative, so the site works at `https://<user>.github.io/ether-web-app/`.

To build by hand:

```powershell
npm run build   # writes dist
npm run serve   # serves dist at http://localhost:5173/
```

## Licence

MIT, see [LICENSE](LICENSE).  
Bundled: `exifr` (MIT), `jsqr` (Apache-2.0), `qrcode-generator` (MIT).  
The build writes their licence texts to `licenses.txt` beside the site (`scripts/thirdPartyNotices.mjs`),  
linked from Settings as **Open-source licenses**; it fails when a bundled package has no licence text it can find.  
HEIC photos preview only where the browser decodes them itself (Safari); Ether ships no HEIC or HEVC decoder.
