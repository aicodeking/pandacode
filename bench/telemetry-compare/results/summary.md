# Idle launch telemetry, 2026-10-30

5 cold launches per app, alternating order, each with a new empty `$HOME`, measured 60 s after launch with nothing clicked and no agents running. Median (min–max). Ratio = PandaCode / T3 Code (below 1: PandaCode used less).

## Resources and disk

| Metric | PandaCode | T3 Code | Ratio |
| --- | ---: | ---: | ---: |
| Physical footprint at end, process tree (MB) | 418 (413–435) | 633 (549–635) | 0.66 |
| Resident memory (RSS) at end, process tree (MB) | 709 (692–728) | 964 (951–967) | 0.74 |
| Peak RSS during the window (MB) | 1062 (1026–1219) | 1112 (1108–1129) | 0.96 |
| CPU time, launch to 60 s (s) | 10.26 (6.54–10.87) | 7.37 (7.19–9.02) | 1.39 |
|   of which app processes (s) | 3.23 (2.58–3.45) | 7.02 (6.59–8.39) | 0.46 |
|   of which tools it started (s) | 6.97 (3.75–7.54) | 0.50 (0.30–0.78) | 14.03 |
| Tool processes started (harness CLIs, shells, npm, git…) | 18 (17–21) | 6 (4–7) | 3.00 |
| CPU time, last 30 s (idle) (s) | 0.10 (0.07–0.29) | 0.65 (0.63–0.75) | 0.16 |
| Processes at end | 7 (7–7) | 7 (7–7) | 1.00 |
| Threads at end | 43 (42–62) | 140 (138–141) | 0.31 |
| Time to first on-screen window (ms) | 740 (449–951) | 2906 (1545–3302) | 0.25 |
| Data written by launch: fresh $HOME + bench-owned ~/Library caches (MB) | 5.45 (5.45–5.46) | 12.58 (12.56–12.59) | 0.43 |
|   of which the app's own data dirs (MB) | 1.12 (1.12–1.13) | 9.79 (9.77–9.80) | 0.11 |
| Files written to the fresh $HOME | 20 (19–20) | 344 (343–344) | 0.06 |
| Remote flows (non-loopback) | 18 (14–18) | 21 (18–22) | 0.86 |
| Bytes received over those flows (KB) | 256.6 (156.8–581.2) | 750.1 (747.4–766.4) | 0.34 |
| Bytes sent over those flows (KB) | 10.1 (7.9–10.2) | 46.3 (45.2–55.0) | 0.22 |
| App bundle size on disk (MB) | 48.6 | 456.5 | 0.11 |

## Hosts contacted by PandaCode at idle launch

By name (first DNS match, else certificate CN, else reverse DNS): **registry.npmjs.org** (node; 5/5 runs, ~190.0 KB in per run, averaged over all runs), **downloads.claude.ai** (pandacode; 5/5 runs, ~5.0 KB in per run, averaged over all runs), **releases.openai.com** (pandacode; 5/5 runs, ~72.7 KB in per run, averaged over all runs), **storage.googleapis.com** (pandacode; 5/5 runs, ~2.4 KB in per run, averaged over all runs), **github.com** (pandacode; 5/5 runs, ~13.8 KB in per run, averaged over all runs), **raw.githubusercontent.com** (pandacode; 5/5 runs, ~6.9 KB in per run, averaged over all runs), ***.github.com** (pandacode; 4/5 runs, ~30.6 KB in per run, averaged over all runs), **api.github.com** (pandacode; 1/5 runs, ~0.6 KB in per run, averaged over all runs).

| Remote | Proto | Identified as | Process | Runs seen | First seen (s, median) | In / out per run seen (KB, median) |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 104.16.9.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 4/5 | 9.5 | 12.9 / 1.0 |
| 104.16.5.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 2/5 | 9.5 | 0.0 / 0.0 |
| 104.16.11.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 3/5 | 10.0 | 31.4 / 2.0 |
| 104.16.3.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 2/5 | 10.5 | 0.0 / 0.0 |
| 104.16.6.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 3/5 | 10.5 | 0.0 / 0.0 |
| 140.82.113.6:443 | tcp4 | cert *.github.com (SAN *.github.com, github.com) | pandacode | 1/5 | 10.5 | 18.8 / 0.5 |
| 35.190.46.17:443 | tcp4 | DNS match downloads.claude.ai; cert downloads.claude.ai (SAN downloads.claude.ai, downloads.claude.com); rDNS 17.46.190.35.bc.googleusercontent.com | pandacode | 5/5 | 11.5 | 4.4 / 0.5 |
| 172.64.144.117:443 | tcp4 | DNS match releases.openai.com | pandacode | 5/5 | 11.5 | 87.3 / 0.5 |
| 142.250.31.207:443 | tcp4 | DNS match storage.googleapis.com; cert invalid2.invalid (SAN invalid2.invalid) | pandacode | 1/5 | 11.5 | 0.0 / 0.0 |
| 172.253.122.207:443 | tcp4 | DNS match storage.googleapis.com; cert invalid2.invalid (SAN invalid2.invalid); rDNS bh-in-f207.1e100.net | pandacode | 1/5 | 11.5 | 2.7 / 0.5 |
| 104.16.7.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 4/5 | 13.0 | 0.0 / 0.0 |
| 104.16.8.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 3/5 | 13.0 | 0.0 / 0.0 |
| 104.16.1.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 2/5 | 13.5 | 164.3 / 4.0 |
| 140.82.113.5:443 | tcp4 | DNS match api.github.com; cert *.github.com (SAN *.github.com, github.com); rDNS lb-140-82-113-5-iad.github.com | pandacode | 1/5 | 13.5 | 3.1 / 0.5 |
| 104.16.2.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 1/5 | 13.5 | 0.0 / 0.0 |
| 142.251.163.207:443 | tcp4 | DNS match storage.googleapis.com; cert invalid2.invalid (SAN invalid2.invalid); rDNS wv-in-f207.1e100.net | pandacode | 2/5 | 14.0 | 3.4 / 0.5 |
| 140.82.114.6:443 | tcp4 | cert *.github.com (SAN *.github.com, github.com) | pandacode | 2/5 | 14.0 | 59.7 / 0.5 |
| 104.16.4.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 3/5 | 14.5 | 0.0 / 0.0 |
| 104.16.10.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 3/5 | 14.5 | 0.0 / 0.0 |
| 140.82.114.5:443 | tcp4 | cert *.github.com (SAN *.github.com, github.com) | pandacode | 1/5 | 14.5 | 14.8 / 0.5 |
| 142.251.16.207:443 | tcp4 | DNS match storage.googleapis.com; cert invalid2.invalid (SAN invalid2.invalid); rDNS bl-in-f207.1e100.net | pandacode | 2/5 | 15.0 | 1.4 / 0.4 |
| 104.16.0.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | node | 2/5 | 18.5 | 125.5 / 4.0 |
| 140.82.114.4:443 | tcp4 | cert github.com (SAN github.com, www.github.com) | pandacode | 2/5 | 32.0 | 13.9 / 0.8 |
| 140.82.114.3:443 | tcp4 | DNS match github.com, www.github.com; cert github.com (SAN github.com, www.github.com) | pandacode | 1/5 | 32.5 | 13.9 / 0.7 |
| 140.82.113.3:443 | tcp4 | cert github.com (SAN github.com, www.github.com); rDNS lb-140-82-113-3-iad.github.com | pandacode | 2/5 | 33.5 | 13.8 / 0.7 |
| 185.199.111.133:443 | tcp4 | DNS match raw.githubusercontent.com; cert *.github.io (SAN *.github.com, *.github.io, *.githubusercontent.com, github.com) | pandacode | 5/5 | 34.5 | 9.8 / 1.4 |

Processes attributed to the app (process tree plus processes macOS holds it responsible for), with the command line when `ps` could read it:

| Process | Command | Runs seen | CPU per instance (s, median) |
| --- | --- | ---: | ---: |
| com.apple.WebKit.WebContent | `/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent` | 5/5 | 2.13 |
| node | `node ~/.hermes/node/bin/command-code --version` | 5/5 | 0.86 |
| node | `node ~/.nvm/versions/node/v25.6.0/bin/pi --version` | 5/5 | 0.84 |
| pandacode | `<repo>/src-tauri/target/release/bundle/macos/PandaCode.app/Contents/MacOS/pandacode` | 5/5 | 0.56 |
| kimi | `~/.kimi-code/bin/kimi --version` | 5/5 | 0.42 |
| opencode | `~/.opencode/bin/opencode --version` | 5/5 | 0.39 |
| node | `node ~/.local/bin/npm view command-code versions --json` | 2/5 | 0.35 |
| node | `npm view command-code versions` | 2/5 | 0.33 |
| node | `npm` | 3/5 | 0.30 |
| com.apple.WebKit.GPU | `/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU` | 5/5 | 0.21 |
| com.apple.SafariPlatformSupport.Helper | `/System/Library/PrivateFrameworks/SafariPlatformSupport.framework/Versions/A/XPCServices/com.apple.SafariPlatformSupport.Helper.xpc/Contents/MacOS/com.apple.SafariPlatformSupport.Helper` | 5/5 | 0.15 |
| xcodebuild | `/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -license check` | 5/5 | 0.10 |
| com.apple.WebKit.Networking | `/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking` | 5/5 | 0.06 |
| node | `node ~/.hermes/node/bin/dsh --version` | 4/5 | 0.04 |
| node | `<defunct>` | 3/5 | 0.04 |
| node | `node ~/.hermes/node/bin/cline --version` | 1/5 | 0.04 |
| muse-bin-1.4.14-R7309.1 | `<defunct>` | 1/5 | 0.03 |
| SetStoreUpdateService | `/System/Library/PrivateFrameworks/CascadeSets.framework/Versions/A/XPCServices/SetStoreUpdateService.xpc/Contents/MacOS/SetStoreUpdateService` | 5/5 | 0.02 |
| node | `node ~/.nvm/versions/node/v25.6.0/bin/kilo --version` | 2/5 | 0.02 |
| com.apple.audio.SandboxHelper | `/System/Library/Frameworks/AudioToolbox.framework/XPCServices/com.apple.audio.SandboxHelper.xpc/Contents/MacOS/com.apple.audio.SandboxHelper` | 5/5 | 0.02 |
| python3.11 | `~/.hermes/hermes-agent/venv/bin/python3 ~/.hermes/hermes-agent/venv/bin/hermes --version` | 1/5 | 0.02 |
| muse-bin-1.4.14-R7309.1 | `~/.local/bin/muse-bin-1.4.14-R7309.1 --version` | 3/5 | 0.02 |
| codex | `~/.local/bin/codex --version` | 3/5 | 0.01 |
| uv | `~/.local/bin/uv tool dir` | 1/5 | 0.01 |
| codesign | `/usr/bin/codesign -dvv <repo>/src-tauri/target/release/bundle/macos/PandaCode.app` | 1/5 | 0.01 |
| git | `git branch --show-current` | 5/5 | 0.01 |
| bash | `~/.hermes/hermes-agent/venv/bin/python3 ~/.hermes/hermes-agent/venv/bin/hermes --version` | 1/5 | 0.01 |
| grok-1.0.62 | `~/.local/bin/grok --version` | 2/5 | 0.01 |
| bash | `bash ~/.local/bin/muse --version` | 2/5 | 0.01 |
| env | `node ~/.hermes/node/bin/cline --version` | 1/5 | 0.01 |
| rtk | n/a | 1/5 | 0.01 |
| .cline | n/a | 1/5 | 0.01 |
| bash | `/bin/sh ~/.hermes/hermes-agent/venv/bin/hermes --version` | 1/5 | 0.01 |
| uv | `/opt/homebrew/bin/uv tool dir` | 1/5 | 0.00 |
| env | `/bin/sh ~/.hermes/hermes-agent/venv/bin/hermes --version` | 1/5 | 0.00 |
| .kilo | n/a | 1/5 | 0.00 |
| dirname | n/a | 1/5 | 0.00 |
| bash | n/a | 1/5 | 0.00 |
| git | n/a | 1/5 | 0.00 |

Non-loopback listening sockets: none.

## Hosts contacted by T3 Code at idle launch

By name (first DNS match, else certificate CN, else reverse DNS): **raw.githubusercontent.com** (T3 Code (Nightl; 5/5 runs, ~22.1 KB in per run, averaged over all runs), **registry.npmjs.org** (T3 Code (Nightl; 5/5 runs, ~10.0 KB in per run, averaged over all runs), **docs.anthropic.com** (2.1.311; 5/5 runs, ~1.3 KB in per run, averaged over all runs), **us-east-1.aws.edge.axiom.co** (T3 Code (Nightl; 5/5 runs, ~14.5 KB in per run, averaged over all runs), **relay.t3.codes** (T3 Code (Nightl; 5/5 runs, ~4.8 KB in per run, averaged over all runs), **github.com** (T3 Code (Nightl; 5/5 runs, ~409.7 KB in per run, averaged over all runs), **unidentified 104.18.34.146** (T3 Code (Nightl; 4/5 runs, ~229.5 KB in per run, averaged over all runs), **unidentified 192.168.10.1** (T3 Code (Nightl; 3/5 runs, ~0.0 KB in per run, averaged over all runs), **unidentified 172.64.153.110** (T3 Code (Nightl; 2/5 runs, ~57.2 KB in per run, averaged over all runs), **gcp.nel.cloudflare.com** (T3 Code (Nightl; 2/5 runs, ~5.0 KB in per run, averaged over all runs).

| Remote | Proto | Identified as | Process | Runs seen | First seen (s, median) | In / out per run seen (KB, median) |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 185.199.111.133:443 | tcp4 | DNS match raw.githubusercontent.com; cert *.github.io (SAN *.github.com, *.github.io, *.githubusercontent.com, github.com) | T3 Code (Nightl | 5/5 | 5.5 | 9.0 / 1.9 |
| 104.16.5.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | T3 Code (Nightl | 3/5 | 5.5 | 10.0 / 3.9 |
| 160.79.104.10:443 | tcp4 | DNS match docs.anthropic.com, claude.ai, api.anthropic.com, platform.claude.com | 2.1.311 | 5/5 | 5.5 | 0.0 / 1.5 |
| 104.16.0.34:443 | tcp4 | DNS match registry.npmjs.org; cert npmjs.org (SAN npmjs.org, *.npmjs.org) | T3 Code (Nightl | 2/5 | 5.5 | 10.0 / 3.9 |
| 35.190.80.1:443 | tcp4 | cert gcp.nel.cloudflare.com (SAN gcp.nel.cloudflare.com, a.nel.cloudflare.com, xn--668h.nel.cloudflare.com); rDNS 1.80.190.35.bc.googleusercontent.com | T3 Code (Nightl | 2/5 | 9.5 | 12.5 / 5.1 |
| 44.216.55.45:443 | tcp4 | DNS match us-east-1.aws.edge.axiom.co; cert us-east-1.aws.edge.axiom.co (SAN us-east-1.aws.edge.axiom.co, hec.us-east-1.aws.edge.axiom.co) | T3 Code (Nightl | 3/5 | 9.5 | 4.8 / 12.5 |
| 192.168.10.1:53 | udp4 | no rDNS, no cert | T3 Code (Nightl | 3/5 | 10.0 | 0.0 / 0.1 |
| 104.18.34.146:443 | tcp4 | no rDNS, no cert | T3 Code (Nightl | 4/5 | 10.5 | 286.2 / 9.0 |
| 35.190.80.1:443 | udp4 | cert gcp.nel.cloudflare.com (SAN gcp.nel.cloudflare.com, a.nel.cloudflare.com, xn--668h.nel.cloudflare.com); rDNS 1.80.190.35.bc.googleusercontent.com | T3 Code (Nightl | 1/5 | 10.5 | 0.0 / 2.4 |
| 172.64.153.110:443 | tcp4 | no rDNS, no cert | T3 Code (Nightl | 2/5 | 12.5 | 143.1 / 4.5 |
| 104.21.3.218:443 | tcp4 | DNS match relay.t3.codes, ingest.t3.codes | T3 Code (Nightl | 3/5 | 13.5 | 4.8 / 3.3 |
| 172.67.153.155:443 | tcp4 | DNS match relay.t3.codes, ingest.t3.codes | T3 Code (Nightl | 2/5 | 14.0 | 4.8 / 3.3 |
| 32.196.68.31:443 | tcp4 | DNS match us-east-1.aws.edge.axiom.co; cert us-east-1.aws.edge.axiom.co (SAN us-east-1.aws.edge.axiom.co, hec.us-east-1.aws.edge.axiom.co) | T3 Code (Nightl | 4/5 | 16.5 | 12.1 / 11.8 |
| 140.82.113.3:443 | tcp4 | cert github.com (SAN github.com, www.github.com); rDNS lb-140-82-113-3-iad.github.com | T3 Code (Nightl | 2/5 | 19.5 | 409.7 / 4.1 |
| 140.82.114.3:443 | tcp4 | DNS match github.com, www.github.com; cert github.com (SAN github.com, www.github.com) | T3 Code (Nightl | 3/5 | 19.5 | 409.7 / 4.1 |
| 185.199.110.133:443 | tcp4 | DNS match raw.githubusercontent.com; cert *.github.io (SAN *.github.com, *.github.io, *.githubusercontent.com, github.com) | T3 Code (Nightl | 1/5 | 21.0 | 13.1 / 4.5 |
| 185.199.109.133:443 | tcp4 | DNS match raw.githubusercontent.com; cert *.github.io (SAN *.github.com, *.github.io, *.githubusercontent.com, github.com); rDNS cdn-185-199-109-133.github.com | T3 Code (Nightl | 1/5 | 21.5 | 13.1 / 4.7 |
| 185.199.108.133:443 | tcp4 | DNS match raw.githubusercontent.com; cert *.github.io (SAN *.github.com, *.github.io, *.githubusercontent.com, github.com); rDNS cdn-185-199-108-133.github.com | T3 Code (Nightl | 1/5 | 22.0 | 13.1 / 4.7 |

Processes attributed to the app (process tree plus processes macOS holds it responsible for), with the command line when `ps` could read it:

| Process | Command | Runs seen | CPU per instance (s, median) |
| --- | --- | ---: | ---: |
| T3 Code (Nightly) Helper | `/Applications/T3 Code (Nightly).app/Contents/Frameworks/T3 Code (Nightly) Helper.app/Contents/MacOS/T3 Code (Nightly) Helper --type=gpu-process --user-data-dir=$HOME/Library/Application Support/t3code` | 5/5 | 2.25 |
| T3 Code (Nightly) Helper (Renderer) | `/Applications/T3 Code (Nightly).app/Contents/Frameworks/T3 Code (Nightly) Helper (Renderer).app/Contents/MacOS/T3 Code (Nightly) Helper (Renderer) --type=renderer --user-data-dir=$HOME/Library/Applica` | 5/5 | 1.94 |
| T3 Code (Nightly) | `/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly) --require /Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/desktop/dist-electron/compileCache.cjs /Applications` | 5/5 | 1.94 |
| T3 Code (Nightly) | `/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)` | 5/5 | 1.43 |
| 2.1.311 | `claude --output-format stream-json --verbose --input-format stream-json --setting-sources=user,project,local --strict-mcp-config --permission-mode default --no-session-persistence --settings {"disable` | 5/5 | 0.34 |
| T3 Code (Nightly) Helper | `/Applications/T3 Code (Nightly).app/Contents/Frameworks/T3 Code (Nightly) Helper.app/Contents/MacOS/T3 Code (Nightly) Helper --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US` | 5/5 | 0.20 |
| xcodebuild | `/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -license check` | 5/5 | 0.07 |
| codex | `codex app-server` | 5/5 | 0.07 |
| SetStoreUpdateService | `/System/Library/PrivateFrameworks/CascadeSets.framework/Versions/A/XPCServices/SetStoreUpdateService.xpc/Contents/MacOS/SetStoreUpdateService` | 5/5 | 0.02 |
| t3-resource-monitor | `/Applications/T3 Code (Nightly).app/Contents/Resources/resource-monitor/t3-resource-monitor` | 5/5 | 0.01 |
| codex | `~/.local/bin/codex --version` | 2/5 | 0.01 |
| security | `(security)` | 1/5 | 0.01 |
| security | `security find-generic-password -a <user> -w -s Claude Code` | 1/5 | 0.01 |
| zsh | `/bin/zsh -ilc printf '%s\n' '__T3CODE_ENV_PATH_START__'; printenv PATH \|\| true; printf '%s\n' '__T3CODE_ENV_PATH_END__'; printf '%s\n' '__T3CODE_ENV_DBUS_SESSION_BUS_ADDRESS_START__'; printenv DBUS_SE` | 3/5 | 0.01 |
| git | `git -c core.hooksPath=/dev/null -c core.fsmonitor= -C /private$HOME/.t3/userdata ls-files --error-unmatch -- :(icase).claude/settings.local.json` | 5/5 | 0.01 |
| T3 Code (Nightly) | `ioreg -rd1 -n product` | 1/5 | 0.00 |
| git | `/Library/Developer/CommandLineTools/usr/bin/git -c safe.bareRepository=explicit ls-remote https://github.com/openai/plugins.git HEAD` | 1/5 | 0.00 |
| zsh | n/a | 1/5 | 0.00 |

Non-loopback listening sockets: none.

## Where the launch writes

PandaCode (last run, largest paths under the fresh $HOME): `.npm/_cacache/content-v2/sha512` 2442 KB, `Library/Caches/kimi-code/native` 1989 KB, `Library/Application Support/ai.pandacode.bench/kingcode.sqlite3-wal` 455 KB, `Library/Application Support/ai.pandacode.bench/kingcode.sqlite3-shm` 32 KB, `Library/Application Support/ai.pandacode.bench/kingcode.sqlite3` 4 KB, `.npm/_logs` 3 KB, `.npm/_cacache/index-v5/c4` 1 KB, `Library/Application Support/ai.pandacode.bench/remote.json` 0 KB, `.commandcode` 0 KB, `.pi/agent` 0 KB.
Paths under the real ~/Library named after its bundle ID with a newer mtime after launch: `~/Library/Caches/ai.pandacode.bench`, `~/Library/WebKit/ai.pandacode.bench`.

T3 Code (last run, largest paths under the fresh $HOME): `Library/Application Support/t3code-v2/GraphiteDawnCache` 5733 KB, `.codex` 2558 KB, `.t3/userdata` 868 KB, `.t3/userdata/logs/server.trace.ndjson` 841 KB, `Library/Application Support/t3code-v2/DawnGraphiteCache` 544 KB, `Library/Application Support/t3code-v2/DawnWebGPUCache` 544 KB, `Library/Application Support/t3code-v2/GPUCache` 544 KB, `Library/Application Support/t3code-v2/Cache` 277 KB, `.t3/userdata/logs/desktop.trace.ndjson` 209 KB, `.codex/skills/.system/imagegen` 124 KB, `Library/Application Support/t3code-v2/Partitions` 113 KB, `.codex/skills/.system/openai-docs` 90 KB.
Paths under the real ~/Library named after its bundle ID with a newer mtime after launch: none.

Machine: Mac16,5, Apple M4 Max, 48 GB, macOS 27.0.1. PandaCode 0.3.79 (`ai.pandacode.bench`, commit 37ef134), T3 Code 0.1.3-nightly.20261026.3717. Raw numbers: 2026-10-30.json. Method and limitations: ../README.md.
