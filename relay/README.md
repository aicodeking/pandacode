# PandaCode Connect relay

A Cloudflare Worker with one SQLite-backed Durable Object per account. It signs devices in with
GitHub, keeps the device list, and forwards end-to-end encrypted frames between an account's
devices. It stores no task content. The contract is in [docs/remote-access.md](../docs/remote-access.md).

## Deploy

1. Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps) and tick **Enable Device Flow**.
   Generate a client secret too: the relay uses it only to check that a sign-in token was issued to this app (`POST /applications/{client_id}/token`). The desktop app never sees it. The client ID also goes into the desktop build as `PANDACODE_GITHUB_CLIENT_ID`.
2. From this folder:
   ```sh
   npm install
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler deploy
   ```
   Each `secret put` takes the secret's name and asks for its value (paste the OAuth App's client ID,
   then its client secret). Run them one line at a time.
   The deploy creates the `Account` Durable Object (SQLite migration `v1`) and the `AUTH_LIMITER` (10/min per IP) `ACCOUNT_LIMITER` (30/min per account) and `GLOBAL_AUTH_LIMITER` (300/min across all sign-ins, checked after the per-IP one) rate-limit bindings.
3. Build the desktop app with `PANDACODE_RELAY_URL` set to the Worker URL (or set it as an environment variable at run time).

Rotating `SESSION_SECRET` signs everyone out. `SESSION_SECRET` must be at least 32 characters; with it missing or shorter (or the GitHub ID/secret missing, for sign-in) every request gets a generic `500 server error`.

Hardening notes:
- Sign-in bodies are read through a streaming cap of 256 KiB (`src/body.ts`), so chunked uploads get 413 too.
- Tokens carry `gen`, a random value stored on the device row when it is first registered. The Durable Object rejects a token whose `gen` differs from the row's, so a revoke followed by a re-register in the same second kills old tokens. A plain re-sign-in of a still-registered device keeps its `gen` (its other tokens stay valid; same device, same key). Tokens without `gen` (issued before schema 2) fall back to the `iat >= registered_at` check; `/v1/token` upgrades them. Schema 2 adds `devices.gen` (existing rows get 0).
- A rate-limited WebSocket frame over 4 KiB is answered `rate limit exceeded` without parsing it.

## Behaviour

- `GET /v1/connect?host=0|1` opens the socket and sets the host flag and `last_seen` in one write, then broadcasts presence once. A `{kind:"host"}` frame still works; repeating the stored value writes and broadcasts nothing.
- `POST /v1/token` (Bearer relay token) returns `{ token }`: a fresh 30-day token for the same account and device, `iat` = now. It passes the same checks as `/v1/devices` (signature and expiry, `ACCOUNT_LIMITER`, device still registered, `iat` not before registration), so a revoked device gets 401 and cannot refresh. Other failures are the usual 401/429 JSON errors; other methods get 405.
- Frames are `{ to, body, ref? }` (`ref`: opaque, at most 64 chars). When a frame can't go out, the sender gets `{ kind: "undeliverable", to, ref?, reason: "offline" | "rate" }` with `ref` echoed. Malformed frames get `{ kind: "error", error }`.
- Presence is `{ kind: "presence", devices: [{ id, name, platform, publicKey, host, online, lastSeen }] }`, the full registered list, the same shape as `GET /v1/devices`.
- Clients send `ping` every 30 s (answered by the runtime without waking the object). A socket is online only while its last ping, or its join before the first ping, is under 75 s old; stale sockets are closed (code 4002) when found and presence is broadcast.
- A reconnect keeps the device's rate bucket (20/s, burst 100), seeded from the old socket before it closes.
- The schema migrates once, gated on `PRAGMA user_version`.

## Develop

```sh
npm run typecheck   # tsc for the Worker and for the tests
npm test            # node --test (needs Node 22.18+ for TypeScript stripping)
npx wrangler dev    # local; put SESSION_SECRET=... in .dev.vars
```

| File | Job |
|---|---|
| `src/index.ts` | Routes, auth rate limits, GitHub sign-in, token check |
| `src/account.ts` | Durable Object: device rows, hibernating WebSockets, forwarding, presence |
| `src/token.ts`, `body.ts`, `config.ts`, `policy.ts`, `validate.ts`, `bucket.ts`, `frames.ts`, `github.ts`, `limits.ts` | Pure logic, unit tested |
