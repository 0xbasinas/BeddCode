# Reaching a host from a hosted web app (Tailscale Serve first, Funnel second)

Status: design only, nothing here is built.

## Goal

Open `https://app.beddcode.xyz` on any device, enter a host's address and a pairing code, and work
with that host, with nothing to install. The sessions, files and terminals go from the browser
straight to the host. The hosted page is static files; no BeddCode server sees user data.

## Why two phases

|                            | Tailscale Serve (phase 1)                      | Tailscale Funnel (phase 2)                     |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Who can reach the host     | Devices on the user's tailnet                  | Anyone on the internet                         |
| What the browser needs     | Tailscale running on that device               | Nothing                                        |
| What the host sees         | Tailnet identity headers, classified `tailnet` | `tailscale-funnel-request`, classified `other` |
| Host guard today           | Already accepted                               | Already refused (`peerAllowed` is false)       |
| Custom domain              | No: `<machine>.<tailnet>.ts.net`               | No: only `*.ts.net`                            |
| Risk if the host has a bug | Tailnet members                                | The internet                                   |

Sources: Tailscale's [Serve](https://tailscale.com/kb/1242/tailscale-serve) and
[Funnel](https://tailscale.com/kb/1223/funnel) docs. Funnel needs MagicDNS, HTTPS certificates and
the `funnel` node attribute; it allows ports 443, 8443 and 10000 and has bandwidth limits that cannot
be configured. A port is either Serve or Funnel, whichever was set last.

Phase 1 delivers the "no install" experience with no new exposure. Phase 2 exists for people whose
devices cannot run Tailscale, and is opt-in per host.

## Phase 1: Serve + hosted web app

### User flow

1. On the host: `beddcode web enable`.
   - Runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>`.
   - Adds `https://app.beddcode.xyz` to `allowedOrigins` (config file).
   - Prints the address (`https://<machine>.<tailnet>.ts.net`) and a pairing code.
2. On any device with Tailscale on: open `app.beddcode.xyz`, paste the address and code.
3. `beddcode web disable` turns Serve off and removes the origin.

### Work

| Piece       | Change                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host CLI    | `web enable \| disable \| status`; reads the tailnet name from the existing `TailscaleService`.                                                                         |
| Host config | Nothing new: `allowedOrigins` already exists and the CORS/WebSocket origin checks already use it.                                                                       |
| `doctor`    | One check: is Serve pointing at this port, and is HTTPS enabled for the tailnet?                                                                                        |
| Web app     | A "connect" screen (address + code → `POST /pair` → token) and storing hosts, as mobile already does through `packages/client-runtime`. Static build deployed to Pages. |
| Docs        | One README section.                                                                                                                                                     |

### Open questions to test first (half a day, before building)

1. **Browser local-network rules.** A public page calling a `*.ts.net` name that resolves to a
   private `100.x` address may trigger a permission prompt (Chrome's local network access) or be
   blocked in other browsers. Test a throwaway page against a real `tailscale serve` host in Chrome,
   Safari (iOS) and Firefox. If it is blocked, fall back to the host serving its own UI at its
   `ts.net` address, which already works.
2. **WebSocket through Serve.** The docs do not say; confirm `/ws` and `/tunnel` work and survive idle.
3. **Mixed content.** The page is HTTPS, so only `wss://` hosts work; plain `http://100.x` addresses
   must be rejected with an explanation that points to `beddcode web enable`.

## Phase 2: Funnel (opt-in)

Funnel puts the host on the public internet. The host can run commands, edit files and open
terminals for any paired device, so this is the riskiest feature BeddCode would ship. It should not
land until Phase 1 is in use and the hardening below is done and reviewed.

### Threat model

- Anyone can send requests to `/health`, `/pair`, `/ws` and `/tunnel`.
- Attacker goals: pair a device (guess the code), steal a token, reach loopback-only endpoints
  through the proxy, exhaust the host, or lock the real user out.

### What already helps

- The guard treats a request from the local proxy as the machine itself only when it carries no
  proxy headers; Funnel requests carry `tailscale-funnel-request` and are `other`, never `loopback`.
  Loopback-only routes (`/admin/pair`, `/agent-tools`) stay unreachable.
- Pairing codes are six digits, ten minutes, one use. Wrong guesses are counted host-wide (five in a
  minute locks redeeming for a minute and clears outstanding codes).
- Every non-loopback connection must present a device token before anything else.

### Gaps to close

| Gap                                                                                                           | Fix                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peerAllowed('other')` is false; there is no way to opt in                                                    | New setting `allowFunnel` (default off). When on, `other` peers are accepted but **always** need a token, never loopback trust.                                                                   |
| Lockout is host-wide: an attacker can keep the real user from pairing, and each lockout wipes the user's code | Count failures per source address (from the Funnel-supplied client address) as well as globally; lock out the offender and keep the global limit as a backstop that no longer clears valid codes. |
| Six-digit codes are weak when the whole internet can guess                                                    | Public mode uses longer codes (for example 10 characters) and shows the code once; tokens remain long random strings.                                                                             |
| `/pair` and `/ws` upgrade accept unlimited unauthenticated traffic                                            | Cap concurrent unauthenticated sockets, close sockets that do not authenticate within a few seconds, cap request body size.                                                                       |
| Funnel is easy to leave on                                                                                    | `beddcode web enable --public` asks for confirmation, prints a warning, and `doctor`/the app show a persistent "public" badge; `web status` says plainly whether it is public.                    |
| No record of who connected                                                                                    | Log pair attempts and new device pairings with the source address; list devices with last-seen (`beddcode devices`).                                                                              |
| Origins                                                                                                       | Public mode still requires an allowed origin for browser use; the hosted page's origin is added by `web enable`.                                                                                  |

### User flow

`beddcode web enable --public` → warning and confirmation → `tailscale funnel --bg 443` (requires the
user's tailnet to allow the `funnel` attribute) → prints the public address and a long pairing code.
`beddcode web disable` turns it off. Turning it off also invalidates outstanding codes.

### Acceptance

- With `allowFunnel` off, Funnel requests get 403 exactly as today (regression test).
- With it on: no endpoint except `/health`, `/pair` and the authenticated WebSocket answers an
  unauthenticated internet request; tests cover each route with Funnel headers.
- Guessing cannot lock out a legitimate pairing started from another address, and cannot go faster
  than the per-address limit.
- An independent security review of the guard, pairing and token code before release.

## Out of scope

- Custom domains for hosts (Funnel cannot; a self-hosted tunnel such as Pangolin or frp could, and
  would be a separate design).
- Running a BeddCode relay that carries traffic. That would put user data on our servers and is
  deliberately not part of this.

## Order of work

1. Browser test page (the three open questions) → decide go/no-go on the hosted app.
2. Phase 1: `web enable|disable|status`, `doctor` check, web connect screen, deploy at
   `app.beddcode.xyz`.
3. Phase 2 hardening and review, then `--public`.
