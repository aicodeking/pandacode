# Cloud agents

A task can run its agent on a cloud machine instead of this computer. In a New task, the
context bar's computer menu ("This computer", other Connect computers) also lists
**Cloud** targets: every provider connected in Settings → Cloud (Daytona, Docker, DigitalOcean,
Vultr, Hetzner, RunPod, Cloudflare, AWS EC2, Google Cloud, E2B, Modal, Vercel Sandbox,
CodeSandbox, Runloop, Blaxel, Tensorlake, Freestyle, Railway, boat, InstaBox). Picking one and
sending starts the task there. The
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
- `cloud_instabox_images() → {images: [{value, label}], selected}` and
  `cloud_instabox_set_image({image}) → same` — the InstaBox machine image (below).

## Provider settings

Keyed providers connect through `cloud_connect(provider, key, options)`:

| Provider | Key | Options |
| --- | --- | --- |
| docker | — (no credentials) | `engine` (`docker`, `podman`, `apple` for Apple Containers on this machine, or `lxc` for the LXD/Incus client — which selects its own remote, so no endpoint), `endpoint` (empty for this machine's daemon, `ssh://[user@]host[:port]` over the shared SSH transport — for Podman this runs the remote podman directly, `tcp://host:port` with TLS (Docker only), or `unix:///path`), `image` (default `ubuntu:24.04`), and `tlsCa`/`tlsCert`/`tlsKey` paths for `tcp://` Docker hosts. One container or instance per task, named `pc-…` (labelled `pandacode` on Docker/Podman/Apple; the prefix is the ownership marker on LXC, which has no labels). Machines keep their disk until deleted and use the host's own resources. A Docker daemon is root-equivalent on its machine — an endpoint is a trust decision like any VPS |
| digitalocean | API token | `region` (default `nyc1`). Droplets carry the `pandacode` tag and are persistent VMs: the disk survives stop/start, and DigitalOcean bills a droplet while it exists even when powered off — the panel's **delete** is what ends the billing. The first create registers an account SSH key holding the shared keypair's public half (`cloud/ssh.rs`), matched by key material so several computers can share the account |
| vultr | API key | `region` (default `ewr`). Instances carry the `pandacode` tag; the Ubuntu 24.04 image is picked by name from the account's OS list at create (Vultr has no image slugs), and `user_data` is sent base64-encoded. Bill while they exist, stopped included — delete ends the billing |
| hetzner | API token | `location` (default `fsn1`). Servers carry the `pandacode=true` label and are persistent VMs billed while they exist; CPX22 on the stock Ubuntu 24.04 image. Stop is a graceful shutdown followed by a hard poweroff, as Hetzner's own guidance orders them |
| runpod | API key | `gpu` (default an RTX 3090) and `image` (default RunPod's own Ubuntu 24.04 base image, which ships SSH configured). Pods expose SSH on their public IP through the container's port 22 and authorize PandaCode's key with the documented `SSH_PUBLIC_KEY` pod variable; only pods named `pc-…` (the run pipeline's names) appear in the panel. The container disk is cleared when a pod stops (only the `/workspace` volume survives), so pods are non-persistent: a stopped pod is replaced by a fresh one and rehydrated, like Cloudflare's sandboxes. A running pod bills its GPU until stopped — the panel's stop releases it |
| e2b | API key | — |
| modal | token secret | `tokenId` (required), `environment` |
| codesandbox | API key | — |
| runloop | API key | — |
| blaxel | API key | `workspace` (required) |
| tensorlake | API key | — |
| freestyle | API key | — |
| boat | API key | `apiUrl` |
| instabox | API key | — (machines start from the image chosen after connecting, see [InstaBox](#instabox); `exec` output is read back from a file because InstaBox keeps only its first 1 MiB; at most 60 unattended minutes) |
| vercel | (existing deploy token) | `projectId` and `teamId` for Sandbox, saved in `Settings.providers["vercel"]` |
| railway | (existing deploy token) | `workspace` (existing) |
| gcloud | (gcloud CLI login) | `zone` for Compute Engine VMs, saved in `Settings.providers["gcloud"]` |

Non-secret options live in `cloud::Settings.providers[<id>]`; a `detail` entry there is
shown in Settings. Secrets use `cloud::set_secret("<id>_key", …)`.

## InstaBox

**Machine image.** Once InstaBox is connected, its card in Settings → Cloud has a
Machine image select filled from the API: `agent-browser` (the default), the account's
`ready` snapshots (name · ID), and other templates only when the org new machines go to
(the key's workspace, else the personal org, `GET /v1/orgs` `tier`) is on a paid plan;
the free plan creates from `agent-browser` only (`403 template_not_allowed`). The choice is
saved as `snapshotId` or `template` in `Settings.providers["instabox"]`, and
`cloud_instabox_set_image` saves only a value the account's current list offers. It
applies to machines created afterwards. A create from a snapshot with storage restores
it first and took between 1.5 and 10 minutes live (from a template: seconds).

**A snapshot without the desktop tool.** `agent-browser` ships an `open-computer-use`
MCP server in `~/.claude.json`, which agents sometimes reach for instead of Bash. To get
machines without it:

1. Create a machine from `agent-browser` in the InstaBox dashboard.
2. In its terminal, remove the server (Codex has no such entry):

   ```sh
   jq 'del(.mcpServers["open-computer-use"])' ~/.claude.json > ~/.claude.json.new \
     && mv ~/.claude.json.new ~/.claude.json && chmod 600 ~/.claude.json
   ```

   Install anything else every task should have, but sign in to nothing: a snapshot keeps
   HOME (`/data/home`), credentials included.
3. Stop the machine, then save a snapshot of it (dashboard, or
   `POST /v1/machines/{id}/snapshots` with `{"name": "clean-agents"}`; a stopped
   machine's snapshot is ready at once). The source machine can then be deleted.
4. Pick `clean-agents · sn_…` as the Machine image in Settings → Cloud.

**Staying awake.** `keep_alive` takes an activity lease
(`PUT /v1/machines/{id}/activity-leases/pandacode`, at most 3600 s), which also wakes a
paused machine; when it expires a full idle period starts. It also PATCHes
`autoSuspendAfterSeconds`, which only accounts with manual lifecycle (`GET /v1/me`
`manualLifecycle`) get: every other account keeps the fixed 30-minute idle pause and the
reply says 1800 whatever was sent.

**Reconnecting after a pause.** A pause freezes processes, and after a resume clients
such as Claude Code reuse keep-alive sockets to the model API whose connections are gone,
and hang. `keep_alive` starts a small watcher on the machine (once per boot,
`~/.pandacode/reconnect.sh`) that notices the wall clock jumping ahead of `/proc/uptime`
and closes established outbound connections to ports 443 and 80 with `sudo -n ss -K`,
so clients reconnect. This needs passwordless sudo, which `agent-browser` and snapshots
of it have; on an image without it the watcher closes nothing.

## Privacy

Nothing is sent anywhere until the user connects a provider and starts a cloud task. A
cloud task sends the checkout, the prompt, and the harness's login to the chosen
provider's machine in the user's own account. One thing more travels only when asked
for: with **Include provider environment variables** turned on for a cloud (Settings →
Agents → Cloud sandboxes, off by default), the harness's saved variables from
Settings → Providers ride the same run — a proxy the cloud machine can reach, for
example. They land in the same 0600, self-deleting command file as the login token,
the harness's own credentials always win over them, and a variable whose proxy points
at this computer (`127.0.0.1`, `localhost`) refuses to start the task, because a
cloud machine cannot reach it.
