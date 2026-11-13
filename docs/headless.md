# Headless server (`pandacode serve`)

The same PandaCode binary runs as an always-on **host** on a server: started over SSH, no
desktop session, no one watching. Your devices — the mobile app and other computers'
PandaCode — see the server as one more computer in PandaCode Connect and can start, watch,
steer and approve tasks on it, including cloud runs ([cloud agents](cloud-agents.md)). There
is no webview and no window: the desktop frontend never runs on a server.

Nothing changes for the desktop app. `pandacode` with no arguments is the ordinary GUI;
`pandacode serve …` is the host.

## What the server runs

`serve` builds the real app — storage, provider credentials, the queue, bots, the
cloud-agent resume loop, Connect hosting (`setup_common` in `lib.rs`, shared with the
desktop startup) — then closes the window from `tauri.conf.json` and keeps the process
alive. Everything user-facing happens on your devices. The few jobs the desktop window
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

## Linux server

1. Install the binary and Tauri's Linux runtime libraries (GTK, webkit2gtk — they are
   linked even though no webview is created). A display must exist to *start*: run under
   `xvfb-run` (a virtual X server; PandaCode renders nothing).
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

- `PANDACODE_SECRETS_FILE=1` keeps provider credentials in the same 0600 `secrets.json`
  file macOS uses, instead of the Secret Service a server doesn't have (and which cannot
  answer noninteractive reads). Set `PANDACODE_SECRETS_FILE=0` to use a keyring anyway.
  Log in each CLI/provider once; a keyring's old values are not migrated.
- **NTP required.** Connect refuses requests whose timestamp is more than a minute off.
- One instance per data dir. Don't run serve and the desktop app on the same data dir:
  serve skips the single-instance guard.
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

- The server dials the relay outbound (one WebSocket). No inbound ports, and the relay
  stores no task content: frames between your devices are end-to-end encrypted
  ([remote access](remote-access.md)).
- The server takes one of the account's 10 device slots; revoke it from any device's
  Remote access settings to cut it off instantly.
- It holds the worst a host can hold: provider CLI logins and project checkouts. Use a
  dedicated user, keep `secrets.json` (0600) and the app data dir private, and leave
  `--full-access` off unless you mean it.
- No new automatic requests beyond what Connect already makes on the desktop: the same
  relay socket, no update checks, no telemetry.

## Tasks after a crash

A task that was mid-run when the server restarted shows as interrupted; send it another
message (from any device) to resume. Queued messages survive and are delivered about ten
seconds after startup, unless their task is archived or still inside a usage limit (the
limit-resume send ends a run, which then delivers the queue). Cloud runs keep going on
their machines through server restarts.

Unless systemd runs it as a service, `serve` starts the crash guard (once the app is built,
before its run loop): after a crash it restarts as a plain
`serve`, appends all its output (including its startup line about the crash, which ends with the
absolute path of the `crash-reports` folder and so names your home folder, the status line
with your Connect GitHub login, and error messages, which can name threads and contain
project and file paths) to
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
