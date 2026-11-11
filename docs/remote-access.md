# Remote access (PandaCode Connect)

Opt-in. Off by default. Signing in lets a task *run on another computer*: one of the user's
computers signed in to the same GitHub account, with **Allow remote control of this computer**
turned on. The task stays an ordinary task in the local sidebar and conversation pane, with the
same streaming, composer, approvals and model picker as a local one; there is no separate remote
view. Nothing is sent anywhere until the user signs in. A computer can also be an always-on
server with no screen or desktop app: `pandacode serve` ([headless](headless.md)).

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
  as for a local run. A mirror interrupted by this computer's restart takes H's status at the
  next subscription (and its messages are copied). A run end always copies the messages, even
  when the turn already ended here (Stop, an offline host).
- A subscribed task that H says no longer exists (`missing`) ends a running mirror as failed
  (`This task is no longer on <host>.`). A row left without `remote_session` by a start this
  computer quit during is a local draft again at the next launch.
- Approval and question cards follow H's `pending` list at each subscription: a card missing
  here (after a restart or a lost frame) is shown again, and one answered elsewhere is cleared.
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
- `DELETE /v1/account` → `{ ok: true }`: deletes all relay state for the account and closes its
  sockets with `4001 (signed out)`. Since tokens are accepted only for registered devices, all
  existing tokens become invalid; signing in again creates a fresh relay account.
- `POST /v1/token` → `{ token }`: a fresh 30-day token for the same account and device
- `POST /v1/push/devices` → `{ ok: true }`: registers a push device token for this device
  (`{ platform: "ios" | "android", token }`; up to 3 per platform). A revocation or account
  deletion drops the device's tokens with it.
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
  restarted has forgotten its subscribers). Frames within 250 ms share one round, except the
  socket's first presence, whose round starts at once: with it, the desktop asks the afterId
  page of up to 3 mirrors with messages copied (running ones first) right behind `subscribe`,
  and the phone does the same for its open threads, so a reconnect catches up in one round trip
  after the upgrade instead of two. One round
  runs at a time (a call during it runs one more after it), every host is asked at once, and a
  round in which a host with a running mirror failed is retried after 2 s, 4 s… up to 60 s.
- `{ kind: "undeliverable", ... }` (above)
- `{ kind: "error", error }`

Client → relay control: `{ kind: "host", enabled: boolean }` changes the advertised host flag
after connecting. A host can also send `{ kind: "notify", body: { kind: "waiting" | "finished",
count } }`: the object coalesces these (30 s window, halved when the waiting count grows) and
pushes a generic notice — counts and a deep link, never task text — to every push token the
account's phones have registered via `POST /v1/push/devices`. `"ping"` gets `"pong"` as a
hibernation auto-response.

Presence is the device list: the desktop takes devices, names and keys from it and never fetches
on connect or for an unknown sender. A device missing from presence is removed, and its event
subscription with it.

Close codes: `4000` (replaced by a newer socket) makes the client wait at least 60 s before it
reconnects. `4001` (device revoked) signs this computer out locally. Otherwise the client
reconnects at once, then after 1 s, doubling to 60 s, each wait spread over 75–125 %. The
backoff starts over only after a socket stayed up for 30 s or more, or after a wake. The phone
(`mobile/src/store/backoff.ts`) follows the same schedule.

The desktop keeps one rustls client config for every connect, so a reconnect resumes the TLS
session: no certificate chain is sent or checked again (bytes and CPU, not a round trip). TLS
1.3 0-RTT early data is not used. The upgrade request carries the bearer token, and a replay
of it would let anyone on the path replace the device's socket at the relay (close `4000`, which
then waits 60 s), so a replayable upgrade is not safe; the relay would also need Cloudflare's
0-RTT zone setting.

The client pings every 25 s and treats the socket as dead when nothing arrives within 10 s of a
ping, or when a frame can't be written within 10 s. Every 2 s it compares the wall clock with
the monotonic one (which, like tokio's timers, stands still while the computer sleeps); a jump
of more than 10 s means it slept, and it reconnects at once. At most 512 frames wait for the
socket; past that a send fails at once (`Too much is waiting to go to the relay.`).

The phone (`mobile/src/connect/relay-socket.ts`) pings every 30 s and treats the socket as dead
when no answer arrives within 10 s (there is no longer a silence rule of its own). A user action
made while the socket waits out a backoff calls `kick()`: the socket connects at once and the call
waits up to 10 s for presence before failing (`whenConnected` in `client.ts`); background calls
don't kick. `useConnectionQuality()` / `<ConnectionDot/>` (`mobile/src/ui/ConnectionQuality.tsx`)
show the socket's state and last ping round trip ("Connected, 120 ms").

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
| Idle socket | kept (hibernated). The desktop pings every 25 s, the phone every 30 s (10 s to answer). | |

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

**Packed frames.** Requests from current viewers carry `z: 1`: the sender opens packed frames.
The host remembers this per device (in memory) from each fresh request (a stale or repeated one
changes nothing) and forgets a device that leaves presence; an older app's requests lack it and
turn packing off again. A reply is packed by its own request's `z`, never by what the host
remembers when it is sent. To such a peer, a reply or event whose JSON plaintext is
over 1 KB is sealed as `"z"` + raw deflate (level 6) when that is smaller. JSON plaintexts
start with `{`, so `open` tells the two apart. Inflated output is capped at 2 MB (the largest
real frame, a 1 MiB messages page, is about 1.05 MB). Requests are never packed; a host drops a
packed request. The relay and direct links carry the same sealed body. A real 178 KB
messages page deflates to 16 % (29 KB).

A host answers requests from other devices listed in its account presence only while **Allow
remote control** is on. Otherwise it returns
`{ ok: false, error: "Remote control is off on this computer" }`. A host still applies its own
approval policy: remote prompts get no more power than local ones. Access (remote control on, the
sender in presence, replay) is checked again when a queued request runs, not only when it arrives.

**Full access for remote tasks** (`remote_full_access` in `remote.json`, off by default): while
off, `task.start` without a mode starts in `ask` and makes a plain task: the saved default agent
team is not applied (its workers would run with full access), so no team is started remotely; an explicit `full` in `task.start` or
`task.configure`, and any `task.send`, `task.steer` or mode-less `task.configure` on a task whose
stored mode is `full`, are refused with `Full access is off for remote tasks on <host>.` A task
that leads an agent team (one with a team configured, active or not) is also refused for
`task.send`, `task.steer` and `task.teamResume`, whatever the lead's own mode, with `Team workers
run with full access; allow full access for remote tasks to drive a team remotely.`: team workers
always run with full access ([architect-workers.md](architect-workers.md)). The same sentence
refuses `recipes.run` on a team lead, a `queue.update` of a lead's queued prompt (and a headless
host's queue drain into one), `usage.clearLimit` and `usage.resumeAtReset {on: true}` on a lead,
`thread.setStage` and `thread.archive` (either way) on a lead (a stage change can wake the lead),
`thread.setGoal` on a lead (the lead reads its goal like a prompt), an `approval.respond` with
`approve: true` or an `input.respond` that answers a lead's question (an answer steers the lead
like a prompt; `approve: false`, and a response that only cancels or declines, `{action: "cancel"
| "decline"}` or a questions form with no answers, stay allowed so a phone can still stop it),
`bot.message` when the bot's desktop thread leads a team, `bot.runSchedule` when its scheduled-work
thread does, a `bot.failoverDecide` that runs a held lead's turn, a `schedules.create`/`update`, `runNow` or enable that
targets one (a schedule last saved from a remote device is checked again each time it fires: if its
thread has since come to lead a team and the switch is off, the run is recorded as skipped with the
reason, `schedules::remote_team_gate`; saving it again on the desktop clears the mark; which turns a phone drove is not recorded, so while this computer hosts remote devices an agent's `pandacode_schedule_message` to another thread gets the same mark and gate, and its `pandacode_queue_message` or `pandacode_steer_task` into a different thread that leads a team is refused as a tool error (`agent_tools::allow_cross_thread_team`)), an `orchestration.respond` that accepts a lead's link request (`links::allow_remote_accept`; declining stays allowed), and every `team.start` (listed in `fullAccessSwitch`); `chat.start` and
`github.startTask` make their task without the saved default team, and so does `worktree.create`
when it makes a new task for a started one (`start::parse` leaves `team`
off; only a caller that saw the switch turns it on). A `btw.ask` side thread never gets the saved
default team, with or without the switch, as on the desktop. Reports from threads a lead
launched on linked computers ([machine-orchestration.md](machine-orchestration.md)) still wake
the lead (`orchestrate::wake`) whatever the switch: the lead started those threads itself, so their
reports are its own work coming back, not a remote prompt. This prevents
accidents; it is not a boundary against a device that can also answer a plain task's approvals.
Shells sit beyond any task's mode, so while it is off `terminal.list`, `terminal.open`,
`terminal.read`, `terminal.write` (a shell's scrollback holds whatever was typed or printed),
`terminal.resize`, `terminal.close`,
`runScript.start`, `runScript.stop`, `checks.run` (the repo's check commands, run with no approval step) and
`files.write` are refused (`Turn on Full access for remote tasks on this computer to use the
terminal.`, `… to run scripts.`, `… to run checks.`, `… to edit files.`), and
`orchestration.respond` may not link another computer with `full` access. `host.hello` lists these
methods as `fullAccessSwitch`, so a phone hides them and says why before calling.

**Round-3 gates** (what a phone below the needed grant, or with the switch off, sees):

- **Terminals:** one phone may have at most 4 shells open on a computer (`MAX_PHONE_TERMINALS`);
  a fifth `terminal.open` is refused with `This phone already has 4 terminals open on this
  computer. Close one to open another.` Opens still starting count, and a failed one frees its slot.
- **Bots:** `bot.detail` to a `view` device is limited: `schedules`, `rules` and `memories` are
  empty lists, `memoryCount`, `scheduleCount` and `ruleCount` carry their sizes, and `limited:
  true` is set. The phone shows the counts with an access note instead of empty sections.
- **Git:** ordered-lane git calls (`git.stage`, `git.switchBranch`) never wait behind a background
  one (`git.commit`, `git.push`, `worktree.merge`, `pull.create`) on the same checkout: they are
  refused with `Another git change is still running on this checkout.` so Stop is never held up.
- **Secret files in diffs:** below Full, `task.diff` leaves out secret files' sections and counts
  them in `hiddenSecrets` (the phone notes "N files hidden — secret files need Full access"), and
  a `task.diff` with a secret `path` or a `turn.diff` of a secret file (or a rename from one) is
  refused with `This file may hold secrets. Give this phone Full access on the computer to …`;
  the phone shows that as a note rather than an error to retry.

**Round-4 gates:**

- **Repository hooks:** a hook is any program the checkout names (`.git/hooks`, `core.hooksPath`),
  so with "Full access for remote tasks" off, `git.commit`, `git.push`, `worktree.merge` and
  `pull.create`'s push run with `-c core.hooksPath=/dev/null` (and `--no-verify` on commit, push
  and merge): no hook runs (`workspace::Hooks::Skip`, `methods/git.rs` `hooks_for`). With the switch
  on they run hooks as the desktop does. `git.switchBranch` never runs hooks (no `post-checkout`).
- **Secret files in diffs** use `files.rs`'s whole rule: names (`SECRET_FILES`), folder and name
  (`.kube/config`, `.docker/config.json`) and a symlink resolving to either, for a `path` refusal
  and for patch filtering alike. `task.pullDiff` with a `path` follows it too below Full: a secret
  `path` is refused and a section naming a secret file (a rename from one) is dropped and counted in
  `hiddenSecrets`.
- **`.git` paths:** `path_param` refuses a `.git` segment in any case (`.GIT`, `.Git`), since macOS
  and Windows file systems treat them as one folder.
- **`routing.status`** (View) never sends the router's error text (it can name folders on the
  computer): `error` is a fixed sentence and `failed: true`, as `settings.routing`.
- **`skills.activate`** also needs the switch (`Turn on Full access for remote tasks on this
  computer to change skills.`): a skill's instructions reach every task of its harness or project,
  Full access ones included. It is in `fullAccessSwitch`.
- **One send at a time per task:** `task.send` (ordered lane), `recipes.run` and
  `schedules.runNow` (background lane) each take the task's send lock (`host::task_send_lock`,
  re-exported from `methods/mod.rs`) around "is it busy? then queue or send", so two can't both
  see the task idle and both start a turn. A lock rather than moving them to the ordered lane: a
  recipe or schedule may wait on its harness to start, and the ordered lane must stay free for
  Stop. Holders keep it only for the check and the send (which returns once the turn starts), so
  a `task.send` waits at most that long.
- **Writes that must not run twice** (`github.comment`, `pull.create`, `recipes.run`,
  `schedules.runNow`, `host::ONCE_METHODS`) take an optional `sendId`, deduped like a prompt's (see
  "Repeated prompts"), keyed by calling device, method, target (task, schedule, or project and
  number) and id. Hosts that do this list `actionSendId` in hello `features`.

**Round-5 gates:**

- **Programs in the repository's git config:** skipping hooks is not enough, since Git also runs
  programs the checkout's own config names. With the switch off, `git.stage`, `git.commit`,
  `git.push`, `worktree.merge` (both checkouts) and `pull.create`'s push first read
  `git config --local` and `--worktree` (`workspace::refuse_repo_config_programs`) and refuse with
  `This repository's git config runs programs (<keys>); turn on Full access for remote tasks on
  this computer to commit from the phone.` when any of these is set there:
  `filter.<x>.clean|smudge|process`, `diff.<x>.textconv|command`, `diff.external`,
  `merge.<x>.driver`, `gpg.program`, `gpg.<fmt>.program`, `core.sshCommand`, `core.askPass`,
  `core.gitProxy`, `core.fsmonitor` naming a program (the built-in `true` runs nothing),
  `credential[.<url>].helper`, `include.path`, `includeIf.<cond>.path` (they pull in other config),
  `remote.<x>.receivepack|uploadpack`, an `ext::` remote URL and `protocol.ext.allow`. Only
  repository-local config is untrusted; the user's global and system config are their own. A
  config too large to read is refused too. Desktop actions, and phones with the switch on, are
  unchanged.
- **Images on a failed send:** `task.send` claims its uploaded images, and gives them back to the
  sender (`images::restore`, fresh expiry) if the message is neither sent nor queued, so a retry
  under the same `sendId` still finds them instead of failing with "image missing".
- **Expired copies of a running send:** a request that waited in the device's lane past its
  expiry is refused `NOT_RUN` only if its `sendId` is unknown. One whose first copy is still
  running (`sends_in_flight`) counts as sent, as one with a remembered answer does, so it goes
  through and waits for the first's answer (`host::already_sent`).
- **`recipes.run` partial failures:** once a step was sent or queued, a later step's failure is a
  success `{ sent, queued, partialError }`, so `once_per_action` remembers it and a retry under the
  same `sendId` does not send the first steps again. A failure before any step went is an error.
- **Bots in `full` mode:** `bot.message`, `bot.runSchedule` and `bot.pairingDecide` with
  `approved` (approving a sender lets it drive the bot) are refused with `Full access is off for
  remote tasks on <host>.` while the switch is off and the bot's mode is `full`
  (`methods/admin.rs` `allow_bot_mode`). Blocking or removing a sender is always allowed.
- **Text agents read:** `thread.setGoal` on a task in `full` mode, and `design.comment` on such a
  task (or, for a `projectId` target, a project whose shared checkout has a `full` task without a
  worktree) need the switch, as `task.send` does.
- **Artboard previews** also drop the SVG animation tags `set`, `animate`, `animateMotion` and
  `animateTransform`, which can rewrite an attribute (a link's `href`) after sanitizing.
- **`.git` paths** are also refused under Windows spellings: trailing dots or spaces (`.git.`,
  `.git `), an NTFS stream suffix (`.git::$INDEX_ALLOCATION`) and the short name `git~1`, in any case.
- `files.write`'s running-task check canonicalizes paths off the async runtime (`crate::blocking`).
- **What the switch is not:** it gates PandaCode's own `full` mode. Harness modes that skip
  approvals under another name (Kimi's `auto`, which maps to its yolo mode, and similar) are not
  `full`, so a device that may set such a mode on such a harness can run without approvals even
  with the switch off. Treat the switch as a guard against accidents, not a boundary against a
  device you would not trust with those modes.

**Round-6 gates:**

- **Repository config is an allowlist, not a denylist.** Round 5's list of program-running keys
  missed `url.<base>.insteadOf`/`pushInsteadOf` rewriting a remote to `ext::`, a top-level
  `protocol.allow=always`, `gpg.ssh.defaultKeyCommand` and `core.alternateRefsCommand`. With the
  switch off, `workspace::refuse_repo_config_programs` now refuses (same message as before) unless
  *every* `git config --local` and `--worktree` entry is one `workspace::config_entry_is_inert`
  knows runs nothing: `core.{repositoryformatversion, filemode, bare, logallrefupdates,
  ignorecase, precomposeunicode, symlinks, autocrlf, eol, safecrlf, worktree, sparsecheckout,
  sparsecheckoutcone, untrackedcache, checkstat, trustctime, quotepath, hookspath}`, a boolean
  `core.fsmonitor`, `remote.<x>.{url, pushurl}`, `submodule.<x>.url` and
  `branch.<x>.{remote, pushremote}` when they are a plain `https`/`http`/`ssh`/`git`/`file`
  (`git+ssh`, `ssh+git`) URL, `host:path`, a local path or a remote name (never `<helper>::`,
  `ext::`, another scheme, which would start `git-remote-<scheme>`, or a leading `-`),
  `remote.<x>.{fetch, push, tagopt, prune, prunetags, mirror, promisor, partialclonefilter,
  skipdefaultupdate, skipfetchall}`, `branch.<x>.{merge, rebase, description}`,
  `submodule[.<x>].active`, `user.{name, email}`, `pull.{rebase, ff}`,
  `push.{default, autosetupremote}`, `init.defaultbranch`,
  `extensions.{worktreeconfig, objectformat, refstorage, partialclone}`, `fetch.{prune, prunetags}`,
  `gc.*`, a boolean `commit.gpgsign` (signing uses the user's own global gpg settings) and the
  `git lfs install` keys `lfs.repositoryformatversion` and `lfs.<url>.access`. Anything else
  (filters, drivers, `gpg.*`, `url.*`, `protocol.*`, `include*`, `credential.*`, `core.sshCommand`,
  `core.editor`, keys Git adds later) refuses. `core.hooksPath` and `core.fsmonitor` are allowed
  only because every hooks-skipped call overrides both.
- **Transport overrides on every hooks-skipped Git call** (`workspace::git_global_args(false)`, so
  phone commits, pushes, merges and worktree adds, and the desktop's read-only inspection):
  `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never
  -c protocol.https.allow=always -c protocol.http.allow=always -c protocol.ssh.allow=always
  -c protocol.git.allow=always -c protocol.file.allow=user -c protocol.ext.allow=never`
  (Round 7: `protocol.file.allow=never`).
  Command-line config outranks every file, so even a config that slipped past the allowlist cannot
  reach `ext::` or a remote helper (tested with the reviewer's `insteadOf` exploit). HTTPS, SSH
  and local-path remotes keep working; `GIT_PROTOCOL_FROM_USER` is not set to 0 (PandaCode removes
  every inherited `GIT_*`), because that would also refuse a local-path remote the user pushes to.
  Desktop actions that run hooks keep the user's own transports.
- **Refusal before any status:** `pull.create` (`push_and_open_pull`) and `git.stage {all}` check
  the config before their `git status` (a status refresh can run clean filters), and
  `git.switchBranch` checks it too (a checkout runs smudge filters).
- **`git.status` with the switch off** does not refuse: for a checkout whose config fails the
  allowlist it runs `git status` with every filter the checkout's own config defines switched off
  (`-c filter.<x>.clean= -c filter.<x>.smudge= -c filter.<x>.process= -c filter.<x>.required=false`)
  and `--ignore-submodules=all` (`workspace::git_status_untrusted`); a filter name Git cannot take
  on the command line refuses with a clear message. Allowlisted checkouts get the usual status.
- **Bots:** `bot.failoverDecide` with `send`, or with `wait` on a limit with a known reset (it
  resumes the turn then), and `bot.remember` (a memory goes into every turn) need the switch for a
  bot in `full` mode (`allow_bot_mode`). Dismissing a hold does not.
- **`design.comment` on a task target** without a worktree of its own also checks the shared
  checkout (`shared_checkout_allows`), as a project target does.
- **Secret files** also include `id_ecdsa*`, `id_dsa*`, `*.pfx`, `terraform.tfstate*`,
  `.yarnrc.yml`, anything under a `.ssh/` folder and `gh/hosts.yml`.
- **More once-methods:** `worktree.create`, `thread.fork` and `rewind.to` join
  `host::ONCE_METHODS` (target: the task, or `<sessionId>@<messageId>` for a fork or rewind).
  Hosts list `forkSendId` in hello `features`; the phone sends a `sendId` and retries a lost reply
  only then (`api/rewind.ts` `hostCallForkOnce`). `git.commit` always gets a long deadline on the
  phone (60 s, 90 s with `push`).
- **Background deadlines:** a background-lane call still queued past the phone's own timeout for it
  (`methods::background_timeout`, less 2 s) is refused `NOT_RUN` instead of running after the phone
  gave up (a `btw.ask` behind `checks.run` and `git.push`, or a non-once call run again by a manual
  retry). Only queued calls expire; a running one finishes. A once-method whose `sendId` already
  ran, or runs now, still gets the first answer.
- **Background once-methods:** `btw.ask` (target: the task), `vm.start`/`vm.stop` (the VM name) and
  `moodboards.add` (`<projectId>/<board>/<imageId>`) join `host::ONCE_METHODS`. Hosts list
  `backgroundSendId` in hello `features`; the phone sends a `sendId` and retries a lost reply only
  then (`api/composer.ts` `hostCallBackgroundOnce`), so a `moodboards.add` retry answers the first
  add instead of "image missing". The phone waits 60 s for `vm.start`/`vm.stop`.
- **Saved-then-failed prompts:** if `task.send` saved the user message but the harness then failed
  to start, `once_per_send` remembers the error (`host::saved_failure`), so a retry under the same
  `sendId` answers it instead of saving the prompt twice. Other failures are still not remembered.
- **Images:** `images::Uploads::restore` never fills past `MAX_READY` waiting images per sender;
  `team.start` and `chat.start` give claimed images back when they fail before the images are used.
- **Reconnects:** only a user-initiated call (`client.ts` `userInitiated`: not background, not an
  automatic refresh or poll such as `subscribe`, `tasks.list`, `task.messages`, `host.hello`)
  cuts the socket's reconnect backoff short with `kick()`.

**Round-7 gates** (each with a real-git regression test that first reproduces the exploit):

- **Submodules.** A submodule carries its own config (`.git/modules/<x>/config`, filters
  included) that the top-level allowlist never reads. With the switch off, every phone status and
  diff (`git.status`, `git.stage {all}`, `task.changes`, `task.diff`, through
  `workspace::git_status_untrusted`/`git_diff_untrusted`, allowlisted checkouts included) passes
  `--ignore-submodules=all` and `-c diff.ignoreSubmodules=all -c status.submoduleSummary=false
  -c submodule.recurse=false -c push.recurseSubmodules=no -c fetch.recurseSubmodules=false`
  (`SKIP_SUBMODULES`, also on every hooks-skipped commit, merge and push). Commits, pushes,
  merges, pull requests and `worktree.create` refuse a checkout with submodules (`.gitmodules`, or
  a `modules` folder in its Git directory) while the switch is off
  (`workspace::refuse_untrusted_programs` → `refuse_submodules`). `task.pullDetect` reads only the
  branch name (`symbolic-ref`), never a full status.
- **No local-path or `file://` remotes with hooks skipped.** `git-receive-pack` clears
  `GIT_CONFIG_PARAMETERS`, so a push into a local repository ran *its* receive hooks. The
  hooks-skipped transports now say `-c protocol.file.allow=never`, and the allowlist takes
  `remote.<x>.{url, pushurl}`/`submodule.<x>.url` only as a plain network URL (`https`, `http`,
  `ssh`, `git`, `git+ssh`, `ssh+git`) or scp-like `host:path` (a one-letter host is a Windows
  drive), and `branch.<x>.{remote, pushremote}` only as a plain remote name (not `.`, nothing
  path-like) or such a URL. This replaces Round 6's "local-path remotes keep working".
- **Includes.** A phone status or diff with the switch off refuses a config with any `include.*`
  or `includeIf.*` key: the filters an included file defines are not in the local listing, so they
  could not be switched off.
- **Clones** (`projects.clone`) claim their folder with `create_dir` (taken: try `<name>-2`, … up to
  1000 names) before cloning into it, so clones of `a/x` and `b/x` started together never share
  `~/PandaCode/x`, and a failed clone removes only the folder it created.
- **`search.threads`** needs at least 3 characters, scans only the newest 50,000 messages, is
  interrupted after 5 s, and reads on its own read-only SQLite connection (WAL) instead of holding
  the store lock (in-memory stores fall back to the lock, with the same bounds).
- **Secret files** also include `application_default_credentials.json`, `*-credentials.json`,
  `service-account*.json`/`service_account*.json` and `.aws/config`.
- **`files.write` retries:** when `baseHash` no longer matches but the file already holds exactly
  the new text (the first save landed and its reply was lost), the write answers success with the
  file's hash instead of a conflict.
- **Running agents:** `git.commit` from the phone is refused while the task's agent runs, and both it and
  `worktree.merge` check again after acquiring the checkout lock (an agent may start while they
  wait for it).

**Round-8 gates** (each with a regression test; the Git ones use real git and first reproduce the exploit):

- **No lazy fetch, credential helper or askpass while reading.** In a partial clone
  (`remote.<x>.promisor=true`, `extensions.partialClone`) a `task.diff` with the switch off fetched
  missing blobs through the repository's own `core.sshCommand` (a marker-file test showed it). A
  hooks-skipped status or diff now refuses a local config with `core.sshCommand`, `core.askPass`,
  any `credential.*`, a non-empty `extensions.partialClone` or a `remote.<x>.promisor` that is not
  false (`workspace::network_program_key`), and every hooks-skipped phone call runs with
  `GIT_NO_LAZY_FETCH=1` and `GIT_TERMINAL_PROMPT=0` (`UNTRUSTED_ENV`). Calls that need no network
  (status, diff, upstream, ahead/behind, commit, merge) also pass `-c credential.helper= -c
  core.askPass=` (`UNTRUSTED_ARGS`); a phone push keeps the user's global credential helper (the
  allowlist already refuses local `credential.*` and `core.sshCommand` before it runs).
- **No raw Git commands.** `git.status`'s upstream lookup and `task.changes`' ahead/behind go
  through `workspace::git_inspect` (the bounded runner, hooks skipped, and with the switch off the
  same untrusted options and refusals as status).
- **jj.** `settings.jj` with the switch off runs `jj --ignore-working-copy --config
  signing.behavior=drop --config fsmonitor.backend=none --config ui.paginate=never` (no
  working-copy snapshot, so no commit is written or signed), and only a `.jj` in the target folder
  itself counts, never one in a parent folder (`jj::status_untrusted`).
- **Slash-command discovery** starts `claude -p` in the task folder with `--settings` holding
  `disableAllHooks: true` for every Claude-family harness (plain Claude, GLM, MiMo), which turns
  off the hooks a project's `.claude/settings.json` names during discovery. It does not stop the
  harness reading the rest of the project's config; Round 11 narrows that further.
- **`thread.setStage`** checks the task's mode like a prompt (a `full` task needs the switch):
  reopening a task calls `orchestrate::retry`, which can wake its agent.
- **Secret files** also include anything under `.gnupg/`, `.vault-token`, `.s3cfg`, `.boto`,
  `auth.json` and `*.ovpn`.
- **Idempotency.** `git.commit` and `bot.runSchedule` take `sendId` like the other
  `ONCE_METHODS` (targets: the task; the bot and schedule). `team.start` requires `startId`
  (`Missing startId.`), like `chat.start`. `rewind.to` runs in the background lane. The diff paths'
  secret checks (`secret_path`, which canonicalizes) run inside `crate::blocking`.

**Round-9 gates** (the Git ones with real-git regression tests, `GIT_CONFIG_GLOBAL=/dev/null`, that
first reproduce the exploit with the desktop's own call):

- **One trust parameter, failing closed.** Every Git helper in `workspace.rs` that PandaConnect code
  can reach takes a `workspace::Trust`: `Desktop`, or `Phone { full_access }` from the host's switch
  (`methods/git.rs`' `trust_of`, `host.rs`' `Trust::phone(full_access)`). That covers `git_status`,
  `git_diff`, `git_stage`, `git_commit`, `git_push`, `git_branches`, `git_switch`, `current_branch`,
  `worktree_status`, `merge_worktree`, `remove_worktree_for`, `create_worktree_for`, `git_inspect`
  and `refuse_untrusted_programs`, and the `lib.rs` wrappers the methods call (`stage_files`,
  `task_branches`, `switch_branch`, `task_worktree_status`, `remove_task_worktree`,
  `merge_task_worktree`, `push_and_open_pull`). The desktop's Tauri commands pass `Desktop`, and a
  Full-access phone is treated the same (behaviour unchanged). For an untrusted phone (switch off) each
  operation decides a `Gate` once, before its first Git call. `Gate::read` (status, diff, branches,
  upstream, worktree status) uses `untrusted_inspection_args`: it refuses `core.sshCommand`,
  `core.askPass`, `credential.*`, partial clones and includes, and switches the checkout's filters
  off. `Gate::change` (stage, switch, commit, push, merge, worktree create and remove) runs
  `refuse_untrusted_programs` (every local key on the allowlist, no submodules). Every closed call
  also gets `UNTRUSTED_ENV` (`GIT_NO_LAZY_FETCH=1`, `GIT_TERMINAL_PROMPT=0`), `UNTRUSTED_ARGS`
  (`credential.helper=`, `core.askPass=`; not for a push), `MAINTENANCE_OFF` (`-c
  maintenance.auto=false -c gc.auto=0`), `core.hooksPath=/dev/null`, `core.fsmonitor=false`, the
  protocol overrides, `SKIP_SUBMODULES`, and `--ignore-submodules=all` on status. Child processes
  (`worktree remove`'s internal status, for example) inherit the `-c` options and the environment.
  `workspace::tests::remote_git_calls_always_pass_a_trust` fails when a helper loses its `Trust`
  parameter, or when `remote/methods/*.rs` or `remote/host.rs` calls one without a trust argument,
  calls `run_git*`, `Command::new("git")`, the desktop-only `create_worktree_with` /
  `remove_worktree` / `recreate_worktree`, or a desktop Tauri Git command. It scans
  `remote/start.rs` too, where the desktop's trust appears only in `start::git` (the viewer's own
  checkout, for `remote::mirror`) and the `#[cfg(test)]` wrappers `remote::bench` uses.
- **Starts.** `task.start` and `github.startTask` (both through `remote/start.rs`) carry the caller's
  trust in `Start::full_access`: `host::cap_mode` sets it to the switch as it was when the request
  was admitted (and `run_one` fills it for a start inside a `batch`), so a switch flipped while the
  start waits for its lane changes nothing (`a_start_keeps_the_full_access_switch_from_its_admission`;
  only a `Start` built without either still reads the switch when it runs). With the switch off, `prepare` runs `refuse_untrusted_programs` before the first Git call,
  then every fetch, lookup, checkout, `merge --ff-only` and `reset --hard` goes through
  `workspace::git_change` (`Gate::change`; a fetch keeps the user's global credential helper, as a
  push does) and every worktree through `create_worktree_for` / `remove_worktree_for`. With it on
  (and on the desktop) `git_change` runs plain Git as before.
  `start::tests::an_untrusted_phone_start_runs_no_program_from_the_checkouts_config` checks that a
  smudge/clean filter and a `gc.recentObjectsHook` in the checkout's config refuse every
  worktree-start step and never run, while the Full-access and desktop worktree runs the filter.
  `team.start` refuses worktrees and branches and runs no Git itself, but its workers' worktrees of
  the project's checkout are made by `architect_start_in_project` with Desktop trust, so with the
  switch off it runs `refuse_untrusted_programs` on that checkout before claiming images or making
  the task (`team::tests::an_untrusted_phone_cannot_start_a_team_in_a_checkout_whose_config_runs_programs`);
  `cloud.start` needs Full
  access; `chat.start` uses a chat folder; `projects.clone` and a start's clone are fresh `gh repo
  clone`s, whose config is Git's own.
- **`gh` running Git.** `gh` runs `git` in the checkout itself (to find the repository, or for `pr
  create`, `pr checkout`, `repo clone`). For an untrusted phone,
  `crate::github::run_gh_as(root, args, timeout, trust)` (with `search_as`, `view_as` and
  `repository_as`; the desktop's `run_gh`, `search`, `view` and `repository` are these with
  `Trust::Desktop`) hands that Git
  `workspace::tool_git_env`: `UNTRUSTED_ENV` plus `GIT_CONFIG_COUNT`/`KEY`/`VALUE` for
  `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `protocol.ext.allow=never`,
  `protocol.file.allow=never`, `maintenance.auto=false` and `gc.auto=0` (environment config outranks
  every config file, like `-c`; tested with real git by
  `workspace::tests::tools_running_git_for_an_untrusted_phone_inherit_the_closed_gate`).
  The phone's callers: `methods/github.rs`' `gh_in` (`github.item`, `github.comment`,
  `github.startTask`'s issue lookup), `github.search` (`search_as`) and `task.pullDetect`'s
  repository lookup (`repository_as`);
  `github::tests::phone_gh_calls_carry_the_hardened_git_env_and_desktop_calls_do_not`.
  `pull.create` already refuses first through `push_and_open_pull`. `github_pull.rs` has the same
  split: `detail_as`, `diff_as`, `detect_as`, `lookup_as` and `merge_as` take the trust, and the
  desktop's `detail`, `diff`, `detect`, `lookup` and `merge` are these with `Trust::Desktop`.
  `task.pull`, `task.pullDiff`, `task.pullMerge` and `task.pullDetect` pass
  `Trust::phone(full_access)` (through `host.rs`' `pull_detail_cached` / `pull_diff_cached` /
  `detect_pull`). `task.pullMerge` (Full) with the switch off is refused first by
  `workspace::refuse_untrusted_programs` inside `merge_as`, since `gh pr merge` may run Git to
  update the local branch. `github_pull::tests::remote_code_reaches_pull_requests_only_with_a_trust`
  fails if `remote/` calls a plain variant or an `_as` call passes no trust.
- **Calls that had no protection.** `git.branches` (View) and `pull.create`'s default base ran
  `for-each-ref --sort=-committerdate`, which in a partial clone fetches a missing commit lazily
  through the checkout's `core.sshCommand`. `worktree.status` (View) ran a status (clean filters)
  plus rev-list and merge-base (lazy fetch). `worktree.remove` (Full) had no refusal at all, though
  `worktree remove` runs a status inside the checkout and `branch -d` reads commits. All four now go
  through the gates above, and `task.pullDetect`'s branch lookup does too.
- **Narrower allowlist.** `gc.*` is no longer allowed wholesale: `gc.recentObjectsHook` is a shell
  command. Only `gc.auto`, `autoPackLimit`, `autoDetach`, `reflogExpire`, `reflogExpireUnreachable`,
  `pruneExpire`, `worktreePruneExpire`, `packRefs`, `aggressiveWindow`/`aggressiveDepth`,
  `bigPackThreshold` and `logExpiry` pass, plus the per-ref `gc.<pattern>.reflogExpire*`.
  `core.worktree` is off the allowlist. Auto maintenance is off for every untrusted call, so a gc hook
  in the user's own config never runs after a phone commit either (tested with
  `maintenance.strategy=gc`, `gc.auto=1`, `gc.pruneExpire=now` in a test global config).
- **Stricter than before.** An untrusted `git.stage` and `git.switchBranch` now also refuse a
  repository with submodules, and a closed `Gate::read` refuses a partial clone even where the
  allowlist alone would have let a change through.
- **Discovery.** `moodboards.add` checks the switch, so `host.hello` lists it in `fullAccessSwitch`.
- **Not covered yet:** `remote/start.rs` (`task.start` from a paired computer) still runs raw `git`
  through `workspace::run_process` and calls the desktop-only `create_worktree_with` /
  `remove_worktree`. The `gh` CLI that `github.rs` starts runs its own `git`.

**Round-10 gates** (each with a regression test; the Git ones use real git with
`GIT_CONFIG_GLOBAL=/dev/null`):

- **Diff prefixes are fixed.** A checkout's own `diff.srcPrefix`/`diff.dstPrefix`, `diff.noprefix`
  or `diff.mnemonicPrefix` rewrote the `diff --git` line the host's secret-file filter reads, so a
  `.env` change reached a View phone. `workspace::diff_with` (tracked, staged, and the untracked
  `--no-index` preview) now always runs `-c diff.noprefix=false -c diff.mnemonicPrefix=false diff
  --src-prefix=a/ --dst-prefix=b/`, for the desktop and every phone
  (`diffs_always_name_files_with_a_and_b_prefixes`). `host.rs`' `without_secret_patches` also checks
  each section's `---`/`+++` header lines (before its first hunk) and its `rename`/`copy` lines
  (`diffs_with_odd_prefixes_still_leave_out_secret_files`).
- **No clones with the switch off.** A fresh clone brings the repository's own harness config
  (`.claude/settings.json` hooks, `.opencode/plugin`…), which an agent started in it runs without
  anyone approving it. With the switch off, `projects.clone` refuses before claiming a clone, and a
  start whose `repo` this computer has no project for refuses in `start::project_for` before any
  clone ("Turn on Full access for remote tasks on this computer to clone a repository from the
  phone.", `start::refuse_clone`). That covers `task.start` with a `repo` and every start built on
  it; `github.startTask` always names an existing `projectId`, so it never clones. A start whose
  `repo` matches an existing project, and every start by `projectId`, is unaffected.
  `projects.clone` is in `fullAccessSwitch`; `task.start` is not, since only its clone path refuses.
- **slash.list below Control.** Discovery starts the harness in the project, so a View device's
  cache miss gets `slash_commands::snapshot` (the latest known catalog, else the local actions)
  instead (`composer::tests::view_devices_never_launch_slash_discovery`). Control devices (and
  `force`, which needs Control) still run discovery.
- **Refusals name the action.** The untrusted-config refusal ends "…to <action> from the phone."
  with the request's own action (`stage files`, `switch branches`, `commit`, `push`, `start a task`,
  `create a worktree`, `merge a worktree`, `remove a worktree`; `use Git on this checkout` from
  callers that name none), and so does the submodule refusal of `Gate::change`. A `git.stage` or
  `git.switchBranch` on a checkout another git change holds reads "Another git change is running on
  this checkout — try again in a moment."
- **`core.worktree` in the read gate.** `Gate::read` refused programs and network keys but let
  `core.worktree` point status and diff at a folder outside the project. It now refuses it, as the
  change allowlist already did (`hooks_skipped_reads_refuse_a_moved_worktree`).

**Round-11 gates** (each with a regression test):

- **Reopening checks the task's mode.** `thread.archive` with `archived: false` calls
  `set_task_stage`, whose `orchestrate::retry` can wake the agent, so it now runs
  `allow_task_mode` first, always: a `full` task needs the switch to be settled or reopened
  (`threads::tests::archiving_or_reopening_checks_the_task_mode_first`).
- **Slash discovery needs Control and the task's mode.** Discovery starts the harness inside the
  project, so `slash.list` (and `slash.resolve`, through `slash_commands::resolve_known`) only
  run it for a Control device whose task mode passes `allow_task_mode` (a `full` task needs the
  switch); everyone else gets `slash_commands::snapshot`, the latest known catalog. A `force`
  that may not discover is refused. Claude discovery also passes `--setting-sources user` (no
  project or local `.claude/settings*.json`) and `--strict-mcp-config` (no project `.mcp.json`
  servers); GLM and MiMo already load no setting sources
  (`composer::tests::slash_discovery_needs_control_and_the_task_mode`,
  `claude::tests::every_claude_family_discovery_disables_all_hooks`).
- **No FIFOs or devices.** `files.image` (`workspace::image_data_url`) and the document viewer
  check `fs::metadata(..).is_file()` before opening, since opening a FIFO blocks until a writer
  appears; `files.read` already did and `files.grep` skips non-files
  (`workspace::tests::fifos_named_like_images_or_documents_are_never_opened`).
- **More secret files:** `.mcp.json` (MCP servers carry tokens), `.claude/settings.local.json`
  and `secrets.*` (`secrets.json`, `secrets.yaml`, `secrets.toml`…).
- **Claimed images all come back.** After a failed send, `images::restore` gives every claimed
  image back to its sender even past the 16-waiting cap (each was counted when stored), so the
  same-`sendId` retry finds them all.
- **A made task is never orphaned.** When `task.start` or `chat.start` made its task but the first
  message failed, the start answers (and `task.startStatus` remembers) `{ sessionId, sent: false,
  error }` instead of an error, so the phone can open the task holding the prompt
  (`start::made_but_not_sent`). `projects.recentRepos` no longer maps a repository to a chat
  folder, as `projects.clone` already did.
- **`runScript.stop { terminalId }`** (full, and the switch) closes a run-script terminal through
  the terminal methods' close path; any other terminal (a shell, a harness console, a hidden or
  closed one) is refused "That run script is not running here." It is in `fullAccessSwitch`.

**Round-12 gates** (each with a regression test):

- **Recipes never start discovery ungated.** `recipes.plan` (View) and `recipes.run` read the task's
  slash commands through `composer::task_catalog`, which discovers only when `may_discover` holds
  (Control and the task's mode) and otherwise returns `slash_commands::snapshot`. `recipes.run` runs
  `allow_task_mode` before the dry run. A source scan fails if any `remote/methods/*.rs` or
  `remote/host.rs` calls `list_slash_commands`, `resolve_slash_command`, `slash_commands::catalog`
  or `slash_commands::resolve` outside `listed_catalog` and `SlashResolve`'s gated branch
  (`composer::tests::remote_paths_reach_discovery_only_through_the_gate`,
  `tools::tests::recipes_never_start_discovery_without_the_gate`). `task.send` and the other
  sends still resolve commands through `prepare_command`, but only after their own
  `allow_task_mode`, and a send runs the harness anyway.
- **Every terminal method needs the switch.** `terminal.resize` and `terminal.close` now check it
  before anything else, like the other terminal methods and `runScript.stop`, and are listed in
  `fullAccessSwitch` (and the phone's fallback list).
- **`runScript.get` reports the running script** as `running: { terminalId } | null`: the project's
  (or task's) running run-script terminal that `runScript.stop` may close. With the switch off it
  is always `null`, so the id never reaches a phone that cannot use it.
- **More secret files:** `*.env` (`prod.env`), `serviceAccountKey.json`, `firebase-adminsdk*.json`
  and `*-service-account*.json`.
- **No hard-linked files.** `files.read`, `files.image` and `files.write` refuse a regular file with
  more than one hard link, for every device: `This file is hard-linked elsewhere, so PandaCode won't
  open it from your phone.` A hard link carries neither a secret name nor a symlink, so it could
  otherwise expose `~/.ssh/id_rsa` from inside a project. Folders and missing files are left to the
  readers (`files::tests::hard_linked_files_are_refused_for_reads_and_writes`). Phone diffs
  (`Trust::Phone`) leave hard-linked files out too: `task.diff` skips them (tracked and untracked) and
  counts them in `hiddenSecrets`, a local `task.pullDiff` path answers an empty patch with
  `hiddenSecrets: 1`, and `turn.diff` refuses one (`workspace::tests::phone_diffs_leave_out_hard_linked_files`).
  When a hard link forces an explicit path list, the phone's diff names it in chunks of at most
  8 KiB of pathspecs (`git diff` has no `--pathspec-from-file`), so a long list never exceeds
  ARG_MAX (`workspace::tests::phone_diffs_with_many_paths_run_in_chunks`).
  `files.grep` never reads a hard-linked file (`workspace::search_text_for_phone` checks the link
  count on the opened handle), so a hard link named `notes.txt` is never returned. Nor does a
  linked file reach Git from the phone, whose copy would later leak through a diff or a push:
  `git.stage` refuses a named hard-linked path with the same message as `files.read`, and
  `git.stage {all}` refuses the whole call naming the file (`notes.txt is hard-linked elsewhere,
  so PandaCode won't stage it from your phone.`); unstaging is unaffected. `git.commit` from the
  phone is refused while any staged path is hard-linked on disk (`… won't commit it from your
  phone.`) (`workspace::tests::phones_never_stage_or_commit_hard_linked_files`).
- **`task.workspaceImage` follows the same rules as `files.image`.** Both read through
  `files::checked_image_data_url`, which refuses a path resolving into `.git`, a secret file (or a
  symlink to one, say `logo.png -> .env`) below Full, and a hard-linked file for every device,
  before any bytes are read; `variant: "full"` returns raw bytes, so this matters
  (`files::tests::workspace_images_refuse_secrets_git_and_hard_links`). A source scan fails if any
  `image_data_url` call under `src-tauri/src/remote/` skips the helper
  (`files::tests::remote_image_reads_go_through_the_checked_helper`).
- **Design reads refuse links on the opened file.** `design.read` and `design.preview` read
  artboards (and `comments.json`) through `design::read_bounded`, which opens with `O_NOFOLLOW`
  and checks the handle: a symlink, a non-regular file or a file with more than one hard link is
  refused, with no gap between check and read. The desktop canvas shares the reader
  (`design::tests::reads_refuse_symlinked_and_hard_linked_artboards`).

Round 16:

- **Turn captures and hard links.** `turn_changes` hashes a file with more than one hard link but
  keeps no snapshot or patch for it (`HARD_LINKED_ERROR`); `turn.diff` refuses those entries even
  when the checkout is gone, and its secret check also follows symlinks
  (`turn_changes::tests`, `git::tests::turn_diffs_of_hard_linked_files_are_refused`).
- **Unstaging renames.** Unstage (all or named) also resets the source of a staged rename or copy,
  so the index returns to HEAD for both paths.
- **`projects.icons` never leaves the project.** `project_icon::find` (shared with the desktop
  sidebar) resolves each fixed candidate (`public/favicon.svg`, `logo.png`…) and skips it unless
  its canonical path stays inside the canonical project root, so a symlinked `public/` pointing
  elsewhere is ignored. The file is opened with `O_NOFOLLOW` (a symlinked icon is skipped) and the
  handle must be a regular file with one hard link whose device and inode match the resolved path;
  normal icons are unchanged (`project_icon::tests::never_reads_through_symlinks_or_hard_links`).
- **Handle-checked reads.** `files.read`, `files.image` and `task.workspaceImage` no longer check
  a path and then reopen it by path. `files::open_checked` resolves the target once (inside the
  canonical root, out of `.git`, and below Full off the secret list, rechecked on the resolved
  name), stats it, opens it with `O_NOFOLLOW | O_NONBLOCK`, and requires the handle to be a regular
  file with one link and the same device and inode; the text or image `data:` URL is then read
  from that handle with the desktop's limits and messages (128 KiB text, 8 MB images, the same
  types). A file swapped between the check and the open answers `This file changed while it was
  being opened. Try again.` (`files::tests::reads_come_from_one_checked_handle`).
- **More secret files:** `connect-secrets.json`, `connect-grants.json`, `.credentials.json` (the
  `credentials*.json` pattern missed the leading dot), `credentials.toml`, `*.p8`, `*.ppk`, `*.gpg`
  and `.terraformrc` (`.pypirc` was already listed).

Round 17:

- **More secret files.** MCP configs under each tool's own name (`SECRET_PATHS`:
  `.cursor/mcp.json`, `.vscode/mcp.json`, `.roo/mcp.json`, `.gemini/settings.json`,
  `.codex/config.toml`), Claude Code's user config `.claude.json`, and shell and REPL histories
  (`.zsh_history`, `.bash_history`, `.python_history`). Every secret check goes through
  `files::is_secret_path`, so `files.read`/`files.image`, `files.search`/`files.grep`, `task.diff`,
  `task.pullDiff` and `turn.diff` all apply them (`files::tests::secret_files_are_recognised_by_name`).
- **`github.search` stays in the project's repository.** A query with a `repo:`, `org:`, `user:` or
  `owner:` qualifier (any case, also quoted, negated or grouped) is refused with `Search this
  project only: leave out repo:, org:, user: and owner: filters.` (`is:open` and the like stay
  allowed), and every result whose
  URL is not an issue or pull request of the project's own `origin` repository is dropped
  (`github::tests::github_search_stays_in_the_projects_repository`).
- **`github_hub::project_repo` runs no Git.** It reads `remote.origin.url` straight from the
  repository's config file (found through `.git`, a linked worktree's `gitdir:`/`commondir`, or a
  parent folder; Round 20 stopped following `[include]` files; symlinked or oversized files
  are ignored), so the phone's `projects.list`, `tasks.list`, GitHub methods and starts no longer
  run `git config` in a checkout outside the Trust rule. `[includeIf]` sections are not evaluated.
  A source scan fails if `github_hub.rs` spawns anything but `gh`
  (`github_hub::tests::project_repo_never_runs_a_program`).
- **Progress snapshots refuse hard links.** `progress::read_image` already refused symlinks on
  every step and opened with `O_NOFOLLOW`; it now also refuses a file whose opened handle has more
  than one link, before reading (`progress::tests::images_refuse_hard_links`).

Round 18:

- **Schedules.** `schedules.create` is a once-method (`sendId`, keyed by the target `sessionId`), so a retried create makes one schedule. `schedules.update` keeps the schedule's `workflowId` / `chainFromId` when the input leaves them out (an explicit `null` clears them), so older phones can't break workflow chains.
- **Pushes and exports.** `git.push` and `git.commit {push}` clear the pull cache. Export snapshots are capped per device (`EXPORT_KEEP` each), so one device's retries can't expire another's export.
- **Phone GitHub actions stay in the project's repository.** `github.comment`, `github.item`'s
  issue and pull request views, `github.startTask`'s issue lookup and `pull.review` now pass
  `--repo=<origin>` (`github_hub::project_repo`, as the lists already did), so in a fork checkout
  `gh` no longer picks `upstream` or a `remote.<x>.gh-resolved` remote. A project without a GitHub
  `origin` is refused with `This project has no GitHub remote.` Desktop callers are unchanged
  (`github::tests::phone_views_pin_the_projects_repository`,
  `remote::methods::github::tests::phone_gh_calls_pin_the_projects_repository`).
- **`skills.list` sends no local paths.** A folder skill's `source` is `~/…` below the home folder
  and otherwise only the folder's name (GitHub sources keep `owner/name/path`), and `project` is
  the project root shown the same way, never an absolute path
  (`remote::methods::tools::tests::skills_list_sends_no_local_paths`).

Round 19:

- **Slow-read lane.** Thirteen slow read-only methods (`github.repos/issues/pulls/runs/item/search`, `usage.get`, `usage.limits`, `recipes.plan`, `design.preview`, `settings.providers`, `projects.recentRepos`, `slash.list`) run in their own lane, 2 per phone (`methods::slow_read_timeout`, `socket.rs` `SLOW_READS_PER_PEER`), and each may wait the phone's timeout less 2 s. The four ordinary read slots stay free for `subscribe`, `tasks.list`, `task.messages`, `batch` and `host.hello`, so a reconnect's catch-up never expires behind them.
- **Exports.** Only `offset == 0` builds a snapshot; a later page without a valid token is refused. Snapshots are capped per device and at 32 MiB in total.
- **Queue Undo.** `queue.restore` is refused once the task's queue delivered anything since the removal (`message_queue::deliveries`, bumped by `take`), not after a direct send.
- **Schedules.** The phone leaves `workflowId` / `chainFromId` out of `schedules.update`, so the host keeps its own.
- **Bot workspaces are refused by `sessionId` too.** A bot task's folder (`~/PandaCode Bots/<slug>`)
  was refused by `projectId` but reachable with its `sessionId` (from a `tasks.list` row with
  `botId`). Every phone path to a task's folder now goes through `host::workspace_session_from` /
  `workspace_task`, which refuse a task whose project is a bot's with `That task belongs to a bot.`:
  `task_root`, `linked_pull`, `optional_pull`, `task.pullDetect`, `files::resolve` (so `files.*`,
  `design.*`, `moodboards.*`, `runScript.*`, recipes and `terminal.open`), every `git.*` method,
  `checks.*` and `progress.*`. The conversation (`bot.thread`, `task.messages`) still reads through
  `local_task` (`remote::host::tests::bot_task_workspaces_are_refused_by_session_id`, source scan
  `phone_workspace_paths_refuse_bot_tasks`).
- **Clone failures name no local path.** `projects.cloneStatus` maps `gh`'s usual failures
  (not found, signed out, timed out, disk full) to fixed sentences and writes the home folder as
  `~` in anything else, cut to 300 bytes. A clone's status is shown only to the devices that started
  or joined it; others get `unknown` (`remote::methods::projects::tests::clone_errors_hide_local_paths`,
  `a_clone_status_is_scoped_to_the_devices_that_asked`).
- **`providers.list` names no absolute path.** Each harness's `path` is `~/…` below the home folder,
  else only the file name (`remote::host::tests::provider_paths_are_home_relative_or_file_names`).
  The phone never reads it.

Round 20:

- **Driving a bot's thread needs Full.** `bot.message` was Full-only and checked the bot's mode,
  but a bot thread's `sessionId` (a `tasks.list` row with `botId`) let a Control device drive the
  bot's agent through task methods. `host::drivable_task` / `drivable_session_from` refuse a task
  whose project is a bot's unless the device has Full (`Only a device with Full access can drive a
  bot's thread.`), then apply the bot's own rule (`admin::allow_bot_mode`: a full-mode bot needs
  the switch). It guards `task.send`, `task.steer`, `task.configure`, `task.teamResume`,
  `approval.respond`, `input.respond`, `thread.fork`, `thread.setGoal`, `thread.setStage`,
  `thread.archive` when reopening, `rewind.to`, `queue.update`, `usage.clearLimit` and
  `usage.resumeAtReset {on: true}`. `task.stop` stays open to Control. Command discovery
  (`composer::command_context`, behind `slash.list`, `slash.resolve` and recipes) now uses
  `workspace_session_from`, so it never runs in a bot's workspace. Viewing (`task.messages`,
  `bot.thread`, `subscribe`) is unchanged
  (`remote::host::tests::driving_a_bot_thread_needs_a_full_device_and_the_bots_mode_rule`, source
  scan `phone_methods_that_drive_a_task_refuse_bot_threads_below_full`).
- **Lanes.** `slash.resolve` (may discover for the phone's whole 30 s) moved to the background lane
  with a 30 s `background_timeout`, so it can't hold up a Stop. `files.grep` joined the slow-read
  lane at the phone's 20 s (`methods::tests`).
- **Queue Undo.** `restore_held` reports success for an earlier restore only while the entry is in
  the queue again; a restored entry that left the queue (sent or removed on the desktop) answers
  `This message can no longer be put back.`. `restored` and the delivery count are recorded only
  after the reorder succeeds (`composer::tests::queue_restore_marks_restored_only_after_it_is_back`).
- **`projects.recentRepos` is Full.** It lists every private repository and only serves
  `projects.clone`, which is Full. The phone already shows the list only when `projects.clone` is
  allowed (`add-project.tsx`), and `methodAccess` comes from `host.hello`.
- **No local paths.** `worktree.create` no longer sends `path` (the phone never read it).
  `projects.list` shows a project outside the home folder by its folder name only
  (`files::tests::home_is_shortened`).
- **More secret files:** `.m2/settings.xml`, `gradle.properties`, `.yarnrc`, `pip.conf`,
  `rclone.conf`, `*.kdbx`, `.dockercfg` and `.config/hub`
  (`files::tests::round_20_secret_files_are_recognised`).
- **`github_hub::project_repo` follows no includes.** `[include]` and `[includeIf]` files are no
  longer read, so a checkout's config can't point the lookup at another file; an `origin` defined
  only in an included file is not found (`github_hub::tests`, `start::tests`).

Round 21:

- **Shared checkouts.** `git.switchBranch`, `git.commit` and `pull.create` refuse with `Wait for
  the agent to finish first.` while any agent works in the task's checkout (another task sharing
  the main checkout too), before and again under the checkout lock, as `git.discard` and
  `files.write` do (`git::refuse_running_here`; source scan
  `remote::methods::git::tests::checkout_changes_refuse_while_any_agent_works_in_the_checkout`).
- **Queue Undo counts only real deliveries.** `message_queue::restore` (a failed launch putting
  a taken entry back: `headless.rs`, `bots/gateway.rs`, the desktop's `queue_restore`) now
  undoes its `take`'s count. A `task.send` or `recipes.run` that queued an entry and took it
  straight back to send it itself (the run ended in between) uses `message_queue::withdraw`,
  which counts nothing; `queue.restore` puts its entry back with `message_queue::reinsert`, which
  leaves the count alone (`message_queue::tests::only_real_deliveries_are_counted`).
- **Schedules respect the bot-thread guard.** `schedules.runNow`, `schedules.setEnabled {enabled:
  true}`, `schedules.create` and `schedules.update` check the target thread and any watched
  thread with `drivable_session_from` (a bot's thread needs a Full device and the bot's mode
  rule), then the target's mode as before. Snoozing, disabling and deleting are unchanged
  (`remote::methods::schedules::tests::a_bots_thread_needs_a_full_device_to_be_scheduled`; the
  source scan `phone_methods_that_drive_a_task_refuse_bot_threads_below_full` covers
  `schedules.rs`).
- **Headless queue drain.** A phone's `queue.update`, `queue.remove`, `queue.restore` or
  `queue.reorder` drains a headless host's idle task (`headless::queue_changed`) only when that
  device could send to it: the bot-thread guard and the task's mode (`composer::may_drain`).
  Otherwise the edit stands and the queue waits for someone who can resume it
  (`composer::tests::a_queue_edit_drains_only_where_the_device_could_send`).
- **Pull requests stay in the project's repository.** The phone's `task.pull`, `task.pullDiff`,
  `task.pullMerge` and `task.pullDetect` pass `--repo=<owner/name>` to `gh pr view|diff|merge`:
  the repository in the task's pull request link when it names one, else the project's `origin`
  (`github_pull::pinned_repo`, through `github_hub::project_repo`, which runs no Git). Without
  either they are refused with `This project has no GitHub remote.`; `task.pullDetect` answers
  `{pull: null}` (nothing can match) and no longer runs `gh repo view`. Every `_as` entry point
  refuses a phone trust without a repository, so no phone path can leave `gh` to pick a fork's
  `upstream`. `pull.create` opens the pull request with `--repo=<origin>` and is refused before
  anything is pushed when the project has no GitHub `origin` (`github::pull_create_repo`).
  Desktop paths are unchanged (`github_pull::tests::phone_pull_requests_pin_the_repository`,
  `remote_pull_request_calls_pass_a_pinned_repo`,
  `github::tests::phone_pull_requests_open_in_the_projects_repository`).
- **More secret files:** `.gemini/oauth_creds.json`, `.qwen/oauth_creds.json`, any `adc.json`
  under `gcloud/legacy_credentials`, `.azure/msal_token_cache.json`, `github-copilot/apps.json`,
  `.netlify/config.json` and `.wrangler/config/default.toml`. Folder-qualified secret paths may
  now span more than one folder (`files::tests::round_21_secret_files_are_recognised`).

Round 22:

- **A home-rooted project is Full-only for reading.** Below Full, `files.list`, `files.read`,
  `files.image`, `files.search`, `files.grep`, `task.workspaceImage`, `task.diff` and `turn.diff`
  refuse a checkout that is `/`, the home folder or an ancestor of it (compared as given and
  canonicalized, so a symlink to home counts) with `This project is your home folder; open files
  from it on this computer.` (`files::allow_root`, `files::tests::a_home_rooted_project_is_full_only`).
  A `turn.diff` whose checkout is gone has nothing to compare and is unchanged.
- **More secret files:** `fish_history`, `.psql_history`, `.mysql_history`, `.node_repl_history`,
  `.sqlite_history`, `.irb_history`, `ngrok.yml`, `.huggingface/token`, `huggingface/token`
  (`~/.cache/huggingface/token`), `.config/github-copilot/hosts.json`,
  `configstore/firebase-tools.json`, `.config/stripe/config.toml` and `.fly/config.yml`
  (`files::tests::round_22_secret_files_are_recognised`).
- **Queue edits on a bot's thread.** `composer::on_queue` checks every change (`queue.update`,
  `queue.remove`, `queue.restore`, `queue.reorder`) with `drivable_session_from` and the device's
  Full grant, so a Control device can't edit a bot's queue; `queue.list` stays View (source scan
  `phone_methods_that_drive_a_task_refuse_bot_threads_below_full`).
- **Pull requests follow `gh`'s base repository.** `github_hub::base_repo` reads the checkout's
  config (no Git process, no includes) and picks what the desktop's `gh` resolves: the remote with
  `gh-resolved` (`base` means its URL's repository, another value names `owner/name`), then
  `upstream`, then `origin`. `github::pull_create_repo` (`pull.create`) and
  `github_pull::pinned_repo` (`task.pull`, `task.pullDiff`, `task.pullMerge`) use it after the
  repository in the task's link. `task.pullDetect` accepts pull request links to any of the
  checkout's GitHub remotes (`github_hub::github_remotes`, plus the task link's repository) and
  pins each lookup to the repository in its URL (`github_pull::detect_in_as`). For consistency
  the phone's GitHub methods (`github.repos`, `github.issues`, `github.pulls`, `github.runs`,
  `github.search`, `github.item`, comments and reviews) use the same base repository, so in a
  fork checkout they show `upstream`. `github_hub::project_repo` (origin) still identifies a
  project for `projects.list`, starts and the desktop GitHub view
  (`github_hub::tests::base_repo_follows_gh_resolved_then_upstream_then_origin`,
  `github_pull::tests::phone_pull_requests_pin_the_repository`,
  `github::tests::phone_pull_requests_open_in_the_projects_repository`).
- **Every queue delivery is counted.** The desktop's steer of a queued entry now calls
  `queue_take_steered` (was `queue_remove`), and a shared channel's stopped assignment and an
  agent's `pandacode_remove_queued` leave the queue through `message_queue::remove_delivered`,
  which counts a delivery as `take` does (one `DELETE … RETURNING`; an entry already gone counts
  nothing). A phone's earlier Undo is then refused instead of restoring into a queue that moved on
  (`message_queue::tests::steered_and_other_takes_count_as_deliveries`).
- **A retried `queue.remove` answers from the hold.** When the entry is gone but this host removed
  it within the hold window and hasn't put it back, `queue.remove` answers success with the queue,
  so a retry after a lost reply still offers Undo (`composer::remove_queued`,
  `composer::tests::a_retried_queue_remove_answers_from_the_hold`).

Round 23:

- **Pull requests from a fork name the fork's branch.** `workspace::git_push` pushes to
  `origin` (else the first remote by name), but a phone's `pull.create` pins `--repo=` to the base
  repository (Round 22). When the push remote's repository (`github_hub::push_repo`, read from the
  config like `base_repo`) differs from the base, `--head=` is `<pushOwner>:<branch>`
  (`github::pull_head`); a same-repository checkout and the desktop (no `--repo`) still pass the
  bare branch (`github::tests::phone_pull_requests_from_a_fork_name_the_fork_head`,
  `github_hub::tests::push_repo_is_origin_then_the_first_remote_by_name`).
- **`task.pullMerge` waits as long as the phone does.** It ran in the ordered lane, where a queued
  request expires after 18 s while the phone waits 60 s (`MERGE_TIMEOUT_MS`). It now runs in the
  background lane (socket.rs `lane`) with a 60 s `methods::background_timeout`, so it also never
  holds up a Stop. A merge carries no `sendId`; instead `host::claim_merge` lets one merge per task
  run at a time and refuses a concurrent retry with `This pull request is already being merged.`
  (a later retry finds the pull request merged)
  (`socket::tests::stops_and_answers_never_wait_behind_a_start`,
  `socket::tests::a_request_its_caller_gave_up_on_is_dropped`,
  `host::tests::one_pull_merge_per_task_runs_at_a_time`).
- **`checks.plan` can't hang on a FIFO.** `checks::plan` reads `package.json` through
  `read_manifest`: opened with `O_NONBLOCK`, read only when the opened handle is a regular file of
  at most 1 MiB (`checks::tests::a_fifo_manifest_is_skipped_without_blocking`).
- **PandaCode's app data folder is Full-only as a project.** Below Full, `files::allow_root` also
  refuses a checkout that is, holds or sits inside the app data folder (`secret_store::dir()`, set
  at startup from Tauri's `app_data_dir`; compared as given and canonicalized) with `This project
  holds PandaCode's own data; open files from it on this computer.` (`files::touches_app_data`,
  `files::tests::a_home_rooted_project_is_full_only`).
- **`cloud.machines` errors hide local paths.** Each provider error has the home folder written as
  `~` (`projects::home_as_tilde`, shared with `projects.cloneStatus`) before it is cut to 300
  bytes (`admin::cloud_error`, `admin::tests::cloud_machine_errors_write_home_as_tilde`).

Round 24:

- **Project rule and recipe files are read bounded.** `recipes.list`, `recipes.plan` and
  `recipes.run` checked a recipe's size with `DirEntry::metadata()` (which does not follow
  symlinks) and then read it with `read_to_string` (which does), so a View device could point the
  host at a `.pandacode/recipes/x.json` linked to `/dev/zero`, or a FIFO, and run it out of
  memory or block it. `workspace::read_regular` opens with `O_NOFOLLOW | O_NONBLOCK`, reads only
  when the opened handle is a regular file, and reads through `take(limit + 1)`; recipes skip
  anything else (`recipes::tests::listing_skips_links_and_fifos`,
  `workspace::tests::read_regular_refuses_links_fifos_and_oversized_files`). The skills matrix
  (`skills.list`), activation status, `adapter::file_hash`, `write_block` and `remove_block` read
  `CLAUDE.md`, `AGENTS.md` and written skill files through `skills::adapter::read_text` /
  `workspace::read_regular_target`: bounded at 2 MiB and only from a regular file, so a link to
  `/dev/zero` or a FIFO is refused on the opened handle. That reader follows a symlink to a
  regular file, since a symlinked `AGENTS.md -> CLAUDE.md` or dotfiles `~/.claude/CLAUDE.md` is
  common and none of that text is sent to a phone (only block ids and an "other instructions"
  flag). The matrix lists an oversized, non-UTF-8 or non-regular rule file as `Has instructions
  PandaCode does not manage.`, activation into it is refused, and its status reads `missing`
  (`skills::tests::special_rule_files_are_never_read_in_full`).
- **`skills.list` cells carry no local paths.** Each matrix cell's `surface` (a skill folder or a
  rule file) goes through `shown_path` (`~/…` or a file name), like the item sources and the
  project (`tools::shown_cells`, `tools::tests::skills_list_sends_no_local_paths`).
- **A fork's pull request defaults to the base repository's branch.** With no `base`,
  `pull.create` reads `refs/remotes/<remote>/HEAD` for the remote `github_hub::base_repo` resolved
  (`github_hub::base_remote`; a `gh-resolved` `owner/name` maps to the remote whose URL names it),
  so a fork checkout targets `upstream`'s default branch rather than `origin`'s. When that remote
  or ref is missing it falls back to the task's branch list as before
  (`workspace::pull_base_default`, `workspace::tests::pull_base_default_reads_the_base_remotes_head`,
  `github_hub::tests::base_remote_names_the_remote_base_repo_resolved`,
  `git::tests::pull_create_defaults_to_the_base_remotes_branch`).
- **The head owner follows the push URL.** `github_hub::push_of` prefers the remote's last
  `pushurl` over `url`, as `git push` does, so `pull_head` names the fork the branch actually went
  to (`github_hub::tests::push_repo_prefers_the_push_url`).
- **Archive and Undo share one guard.** `thread.archive` with `archived: true` used `local_task`
  while reopening used `drivable_task`, so a Control device could settle a bot's thread but its
  Undo was refused. Both directions now use `drivable_task` (a bot thread needs Full either way)
  (source scan `phone_methods_that_drive_a_task_refuse_bot_threads_below_full`).

| Method | Params | Result |
|---|---|---|
| `subscribe` | `{ sessionIds: [...] (≤ 500), epoch?, afterSeq?: { [sessionId]: seq } }` | `{ tasks: [{ sessionId, status, lastId, title, pending, seq, events?, gap?, lastEventAt?, runStartedAt?, subagents?, subagentsTruncated?, team? }], missing: [sessionId], epoch }` for those that exist; `missing` lists requested ids that are not tasks there. `seq`, `events` and `gap` are described in [Events](#events). `status` and `team` follow [Team tasks](#team-tasks). `pending` is the current `[{ kind: "approval" \| "input_request", requestId, text, data, tool? }]` for requests the viewer can still answer; large payloads are cut to fit. Answered, cancelled and ended-run requests are removed. While a host run is active (including waiting for input or approval), `lastEventAt` is the unix-millisecond time of the harness's last event, `runStartedAt` is the latest saved prompt time when known, and `subagents` is a snapshot in the desktop `SubagentActivity` shape: `[{ id, parentId, name, prompt, status, response, tools: [{ id, name, status, input, output, writePaths? }], startedAt, updatedAt }]`. The phone can derive active/total child counts and tool counts from the array and each item's status and tools. `subagentsTruncated: true` appears only when entries or activity text were cut to fit the 40 KiB per-task subagent budget. These live-run fields are absent when the task is not active. Adds the ids to this device's subscription for 10 minutes; the viewer renews every 9 minutes and on every presence frame. An expired subscription starts over. |
| `tasks.list` | `{ limit?: 0..500 }` (default 200) | `{ tasks: [{ sessionId, title, status, projectId, projectName, provider, model, effort, mode, pinned, updatedAt, lastPromptAt, lastEventAt?, runStartedAt?, branch?, chat?, botId?, botName?, pending, team? }], projects: [{ id, name, repo: "owner/name" \| null }] }`. `pending` has the same shape and meaning as for `subscribe`; `status` and `team` follow [Team tasks](#team-tasks). `lastEventAt` and `runStartedAt` use the same definitions as `subscribe` and are included only for an active host run. Tasks are ordered by latest prompt or response and omit drafts and mirrors. Bot workspace tasks include `botId` and `botName`; other tasks may include chats (`chat: true`). Projects omit bot workspaces. The tail is dropped to keep the reply under 180 KiB. |
| `projects.icons` | `{ projectIds: string[] }` (1..=50; use project ids from `tasks.list`) | `{ icons: { [projectId]: string \| null } }`. Known non-bot local projects map to their icon `data:` URL, or `null` when no icon exists or it exceeds 64 KiB. Icons reached through a symlink (file or folder) or with more than one hard link are skipped. Unknown ids are omitted. Icons stop being added before the result exceeds 180 KiB, so omitted ids can be requested again. |
| `providers.list` | `{ force?: boolean }` | the host's `list_providers` result: `[{ id, name, installed, path, version, models }]`, with `path` as `~/…` or a file name (Round 19). `force` drops the same ACP catalog caches. If it would not fit one reply, the longest `models` lists are halved until it does. |
| `providers.models` | `{ provider, force?: boolean }` | the host's `list_provider_models` result: `[{ id, name, description, reasoningEfforts, defaultReasoningEffort, contextWindow }]`, its tail dropped to fit one reply. `provider` must be a known harness id (`Unknown provider.`). |
| `task.start` | `{ repo?: "owner/name", projectId?: string, branch?, worktree, prompt, provider, model, mode?, effort?, startId? }` (exactly one of `repo` or `projectId`) | `{ sessionId }`, or `{ sessionId, sent: false, error }` when the task was made but its first message failed. A repeated `startId` from the same device runs nothing new: it waits for (or returns) the first start's result. |
| `task.startStatus` | `{ startId }` | `{ state: "running" \| "done" \| "failed" \| "unknown", sessionId?, error? }`. Finished starts are remembered for an hour. |
| `task.cancelStart` | `{ startId }` | `{ cancelled: true }` once a running start was told to stop (its callers get `Start cancelled.` at once, the clone's process group is killed); `{ cancelled: false, sessionId }` when it had already made its task. |
| `task.messages` | `{ sessionId, afterId?, tail?, beforeId?, limit?, budget? }` (`limit` is 1..400; defaults to 100 for `tail`/`beforeId`, 400 for `afterId`; `budget` is the page's JSON bytes, see [Message copies](#message-copies)) | `{ messages: [{ id, role, content, createdAt, turnDurationMs, attachments }], hasMore, hasOlder, title, lastId }`. `attachments` is always an array; saved images include `{ id, kind: "image", name, mime, bytes, width, height }`, while document and folder context markers carry `{ id, kind, name }`. `tail: true` returns the newest page; `beforeId` returns the page immediately before that message id. Both are oldest-first. Use only one of `afterId`, `tail: true` or `beforeId`; mixing them is refused. `hasMore` means newer rows follow this page, `hasOlder` means older rows precede its first message, and `lastId` is the newest message id (or `null` for an empty thread). |
| `task.team` | `{ sessionId }` | `{ team: null \| TeamSnapshot }`. The snapshot includes `sessionId`, `status`, `error` (null, or why the team paused or failed or why its lead is quiet), `round`, `revision`, `summary`, `updatedAt`, `mode: "auto" \| "classic"`, `rounds: { used, max }` (`max` is always 0: rounds have no limit), and `workers` (every row; a reply over 180 KiB cuts text, then files, then all row detail, and only then drops rows, oldest settled first; team-level `truncated` and `workersTruncated` and a worker's `filesTruncated` say so, and the phone shows a note). Older hosts also send `messages`, which clients ignore. Each worker includes `{ id, name, provider, model, status, attempt, summary, checkpoint, files, dependsOn, startedAt, updatedAt, sessionId }` plus desktop fields `profileId`, `assignment`, `error`, `readOnly`, `abandoned`, and `createdAt`. `checkpoint` is null or `{ summary, nextSteps, blocker, updatedAt }`. Worker `waiting` is exposed as `running` to match the phone status set. A task with no team returns `{ team: null }`. |
| `task.workerMessages` | `{ sessionId, workerId, afterId?, tail?, beforeId?, limit? }` (`afterId` defaults to 0; `limit` is 1..100 and defaults to 100) | `{ messages, hasMore, hasOlder, title, lastId, tail? }`. `sessionId` identifies the architect task; `workerId` must belong to that team's saved workers. Messages are the worker transcript page returned by the desktop worker-message API: `{ id, sessionId, role, content, createdAt, turnDurationMs, authorProvider?, turnChanges?, coordinationKind? }`, oldest first. `tail: true` returns the newest page and `beforeId` the page immediately before that message id; a page cut to fit keeps the rows next to the cursor, and these replies carry `tail: true`, which tells a viewer the host pages backward (older hosts ignore both params and answer as for `afterId` 0). `afterId` is an exclusive cursor; pass the last returned message id for the next page. `hasMore` reports newer rows after the page and `hasOlder` reports saved rows before it. The page fits within 180 KiB. |
| `task.attachment` | `{ sessionId, id, variant: "thumb" | "full", offset? }` | `{ mime, total, offset, data, done }`, with `data` a base64 chunk. Image ids must be UUIDs linked to a message in that same local session. `thumb` is a JPEG with a long edge no larger than 480 px and fits one chunk. `full` returns original bytes unless the source exceeds 8 MiB, when the host makes a JPEG with a long edge no larger than 2048 px. Chunks contain at most 120 KiB of raw bytes. |
| `task.workspaceImage` | `{ sessionId, path, variant: "thumb" | "full", offset? }` | The same chunk shape as `task.attachment`. Uses the local task's workspace image checks: relative paths only, no traversal or escaping symlinks, image types only, and a maximum source size of 8 MiB. Like `files.image`, it refuses paths into `.git`, secret files below Full and hard-linked files. Mirrors are refused. |

| `task.send` | `{ sessionId, text }` | `{ queued: boolean }`. Queued if the task is running, like Enter. If the run ended between the check and the queue add, the host takes the entry back and sends it. |
| `task.teamResume` | `{ sessionId }` | `{}`. The desktop's Resume (`architect_control` with `resume`) for a team that is `paused`, `failed` or `interrupted`; any other team is refused. Resuming starts agents, so it needs the `control` scope and Full access for remote tasks, since its workers run with full access (and as for `task.send`). Hosts without it answer `Unknown method.`, and the phone and desktop mirror say to update that computer. |
| `task.stop` | `{ sessionId }` | `{}`. For a task whose team is running or waiting this is the desktop Stop button (`architect_control` with `stop`): the team is paused, unsettled workers are marked stopped, and the architect's and workers' runs are stopped, also between architect turns when no agent of the task itself runs. Otherwise it stops the task's run (`stop_session`). |
| `task.steer` | `{ sessionId, text }` | `{}` (as `steer_task`) |
| `task.configure` | `{ sessionId, provider?, model?, effort?, mode? }` | `{}`. `provider` and `model` together (a provider not installed there is refused as in `task.start`); `effort: null` clears it; `mode` changes permissions. |
| `task.pull` | `{ sessionId }` | `{ pull: PullDetail \| null }`. `PullDetail` is `{ number, title, body, bodyTruncated, state, url, author, base, head, additions, deletions, changedFiles, createdAt, updatedAt, mergedAt, mergeable, reviewDecision, labels: string[], checks: [{ name, state, url }], files: [{ path, additions, deletions }], commits: [{ oid, headline, author, date }], timeline: [{ kind, author, body, state, createdAt }], truncated }`. `truncated` is true if Connect trimmed the detail's body, timeline, files or other fields (or the GitHub body was already truncated); the whole result fits under 180 KiB. |
| `task.pullDiff` | `{ sessionId, path? }` | Without `path`, `{ files: [{ path, additions, deletions }], truncated }` with the tail dropped to fit 180 KiB. With `path`, `{ patch, truncated, hiddenSecrets? }` for that file; patches are cut at 120 KiB. Below Full, a secret `path` is refused and secret sections are dropped, as in `task.diff`. |
| `task.pullMerge` | `{ sessionId, method: "merge" \| "squash" \| "rebase" }` | `{}`. Uses the same merge operation and refusals as the desktop merge button; an unlinked pull request is refused. With Full access for remote tasks off, a checkout whose git config names a program, or that has submodules, is refused first. |
| `task.pullDetect` | `{ sessionId }` | `{ pull: PullDetail \| null }`. Runs the same turn-message and branch checks as desktop pull detection and links a newly detected pull request; returns its detail, or `null` when none was newly detected. |
| `task.changes` | `{ sessionId }` | `{ branch, ahead, behind, files: [{ path, status, staged }] }`. Status uses Git's one- or two-character index/working-tree code (`??` for untracked); `ahead` and `behind` count commits against the upstream, or are both 0 when no upstream exists. Files are trimmed from the tail to fit 180 KiB. |
| `task.diff` | `{ sessionId, path?, staged? }` (`staged` defaults to `false`) | `{ diff, truncated, hiddenSecrets? }`. Returns the checkout's unified diff, including untracked files for an unstaged diff. The text is cut at 120 KiB when needed. Below Full, secret files (`methods/files.rs`'s `SECRET_FILES` names: `.env*`, keys, `.npmrc`…, its `SECRET_PATHS` such as `.kube/config`, and symlinks to either) are left out as in `files.read`: a `path` naming one is refused, and a whole diff drops their file sections and counts them in `hiddenSecrets`. |
| `bots.list` | `{}` | `{ bots: [{ id, name, avatar: string \| null, state: "paused" \| "working" \| "ready", paused, desktopSession: string \| null, projectId }] }`. An avatar is its stored data URL or icon id only when it is at most 32 KiB; otherwise it is `null`. The tail is dropped to fit 180 KiB. |
| `bot.thread` | `{ botId }` | `{ sessionId }` for the bot's desktop conversation, creating it on first use as the desktop sidebar does. |
| `bot.message` | `{ botId, text }` | `{ sessionId }`. Sends through the desktop bot-message flow, so the bot's brief and memories are applied. |
| `bot.pause` | `{ botId, paused: boolean }` | `{}`. Pausing stops the bot's current work before recording the pause, as in Settings. |
| `approval.respond` | `{ sessionId, requestId, approve: boolean }` | `{}` |
| `input.respond` | `{ sessionId, requestId, response }` | `{}` (as `respond_user_input`) |
| `host.hello` | `{}` | `{ protocol: 2, appVersion, methods: string[], limits: { maxText, pageBudget, packedPageMax, maxBatch, maxIds, maxPath, maxFrame, maxImages, maxImageBytes, imageChunk }, features: string[], access, methodAccess, fullAccessSwitch }`. `methods` is every method this host serves (built-in and registry); `limits` come from the constants that enforce them; `features` are flags a viewer cannot read from `methods` (`packedFrames`, `replayAfterSeq`, `pagedMessages`, `imageUpload`, `teams`, each [registry](#adding-a-method) group with at least one method, and `remoteFullAccess` while Full access for remote tasks is on). `access` is the calling device's grant (`view`, `control` or `full`; null if not approved), `methodAccess` maps every listed method to the narrowest grant that may call it, and `fullAccessSwitch` lists the methods that also need Full access for remote tasks on (`terminal.list/open/read/write/resize/close`, `runScript.start`, `runScript.stop`, `checks.run`, `files.write`, `skills.activate`, `cloudAgents.start`, `moodboards.add`, `projects.clone`). `view` scope, read-only. Hosts from before it (protocol 1) answer `Unknown method.`, or, to a view or control device, a grant refusal; the phone records such a host as legacy. |

A host refuses a session id that is itself a mirror, so tasks never hop twice. Attachment bytes are
read on the blocking pool and are only served when a `message_attachments` row ties the UUID to a
message in the requested session. Prompt captures start in the cache at
`browser-captures/<uuid>.png`; schema 30 links them to their saved message and copies the PNG into
`<app data>/attachments/<session id>/<uuid>.png` so cache cleanup cannot remove it. Moodboard
images remain in `moodboard_images.original`; each link records both the board id and image UUID. Document and
folder contents remain in the saved message text under `Document context:` and `Folder context:`;
`task.messages` also exposes those markers in its `attachments` list. Deleting a task removes its
attachment rows and copied files. The host never accepts a filesystem path for `task.attachment`.

### Capability discovery

The phone asks each online host `host.hello` once per socket presence (again after the host goes
offline and back, or the socket reconnects) as a background call, and keeps the answer per device
in `mobile/src/connect/api/capabilities.ts` (`useCapabilities`). `useHostSupports(deviceId,
method)` is false once the host is known to lack a method, so a screen hides the feature up front
and shows `outdated(<computer>)` ("Update PandaCode on <computer> to use this."); it is true while
unknown. A legacy host is assumed to serve the methods from before `host.hello`; any method it
answers with `Unknown method.` is recorded as missing. The capabilities are forgotten when the
computer goes offline, so it is asked again when it returns (possibly updated, or regranted).

`useHostAllows(deviceId, method)` also checks this phone's grant there against `methodAccess`, and
for `fullAccessSwitch` methods whether `remoteFullAccess` is on; `useHostBlock` says why not
(`outdated`, `access` or `switch`, explained by `blockedNote` from `api/hello.ts`: "Turn on Full
access for remote tasks on <computer> to use this.") and `useNeedsFullAccessSwitch` is true when
only the switch is in the way. A host that does not send `access`/`methodAccess` hides nothing by
grant. The API is listed at the top of `capabilities.ts`. The older per-method fallbacks (`newer()`,
the store's `outdated` for pulls and bots, `teams: 'outdated'`) are unchanged.

`features` in the `host.hello` reply flags behaviour the method list can't show: `packedFrames`,
`replayAfterSeq`, `pagedMessages`, `imageUpload`, `teams`, `startId` (a repeated `task.start`
with the same `startId` answers the first start; `task.startStatus` reports it), `sendId` (the same
for `task.send`, `task.steer` and `bot.message`, see "Repeated prompts"), `actionSendId` (the same
for `github.comment`, `pull.create`, `recipes.run` and `schedules.runNow`), `forkSendId` (and for
`worktree.create`, `thread.fork` and `rewind.to`), `backgroundSendId` (and for `btw.ask`,
`vm.start`, `vm.stop` and `moodboards.add`; queued background calls expire), `prevSeq` (agent events
carry `prev`, see "Events"), each feature group with methods, and `remoteFullAccess`.

### Repeated prompts (`sendId`)

`task.send`, `task.steer` and `bot.message` take an optional `sendId` (a printable id, at most 200
bytes). The host remembers the answer per (calling device, task or bot, `sendId`) for an hour, at
most 4096 in all (oldest forgotten first), and answers a repeat with the first answer without
running it again. A failure is not remembered, so a retry runs. Requests from one device run in
order in its state-changing lane, so a repeat never overlaps the first. Older hosts ignore the
field.

The phone sends the optimistic bubble's id as `sendId` (an outbox entry's id, so resending it is
safe). When a reply is lost (`That computer did not answer in time.` or the connection dropped),
it sends once more under the same id if the host's hello lists `sendId`; if that is lost too (or
the host can't dedupe) the bubble stays, marked `unconfirmed` ("Unconfirmed"), the thread reloads to
settle it, and the call resolves `{ unconfirmed: true }` instead of failing, so the user is not
invited to send it twice. The bubble leaves when the stored copy arrives or the run ends. A
thread reload that started after the lost reply decides it (`unconfirmedVerdict` in
`mobile/src/store/sent.ts`): if it finds no stored copy and the task is idle, the host never ran
it. A host that dedupes by `sendId` gets a `task.send` back through the outbox under the same id
(safe: a copy that did run answers from memory), once; otherwise (or a steer, a bot message, or a
second time) the bubble shows "Not delivered" with Send again (the same call and `sendId`; a steer
goes as a message) and Discard. The host also marks a keyed send as running before it runs, so a
repeat that arrives meanwhile (a retry on a new socket generation) waits for the first's answer
instead of running beside it; if the first fails or is dropped, the waiter runs it itself. The
outbox (`mobile/src/store/outbox.ts`) leaves an entry queued after a lost reply when the host
dedupes (`idempotent`), and sends it again on the next flush.

`github.comment`, `pull.create`, `recipes.run`, `schedules.runNow` (and `worktree.create`,
`thread.fork`, `rewind.to`, `git.commit`, `bot.runSchedule`) take the same optional
`sendId` when the host's hello lists `actionSendId` (remembered per device, method, target and
id). The phone's wrappers (`runOnce`/`hostCallOnce` in `mobile/src/connect/api/github.ts`, used by
`githubComment`, `createPull`, `runRecipe` and `runScheduleNow`) make one id per user action, send
once more under it after a lost reply, and otherwise fail with `The computer did not confirm this,
so it may have gone through. Check before trying again.` rather than risk a second comment, pull
request or run. A refusal of the retry means it never ran and is shown as is. Without
`actionSendId` the phone sends no id and never retries. `btw.ask`, `vm.start`, `vm.stop` and
`moodboards.add` do the same under `backgroundSendId` (`hostCallBackgroundOnce` in
`api/composer.ts`).

### Adding a method

Built-in methods live in `host.rs` (`METHODS`, `Call`, `parse`, `run_one`) and `grants.rs`
(`VIEW`/`CONTROL`/`FULL_ONLY`). New methods go in the registry instead, one file per feature group,
so parallel work never edits the shared dispatch:

| Side | Files | What a method adds |
|---|---|---|
| Host | `src-tauri/src/remote/methods/{threads,composer,git,github,schedules,files,projects,design,tools,terminal,admin,team}.rs` | a `Method { name, access, read_only, parse }` in that file's `METHODS`, a params struct implementing `Run` |
| Phone | `mobile/src/connect/api/<same>.ts` | `registerMethods([...])` once, then a typed function calling `hostCall` |
| Demo | `mobile/src/demo/<same>.ts` | an entry in that file's `handlers` |

`host.rs` looks any method it does not know up in the registry (`methods::find`). From the
declaration alone the method is refused while hosting is off, checked against presence and the
device's grant (`access`: `View`, `Control` or `Full`; `grants.rs` reads it), run in the read lane,
retried after a reconnect and allowed in `batch` when `read_only`, and listed by `host.hello`. The
tests in `methods/mod.rs`, `grants.rs` and `host.rs` cover every registry method: unique names that
never shadow a built-in, scopes as declared, read-only as declared. A method that changes a task's
mode must refuse `full` itself (`ctx.full_access`, `full_access_off`, `allow_task_mode`). Keep
replies within `PAGE_BUDGET` (180 KiB) and text params within `MAX_TEXT`; reuse the validators
`methods/mod.rs` re-exports (`id_param`, `text_param`, `name_param`, `path_param`, `uuid_param`,
`force_param`, `page_budget`) and task lookups (`local_task`, `task_root`, `linked_pull`,
`optional_pull`), which refuse mirrors. Document the method in the table above.

On the phone, `hostCall(deviceId, method, params, { timeoutMs?, background? })` fails at once with
the update note when the host is known to lack the method, and turns `Unknown method.` into it. In
demo mode `demoCall` (`mobile/src/demo-host.ts`) answers core methods itself and falls through to
`src/demo/*.ts` handlers; the demo's `host.hello` lists them.

A new phone screen is a route file in `mobile/src/app/` whose name is already listed in
`PUSHED_SCREENS` or `SHEET_SCREENS` in `mobile/src/app/_layout.tsx`; it hides or disables the
feature with `useHostSupports(deviceId, method)`.

### Registry methods

Scope is the narrowest grant (`view` < `control` < `full`). RO = read-only (concurrent, batchable,
retried after a reconnect). Lane for state-changing methods: **O** ordered (serial per phone, with
`task.send`/`task.stop`), **B** background (beside the ordered lane), **S** start (own run, one of
the four start slots, `startId` dedupes). `target` means `sessionId` (the task's checkout) or
`projectId`, one required. Every task lookup refuses mirrors. Replies stay under `PAGE_BUDGET`;
paged replies take `offset` and answer `next`.

| Method | Scope | RO / lane | Params → notes |
|---|---|---|---|
| `thread.rename` | control | O | `sessionId, title` |
| `thread.archive` | control | O | `sessionId, archived` (the phone's Archived section and Undo). On a team lead it needs Full access for remote tasks. |
| `thread.delete` | full | O | `sessionId` |
| `thread.pin` | control | O | `sessionId, pinned` |
| `thread.fork` | control | O | `sessionId, messageId, before?` |
| `thread.export` | view | RO | `sessionId, offset?, token?` → `{ text, offset, next, total, token, version }`. Offset 0 snapshots the Markdown and answers a `token` (per device and task, 10 min); later pages pass it back and read that snapshot; an unknown or expired token is refused (`This export changed or expired. Export again.`). Without a token (older phones) each page rebuilds and `version` (a hash) shows a change. |
| `thread.goal` / `thread.setGoal` | view / control | RO / O | `sessionId` / `sessionId, description`. `thread.setGoal` on a team lead needs Full access for remote tasks. |
| `thread.setStage` | control | O | `sessionId, stage` (a known task stage). On a team lead it needs Full access for remote tasks. |
| `slash.list` | view | RO | `sessionId, force?` → `{ commands, warnings, truncated }`; `force` (re-scan the harness) needs control |
| `slash.resolve` | control | B | `sessionId, text`. Waits in the background lane up to 30 s (Round 20). Refused for a bot's thread. |
| `btw.ask` | control | B | `sessionId, text, sideId?, seenId?` → `{ sideId, title, seenId, created }`. Reuses `sideId` only if this host linked it to the task, it is in the same project and not archived; otherwise makes a new side thread (a fork at the last message for a worktree task, else a new task with the task's provider, model and mode, which must pass the Full-access rule, and never the saved default team). Refused for bot conversations and while the side thread is still answering; a side thread made by a failed ask is deleted. |
| `queue.list` | view | RO | `sessionId` |
| `queue.update` / `queue.remove` / `queue.reorder` | control | O | `sessionId, id, text` / `sessionId, id` / `sessionId, ids`. `queue.update` on a team lead needs Full access for remote tasks. |
| `queue.restore` | control | O | `sessionId, id`. Puts back the exact entry (text, attachments) a `queue.remove` took out in the last 60 s, at its old index; at most 8 held per task. Idempotent; no mode check (it only restores what was queued). Refused once the task has a newer user message or the hold expired: `This message can no longer be put back.` Delivery is checked before the idempotency check, so an entry that was restored and later sent reports that it can't be put back. The demo host does the same. |
| `usage.get` | view | RO | `sessionId?, refresh?` (token ledger) |
| `usage.limits` | view | RO | `provider, refresh?`; `refresh` (asks the provider) needs control |
| `usage.resumeAtReset` / `usage.clearLimit` | control | O | `sessionId, on` / `sessionId`. Resuming (`on: true`) or clearing a team lead's limit needs Full access for remote tasks. |
| `git.status` / `git.branches` / `worktree.status` | view | RO | `sessionId`. Staged renames and copies carry `origPath`. |
| `git.stage` | control | O | `sessionId, paths \| all, unstage?` → `{ count, skipped? }` for `all`. Named paths: up to 5,000; `all`: up to 50,000 files, folder and submodule rows skipped and counted, run over pathspec chunks. Refused while a background git call holds the checkout (`Another git change is still running on this checkout.`). `unstage` of a staged rename or copy is `origPath`-aware: unstaging its `path` also restores its `origPath` in the index, so the old name does not stay staged as a deletion. |
| `git.discard` | control | O | `sessionId, paths, skipFolders?` (1–500 files) → `{ count, skipped? }`. With `skipFolders` (Discard all) folder and submodule rows are left out and counted in `skipped`; without it a named folder is refused. Git runs over 8 KiB pathspec chunks. Restores tracked files from HEAD and deletes only the untracked files it names; discarding a rename's new path also restores the old one; refused while any agent works in the checkout or another git change holds it; `allow_task_mode`; change gate; idempotent. |
| `git.commit` | full | B | `sessionId, message, push?, sendId?`. Refused while the task's agent runs. Hooks run only with Full access for remote tasks on. |
| `git.push` | full | B | `sessionId`. Hooks as `git.commit`. |
| `git.switchBranch` | full | O | `sessionId, branch`. Refused while a background git call holds the checkout, as `git.stage`. |
| `worktree.merge` | full | B | `sessionId`. Hooks as `git.commit`. |
| `worktree.remove` | full | B | `sessionId, deleteBranch?` |
| `worktree.create` | full | B | `sessionId, branch?` (default: from the task's issue or title, under `pandacode/`). Refused while the agent runs or when the task already has one; holds the project's checkout lock. An unstarted task moves into the new worktree (the desktop's `attach_worktree`); a started one gets a new task there with its harness and model (`create_worktree`), and the saved default team only with Full access for remote tasks. `git worktree add` never runs hooks; with the switch off a repository whose config names programs (filters) is refused. Reply `{sessionId, moved, branch}` (no local path since Round 20). |
| `pull.create` | full | B | `sessionId, title, body?, base?, draft?, sendId?`. The push runs hooks as `git.commit`. |
| `pull.review` | full | B | `sessionId, event: approve\|request_changes\|comment, body?, sendId?` → `{ number }`. `gh pr review` on the task's linked pull request through `run_gh_as` with the phone's trust; the body goes as `--body=` and is required except for approve. A once-method (`sendId`); clears the pull cache. Needs Full, like `github.comment`, because it speaks on GitHub as the user's `gh` account. |
| `turn.summary` / `turn.diff` | view | RO | `sessionId, messageId` / `+ path`. Below Full, `turn.diff` refuses a secret file (by its path or a rename's old path), as `files.read` does. |
| `github.repos` | view | RO | — |
| `github.issues` / `github.pulls` / `github.runs` | view | RO | `projectId` |
| `github.item` | view | RO | `projectId, kind: issue\|pull\|run, number \| runId` |
| `github.search` | view | RO | `projectId, query` |
| `github.comment` | full | B | `projectId, kind?: issue\|pull, number, body, sendId?` |
| `github.startTask` | full | S | `projectId, issueNumber, provider, model, worktree?, mode?, effort?, startId` (titled `Fix #N: …`). Without Full access for remote tasks the task gets no saved default team. `startId` is required (`Missing startId.`), so a retry after a lost reply never starts a second task. |
| `schedules.list` / `schedules.runs` | view | RO | `sessionId?` / `sessionId?, scheduleId?, limit?` |
| `schedules.runNow` | control | B | `scheduleId, sendId?` (sends under the thread's send lock) |
| `schedules.setEnabled` / `schedules.snooze` | control | O | `scheduleId, enabled` / `scheduleId, minutes` (1 min–7 days) |
| `schedules.create` / `schedules.update` / `schedules.delete` | full | O | `input` (the desktop's `ScheduleInput`) / `scheduleId, input` / `scheduleId` |
| `projects.list` | view | RO | — |
| `files.list` / `files.read` / `files.image` | view | RO | `target, path?` / `target, path, offset?` / same, images only. Below a full grant, `read`/`image` refuse common secret files (`SECRET_FILES` in `methods/files.rs`: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `.pypirc`, `credentials*.json`, `*.p12`, `*.keystore`, also through a symlink); `list` still shows their names. |
| `files.search` / `files.grep` | view | RO | `target, query` / `+ matchCase?, wholeWord?, regex?`. Below a full grant, secret files are left out of the results. |
| `files.write` | full | O | `target, path, text, baseHash` (the `hash` of the `files.read` it edits; a changed file is refused as a conflict). Also needs Full access for remote tasks. |
| `chat.start` | full | S | `prompt, provider, model, mode?, effort?, imageIds?, startId` (`startId` required, as for `github.startTask`) |
| `projects.clone` | full | O | `repo, name?` (clone runs on; poll `projects.cloneStatus`) |
| `projects.cloneStatus` / `projects.recentRepos` | view / full | RO | `repo` / —. `recentRepos` lists private repositories, so it is Full, like the `projects.clone` it serves (Round 20). |
| `design.list` / `design.read` / `design.preview` | view | RO | `target` / `target, name, offset?`. `preview` renders with QuickLook on a Mac after `sanitize_artboard` (`methods/design.rs`): comments, doctypes, `<script>`, `<link>`, `<iframe>`, `<frame>`, `<object>`, `<embed>`, `<base>` and `<meta>` are removed, then backslashes (CSS escapes), `<style>` blocks and non-text attributes holding character references, `@import`, non-`data:` `url(...)` and `image-set()`-style functions, and non-`data:`/`#` URL attributes; repeated until stable, and the CSP meta (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) is the first element. `qlmanage` cannot run under `sandbox-exec` (it sets up its own sandbox, which fails inside one, and renders in QuickLook's own services), so the sanitizer and CSP are the whole defence. |
| `design.comments` | view | RO | `target, artboard?` |
| `design.comment` / `design.resolve` | control | O | `target, artboard, x, y, text` / `target, commentId, status?` |
| `progress.list` / `progress.thumb` / `progress.media` | view | RO | `sessionId` / `sessionId, id, offset?` |
| `checks.plan` | view | RO | `sessionId` |
| `checks.run` | full | B | `sessionId` (runs the repo's commands on the computer with no approval step, so it also needs Full access for remote tasks, like `runScript.start`) |
| `recipes.list` / `recipes.plan` | view | RO | `target` / `sessionId, name` |
| `recipes.run` | control | B | `sessionId, name, sendId?` (sends under the task's send lock) |
| `skills.list` | view | RO | `target?` |
| `skills.activate` | full | O | `id, harness, active, scope: user\|project, target?` (project scope needs a target). Also needs Full access for remote tasks. |
| `runScript.get` / `runScript.start` | view / full | RO / O | `target`. `get` answers `{ script, running: { terminalId } \| null }` (`running` is null unless the switch is on and the device has Full). `start` also needs Full access for remote tasks. |
| `runScript.stop` | full | O | `terminalId` (from `runScript.start`) → `{ status: "stopped" }`. Needs Full access for remote tasks; refuses any terminal that is not a run script. |
| `localServers.list` | control | RO | — (every listening process on the computer) |
| `terminal.list` / `terminal.read` | full | RO | — / `terminalId, after?` (a shell's output can carry anything on the computer, so both are Full and also need Full access for remote tasks) |
| `terminal.open` / `terminal.write` / `terminal.resize` / `terminal.close` | full | O | `target, cols, rows` / `terminalId, data` (1 B–16 KB, untrimmed) / `terminalId, cols, rows` / `terminalId`. `open` and `write` also need Full access for remote tasks; `open` is refused at 4 shells per phone. `read`, `write`, `resize` and `close` refuse a terminal `list` hides (bot workspaces, mirrored tasks) as closed. |
| `bot.detail` | view | RO | `botId`. Below full: no pairing codes and only the last 4 characters of each sender id. To a `view` device: empty `schedules`/`rules`/`memories` with `memoryCount`, `scheduleCount`, `ruleCount` and `limited: true`. |
| `bot.remember` / `bot.forget` | full | O | `botId, content` / `botId, memoryId` |
| `bot.runSchedule` | full | B | `botId, scheduleId, sendId?` |
| `bot.pairingDecide` | full | O | `botId, channelId, senderId, decision: approved\|blocked\|removed` |
| `bot.failoverDecide` | full | O | `sessionId, action: send\|wait, always?` |
| `machines.list` / `cloud.machines` / `cloudAgents.list` / `routing.status` | view | RO | —. `routing.status` → `{ routing: { enabled, mode, minP, profiler, error, failed } }` with `error` a fixed sentence, never the router's own text. |
| `vm.frame` | control | RO | `name, frameId?, offset?` (a live picture of the VM's screen) |
| `vm.start` / `vm.stop` | full | B | `name` |
| `orchestration.respond` | full | O | `requestId, accept, deviceId?, access?: read\|ask\|full`; `full` also needs Full access for remote tasks. |
| `team.roster` | view | RO | — (installed team harnesses and saved agent teams, no secrets) |
| `settings.providers` | view | RO | — → `{ providers: [{ id, name, installed, executable, version, models, status, update }] }`. `executable` is the file name only; `models` a count; `status` is `ready`, `installed`, `needsKey` (a keyed harness with no saved or environment key), `signedOut` (Claude without a login) or `missing`; `update` is `{ status, latest, canUpdate }` from the desktop's cached agent update check (omitted without a main window or after 8 s). No keys, tokens, environment names or values, or paths. Installing and updating harnesses and editing keys stay on the computer. |
| `settings.routing` / `settings.setRouting` | view / full | RO / O | — / `on: bool` → `{ on, mode, profiler, failed }` (`failed` replaces the error text, which can name folders). The switch only: the router's files download on the computer when a team first uses it. |
| `settings.tokenSaver` | view | RO | — → `{ rtk, rtkVersion }`. Detection only, never installs. The saver's packs are per thread in the desktop window's storage, so the phone has no switch for them. |
| `settings.jj` | view | RO | `target` → the desktop's `JjStatus` (`isRepo`, `colocated`, `change`, `files`) plus `truncated` |
| `moodboards.list` / `moodboards.image` | view | RO | `target` → `{ boards: [{ id, name, imageCount, updatedAt, images: [{ id, name, caption, width, height, createdAt }] }], truncated }` / `target, boardId, imageId, full?, offset?` → a `data_page` (JPEG thumbnail, or the agent-size image with `full`), paged like `progress.media`. Bot projects are refused; board membership is checked in one query. |
| `moodboards.add` | full | B | `projectId, board, imageId, name?` → `{ board }` (the desktop's `MoodboardDetail`, oldest images dropped to fit). Also needs Full access for remote tasks. `imageId` is an upload from this device's `image.put`, claimed as `task.send` claims one (given back if the add fails, removed from the capture folder after it); the desktop's `add_moodboard_image` decodes it into the board in app storage. `board` is a board id and `name` a plain file name (no folders, `..`, leading dot or control characters; default `Image from phone.png`). Emits `moodboards-changed { projectId, boardId }`. |
| `deploy.targets` | view | RO | — → `{ targets: [{ id, connected, note? }] }` with `id` one of the desktop Deploy menu's targets in its order (`vercel`, `cloudflare`, `railway`, `netlify`, `aws`, `gcloud`, from `src/deploy.ts`). `connected` is decided as `deployItems()` does (`cloud_connections` lists that provider connected); `note` is the menu's "Connect it in Settings → Agents → Cloud sandboxes" for one that is not. No tokens, accounts or project details. |
| `team.start` | full | S | Needs Full access for remote tasks (team workers run with full access). `projectId`, the `task.start` fields (no `repo`, `worktree` or `branch`), `auto?` or `profileId` (not both); `startId` (required, as for `chat.start`) shared with `task.startStatus` |

### Starting a task on another computer

The phone makes one `startId` per start and keeps it with the new-task draft
(`mobile/src/ui/useNewTask.ts`): tapping Start again on the same draft after a lost reply or an
unreachable computer reuses it, so the host runs the start once; a draft that changed, or a start
the host refused or finished, gets a new one. When the `task.start` reply is lost, the phone asks
`task.startStatus` every 3 s (as `mirror.rs` does) until it is `done` (the task opens), `failed`
(the host's error), or the start timeout passes ("still starting"); `unknown` (the request never
arrived) sends `task.start` again under the same id, at most twice
(`mobile/src/connect/start-retry.ts`).

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

The viewer sends a `startId`; the host runs each one once, on its own, so a lost reply never
stops it halfway. When the reply to `task.start` times out or the socket drops, the mirror row
stays (running, no `remote_session`) and, once the host is online again, the viewer asks
`task.startStatus` every 3 s until the start is done (the row is linked), failed or unknown
(the row is put back and `remote://start-progress` reports `error`). `remote_cancel_start`
sends `task.cancelStart` and puts the row back; a start cancelled after its task was made is
stopped on the host. Older hosts refuse both methods (`Unknown method.`): the row is put back.
The viewer makes the mirror row and spawns its start in one step (no await between them), so a
caller that gives up (a machine tool's deadline) never leaves a row nothing starts. A machine
thread (docs/machine-orchestration.md) is never put back: its `startId` is its own id, a start
PandaCode quit during is asked about again after restart, a failed or lost start keeps it as an
error, and one the user stopped stays stopped.

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
each subscriber an `agent.events { events: [...], epoch }` frame: the first event after a quiet
100 ms goes at once (a turn's first delta shows without waiting), the next ones wait out the rest
of 40 ms since the last flush, and after a burst's first 5 frames of 100 ms per frame the last flush
sent (more frames only when the events pass the 180 KiB frame budget; an event over 120 KiB is cut).
Pacing counts frames, not flushes, so however many viewers subscribe, streaming costs the host's
socket about 10 frames a second, whatever the token rate, under the relay's 20 frames a second
(replies included). Consecutive text deltas of the same message are merged.

Every agent event of a followed task carries `seq`, one counter per host launch (`epoch`, new
at each launch). The host keeps each task's last 2000 events (at most 2 MiB per task, 32 MiB in
all) in memory. A viewer remembers the newest `seq` per task and subscribes with `epoch` and
`afterSeq`; the reply then holds, per task, the events after that position (`events`, in order,
deltas merged, within a third of the reply; for a viewer that sent `"z": 1`, within 180 KiB of JSON
while the packed reply fits 180 KiB) or `gap: true` when some are gone (dropped, too
many, or another epoch), when the viewer copies the messages instead. Each task's `seq` is the
position to use next. The viewer drops an event at or before the newest `seq` it saw, so a
replay and live frames never show twice. Events without `seq` (older hosts) are shown as before,
and older viewers ignore the new fields.

Newer hosts (hello feature `prevSeq`) also give each agent event `prev`: the `seq` of the same
task's previous agent event (run ends, which go in their own frames after the events flushed with
them, are not chained). A viewer whose position in that task is behind `prev` missed an event
(for example a frame lost on the way): it drops that task's events from there, holds what comes
next and subscribes again from its position, as after `lagged`. A task the viewer has no position
in yet, or an event without `prev`, is never a gap. When a finished task's ring is swept (no viewer
for 10 minutes) the host remembers where it ended (at most 4096 tasks), so a ring made again later
starts from there: its first event's `prev` is the task's last one and a viewer still holding that
position replays with no false gap. An event of the task that nobody numbered meanwhile forgets
this, and the new ring starts at the current `seq` as before. The phone (`Cursors.check` in
`mobile/src/store/replay.ts`) and the desktop viewer (`Viewer::missed_before` in `mirror.rs`) both
do this.

The phone saves its positions (`epoch` and `seq` per task, per host) as resume tokens in
`connect-cursors.json` in its cache (`mobile/src/connect/cursor-file.ts`, at most 5 s after they
change, ignored after an hour, deleted on sign-out). After a relaunch its subscribes send them, and a
host still on the same launch (`epoch`) replays only what was missed instead of the phone
refetching; another epoch answers `gap` as before. A subscribe that fails (a renewal or one cut
short) is retried per host after 2 s, doubling to 60 s, each wait jittered ±30 %; a success, the
host going offline or the socket closing resets it (presence subscribes again).

A subscriber more than 4096 events behind stops buffering until it catches up at the run end.
Each event is an `AgentEvent` with `sessionId`, `kind`, `text`,
`requestId`, `data`, and optional `tool`; request ids are included where applicable. These are
the kinds sent in `agent.events`:

| Kind | Meaning |
|---|---|
| `approval` | The agent requests permission for a tool action. `requestId`, `data` and optional `tool` describe the request. |
| `approval_cancelled` | An outstanding approval was withdrawn or cancelled. |
| `commands_changed` | The harness's available command catalogue changed. |
| `error` | The provider reports a run error; the explanation is in `text`. |
| `goal` | Snapshot of the Codex goal state. |
| `goal_input` | The goal runtime is asking for user input. |
| `goal_ready` | Goal setup completed and its initial state is available. |
| `input_cancelled` | An outstanding structured-input request was withdrawn or cancelled. |
| `input_request` | The agent requests structured user input; `requestId`, `data` and optional `tool` carry the answerable request. |
| `limited` | The provider reports an account usage limit; `data` may include `resetsAt` and `window`. |
| `message_start` | A new assistant message or phase starts; `data.messageId` identifies it and `data.phase` may identify its phase. |
| `session` | The provider's native session id is available in `text`. |
| `status` | Progress or state text. Plan updates and reasoning/thinking notices use this kind; any provider metadata is reduced to recognized scalar fields. |
| `steer` | A steer was accepted, delivered, or failed; `data` includes its id, status and mode. |
| `subagent` | A child-agent snapshot changed. `data` is a desktop `SubagentActivity` (`id`, `parentId`, `name`, `prompt`, `status`, `response`, `tools`, `startedAt`, `updatedAt`); ids are scoped to the parent run. |
| `team` | A worker row changed in the task's architect team. `sessionId` is the architect task id and `data` is the changed worker row in `task.team` shape. If the team is removed, `data` is `{ "removed": true }`. The desktop emits full `architect-event` snapshots; Connect sends only changed rows through the same event buffer. |
| `task_settings` | Goal runtime task settings changed. |
| `text` | Assistant text delta. `data.messageId` and optional phase associate it with its message. |
| `tool` | A tool started or changed; the current `ToolActivity` is in `tool` (`id`, `name`, `status`, `input`, `output`, and optional `writePaths`). |
| `turn_complete` | A Codex goal turn completed. |
| `turn_start` | A Codex goal turn started. |
| `usage` | Sanitized context-token usage snapshot; `data` carries recognized usage fields only. |

A desktop mirror keeps `subagent` snapshots (live and from `subscribe`'s `subagents`) in its own store, so its Subagents panel matches the host's after missed frames or a reopen. It reads the host's team with `task.team` when the task opens and after each `team` event or run end (`remote_team` in `remote/mirror.rs`, mapped to the desktop TeamSnapshot) and a worker's transcript with `task.workerMessages` (`remote_worker_messages`). The workers panel there shows the host's `error` and a note when its reply was cut, and is read-only apart from Resume (`task.teamResume`, shown while the team is paused, failed or interrupted): no pause, stop, setup or team messages. Hosts without these methods show no team.

There are no separate `plan`, `todo`, `thinking` or `reasoning` event kinds: those provider
updates are represented as `status` text and/or data. The provider's `done` event is consumed by
the desktop run loop and is not sent in `agent.events`. Likewise, local `status: running`,
`turn_changes`, persistence errors, and final `done` emissions are window events rather than
Connect `AgentEvent`s. The desktop's `architect-event` is also a window event; Connect translates
it to the `team` kind for subscribed architect tasks. Connect signals run end with `run.finished`.

For example, a live child update is an ordinary `agent.events` item:

```json
{
  "sessionId": "host-session-id",
  "kind": "subagent",
  "text": "",
  "requestId": null,
  "data": {
    "id": "run-id:child-id",
    "parentId": null,
    "name": "Tests",
    "prompt": "Run the focused tests",
    "status": "running",
    "response": "Checking the project setup…",
    "tools": [{ "id": "run-id:child-id:tool-id", "name": "Bash", "status": "running", "input": "cargo test", "output": "" }],
    "startedAt": 1792866000000,
    "updatedAt": 1792866000500
  }
}
```

At a run end the host queues `run.finished { sessionId, successful, stopped, text, status?, team? }`
after that run's last events. The viewer copies the new messages, ends the local turn, then emits the
`done` agent event with `text`, so the transcript reloads with everything in it.

#### Team tasks

An architect task can be working while no agent of its own runs: the architect ends its turn
(the team becomes `waiting`) while its workers carry on, and the desktop still shows the task as
running. Connect reports it the same way. Every task row of `tasks.list` and `subscribe`, and every
`run.finished`, of a task that leads a team carries
`team: { status, activeWorkers }`, where `status` is the team snapshot's status (`ready`,
`running`, `waiting`, `paused`, `failed`, `completed`) and `activeWorkers` counts workers that are
not abandoned and are `queued`, `running` or `waiting`. Other tasks have no `team`. The values are
read in one query from the saved team, on the blocking pool.

- While the team is `running` or `waiting`, the row's `status` is `running`, whatever the saved
  status (`completed`, `idle`, or `interrupted` because no agent is registered). The one exception
  is a row whose own architect run is registered and `waiting` for input or approval: it stays
  `waiting`. Once the team is paused, failed or completed, `status` is what it would be without a
  team.
- A `run.finished` whose team is still running or waiting has `status: "running"`: the run ended,
  but the task did not, so the phone keeps it under Running. Without `status`, `run.finished`
  means what it always did.
- When a team the host has reported or seen as active stops being `running` or `waiting` and no
  agent of the architect task is registered, the host sends a further `run.finished`:
  `{ sessionId, successful: team.status == "completed", stopped: team.status == "paused", text:
  "Team completed" | "Team paused" | "Team failed" | "Team stopped", status, team, teamSettled: true }`,
  with `status` as a task row would show it then. If the architect itself still runs, its own run
  end reports the settled team instead. A settling `run.finished` is skipped while the same task's
  `run.finished` is still waiting in the buffer, but it can follow one already sent; viewers treat
  a repeated `run.finished` as a no-op (the desktop mirror ends a turn only once).

The viewer re-emits each event as the window's ordinary `agent-event` with the mirror's *local*
session id (events for tasks it doesn't mirror from that host are dropped), and moves the row's
status (`approval`/`input_request` → waiting, their cancellations → running, any other event
→ running). A subscription reply catches up on what was missed: a status that changed, a run
that ended while this computer wasn't listening, and messages newer than `remote_synced_id`.

### Message copies

`task.messages` keeps the legacy `afterId` path for desktop mirrors: rows after the cursor, oldest
first, at most 400 rows by default. `tail: true` starts at the newest message, and `beforeId` pages
backward from that id; those modes default to 100 rows. Every mode is kept within 180 KiB of JSON,
and newest-first pages keep the newest rows that fit. An optional `budget` sets the page's JSON
bytes instead: clamped to 4 KiB..1 MiB, and to at most 180 KiB unless the request carried `"z": 1`
(the viewer opens packed frames). A page over 180 KiB is cut until it packs (deflates) into 180 KiB,
so its sealed frame still fits the relay's 256 KB. A page always holds at least one message. The
desktop mirror's and phone's first tail page ask for 32 KiB (about 12 KB on the wire, one round trip
on 3G), and the mirror's afterId and `beforeId` copies ask for 1 MiB. Hosts before `budget` ignore it. `hasMore` reports newer rows after the page;
`hasOlder` reports older rows before its first row. `lastId` is the current newest message id, or
`null` for an empty thread. Any message over 120 KiB is cut and ends with
`…[cut on the host to fit a remote page]` (JSON tool content is cut inside, so it still parses).
When a page's single message does not fit a smaller `budget`, it is cut to the budget the same way
and marked `cut: true` (same id); viewers fetch it whole later with `afterId: id - 1` and a full
budget and replace their copy. The desktop mirror does this at the end of each copy and marks such
a copy in `messages.remote_cut` (schema 33, H's message id) until it is replaced, so a failed fetch
or a restart leaves it for the next copy; older viewers ignore the flag. The desktop copies older
pages (`beforeId`) in rounds of 8 until none are left, each page waiting (up to 10 s) while other
calls to that host are pending.
The desktop mirror stores an `afterId` page and advances `remote_synced_id` in one transaction,
and skips a page that no longer starts at the stored position (a concurrent copy got there first),
so messages are never copied twice. It follows `hasMore` for up to 50 pages per copy and also takes
the host's title.

Known limit: a message the host rewrites in place after it was copied (a tool's status, say)
is not copied again.

Responses and events are handled as soon as they arrive and never wait behind a slow request.
Each peer can have up to four read requests in flight. The read lane includes `subscribe`,
`tasks.list`, `projects.icons`, `providers.list`, `providers.models`, `task.startStatus`,
`task.cancelStart` (never behind the start it cancels), `task.messages`, `task.team`,
`task.workerMessages`, `task.attachment`, `task.workspaceImage`, `task.pull`, `task.pullDiff`, `task.pullDetect`,
`task.changes`, `task.diff` and `bots.list`. Replies may arrive out of order; both the phone
and desktop client match them by request id. The desktop mirror still copies messages by its
`afterId` cursor and commits each page before advancing it.

State-changing requests from one peer remain serial and keep their arrival order relative to one
another. This includes `task.send`, `task.steer`, `task.stop`, `task.teamResume`, `task.configure`,
`approval.respond`, `input.respond`, `bot.thread`, `bot.message` and `bot.pause`.
`task.pullMerge` runs in the background lane (Round 23), one per task at a time.
Each start (`task.start`, and the registry's `github.startTask`, `chat.start` and `team.start`) runs on its own
and holds one of the computer's four start slots, so a stop or an answer never waits behind a clone.
Slow registry methods run in a background lane beside the ordered one, at most two per peer at once:
`btw.ask`, `checks.run`, `git.commit`, `git.push`, `github.comment`, `pull.create`, `recipes.run`,
`worktree.create`, `worktree.merge`, `worktree.remove`, `vm.start`, `vm.stop`, `schedules.runNow`,
`bot.runSchedule`, `rewind.to`, `moodboards.add` and `slash.resolve` (`methods::lane_for`; any other state-changing registry method joins the ordered
lane, so a new slow one must be listed there). They keep no order relative to the ordered lane.
Read requests may run while the ordered lane is busy. The event flush only batches mirror
events; an RPC reply is placed directly on the socket outbox and does not wait for an event tick.

A request's `ts` and `nonce` are checked when it arrives, not when it runs, so time in the queue
never makes it expire. A background-lane call waits up to its own deadline instead, the phone's
timeout for that method less 2 s (`methods::background_timeout`: `checks.run` 150 s; `git.push`,
`pull.create` and `git.commit` with `push` 90 s; `git.commit`, `worktree.*`, `btw.ask`, `vm.*` 60 s;
`recipes.run`, `github.comment` and `pull.review` 45 s; the rest 20 s). A request (other than a start, whose
`startId` makes a repeat harmless, or a background-lane call) that waited 18 s or
more, past its caller's 20 s timeout, is refused with `This request waited too long on the other computer and did not run. Try again.` instead of run, so a prompt the caller sent again
can't run twice. A prompt whose `sendId` already ran is not refused: it gets the first answer (see
"Repeated prompts"), so the refusal always means nothing with that request ran. Older hosts said
`...and was dropped. Try again.` even when an earlier copy had run, so the phone treats that text
like a lost reply for prompts (the bubble stays "Unconfirmed" and the thread reloads) and the new
text as a refusal (`promptMaybeRan` in `mobile/src/connect/rpc.ts`).

### Batch requests

`batch` combines 1–8 read-only calls into one request. Calls are validated before running; a
write method or malformed batch shape rejects the batch, while invalid parameters for one allowed
call become that call's error. Calls run in the listed order and results stay in the same order.
The `calls` list cannot contain another `batch`.

For 2 s after a reconnect's presence, or after the app returns to the foreground, the phone groups
the `tasks.list`, `subscribe` and `task.messages` calls it makes to a host in the same tick into one
`batch` (up to the host's `maxBatch`), when that host's `host.hello` lists `batch`
(`mobile/src/connect/batcher.ts`). A result the host left out to fit the reply, or a host that
refuses the batch, is fetched on its own; a lost batch fails each call in it.

For example, opening a task can fetch its newest messages, subscribe for live updates and check
for a pull request in one phone round trip:

```json
{
  "type": "req",
  "id": "request-id",
  "method": "batch",
  "params": {
    "calls": [
      { "method": "task.messages", "params": { "sessionId": "task-id", "tail": true } },
      { "method": "subscribe", "params": { "sessionIds": ["task-id"] } },
      { "method": "task.pullDetect", "params": { "sessionId": "task-id" } }
    ]
  }
}
```

The response uses the ordinary outer request id and returns one `{ok, result|error}` entry per
call:

```json
{
  "type": "res",
  "id": "request-id",
  "ok": true,
  "result": {
    "results": [
      { "ok": true, "result": { "messages": [], "lastId": null } },
      { "ok": true, "result": { "tasks": [] } },
      { "ok": false, "error": "..." }
    ]
  }
}
```

The combined results fit within the 180 KiB JSON budget, so calls inside a batch get plain-sized
`task.messages` pages and replays even for a viewer that opens packed frames. If successful results would exceed it,
the largest entries are returned as per-call errors asking the client to request them separately.

### Host timing and slow paths

Set `PANDACODE_CONNECT_TIMING=1` before launching the desktop app to emit one debug timing line
per handled request. It includes method, time waiting in the peer queue, handler time, JSON
serialization time, sealing time, and payload/frame byte counts. `task.start` also reports any
wait for the global four-start limit. A batch logs its outer queue wait and per-call handler times.
It logs no task or peer ids.

The request path previously did message-page queries, subscription snapshots, and session/root
lookups while polling on the async socket worker. Those database operations now use the blocking
pool; the existing `(session_id, id)` message index already supports paging. Icon generation,
image reads/transforms, git changes/diff and GitHub detail/diff work already used blocking
workers. Pull detail and file-diff results are now cached for 30 seconds per session and PR;
pull-detection results are keyed by the latest message id and linked PR number, and a merge
invalidates that session's cache. Each invalidation bumps a per-session generation that a fetch
reads before it runs; the result is stored only if the generation is unchanged, so a fetch that
started before an invalidation never caches a stale value after it
(`host::tests::a_pull_fetch_started_before_an_invalidation_is_not_cached`). This avoids repeated
GitHub CLI work while the inspected task state is unchanged.

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
| `remote_start_task` | `{ deviceId, projectId, prompt, provider, model, mode?, effort?, worktree?, branch?, sessionId? }` | the mirror `Session` plus `sessionId`. `branch` defaults to the checkout's. An empty New task draft without its own worktree passed as `sessionId` becomes the mirror; otherwise a new task is made. On failure nothing is left: a new row is deleted, a draft stays a draft. With `startId`, a timeout or a dropped socket keeps the row and returns it (see Starting a task). |
| `remote_cancel_start` | `{ sessionId }` (the local row) | `{ cancelled }`. Cancels a start that has no host task yet and puts the row back (also when the host can't be reached); `cancelled: false` when the host had already made the task, which then runs as a mirror. |

Window events: `remote://status` (status), `remote://presence` (devices), and for mirrors the
ordinary `agent-event` and `sessions-changed`.

The agent-event hook in `lib.rs` clones and allocates nothing while hosting is off or nobody
follows (or followed, since this launch) that task.

## Privacy

Listed in the README privacy table: remote access contacts GitHub (sign-in only) and the relay
(while signed in). Task content crosses the relay only encrypted end to end.
