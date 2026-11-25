# Settings and logs

The **Settings** sheet holds the everyday settings (§16.1), every other setting lives in code (§16.2, §16.3),  
and the log viewer shows what the logger kept (§16.5–16.8).  
Both are plain TypeScript under `src/app/settings` and `src/app/logViewer`, built on the `Client` interface only,  
so they never touch the network or storage directly (AR-02).

## The Settings sheet (AP-01, AP-02)

The header's gear opens it with `createSettingsSheet(...).open()`: a dialog from `dialogs.openModal`,  
a bottom sheet on portrait phones and a centred sheet elsewhere, with a close button beside the title.  
Escape and the backdrop close it too, and focus goes back to the gear.  
Opening it never interrupts pairing or a transfer: it only reads the client and sends it settings.

Its rows, top to bottom, come from `ROWS` in `settingsSheet.ts`, one builder per row,  
so a new row slots in by its place in the list:

1. **Device name** and **Change**, which opens the rename sheet over Settings (below).
2. **PIN**: **Set PIN** while there is none, then **Change** and **Remove** (SP-09); the PIN sheet is below.
3. **Find nearby devices**, a switch: "Uses public relays to find devices on the same Wi‑Fi."
4. **Ask before receiving**, a switch, on by default: "Review each batch before it arrives." (SP-07).
5. **Theme**: System · Light · Dark. `shell/themeController.ts` applies the choice and stores it under `ether.theme`;  
   System, the default, follows `prefers-color-scheme`, also when it changes while the page is open.
6. **Storage**: used and free space from `client.getStorageInfoAsync()`, read each time the sheet opens,  
   and **Clear all data…** (see Storage).
7. The version, small and faint, e.g. "Ether 0.1.0+a2d6bc91".

The labels and help texts come from `SETTING_DESCRIPTORS`, so the sheet and the code share one list.  
Every row updates in place on the client's `settings` event and the theme's change,  
so a rename made elsewhere or a system theme change shows at once while the sheet is open.

## How changes apply (AP-03)

There is no Save button: switches and the theme apply at once.  
Switches go through `client.configureAsync`; when that fails, a toast says "Could not save the change. Try again."  
and the switch goes back to the stored value.  
The shell reroutes the logger on every settings change (LG-05), so logging changes apply without a reload.

### Rename sheet (DN-02)

`openRenameSheet` in `src/app/settings/renameSheet.ts` shows "Device name", "Nearby devices see this name.",  
the name selected in a text field (32 characters at most), three suggestions and **More**.  
The suggestions come from `suggestDeviceNames` in `src/core/deviceInfo.ts` and never repeat the current name;  
More shows three others in the same buttons, so it keeps the focus. A suggestion fills the field.  
**Save** trims the name and renames through `client.renameAsync`, which also tells the peer, then toasts "Name saved.".  
An empty name says "Enter a name.", and Cancel, Escape or an unchanged name close the sheet without renaming.

### PIN sheet (SP-09)

`openPinSheet` in `src/app/settings/pinSheet.ts` opens from the Settings row, and Home can open the same sheet.  
It shows "Set a PIN" or "Change your PIN", an empty field for 4 to 8 digits (`settings/pinInput.ts`: a numeric keypad,  
digits only), **Save** and, once a PIN is set, **Remove PIN**. Both go through `client.configureAsync({ pin })`.  
The `pin` setting has its own descriptor kind, `pin`: `normalizeSettings` drops spaces, takes 4 to 8 ASCII digits  
or `null` for none, and keeps the PIN before for anything else ("Use 4 to 8 digits.").  
The PIN never shows again once saved, is never sent to the peer, and `core/redact.ts` hides `pin` and `proof`  
in every log entry and in the settings of a log export, so the log says only "PIN set" or "PIN removed".

### Default names (DN-01)

A new device is named with an adjective and a Greek hero or god, e.g. "Swift Perseus" (`defaultDeviceName`),  
all public-domain myth: Swift, Brave, Bold, Calm, Bright, Noble, Clever, Mighty, Quick, Silent, Golden or Lucky,  
with Perseus, Achilles, Atalanta, Odysseus, Hector, Orion, Theseus, Hippolyta, Jason, Ajax, Penelope, Castor, Pollux,  
Icarus, Medea, Hercules, Zeus, Hera, Poseidon, Athena, Apollo, Artemis, Hermes, Ares, Aphrodite, Hephaestus,  
Demeter, Dionysus, Hestia, Persephone, Hades, Helios, Selene, Eos, Iris or Nike.  
The platform is not part of the name: `platform.devicePlatform()` sends it as its own field (DN-07).  
A name already saved on a device stays as it is,  
and two peers with the same name still show the last 4 characters of the device ID (DN-03).

## Settings (table 16.2)

`SETTING_DESCRIPTORS` in `src/core/settings.ts` lists every setting with its label, range and when a change takes effect,  
`BASE_DEFAULTS` holds the defaults (with `platform.settingDefaults()` for the device name),  
and `normalizeSettings` clamps values and keeps **Lost after** longer than **Weak after**.  
Only `BASIC_SETTINGS` appear in the Settings sheet; every other row is changed in code,  
by its default or through `client.configureAsync`.

| Where | Setting | Default | Allowed | Takes effect |
| --- | --- | --- | --- | --- |
| Settings sheet | Device name | An adjective and a Greek hero or god, e.g. "Swift Perseus" | 1–32 characters | Now (sent to the peer) |
| Settings sheet | Ask before receiving | On | On / Off | Next file |
| Settings sheet | Find nearby devices | On | On / Off | Now (starts or stops [nearby discovery](Nearby.md); needs internet, uses public servers) |
| Code: transfer | Batch (page) size | 1 MiB | 256 KiB, 512 KiB, 1, 2, 4 or 8 MiB | Next file |
| Code: transfer | Chunk size | 64 KiB | 16, 32 or 64 KiB | Next file |
| Code: transfer | Concurrent files | Auto | Auto, 1–4 | When a slot frees |
| Code: transfer | Send thumbnails first | On | On / Off | Next batch |
| Code: transfer | Max buffered | 4 MiB | 1–16 MiB | Now |
| Code: timeouts | Ping interval | 2 s | 1–10 s | Now |
| Code: timeouts | Weak after | 6 s | 3–30 s | Now |
| Code: timeouts | Lost after | 10 s | 5–60 s, longer than Weak after | Now |
| Code: timeouts | Gathering cap | 3 s | 1–10 s | Next pairing |
| Code: timeouts | Code expiry | 5 min | 1–30 min | Next pairing |
| Code: timeouts | Connect timeout | 15 s | 5–60 s | Next pairing |
| Code: timeouts | Offer reply timeout | 15 s | 5–60 s | Next file |
| Code: timeouts | Page ack timeout | 10 s | 2–60 s | Now |
| Code: timeouts | Page resend tries | 3 | 1–10 | Now |
| Code: storage & history | Keep partial files | 7 days | 1–90 days | Now |
| Code: storage & history | Keep history | 7 days | 7–365 days | Now |
| Code: storage & history | History per device | 1,000 | 100–10,000 | Now |
| Code: debug logging | Debug logging | Off (on for a `?debug=1` page) | On / Off | Now |
| Code: debug logging | Minimum level | debug | debug, info, warn, error | Now |
| Code: debug logging | Category levels | None (every category uses the minimum level) | One level or Inherit per category | Now |
| Code: debug logging | Sinks | Memory, Console | None, Console, Memory, IndexedDB, Peer | Now |
| Code: debug logging | Log buffer size | 5,000 | 500–50,000 | Now |
| Code: debug logging | Keep previous run | 1,000 | 100–10,000 | Now |
| Code: debug logging | Stats polling interval | 1,000 ms | 500–10,000 ms | Now |
| Code: debug logging | Show peer's logs | Off | On / Off | Now |

A device that stored a value keeps it: a new default reaches only devices that never stored one.  
Picking the None sink clears the other sinks and picking another sink clears None,  
because None alone keeps nothing and None beside others is ignored (LG-04).  
With debug logging off, the logger keeps the memory sink only, at `info` for the handshake categories and `warn` for the rest (LG-11).

## This session (AP-05)

`client.configureSessionAsync` overrides batch size, chunk size, concurrent files and max buffered  
for the connected session only, stored in its session record; there is no UI for it.  
Overrides never go to the peer; running files keep their page size, and the batch size is negotiated per file (§6).

## Storage

- **Storage** (Settings): used and free space, read with `client.getStorageInfoAsync()` each time the sheet opens.  
  Whether persistent storage was granted is logged in category `device` (`persistent storage granted` or `not granted`).
- **Clear all data…** (Settings): confirm, then `client.clearAllAsync()` and the IndexedDB log sink's `clearAsync()`,  
  so the previous run goes too (DL-12), and a toast "All data cleared.". ZIPs already downloaded stay where they were saved.
- Clearing one device's session is `client.clearSessionAsync`; the Settings sheet doesn't offer it.

## Code-only tools (§16.3)

- **Device info:** the detection result is logged at start in category `device` and goes into every log export.
- **Test tools:** no UI. Each stays on until turned off, and the shell's "Test tool active" banner shows on every screen meanwhile,  
  with **Turn off**.

| Tool | Client call | What it does |
| --- | --- | --- |
| Simulate page corruption | `setTestTool('corrupt-pages', on)` | Damages outgoing pages; the receiver answers `nack` and the page is sent again (test 20) |
| Drop the ack | `setTestTool('drop-ack', on)` | Ignores page acks; the sender times out and resends without a second write (test 30) |
| Fill storage | `setTestTool('fill-storage', on)` | Storage writes fail as if the device were full, to check "Storage full" |
| Drop the connection | `dropConnectionForTest()` | Cuts the link once, as if the Wi‑Fi went away; works while connected |

## Log viewer (DL-01 to DL-05)

The viewer exists only with `?debug=1` in the address (the `#` part is reserved for pairing codes), and opens at start.  
That page also has debug logging on, without storing it: the shell routes the logger with `debugLogging: true`  
and tells the viewer through `isDebugLogging`, so it keeps every category and polls the candidate pairs.  
Only then does the pairing failure screen link to the timeline, with `showTimeline()`.  
It stays open beside the app, so a transfer can be watched.  
Opened mid-session, it shows everything already in the memory sink,  
so the handshake is there even when debug logging was off before (DL-01).

| Layout | Placement | Size | Property the shell reads |
| --- | --- | --- | --- |
| Portrait phone (and tablets in portrait under 900 px) | Bottom drawer with a drag handle | 40% of the height, 160 px to 90% | `--log-viewer-block-size` |
| Landscape phone | Right side panel over the instructions column | Half the width | `--log-viewer-inline-size` |
| Desktop | Docked right panel, resizable from its left edge | 380 px, 280 px to 70% | `--log-viewer-inline-size` |

While open, `<html>` carries `data-log-viewer="open"` and both properties are set (the unused one to `0px`),  
so the shell keeps the QR and the camera clear (DL-02, test 26).  
The drag handle also works with the arrow keys. Rotating keeps the filters, the paused state and the scroll position.  
A closed viewer leaves the page: it unsubscribes from the sink, stops its timers and clears both properties (DL-11).

Each entry is one monospace line, 12 px, scrolled sideways rather than wrapped, so long IPv6 and `.local` names stay on one line:  
time since the pairing started, category, level, the peer's name for peer entries, and the message, with `{…}` when it carries data.  
Clicking a line expands every field of the entry as coloured JSON; clicking again folds it.  
Warnings and errors have a tinted background.

The toolbar filters by category (or the whole handshake group), minimum level, file and text  
(message, data, file ID and peer name), and holds **Auto-scroll** and **Clear**.  
Scrolling up pauses auto-scroll by itself and scrolling back to the end resumes it;  
the button shows **Paused** meanwhile (DL-04). On phones the toolbar is one row that scrolls sideways.  
**Export** in the header copies or downloads the lines in view.

The panel is a region labelled "Logs" and has no `aria-live`, which would flood screen readers (DL-05).

## Batching and limits (DL-08 to DL-12)

- The memory sink keeps the newest 5,000 entries (Log buffer size); a notice says how many older ones were dropped.  
  Another notice says when debug logging is off, so only handshake steps, warnings and errors are kept.
- New entries queue up and are appended at most once per animation frame and at most 10 times a second (DL-10);  
  only the lines in view, plus ten above and below, exist in the page.
- In a second with more than 20 page lines, the page lines fold into one "+87 pages" row,  
  while the per-second summaries and everything else stay (DL-09). Clicking the row shows the pages.
- **Previous run** shows the entries the IndexedDB sink kept from the page load before this one (DL-12),  
  with the time of its last entry; Clear is off there.

## Export (DL-13, DL-14)

**Copy**, **Download .txt** and **Download .json** export the lines that pass the filters, from the live view or the previous run.  
The text has a header with the build, the export time, the service worker, the device and its capabilities,  
the settings, the active filters and the dropped count, then one line per entry with its data as compact JSON.  
The JSON has the same fields and the entries in full. Files are named `ether-logs-<YYYY-MM-DD-HHMMSS>.txt` or `.json` (PW-00);  
nothing is uploaded.

**Mask IP addresses** runs `maskIpAddresses` on every message and data field, so `192.168.1.23` becomes `192.168.1.x`;  
headers and timestamps are left as they are.  
The ICE password, whole codes and full fingerprints never reach a sink, masked or not (LG-08).

## Handshake timeline (DL-07)

The **Handshake** section at the top of the viewer shows camera permission → gathering → code shown → answer applied →  
ICE connected → DTLS connected → channels open, each with its time since the pairing started and its duration.  
It is built from log entries only, by a table of matchers on category and message text (`TIMELINE_STEPS`),  
so a missing line leaves its step out rather than breaking the timeline.  
It reads the latest pairing, which starts where `t` restarts at zero (`markOrigin`), and ignores peer entries.

| Step | Categories | Reached when the message matches | Amber when | Failed when |
| --- | --- | --- | --- | --- |
| Camera permission | `pair` | `camera permission` | it says denied, blocked, dismissed, unavailable, not asked or no camera | — |
| Gathering | `pair`, `ice` | `gathering <n> ms` (the span), `gathering complete`, `gathering capped`, `iceGatheringState complete` | the span's data has `complete: false`, or it says capped or timeout | — |
| Code shown | `pair` | `code <n> B`, `offer shown`, `answer shown`, `code shown`, `QR v<n>` | — | — |
| Reply applied | `pair` | `answer applied` (only on the device that showed the offer) | — | `answer … rejected`, `invalid` or `failed` |
| ICE connected | `ice` | `iceConnectionState connected` or `completed` | — | `iceConnectionState failed`, `ice failed` |
| DTLS connected | `dtls`; `ice` | `DTLS connected`, `connected` at the start; `connectionState connected` | — | `DTLS failed`, `fingerprint mismatch`; `connectionState failed` |
| Channels open | `dtls` | `channels open` | — | — |

The step's duration is the span's `durationMs` for gathering, and the time since the step before for the others.  
The device that scanned the offer is recognised by `offer code decoded` or `answer created`; its Reply applied step reads "On the other device".  
A step not reached while a later one was is shown as skipped.

A failure is either a step's own failure line, or a line that ends the pairing:  
`connect timeout`, `timed out`, `code expired`, `pairing failed`, or any `error` in `pair`, `ice` or `dtls`  
(the network writes `not connected after <n> ms` and `pairing failed: <reason>` at `error`).  
That marks the first step after the furthest one reached as failed, in red, with the failure message and the last state reached:  
the transport states the network attaches to its failure line (`linkState`, `signalingState`, `iceGatheringState`,  
`iceConnectionState`, `connectionState`, `dtlsState`, `sctpState`, `openChannels`), else the last state line  
(`…State <value>`, `DTLS <state>`, `SCTP <state>`), else the last step's message.  
The section's summary reads "Connected in 10.0 s", "Failed at ICE connected", "In progress" or "No pairing yet".

## Candidate pairs (DL-06)

Below the timeline, while the viewer is open and debug logging is on,  
the viewer polls `client.getDiagnosticsAsync()` every Stats polling interval, one call at a time,  
and stops when it closes or debug logging goes off (DL-11, test 24). With debug logging off (a viewer built without `?debug=1`, as in the harness) it says so instead.

The table lists each pair as local ↔ remote candidate (type, then the IP or `.local` name and port),  
its state (waiting, in-progress, succeeded, failed, frozen), whether it is nominated, round-trip time, and bytes sent and received.  
The selected pair comes first, highlighted and marked "selected"; failed pairs come last.  
`.local` names are amber and peer-reflexive candidates blue, with these notes under the table:  
"`.local` = this browser hid its IP (no camera permission)" and "peer-reflexive = address learned from the other device's checks".  
Above the table, a line gives the link state, health, round-trip time and maximum message size, and below it the busy slots and their buffers.

## Nearby log lines

[Nearby devices](Nearby.md) logs in category `nearby`, kept at `info` with debug logging off.
The public address never appears; `joined room` shows the first 8 characters of the room tag,
so two devices' logs show whether they are in the same room.

| Level | Message | When |
| --- | --- | --- |
| info | `starting`, `status <off, starting, listening or offline>`, `stopping: <reason>` | Discovery starts, changes status or stops; `stopping: page hidden` when the page hides |
| info | `page hidden; joining once it is visible`, `page visible again; rejoining` | The page hid or was shown |
| info | `this tab speaks as the device it was before the reload` | A reload kept the tab's identity |
| info | `session storage unavailable; a reload will count as a new device` | Blocked storage; data: the error |
| warn | `the stored tab identity is unreadable; making a new one`, `another tab speaks as this device (a duplicated tab); taking a new identity` | The tab took a new identity |
| warn | `rejoining the room failed; checking the address` | A page shown again could not rejoin at once |
| info | `public address from <n> of <m> STUN servers` | The STUN vote ended; data: the servers that answered and the silent ones |
| warn | `no STUN server gave a public IPv4 address (<m> asked)`, `STUN <server> refused by the browser` | No address: `offline` until a retry finds one |
| info | `joined room <8 hex>`, `public address changed; moving to the new room` | A room was joined, or the address changed |
| info | `relay <url> connected`, `relay <url> closed`, `relay <url> disconnected while offline`, `relay <url> paused`, `relay <url> resumed` | A relay connection changed |
| warn | `relay <url> could not connect`, `relay <url> no answer within 10 s`, `relay <url> silent for <n> s`, `relay <url> refused by the browser` | A relay failed; at most every 30 s per relay |
| warn | `relay <url> refused an event: <reason>`, `relay <url> closed the subscription: <reason>` | A relay answered `OK false` or `CLOSED` |
| info | `relay <url> notice: <text>` | A relay sent `NOTICE`, e.g. `rate-limited: slow down`; at most every 30 s per relay |
| debug | `relay <url> subscribed; skipped <n> stored event(s)` | `EOSE`: what the relay replayed from before is dropped |
| info | `device appeared`, `device left`, `<n> device(s) went quiet`, `a quiet device was replaced by a new one with the same name` | The list changed; data: how many devices are listed (never names) |
| info | `pairing request sent`, `received`, `accepted`, `answered declined`, `busy`, `pin-required` or `wrong-pin`, `withdrawn`, `expired`, and the outcome `accepted`, `declined`, `busy`, `pin-required`, `wrong-pin`, `no-answer` or `canceled` | A request's steps; data: `requestId`, and `hasPin` (sent with a PIN) or `isPinVerified` (received with the right PIN) |
| warn | `5 wrong PINs from one device; answering it busy`, `10 wrong PINs from nearby devices; answering all busy` | A PIN lockout started ([Nearby](Nearby.md#pin)); data: `lockoutMs`, never the PIN or who asked |
| warn | `dropped relay events: <reasons>`, `dropped nearby messages: <reasons>` | Malformed, forged, stale or flooding input; data: counts per reason; at most every 30 s |
| info | `goodbye sent`, `browser offline`, `browser online; reconnecting and checking the address`, `name, device type or PIN changed; announcing` | |
| warn | `own relay <url> out of its free allowance (its status says so)` or `(no readable answer while the internet works)` | The allowance notice was raised; data: `resetsAt` |
| info | `own relay <url> status ok; its failures were passing ones`, `own relay <url> connected again; allowance notice cleared`, `no own relay is out of its allowance` | The notice was not needed, or cleared |
| warn | `own relay <url> status error: not its allowance` | The status check answered `error` |
| info | `own relay <url> gave no status, and the internet seems down` | No notice: `offline` covers it |
| debug | `presence sent`, `presence reached no relay`, `own relay <url> status <code>` | |

## Code

| File | Holds |
| --- | --- |
| `src/core/settings.ts` | `SETTING_DESCRIPTORS`, `BASE_DEFAULTS`, `BASIC_SETTINGS`, `normalizeSettings` and migrations |
| `src/core/deviceInfo.ts` | `defaultDeviceName`, `suggestDeviceNames`, `DEVICE_PLATFORMS` and `toDevicePlatform` |
| `src/app/settings/settingsSheet.ts` | `createSettingsSheet`: the rows, applying changes, storage and Clear all data |
| `src/app/settings/renameSheet.ts` | `openRenameSheet`: the name, suggestions, More and Save |
| `src/app/settings/pinSheet.ts`, `pinInput.ts` | `openPinSheet`: Set a PIN, Save and Remove PIN; the digits-only PIN field it shares with "Enter *X*'s PIN" |
| `src/core/pin.ts` | The PIN's rules: 4 to 8 digits, `isValidPin`, `toPinDigits` |
| `src/app/shell/themeController.ts` | System, Light or Dark, stored under `ether.theme` and applied as `data-theme` |
| `src/app/logViewer/logViewer.ts` | `createLogViewer`: placement, toolbar, batching, polling, export |
| `src/app/logViewer/logList.ts` | The virtualised list and the JSON expansion |
| `src/app/logViewer/handshakeTimeline.ts` | `TIMELINE_STEPS` and `buildTimeline` |
| `src/app/logViewer/candidatePairs.ts` | Rows and summaries of the pair table |
| `src/app/logViewer/diagnosticsView.ts` | Drawing the timeline and the pair table |
| `src/app/logViewer/logFilter.ts`, `logFormat.ts`, `pageCollapse.ts`, `logExport.ts` | Filters, line text, "+N pages", export |
| `src/app/logViewer/renderScheduler.ts`, `virtualWindow.ts`, `viewerLayout.ts`, `statsPoller.ts` | Batching, the visible window, placement, polling |
| `src/app/testing/adminFakes.ts` | A fake client, platform, database sink and sample logs for the tests and the harness |

## Tests and checks

`npx vitest run src/app/settings src/app/logViewer src/app/pwa` runs the unit tests (happy-dom):  
the pure modules in detail, and the Settings sheet, the rename sheet and the log viewer end to end against the fake client.

`node scripts/checks/adminHarness.mjs` builds a page with the Settings sheet and the log viewer on the fake client  
and sample logs, and serves it at `http://127.0.0.1:5199/`. Query options: `?open=settings,viewer`,  
`?theme=system|light|dark`, `?scenario=connected|failed` and `?live=1` (40 page lines a second).  
Its stand-in shell keeps clear of the log viewer with the same rules as `_shell.scss`.
