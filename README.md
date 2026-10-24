# PandaCode

A small, native desktop workspace for coding agents. PandaCode runs the coding
CLIs you already use — **Claude Code, Codex, Kimi Code, OpenCode, GLM Coding
Plan and Xiaomi MiMo** (through Claude Code), **GitHub Copilot CLI, Antigravity,
xAI's Grok Build, DeepSeek, Command Code, Cline and Kilo Code** (through ACP), **Pi** and its
fork **omp** (through Pi's RPC mode), and Meta's **Muse Code** (through its MSP
protocol) — side by side, with your projects, Git, a
terminal and a browser in one window.

PandaCode is free and open source under the [PandaCode License](LICENSE), the MIT
License with one addition: forks that are used commercially or released publicly
must say "This is a fork of PandaCode" and link to this repository. There is no
account, no license key and no telemetry.

Built with Tauri 2, Rust, SQLite and plain TypeScript. It uses the operating
system's webview: no bundled Chromium, resident Node server, React runtime or
embedded editor engine.

<p align="center">
  <b>Download:</b>
  <a href="https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-macOS-arm64.dmg">macOS (Apple silicon)</a> ·
  <a href="https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-macOS-x64.dmg">macOS (Intel)</a> ·
  <a href="https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Windows-x64-setup.exe">Windows x64</a> ·
  <a href="https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Windows-arm64-setup.exe">Windows arm64</a> ·
  <a href="https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Linux-x86_64.AppImage">Linux x64</a> ·
  <a href="https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Linux-aarch64.AppImage">Linux arm64</a> ·
  <a href="https://github.com/aicodeking/pandacode/releases">All releases</a>
</p>

<p align="center">
  <img src="docs/screenshots/conversation.webp" alt="PandaCode with a finished Claude Code task: the reply explains the change, with the project's tasks in the sidebar and the composer below" width="100%">
</p>

## Features

- **Every harness in one place.** Pick the harness, model and reasoning effort
  per task; switch between them from the composer. See [providers](docs/providers.md).
- **Tasks and a task board.** Parallel tasks across projects, a Pending → In
  progress → Review → Completed [board](docs/task-board.md), message queueing
  and steering while an agent runs.
- **Agent teams.** An [architect and up to three workers](docs/architect-workers.md),
  mixing harnesses and models, or named team profiles. Each spawned worker is one
  line in the turn that started it; click it to open the worker.
- **Bots.** Put an agent behind Telegram, Slack, Discord, WhatsApp or a local web
  chat; each conversation is an ordinary task. The sidebar's **Bots** view lists
  every bot with its latest message. See [bots](docs/bots.md).
- **Local VMs and cloud sandboxes.** Headless macOS/Linux VMs on Apple silicon
  (Tart), and Daytona, Cloudflare and AWS sandboxes that agents can drive.
- **Cloud agents.** Pick a cloud provider in a New task's **Run on** menu and the
  agent runs on a machine in your own account (Daytona, Cloudflare, AWS, Google Cloud,
  E2B, Modal, Vercel Sandbox, CodeSandbox, Runloop, Blaxel, Tensorlake, Freestyle,
  boat). PandaCode installs the harness there, copies your login, and keeps the run
  going while your laptop sleeps; changes come back to a local worktree. See
  [cloud agents](docs/cloud-agents.md).
- **Simulators.** iOS Simulator and Android emulator tools for agents.
- **Deploys.** Start a deploy task for Vercel, Cloudflare, Railway, AWS or Google
  Cloud from the header, with approval-gated CLI runs (AWS and Google Cloud use
  your installed CLI and its login).
- **GitHub view.** Your repositories with their threads, pull requests and issues;
  review, fix checks, merge or solve an issue in one click. Each opens as a linked
  thread beside the GitHub view, where you can keep chatting. See [GitHub](docs/github.md).
- **Git and worktrees.** Diffs, staging, commits, per-task [worktrees](docs/worktrees.md)
  with a one-click local **Merge into main**, branch switching from the branch chip,
  and optional [GitHub](docs/github.md) issues and pull requests through `gh`,
  including merging a task's linked pull request.
- **Approvals at hand.** Requests wait in a slim bar above the prompt, one line
  each, grouped with **Approve all** when there are several.
- **Find in thread.** `⌘/Ctrl F` searches your messages and the agent's, with
  every match highlighted.
- **Review every turn.** Saved [turn changes](docs/turn-changes.md) with
  unified/split diffs, an embedded [browser](docs/browser.md), and file previews.
- **Token saver.** Per-task response-style packs that cut output tokens.
- **Quick overlay.** A global shortcut (default ⌘/Ctrl + Shift + Space) opens a
  launcher for new and running tasks from anywhere.
- **Agent usage.** Account limits and cost estimates for each installed harness
  ([agent usage](docs/agent-usage.md)), and one-click CLI updates
  ([agent updates](docs/agent-updates.md)).
- **Attachments.** Images, PDFs, documents, folders and a built-in mockup
  sketcher ([attachments](docs/attachments.md)).

## Screenshots

**A board for everything in flight.** Tasks from every project move from Pending to
Review, each with its harness, model and linked issue.

<img src="docs/screenshots/board.webp" alt="The task board with Pending, In progress, Review and Completed columns" width="100%">

<table>
  <tr>
    <td width="62%" valign="top"><img src="docs/screenshots/streaming.webp" alt="A reply streaming in, with the live working row and tool activity above it" width="100%"><br><sub><b>Live replies.</b> Responses stream in as Markdown, with tool activity folded above.</sub></td>
    <td width="38%" valign="top"><img src="docs/screenshots/model-picker.webp" alt="The harness and model picker listing Claude Code, Codex and Kimi Code models" width="100%"><br><sub><b>Any harness, any model.</b> Switch per task, with context size and reasoning effort.</sub></td>
  </tr>
</table>

**Agent teams.** An architect plans the work, runs workers in parallel across
harnesses, and reviews what they bring back.

<img src="docs/screenshots/agent-team.webp" alt="An agent team's finished run: the architect's summary, the combined changed files and two completed workers" width="100%">

**Your app beside the chat.** The iOS Simulator and Android emulator run in the
inspector on a lifelike device, so you can tap through what an agent just built.

<img src="docs/screenshots/simulator.webp" alt="The inspector showing an iPhone 17 Pro simulator next to the conversation" width="100%">

**Bots that keep working.** A bot's conversation is an ordinary task thread, with
the same streaming, composer and model picker; reach it from Telegram, Slack,
Discord, WhatsApp or a browser too.

<img src="docs/screenshots/bot.webp" alt="A bot named Scout replying with a morning digest" width="100%">

<table>
  <tr>
    <td width="58%" valign="top"><img src="docs/screenshots/diff.webp" alt="The changed-files viewer with a syntax-highlighted unified diff" width="100%"><br><sub><b>Review every turn.</b> Each turn saves its changes, with unified and split diffs.</sub></td>
    <td width="42%" valign="top"><img src="docs/screenshots/bot-settings.webp" alt="Bot settings with tabs for profile, conversations, memory, schedules, channels, rules and activity" width="100%"><br><sub><b>Bot settings.</b> Memory, schedules, channels and rules, in one place.</sub></td>
  </tr>
</table>

<sub>Screenshots come from the browser preview with sample data. Regenerate them with
`npm run screenshots` (see [`scripts/screenshots`](scripts/screenshots/capture.spec.ts)).</sub>

## Privacy

- **No telemetry, no analytics, no accounts.** PandaCode does not phone home.
- **Your code stays on your machine.** Projects, conversations and settings are
  stored locally in SQLite. Prompts go only to the coding CLI or service you
  pick, under that provider's own terms.
- **It only talks to services you choose.** Provider keys (GLM, MiMo, DeepSeek, Command Code, cloud
  sandboxes, bot channels, connection secrets) are sent only to that provider.
  On macOS they live in `secrets.json` in PandaCode's app data folder, readable
  only by your user (0600), never the Keychain, so updates never ask for your
  login password; keys saved in the Keychain by older versions move there on
  first use. Linux keeps them in the Secret Service and Windows in Credential
  Manager.

A few automatic checks send no personal data — just plain requests for public
information:

| What | Where | How often |
| --- | --- | --- |
| Latest versions of installed coding CLIs | `formulae.brew.sh`, `downloads.claude.ai`, `api.github.com`, `cdn.kimi.com` | About every 6 hours |
| Plan usage checks for your signed-in agents | That agent's provider | When you open the menu bar item or the Usage dialog |
| Public model price list (for cost estimates) | `raw.githubusercontent.com` | Daily |
| PandaCode's own updates (`latest.json` on this repository's latest release) | `github.com` | At launch and about every 6 hours; turn off in Settings → About |
| Cloud agents (optional): the task's checkout, prompt and harness login go to the machine you chose; PandaCode checks on its active runs | The cloud provider you connected | Only for tasks you start on a cloud provider; while a run is active and at launch to re-attach |
| PandaCode Connect (optional): GitHub sign-in, then the relay that forwards your devices' end-to-end encrypted messages | `github.com`, the PandaCode relay | Only after you sign in under Settings → Remote access; nothing before |

## Install

Download the latest build from
[GitHub Releases](https://github.com/aicodeking/pandacode/releases/latest):

| Platform | File | Requirements |
| --- | --- | --- |
| macOS (Apple silicon) | [`PandaCode-macOS-arm64.dmg`](https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-macOS-arm64.dmg) | macOS 12+ |
| macOS (Intel) | [`PandaCode-macOS-x64.dmg`](https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-macOS-x64.dmg) | macOS 12+ |
| Windows x64 | [`PandaCode-Windows-x64-setup.exe`](https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Windows-x64-setup.exe) | Windows 10 1809+ or Windows 11 |
| Windows arm64 | [`PandaCode-Windows-arm64-setup.exe`](https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Windows-arm64-setup.exe) | Windows 11 on ARM (Snapdragon X and similar) |
| Linux x64 | [`PandaCode-Linux-x86_64.AppImage`](https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Linux-x86_64.AppImage) | Ubuntu 22.04+ or compatible, X11 or XWayland |
| Linux arm64 | [`PandaCode-Linux-aarch64.AppImage`](https://github.com/aicodeking/pandacode/releases/latest/download/PandaCode-Linux-aarch64.AppImage) | Ubuntu 24.04+ aarch64 or compatible, X11 or XWayland |

Or from a terminal: `npx pandacode` downloads the latest build, verifies its
signature and installs it (on macOS it is signed locally for you, so no
Gatekeeper prompt). `npx pandacode --dry-run` only downloads and verifies.

With [Homebrew](https://brew.sh): `brew install --cask aicodeking/pandacode/pandacode`
on macOS, or `brew install aicodeking/pandacode/pandacode` on Linux
([details](docs/homebrew.md)).

Release builds are not code-signed, so your OS will warn the first time:

- **macOS:** the build carries an ad-hoc signature and is not notarized, so macOS
  refuses to open it, and **Open Anyway** in **System Settings → Privacy &
  Security** does not always clear it. Run `xattr -dr com.apple.quarantine
  /Applications/PandaCode.app` once instead; `npx pandacode` signs the app locally
  and needs no such step.
- **Windows:** if SmartScreen appears, click **More info → Run anyway**.
- **Linux:** `chmod +x PandaCode-Linux-x86_64.AppImage` (or `-aarch64`), then run it. Some
  distributions need FUSE 2 (`libfuse2`), or set `APPIMAGE_EXTRACT_AND_RUN=1`.

Each file has a `.sha256` checksum beside it. Once installed, PandaCode updates
itself: it checks the latest release, downloads a newer version in the background,
verifies its signature, and restarts to install it when no agent is working and
you've stepped away (or when you click **Restart to update**). Turn this off in
Settings → About. See [platform support](docs/platform-support.md) for details.

Then install Git and at least one coding CLI and sign in with its normal login.
PandaCode does not include provider plans or usage.

[Pi](https://github.com/earendil-works/pi) installs with `npm i -g @earendil-works/pi-coding-agent`; sign in through Pi's own CLI. PandaCode drives it over Pi's RPC mode and gives it PandaCode's app tools through a local loopback bridge extension. Pi has no approval system of its own, so PandaCode's extension enforces the permission modes; the integrated console needs Full access.

[omp (Oh My Pi)](https://github.com/can1357/oh-my-pi), a Pi fork that runs on Bun, installs with `bun install -g @oh-my-pi/pi-coding-agent`; sign in through `omp` itself. PandaCode drives it with the same RPC bridge as Pi and passes `--approval-mode yolo` so the bridge stays the only approval gate.

[DeepSeek](https://platform.deepseek.com/api_keys) installs with `npm i -g @deepseek-ai/dsh`; PandaCode launches `dsh --profile acp`. An API key is optional (Settings → Providers, or `DEEPSEEK_API_KEY`); dsh can use its own stored credentials. Usage limits are not shown in PandaCode; check platform.deepseek.com.

[Command Code](https://commandcode.ai/docs/acp) installs with `npm i -g command-code` (Node 22 or newer); PandaCode launches `command-code acp`. Sign in once with `command-code login`, or save an API key in Settings → Providers (or set `COMMAND_CODE_API_KEY`); either one authenticates the same account. Usage limits are not shown in PandaCode; check Command Code Studio.
[Cline](https://docs.cline.bot/cline-cli/overview) installs with `npm i -g cline`; PandaCode launches `cline --acp`. Sign in once with `cline auth` (or set `CLINE_API_KEY`); the provider and models chosen in Cline apply. See [provider details](docs/providers.md#cline).

[Kilo Code](https://kilo.ai/docs/code-with-ai/platforms/cli) installs with `npm i -g @kilocode/cli`; sign in with `kilo auth login`, then select **Kilo Code** in PandaCode. PandaCode launches `kilo acp` and uses Kilo's configured providers and models. See [provider details](docs/providers.md#kilo-code).

Muse Code installs with Meta's launcher into `~/.local/bin/muse`; run `muse login` once in a terminal. PandaCode launches `muse serve` and speaks MSP, Muse's JSON-RPC session protocol, with its sandbox and approval modes; see [docs/providers.md](docs/providers.md#muse-code) for what each mode does and what Muse cannot express.

[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) installs with `npm install -g @github/copilot`; run `copilot login` in a terminal, then select **GitHub Copilot CLI** in PandaCode. PandaCode launches the local `copilot` executable over ACP. The CLI manages its own sign-in. See [provider details](docs/providers.md#github-copilot-cli).

## Build from source

You need Node.js 22, stable Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
git clone https://github.com/aicodeking/pandacode.git
cd pandacode
npm ci
npm run desktop        # same as: npm run tauri dev
```

`npm run dev` serves only the frontend. In a regular browser it runs a labeled,
device-local sample workspace for UI work; files, Git and terminals are
simulated there. `npm run tauri build` makes a local installer, and
`npm run release:build` builds the release asset for your OS (see
[releasing](docs/releasing.md)).

The website lives in [website/](website/): `npm run site:dev` and
`npm run site:build`.

## Use

Open a project folder, then click **New task** or press `⌘/Ctrl N`. A centered
"What should we build in …?" page opens in the last active project with the
message box focused. Choose the harness and model from the searchable picker in
the message box; new tasks remember your last choice. The **+** button attaches
images, documents, folders, project files or a mockup. Open **Changes** to
inspect and stage diffs, or the terminal to run shell commands. Conversations
and provider session IDs persist across restarts; agents start only for active
turns.

In **Files**, click an HTML, SVG, image or PDF to open it in the sidebar browser.
Filenames mentioned in responses become clickable and resolve against the task's
own project or worktree.

The bar above the prompt shows the project, checkout and branch. Its branch chip
is the one place for [worktrees](docs/worktrees.md): an unstarted task moves into
a new worktree in place, a started one spawns a sibling task, and archiving a
clean worktree task offers to remove its checkout and merged branch.

Choose **Board** in the header to manage tasks by status. Choose **Team** in the
composer for an automatic team, or set up an architect and workers. Each turn's
tool calls sit inside a compact **Worked for …** row; final answers and errors
stay visible, and approval requests wait in the bar above the prompt.

The branch chip also switches the project checkout to `main` or another local
branch, and in a worktree task offers **Merge into main**: it merges the
worktree's committed work locally, refuses uncommitted changes or conflicts
without touching anything, then offers to remove the worktree.

**Standard** permissions keep each provider's native checks. Claude's **Accept
edits** allows its editing tools; Codex uses its workspace sandbox with
on-request approvals. **Full access** enables the harness's broadest mode. See
[provider details](docs/providers.md).

Type `/` at the start of a message for the harness's commands and skills
([slash commands](docs/slash-commands.md)).

Keyboard shortcuts: `⌘/Ctrl N` new task, `⌘/Ctrl K` command palette,
`⌘/Ctrl J` terminal, `⌘/Ctrl B` sidebar, `⌘/Ctrl ,` settings, `⌘/Ctrl F` find
in thread (`⌘/Ctrl G` next match), `Enter` send (queues while an agent runs),
`⌘/Ctrl Enter` steer, `Shift Enter` newline, `⌘/Ctrl +/−/0` interface size (the
whole interface scales, not just text).

On macOS, if folder access is denied, use **Browse** to select the folder, or
allow PandaCode under **System Settings → Privacy & Security → Files & Folders**.

PandaCode includes [21 anime scenery wallpapers](docs/wallpapers.md), a
different morning, afternoon and night scene for each weekday. **Settings →
Daily wallpapers** turns them off. You can also import VS Code color themes.

The [optional Jev add-on](docs/jev.md) adds work review, project-rule checks and
app testing in isolated Chrome profiles. It is off by default and PandaCode works
fully without it.

## Resource limits

No background directory polling or recursive file watchers. Agents exit after
each turn and resume by provider session ID. After a Claude Code turn, the next
turn's process starts in the background so a follow-up skips the CLI's startup;
at most two wait at a time, each for up to 10 minutes. PandaCode's fixed
instructions go to Claude-family harnesses once as a cached system prompt rather
than in every message. The interface has no transitions: everything appears at
once, and a thread you return to is drawn in a single frame. Terminal and Markdown code load only
when needed. Terminal history, provider frames, files, diffs and streamed text
all have explicit limits; only the current 100-message page of a conversation is
loaded. **Resource usage** reports native core RSS, active agents, terminals and
database size (core RSS excludes the system webview and provider processes).

## Tests

```sh
npx tsc --noEmit           # typecheck
npm run build && npm test  # unit tests (some read dist/)
npm run test:release       # release script tests
npm run test:rust          # cargo test
npx playwright test        # browser suite (Chrome)
npx playwright test -c playwright.webkit.config.ts   # WebKit
```

Ordinary tests make no paid model calls. Opt-in live tests are `#[ignore]`d;
see [providers](docs/providers.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the pull request process, and [AGENTS.md](AGENTS.md) for code conventions. Please
follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues
privately as described in [SECURITY.md](SECURITY.md). Bugs and ideas go in
[GitHub issues](https://github.com/aicodeking/pandacode/issues).

Architecture notes: [design](docs/design.md), [native IPC](docs/ipc.md),
[research](docs/research.md). Provider protocols live in
`src-tauri/src/providers.rs` behind one normalized event interface; ACP harnesses
share `acp.rs`.

## Data

Data lives in Tauri's per-user application data directory (on macOS,
`~/Library/Application Support/ai.pandacode.desktop/`) in `kingcode.sqlite3`; the
database keeps its legacy internal name. Project source stays in the folders you
open, and removing a project from the app never deletes its files.

## License

[PandaCode License](LICENSE) (MIT with an attribution requirement for forks) ©
2026 PandaCode contributors. Provider names and logos belong to
their owners and do not imply endorsement ([brand assets](docs/brand-assets.md)).
