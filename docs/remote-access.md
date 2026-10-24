# Remote access (PandaCode Connect)

Opt-in. Off by default. Signing in lets a task *run on another computer*: one of the user's
computers signed in to the same GitHub account, with **Allow remote control of this computer**
turned on. The task stays an ordinary task in the local sidebar and conversation pane, with the
same streaming, composer, approvals and model picker as a local one; there is no separate remote
view. Nothing is sent anywhere until the user signs in.

## Pieces

| Piece | Where | Job |
|---|---|---|
| Relay | `relay/` (Cloudflare Worker + one Durable Object per account) | Sign-in, device list, forwards encrypted frames between an account's devices. Stores no task content. |
| Native | `src-tauri/src/remote/` | Sign-in, secrets in a private file (`secrets.rs`), one WebSocket to the relay, host RPC (`host.rs`, `start.rs`), mirrors (`mirror.rs`), client calls. |
| UI | `src/remote*.ts`, `src/remote-settings.css` | Settings → Remote access, and choosing where a new task runs. |

## Mirrors

A task started on host H is a normal local session row (a *mirror*) with three extra columns
(schema version 26): `remote_device` (H's device id), `remote_session` (H's session id, null
while H is still starting it) and `remote_synced_id` (the last of H's message ids copied here).

- `get_messages` reads local rows. Messages are copied from H after each run end, and when a
  subscription shows H has newer ones.
- `send_message`, `stop_session`, `respond_approval`, `respond_user_input`, `steer_task`,
  `configure_session` (model), `set_reasoning_effort` and `update_session` (mode, so
  permissions change on H) go to H natively, with H's session id.
  A prompt marks the mirror running before H answers (and restores the status if H refuses).
  Images can't be sent to a mirror yet: they are files on this computer.
- Stopping a mirror whose host is offline (the relay reports it undeliverable, or presence
  shows it offline) ends the local turn as stopped, so the spinner clears. A run end is applied
  once: a mirror that is no longer running or waiting is never ended again.
- The queue stays on this computer: the window delivers the next entry with `send_message` at
  the run end, as for any task, so it reaches H. (Routing the queue to H as well would let both
  windows deliver the same entry.)
- `list_sessions` (and every `Session`) carries `remoteDevice: { id, name }`. The name comes
  from presence ("another computer" until presence names it).
- Running state is the row's status, set from H's events, so the sidebar and composer show it
  as for a local run. A mirror is never reset to interrupted because no local agent runs it.
- Anything that needs the checkout (git, worktree and diff commands, file reads, launching an
  agent) goes through `Store::workspace_root`, which refuses a mirror with
  `This task runs on <name>.` and never touches the local disk.

## Accounts

Sign in with GitHub using the OAuth **device flow** (no client secret anywhere):

1. Desktop: `POST https://github.com/login/device/code` with `client_id`, and the scope is empty (identity only).
2. The user enters the code at `verification_uri`. The desktop polls `https://github.com/login/oauth/access_token`.
3. Desktop → relay `POST /v1/auth/github` `{ githubToken, device: { id, name, platform, publicKey } }`.
   The relay checks the token against its own OAuth app (`POST /applications/{client_id}/token`, so a
   token issued to any other app is refused) and gets the numeric id, login and avatar_url. It
   registers the device and returns `{ token, account: { id: "gh:<id>", login, avatarUrl } }`.
4. The desktop stores only the relay token, in `connect-secrets.json`, and discards the GitHub token.

**Where secrets live.** The relay token and the base64 X25519 private key are one JSON file,
`<app data dir>/connect-secrets.json` (`{ token?, key? }`), mode 0600 on unix, written
atomically (temp file in the same folder, fsync, rename). Each install's data folder is its own
scope, so a dev build and the installed app never share secrets. A missing, unreadable or
corrupt file means none (signed out). Connect never uses the OS keychain: macOS pins each item
to the exact code hash of the build that made it, and PandaCode has no Apple Team ID, so every
update asked for the login password on every read. Other app secrets moved the same way, to
`secrets.json` (see `secret_store.rs`). Nothing is migrated from the keychain for Connect
(reading it is what prompted); users from before this change sign in once more, and the `409`
path below gives them a new device id.

The device key is made once, at sign-in, behind a lock (so two sign-ins cannot race) and before
polling starts. Only a missing (or undecodable) key is ever generated, so an existing key is
never overwritten; a failed write fails sign-in. `remote_sign_in_cancel`
stops the device-flow poll, and a new `remote_sign_in_start` cancels any earlier flow.

A relay `401` (or close code `4001`) signs this computer out only if the token that request
used is still the current token, so a late refusal of an old token never signs out a newer
sign-in.

If the relay answers `409` (this device id is already registered with a different public key), the
desktop makes a new device id, saves it, and retries once.

Relay token: `base64url(JSON {acct, dev, iat, exp, gen}) + "." + base64url(HMAC-SHA256(SESSION_SECRET))`.
It is valid for 30 days, and only while the device is still registered on the account with the same
`gen` (a random value set when the device row is created; older tokens without `gen` fall back to
`iat >= registered_at`, and a refresh adds it). Revoking a device closes its socket and makes its
tokens invalid, even after a re-registration in the same second. The relay refuses to run with a
`SESSION_SECRET` shorter than 32 characters.

**Refresh.** While connected, the desktop checks the token at connect and every 12 hours. With
fewer than 7 days left it calls `POST /v1/token` and stores the fresh token (same account and
device, later expiry) in the secrets file and in memory. A failure is left for the next check; a
`401` follows the sign-out rule above.

**Startup.** Only a computer with an account in `remote.json` reads the secrets file. A
missing (or expired) token means signed out. Nothing prompts and nothing touches the network
unless signed in.

Build config is `option_env!("PANDACODE_RELAY_URL")` and `option_env!("PANDACODE_GITHUB_CLIENT_ID")`.
Environment variables of the same names override them at run time. If either is missing, remote
access is shown as "not configured in this build".

## Relay HTTP API

All routes except auth take `Authorization: Bearer <relay token>`. Errors are `{ error: string }`.

- `POST /v1/auth/github` → `{ token, account }`
- `GET /v1/devices` → `{ devices: [{ id, name, platform, publicKey, host, online, lastSeen }] }`.
  The desktop uses it only for an explicit `remote_devices` call made before the
  socket's first presence frame.
- `DELETE /v1/devices/:id` → `{ ok: true }`
- `POST /v1/token` → `{ token }`: a fresh 30-day token for the same account and device
- `GET /v1/connect?host=0|1` (WebSocket upgrade) → joins the account's Durable Object, advertising
  whether this device hosts

## Relay frames (WebSocket text, JSON)

Client → relay: `{ to: deviceId, body: string, ref?: string }`. `ref` is the request id of the
request or response the body carries (events have none). The relay adds `from` and delivers
`{ from, to, body }` to the target device's socket. If it cannot, it answers
`{ kind: "undeliverable", to, ref?, reason: "offline" | "rate" }`. With a `ref` the desktop fails
only that pending call; without one it fails every pending call to `to`.

Relay → client:
- `{ kind: "presence", devices: [{ id, name, platform, publicKey, host, online, lastSeen }] }`, the
  account's full device rows, sent on connect and on every join, leave or device change.
  Each presence frame makes the viewer subscribe again to the hosts it mirrors (a host that
  restarted has forgotten its subscribers).
- `{ kind: "undeliverable", ... }` (above)
- `{ kind: "error", error }`

Client → relay control: `{ kind: "host", enabled: boolean }` changes the advertised host flag
after connecting. `"ping"` gets `"pong"` as a hibernation auto-response.

Presence is the device list: the desktop takes devices, names and keys from it and never fetches
on connect or for an unknown sender. A device missing from presence is removed, and its event
subscription with it.

Close codes: `4000` (replaced by a newer socket) makes the client wait at least 60 s before it
reconnects. `4001` (device revoked) signs this computer out locally. Otherwise the client
reconnects with a backoff that starts at 1 s and doubles to 60 s. The backoff resets to 1 s only
after a socket stayed up for 30 s or more.

The relay uses the hibernation API (`ctx.acceptWebSocket`, tagged with the device id), so idle
sockets cost no duration. Device rows live in the Durable Object's SQLite storage.

## Limits (free)

| Limit | Value | Why |
|---|---|---|
| Devices per account | 10 | Fits personal use. Stops abuse. |
| Sockets per device | 1 | A new socket closes the old one. |
| Frame size | 256 KiB | Message pages and event frames are capped at 180 KiB of JSON. |
| Frame rate per socket | 20/s sustained, burst 100 | Token bucket. Over the limit → `undeliverable` (`reason: "rate"`) or `error`, and drop; frames over 4 KiB are not parsed. |
| Auth calls | 10/min per IP, 300/min overall | Workers rate-limit bindings |
| Authenticated HTTP calls | 30/min per account | Workers rate-limit binding |
| Sign-in body | 256 KiB, counted while streaming | Chunked bodies too |
| Idle socket | kept (hibernated). The client pings every 30 s. | |

## End-to-end encryption

Each device has an X25519 key pair. The private key stays in `connect-secrets.json`, and the public key is
registered with the device. For a pair of devices:

`key = HKDF-SHA256(ikm = X25519(mine, theirs), salt = sorted(idA, idB).join("|"), info = "pandacode-remote v1")`.

`body = base64(nonce24 || XChaCha20-Poly1305(key, nonce24, plaintext, aad = from + "|" + to))`.
Pair keys are cached by `(deviceId, publicKey)`, so a key change derives a new one from the
current key in presence. The relay sees only device ids and ciphertext. Settings shows each
device's key fingerprint (first 16 bytes of SHA-256 of the public key, hex) for information.

### Account access

Devices signed in to the same GitHub account can control each other while **Allow remote control**
is on. The host accepts requests only from devices listed in the account's current presence, and
still checks the timestamp and nonce for replay. The viewer opens responses and events only from
devices in presence, using each device's current public key to derive the encrypted pair key.
Subscribers are dropped when their device leaves presence or their subscription expires.

There is no per-device key pinning. The relay could add a device to the account, and that device
could then control a host while remote control is enabled. This is the trade-off of removing
pinning. Fingerprints remain visible in Settings as identifying information; they do not gate
access.

## App protocol (encrypted plaintext, JSON)

- Request `{ type: "req", id, method, params, ts, nonce }`: `ts` is unix time in ms, and `nonce` is
  16–64 random printable characters. A host refuses a request if `ts` is more than 60 s old or
  ahead, and refuses any nonce it saw in that window. The seen-nonce set is pruned to the window
  and bounded.
- Response `{ type: "res", id, ok: true, result, ts, nonce }` or `{ type: "res", id, ok: false, error, ts, nonce }`
- Event `{ type: "event", name, data, ts, nonce }`

Every sealed message carries `ts` and `nonce`. The viewer (desktop and phone) applies the same
window and seen-nonce check to responses and events and drops a stale, repeated or unstamped one;
a dropped response fails its call at once with `That computer's reply was stale or repeated…`.
A viewer therefore needs a host on a version that stamps replies.

A host answers requests from other devices listed in its account presence only while **Allow
remote control** is on. Otherwise it returns
`{ ok: false, error: "Remote control is off on this computer" }`. A host still applies its own
approval policy: remote prompts get no more power than local ones. Access (remote control on, the
sender in presence, replay) is checked again when a queued request runs, not only when it arrives.

**Full access for remote tasks** (`remote_full_access` in `remote.json`, off by default): while
off, `task.start` without a mode starts in `ask`; an explicit `full` in `task.start` or
`task.configure`, and any `task.send`, `task.steer` or mode-less `task.configure` on a task whose
stored mode is `full`, are refused with `Full access is off for remote tasks on <host>.` This
prevents accidents; it is not a boundary against a device that can also answer approvals.

| Method | Params | Result |
|---|---|---|
| `subscribe` | `{ sessionIds: [...] }` (≤ 500) | `{ tasks: [{ sessionId, status, lastId, title, pending }] }` for those that exist. `pending` is the current `[{ kind: "approval" \| "input_request", requestId, text, data, tool? }]` for requests the viewer can still answer; large payloads are cut to fit. Answered, cancelled and ended-run requests are removed. Adds the ids to this device's subscription for 10 minutes; the viewer renews every 9 minutes and on every presence frame. An expired subscription starts over. |
| `tasks.list` | `{ limit?: 0..500 }` (default 200) | `{ tasks: [{ sessionId, title, status, projectId, projectName, provider, model, effort, mode, pinned, updatedAt, lastPromptAt, branch?, chat?, pending }], projects: [{ id, name, repo: "owner/name" \| null }] }`. `pending` has the same shape and meaning as for `subscribe`. Tasks are ordered by latest prompt or response, omit drafts, mirrors and bot workspaces, and may include chats (`chat: true`). Projects omit bot workspaces. The tail is dropped to keep the reply under 180 KiB. |
| `projects.icons` | `{ projectIds: string[] }` (1..=50; use project ids from `tasks.list`) | `{ icons: { [projectId]: string \| null } }`. Known non-bot local projects map to their icon `data:` URL, or `null` when no icon exists or it exceeds 64 KiB. Unknown ids are omitted. Icons stop being added before the result exceeds 180 KiB, so omitted ids can be requested again. |
| `providers.list` | `{ force?: boolean }` | the host's `list_providers` result: `[{ id, name, installed, path, version, models }]`. `force` drops the same ACP catalog caches. If it would not fit one reply, the longest `models` lists are halved until it does. |
| `providers.models` | `{ provider, force?: boolean }` | the host's `list_provider_models` result: `[{ id, name, description, reasoningEfforts, defaultReasoningEffort, contextWindow }]`, its tail dropped to fit one reply. `provider` must be a known harness id (`Unknown provider.`). |
| `task.start` | `{ repo?: "owner/name", projectId?: string, branch?, worktree, prompt, provider, model, mode?, effort? }` (exactly one of `repo` or `projectId`) | `{ sessionId }` |
| `task.messages` | `{ sessionId, afterId }` | `{ messages: [{ id, role, content, createdAt, turnDurationMs }], hasMore, title }` |
| `task.send` | `{ sessionId, text }` | `{ queued: boolean }`. Queued if the task is running, like Enter. If the run ended between the check and the queue add, the host takes the entry back and sends it. |
| `task.stop` | `{ sessionId }` | `{}` |
| `task.steer` | `{ sessionId, text }` | `{}` (as `steer_task`) |
| `task.configure` | `{ sessionId, provider?, model?, effort?, mode? }` | `{}`. `provider` and `model` together (a provider not installed there is refused as in `task.start`); `effort: null` clears it; `mode` changes permissions. |
| `approval.respond` | `{ sessionId, requestId, approve: boolean }` | `{}` |
| `input.respond` | `{ sessionId, requestId, response }` | `{}` (as `respond_user_input`) |

A host refuses a session id that is itself a mirror, so tasks never hop twice.

### Starting a task on another computer

`task.start` on the host:

1. Refuses a provider that isn't installed there: `<Provider> is not installed on <host>.`
2. With `projectId`, uses that registered project directly (bot workspaces are refused). With
   `repo`, it finds a project whose `origin` is that GitHub repository (as
   `github_project_repos`, case insensitive). With none, it clones it with `gh` (as
   `github_clone_repo`, at most 6 minutes) into `~/PandaCode/<name>`, or `<name>-2`, `-3`… when
   taken, and adds the project.
3. Fetches `origin` (at most 90 s), then uses the viewer's branch if origin has it, otherwise
   origin's default branch. With a worktree it creates `pandacode/remote-<id>` from
   `origin/<branch>` the normal way. Without one, a fresh clone is checked out on that branch;
   an existing checkout is never switched: it runs in place only when it is clean, has no local
   agent running in it and is already on that branch (then it is fast-forwarded to origin when
   it can be). Otherwise the start is refused, for example `<host> has uncommitted changes in
   <project>. Start it in a Worktree instead.` (or `… has an agent working in …`, `… has
   <project> on <branch>, not <branch>.`).
4. Creates the task with the provider, model, mode and effort, adds it to the caller's
   subscription, and sends the prompt.

The host's worst case is about 9.5 minutes (clone, fetch and local git steps, each capped); the
viewer waits 3 minutes longer. A `task.start` runs beside the peer's ordered request queue (at
most 4 at once, then it queues), so a slow clone never delays that peer's other requests, which
stay in order.

### Model lists for another computer

A mirror's model picker lists the host's harnesses and models, not this computer's:
`list_providers` and `list_provider_models` take an optional `deviceId` and then ask that host
(`providers.list`, `providers.models`). This computer's own id, or an empty one, lists locally.
The viewer keeps each reply for 10 minutes per device (and per device and provider for models);
`force` asks again, and concurrent identical requests share one call. A device's lists are
dropped when it goes offline, comes back, changes hosting or is revoked, and on sign-out. Every
request, cached or not, first gets the usual errors for an unknown or offline
(`That computer is offline.`) host.

`remote_start_task` and a mirror's `configure_session` are refused here when the cached lists
show the provider isn't installed there (`<Provider> is not installed on <host>.`) or the model
isn't among its models (`<model> is not available for <provider> on <host>.`; `default` always
passes). With nothing cached the host decides, and it refuses a provider it doesn't have.

### Events

Push only; nothing polls. The host buffers the agent events of each subscriber's tasks and sends
each subscriber at most one `agent.events { events: [...] }` frame every 100 ms (more only when
the events pass the 180 KiB frame budget; an event over 120 KiB is cut). Consecutive text deltas
of the same message are merged, so streaming costs at most 10 frames a second per subscriber,
whatever the token rate. A subscriber more than 4096 events behind stops buffering until it
catches up at the run end. Each event is the host's raw `AgentEvent` (`sessionId`, `kind`, `text`,
`requestId`, `data`, `tool`), approval ids included.

At a run end the host queues `run.finished { sessionId, successful, stopped, text }` after that
run's last events. The viewer copies the new messages, ends the local turn, then emits the
`done` agent event with `text`, so the transcript reloads with everything in it.

The viewer re-emits each event as the window's ordinary `agent-event` with the mirror's *local*
session id (events for tasks it doesn't mirror from that host are dropped), and moves the row's
status (`approval`/`input_request` → waiting, their cancellations → running, any other event
→ running). A subscription reply catches up on what was missed: a status that changed, a run
that ended while this computer wasn't listening, and messages newer than `remote_synced_id`.

### Message copies

`task.messages` returns the messages after `afterId`, oldest first: at most 400 rows, kept
within 180 KiB of JSON, `hasMore` when more remain. Any message over 120 KiB is cut and ends with
`…[cut on the host to fit a remote page]` (JSON tool content is cut inside, so it still parses).
The viewer stores a page and advances `remote_synced_id` in one transaction, and skips a page
that no longer starts at the stored position (a concurrent copy got there first), so messages
are never copied twice. It follows `hasMore` for up to 50 pages per copy, and also takes the
host's title.

Known limit: a message the host rewrites in place after it was copied (a tool's status, say)
is not copied again.

Responses and events are handled as soon as they arrive and never wait behind a slow request.
Requests from one peer are answered in order, except `task.start` (above).

## Tauri commands (UI contract)

| Command | Args | Returns |
|---|---|---|
| `remote_status` | | `{ configured, signedIn, account?: { login, avatarUrl }, device: { id, name, fingerprint }, hostEnabled, connected }` |
| `remote_sign_in_start` | | `{ userCode, verificationUri, expiresIn }` |
| `remote_sign_in_finish` | | status (waits for the device flow, error on expiry, denial or cancel) |
| `remote_sign_in_cancel` | | status. Stops the device-flow poll. |
| `remote_sign_out` | | status |
| `remote_set_host_enabled` | `{ enabled?, fullAccess? }` | status (with `remoteFullAccess`). Sets Allow remote control and/or Full access for remote tasks. |
| `remote_devices` | | `[{ id, name, platform, fingerprint, host, online, lastSeen, current }]`, from presence (fetched only before the first presence frame) |
| `remote_revoke_device` | `{ deviceId }` | `{}` |
| `remote_targets` | | `[{ deviceId, name, platform, online }]`: other online devices with hosting on |
| `remote_repo_check` | `{ projectId }` | `{ repo: "owner/name" \| null, branch, ahead, dirty, pushed }`. `repo` is null without a GitHub `origin`; `ahead` is `rev-list --count @{u}..HEAD` (0 without an upstream); `pushed` is whether `origin/<branch>` exists. Local refs only, no network. |
| `list_providers` | `{ force?, deviceId? }` | as without `deviceId`, from that host (see Model lists) |
| `list_provider_models` | `{ provider, force?, deviceId? }` | as without `deviceId`, from that host |
| `remote_start_task` | `{ deviceId, projectId, prompt, provider, model, mode?, effort?, worktree?, branch?, sessionId? }` | the mirror `Session` plus `sessionId`. `branch` defaults to the checkout's. An empty New task draft without its own worktree passed as `sessionId` becomes the mirror; otherwise a new task is made. On failure nothing is left: a new row is deleted, a draft stays a draft. |

Window events: `remote://status` (status), `remote://presence` (devices), and for mirrors the
ordinary `agent-event` and `sessions-changed`.

The agent-event hook in `lib.rs` clones and allocates nothing while hosting is off or nobody
mirrors that task.

## Privacy

Listed in the README privacy table: remote access contacts GitHub (sign-in only) and the relay
(while signed in). Task content crosses the relay only encrypted end to end.
