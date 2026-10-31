# Agent updates

Open **Settings → Agents → Agent updates → Check updates** to see the agents
PandaCode finds on this computer. PandaCode checks public release metadata in the
background every six hours and shows a popup when a newer version is available.
**Later** dismisses that release; a newer release can appear again.

Checking does not install anything. An installation starts only after choosing
**Update**. Finish running agents and Jev work, pause goals and teams, and close
terminals first. PandaCode checks the selected executable again before updating and
reads its version afterward. A successful updater exit alone does not mean that
the selected executable was updated.

**Manual update** means PandaCode cannot establish a supported update route for
that installation. Use its **Guide** link and the package manager or installer that
owns it. This includes custom wrappers, executables selected directly from a
version directory, and unrecognized package-manager installations. A network or
version-check failure appears as **Unavailable**, rather than **Up to date**.

Every agent PandaCode can start (`providers::PROVIDERS`) gets a row when it is
installed, including Pi, Oh My Pi, DeepSeek, Command Code, Cline, Kilo Code,
GitHub Copilot CLI and Muse Code. Agents without a supported route below show
their installed version and **Manual update**; PandaCode does not check a release
feed for them.

Claude Code, GLM Coding Plan, and MiMo can use the same Claude installation. Update
that installation once. A relay configured to use a separate or pinned executable
still needs its own installation checked.

## Supported PandaCode routes

Every route also requires a recognized stable launcher or package-manager receipt.
The executable's name alone is insufficient.

| Installation | One-click updates |
| --- | --- |
| Recognized native Claude, Codex, Grok, OpenCode v1, or Kimi Code | Official CLI updater. Codex requires version 0.154.0 or newer and a verified stable launcher pointing at its managed `current` release; Kimi Code requires 2.0.2 or newer. |
| npm Claude, Codex, or OpenCode v1 | Exact installed package and matching global npm prefix. |
| Homebrew Claude or Codex cask | Exact cask and stable Homebrew launcher. |
| Homebrew OpenCode v1 core formula | Verified `homebrew/core` receipt and stable launcher. |
| Legacy Python Kimi installed by uv | Verified `kimi-cli` tool receipt. |

Kimi npm/Homebrew installs, OpenCode v2, non-core Homebrew taps, other package
managers, and unrecognized custom locations need manual updates. Antigravity
shows its official guide without probing its ACP server version or checking an
update feed. PandaCode never substitutes the separate `agy` CLI updater.

Codex's optional background-update marker is not required for an explicit update.
Direct paths into a version directory stay manual; PandaCode never installs a
newer version in the background.

PandaCode reads the latest Kimi version from the canonical CDN's plain-text
`https://cdn.kimi.com/kimi-code/latest` feed but does not implement
Kimi's gradual-rollout timing. Its notification can therefore precede the
vendor's automatic update for that computer; installation still requires a click.

## Upstream updater reference

Verified against official documentation, source, public metadata, and local
help/version output on 2026-09-22. These are upstream capabilities; PandaCode only
enables **Update** when it recognizes the selected installation and can verify
that the command will update it.

| Agent/install family | Release metadata | Official update route and limits |
| --- | --- | --- |
| Claude Code native; GLM/MiMo using Claude | `https://downloads.claude.ai/claude-code-releases/{latest,stable}`; plain version | `claude update`. Preserve `autoUpdatesChannel` and managed version restrictions. A custom launcher may continue selecting an old version. |
| Codex native | `https://releases.openai.com/codex/channels/latest`; JSON `tag_name` with `rust-v` prefix | `codex update` on versions that expose it. The vendor command runs its official installer internally. A selected release file is distinct from the stable launcher. |
| Kimi Code native | `https://code.kimi.com/kimi-code/latest.json`; JSON `version` and rollout timing; `/latest` is a plain-version fallback | Current Kimi Code supports `kimi upgrade --yes`. Older native 0.26.0 lacks that noninteractive interface, so it needs manual updating. |
| Legacy Python Kimi CLI | `https://pypi.org/pypi/kimi-cli/json`; JSON `info.version` | `uv tool upgrade kimi-cli --no-cache` for a verified uv installation. This is a separate product/package from Kimi Code. |
| OpenCode v1 native | `https://api.github.com/repos/anomalyco/opencode/releases/latest`; JSON `tag_name` | `opencode upgrade <version> --method curl`. The vendor command runs its installer internally. OpenCode v2 uses a separate package and must not be selected as a v1 update. |
| Grok Build native | `https://x.ai/cli/{stable,alpha,enterprise}`; plain version | `grok --no-auto-update update` preserves the selected channel. `update --check --json` is also available, but a metadata request avoids starting the CLI for a background check. |
| Antigravity ACP server | [Official ACP registry entry](https://raw.githubusercontent.com/agentclientprotocol/registry/refs/heads/main/antigravity-acp/agent.json); JSON `version` and platform archives | Update through its owning installer/editor. `agy update` updates the separate terminal CLI, not PandaCode's `agy_acp_server.par` or `agy_acp_server.exe`. No verified server self-updater is assumed. |

For npm installations, the package names are `@anthropic-ai/claude-code`,
`@openai/codex`, `@moonshot-ai/kimi-code`, and `opencode-ai` (OpenCode v1).
OpenCode v2 uses `@opencode/cli`. Use the installed package's release feed and
preserve the package manager; matching a command's name is not enough to prove
ownership. The general upstream npm command for a checked version is
`npm install -g <package>@<version>`.

Homebrew releases can lag upstream. Use the installed formula/cask's metadata:
Claude's `claude-code` cask follows stable, while `claude-code@latest` follows
latest; Codex uses the `codex` cask; Kimi Code uses the `kimi-code` formula.
OpenCode's core formula, official tap, and v2 formula are distinct. Windows
WinGet Claude installations use `winget upgrade Anthropic.ClaudeCode`. Linux
system-package installations should remain with their owning package manager.

## Check and execution boundaries

- Metadata requests use fixed official HTTPS endpoints, deadlines, bounded
  responses, and a cache. They do not require agent credentials or ACP startup.
- Version probes disable the provider's background updater where supported.
  Never invoke an updater merely to discover whether an update is available.
- Supported checks preserve release channels and product families. Prerelease
  installations use manual updating.
- A stable launcher and a path pinned directly to its current version are
  different update targets, even when they resolve to the same file today.
- PandaCode leaves the process's installer-home environment unchanged. A custom
  home or installation location that cannot be matched safely stays manual.
- PandaCode invokes a fixed official CLI or recognized package manager. It does
  not construct downloaded shell installers or request administrator passwords.
  Windows file locks and system-package permissions can require manual action.

## Sources

- [Claude setup, channels, and package-manager updates](https://code.claude.com/docs/en/setup),
  [official installer metadata source](https://claude.ai/install.sh).
- [Codex CLI](https://developers.openai.com/codex/cli/),
  [0.154.0 updater implementation](https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/tui/src/update_action.rs),
  [official installer](https://chatgpt.com/codex/install.sh).
- [Kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html#kimi-upgrade),
  [legacy 0.26.0 native updater](https://raw.githubusercontent.com/MoonshotAI/kimi-code/%40moonshot-ai%2Fkimi-code%400.26.0/apps/kimi-code/src/cli/update/preflight.ts),
  [legacy Python installation guide](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/guides/getting-started.md).
- [OpenCode 1.18.31 installer implementation](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.31/packages/opencode/src/installation/index.ts),
  [OpenCode v2 documentation](https://opencode.ai/v2/docs).
- [Grok Build](https://docs.x.ai/build/overview),
  [official installer and channel metadata](https://x.ai/cli/install.sh).
- [Antigravity IDE extensions](https://antigravity.google/docs/ide/extensions),
  [separate Antigravity CLI installation](https://antigravity.google/docs/cli/install).
