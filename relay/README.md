# Ether relay

Ether's own relay for finding nearby devices: a Cloudflare Worker with one Durable Object, on the free Workers plan.

Devices behind the same router share one public IP address.
Each one hashes that address into a room name and passes small encrypted messages through the relay:
"I'm here", a request to pair, and the answer.
Files never go through the relay; once a request is accepted, the two devices connect directly.

Ether lists this relay under `own` in `src/discovery/relays.json`, and tries it before the public Nostr relays
that back it up.

## What it does

The relay speaks the part of Nostr (NIP-01) that Ether needs, so any public Nostr relay can stand in for it.

- **Nothing is stored.** It takes only ephemeral events (kinds 20000–29999) and passes them straight on.
- **Only Ether's pages may connect.** The browser's origin must be one of `ALLOWED_ORIGINS` in `wrangler.toml`,
  or a private network address (`10.x`, `172.16–31.x`, `192.168.x`) on any port:
  Ether served from a computer to a phone on the same Wi‑Fi, which only that network can reach.
- **Ids and signatures are not checked here.** That keeps the relay within the free plan's CPU time;
  Ether checks both on every event it receives.
- **Each connection has limits:**
  - 4 subscriptions, each with up to 4 filters;
  - 40 messages every 10 seconds;
  - 16 KB of content per event.
- **It reports its state.** A browser can't tell why a WebSocket failed, so when the relay's connection fails,
  Ether asks `GET /status`, which every origin can read:

  | Answer | Meaning |
  | --- | --- |
  | `200 {"status":"ok"}` | The relay works. |
  | `503 {"status":"limit"}` | Cloudflare refused the Durable Object for a used-up free allowance. |
  | `403 {"status":"forbidden"}` | The relay doesn't serve the asking page's origin; Ether uses the public relays instead. |
  | `503 {"status":"error"}` | Any other fault. |
  | No readable answer | The Worker itself is past its daily requests, so Cloudflare answered in its place. |

  For `limit`, or no readable answer while the internet works, Ether shows a banner:
  today's free allowance is used up (or probably is), and when it starts again.

| File | What's in it |
| --- | --- |
| `src/relayRules.ts` | The rules: which messages are taken, who hears an event, and the limits |
| `src/relayRules.test.ts` | Tests for the rules, run with Ether's other tests (`npm test`) |
| `src/relayHub.ts` | The Cloudflare part: the Worker, the Durable Object and the status check |
| `wrangler.toml` | The Worker's name, its allowed origins, and the Durable Object |

## Set it up

You need Node.js and a free Cloudflare account (<https://dash.cloudflare.com/sign-up>; the Free plan needs no card).
Nothing secret goes into the repository: Wrangler keeps your login on your computer.

1. Turn off Wrangler's telemetry on this computer, before anything else (see [Telemetry](#telemetry)).

   ```shell
   npx wrangler@4 telemetry disable
   ```

2. Sign in. A browser page opens; select **Allow**.

   ```shell
   cd relay
   npx wrangler@4 login
   ```

3. Deploy.

   ```shell
   npx wrangler@4 deploy
   ```

   The first deploy registers a `workers.dev` subdomain for your account,
   and the output ends with the relay's address:

   ```text
   Deployed ether-relay triggers
     https://ether-relay.<subdomain>.workers.dev
   ```

   You can rename the subdomain in the Cloudflare dashboard, under **Workers & Pages**; the address changes with it.

4. Check that it answers. A new address can take a few minutes to start working.

   ```shell
   curl -i https://ether-relay.<subdomain>.workers.dev
   ```

   Status `426` with "Ether relay: WebSocket connections only." means it's running.

   The status check should answer too:

   ```shell
   curl -H "Origin: https://efthymios-ks.github.io" https://ether-relay.<subdomain>.workers.dev/status
   ```

   ```json
   {"status":"ok"}
   ```

5. Put its address under `own` in `src/discovery/relays.json`, with `wss://` instead of `https://`:

   ```json
   {
       "own": ["wss://ether-relay.<subdomain>.workers.dev"],
       "public": ["wss://nos.lol"]
   }
   ```

   Then rebuild Ether (`npm run build`).
   The build reads the same file for the page's Content Security Policy,
   allowing both `wss://` and `https://` for an own relay (for the status check), so nothing else needs editing.

## Telemetry

Wrangler never sends Cloudflare usage data from this project. Two settings make sure of it.

- **In the project:** `wrangler.toml` sets `send_metrics = false`, so this relay sends none on any computer.
  Keep that line.

  ```toml
  send_metrics = false
  ```

- **On each computer:** turn it off once for every Wrangler project there, and check it.

  ```shell
  npx wrangler@4 telemetry disable
  npx wrangler@4 telemetry status
  ```

  The status should read `Disabled`.

A script or CI job can also set the environment variable `WRANGLER_SEND_METRICS=false`.

## Change it

- **Allow another origin:** if Ether is served from another address, such as a custom domain,
  add that address to `ALLOWED_ORIGINS` and deploy again.

  ```toml
  [vars]
  ALLOWED_ORIGINS = "https://efthymios-ks.github.io https://ether.example.com http://localhost http://127.0.0.1"
  ```

- **Deploy a change:** after editing `src` or `wrangler.toml`, from the `relay` folder:

  ```shell
  npx wrangler@4 deploy
  ```

- **Watch it live:** this prints every connection and error while it runs.

  ```shell
  npx wrangler@4 tail
  ```

- **Remove it:** take it out of `src/discovery/relays.json` first, then:

  ```shell
  npx wrangler@4 delete
  ```

## Test with it

How Ether reaches this relay depends on where the page comes from:

| Ether served from | Uses this relay? |
| --- | --- |
| GitHub Pages | Yes |
| This computer (`localhost`, `127.0.0.1`), e.g. `./Start-Debug.ps1` | Yes |
| This computer to a phone on the same Wi‑Fi, `./Start-Debug.ps1 -Lan` | Yes: private network addresses are allowed |
| A dev tunnel, `./Start-Debug.ps1 -Tunnel` | No: the relay answers `forbidden`, and Ether finds devices through the public relays |

Nearby devices must share one public address: put the phone on the same Wi‑Fi as the computer, not mobile data.

To run the relay itself on this computer, with Cloudflare's own runtime and no account:

```shell
npx wrangler@4 dev
```

It listens at `ws://127.0.0.1:8787`.

## Costs and limits

- **Free allowance:** the Workers Free plan allows 100,000 requests a day.
  Two devices with Ether open all day send about 6,000 messages.
- **Past a limit:** requests fail until 00:00 UTC, and Ether shows a banner saying so,
  with that time in the device's own time zone. The Free plan never bills.
- **A public address:** anyone can read it in this repository, but browsers on other sites are refused.
  A script that fakes its origin could at worst use up a day's allowance.
  Ether then carries on through the public relays, and QR pairing always works.
