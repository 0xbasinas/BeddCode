# @beddcode/relay

A small relay that lets a phone or another computer reach a BeddCode host on any network, with no ports opened.
The host dials out to the relay; devices dial in; the relay forwards bytes. Everything between a device and its
host is end-to-end encrypted (ChaCha20-Poly1305, key shared at pairing), so the relay can neither read nor alter it.

## Run it

**Cloudflare (free plan is enough for personal use)**

```sh
cd packages/relay
npx wrangler deploy -c worker/wrangler.toml
```

**Self-host (Node)** — put it behind TLS:

```sh
PORT=8787 pnpm --filter @beddcode/relay start
```

## Point a host at it

```sh
beddcode config set relay-url https://your-relay.example.workers.dev
```

(or `--relay-url`, or `BEDDCODE_RELAY_URL`). Restart the host; pairing links and QR codes then include a relay route,
and a key is created at `<data dir>/relay-key`.

## Lock it with a password

Without one, anyone who knows the address can open rooms on your relay. Set one on the relay:

```sh
npx wrangler secret put RELAY_PASSWORD -c worker/wrangler.toml
```

then enter it on each host (Share this computer → Connect from anywhere, or `beddcode config set relay-password …`).
Devices never need it. Self-hosting: set `RELAY_PASSWORD` in the environment.

## Speed measurements (optional, Cloudflare only)

With a password set, the Worker also keeps small speed measurements for you: how long connecting and loading a
thread take on each device, as numbers and a few short labels (platform, direct or relay), never content. Switch it on
in Share this computer → Connect from anywhere, then read it with:

```sh
beddcode metrics --days 7
```

Samples older than 30 days are dropped, and the store stops accepting new ones at 300,000.

## Tests



`pnpm --filter @beddcode/relay test` runs against the Node relay. To run the same suite against the Worker, start
`wrangler dev --port 8788 --ip 127.0.0.1 -c worker/wrangler.toml` and set `RELAY_TEST_PORT=8788`.
