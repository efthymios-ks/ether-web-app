# Screens

Every screen of the main interface, what it shows in each layout, and how the three platforms differ.  
IDs such as `UI-03` refer to [Requirements](Requirements.md); the shell is in `src/app/app.ts`,  
and the screens are in `src/app/pairing`, `src/app/nearby`, `src/app/history`, `src/app/transfers`, `src/app/gallery`
and `src/app/saving`.

## Layouts

The layout follows the available size, never the device type (§13, UI plan §4.9).  
The shell is one `100dvh` grid (UI-02): the header, one notice, and the main area.  
Each screen holds its own buttons.  
Rotating only changes CSS, so no screen is rebuilt and the camera never restarts (UI-05).

The main area holds two parts side by side in the page (`src/app/app.ts`):
Home's panel (`shell/homePanel.ts`: who this device is, then the nearby devices),
which lives as long as the app, and the pane, which holds the screen of the moment.

| Layout | When | Main area |
| --- | --- | --- |
| One column | Portrait screens under 900 px wide (phones, small tablets), and anything under 600 px wide | Home is its panel; every other screen fills the area. Only the main area scrolls. |
| Sidebar and pane | Wide screens (≥ 900 px) and landscape phones (≥ 600 px wide), while not connected, on Home and while pairing with a code | Home's panel is a sidebar (`clamp(260px, 30vw, 340px)`, the surface colour, a border on its inline end) beside the pane. On Home the sidebar looks for nearby devices, with the orbit, and the pane offers the other way, "Or pair with a code" with its menu (UI plan D9); while pairing with a code, the pane holds its steps. Each scrolls on its own. |
| Connected | While connected, on any width (D8) | No sidebar: the session takes the whole width, up to about 1,600 px, and Home shows the identity and the Connected card in one centred column. |

The shell marks the layout on `[data-role="app"]`: `data-screen` names the screen, `data-split="true"` allows the sidebar
(Home or Pair with a code, while not connected), and the CSS query of the `split` mixin in `styles/_layout.scss`,
the same as `SPLIT_MEDIA` in `shell/layout.ts`, decides whether there is room for it.  
A session screen, even one whose link is down, takes the whole width as well.  
Landscape phones also put the QR or the camera beside the words of a pairing step.  
Safe-area insets pad the header, the sidebar, the pane and the main area (UI-01).  
The on-screen keyboard is measured with `visualViewport`,  
and its height pads the main area so a focused field stays visible (UI-07).  
Text sizes are in `rem`, spacing uses logical properties,  
and reduced motion turns off spinners and transitions, and stills the orbit (UI-08).  
Buttons show a hover only with a mouse (`hover: hover`), so a tap never leaves one looking hovered:  
outlined buttons get an accent border, filled ones a deeper shade with a ring and a 1 px lift.

Every dialog and sheet (`dialogs.ts`) rises from the bottom on portrait phones, above the home indicator,
and is a centred card elsewhere; Escape and the backdrop close it, and focus goes back to what opened it.  
A dialog's buttons share one row, each at least 130 px, and wrap two by two on a narrow phone.  
A dialog about a device or a PIN shows a round icon above its title: the device that asks
(the receive dialog, Asked by a nearby device, the Restore prompt) or a lock (Set a PIN, Enter *X*'s PIN).  
An action menu (the peer bar's ⋯, a batch's ⋯, a row's ⋯) has its title with a close button beside it,
then one flat 48 px row per action, its icon then its words, with a danger action in red.

Touch screens never zoom by hand.  
The viewport meta has `maximum-scale=1, user-scalable=no`, which Android honours,  
`html` has `touch-action: pan-x pan-y`, so pinch and double-tap zoom are off while scrolling still works,  
and at start-up `platform.preventTouchZoom(document)` adds the iPhone and iPad guard, because Safari ignores the meta.  
The viewer stage (`pan-y`, so it can be swiped), the tiles grid and the log viewer's drawer handle (`none`) set their own `touch-action`.  
On touch screens (`pointer: coarse`) every input, select and textarea is at least 16 px, the Settings sheet's included,  
so iOS doesn't zoom into a focused field.

### The log viewer beside the main area

The log viewer (`?debug=1` only) never covers the QR or the camera (DL-02, test 26).  
On desktop the main area shrinks by the docked log viewer (`--log-viewer-inline-size`).  
On portrait phones it shrinks by the log viewer drawer (`--log-viewer-block-size`), and the QR shrinks with it.  
On landscape phones the viewer covers the right column only, while the QR or camera stays on the left.

## Header

`[Ether logo + name] …… [🕘 Previous sessions] [⚙ Settings]` (`shell/header.ts`, UI plan §4.1):

- **Brand:** the app's own icon (`public/icons/icon.svg`, its gradient the same in both themes) and the name "Ether",
  on every layout. It always goes Home (R9), from any screen; a step of Pair with a code is left, and its code withdrawn.  
  While connected, Home shows the connected device.
- **Previous sessions:** a clock button before Settings, 44×44 px with the tooltip "Previous sessions",  
  opens the Previous sessions drawer; `aria-expanded` while it is open.
- **Settings:** a gear, 44×44 px with the tooltip "Settings", opens the Settings sheet at any time (AP-01).  
  The theme is chosen in Settings.

The peer's name and health show once, in the session's peer bar.

## Settings

A sheet (a bottom sheet on portrait phones, centred elsewhere) titled "Settings", with a close button beside the title;  
Escape and the backdrop close it too, and focus goes back to the gear. One row per setting, divided by thin lines,  
the words on the left and the control on the right (on narrow screens the control wraps under the words;
Theme, which has no second line, keeps its choices beside the word down to 320 px):

- **Device name:** the name, and **Change**, which opens the rename sheet over Settings (DN-02).
- **PIN:** "Anyone nearby can ask to connect; you accept each time." and **Set PIN** while there is none;  
  once set, "Devices must enter it to connect to you." with **Change** and **Remove** (SP-09). The PIN itself never shows.  
  Set PIN and Change are one button, which opens the PIN sheet over Settings, so focus comes back to it;  
  Remove removes the PIN at once, toasts "PIN removed." and moves focus to Set PIN.
- **Find nearby devices:** a switch, "Uses public relays to find devices on the same Wi‑Fi." The whole row toggles it.
- **Ask before receiving:** a switch, on by default, "Review each batch before it arrives." (SP-07).
- **Theme:** **System** · **Light** · **Dark** (UI-12). System, the default, follows `prefers-color-scheme`,  
  also when it changes while the page is open; the choice is stored under `ether.theme`, and any other stored value counts as System.
- **Storage:** "1.2 GB used · 21.0 GB free" and **Clear all data…**, which asks first (danger) and toasts "All data cleared."
- The version, small and faint, and a link to the bundled libraries' licences:  
  "Ether 0.1.0+a2d6bc91 · Open-source licenses", which opens `licenses.txt` in a new tab.

Switches and the theme apply at once. Every other setting is changed in code (§16.2, [Settings and logs](AdminAndLogs.md)).

**Rename sheet:** "Device name", "Nearby devices see this name.", the name selected in a text field (32 characters at most),  
three suggestions in the default style ("Swift Perseus") and **More**, which shows three others in the same buttons,  
so More keeps the focus. A suggestion fills the field. **Save** renames and toasts "Name saved.";  
an empty name says "Enter a name."; **Cancel**, Escape and an unchanged name close it without renaming.

**PIN sheet** (`openPinSheet` in `src/app/settings/pinSheet.ts`, which Home can open too): a lock above "Set a PIN",  
or "Change your PIN" once there is one, "Devices must enter it to connect to you. With a PIN, you don’t need to accept  
each request.", and an empty field with "4–8 digits" as its placeholder: large, spaced digits in the middle,  
a numeric keypad on phones (`inputmode="numeric" pattern="[0-9]*"`), and anything but digits dropped as it is typed or pasted.  
**Save** checks for 4 to 8 digits ("Use 4 to 8 digits."), saves and toasts "PIN set.";  
**Remove PIN** (danger, only when a PIN is set) toasts "PIN removed."; **Cancel**, Escape and the backdrop change nothing.

## Notices

One notice at a time under the header, from a table in `src/app/shell/banners.ts`, in this order of priority:
the first that applies and isn't dismissed shows, and the next one shows once it goes.
The same notice with the same words keeps its element, so a tap on its button is never lost to a redraw.

| Banner | Shown when | Action |
| --- | --- | --- |
| In-app browser (DD-08) | The page runs inside Instagram, Facebook and similar | Copy link |
| Test tool active (§16.3) | Any test tool is on | Turn off |
| Keep the app open until done (WL-04) | A transfer runs on a platform that suspends in the background | — |
| Keep this screen open (WL-03) | The screen should stay on, and the browser has no Wake Lock | — |
| Update ready (PW-03) | A new version is waiting | Update now, hidden while a transfer runs |
| Nearby relay allowance | Ether's own relay for nearby devices used up its free daily Cloudflare allowance, while nearby devices are on | Dismiss, until the allowance starts again |
| Install (PW-05) | Installing is possible | Install, or How? with the steps |
| Identity (DN-05) | The tab and the installed app keep separate history | Dismiss, remembered |

The wake lock is held while connected, while a transfer runs and while a QR is shown (WL-01), with no setting to turn it off;  
it is taken again when the page becomes visible (WL-02).

The nearby relay allowance banner follows the discovery's `relay-allowance` event and goes away by itself when the relay works again.  
It leads with the gist in bold, so it reads in the first line or two on a phone, and the rest wraps:

- when the relay said so: "**The nearby-devices relay has used up today’s free Cloudflare allowance.**";
- when it gives no readable answer while the internet works:  
  "**The nearby-devices relay isn’t answering. Today’s free Cloudflare allowance is probably used up.**";
- then, for both: "It starts again at 02:00 (in 5 h 12 min).
  Nearby devices still show through public relays, and the QR code always works."

The reset is the next 00:00 UTC, shown in local time, and the countdown follows the clock by the minute.  
Dismissing it stores the reset time under `ether.dismissed.relay-allowance`,  
so it stays away until then, also after a reload, and shows again after the reset if the relay is still out.

## Start-up screens

- **Not supported (§2):** when `RTCPeerConnection` or `indexedDB` is missing, one screen lists what is missing.
- **Open in another tab (§7.5, test 18):** the Web Lock `ether-connection` is taken with `ifAvailable`;  
  a second tab shows "Ether is open in another tab" with Try again.  
  A code it was opened with is passed on `BroadcastChannel('ether')`, and the screen says whether the other tab took it.  
  Without Web Locks the app carries on.
- **Could not start:** storage blocked or an upgrade in another tab, with Reload.

`?debug=1` opens the log viewer at start and turns debug logging on for that page (DL-01);  
without it there is no log viewer. The `#` part of the address is reserved for codes.

## Home

Who this device is and who is nearby (UI plan §4.2): nearby devices are the default way to connect (R6),
and pairing with a code is the small second way (R7).  
Home's panel lives as long as the app and changes in place (`shell/homePanel.ts`);
on wide screens it is the sidebar beside the pane (see Layouts).  
Its heading "Home" is for screen readers only, and takes the focus on arriving at Home.  
Paired devices are not listed here: they are in the Previous sessions drawer (§7.6),
and the nearby cards say which were paired before.

### Identity

Centred at the top: "You are **Swift Perseus** | PIN **none**" (or "PIN **••••**" once set; the PIN itself never shows).  
Each half is one button (R10): the name opens the rename sheet ("Device name: *Swift Perseus*, change it"),
and the PIN opens the Set a PIN sheet ("PIN: none, set one", or "PIN: set, change it"), the same sheets as Settings;
closing them puts the focus back on the button. A long name ends in an ellipsis.

### Nearby

Devices behind the same router, so usually on the same Wi‑Fi, that have Ether open show up on Home,  
found through public relays as [Nearby](Nearby.md) explains; pairing with one needs its yes, or its PIN.  
The code is in `src/app/nearby`: the controller, Home's section (`nearbySection.ts`) and the dialog on the device that is asked.  
This device looks while the everyday setting **Find nearby devices** is on (the default)  
and it is neither connected nor showing, scanning or answering a code.  
It stops when a session connects and looks again when the connection ends,  
and after a rename the other devices see the new name.

- **While looking**, a row "◌ **Nearby** Tap a device to connect": the orbit (R8), a core dot, a thin ring and two satellites
  circling it once every 2.4 s in the accent colour, which holds still under reduced motion,
  named "Looking for nearby devices" for screen readers; then the title and the hint, a polite live region.
- **Cards**, one per device, 8 px apart, following the devices as they come and go (`.device-card`).  
  The whole card is the target, with no separate Connect button (§2.5): its accessible name is "Connect to *Pixel 8*".
  It shows a 42 px device-type icon (phone, tablet or computer), the name on one line,
  and tags: the platform ("Android", "iPad", "Windows"; the device type when an older build sends none),
  a lock **PIN** tag when the device has a PIN, **Paired before** when a session's peer has that name,
  and **3 unfinished** (warn) with that session's unfinished files, from the shared sessions store.  
  Each device says it is still here about every 30 s; cards are updated in place (`syncChildren`), touching only what changed,  
  so focus, hover and scrolling stay put;  
  when the focused device leaves, focus moves to its neighbour, or to the line that replaced the list.
- **Instead of the list**, big and centred:
  - nobody found yet, also while starting: a 72 px orbit, "Open Ether on another device." and "Same Wi‑Fi. It shows up here.";
  - offline: "No internet, so nearby devices can’t be found." and "Pair with a code instead.";
  - the setting off: "Finding nearby devices is off.", "Turn it on, or pair with a code." and **Turn on**,
    which turns the setting on and starts looking;
  - beside Pair with a code in the sidebar, while a code shows: "Nearby search is paused while you pair with a code.", one quiet line.
- **Footer:** "⊞ Can’t see it? Pair with a code", a link-style button at the bottom of Home on one column, opens Pair with a code.
  Beside the sidebar there is no such link: the pane offers Pair with a code itself (D9).

### Asking a nearby device

A tap on a card prepares this device's code and sends it to that device alone.  
The card reads "Waiting for *Pixel 8* to accept…" with a spinner under its tags (also its accessible name),
keeps its accent border, and **Cancel** shows under it, aligned to the end, with the focus;
every other card is disabled and fades: one request at a time. The hint beside the title goes quiet meanwhile.

- **Accepted:** the reply completes the pairing as **Paste reply** does:  
  Connecting, then the session with the check code (SP-02), or the failure screen (HS-10).
- **Declined, busy or no answer:** nothing pairs, the code is withdrawn,  
  and a note under the list says why: "*Pixel 8* declined.", "*Pixel 8* is busy." (it is connected or pairing),  
  or "*Pixel 8* didn’t answer." (the request expired).  
  Focus goes back to that device's card.
- **Couldn't go out:** the code is withdrawn too, and the note says why in plain words:  
  "Nearby devices can’t be reached right now. Try again soon, or pair with a code." (not listening),  
  "*Pixel 8* is no longer nearby. Check Ether is open there, or pair with a code." (gone from the list),  
  "This device’s code couldn’t be sent. Try again, or pair with a code." (not a pairing code),  
  "The request to *Pixel 8* ended without an answer. Try again." (ended early),  
  or "Couldn’t reach *Pixel 8* through the relays. Try again, or pair with a code." (no relay took it).
- **Cancel** withdraws the request and the code, with no note.  
  Showing or scanning a code withdraws it too; opening Pair with a code alone doesn't.
- The asked device keeps its card, and its Cancel, while the request runs, even if it stops saying it is here.

**A device with a PIN** (SP-10): a tap first opens the sheet with a lock above "Enter *Calm Athena*’s PIN",  
"*Calm Athena* has a PIN. With it, you connect straight away.", the field with "PIN" as its placeholder  
(numeric keypad, digits only), **Cancel** and **Connect**. Nothing goes out until Connect:  
an empty field says "Enter the PIN.", and fewer than 4 digits "Use 4 to 8 digits.".  
Connect sends the request with the PIN's proof, and the card reads "Connecting to *Calm Athena*…";  
the right PIN connects without an Accept there. A wrong one opens the sheet again with "Wrong PIN. Try again.",  
and a device that turned out to need a PIN (it set one since its last presence) opens it with no error.  
Cancel, Escape and the backdrop send nothing. While the sheet is open this device counts as busy,  
except to the very device whose PIN is being typed: its request is taken without asking, as with crossing requests.  
Reconnect and the Previous sessions drawer go through the same sheet. Pairing with a code never asks for a PIN (D2).

When Home's panel isn't on screen as the answer comes, the note is a toast instead,
or a note on the peer bar when it is about that session's peer.

### Asked by a nearby device

A dialog over whatever screen is open: the asking device's kind as a round icon above "*Pixel 8* wants to connect",  
its platform, small and muted ("Android nearby", or "Phone nearby" from an older build),  
"Accept only if you know this device. Both screens then show the same check code.",  
then **Decline** and **Accept**, with focus on Accept.  
When a session's peer has that name, the title reads "*Pixel 8* wants to connect again",  
and a small "Paired before" badge follows the platform.

- **Accept** answers the request behind the Connecting screen, since no reply needs showing,  
  sends the reply back, and waits as the reply screen does:  
  the session with the check code, or the failure screen (HS-10).  
  A code that can't be used is explained on the screen Accept was tapped on, and the request is declined,  
  e.g. "The request from *Pixel 8* expired. Try again from *Pixel 8*."  
  So is a reply that can't go back: "The request from *Pixel 8* ended before your reply reached it.
  Try again from *Pixel 8*." or "Couldn’t send your reply to *Pixel 8*. Try again from *Pixel 8*, or pair with a code."
- **Decline**, Escape and the backdrop decline; nothing pairs.
- **With a PIN** (SP-11): a request that comes with the right PIN shows no dialog;  
  this device answers it at once behind the Connecting screen and toasts "*Pixel 8* entered your PIN.".  
  Requests without the PIN, or with a wrong one, are turned down without showing anything.
- When the asker withdraws, the dialog closes with the toast "*Pixel 8* canceled.",  
  or "The request from *Pixel 8* expired." once its time is up.
- A request that arrives while this device is connected, pairing, asking a device itself,  
  or already showing this dialog is answered busy, without asking.
- **Crossing requests:** when both devices tap each other's card or Reconnect,  
  each gets a request from the very device it is asking.  
  The two pairing codes settle it, compared as normalised codes, which both devices see alike:  
  the device whose own code sorts first goes on with its request and leaves the other one open;  
  the other withdraws its own request and takes the incoming one without a dialog,  
  since its person already asked for exactly that device, then goes on as the asked side.  
  A device whose code is still being prepared has sent nothing yet, so it is the one that takes the other's request.  
  The request left open is declined once the device's own request ends; by then the other device has withdrawn it.

### While connected

Home keeps the identity, then **Connected** with one card for the connected device:
its avatar (its kind of device from its platform, or its first letter), its name, and the tags **Connected** (ok),
or **Connection lost** (fail) once the link drops, and **Transferring** (info) while files move;
the whole card, "Open session with *Pixel 8*", opens the session.  
Under it: "Nearby search is paused while you’re connected. Disconnect to connect to another device."  
There is no nearby list and no Pair with a code link meanwhile.  
Once the link is lost, the card stays with Connection lost, and the nearby devices and the link come back under it,
since this device looks again and any device can be asked.  
Everything here is one centred column on every width (D8).

## Pair with a code

The second way to connect, for devices that don't show up nearby (R7, UI plan §4.4).  
One device shows its code, the other scans or pastes it and shows a reply, which the first device scans or pastes.  
The code says offer and answer; the screens never do: they say "your code", "a code" and "reply".  
Codes are never shown as text and never typed: they move as QR codes, or through **Copy code** and the Paste buttons  
and Ctrl+V or Cmd+V anywhere on a pairing screen or on Home (a document `paste` event, no field needed).  
The QR holds the app's address with `#code`, so the system camera can open the app with it.  
The screens are one centred column, up to 560 px (`pairing/pairingScreens.ts`), in the pane beside the sidebar on wide screens;
landscape phones put the QR or camera on the left and the words on the right.  
Every step has "‹ **Other options**" at the top, which withdraws its code and goes back to the menu
(Home's pane, when it started there beside the sidebar), and the logo goes Home from any of them.

### The menu

Beside the sidebar it is Home's pane: "Or pair with a code", the same line and choices, with no Back (D9).
Otherwise it is a screen of its own, reached from Home's "Can’t see it? Pair with a code",
from **Use a code** on a peer bar whose link is down, and from **Pair with a code** in the Previous sessions drawer.
"‹ **Back**" returns to the screen it was opened from.

- **Pair with a code**, and "For devices that don’t show up nearby. One shows a code, the other scans it and shows one back."
- Two 112 px tiles: **Show my code** (QR icon) and **Scan a code** (camera icon);  
  under them, the link-style **Paste a code**, which reads the clipboard in one tap.
- Without a camera, **Paste a code** is the second tile instead of Scan a code.

### Your code (first device)

"Step 1 of 2", the heading "Scan this on the other device", and the QR.  
The QR fills `min(width, height)` minus the room the rest of the step takes, at least 240 px,
black on white in every theme, with a 4-module quiet zone (UI-03);
its frame takes the accent colour, and the panel carries `data-kind="offer"` ("Your pairing code as a QR code").  
Under it: **Copy code** and "Expires in 4:59 · works once" (HS-08), in the warn colour for the last 30 seconds,
and "Can’t scan it? Turn up the screen brightness."  
After a thin line, on the same screen: "Step 2 of 2", "Then get its reply", **Scan reply** (primary) and **Paste reply**.  
Scan reply opens the scan screen for the reply, which can go back to the code with **Show my code again**;
the code stays the same.  
When the countdown ends, the code is withdrawn and the expired screen follows.  
While the code is prepared, the browser may ask for the camera (HS-05), and the placeholder says so:
"Preparing your code… If the browser asks for the camera, allow it: the devices find each other more easily."

### Reply (second device)

"Step 2 of 2", the heading "Show this to the first device",  
the QR with an ok-coloured frame (`data-kind="reply"`, "Your reply as a QR code"), **Copy code**,  
and "Waiting for the first device to read it…" with a spinner.  
When the page was opened from the system Camera, the platform's note is shown above (HS-06).

### Scan

"Scan the other device’s code", or "Step 2 of 2 · Scan the reply" on the first device;  
the camera view with a viewfinder (UI-04), the torch toggle where the track supports it,  
and **Paste instead** under it (HS-09), with **Show my code again** for the reply.  
Phones use the rear camera; desktops mirror whichever camera they have.  
A read code pauses the scanner and keeps the camera on until gathering is over,  
so the hook that exposes local addresses reuses it instead of opening a second capture session.

### Copy and Paste

Two computers without cameras pair by copy and paste alone (test 4).

- **Copy code** copies the bare code (the client's `code`, not its `url`)  
  with `navigator.clipboard.writeText`, and says "Copied" for two seconds.  
  When that is refused, a visually hidden field holding the code is selected and the copy command is tried,  
  so the code never shows as text;  
  when both fail, a notice says to scan the QR instead.
- **Paste a code**, **Paste reply** and **Paste instead** read the clipboard with `navigator.clipboard.readText()`  
  and go on at once when it holds the expected kind: a code shows the reply, a reply completes the pairing.  
  Spaces, dashes and lower case are fine.
- The wrong kind gets a clear line where it was pasted or scanned:
  a reply on the second device says "That’s a reply. Paste it on the first device, the one showing its code."
  (or "Scan it with the first device…" when scanned),  
  a code where a reply is expected says "That’s a code, not a reply. Scan or paste it on the other device.",  
  and other text says "That isn’t an Ether code. Copy it again and try once more."  
  An expired code says "This code expired, show a new one."  
  A code pasted on Home is explained under the nearby devices.
- When the page can't read the clipboard, the line says "Allow clipboard access, or press Ctrl+V."  
  (Cmd+V on a Mac) on desktop, and "Allow pasting when your browser asks." on phones.
- The buttons keep `data-action="copy-code"` and `data-action="paste-code"`,  
  are at least 44 px, labelled with text, and reachable with the keyboard.

### Without a camera

The camera check runs at start (`enumerateDevices`).  
Without one, Scan a code and Scan reply are left out and the Paste buttons take the lead;  
the scan screen shows Paste instead without trying the camera, with the focus on it.

### Opened from the QR, and other tabs

A page opened with `#<code>`, e.g. by the system camera reading the QR, reads the code once and clears it from the address.  
A code shows the reply at once (HS-06).  
A reply is sent on `BroadcastChannel('ether')` to the tab that holds the pending code, which completes the pairing,  
and the new tab says "Pairing continued in the other tab" (HS-07).  
When the other tab holds the Web Lock, that is the whole of the new tab's screen;  
without Web Locks it is a note over the app.  
If no tab answers within 1.5 s, a dialog says "Scan the reply from inside the app",
"… On the first device, tap Show my code again, then Scan reply or Paste reply inside Ether."  
An expired code in the address shows the expired screen; a pasted or scanned one is explained in place.

### Connecting, failure and expired

- **Connecting:** a 32 px spinner above "Connecting…", "Both devices are looking for each other on the local network.
  This takes a few seconds.", and **Cancel**, in the middle of the pane.
- **Failure (HS-10):** not connected 15 s after the reply was applied: "The devices couldn’t connect",
  "They read each other’s codes but found no way to reach each other. The usual causes:",
  then `platform.pairingFailureHints()` as cards, and with `?debug=1` a link to the handshake timeline in the log viewer.  
  Then **Show my code** (primary), **Scan a code** (or **Paste a code**) and **Done**, which goes back to where pairing started.
- **Expired (HS-08):** "This code expired, show a new one", "A code works once, and only for a short time.
  Show a new one and scan it again.", with the same buttons.

## Previous sessions

The clock button in the header opens a drawer from the inline end, full height, `min(380px, 90vw)` wide,  
titled "Previous sessions" with a Close button,  
and "Connect to one of these devices and Ether offers to restore its session."  
One card per paired device (§7.6), last connected first, from the shared sessions store:  
an avatar with its kind of device from the platform the session keeps (`peerPlatform`), or the name's first letter,  
the name (with the last 4 characters of its device ID when two peers share a name, DN-03),  
"Android · Last connected Yesterday 20:07" (or "Connected now", "Connection lost";  
the platform is left out for a peer that never sent one),  
and the tags **Nearby** while the device is listed among nearby devices and **3 unfinished**.  
With none, it says "No previous sessions."  
Cards are kept and changed in place, so presence and file events never replace one under a finger.

- **Tap a card:** the connected session opens.  
  A device listed nearby is asked as a tap on its card does on Home, and Home shows the waiting request with Cancel.  
  Otherwise a sheet says "*X* isn’t nearby",  
  "Open Ether on it on the same Wi‑Fi and it shows up on Home, or pair with a code.",  
  with Close, **See files** (its session screen) and **Pair with a code** (the menu of Pair with a code).  
  While another device is connected it says "Connected to *Y*", "Disconnect from *Y* to connect to *X*.",  
  with See files and OK.  
  Closing the sheet goes back to the drawer, focus on the card.
- **Bin** ("Clear session with *X*"): "Clear session with *X*?",  
  "Its history and unfinished files on this device go. Downloaded ZIPs keep their copies.", Cancel and Clear,  
  then the toast "Cleared *X*."; focus moves to the next card. Disabled for the connected device.  
  A session screen showing that device goes back to Home.

## Restore prompt

Connecting to a device whose session already holds files asks first, on both devices (UI plan §4.6, §6),  
over the session screen the connection opened:

- The peer's avatar above "Restore your session with *Pixel 8*?"
- "Last connected Yesterday 20:07 · 13 received, 8 sent · **3 unfinished** resume." (counts that are zero are left out)
- "Start fresh clears your history with *Pixel 8* on both devices."
- **Start fresh** and **Restore** (primary, focused).

Restore lets this device's transfers resume; they move once both devices chose Restore.  
Escape or a tap outside counts as Restore. Start fresh clears the session like Reset this device and says  
"Started fresh. History cleared on both devices.", or, with the link down,  
"Started fresh. *Pixel 8* clears its copy when you next connect."  
When the other device starts fresh first, the prompt closes with  
"*Pixel 8* started fresh. Your history with it was cleared."  
The prompt stays open when the link drops. There is no prompt when the session holds no files,  
nor on a reconnect after link loss within the same page run.

## Session

One paired device (§7.6, UI plan §4.5), reached by connecting, or from the Previous sessions drawer:
the peer bar across the top, then the tabs **Send**, **Received** and **Sent**.
On wide screens the session takes the whole width, up to about 1,600 px (UI plan D8),
so the peer bar runs across the top and the tabs, the progress view and the lists fill the width below.
Picking lives on the Send tab, and pairing again on the peer bar.

### Peer bar

One compact row on every layout (`history/sessionStatus.ts`): a 42 px avatar with the peer's kind of device
(phone, tablet or computer, from its platform; the first letter of its name when it sent none),
the name (with the last 4 characters of its device ID when two peers share a name, DN-03), one line under it,
then the chip or the actions, then **⋯**. The name is one line, middle-truncated, with the full name in its tooltip.

- **Connected:** "● Connected · 12 ms", "Weak · 42 ms" or "Lost", with a coloured dot,
  and the platform as a small tag ("iPad"); then the check code as a chip, "Check BXWU",
  with the label small and muted and the code monospace and bold (SP-02).
  Under 420 px wide "Check" and the platform tag hide, the code stays.
  A tap on the chip shows "Both screens must show BXWU. If not, disconnect." as a toast;
  the same words are its tooltip and part of its accessible name.
- **Connection lost:** the bar turns red (a red tint, a red border with a thick start edge, and a red avatar;
  the text keeps its own colour) when the link dropped without `bye` (HC-05),
  and the line reads "● Connection lost · 2 paused", every paused file in its tooltip;
  stopped files don't count, since they wait for Resume rather than for the link.
- **Disconnected:** the same red bar with "Disconnected · 2 paused", when the other device closed Ether and said `bye` (HC-06).
- **Not connected:** "Not connected · last connected Today 14:02", in the plain look.

In these three states the bar offers **Use a code**, and **Reconnect** whenever Find nearby devices is on
and nearby search can run (it has the internet, and this device isn't connected to another one).
Reconnect looks for the peer among nearby devices,
by the name it last used here or the session's peer name, taking the most recently seen when several match.
While it shows, Reconnect ("Reconnect to *Pixel 8*") is the one primary button, first,
and Use a code steps back to the outlined style; Use a code turns primary again as soon as Reconnect hides.

- **Nearby:** Reconnect asks the peer at once, as a tap on its card does on Home,
  with the PIN sheet first for a device with a PIN: a line under the name reads
  "Waiting for *Pixel 8* to accept…" with a spinner, or "Connecting to *Pixel 8*…" when its PIN went with the request,
  **Cancel** ("Cancel reconnecting to *Pixel 8*") takes Reconnect's place, and focus moves to Cancel.
  Accepted goes through Connecting to the check code, and the client's `hello` resumes this same session.
  Declined, busy, no answer and errors pair nothing and show the same notes as on Home, across the bar under its row,
  e.g. "*Pixel 8* declined."; focus goes back to Reconnect.
- **Not nearby:** while the list is up without the peer, a line under the state says
  "Not nearby right now. Open Ether on it on the same Wi‑Fi."
  Reconnect then waits for the peer: the line reads "Waiting for *Pixel 8* to show up nearby…" with a spinner,
  and Cancel takes Reconnect's place, with focus on it.
  As soon as the peer shows up nearby, the request goes out by itself, as above:
  the line turns to "Waiting for *Pixel 8* to accept…", or the PIN sheet opens for a device with a PIN
  (Cancel there sends nothing, and focus comes back to Reconnect).
  A request from the peer itself takes the wait's place and is answered as any request is.
- **The wait** belongs to the page run, not the screen: it goes on across Home and the other screens,
  and the request goes out wherever the app is. A reload forgets it.
  It ends with Cancel, once this device connects another way (a code, or another device's request),
  when the session is cleared or reset (Reset this device…, Start fresh), and when Find nearby devices is turned off
  or nearby search goes offline. There is one wait or request at a time:
  a tap on a nearby card, or Reconnect on another session, takes its place.
- **Nearby devices off or offline:** Reconnect hides, Use a code stays, and the line under the state says why
  in Home's words: "Finding nearby devices is off." or "No internet, so nearby devices can’t be found."
- **Use a code** opens Pair with a code: **Show my code**, **Scan a code** and **Paste a code**;
  its Back comes back to the session. Pairing with a code keeps a wait going until it connects.

On a bar narrower than 560 px the actions take a row of their own under the name, and ⋯ stays on the first row.
Reconnect, the waiting line, Cancel and the nearby line are kept between renders and changed in place,
only when what they show changes, so the presence each device repeats about every 30 s changes nothing on the bar.
Focus that was on the bar moves with what replaced its button: Cancel, Reconnect, then Use a code.
The chip and the buttons look small on desktop and keep a 44 px hit area on touch screens:
there the chip is the same 32 px pill, drawn inside a 44 px target.

**⋯** (More actions, 44 px) opens a menu titled with the peer's name:
**Disconnect** while connected ("Disconnect?", "Running transfers pause. Pair again later and they resume where they stopped."),
then Clear sent…, Clear received… and Reset this device… in red (see Clear session data), each with its icon,
the ones with something to clear only; with nothing to clear it says "Nothing to clear with *Pixel 8* yet."

### Receive dialog

A batch offered to this device asks in a dialog, wherever the app is (BK-03, SP-07, UI plan D7;
`transfers/incomingPrompts.ts`), for the connected session only:

- The peer's avatar above "*Pixel 8* wants to send you 24 items", then "186 MB · Free: 21 GB." with **Decline** and **Accept**.
- When the batch is bigger than the free space: "38.2 GB · Free: 21 GB. Not everything fits." with
  **Decline**, **Accept what fits (690)** and **Accept all**; when none of it fits, Decline and Accept all.
  Free space is the storage quota minus its usage (`navigator.storage.estimate()`), as the client reports it.
- Files offered one at a time under Ask before receiving get the same dialog: "*Pixel 8* wants to send you contract.pdf"
  or "… 3 files", with their size, Decline and Accept; more files arriving change its words in place.

Nothing arrives without Accept: Decline, Escape and the backdrop all decline, with the toast "Declined 24 items from *Pixel 8*."
Accept opens the session's Send tab, where the files arrive; Accept what fits says
"Receiving the 690 items that fit. The rest are skipped.", and Accept all when space is short
"Receiving all 1,240 items. Free up space before it runs out."
One dialog shows at a time, the next after it; the link ending closes it, since the answer goes over the link.

### Tabs

**Send**, **Received 13** and **Sent 10**, with arrow keys between them; the counts are every file of the list,
unfinished ones included, small and faint, and part of the tab's accessible name ("Received, 13 files").
Send carries a static accent dot while this session's files move ("Send, files moving" for screen readers).
The tabs share the whole width equally on every layout, under one line with the selected tab's accent underline.
There is no connection log on screen: the session record keeps it (`connections`), but the session screen doesn't show it.
Nothing above the tabs changes height during a transfer (the health text changes in place).

### Send

**Unfinished files from other devices** come first while connected: the client lists unfinished files of other paired devices
(the `unfinished-elsewhere` event, once per connection, and `listUnfinishedElsewhereAsync` when the tab opens).
The card reads "3 unfinished files from *iPhone · Old Fox* (12.0 MB). Send them to *Pixel 8*?",
or names the count of devices when there are several, with one line per device.
**Send to *peer*** calls `sendUnfinishedHereAsync` and reports "2 sent, 1 to pick again";
the files that must be picked again show under Needs picking again.
**Not now** hides the card until the next connection.
In the old session's history, a moved record reads "Moved", its ⋯ sheet says "Moved to *peer*", and it has no actions.

**Idle**, the tab shows the platform's pickers as tiles (§5, `createPickerTiles` in `transfers/pickers.ts`),
up to 720 px wide and centred: Photos & videos and Files on phones, Files and Folder on desktop;
under them, "Files go straight to *Pixel 8*, encrypted. Received files download as one ZIP."
While not connected the tiles are greyed out (`aria-disabled`), the line reads "Connect to *Pixel 8* again to send files.",
and a tap says "Connect to *Pixel 8* first, then pick the files."

**Busy**, the tiles give way to the progress view (`transfers/progressPanel.ts`):

- Each batch (BK-01, `transfers/batchCard.ts`), oldest first: a header "Sending to *Pixel 8*" (Receiving from,
  then Sent to or Received from once all of it has ended; a stopped batch keeps Sending to) with its count, "2 of 6",
  and "· 1 failed", "· 1 cancelled" or "· 3 stopped" after it, and **⋯** ("Batch actions"), over a flat list of its files.
  The list is virtualised: only the lines near the view are in the page, so 1,000 files don't grow it.
- **Unfinished:** unfinished files outside any batch on screen, e.g. from earlier connections, as the same lines.
- **Needs picking again:** files that must be picked again (PK-05), "IMG_2231.MOV (2.1 GB)"
  with "Pick it again to resume from page 1312 of 2048 (64%)." and a **Pick** button,
  which opens the picker; picked files resume through `resumeWithFilesAsync` (test 9). It also shows on the idle tab.
- A sticky **Total progress (0:13)** card at the bottom of the view: the time since the batches started,
  the percent of bytes and one bar over the batches still moving, then three lines that always show (UI plan D10):
  "12 of 24 done · 2 skipped · 3 downloaded · 1 failed · 1 cancelled · 2 stopped" (the counts that apply),
  "3.0 MB of 4.0 MB · 1.0 MB/s", and "1 s left", or "Estimating time left…" before the first rate,
  or "Waiting for the connection…" while the link is down.
  The buttons sit beside the three lines, centred on them and aligned right;
  on a narrow screen they wrap under the lines. Its one button while files move is **Stop**,
  which asks first, "Stop sending?" (or "Stop receiving?", "Stop all transfers?"),
  "Finished files stay. Files still moving stop here and on *Pixel 8*; what arrived is kept, so you can resume them later.",
  with Keep going and Stop (not in the danger colour: nothing is lost), then stops every batch still moving,
  keeping what arrived on both devices (TR-12).
  Once nothing moves and some files are stopped, the card reads **Stopped (0:13)**, the time frozen at the Stop,
  with its percent and the bar in the warn colour where it stopped, the counts ("1 of 3 done · 2 stopped"), the bytes,
  and "What arrived is kept. Resume continues from there." (or "… Connect to *Pixel 8* again to resume." while not connected),
  and **Resume** (only while connected), which resumes every stopped batch on both devices, and **Done**.
  Once everything has ended the card reads **Finished (0:42)** with a full green bar, the counts and bytes,
  **Send more** and **Done**.
  The card sticks above a phone's home indicator. Screen readers hear "Finished." or "Stopped." with the counts
  when a transfer seen moving here ends or stops, never every percent on the way.

A batch stays on the tab from the moment this page sees it run until Done or Send more, also after leaving the session
and coming back (the tracker remembers it); both take the batches that don't move away, stopped ones too,
and bring the tiles back, focus on the first.
A stopped batch also shows after a reload, until Done, so it can be resumed from here; a resumed one comes back.
A batch that finished before this page run doesn't show, and a batch waiting for this device's answer shows once accepted.
Received files are downloaded from Received (Select, then ZIP (N)), never from here.

A batch's ⋯ is a menu that holds **Stop this batch** while it moves ("Stop this batch?",
"2 files that haven’t finished stop here and on *Pixel 8*. What arrived is kept, so you can resume them later.",
Keep going and Stop), **Resume this batch** while some of its files are stopped and the device is connected,
**Retry failed** (BK-07, sending with failures, while connected),
**Show in Received** or **Show in Sent**, which opens that tab filtered to the batch ("Filtered: This batch"),
and last, in red while files haven't finished, **Delete what arrived** ("Delete what arrived?",
"2 files that haven’t finished stop, and what arrived of them is deleted here and on *Pixel 8*. Finished files stay.",
Keep and Delete), which cancels them on both devices.

### Progress lines

Each file of the progress view is one 56 px line (`transfers/progressLine.ts`), LocalSend-plain:
a 40 px thumbnail or the file's category icon (File icons, below), "name (size)" on one line with the name truncated in the middle
and the size always shown (UI-09),
and under it, on every width, the file's state in words and colour, never colour alone:

| State | Words |
| --- | --- |
| Done | Done (ok), or Damaged (fail) for a received copy that no longer matches its hash |
| Waiting | Queue, with "· Location included" on a queued file that carries GPS (MD-08); "Resuming from 64%" on one with pages already saved (after a Stop, or picked again); Waiting for you to accept |
| Checking | Waiting to check; Checking… with a small spinner (accent) |
| Skipped | Skipped · already on *peer* (faint) |
| Moving | its own bar, a `role="progressbar"` with `aria-valuenow`, and its percent |
| Exceptions | Paused, Paused by *peer*, Paused: connection lost or storage full, Stopped (warn); Needs picking again (warn); Failed (fail); Cancelled, Declined by *peer*, No space on *peer* (faint) |

The bar is fed by live progress events, redrawn at most 10 times a second (TR-10), and never goes backwards after a resume:
a line keeps the furthest it has shown for that file, and only a real restart (`restarted`, `data-lost`) starts it over.
A moving line always adds page X of Y, speed and time left after its percent; only moving lines do, so the list stays calm.
Lines read their own session's progress only, and every part changes in place, so a line is never replaced under a finger;
only files new to a batch redraw its list.
A received photo's thumbnail made after its last change (this device makes one once the file is whole,
when the sender sent none) still replaces the icon on its line.

The whole line is one button: its accessible name is the whole name with its folder, the size, the state and "Actions",
and its tooltip the whole name with its folder. A tap opens the file's actions as the row ⋯ sheet (`gallery/rowMenu.ts`),
from the same table as the Sent and Received rows (`rowActionsFor` in `transfers/fileRow.ts`):
Accept, Decline, Pick file again, Resume, Pause, Cancel, Send again and Details, as the state allows,
then Delete and Delete partial last; the sheet shows the file's note above them, e.g. why it failed,
or for a stopped file "Stopped at page 1312 of 2048 (64%). What arrived is kept; Resume continues from there.".
A stopped file offers Resume (while connected), which resumes it on both devices, and Delete partial,
or Cancel when nothing of it arrived yet.
Cancel asks once, "Stop sending?" or "Stop receiving?", and what arrived of the file is deleted on both devices (TR-09);
Delete partial asks "Delete the partial file?" and deletes what arrived of a file that isn't moving, on both devices,
on the sending side as well as the receiving one.
Nothing asks whether to keep a partial file, also when the other device cancels it.

### Sent and Received

One session's files of one direction, newest first, across all its batches, including the ones still moving.  
The toolbar is `[Search] [☑ Select] [⚙ View & filter]`: the search field leads and takes the room left,  
and the two 44 px icon buttons follow, named "Select" and "View and filter" for screen readers, with tooltips.

**View & filter** opens a sheet (`gallery/viewSheet.ts`), a bottom sheet on portrait phones and a dialog elsewhere:

- **Group by:** Day | Month | Year. Day headers ("Today", "Yesterday", "Mon 23 Nov 2026"), month headers ("November 2026")  
  or year headers ("2026"), each with its count.  
  The choice is remembered on this device under `ether.files.groupBy` (Month by default).
- **Show as:** List | Tiles. List shows rows (`gallery/galleryList.ts`); Tiles shows the thumbnail grid.  
  The choice is remembered under `ether.files.view` (List by default).  
  Both fall back to the default when storage is blocked.
- **Type:** Photos, Videos, Audio, Documents, Other files, by the file's category, the one its icon shows;  
  archives count as Other files.
- **Status:** Not downloaded, Downloaded, Failed in Received; Sent, Not sent yet, Failed in Sent.  
  A damaged stored copy counts as Failed.

Group by and Show as are segmented controls with `aria-pressed` that span the sheet, each choice an equal part;
the boxes are rows of at least 44 px.  
Within Type or Status the boxes add up, across them they narrow, and nothing checked shows everything; there is no "All".  
Every change applies at once behind the sheet.  
**Clear filters** unchecks the boxes, and **Done**, ×, Escape or a tap outside close it,  
with focus back on View & filter.  
While any box is checked, View & filter carries a dot and says "View and filter, 2 filters on",  
and a line above the list reads "Filtered: Photos · Failed" with **Clear**.  
A batch's Show in Received or Show in Sent (in its ⋯ on the Send tab) shows "Filtered: This batch", and Clear shows every batch again.  
Filtering runs over the loaded rows, so the lists stay virtualised;  
Select all and Select day, month or year act on the filtered view only.  
The filter belongs to the session's screen and survives rotation.

Search, filter and selection work the same in every combination and carry over when switching,  
and everything survives rotation.  
The lists keep the reader's place: when files are added or regrouped above the first one in view  
(records appearing while a batch is sent or received, a day, month or year growing), and when switching view or grouping  
or turning the phone, that file stays at the same spot on screen;  
files added below it move nothing, and nothing moves while the list's own top is still in view.

Statuses show only for exceptions, in rows and tiles alike (`exceptionStatus` in `transfers/fileStatus.ts`):  
the plain end of a transfer, Sent in Sent and Not downloaded yet in Received, says nothing,  
while Failed, Damaged, "Skipped · already on *peer*", Paused, Not sent yet, Deleted from app and the like do.  
Downloaded is a ✓: "✓ Downloaded" on a row, a small ✓ badge on a tile.  
Every row's and tile's accessible name still carries its full status, plain or not.

### File icons

Every file has a category (`fileCategoryOf` in `media/fileCategory.ts`, see [Media](Media.md#file-categories-and-icons)):  
photos, videos, audio, documents, archives and other files.  
Files without a thumbnail show their category's fixed icon, the same on tiles, list rows, progress lines, Details and the viewer (GL-08):  
a music note for audio, one page with lines for every kind of document (PDF, Word, Excel, PowerPoint, OpenDocument, text, Markdown, CSV, RTF…),  
a box for archives, and a plain page for anything else.  
Photos and videos show their thumbnail, and their photo or video icon until it arrives.  
Each icon takes its category's file-type colour from the theme (`--ft-audio`, `--ft-word` for documents, `--ft-archive`…), in both themes.  
A thumbnail this browser can't draw (an `<img>` error) gives the icon back, so nothing ever shows broken.

### List rows

Each group's rows form one card with hairline dividers between them.  
Each row is 56 px high (`LIST_ROW_HEIGHT` in `gallery/galleryRow.ts`, also the virtualised height):  
a 40 px thumbnail or the file's category icon, the name on one line truncated in the middle (UI-09),  
and one small meta line, size · date, then the exception, if any, in its colour; a damaged copy reads "Damaged" in red.  
A moving file shows its status, its own bar and its percent instead (the bar never goes backwards after a resume).  
The whole row is one button: a finished file opens its Details, an unfinished one its actions;  
its full name, meta and status are its accessible name, with what a tap does.  
The single **⋯** ("More actions: *name*") opens the row's actions as a sheet (`gallery/rowMenu.ts`)  
with the file's name as its title and the row's note above the actions, e.g. a damaged copy.  
The actions come from the same table as the progress view's lines (`rowActionsFor` in `transfers/fileRow.ts`):  
Download ZIP for that one file, Accept, Decline, Resume, Pause, Cancel, Send again and Details, as the state allows,  
then Delete and Delete partial last, in the danger colour.  
The sheet closes before an action runs, so its confirmation opens over the list.  
A thumbnail that becomes ready later replaces the icon, and every part of a row updates in place.

### Tiles

A virtualised grid of thumbnails (GL-01): only the rows on screen and one screen above and below exist;  
columns follow the width with cells of at least 80 px, and rotating keeps the same item at the top.  
Object URLs of thumbnails are revoked when their row leaves the screen (GL-02).  
Every tile has the theme's raised surface and border, so a file without a thumbnail shows its category's icon  
large and centred on a tile, 40% of its width up to 64 px.  
A moving file shows its ring and its percent as its tag (GL-04), with its icon shrunk to fit inside the ring.  
Along the bottom of a tile sit its tag and, for a video or a song, its length.  
The tag shows only an exception, in the List's words and colours: Failed, Damaged, Not sent yet,  
"Skipped · already on *peer*", Paused, Deleted from app and so on.  
It is a nearly opaque pill, so it reads over a photo as well as over the file icon,  
and a status too long for the tile ends in an ellipsis inside it.  
A downloaded file has a small ✓ badge in its top corner instead.  
There is no legend: every tile's accessible name and tooltip are its name and its full status, e.g. "IMG_2231.JPG, Sent".  
Tiles update in place, as List rows do (`gallery/galleryTile.ts`): a ring moves on and becomes the finished tile,  
the badges keep their elements and change only their text, and a thumbnail loads once,  
without the grid being drawn again; only files new to the tab reload it, at most twice a second.  
A tap opens what a row's tap opens: a finished file's Details, an unfinished one's actions.

The viewer previews one item at a time with its neighbours loaded, swipe and arrow keys (GL-06);  
the preview in a file's Details opens it at that file.  
Photos show full size, videos play with the browser's controls,  
and audio plays with an `<audio controls>` player under its icon; nothing plays until tapped.  
It never opens a file by itself (SP-06).  
Everything else shows its category's icon with the reason (RX-06):  
"There’s no preview for this kind of file." for documents, archives and other files,  
"This browser can’t show this format." or "This browser can’t play this format." where this browser can't decode it,  
also when a picture or a player fails after all,  
and "Only the thumbnail is kept for this item." or "Only the details are kept for this item." for sent files and deleted copies.  
Details: name, date taken with its time zone, location with an Open in Maps link opened only on tap (MD-07),  
camera, size, length, tags, Ether's page verification and the SHA-256 row.  
Actions: **Download ZIP** for the one file, and Delete.

### Selection

People send many batches, then pick what to download themselves; the app never decides.  
The **Select** icon turns selection mode on and off, pressed while on (GL-03),  
and everything that selects also unselects (`gallery/selectionControls.ts` over one selection model):

- In List every row gets a 44 px checkbox ("Select *name*") and a picked row is tinted;  
  tapping a row or a tile picks it instead of opening it, and the row's ⋯ steps aside.
- While selecting, each header offers **Select day** or **Select month**, which selects the rest of a partly selected group  
  and reads **Unselect day** or **Unselect month** once all of it is selected.
- A bar sticks to the bottom of the view: "N selected · **Select all** · **Range** · **ZIP (N)** · Delete".  
  Select all reads **Unselect all** once everything the search and the filter show is selected.  
  ZIP (N) and Delete (a trash icon in the danger colour) are on the Received side only;  
  screen readers hear "Download ZIP (N)" and "Delete (N)".
- **Range** (tap the first and the last; a toast says so) and Shift-click give the whole range the first item's new state,  
  so a range can unselect too.
- Escape clears the selection, and a second Escape leaves selecting; the Select icon leaves at once.
- Accessible names say the action, e.g. "Unselect month: November 2026" or "Select all 120 items".
- The selection belongs to the session's screen and survives rotation.

**ZIP (N)** downloads one ZIP of the picked files with the session.  
**Delete** asks "Delete 12 received files (340 MB) from the app?" with "Downloaded ZIPs keep their copies."  
and then deletes them in one call, `deleteReceivedManyAsync(sessionId, fileIds)`.

### Search

The search field leads the toolbar (`gallery/fileSearch.ts`): a `type="search"` field named "Search files",  
with the placeholder "Search", a search icon, and an × ("Clear search") only while it has text.  
It looks in each file's name and folder path, whatever the case and the accents.  
Greek loses its tonos and dialytika and reads final ς as σ, so "αθηναι" finds "Αθηναίισσα.mp3" and "ΣΟΥ" finds "σου",  
while "remb" finds nothing in Greek.  
Several words must all appear, in any order.

The list follows once typing pauses for 150 ms, in place and keeping the reader's place, and the field keeps focus.  
While a search is typed the panel keeps its height, so a shorter list never pulls the field from under the finger.  
The search narrows the type and status filters further, in both views and either grouping,  
and Select all, Select day, month or year, ZIP (N) and Delete act on what it shows.  
With nothing to show, the note reads "No files match “*text*”." with **Clear search**;  
when the filters are part of the reason (they hide what the search finds, or show nothing themselves),  
it reads "No files match “*text*” with these filters."  
with **Clear search** and **Clear filters**.  
Without a search, filters that hide everything read "No files match these filters."  
Escape or the × clears the search, and **Clear filters** in the sheet leaves it alone.  
Each tab has its own search, which is never stored, so a reload starts without one.

### Skipped files

A re-sent file that the other device already has (same name and content, from any folder) is checked by its full hash and not sent again.
The files are checked one at a time: those waiting for their turn carry the note `check-waiting` and show "Waiting to check";
the one being checked carries the note `checking` and shows "Checking…" with a spinner;
then it ends `done` with the note `already-on-peer` and no bytes sent,
and shows "Skipped · already on *peer*" in the progress view and the lists.
The Total progress card counts these apart, e.g. "12 of 24 done · 10 skipped".
Identical files in different folders are separate files and are both shown.

### No state across sessions

Everything a session screen shows is keyed by session, and by direction and file below that,  
so two paired devices never share state, even for the same file ID:  
file records, progress, batch progress, errors, incoming prompts, rows, thumbnails and the selection.  
Every client call about a file passes a `FileRef` (`sessionId`, `fileId`, `direction`);  
ZIPs, saved marks and bulk deletes take the session first (`buildZipAsync(sessionId, fileIds)`), one session per call.  
Peer names in rows and dialogs come from the record's own session, never from whichever device is connected.  
When the link ends, rates and unanswered batch prompts are dropped;  
a new connection starts without the last one's health, prompts or rates,  
and only the connected session's files count as a running transfer.

### Clear session data

The peer bar's **⋯** opens **Clear sent…**, **Clear received…** and **Reset this device…**, after Disconnect while connected;
items with nothing to clear are left out, and with nothing at all the menu says so.
Each confirmation is worded from `getClearSummaryAsync(sessionId, scope)`,
e.g. "Clear 120 received files (1.2 GB)?" with "8 haven't been downloaded yet. Downloaded ZIPs keep their copies."
Clear sent and Clear received offer an unchecked "Also cancel and clear the 3 transfers in progress".
Reset this device clears sent and received files and always cancels transfers in progress,
and says "*peer* stays paired; you can send again right away."
The confirm button is a danger button (Clear or Reset).
After `clearSessionFilesAsync` a toast says "Cleared 120 files."
The `session-cleared` event rebuilds that session's tabs, so lists, tiles, batches, progress and selection start over,
the tracker forgets the cleared records, and the receive dialog and the Previous sessions drawer reload;
other sessions are untouched.

### File details

Details is a sheet with the file's name as its title (`history/fileDetails.ts`, MD-07), opened by a finished row or tile,  
or by Details in a row's ⋯:

- a preview: a photo's or a video's thumbnail, else the file's category icon (File icons).  
  For photos, videos and audio a tap opens the full-size viewer at that file; other files' previews are a picture only.  
  A received video or song that this browser plays (`canPreview`, `canPlayType`) also has a round **Play** button  
  ("Play *name*"), in the middle of a video's poster or under a song's icon.  
  Play reads the stored file then, not before, and plays it in place with the browser's controls:  
  a `<video>` over the whole preview with the thumbnail as its poster, or an `<audio controls>` under the icon.  
  A player that fails gives way to the icon with "This browser can’t play this format.",  
  and a damaged copy says so in red.  
  Closing the sheet stops it and lets go of the file;
- size (with the pixel size when known), date received or sent,  
  date taken with its time zone ("file date" when that's all there is),  
  location as coordinates with **Open in Maps**, opened only on a tap, camera and lens, length, tags, folder and type;
- the status in its colour, Ether's own page verification ("Every page matched (5d2c8e7f…)"),  
  or "Stored copy is damaged. Ask *peer* to send it again." in red;
- a **SHA-256** row. The SHA-256 is computed only on **Compute** (`computeSha256Async`), with a progress bar and Cancel,  
  then shown in monospace with **Copy** and "Compare with Get-FileHash (Windows) or shasum -a 256 (Mac)."  
  A value the client already knows (`FileRecord.sha256`) shows at once.

Its actions are **Download ZIP** (a received copy that is stored and not damaged), **Send again** (a sent file, while connected)  
and **Delete** (a received copy still in the app), each closing the sheet before it runs.

### Damaged copies

When a stored copy no longer matches its hash (`verify-failed`, or the note `damaged`),
its row and its line say "Damaged" in red,
the row's ⋯ sheet says "The stored copy of *name* is damaged. Ask *peer* to send it again.",
and nothing is downloaded from it.

### Picking files

The Send tab's tiles hold the platform's pickers when connected (§5); there are no picking tips on any device.
Folders picked on desktop keep their relative paths (PK-03).
Files arrive only through the pickers: there is no drag and drop.

## Saving

Received files leave the app only as a ZIP, because the ZIP carries each file's modified date as sent,  
and for photos and videos the date taken as the created date, which some unzip tools restore (SV-04).  
They always land in the app's storage first, because resume needs the pages.

- **ZIP (N)** ("Download ZIP (N)" for screen readers) sits in Received's selection bar, for files picked across batches;  
  **Download ZIP** is also in a file's Details, in the viewer and in a row's ⋯ for one file.  
  A damaged stored copy is never put in a ZIP, so selecting it doesn't count it.  
  It calls `buildZipAsync(sessionId, fileIds)`, downloads `<peer name>-<YYYY-MM-DD HH.mm>.zip` (made safe for every file system),  
  and then marks the files saved with `markSavedAsync(sessionId, fileIds)`.
- Nothing downloads by itself, on any platform: a ZIP leaves only on a tap, and nothing pushes a download per batch.  
  Received files wait in Received, whatever batch they came in, including a file whose batch this device doesn't know.
- Nothing is deleted by itself either: downloading a ZIP keeps the app's copy,  
  and files leave only through the selection's Delete, a row's or a file's Delete, or Clear session data.
- There is no download hint and no unzip help: the browser's own download UI takes over.

## Platforms

| | Desktop | Android | iPhone and iPad |
| --- | --- | --- | --- |
| Pickers (tiles on the Send tab) | Files, Folder (where supported) | Photos & videos, Files | Photos & videos, Files |
| Camera | Any camera, mirrored preview | Rear camera | Rear camera |
| Without a camera | Show my code and Paste a code; Paste reply | Same | Same |
| Paste hint | Allow clipboard access, or press Ctrl+V (Cmd+V on a Mac) | Allow pasting when your browser asks | Allow pasting when your browser asks |
| Received files | Select in Received, then ZIP (N) or Delete; never by itself | Same | Same |
| Sent and Received | List or Tiles, by day, month or year, set in View & filter | Same | Same |
| Manual zoom | Browser zoom as usual | Off: viewport meta and `touch-action` | Off: gesture guard and `touch-action`; fields at least 16 px |
| Open in Maps | OpenStreetMap | `geo:` link | Apple Maps |
| Background | — | — | "Keep the app open until done" during transfers |
| Install | Install button where the browser offers it | Install button | Share → Add to Home Screen steps |
| Notes | Firewall and local network hints on failure | Local network permission hint on failure | System Camera opens Safari; Safari and Home Screen app keep separate history; Safari may delete storage after 7 days |
| In-app browser | Open in your browser | Tap ⋮ → Open in Chrome | Tap ⋯ → Open in Safari |
