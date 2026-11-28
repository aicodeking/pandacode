# Headless server (`pandacode serve`)

The same PandaCode binary runs as an always-on **host** on a server: started over SSH, no
desktop session, no one watching. Your devices — the mobile app and other computers'
PandaCode — see the server as one more computer in PandaCode Connect and can start, watch,
steer and approve tasks on it, including cloud runs ([cloud agents](cloud-agents.md)). There
is no window in front of anyone and the desktop frontend never runs on a server: Tauri still
creates the window from `tauri.conf.json`, but `serve` closes it during setup (with
`--port` it is kept hidden and blank instead, see below).

Nothing changes for the desktop app. `pandacode` with no arguments is the ordinary GUI;
`pandacode serve …` is the host. A host can serve Connect clients (when signed in), a local
web UI in any browser (`--port`, see [Local web UI](#local-web-ui---port)), or both.

## What the server runs

`serve` builds the real app — storage, provider credentials, the queue, bots, the
cloud-agent resume loop, Connect hosting (`setup_common` in `lib.rs`, shared with the
desktop startup) — then closes the window from `tauri.conf.json` (with `--port` it stays
hidden instead) and keeps the process alive. Everything user-facing happens on your
devices. The few jobs the desktop window
would normally do are done natively in `src-tauri/src/headless.rs`:

| Job | On the desktop | In serve mode |
|---|---|---|
| Queue drain | frontend `dispatchQueue` (main.ts) after each run | native, after each clean run end and at startup; failed, stopped, archived and still-limited tasks hold their queue, as on the desktop |
| Pull-request links | frontend after each run | native `github_detect_pull_request` after each run |
| Usage-limit resumes | frontend timer | native 60 s check (`Store::due_limit_resumes`) |
| App-action tools (`pandacode_run_project`, `pandacode_preview_file`, `open_*`) | open in the window | refused with "headless host" so agents fail fast |
| Updates | checked every 6 h, may relaunch | never (no updater; update by reinstalling) |

Turn checks are desktop-only (they are opt-in and off by default). Browser-dependent work
(Jev, the built-in browser) is unavailable on a headless host.

**Secrets are stored in a file, not the OS keychain.** On Linux and Windows, `serve`
sets `PANDACODE_SECRETS_FILE=1` unless you set it yourself, so provider keys, channel
tokens and every other app secret are written to `secrets.json` in the app data
directory instead of the OS keychain (Secret Service / Windows Credential Manager). On
Linux the file is created with mode 0600 (owner read/write only); on Windows it has no
mode bits and relies on the app data directory's permissions. Anyone who can read that
file as the service user, or as root/an administrator, can read the secrets, so run
`serve` as a dedicated user and keep the app data directory private. Set
`PANDACODE_SECRETS_FILE=0` to use the OS keychain instead (it must be unlocked and able
to answer noninteractive reads). macOS always uses the same 0600 file.

When adding something new that the frontend does after a run or on a timer with real
effects, give serve mode a native twin in `headless.rs` — see the checklist at the bottom.

## First run

```sh
pandacode serve --sign-in
```

Prints a GitHub device-flow code, waits for you to approve it in a browser (anywhere), then
serves. `--device-name "build-server"` names the server in your device list (default: the
hostname). The server becomes a host automatically. Other flags, each exiting after it
saves: `--sign-out`, `--full-access` / `--no-full-access` (let remote devices pick Full
access — no approval prompts; off by default).

```sh
pandacode serve        # requires an existing sign-in; exits non-zero if none
```

`pandacode serve --version` (or `-V`) prints `pandacode <version>` and exits 0 without
starting the host or needing a display. So does plain `pandacode --version` on this build,
which is how you ask a server over SSH what it is running.

## Local web UI (`--port`)

```sh
pandacode serve --port 8787        # or -p 8787; 0 picks a free port
```

serves the live PandaCode workspace over HTTP + WebSocket on `127.0.0.1:<PORT>` by default
and prints its address to stdout:

```text
http://127.0.0.1:8787/#token=<token>
```

Open that URL in a browser to get the full PandaCode UI, driving the same tasks, queue and
providers as the host. It works on its own, with no PandaCode Connect sign-in. When you are
signed in, Connect hosting runs alongside it.

- `--host <ADDR>` picks the bind address (default `127.0.0.1`). The recommended way to
  reach a server's web UI from another machine is to keep the loopback default and tunnel
  over SSH:

  ```sh
  ssh -L 8787:127.0.0.1:8787 build-server   # then open the printed URL locally
  ```

  The local port does not have to match the remote one: with
  `ssh -L 9000:127.0.0.1:8787 build-server`, open the printed URL with `8787` changed to
  `9000`.

  On a private network such as Tailscale or WireGuard you can instead bind the machine's
  address on that interface (`--host 100.x.y.z`): WireGuard encrypts the traffic, and
  nothing is exposed as plain HTTP on your LAN. Avoid `--host 0.0.0.0` on untrusted
  networks: pages, API calls and the token all travel as **unencrypted HTTP**.
  `--host` (and `--allowed-host`) without `--port` is refused, by `serve` and the desktop
  app alike.
- **The bind address persists.** **Settings → Connections → Remote access → Web access**
  saves the chosen address next to the port in `web-server.json` (as `host`; absent means
  `127.0.0.1`). A saved server therefore restarts on the same address, and turning Web
  access off and on again keeps it instead of falling back to loopback. A command-line
  `--host` or `PANDACODE_WEB_HOST` applies to that run only; the command line itself never
  saves it, and Settings only writes an address it actually saves.
- **Trusted host names (`--allowed-host`).** A listener normally only answers a `Host` that
  is the bound address (or loopback); a DNS name is refused with `403`. Add the names it
  should accept with the repeatable `--allowed-host <NAME>` flag, or the comma-separated
  `PANDACODE_WEB_ALLOWED_HOSTS` environment variable (trimmed; empty entries ignored).
  `--allowed-host` needs `--port`, and the environment list pairs only with
  `PANDACODE_WEB_PORT`, exactly like `PANDACODE_WEB_HOST`. Names are bare DNS names or IP
  literals: no scheme, port, path or wildcard, stored lowercased, at most 32. The same list
  can be set in Settings, where it applies immediately without restarting the listener or
  rotating the token. A trusted name never weakens anything else: it is only an *additional*
  `Host`, the bearer token is still required on every API and WebSocket call, and a present
  `Origin` must still match `Host` exactly.
- **MagicDNS and Tailscale Serve.** Keep the loopback bind and put a TLS terminator in front
  of it, then trust the name it forwards:

  ```sh
  tailscale serve --bg 8787   # HTTPS for this machine's MagicDNS name -> 127.0.0.1:8787
  pandacode serve --port 8787 --allowed-host my-mac.tailXXXX.ts.net
  ```

  The printed link then starts with `https://my-mac.tailXXXX.ts.net:<port>`. Tailscale
  Serve's own HTTPS endpoint is usually port 443, so open the `https://` name and drop the
  port when Serve maps it to a different one. The same works for any reverse proxy that
  terminates TLS and forwards to the loopback bind: add the public name as a trusted host.
- **The URL is a credential.** Holding the token gives full control of this PandaCode
  session as the host user — starting coding agents, running terminal commands, and
  reading or editing workspace files. `serve --port` prints the full `#token=` URL to
  stdout, so it lands in journald or whatever log your service manager keeps. A
  `pandacode --port` handed off to a running desktop app prints it to that running
  instance's stdout too. Keep those service and launch logs private, and rotate the token
  (see below) if a log was ever shared.
- **Desktop app too.** The desktop session can be served the same way: `pandacode --port
  <PORT>` (or `--web-port <PORT>`), `PANDACODE_WEB_PORT=<PORT>`, or **Settings →
  Connections → Remote access → Web access**. On macOS the binary is inside the app bundle:

  ```sh
  /Applications/PandaCode.app/Contents/MacOS/pandacode --port 8787
  ```

  The `--port` / `--web-port` flags also reach a desktop app that is already running: the
  second `pandacode --port <PORT>` process hands the request to the running app and exits
  silently in that terminal, printing nothing. The running instance starts its web server
  (or moves it to the new port), and its desktop window shows the outcome: a notification
  with **Copy link** and **Open** on success, or an error toast if the port could not be
  used. It also updates **Settings → Connections → Remote access → Web access**.
  `PANDACODE_WEB_PORT`, `PANDACODE_WEB_HOST` and `PANDACODE_WEB_ALLOWED_HOSTS` only apply
  when they launch a new instance. `PANDACODE_WEB_HOST` and `PANDACODE_WEB_ALLOWED_HOSTS`
  apply only together with `PANDACODE_WEB_PORT`: a `--port` passed on the command line
  binds loopback and trusts nothing unless `--host` / `--allowed-host` are given too. The
  browser and the desktop window then show the same live session.

Security:

- Each session gets a fresh 256-bit access token: 64 hex characters from the OS random
  number generator (`OsRng`). It travels in the URL fragment
  (`#token=…`), which browsers never send to the server. The page strips it from the address
  bar on load (`replaceState`) and keeps it in `sessionStorage`, but the browser's history
  may still record the first `#token=` URL: rotate the token (or clear that history) if
  you ever share the browser profile.
- Every API call carries it as a `Bearer` token, compared in constant time. Failed
  attempts are counted per IPv4 address or IPv6 `/64` prefix and answered with `429` once
  there are too many, while a request with the valid token always passes. The primary
  defense against guessing is the 256-bit random token itself.
- Remote peers share a 256-slot connection pool, separate from the 128-slot loopback
  pool, so remote traffic cannot lock out local or SSH-tunnelled access. On an
  off-loopback bind, unauthenticated peers can still fill the remote pool.
- On loopback the `Host` header must name the loopback address, which blocks DNS
  rebinding. A non-loopback bind also restricts `Host` to the bound address (on `0.0.0.0`
  or `::`, to IP literals and `localhost`), so a public domain rebound to the machine is
  refused too. A configured trusted name is accepted in addition, on either kind of bind,
  but only that exact name and never without the token. When an API or WebSocket request
  carries an `Origin` header, it must name exactly the same host and port as `Host`.
  Requests without one, such as non-browser clients, still need the bearer token.
- No CORS wildcard, and pages are served with a strict Content Security Policy.
- Browser tabs can change the port, stop the server or rotate the token, but cannot change
  its listen address (`host`) or its trusted host names through the API. Those are the
  same class of exposure change and stay desktop-only. That block is defense in depth, not
  a privilege boundary: anyone holding the token already has full control of the session,
  terminals and coding agents included (see above). Commands that only make sense on the host
  machine (voice input from its microphone, the embedded browser, the native clipboard,
  revealing or opening files, tray window controls) are refused over the web API.
- The token can be rotated on demand (**New token** in Settings → Connections → Remote
  access → Web access), which ends every other browser session immediately. Rotating from
  a browser tab keeps that tab signed in and ends all the others. Rotation does **not**
  undo lasting changes a previous token holder may have made: bots, schedules, Connect
  device grants, saved Web access auto-start settings, or files and commands run through
  agents or the terminal. Review those if a token leaked.

## Linux server

1. Install the binary and Tauri's Linux runtime libraries (GTK, webkit2gtk). `serve` uses
   the normal app runtime, so a Tauri window and webview are always created, with or
   without `--port`: a plain `serve` closes that window right after setup, while
   `serve --port` keeps it hidden and on `about:blank` because the web API replays its
   calls through that webview. A display must exist to *start*: run under `xvfb-run` (a
   virtual X server; PandaCode shows nothing).
2. Install and log in each agent CLI (`claude`, `codex`, …) and `gh` (pull-request links
   and private clones use it), with the server's own logins.
3. Sign in (above), then enable the service:

```ini
# /etc/systemd/system/pandacode.service
[Unit]
Description=PandaCode headless host
After=network-online.target
Wants=network-online.target

[Service]
User=pandacode
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x800x24" /usr/local/bin/pandacode serve
Restart=always
Environment=PANDACODE_SECRETS_FILE=1

[Install]
WantedBy=multi-user.target
```

- `ExecStart` is the whole launch, on every boot: repeat every flag the host must keep there,
  such as `--port 8787`, `--host` or `--device-name`. The crash guard is off under systemd,
  so its relaunch flags are not involved; edit the unit to change what a restart keeps.
- Set `RestartSec=` (for example `5s`) and a `StartLimitIntervalSec=`/`StartLimitBurst=`
  pair: `Restart=always` otherwise retries a host that keeps failing immediately, in a tight
  loop, where a short delay and a burst limit let systemd give up and leave the failure
  visible in `systemctl status`.
- Keep the `xvfb-run` wrapper: without a display Tauri aborts during GTK startup rather
  than reaching `serve`'s friendly "pandacode serve could not start: …" error, so journald
  shows the crash instead of the reason.
- `PANDACODE_SECRETS_FILE=1` keeps provider credentials in the same 0600 `secrets.json`
  file macOS uses, instead of the Secret Service a server doesn't have (and which cannot
  answer noninteractive reads). Set `PANDACODE_SECRETS_FILE=0` to use a keyring anyway.
  Log in each CLI/provider once; a keyring's old values are not migrated.
- **NTP required.** Connect refuses requests whose timestamp is more than a minute off.
- One instance per data dir. Don't run serve and the desktop app on the same data dir:
  serve skips the single-instance guard. This matters most across **versions**: a newer
  build repairs the shared database on open, and doing that underneath a running older
  build can leave it unable to write or even to read its teams. A build that knows the new
  schema heals such a process (it drops the dangling triggers and falls back to the
  snapshots), but a build from before it does not: it cannot recreate what the newer build
  removed, so restarting it may fail instead of help. Upgrading therefore means stopping and
  restarting every instance, `serve` included, not just the desktop, so no two versions ever
  share the folder. A sequential rollback of a single instance is safe: the older build
  recreates what it needs on open, and `user_version` stays 37, so both schemas' objects
  survive.
- Status lines go to stdout (journald): signed-in account, hosting, relay connection,
  online devices — printed only when they change.

## Mac mini (headless-ish)

A Mac without anyone logged in may refuse window creation over plain SSH (the spike that
mattered; the process itself needs no window). The supported recipe: enable automatic
login for the server's user and run a LaunchAgent with `RunAtLoad`:

```xml
<!-- ~/Library/LaunchAgents/ai.pandacode.serve.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>ai.pandacode.serve</string>
  <key>ProgramArguments</key><array>
    <string>/Applications/PandaCode.app/Contents/MacOS/pandacode</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

No xvfb, no `PANDACODE_SECRETS_FILE` (macOS already uses the 0600 file). Try plain
`ssh host pandacode serve` first — if it starts, skip the auto-login.

## Bots

Bots (channels, schedules, approval rules, their whole profile) are configured with one
JSON file applied inside the serve process — no UI, and channels come up live:

```sh
pandacode serve --import-bots bots.json
```

```json
{ "bots": [ {
    "name": "build-bot",
    "role": "Build assistant", "instructions": "…", "goals": "…", "soul": "optional persona",
    "provider": "claude", "model": "…", "mode": "auto", "heartbeatMinutes": 30,
    "skills": ["skill-id"], "mcp": ["server-name"],
    "channels": [
      { "kind": "telegram", "label": "main", "config": {},
        "secrets": { "token": "env:TELEGRAM_BOT_TOKEN" } },
      { "kind": "web" }
    ],
    "schedules": [ { "title": "Morning report", "prompt": "…", "kind": "daily", "timeOfDay": "09:00" } ],
    "rules": [ { "pattern": "npm test*", "decision": "allow" } ]
} ] }
```

- Fields and validation are the Settings UI's (`mode` is one of ask/auto/review/plan/full;
  schedule kinds are once/interval/daily/weekdays with `intervalMinutes`, `timeOfDay`
  HH:MM or a `runAt` ms timestamp for `once`; secret names per channel kind: telegram and
  discord need `token`, slack `token` + `app_token`, whatsapp `access_token` +
  `signing_secret` and a `config.phoneNumberId`; web needs nothing).
- Secret values are inline or `"env:NAME"`, read from the environment at import — put the
  tokens in the systemd unit's `Environment=`/`EnvironmentFile=`, not in the file.
- `--import-bots` is a startup, one-shot action: it runs once when this `serve` starts.
  A crash-guard restart deliberately drops the flag and its file rather than replaying
  them (re-applying converges, but every restart re-importing is not wanted). Re-run the
  command, or restart the unit that carries the flag, after editing the file.
- Importing is idempotent: bots match by name (existing profiles are updated), channels
  by kind+label, schedules by title, and rules by pattern (an edited decision replaces
  the old rule) — re-applying converges, so keep the file in version control and
  re-apply after edits. A bot that fails is reported and skipped; serve exits non-zero
  until the file is clean. Token shapes are checked at import (a truncated or swapped
  token fails the import instead of dying later).
- Web channels print their chat links at import
  (`http://127.0.0.1:<port>/chat/<id>#<token>`). The chat server binds loopback only:
  reach it through an SSH tunnel (`ssh -L 47321:127.0.0.1:47321 host`).
- `--export-bots bots.json` writes every bot's configuration without secrets (channels
  list `secretsNeeded` names; web tokens are excluded — a re-import mints a fresh link;
  already-fired once-schedules are omitted, since their run time is gone). Use it to
  snapshot or move a server's setup; put the tokens back before re-importing.

Schedules, rules, profiles and secrets are read fresh by a running serve; channels added
by hand (not through the import) need a restart to connect.

## Security

- The server dials the relay outbound (one WebSocket). No inbound ports (unless you pass
  `--port`), and the relay
  stores no task content: frames between your devices are end-to-end encrypted
  ([remote access](remote-access.md)).
- The server takes one of the account's 10 device slots; revoke it from any device's
  Remote access settings to cut it off instantly.
- It holds the worst a host can hold: provider CLI logins and project checkouts. Use a
  dedicated user, keep `secrets.json` (0600) and the app data dir private, and leave
  `--full-access` off unless you mean it.
- No new automatic requests beyond what Connect already makes on the desktop: the same
  relay socket, no update checks, no telemetry.
- `--port` opens a local listening socket (loopback by default) and makes no outbound
  requests; see [Local web UI](#local-web-ui---port) for its token and origin checks.

## Tasks after a crash

A task that was mid-run when the server restarted shows as interrupted; send it another
message (from any device) to resume. Queued messages survive and are delivered about ten
seconds after startup, unless their task is archived or still inside a usage limit (the
limit-resume send ends a run, which then delivers the queue). Cloud runs keep going on
their machines through server restarts.

Unless systemd runs it as a service, `serve` starts the crash guard (once the app is built,
before its run loop): after a crash it restarts `serve` with the serving modifiers from the
original launch — `--port`/`-p`, `--host`, `--device-name` and `--allowed-host` keep their
values and order, so a host started with `--port 8787` comes back with its web UI. One-shot
flags are dropped instead: `--sign-in`, `--sign-out`, `--full-access`, `--no-full-access`,
`--export-bots`, and `--import-bots <file>` (the file was applied at the original start; a
restart does not replay it). The restarted host appends all its output (including its
startup line about the crash, which ends with the absolute path of the `crash-reports`
folder and so names your home folder, the status line with your Connect GitHub login, and
error messages, which can name threads and contain project and file paths) to
`serve-restart.log` in the app data folder, and writes a
local report to `crash-reports/`. The log is owner-only on macOS and Linux (on Windows it gets
the permissions of the profile folder it is in) and moves to `serve-restart.log.1`
past 1 MB: the restarted host checks its size every 30 seconds on macOS and Linux, so it
can pass 1 MB by what it writes in 30 seconds, and opens it again if another process deleted
it (on Windows the size is checked only when a restart begins). The guard's own few lines go
to `crash-guard.log` beside it (moved to `crash-guard.log.1` past 1 MB when a guard starts).
Either log (and its `.1`), once last written more than 90 days ago (or dated more than a day
ahead), is deleted the next time `serve` (or the desktop app) starts, or within about a day
while one keeps running, but never by the process whose output it is: a restarted host's
own `serve-restart.log` is deleted by a later start. Crash reports older than 90 days go the
same way (also when the guard is off). Its crash history and notice live in `crash-guard-serve.json`, apart from the desktop
app's `crash-guard.json`, so the two never take each other's notice. On start after a crash it prints one line with the crash time in UTC, such as "PandaCode
crashed at 2026-11-12 14:32:05 UTC and restarted. Details: <path>" (never the cause).
`<path>` is that crash's report in the crash-reports folder when the notice names one, otherwise
the folder. Every line ends with ". Details: <path>". When it was not restarted it says "PandaCode
crashed at <time> and didn't restart: automatic restarts are off (turn them on in the desktop
app's Settings, or in crash-restart.json in the data folder)" (the switch was off), "…and didn't
restart: the restart failed" (starting the restart failed), or "…and didn't restart" for any
other reason, and "PandaCode kept crashing, last at <time>, and didn't restart; automatic
restarts resume by <time>" when restarts were paused (crash time plus 10 minutes; "automatic
restarts are on again" once that time is reached). A `serve` you start by hand during the guard's 1.5-second wait before its restart takes that
notice at startup and prints the "didn't restart" line, and the guard then starts no second host. A queued message
lost after a failed launch is logged by id, never its text. A `serve` started under
`xvfb-run` restarts as `xvfb-run -a … serve` on a fresh display; if there is no `xvfb-run` in
`/usr/bin` or `/bin` (`PATH` is not searched) the guard stays off and says why. A `serve` that cannot start prints
"pandacode serve could not start: <error>" and exits with status 1; it is not restarted.
A restarted host gets its own guard only once its app is built: one that dies before that
is not restarted again, and the next start prints the "didn't restart" line (when it
exits within 2 seconds the guard also logs it). The "restarted" line is printed only
by the host the guard relaunched, once it has taken the notice.
When systemd runs `serve` as a service there is no guard and the unit's `Restart=` setting
decides; `serve` logs "Crash guard is off: systemd runs this serve as a service, and
restarts are left to its Restart= setting." It counts as a service when `INVOCATION_ID` is
set and either `JOURNAL_STREAM` names its own stdout or stderr or its parent process is
`systemd` (the parent rule only for a `serve` started without `--crash-restart`). A host the
guard restarted runs without `INVOCATION_ID` and `JOURNAL_STREAM`, so it is never taken for
the service and keeps its guard. A `serve` typed into a terminal that itself runs under systemd inherits
`INVOCATION_ID` but still gets a guard; so does a service that runs `serve` through a
wrapper script with its output sent away from the journal. Running as process 1 (a container
without an init) there is no guard either, since nothing outlives it: use the container
runtime's restart policy. Set `PANDACODE_NO_CRASH_GUARD=1` to turn
it off.
See [crash recovery](crash-recovery.md).

## Maintenance checklist

Anything the frontend does after a run, on a timer, or on boot with real effects needs a
native twin in serve mode (`headless.rs`), or server behavior silently diverges:

- [ ] run-end side effects (the desktop's `done` handler in `main.ts`)
- [ ] timers with side effects (limit resumes live in `headless.rs`; turn checks are
      deliberately desktop-only)
- [ ] queue events (`queue-changed` emitters call `headless::queue_changed`)
