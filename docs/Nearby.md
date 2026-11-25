# Nearby devices

`src/discovery` lists the devices on the same network and pairs with one only when it accepts,  
or when the asker enters its PIN (see PIN), so two devices can pair without scanning a QR code.  
It is the **Find nearby devices** setting, on by default, and it needs the internet:  
it asks public STUN servers for the public IPv4 address and passes small encrypted messages through relays.  
Without the internet, or with the setting off, the app talks to no server and pairing is by QR code or by copy and paste.

Pairing itself does not change. Discovery only carries the two pairing codes that a QR code would carry,  
so the devices then connect directly on the Wi‑Fi and show the same check code (SP-02).  
Codes keep local addresses only, and the pairing connection keeps `iceServers: []` (HS-01):  
STUN is used for nothing but learning the public address.

The contract is `discoveryTypes.ts`; `createBrowserDiscovery({ logger })` in `browserDiscovery.ts` wires it to the browser,  
and `createDiscovery(options)` in `discovery.ts` holds the logic, with every browser dependency injected.

## How it works

```mermaid
sequenceDiagram
    participant A as Device A
    participant S as STUN servers
    participant R as Relays
    participant B as Device B
    A->>S: Binding requests, to every server at once
    S-->>A: The public IPv4 address (most servers agree)
    A->>R: Subscribe: kind 25050, #x = room tag
    A->>R: "here", joined (sealed with the room key)
    R-->>B: "here"
    B->>R: "here" again 0.5–2.5 s later, as a greeting
    R-->>A: "here"
    Note over A,B: Each lists the other
    A->>R: request for B: the offer code (sealed for B only)
    R-->>B: request
    B->>B: The user accepts; the network makes the answer code
    B->>R: accept for A: the answer code (sealed for A only)
    R-->>A: accept
    A->>B: The answer is applied: ICE and DTLS straight over the Wi‑Fi, check code on both screens
```

1. **The public address.** `findPublicAddressAsync` (`stunPool.ts`) opens one throwaway `RTCPeerConnection` per STUN server,  
   each with a data channel so it gathers, and reads the server-reflexive (`srflx`) IPv4 candidates.  
   It resolves as soon as no missing answer could change the winner (two of four servers agreeing is enough),  
   or after 5 s with whatever it has, closes every connection, and logs which servers answered.  
   IPv6 addresses are left out: each device has its own, so they can't group a home.  
   The address is checked again every 5 minutes and on the `online` event; a page shown again rejoins its room at once  
   and checks the address only when that is due. A new address moves the device to the new room  
   (it says goodbye in the old one first).
2. **The room.** The room tag is the hex SHA-256 of `ether-nearby-v1:<ipv4>`,  
   so every device behind the same router gets the same tag without telling anyone.  
   Presence is sealed with AES-256-GCM under a key derived from the same text (HKDF-SHA-256),  
   with the room tag as additional data.
3. **The relays.** Every message goes to every relay in `src/discovery/relays.json`, and each relay gets the same subscription.  
   Ether's own relay comes first: a Cloudflare Worker described in [relay/README.md](../relay/README.md).  
   The public Nostr relays after it are backups, so discovery keeps working when it is down or out of its free allowance.  
   A device needs just one relay in common with another.
4. **Presence.** A device says "here" (name, device type, platform, whether it has a PIN, a P-256 public key)  
   when it starts listening, then every 30 s ± 5 s, and at once when its name or platform changes  
   or its PIN is set or removed.  
   Its first presence in a room is marked `joined`: everyone who hears it greets it with a presence of their own  
   0.5–2.5 s later, because it missed every presence sent before it subscribed.  
   A device that is silent for 75 s leaves the list; one that says "bye" leaves it at once.
5. **Only while visible.** A page that is hidden (another tab, another app, the screen locked) says goodbye and leaves:  
   a page in the background can't answer a request, and hiding comes before unloading,  
   so a reload or a closed tab gets its goodbye out far more often than at `pagehide`.  
   When the page is visible again it rejoins at once, as the same device, and announces itself.  
   A request it sent ends as `canceled`, and a request it was showing ends (`request-ended`);  
   the other device hears the goodbye and gets `no-answer` or `request-ended`.
6. **A request.** Tapping a device sends it this device's offer code. The other device shows the request for 60 s;  
   accepting sends back the answer code, declining sends "declined" (or "busy" when it is connected or pairing).  
   Without an accept, no pairing happens, unless the other device has a PIN and the request proves it (see PIN).

### Statuses

| Status | When |
| --- | --- |
| `off` | The setting is off, or `stop()` was called, or the page is hidden; it starts again by itself once the page is visible (also after the back-forward cache) |
| `starting` | Finding the public address, or reaching the relays |
| `listening` | In the room with at least one relay connected; the list may be empty |
| `offline` | No STUN server answered, or every relay failed; it keeps retrying (STUN after 5, 15, 30, then every 60 s) |

## Messages

Every message is a Nostr event (NIP-01), signed with BIP-340 Schnorr by a key made for this page load:

```json
{
  "id": "<SHA-256 of the serialized event>",
  "pubkey": "<x-only public key, per page load>",
  "created_at": 1795000000,
  "kind": 25050,
  "tags": [["x", "<room tag>"]],
  "content": "<base64url of a 12-byte IV and the AES-GCM ciphertext>",
  "sig": "<BIP-340 signature of the id>"
}
```

Kind 25050 is ephemeral (20000–29999), so a relay passes it on and need not store it.  
The subscription is `["REQ", "nearby-<n>", { "kinds": [25050], "#x": ["<room tag>"], "since": <now − 600> }]`;  
`since` reaches 10 minutes back so a device whose clock runs slow is still heard.  
The client uses only `EVENT`, `REQ` and `CLOSE`, and reads `OK`, `EVENT`, `EOSE`, `NOTICE` and `CLOSED`.

The sealed content is one of three room messages:

| Message | Fields |
| --- | --- |
| `{"v":1,"t":"here",…}` | `from` (nearbyId), `run`, `name`, `device` (`phone`, `tablet` or `desktop`), `platform` (optional: `Android`, `iPhone`, `iPad`, `Windows`, `Mac`, `Linux`, `ChromeOS`, else `Phone`, `Tablet` or `Computer`), `key` (raw P-256 public key, base64url), `pin: true` when the device has a PIN (never the PIN), `joined: true` on the first one in a room |
| `{"v":1,"t":"bye",…}` | `from`, `run` |
| `{"v":1,"t":"direct",…}` | `from`, `run`, `to`, `key` (the sender's P-256 key), `box`: a message for `to` only |

`run` is new each time the device joins (start, or the page becoming visible again).  
A goodbye ends that run only: a presence of that run arriving late through another relay is ignored,  
a goodbye arriving after the device came back leaves its row alone,  
and only the requests of that run end.

A `box` is sealed with AES-256-GCM under a key both devices derive from ECDH between their P-256 keys  
(HKDF-SHA-256, the room tag as salt), with `ether-nearby-v1|<from>|<to>` as additional data,  
so the other devices in the room can't read it and it can't be turned around or sent to someone else:

| Direct message | Fields |
| --- | --- |
| `{"t":"request",…}` | `id` (requestId), `offer` (the offer code), `ttl` (60000 ms), `name`, `device`, `proof` (optional: the PIN proof, see PIN) |
| `{"t":"accept",…}` | `id`, `answer` (the answer code) |
| `{"t":"decline",…}` | `id`, `reason`: `declined`, `busy`, `pin-required` or `wrong-pin` |
| `{"t":"cancel",…}` | `id`; sent when the asker aborts or gives up |

### Identity

A tab keeps its `nearbyId` and Nostr key in `sessionStorage` (`ether.nearby.identity`, `tabIdentity.ts`),  
which survives a reload in the same tab, so a reloaded page speaks as the same device  
and the other devices update its row instead of adding a second one.  
That matters most on iPhones, where Safari drops the WebSocket while the page unloads,  
so the old page's goodbye may never go out.  
A new tab gets a new identity, and nothing outlives the tab; the P-256 key, every `run` and every `requestId` are new for each page load.  
When storage is unavailable, each page load is a new device, and the old row leaves after 75 s or is replaced (below).

A duplicated tab copies `sessionStorage`, so two tabs can start with one identity.  
When a tab hears its own `nearbyId` from a run that isn't its own, the tab whose run sorts last takes a new identity,  
so exactly one of them moves and both are listed.

The list holds one row per `nearbyId`: a presence from a listed device updates its row, from whatever run.  
**A quiet namesake is replaced:** when a presence comes from a new `nearbyId`, and a row with the same name and device type  
has been silent for more than 40 s (a presence interval and its jitter, plus a margin),  
the new device takes that row's place. That covers a tab closed without its goodbye followed by a new tab.  
Two live devices that share a name both announce every ~30 s, so neither is ever that quiet and both rows stay.

### Requests

`requestPairingAsync(nearbyId, offerCode, { signal, pin })` resolves with:

- `accepted` and the answer code;
- `declined` or `busy`;
- `pin-required` or `wrong-pin`, from a device with a PIN when the request carried no PIN or a wrong one;
- `no-answer`, 70 s later: the 60 s the request is shown plus 10 s for an answer made at the last moment  
  (making it gathers for up to 3 s), or at once when the asked device says goodbye;
- `canceled`, when the signal aborts or discovery stops; aborting also sends `cancel`, so the other side gets `request-ended`.

It throws `DiscoveryError` (`discoveryError.ts`) when the request can't go out:  
`not-listening`, `unknown-device`, `invalid-code` or `send-failed` (no relay took it).  
`acceptAsync` throws `request-ended` when the request was withdrawn or expired first, and `send-failed`;  
`declineAsync` on an ended request does nothing.

### PIN

A device may have a PIN, 4 to 8 digits, set in Settings (the `pin` setting in `src/core/settings.ts`).  
The PIN stays on that device: its presence says `pin: true` and nothing more,  
the PIN never goes to the room or to the connected peer, and the log hides it (`core/redact.ts` hides `pin` and `proof`).

- **Asking.** The asker types the PIN, and its request carries a proof of it inside the sealed box:  
  `proof = base64url(HMAC-SHA256(key = PIN, message = requestId + "|" + hex(SHA-256(offer code))))`.  
  The proof is bound to one request and one offer, so it can't be used again for another,  
  and only the asked device can open the box.
- **Answering.** A device with a PIN checks each request before anything shows.  
  A right proof makes the request `isPinVerified`, and the app connects without the Accept dialog (D1).  
  No proof gets `decline` with `pin-required`, and a wrong one `wrong-pin`; neither shows anything on that device,  
  and the asker opens its PIN sheet again, with "Wrong PIN. Try again." after a wrong one.  
  A device without a PIN ignores a proof and asks as usual.
- **Guessing.** After 5 wrong proofs within 10 minutes from one `nearbyId`, or from one `run`,  
  that asker's requests get `busy` for 60 s, the right PIN included;  
  after 10 wrong proofs within 10 minutes from all askers together, every request does,  
  so new identities buy no new guesses. A lockout doesn't reset the count: each further wrong proof  
  while the earlier ones are under 10 minutes old locks again, so guesses come at about one a minute.  
  The log says so without the PIN, the proof or who asked. The counts live in memory for the page's life (`nearbyPin.ts`).
- **Older builds.** The new fields are optional on receipt. An older asker sends no proof and gets `pin-required`,  
  which it reads as `declined` ("*X* declined."); an older device ignores `pin` in presence and `proof` in a request,  
  and shows its Accept dialog as before.
- **Pairing by code** never asks for the PIN (D2): showing and scanning a code already proves both devices are in hand.

**Why 60 s and not the code's 5 minutes:** the person asking is usually next to the other device and waiting.  
A minute is plenty to say "tap Accept", and a prompt that pops up minutes later, after the asker gave up, is confusing;  
tapping the device again sends a new request. It is also no longer than the shortest code expiry allowed (1 minute).

## Timings

| What | Value |
| --- | --- |
| Presence | Every 30 s ± 5 s, at once on start, on a name change, and when the page becomes visible after 15 s or more |
| Greeting a newcomer | 0.5–2.5 s after its `joined` presence |
| Leaving the list | 75 s without presence (checked every 5 s), at once on `bye`, or when a new device with the same name and type arrives after 40 s of silence |
| Hidden page | Says goodbye and leaves at once; rejoins and announces as soon as it is visible |
| Request shown | 60 s; the asker waits 70 s |
| STUN | All servers at once, 5 s at most; again every 5 minutes, on `online`, and after a failure in 5, 15, 30, then 60 s |
| Relay connect | 10 s to open, then retries after 1, 3, 10, 30 and 60 s (± 25 %); a connection that lasted 30 s starts over at 1 s |
| Dead relay | 100 s without a frame, not even an `OK` for its own presence, means reconnect |
| Refused subscription | `CLOSED` (auth or payment required): retry after 5 minutes |
| Publish | Waits up to 5 s for an `OK`; an event queued while a relay reconnects is sent if it opens within 5 s |

## Checks on incoming messages

Relays are not trusted, Ether's own included (it checks no ids or signatures, to stay within the free plan's CPU time).  
Everything is checked in this order, and anything that fails is dropped and counted;  
a warning with the counts goes to the log at most every 30 s.

1. **The frame.** Text only, 64 KiB at most, a JSON array.
2. **Stored history.** Events that arrive before `EOSE` are dropped: the public relays keep ephemeral events for a while  
   and replay them to a new subscription, which would bring back devices that already left.  
   A relay that never sends `EOSE` is taken as live after 5 s.
3. **The event.** The NIP-01 shape (lowercase hex of the right lengths, whole numbers, at most 8 tags of 4 values of 128 characters,  
   16 KiB of content), kind 25050 and this room's tag, then the id (SHA-256 of the fields),  
   then the BIP-340 signature. Each event is handled once, whichever relay delivers it first.
4. **Floods.** Each Nostr key gets 20 events, then 1 every 2 s, before its signature is checked,  
   and all keys together get 60 signature checks, then 10 a second.
5. **The room.** `created_at` within 10 minutes of this device's clock, and the content opens with the room key.
6. **The message.** Like `metadataSanitizer.ts`: known fields of the right type and size only, unknown fields ignored,  
   4096 characters at most. Names are trimmed, single-spaced, without control or direction characters, 32 characters at most;  
   codes are printable ASCII without spaces, 2048 characters at most; an unknown device type becomes `desktop`;  
   a missing or unknown `platform` is left out, so devices on older and newer builds still list each other  
   (the row then shows the device type); a request's `ttl` is clamped to 5 s – 5 minutes.  
   `pin` counts only as `true`; a `proof` that isn't 43 base64url characters is left out, so it reads as no proof;  
   a decline reason this build doesn't know reads as `declined`.
7. **The sender.** Its own messages are ignored (its own runs); its own `nearbyId` from another run means a duplicated tab.  
   The first Nostr key to speak for a `nearbyId` keeps it, so no one else can speak for a listed device;  
   a reloaded page keeps its key, so it passes. A presence of a run that said goodbye is ignored.  
   Each `nearbyId` gets 10 messages, then 1 every 3 s.
8. **Caps.** 32 devices in the list, 8 open requests (2 per asker); a request withdrawn before it arrived stays withdrawn.

## Ether's own relay and its free allowance

Ether's own relays (`own` in `relays.json`) run on Cloudflare's free plan, whose daily allowances reset at 00:00 UTC.  
When one fails to open, or is closed by the relay or the network, twice in a row, discovery asks `GET https://<host>/status`  
(`cache: 'no-store'`, so the policy lists each own relay as `https://` too):

| Answer | What discovery does |
| --- | --- |
| `200 {"status":"ok"}` | Nothing: the failures were passing ones |
| `503 {"status":"limit"}` | A notice, `isCertain: true`: Cloudflare refused the relay's Durable Object for the day |
| `403 {"status":"forbidden"}` | No notice: the relay doesn't serve this page's origin (a dev tunnel, say), so it is left alone for the rest of the page's life and the public relays carry discovery |
| `503 {"status":"error"}`, or any other answer | Logs it; no notice |
| No readable answer, while the internet works | A notice, `isCertain: false`: that is how Cloudflare answers once the Worker itself is past its 100,000 daily requests (an error page without CORS) |
| No readable answer, internet down | Nothing: the `offline` status covers it |

The internet works when another relay is connected, or a STUN server answered in the last 5 minutes and the browser is online.  
A notice (`RelayAllowanceNotice { relayUrl, isCertain, resetsAt }`) is emitted as `relay-allowance` and read with `relayAllowance()`;  
`resetsAt` is the next 00:00 UTC. While it stands, the relay is left alone, since each attempt would spend the next day's requests:  
it is checked again every 10 minutes and a minute after `resetsAt`.  
The notice clears (`relay-allowance` with `undefined`) when the status says `ok` or the relay's WebSocket opens again,  
and on `stop()`. The public relays carry discovery meanwhile; the UI shows a banner.

## Privacy

- **STUN servers** (Cloudflare and Google) see a binding request from the device's public address and port, as on any WebRTC call.  
  Nothing else is sent to them.
- **Relays** see the public address of the connection (as any web server would), the page's origin,  
  the room tag, when and how big each message is, and a key made for this page load.  
  The room tag is a hash of the public address, and the IPv4 space is small enough to try every address,  
  so **anyone who knows or guesses the address** (a relay operator included) can derive the room key  
  and read presence: device names, device types and the P-256 public keys.  
  The pairing codes (local addresses, ICE credentials and DTLS fingerprints) are sealed for one device with an ECDH key  
  and can't be read by relays or by other devices in the room.
- **Other devices in the room** see the names and types of the devices listed, and which of them have a PIN,  
  and can send a request. Nothing pairs without the user accepting, or the asker entering the PIN,  
  and the check code then shows on both screens.
- **What never leaves the device:** the device ID, the session, settings (the PIN included), files and history.  
  The public address is not written to the log either; the log shows the first 8 characters of the room tag,  
  which is enough to see whether two devices are in the same room.
- **A dishonest relay** can drop, delay or replay messages (replays are dropped as duplicates or as stored history),  
  but can't forge a listed device's messages: they carry that device's signature.  
  It could pose as a new device in the room, since it can read presence; it still needs the user to accept  
  (or the PIN, which the guard keeps it from guessing quickly), and the codes it would get only work on the local network.

## Limits

- **Strangers behind the same address** share the room: carrier-grade NAT (many mobile and some home connections),  
  offices, campuses, hotels and cafés. They show in the list; nothing pairs unless the other side accepts,  
  or the asker knows its PIN. A short PIN is a small secret: the lockout slows guessing to about one try a minute,  
  so a 4-digit PIN takes days to guess, not minutes.
- **One network, several addresses:** dual-WAN routers, some mesh or ISP setups and a VPN on one device put devices in different rooms.  
  A device on a VPN meets the VPN's other users instead of its home, and pairing needs the local network anyway.
- **No IPv4 path** (IPv6-only networks), browsers or extensions that block WebRTC's UDP, and policies that hide public addresses  
  leave discovery `offline`.
- **No internet** means `offline`: pair by QR code or by copy and paste, which work on a Wi‑Fi without internet.
- **Only visible pages are listed:** a device whose page is in the background leaves at once and comes back when shown.  
  A page that is killed while visible (a crash, iOS reclaiming memory) leaves its row for 75 s.
- **Public relays** may refuse new keys, store events or go away; any one relay in common is enough,  
  and the list in `relays.json` is easy to change.

## Code

| Module | Holds |
| --- | --- |
| `discoveryTypes.ts` | The contract: `Discovery`, `NearbyDevice`, `PairRequest`, `PairRequestOutcome`, `RelayAllowanceNotice`, events |
| `discovery.ts` | `createDiscovery`: status, room, presence, the list, requests, checks on messages |
| `browserDiscovery.ts` | `createBrowserDiscovery`: the browser environment (`RTCPeerConnection`, `WebSocket`, `fetch`, timers, page events) |
| `discoveryError.ts` | `DiscoveryError` and its codes |
| `stunPool.ts` | `STUN_SERVERS` and `findPublicAddressAsync` |
| `nearbyCrypto.ts` | Room tag and key, P-256 keys, direct keys, sealing and opening (WebCrypto) |
| `nearbyMessages.ts` | The message shapes, parsing, name cleaning |
| `nearbyPin.ts` | The PIN proof (HMAC-SHA256 over `core/sha256.ts`) and the guard against guessing |
| `relays.json` | The relay list, `own` first, read by `relayPool.ts` and by `scripts/contentSecurityPolicy.mjs` |
| `relayPool.ts` | All relays: publish to each, one subscription, dedupe, id and signature checks |
| `relayConnection.ts` | One relay: reconnects, `EOSE`, `OK`, `NOTICE`, `CLOSED`, size caps, pause |
| `relayAllowance.ts` | The free-allowance notice of Ether's own relays |
| `nostrEvent.ts`, `schnorr.ts` | NIP-01 events; BIP-340 Schnorr over secp256k1 with `BigInt` |
| `rateLimiter.ts`, `encoding.ts` | Token buckets; hex and base64url |
| `tabIdentity.ts` | The tab's `nearbyId` and Nostr key in `sessionStorage` |
| `fakeRelay.ts`, `fakeDiscoveryEnvironment.ts` | Test doubles: in-memory relays behind fake WebSockets, STUN, session storage, page events |

`scripts/conventions.test.mjs` keeps `src/discovery` free of `src/app`, `src/client`, `src/media` and `src/qr`.  
`scripts/build.mjs` names every relay in the page's `connect-src`, never a blanket `wss:`,  
and `scripts/contentSecurityPolicy.test.mjs` fails when the pool and the policy differ.

## Logging

Everything goes through the injected `Logger` in category `nearby` (default level `info`); the lines are in [Settings and logs](AdminAndLogs.md#nearby-log-lines).

## Tests and checks

`npx vitest run src/discovery` runs the unit tests: Schnorr against the official BIP-340 vectors,  
events, crypto, messages, the STUN vote, each relay connection, the pool, the allowance notice,  
and two- and three-device protocol tests on fake relays (two of which replay stored events, as public relays do):  
presence, self-ignore, timeouts, goodbye, accept, decline, busy, no answer, cancel, name and address changes,  
a relay dying, malformed, forged and flooding input, reloads with and without a goodbye, hiding and showing,  
blocked storage, duplicated tabs, replacing a quiet namesake, and the PIN: the flag in presence,  
a right, missing or wrong proof, a device without a PIN ignoring one, and the lockout.  
`nearbyPin.test.ts` checks the HMAC against RFC 4231 and WebCrypto, and the guard's limits and window.

`npm run check:nearby` is opt-in, since it needs the internet.  
It serves a page with the app's Content Security Policy through `scripts/serve.mjs`,  
opens it in two headless Chromium contexts ("Check A" and "Check B"),  
and checks that both find the public address through the real STUN pool, that Ether's own relay connects,  
that they list each other through the real relays, that request → accept, request → decline and request → cancel  
work with dummy codes, that B reloading its page keeps one row for it on A (the same device, back within seconds),  
that once A sets a PIN, B's request without it gets `pin-required`, with a wrong one `wrong-pin`,  
and with the right one reaches A as verified, and that stopping drops the device on the other side at once.  
`--log` prints both pages' logs.
