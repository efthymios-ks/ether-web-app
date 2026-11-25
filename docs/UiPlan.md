# Ether — minimal UI plan

Make Ether's UI simpler and easier to use, in the spirit of LocalSend, **without dropping any feature**.  
This document is self-contained: requirements, decisions, the target screens, the protocol changes and the implementation phases.  
Its companion is the clickable prototype `docs/ui-prototype/index.html`.

- **Repo:** `efthymios-ks/ether-web-app`. Baseline: commit `9cc18e7`, 114 test files, 1,287 tests passing.
- **Reference app:** `localsend/localsend` (`app/lib/pages/tabs/receive_tab.dart`, `send_tab.dart`, `pages/progress_page.dart`) and LocalSend Web.
- **Status:** every decision is closed (§10) and every phase is done: P1 Settings and defaults, P2 Shell and Home, P3 Session and progress, P4 Lists, P5 History and restore, P6 PIN, P7 Sweep and P8 File icons and media previews.

---

## 1. Requirements

| # | Requirement | Phase | In prototype |
| --- | --- | --- | --- |
| R1 | Minimal UI, easier to use; LocalSend as the reference | all | ✓ |
| R2 | **Keep every existing feature**; only the UI gets simpler (§3) | all | ✓ |
| R3 | Received files leave only as a **ZIP** (unchanged) | — | ✓ |
| R4 | **No text sending** | — | ✓ |
| R5 | Use the repo's theme: SCSS tokens and component classes, no new look (§2a) | all | ✓ |
| R6 | **Nearby scan is the default** way to connect | P2 | ✓ |
| R7 | **Code pairing** (QR / copy-paste) is a small secondary option | P2 | ✓ |
| R8 | **Orbit** animation while scanning (no beacon) | P2 | ✓ |
| R9 | Logo always goes to **Home**; while connected Home shows the connected device | P2 | ✓ |
| R10 | Tap your **name** or your **PIN** on Home to change it quickly | P2 | ✓ |
| R11 | **Sidebar + pane** on wide screens and landscape phones; one column on portrait phones | P2 | ✓ |
| R12 | **Add a PIN**: digits only, numeric keypad, 4–8 digits (§5) | P6 | ✓ |
| R13 | A **correct PIN connects straight away**, with no Accept on the receiver; no PIN → Accept dialog as today | P6 | ✓ |
| R14 | **Code pairing never asks for the PIN** | P6 | ✓ |
| R15 | **Session history kept but hidden**: Restore prompt on connecting to a known device, plus a Previous sessions drawer (§6) | P5 | ✓ |
| R16 | **Start fresh clears the history on both devices** | P5 | ✓ (UI) |
| R17 | **Advanced settings not in the UI**; still centralized and configurable in code; test tools code-only (§7) | P1 | ✓ |
| R18 | **Ask before receiving on by default** | P1 | ✓ |
| R19 | Default names: **Greek heroes and gods** with an adjective; rename sheet suggests names (§8) | P1 | ✓ |
| R20 | **No localization** | — | ✓ |
| R21 | Receive dialog offers **Accept what fits** only when space is short | P3 | ✓ |
| R22 | Every control works while a transfer runs: live parts update in place, never re-created | all | ✓ |

---

## 2. Design principles

1. **One job per screen.** Home = "who am I + who's nearby". Session = "send, or see what came".
2. **Identity first.** "You are **Swift Perseus** | PIN **none**", centred, tappable.
3. **Details where they help.** Counts, bytes, speed and time left always show on the progress card, and page, speed and time left on the lines of files moving now; view options sit behind one **View & filter** button.
4. **Show exceptions, not normal states.** Sent or Not downloaded yet shows no tag; Failed, Damaged, Skipped, Paused, Not sent yet do.
5. **Whole rows are targets.** Tap a nearby device card to connect; no separate Connect button.
6. **No duplicate information.** The peer's name and health appear once, in the peer bar.
7. **Words, not jargon.** "Pair with a code", "Step 1 of 2", "Show this to the first device"; "offer/answer" stays in code only.
8. **Never replace what's under a finger.** Live updates patch in place (`syncChildren`); a tap on an element replaced between touchstart and click is lost on phones.

---

## 2a. Theme: the repo's SCSS as is

- **Tokens** from `src/app/theme/palette-light.scss` and `palette-dark.scss`: `--bg`, `--surface`, `--surface-sunken`, `--surface-raised`,
  `--text`, `--muted`, `--faint`, `--border`, `--border-strong`, `--divider`, `--accent` (blue in light, teal in dark), `--accent-soft`,
  `--accent-text`, `--ok/--warn/--fail/--info` and their `-soft`, `--ft-*` for file-type icons, `--radius` 8px, `--radius-small` 4px,
  `--shadow`, `--shadow-strong`. The theme is `data-theme="light|dark"` on `<html>`, set by `shell/themeController.ts`.
- **Existing components, same class names:** `.button`, `.button-primary`, `.button-danger`, `.button-quiet`, `.icon-button`,
  `.icon-button-small`, `.badge[data-tone]`, `.notice`, `.spinner`, `.progress-bar` + `.progress-fill` (`_base.scss`);
  `.segmented` (`_gallery.scss`); `.tabs` + `.tab` (`_transfers.scss`); dialog and `.toast` (`_dialogs.scss`).
  Card look: `1px solid var(--border)`, `var(--radius)`, `box-shadow: 0 1px 2px var(--shadow)`. Row thumbnails: 40px, `--surface-sunken`, `--radius-small`.
- **New layout classes** and where they go:

| Partial | Classes |
| --- | --- |
| `_shell.scss` | header, `.me` (identity), `.split` / `.side` / `.pane` (wide layout), `.orbit` |
| `_nearby.scss` | `.dev` (device card), `.tags`, `.empty` |
| `_pairing.scss` | `.choice` / `.tile`, `.pair`, `.qr`, `.cam`, `.step` |
| `_transfers.scss` | `.peer`, `.chip` (check code), `.picks`, `.files` / `.f` / `.total` / `.adv` (progress view) |
| `_gallery.scss` | `.tool` / `.search`, `.gh`, `.list` / `.li` / `.meta`, `.selbar`, `.grid` / `.tilebox` / `.ttag` / `.okb` |
| `_dialogs.scss` | `.sheet`, `.drawer`, `.menu`, `.kv`, `.hash` |
| `_admin.scss` → settings | `.set`, `.sw`, `.sugg` |

Photo and video thumbnails in the prototype are coloured placeholders; the app keeps its real thumbnails.

---

## 3. Feature parity: every feature, today → new

| Feature (spec ID) | Today | New |
| --- | --- | --- |
| Nearby discovery, Connect, Cancel, declined/busy/no-answer notes | "Nearby" card with Connect buttons | Device cards (tap the card); "Waiting for X to accept…" + Cancel inside the card; notes under the list |
| Asked by a nearby device | Dialog | Same dialog; skipped when this device has a PIN and the asker entered it (§5) |
| Crossing requests | Automatic | Unchanged |
| Show / Scan / Paste offer (HS-*) | Action bar on Home | "Pair with a code" screen: **Show my code**, **Scan a code**, **Paste a code** |
| Offer, reply, expiry (HS-08), Copy, Scan/Paste reply | Badges "1 · OFFER" / "2 · REPLY", two hints, "Then get the REPLY" card | "Step 1 of 2 · Scan this on the other device", QR, Copy code · "Expires in 4:59 · works once", "Step 2 of 2 · Then get its reply" [Scan reply] [Paste reply] |
| Scan screen, torch, Paste instead | Camera + actions | Same, simpler copy |
| Opened from QR (`#code`), other-tab relay (HS-06/07) | — | Unchanged |
| Connecting, failure (HS-10), expired | Screens | Same screens, restyled |
| Check code (SP-02) | Chip in the card | Same chip in the peer bar; "Check" label hides under 420 px; tap → toast |
| Health ("Good · 12 ms", Weak, Lost) | Header pill **and** card | Peer bar only |
| Connection lost / disconnected, paused count, Reconnect (HC-05/06) | Danger card | Peer bar turns red: "Connection lost · 2 paused" + **Reconnect**, which asks at once when that device is nearby or waits for it to show up + **Use a code** |
| Paired devices list, last connected, unfinished badge (§7.6) | Home "Devices" card / desktop sidebar | Hidden: Previous sessions drawer (clock icon), "Paired before" / "N unfinished" tags on nearby cards, Restore prompt on connect |
| Batch prompt (BK-03) | Prompt above the tabs | Dialog "X wants to send you N items · size · Free: …" — [Decline] [Accept]; when space is short [Decline] [Accept what fits (N)] [Accept all] |
| Ask before receiving (SP-07) | Setting, default off | Setting, **default on** |
| Unfinished files from other devices | Card above the tabs | Same card at the top of the Send tab |
| Tabs In progress / Sent / Received + ⋯ | 4 controls | Tabs **Send · Received N · Sent N** (repo `.tab`); a static accent dot on Send while moving; ⋯ moves to the peer bar |
| Pickers (§5, platform rules) | Bottom action bar | Tiles on the idle Send tab (phones: Photos & videos, Files; desktop: Files, Folder, Photos & videos) + **Send more** on the finished progress card |
| Batch card: counts, bar, meta, feed, open list, Stop, ⋯ | Collapsible card with a 4-line feed | Progress view: "Sending to X · 2 of 6", flat list (icon, "name (size)", Done / Queue / Checking… / Skipped · already on X / bar), sticky **Total progress (0:13)** card with the counts, bytes, speed and time left always shown, and **Stop**, which keeps what arrived (then **Resume** and **Done**); per-batch ⋯: Stop this batch, Resume this batch, Delete what arrived, Retry failed, Show in Sent/Received |
| Skipped, Checking…, Waiting to check | Feed + rows | Same words in the flat list |
| Needs-file rows, Pick file again | Full rows under In progress | "Needs picking again" on the Send tab with **Pick** |
| Row actions (Accept, Decline, Resume, Pause, Cancel, Delete partial, Send again, Details) | Buttons per row | Row ⋯ sheet, same action table |
| Search (accent folding, Greek) | Toolbar | Unchanged; the search field leads the toolbar |
| Filter (Type, Status), Day/Month, List/Tiles | 4 toolbar controls | One **View & filter** sheet; a dot on its icon when filters are on; a "Filtered: … Clear" line above the list |
| Select, Select day/month, Select all, Range, Shift-click, Escape | Toolbar + headers + bar | Select icon toggles the mode; "Select day/month/year" on headers while selecting; sticky bar "N selected · Select all · Range · **ZIP (N)** · Delete" |
| Download ZIP (N), Delete (N) | Selection bar | Same |
| Tiles, status tags, video length (GL-*) | Tags on most tiles | Tags only for exceptions; Downloaded = small ✓ badge; video length |
| Viewer + details (MD-07), SHA-256 | Viewer, Details | Details sheet: preview, size, dates, location (Open in Maps), camera, length, status, verification, SHA-256 Compute → Copy; Download ZIP, Send again, Delete |
| Damaged copies | Row + notice | Red status text + a note in the row ⋯ sheet |
| Clear sent / received / Reset this device, Disconnect | ⋯ by the tabs, button in the card | Peer bar ⋯: Disconnect, Clear sent…, Clear received…, Reset this device… (same confirmations, "Also cancel…" checkbox) |
| Theme toggle (UI-12) | Header button | Settings → Theme: System / Light / Dark |
| Admin panel (AP-*) | Header button | Settings sheet, everyday settings only (§7) |
| Notices (in-app browser, test tool, keep open, keep screen on, update, relay allowance, install, identity) | Banner list | One notice at a time, same priority table (`shell/banners.ts`) |
| Toasts | Many | Only outcomes not visible on screen (declined, copied, saved, cleared); no "Connected to X" or "Sending N items to X" |
| Log viewer (DL-*) | `?debug=1` and admin panel | `?debug=1` only |
| Wake lock, install, offline, service-worker updates | — | Unchanged |

---

## 4. Screens

### 4.1 Header
`[Ether logo + name]  ……  [🕘 Previous sessions] [⚙ Settings]` — no peer pill, theme button or admin button.  
The logo always goes to Home.

### 4.2 Home
1. Identity: **You are** *Swift Perseus* | **PIN** *none*. Tapping the name opens the rename sheet; tapping the PIN opens the PIN sheet.
2. **Nearby** with the orbit animation while scanning: a core dot, a thin ring and two satellites circling it, 2.4 s per turn,
   accent colour, still under reduced motion. "Tap a device to connect".
3. Device cards: icon, name, tags (platform such as Android / iPad / Windows, 🔒 PIN, Paired before, N unfinished).
4. Empty states replace the list, big and centred:
   - nobody found: a 72 px orbit, "Open Ether on another device." / "Same Wi‑Fi. It shows up here.";
   - offline: "No internet, so nearby devices can't be found." / "Pair with a code instead.";
   - setting off: "Finding nearby devices is off." + **Turn on**.
5. Footer link "⊞ Can't see it? Pair with a code" on one column; beside the sidebar the pane offers it instead (D9).
6. While connected: identity, a **Connected** card (name, Connected / Connection lost, Transferring) that opens the session,
   and "Nearby search is paused while you're connected. Disconnect to connect to another device." No code-pairing link.

### 4.3 Connect flow
Tap a card → device has a PIN: **Enter X's PIN** sheet → connected at once. No PIN: "Waiting for X to accept…" + Cancel → accepted → connected.  
Known device → **Restore** prompt (§4.6) → session.

### 4.4 Pair with a code
Menu: **Show my code** · **Scan a code** · Paste a code → offer QR (step 1) → scan or paste the reply (step 2).  
Other device: scan or paste → reply QR "Show this to the first device" → waits. No PIN on this path.

### 4.5 Session
- Peer bar: avatar, name, "● Connected · 12 ms", **Check BXWU** chip, ⋯ menu. One compact row above the tabs on every layout (D8).
- Tabs: **Send** · **Received 13** · **Sent 10**.
- Send tab, idle: picker tiles + "Files go straight to X, encrypted. Received files download as one ZIP."
- Send tab, busy: progress view (§3) + Needs picking again.
- Received / Sent: `[Search] [☑ Select] [⚙ View & filter]`, groups by day, month (the default) or year, rows or tiles.

### 4.6 Restore prompt
"Restore your session with Pixel 8?" · "Last connected Yesterday 20:07 · 13 received, 8 sent · **3 unfinished** resume."  
"Start fresh clears your history with Pixel 8 on both devices." · [Start fresh] [**Restore**]

### 4.7 Settings
Device name (Change) · PIN (Set PIN / Change / Remove) · Find nearby devices · Ask before receiving ·
Theme (System / Light / Dark) · Storage (used · free, **Clear all data…**) · version.

### 4.8 Previous sessions drawer
Right-side drawer, one row per session: platform · last connected, Nearby / N unfinished tags. Tap to reconnect,
or, when not nearby, a sheet "X isn't nearby" with **Pair with a code**. 🗑 clears that session.

### 4.9 Layouts
- **One column:** portrait screens under 900 px wide (phones, small tablets) and anything under 600 px wide.
- **Wide screens (≥ 900 px) and landscape phones (≥ 600 px wide), not connected:** a sidebar (identity + nearby, with the orbit)
  beside a pane: on Home, Pair with a code under "Or pair with a code" (D9), with no second orbit and no link to it in the sidebar;
  while pairing with a code, its steps. The sidebar replaces today's paired-devices sidebar.
- **Wide screens, connected (D8):** no sidebar. The session takes the whole width, up to about 1,600 px:
  the peer bar across the top, then the tabs with the progress view and the lists, so files get the most room.
  The logo still goes to Home, which shows the identity and the Connected card as on a phone.

---

## 5. PIN

**UX**
- Home shows `PIN none` or `PIN ••••`; tap → "Set a PIN" sheet: 4–8 digits, numeric keypad (`inputmode="numeric" pattern="[0-9]*"`),
  non-digits stripped; Remove PIN when one is set.
- Devices with a PIN show a 🔒 PIN tag. Tapping one asks **Enter X's PIN**; wrong → "Wrong PIN. Try again."
- A correct PIN connects straight away: **no Accept dialog** on the receiving device. Without a PIN, the Accept dialog stays.
- Code (QR / paste) pairing never asks for the PIN; showing and scanning codes already proves both devices are in hand.

**Protocol** (`src/discovery/nearbyMessages.ts`, `discovery.ts`, docs/Nearby.md "Messages")
- `here` gains `pin: true` when the device has a PIN, never the PIN itself.
- `request` gains `proof`: `HMAC-SHA256(key = PIN, msg = requestId + "|" + SHA-256(offer))`, base64url, inside the sealed `box` (AES-GCM, per pair).
- Receiver with a PIN: valid proof → accept without a dialog; missing or invalid → `decline` with the new reasons `pin-required` / `wrong-pin`,
  which the asker shows as "Enter X's PIN" / "Wrong PIN".
- Brute force: after 5 wrong proofs from one `nearbyId` or run, answer `busy` for 60 s, and log it redacted.
  Also after 10 from all askers together, so new identities buy no new guesses (docs/Nearby.md, PIN).

**Setting** (`src/core/settings.ts`): basic setting `pin: string | null`, 4–8 digits, never sent to the peer, redacted in logs (`core/redact.ts`).

**Tests:** message validation, accept and decline paths, lockout, settings normalisation, nearby controller UI.

---

## 6. Hidden history and the Restore prompt

Today `sessionId = computeSessionIdAsync(deviceA, deviceB)` (`src/client/hashing.ts`), so a pair always reopens the same session;
after `hello` the client reopens or creates it (`src/client/connection.ts`) and runs `sync`, which resumes transfers by itself (HC-05).

**Change**
- After `hello`, when the session already existed **and** holds files, emit `session-known { sessionId, peerName, lastConnectedAt,
  receivedCount, sentCount, unfinishedCount }` and hold this device's resume until the UI answers:
  - `client.restoreSessionAsync(sessionId)` → continue as today (`sync`, resume);
  - `client.startFreshAsync(sessionId)` → clear the session **on both devices**: this device runs `clearSessionFilesAsync(sessionId, 'all')`
    (cancels transfers in progress, like Reset this device) and sends the new control message `session-reset { sessionId }`;
    the peer clears its copy the same way, closes its Restore prompt if open, and toasts "X started fresh. Your history with it was cleared."
- The prompt shows on **both** devices. Transfers resume only when both chose Restore; Start fresh from either side wins.
- No prompt when the session holds no files, nor on a reconnect after link loss within the same page run.
- `session-reset` is a new control message in `src/client/protocol.ts`, validated like `hello` and `name`, and added to the
  control-message table in docs/Client.md. Tests: both restore; one starts fresh while
  the other's prompt is open; both start fresh at once (idempotent); reset arriving after a link loss.
- UI: the Restore prompt (§4.6) and the Previous sessions drawer (§4.8), which reads `history/sessionsStore.ts`;
  `history/sessionList.ts` becomes the drawer; the Home "Devices" card goes.

---

## 7. Advanced settings: code only

- The admin panel's **Advanced** section, **This session** overrides (AP-05), **Device info** and **Test tools** leave the UI.
- All values stay centralized in `src/core/settings.ts` (`SETTING_DESCRIPTORS`, defaults, `normalizeSettings`) and are changed in code.
  `BASIC_SETTINGS` becomes `deviceName`, `pin`, `askBeforeReceiving`, `findNearbyDevices`; the theme stays in `themeController.ts`, shown in Settings.
- Settings keeps the Storage block (used / free, Clear all data). Clearing one device's session moves to the Previous sessions drawer.
- The log viewer stays behind `?debug=1` (DL-01). Test tools have no UI.
- Remove or slim `src/app/admin/*` (`adminPanel.ts`, `sectionState.ts`, `settingField.ts`, `testTools.ts`, `deviceDetails.ts`,
  `sessionOverrides.ts`) and their tests; keep `settingsModel.ts` only if the Settings sheet uses it.
- No localization: strings stay inline English, no language picker.

---

## 8. Defaults

| Setting | Today | New | Where |
| --- | --- | --- | --- |
| Ask before receiving | Off | **On** | `BASE_DEFAULTS` in `src/core/settings.ts`; Requirements SP-07 |
| Default device name | "iPhone · Blue Otter" (platform + adjective + animal) | **"Swift Perseus"** (adjective + Greek hero or god); the platform becomes a tag | `src/core/deviceInfo.ts` (`ADJECTIVES`, `ANIMALS` → `NAMES`, `defaultDeviceName`); DN-01 |
| Platform | Inside the name | New `platform` field (Android, iPhone, iPad, Windows, Mac, Linux) in nearby `here` and in `hello`, shown as a tag | `nearbyMessages.ts`, `protocol.ts`, `deviceInfo.ts` |

**Names.** Public-domain Greek myth (superhero names are trademarks):

- heroes: Perseus, Achilles, Atalanta, Odysseus, Hector, Orion, Theseus, Hippolyta, Jason, Ajax, Penelope, Castor, Pollux, Icarus, Medea, Hercules;
- gods: Zeus, Hera, Poseidon, Athena, Apollo, Artemis, Hermes, Ares, Aphrodite, Hephaestus, Demeter, Dionysus, Hestia, Persephone, Hades, Helios, Selene, Eos, Iris, Nike;
- adjectives: Swift, Brave, Bold, Calm, Bright, Noble, Clever, Mighty, Quick, Silent, Golden, Lucky.

The rename sheet offers three suggestions and **More**. DN-03 (last 4 characters of the device ID for duplicate names) stays.

---

## 9. Implementation phases

Branch `ui/minimal` from `main`; one pull request per phase. Keep this plan in `docs/UiPlan.md` and update it in the same commit as the code.

| Phase | Scope | Main files | Tests / docs |
| --- | --- | --- | --- |
| P1 Settings and defaults | Ask before receiving on; hero and god names + platform tag; Settings sheet replaces the admin panel; test tools removed; `?debug=1` only | `core/settings.ts`, `core/deviceInfo.ts`, `app/admin/*`, `app/app.ts`, `shell/header.ts`, `styles/_admin.scss` | `settings.test.ts`, `deviceInfo.test.ts`, admin tests (rewrite), docs/AdminAndLogs.md, Requirements §11, §16 |
| P2 Shell and Home | Header; identity with rename / PIN taps; nearby as default with cards and the orbit; empty / offline / off states; "Pair with a code" screen; sidebar + pane layout | `shell/header.ts`, `shell/actionBar.ts`, `nearby/nearbySection.ts`, `pairing/pairingScreens.ts`, `pairing/qrPanel.ts`, `app.ts`, `styles/_shell.scss`, `_nearby.scss`, `_pairing.scss` | `nearby.test.ts`, `pairingFlow.test.ts`, `copyPaste.test.ts`, `app.test.ts`, `scripts/checks/appPairingCheck.mjs` (badge text, labels), docs/Screens.md Layouts, Home, Pairing |
| P3 Session and progress | Peer bar; tabs; Send tab tiles; progress view; Needs picking again; receive dialog with Accept what fits; fewer toasts | `history/sessionScreen.ts`, `history/sessionStatus.ts`, `transfers/batchCard.ts`, `progressPanel.ts`, `fileRow.ts`, `pickers.ts`, `incomingPrompts.ts`, `styles/_transfers.scss` | `batchCard.test.ts`, `fileRow.test.ts`, `sessionStatus.test.ts`, `transferTracker.test.ts`, docs/Screens.md Session |
| P4 Lists | Search + Select + View & filter sheet; exception-only statuses; tiles ✓ badge; selection bar | `gallery/filesPanel.ts`, `fileFilter.ts`, `galleryList.ts`, `galleryTile.ts`, `selectionControls.ts`, `transfers/fileStatus.ts`, `styles/_gallery.scss` | `filesPanel.test.ts`, `fileFilter.test.ts`, `fileStatus.test.ts`, `galleryLayout.test.ts` |
| P5 History and restore | Drawer; `session-known`; restore / start fresh; `session-reset` | `client/connection.ts`, `client/client.ts`, `client/clientTypes.ts`, `client/protocol.ts`, `history/sessionList.ts`, `history/sessionsStore.ts` | new `clientRestore.test.ts`, `protocol.test.ts`, `sessionsStore.test.ts`, docs/Client.md, Requirements §7.6 |
| P6 PIN | Setting and sheets; `pin` flag, proof, new decline reasons, lockout | `discovery/nearbyMessages.ts`, `discovery/discovery.ts`, `nearby/nearbyController.ts`, `nearby/nearbyPrompt.ts`, `core/settings.ts`, `core/redact.ts` | discovery tests, `nearby.test.ts`, `scripts/checks/nearbyCheck.mjs`, docs/Nearby.md, Requirements (new PIN rows) |
| P7 Sweep | Conventions, CSP, both layouts, reduced motion, 320–360 px widths, both themes | all | `npm run typecheck`, `npm test`, `npm run check:app`, `npm run check:nearby` (needs internet), docs/Screens.md |
| P8 File icons and media previews | One category per file (photos, videos, audio, documents, archives, other); its fixed icon on tiles, rows, progress lines, Details and the viewer; audio plays in Details and the viewer, video in Details too; length of audio; Type filter gains Audio and Documents (D11) | `media/fileCategory.ts`, `media/mediaKind.ts`, `media/audioMetadata.ts`, `app/fileIcon.ts`, `app/icons.ts`, `gallery/galleryTile.ts`, `galleryRow.ts`, `galleryViewer.ts`, `fileFilter.ts`, `history/fileDetails.ts`, `transfers/progressLine.ts`, `styles/_gallery.scss` | `fileCategory.test.ts`, `mediaKind.test.ts`, `audioMetadata.test.ts`, `fileIcon.test.ts`, `fileDetails.test.ts`, `galleryViewer.test.ts`, `fileFilter.test.ts`, docs/Media.md, docs/Screens.md, Requirements MD-09, MD-10, GL-08 |

Keep throughout: 44 px targets, in-place updates (§2.8), virtualised lists, keyboard and screen-reader names, safe-area insets,
`100dvh`, no layout shift during transfers.

---

## 10. Decision log

| ID | Question | Decision |
| --- | --- | --- |
| D1 | Correct PIN: connect at once, or still ask Accept? | Connect at once, no Accept |
| D2 | Does code (QR / paste) pairing ask for the PIN? | No |
| D3 | Restore prompt on which device; what does Start fresh clear? | Prompt on both; Start fresh from either side clears the history on both |
| D4 | Where do test tools go? | Code-only, no UI |
| D5 | Desktop: one column or a sidebar? | Sidebar + pane on wide screens and landscape phones; one column on portrait phones |
| D6 | Default name pool | Greek heroes and gods with an adjective |
| D7 | Receive dialog when the batch is bigger than the free space | Decline, Accept what fits (N), Accept all; only Decline, Accept when it fits. Free space = storage quota − usage from `navigator.storage.estimate()`, already exposed by the client (`batch-incoming`: free space, `fitsCount`, `spaceIsShort`; `getStorageInfoAsync`) |
| D8 | Wide layout once connected: a left column for the device, or a bar on top? | A bar on top: the peer bar runs across the full width and the tabs fill the rest. Nearby search is paused while connected, so a left third would hold little more than one card, and the goal is the largest area for files |
| D9 | What does the pane beside the sidebar show on Home? | Pair with a code under "Or pair with a code", with no second orbit; the sidebar's "Can't see it? Pair with a code" link goes in that layout (user) |
| D10 | Progress details behind an Advanced toggle? | Progress details always show; no Advanced toggle (user) |
| D11 | How do files that don't preview look, and does audio play? | File icons for files that don't preview; audio plays in Details and the viewer (user). One category per file decides its fixed icon, the same on tiles, rows, progress lines, Details and the viewer: one Documents icon for every kind of document, one for archives, one for audio, and a plain file icon for the rest. Photos keep their thumbnails; videos keep their poster and also play in Details. A format this browser can't decode or play shows its category's icon, never a broken preview. The Type filter gains Audio and Documents |
| D12 | How do Sent and Received group files by default? | By month, with Day, Month and Year to choose from in View & filter (user) |
| D13 | Does a lost or closed connection come back by itself? | No: a dropped WebRTC link needs a new pairing (HC-05). The peer bar always offers **Reconnect** while nearby search can run; it asks the device at once when it is nearby, or waits for it to show up and asks it then (user) |
| D14 | What does Stop do with what arrived? | It keeps it on both devices, so **Resume** (per file, per batch or on the Total card) or picking the file again continues from the last saved page; every resume sends that last page again. **Delete what arrived** and **Delete partial** throw it away, after asking (user) |

---

## 11. Prototype

`docs/ui-prototype/index.html` is one self-contained page with dummy data and no networking; open it in any browser.
Rotate a phone to landscape to see the sidebar layout. The dashed **Demo** button (top right) offers:

- incoming connect request; incoming batch; incoming batch too big for the free space;
- send a sample batch; connection lost / back; unfinished files from another device;
- nearby states (devices → nobody → offline); layout (sidebar when wide → always one column);
- transfer speed (slow: 5 s per file, one at a time → fast); the "update ready" notice; reset.

Demo PIN for "Pixel 8": `1234`. "Noble Orion" is the device you reach through code pairing.

Where the prototype and a later decision differ, the app follows the decision and the prototype stays as it was drawn:
a connected session takes the full width with the peer bar on top (D8); beside the sidebar the pane offers
Pair with a code, with no second orbit (D9); the progress card always shows its three detail lines,
with Stop beside them and no Advanced toggle (D10); files that don't preview show their category's icon,
and audio plays in Details and the viewer (D11);
Sent and Received group by month, with Year as a third choice (D12); a disconnected peer bar offers Reconnect,
which waits for the device to show up nearby (D13); and Stop keeps what arrived, with Resume on the card,
the batch and each file (D14).
The desktop Send tab offers Files and Folder, as Requirements §5 says,
since a desktop file dialog already shows photos and videos.

---

## 12. Getting started

```powershell
git clone https://github.com/efthymios-ks/ether-web-app
cd ether-web-app
powershell -File .\Start-Debug.ps1 -Peers 2   # two browser windows to pair with each other
npm test                                     # 1,287 tests at the baseline commit
npm run typecheck
npm run check:app                            # needs Chrome; set CHROME_PATH if it isn't found
```

Starting prompt for a new session:

> Read `docs/UiPlan.md` and `docs/ui-prototype/index.html` in efthymios-ks/ether-web-app.
> Implement the next phase not yet merged, on branch `ui/minimal`; update the tests and docs it lists,
> run `npm test` and `npm run typecheck`, and update the plan's status in the same commit.
