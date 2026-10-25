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

## Tests

`pnpm --filter @beddcode/relay test` runs against the Node relay. To run the same suite against the Worker, start
`wrangler dev --port 8788 --ip 127.0.0.1 -c worker/wrangler.toml` and set `RELAY_TEST_PORT=8788`.
