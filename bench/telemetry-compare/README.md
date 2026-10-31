# PandaCode vs T3 Code: idle launch telemetry

This benchmark launches the production desktop builds of PandaCode and T3 Code as a brand-new user would see them, leaves each one idle for 60 s, and records what it did: every outbound connection made by any process attributed to the app, memory, CPU time, process and thread counts, the data it wrote, and when its first window appeared. Nothing is clicked and no agent runs.

Summary of all findings, with references: [SUMMARY.md](SUMMARY.md).

Results: [results/summary.md](results/summary.md). Raw per-run numbers, per-process breakdowns and every flow: `results/<date>.json`. A static reading of each app's telemetry code is in [static-audit.md](static-audit.md) (written separately).

## What is measured

Each run creates a new empty directory, launches the app through LaunchServices with `HOME` pointing at it (`open -n -F --env HOME=<dir> <App.app>`), samples for `IDLE_S` seconds (default 60) from the moment `open` is called, then quits the app and removes the directory.

| Metric | How |
| --- | --- |
| Which processes belong to the app | A small Swift probe (compiled from source embedded in `run.mjs` into `.build/`) lists all processes every 150 ms. A process counts when it is the app's main executable, a descendant of it, or a process macOS holds the app *responsible* for (`responsibility_get_pid_responsible_for_pid`). The last rule is what catches WKWebView's WebContent, Networking and GPU services, which are children of launchd, not of PandaCode. The command line of each new process is read once with `ps`. |
| Network flows | `nettop -L 0 -s 1 -n` runs for the whole window and prints every TCP and UDP flow of every process once a second. Flows of the app's processes are kept unless they are on `lo0` or to 127.0.0.1/::1. Bytes are the largest cumulative in/out counts nettop reported for the flow. Non-loopback listening sockets are listed separately. |
| Host names | nettop shows addresses only. After all runs, each remote address is labelled three ways: (1) **DNS match**: every `http(s)://` host name found anywhere in either bundle (raw bytes, about 970 names) is resolved, and names that currently resolve to that address are listed; (2) **cert**: a TLS handshake to the address on port 443 without SNI, reporting the default certificate's CN and first SANs; (3) reverse DNS. |
| Physical footprint | `footprint -f bytes -p …` over every process alive at the end of the window, summed. This is the number Activity Monitor shows as "Memory". |
| RSS, CPU time, threads | From `proc_pidinfo(PROC_PIDTASKINFO)` in the probe: resident size, user + system CPU time (converted from Mach ticks), thread count. CPU is the sum, over every process seen during the window, of the largest CPU time it reached, so short-lived processes count too. "Last 30 s" is the CPU used between 30 s and 60 s, after start-up work has settled. |
| App vs tools | Both apps start command-line tools at launch (harness CLIs with `--version`, `npm view`, login shells, `git`). Processes whose executable is inside the app bundle or under `/System/` (WebKit, Metal, Electron helpers) are "app"; everything else is "tools". Both are part of the app's footprint; the split shows where the cost comes from. |
| Data written | Total size of all files in the fresh `HOME` after the app has quit, plus anything under the real `~/Library/{Caches,WebKit,HTTPStorages,Preferences,Saved Application State,Logs}` named after the bench build's bundle ID (`ai.pandacode.bench`; WKWebView writes `~/Library/Caches/<id>` and `~/Library/WebKit/<id>` under the real home whatever `HOME` says). Those bench-owned paths are deleted before and after each PandaCode run. "App's own data dirs" excludes the caches written by the tools it started (`.npm`, `.codex`, `Library/Caches/kimi-code` …). |
| Time to first window | First probe tick (150 ms period) at which a process of the app owns an on-screen, layer-0 window at least 100 px tall (`CGWindowListCopyWindowInfo`), measured from the call to `open`. It includes LaunchServices' own launch overhead, which is the same for both apps. It is when the window exists, not when its content is painted. |
| Bundle size | `du -sk` of each `.app`. |

The order alternates each round (PandaCode first, then T3 Code first), with 5 s between launches. Medians are over `RUNS` (default 5) runs per app.

## How each app runs

**PandaCode**: this repository's `main` at the recorded commit, built as the release bundle (`[profile.release]`: thin LTO, `opt-level = "s"`, one codegen unit, stripped, `panic = "abort"`; the build log reports `Finished release profile [optimized]`). The bundle ID is overridden to `ai.pandacode.bench` on the command line only (no config file changes), so the build gets its own data directory and its own single-instance lock, and cannot collide with an installed PandaCode that is running. The fresh `HOME` means the app starts with no projects, tasks, settings or keys.

**T3 Code**: the installed production Electron build, `/Applications/T3 Code (Nightly).app`. T3 Code derives every path from `os.homedir()` (which follows `HOME`) or `T3CODE_HOME`: `~/.t3` for its server state and `~/Library/Application Support/t3code-v2` for Electron's user data, where its single-instance lock also lives. With the fresh `HOME` both are new and empty. The bench refuses to start if any process from the T3 Code bundle is already running.

Neither app is configured in any way: whatever telemetry, crash reporting or update checks each one does by default for a new user is what is measured. The harness CLIs that each app finds on the machine are the ones installed for the user; they run with the fresh `HOME` as well, so they have no logins.

## Environment of the published run

| | |
| --- | --- |
| Machine | Mac16,5 (`sysctl hw.model`), Apple M4 Max, 48 GB RAM |
| OS | macOS 27.0.1 |
| PandaCode | 0.3.79, commit recorded in the JSON (`37ef134`), release bundle built from that commit, bundle ID `ai.pandacode.bench` |
| T3 Code | T3 Code (Nightly) 0.1.3-nightly.20261026.3717 (`com.t3tools.t3code`), Electron |
| Network | Home Wi-Fi, no proxy or VPN in the path |
| Runs | 5 cold launches per app, 60 s each, alternating order |

The machine was not otherwise idle: an installed PandaCode (hosting the agent that ran this bench) and other agents were running. That load is the same for both apps but adds noise to CPU and timing numbers.

## Reproduce

```sh
# 1. PandaCode release bundle with its own bundle ID (no file changes)
npm ci
CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false \
  npx tauri build --bundles app --config '{"identifier":"ai.pandacode.bench"}'
# -> src-tauri/target/release/bundle/macos/PandaCode.app

# 2. T3 Code (Nightly) installed in /Applications, and not running

# 3. Measure (needs Xcode command line tools for swiftc)
node bench/telemetry-compare/run.mjs                 # RUNS=5 IDLE_S=60 by default
RUNS=9 IDLE_S=120 node bench/telemetry-compare/run.mjs
```

`CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false` turns off symbol stripping for build scripts and proc macros only. With the repository's `strip = true` applied to them, this machine's toolchain (rustc 1.93, macOS 27) produced a `ctor_proc_macro` dylib that rustc could not load (`E0463 can't find crate`). The app binary itself is still stripped. Updater signing does not block the build: `createUpdaterArtifacts` is not enabled in `tauri.conf.json`.

Other bundles: `PANDACODE_APP=/path/PandaCode.app`, `T3_APP=/path/T3.app`. `OWNED_IDS` (default `ai.pandacode.bench`) lists bundle IDs whose real `~/Library` caches the bench may measure and delete; never put an ID there whose data belongs to you.

`run.mjs` writes `results/<date>.json` and `results/summary.md`, with the home directory written as `~`, the repository as `<repo>` and the user name as `<user>`. `FROM_JSON=results/<date>.json node bench/telemetry-compare/run.mjs` rebuilds the summary from a raw file without launching anything. It only signals processes it launched (SIGTERM to the app, then SIGKILL to anything left of its process tree after 10 s), and kills them on error or Ctrl-C.

## What the published run shows

Medians of 5 launches, 60 s each (full table and every flow in [results/summary.md](results/summary.md)):

- **Memory**: physical footprint 418 MB for PandaCode against 633 MB for T3 Code (0.66); 43 threads against 140.
- **Idle CPU**: 0.10 s against 0.65 s of CPU in the last 30 s of the window. Over the whole minute PandaCode used more CPU (10.3 s against 7.4 s), but about 7 s of it is the harness CLIs it starts once at launch to detect them (`<cli> --version` for every installed agent CLI, and `npm view command-code versions`); its own processes used 3.2 s against T3 Code's 7.0 s.
- **First window**: 740 ms against 2,906 ms after `open`.
- **Disk**: 48.6 MB bundle against 456.5 MB. A launch wrote 5.5 MB (1.1 MB in PandaCode's own data directory, the rest npm and Kimi CLI caches) against 12.6 MB (9.8 MB in T3 Code's own directories, mostly GPU shader caches and a server trace log).
- **Network, PandaCode**: the app process fetched release metadata from GitHub (`github.com`, `api.github.com`, `raw.githubusercontent.com`; the app updater and version checks) and contacted `downloads.claude.ai`, `releases.openai.com` and `storage.googleapis.com` (address matches; release hosts of harness CLIs); `node` processes it started (npm) contacted `registry.npmjs.org`. No analytics or telemetry host was seen.
- **Network, T3 Code**: besides GitHub, `raw.githubusercontent.com` and `registry.npmjs.org`, the Electron main process sent data to `us-east-1.aws.edge.axiom.co` (Axiom, a log and trace ingestion service; about 18 KB sent per run) and to an address that resolves for `ingest.t3.codes` / `relay.t3.codes`, and reported to Cloudflare's network error logging endpoint (`*.nel.cloudflare.com`) in 2 of 5 runs. The `claude` CLI it starts at launch contacted an Anthropic address, and it ran `security find-generic-password … -s "Claude Code"` (reading the Claude Code login from the keychain) in one run. Two Cloudflare addresses (104.18.34.146, 172.64.153.110) could not be identified.

## Known limitations

- **Short flows can be missed.** nettop samples once a second. A connection that opens and closes between two samples may not appear; in testing, a single `curl` request (one TLS round trip, about 1 s at this RTT) was caught, but a sub-second flow to a nearby CDN might not be. Packet capture would be exact but needs root.
- **Traffic made by system daemons on the app's behalf is not attributed.** DNS lookups go through `mDNSResponder`, certificate checks through `trustd`, and some downloads through `nsurlsessiond`. Those processes serve every app and are not counted. Connections an app makes itself are counted, including UDP DNS sent directly from its own process (T3 Code's main process does this).
- **Host names are inferred.** nettop gives addresses, not names. A DNS match means a name found in a bundle currently resolves to that address; on shared CDN addresses (Cloudflare, Fastly, GitHub's CDN) more than one service can share an address, and a service whose name is not written in either bundle (for example, one a harness CLI contacts) gets no DNS match. The certificate shown is the server's default without SNI, which may belong to another site on the same address. The labels are good leads, not proof; the static audit gives the endpoints from code.
- **Byte counts are per flow, at nettop's last sample.** Bytes sent after the last sample of a flow that then closed are missed, and TLS overhead is included.
- **Tools started by the apps depend on what is installed.** Both apps detect harness CLIs at launch. On another machine with different CLIs, both the tool CPU and the tool traffic (for example PandaCode's `npm view` for a CLI's versions) change. The app/tool split makes this visible.
- **CPU and timing are noisy on a busy machine.** Other apps and agents were running. The order alternates to spread that noise, and medians are reported with ranges.
- **Quit is SIGTERM, not a menu quit.** Sending an Apple Event to quit would need Automation permission. SIGTERM may skip some shutdown writes (for example a final SQLite checkpoint), for both apps alike.
- **Disk outside `HOME`.** Only the real `~/Library` paths named after the bench build's bundle ID are measured. A write elsewhere under the real home (for example by a tool resolving the home directory from the user database instead of `HOME`) is not counted. For T3 Code, real `~/Library` paths named `com.t3tools.t3code…` are checked by modification time only, never read; none changed during the published runs.
- **Responsibility can over-attribute.** macOS also makes the app responsible for generic system XPC services it uses (`SetStoreUpdateService`, `MTLCompilerService`, `com.apple.audio.SandboxHelper`). They are listed per process in the summary and are small.
- **Not the same as a first install.** Gatekeeper's first-launch check and the app's first `codesign` verification happened before the bench (both apps had been launched on the machine before), so launch times are warm-cache launches with a fresh profile.
- **One machine, one network.** Contacted hosts can differ by region, and the update checks depend on what each project has published at the time.
