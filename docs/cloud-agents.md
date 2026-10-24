# Cloud agents

A task can run its agent on a cloud machine instead of this computer. In a New task, the
context bar's computer menu ("This computer", other Connect computers) also lists
**Cloud** targets: every provider connected in Settings → Cloud (Daytona, Cloudflare,
AWS EC2, Google Cloud, E2B, Modal, Vercel Sandbox, CodeSandbox, Runloop, Blaxel,
Tensorlake, Freestyle, Railway, boat). Picking one and sending starts the task there. The
task then reads like any other task: streaming transcript, approvals, questions, steering,
queue, model picker. It keeps running when the laptop sleeps or PandaCode quits, and
catches up when it comes back.

## How it works

1. **Machine.** `cloud::sandbox::connected(provider)` returns a `Box<dyn Sandbox>`
   (`src-tauri/src/cloud/sandbox.rs`: list/create/power/state/exec/keep_alive/spawn/
   upload/download). One machine per cloud task, named `pc-<first 8 of task id>`. Machine
   IDs stay `provider:native`, so the VM panel and `pandacode_vm_*` tools see it too.
2. **Runtime.** `cloud_agents::setup::ensure_runtime` installs what the harness needs
   (git, Node when needed, the harness CLI) idempotently, with a version marker in
   `~/.pandacode/runtime/<harness>`. Supported harnesses: `claude`, `glm`, `mimo`
   (Claude Code relays), `codex`, `opencode`. Others refuse with a clear message.
3. **Credentials.** `cloud_agents::credentials::push` copies the local logins the harness
   needs (files written 0600, never logged, re-pushed before every run so the remote copy
   is fresh) and returns environment variables for the agent process (API keys of keyed
   relays, `GH_TOKEN` from `gh auth token`, git identity). Claude: a long-lived token
   from `claude setup-token` stored in Settings → Cloud is preferred
   (`CLAUDE_CODE_OAUTH_TOKEN`); otherwise the local Claude Code credentials are copied.
4. **Checkout.** The local task gets its own worktree on branch `pandacode/cloud-<short>`
   (the "mirror worktree"), created from the current branch, uncommitted changes
   included as a first commit. `cloud_agents::sync::upload_checkout` sends it as a git
   bundle to `$HOME/pandacode/<task id>` on the machine. After every run,
   `sync::pull_changes` commits the machine's changes there, fetches them back as a
   bundle and fast-forwards the mirror worktree, so the inspector's Changes tab, PR flow
   and Run script work locally. If the mirror worktree has local edits, the cloud commits
   stay on `refs/pandacode/cloud/<task id>` and the task says so. Before a run, local
   commits the machine lacks go up first (`sync::push_local`).
5. **Run.** The agent runs detached on the machine under a small runner
   (`cloud_agents/runner.sh`): its stdin is the append-only file `inbox`, its stdout and
   stderr go to `out` and `err`, and `exit` holds the exit code, in
   `~/.pandacode/runs/<run id>/`. Locally the run uses the ordinary provider pipeline
   (`providers::run_with_tools`, the same `Protocol`, sink, persistence, approvals and
   steering): only the transport differs. Lines PandaCode writes to the agent are
   appended to `inbox`; `out` is polled from a byte offset (adaptive: fast while output
   flows, slower when idle, backing off on network errors with a "Reconnecting…"
   status). PandaCode's local MCP host tools are not offered to cloud runs.
6. **Sleep, quit, resume.** Closing the laptop pauses only the local poller; the run
   continues because `keep_alive` asked the provider to keep the machine up (capped by
   `Info::max_unattended_minutes`). Quitting PandaCode leaves the remote run alone. At
   startup, and when a poll succeeds again, every cloud task whose run was active
   re-attaches: the log is replayed from offset 0 into a fresh `Protocol`, lines already
   in `inbox` are not written again, and the run ends normally (messages saved, queue
   delivered, changes pulled). Stop kills the remote process group.
7. **Idle.** After a run ends, `keep_alive(…, 15)` lets the machine stop on its own.
   The next prompt starts it again (`power start`); a non-persistent machine
   (`Info::persistent == false`) or a deleted one is recreated and rehydrated from the
   mirror worktree plus the harness's saved session files
   (`sync::save_harness_state`/`restore_harness_state`, kept in app data), so
   `--resume` keeps working.

## State

`sessions.cloud` (schema 27) is a JSON object or NULL:
`{provider, machine, remoteDir, base, stage, detail, runId, offset, inboxLines}`.
`stage` is one of `creating`, `installing`, `credentials`, `uploading`, `ready`,
`running`, `reconnecting`, `syncing`, `stopped`, `error`. The session JSON sent to the
webview carries it as `cloud` (`{provider, label, machine, stage, detail}`), and every
change emits `cloud-agent://progress` `{sessionId, stage, detail}` plus
`sessions-changed`.

## IPC

- `cloud_agent_targets() → [{provider, label, ready}]` — providers that can run agents
  and whether they are connected.
- `cloud_agent_start({sessionId?, projectId, provider, prompt, harness, model, mode,
  effort}) → Session` — turns the empty New task draft (or a new row) into a cloud task,
  answers at once, then prepares the machine in the background (progress events) and
  sends `prompt` as the first message. Images are refused like Connect mirrors.
- `cloud_agent_action({sessionId, action})` — `sync` (pull changes now), `retry` (redo a
  failed preparation), `stop` (stop the machine), `delete` (delete the machine; the task
  stays and will recreate one on the next prompt), `open` (select the machine in the VM
  panel).
- Follow-ups, stop, approvals, input, steering: the ordinary commands.

## Provider settings

Keyed providers connect through `cloud_connect(provider, key, options)`:

| Provider | Key | Options |
| --- | --- | --- |
| e2b | API key | — |
| modal | token secret | `tokenId` (required), `environment` |
| codesandbox | API key | — |
| runloop | API key | — |
| blaxel | API key | `workspace` (required) |
| tensorlake | API key | — |
| freestyle | API key | — |
| boat | API key | `apiUrl` |
| vercel | (existing deploy token) | `projectId` and `teamId` for Sandbox, saved in `Settings.providers["vercel"]` |
| railway | (existing deploy token) | `workspace` (existing) |
| gcloud | (gcloud CLI login) | `zone` for Compute Engine VMs, saved in `Settings.providers["gcloud"]` |

Non-secret options live in `cloud::Settings.providers[<id>]`; a `detail` entry there is
shown in Settings. Secrets use `cloud::set_secret("<id>_key", …)`.

## Privacy

Nothing is sent anywhere until the user connects a provider and starts a cloud task. A
cloud task sends the checkout, the prompt, and the harness's login to the chosen
provider's machine in the user's own account.
