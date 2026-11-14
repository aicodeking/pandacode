# Idle launch telemetry (Linux reproduction), 2026-10-30

5 cold launches per app, alternating order, each with a new empty `$HOME`, measured 60 s after launch with nothing clicked and no agents running. Median (min–max). Ratio = PandaCode / T3 Code.

## Resources and disk

| Metric | PandaCode | T3 Code | Ratio |
| --- | ---: | ---: | ---: |
| Proportional set size (PSS) at end, process tree (MB) | 732 (725–738) | 568 (486–585) | 1.29 |
| Resident memory (RSS) at end, process tree (MB) | 909 (905–915) | 1015 (686–1017) | 0.90 |
| Peak RSS during the window (MB) | 1057 (999–1124) | 1200 (1164–1278) | 0.88 |
| CPU time, launch to 60 s (s) | 6.13 (5.10–8.07) | 6.13 (5.53–6.96) | 1.00 |
|   of which app processes (s) | 5.70 (4.83–7.12) | 5.70 (5.20–6.28) | 1.00 |
|   of which tools it started (s) | 0.33 (0.24–0.95) | 0.43 (0.33–0.68) | 0.77 |
| Tool processes started (harness CLIs, shells, npm, git…) | 6 (6–9) | 7 (4–12) | 0.86 |
| CPU time, last 30 s (idle) (s) | 0.17 (0.16–0.18) | 0.88 (0.83–0.95) | 0.19 |
| Processes at end | 3 (3–3) | 9 (9–9) | 0.33 |
| Threads at end | 67 (67–67) | 94 (92–99) | 0.71 |
| Time to first on-screen window (ms) | 188 (180–1024) | 2296 (2148–3371) | 0.08 |
| Data written to the fresh $HOME (MB) | 2.22 (2.16–2.22) | 23.17 (23.16–23.18) | 0.10 |
|   of which the app's own data dirs (MB) | 0.50 (0.50–0.50) | 5.11 (5.10–5.12) | 0.10 |
| Files written to the fresh $HOME | 139 (139–139) | 631 (631–631) | 0.22 |
| Remote flows (non-loopback, incl. DNS) | 10 (10–10) | 30 (28–31) | 0.33 |
| Bytes received over those flows (KB) | 150.6 (150.2–151.1) | 825.8 (822.5–829.6) | 0.18 |
| Bytes sent over those flows (KB) | 9.1 (8.8–9.5) | 226.6 (224.8–227.6) | 0.04 |
| App bundle (AppImage file) size (MB) | 92.4 | 181.4 | 0.51 |
| App bundle extracted size (MB) | 276.4 | 500.6 | 0.55 |

## Hosts contacted by PandaCode at idle launch

Host = TLS/QUIC SNI sent by the app, else the DNS name the app itself resolved to that address. Bytes are whole IP packets (headers and TLS included).

| Host | Process (from ss) | Runs seen | First seen (s, median) | In / out per run seen (KB, median) | Addresses |
| --- | --- | ---: | ---: | ---: | --- |
| releases.openai.com | pandacode | 5/5 | 9.1 | 113.1 / 2.0 | 104.18.43.139:443/tcp4, 172.64.144.117:443/tcp4 |
| downloads.claude.ai | ? | 5/5 | 9.2 | 6.2 / 1.2 | 35.190.46.17:443/tcp4 |
| storage.googleapis.com | ? | 5/5 | 9.2 | 4.4 / 1.1 | 142.250.73.155:443/tcp4, 142.251.33.219:443/tcp4, 142.250.69.187:443/tcp4 |
| github.com | pandacode | 5/5 | 31.0 | 14.7 / 1.8 | 20.29.134.23:443/tcp4, 140.82.116.4:443/tcp4 |
| release-assets.githubusercontent.com | pandacode | 5/5 | 31.4 | 10.6 / 2.2 | 185.199.111.133:443/tcp4, 185.199.109.133:443/tcp4 |

DNS names the app looked up: `releases.openai.com` (5/5, 9.1 s), `storage.googleapis.com` (5/5, 9.1 s), `downloads.claude.ai` (5/5, 9.2 s), `github.com` (5/5, 31.0 s), `release-assets.githubusercontent.com` (5/5, 31.4 s).

Processes attributed to the app:

| Process | Command | Runs seen | CPU per instance (s, median) |
| --- | --- | ---: | ---: |
| WebKitWebProces | `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess 4 25 28` | 2/5 | 5.48 |
| WebKitWebProces | `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess 4 24 27` | 1/5 | 5.34 |
| WebKitWebProces | `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess 4 25 27` | 1/5 | 5.12 |
| WebKitWebProces | `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess 4 23 27` | 1/5 | 4.37 |
| pandacode | `pandacode` | 5/5 | 0.50 |
| node | `node /data/home/.cache/.bun/bin/pi --version` | 5/5 | 0.09 |
| opencode | `/data/home/.cache/.bun/bin/opencode --version` | 3/5 | 0.08 |
| codex | `/data/home/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --version` | 1/5 | 0.08 |
| opencode | n/a | 1/5 | 0.07 |
| npm prefix | n/a | 2/5 | 0.06 |
| grok | `/data/home/.npm-global/bin/grok --version` | 2/5 | 0.06 |
| npm | `npm` | 3/5 | 0.03 |
| WebKitNetworkPr | `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess 1 20 23` | 2/5 | 0.03 |
| WebKitNetworkPr | `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess 1 23 25` | 1/5 | 0.02 |
| WebKitNetworkPr | `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess 1 22 25` | 2/5 | 0.02 |
| claude | `/data/home/.npm-global/bin/claude --version` | 3/5 | 0.01 |
| node | `/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js prefix --global` | 2/5 | 0.01 |
| grok | `/data/home/.npm-global/bin/grok --no-auto-update --version` | 1/5 | 0.01 |
| claude | n/a | 1/5 | 0.00 |

Non-loopback listening sockets: none.

## Hosts contacted by T3 Code at idle launch

Host = TLS/QUIC SNI sent by the app, else the DNS name the app itself resolved to that address. Bytes are whole IP packets (headers and TLS included).

| Host | Process (from ss) | Runs seen | First seen (s, median) | In / out per run seen (KB, median) | Addresses |
| --- | --- | ---: | ---: | ---: | --- |
| redirector.gvt1.com | t3code | 5/5 | 0.6 | 7.9 / 3.4 | 142.251.34.206:443/tcp4, 108.177.98.139:443/tcp4, 142.250.73.78:443/tcp4, 142.250.69.174:443/tcp4 |
| rr5---sn-nx57ynsy.gvt1.com | t3code | 5/5 | 0.7 | 480.3 / 12.7 | 173.194.152.106:443/udp4, 173.194.152.106:443/tcp4 |
| raw.githubusercontent.com | t3code | 5/5 | 1.8 | 9.6 / 2.5 | 185.199.108.133:443/tcp4, 185.199.111.133:443/tcp4, 185.199.110.133:443/tcp4 |
| registry.npmjs.org | t3code | 5/5 | 2.0 | 11.2 / 5.2 | 104.16.0.34:443/tcp4, 104.16.5.34:443/tcp4, 104.16.8.34:443/tcp4, 104.16.11.34:443/tcp4 +1 |
| api.anthropic.com | claude | 5/5 | 2.1 | 10.9 / 168.4 | 160.79.104.10:443/tcp4 |
| chatgpt.com | ? | 2/5 | 2.3 | 4.2 / 2.1 | 104.18.32.47:443/tcp4 |
| github.com | ? | 1/5 | 2.7 | 3.3 / 0.8 | 140.82.116.3:443/tcp4 |
| clerk.t3.codes | t3code | 5/5 | 3.0 | 283.8 / 9.4 | 104.18.34.146:443/tcp4, 172.64.153.110:443/tcp4 |
| us-east-1.aws.edge.axiom.co | t3code | 5/5 | 7.3 | 11.8 / 18.2 | 32.196.68.31:443/tcp4, 44.216.55.45:443/tcp4, 100.50.175.129:443/tcp4 |
| ingest.t3.codes | t3code | 5/5 | 11.5 | 5.2 / 3.8 | 104.21.3.218:443/tcp4 |

DNS names the app looked up: `redirector.gvt1.com` (5/5, 0.6 s), `rr5---sn-nx57ynsy.gvt1.com` (5/5, 0.7 s), `raw.githubusercontent.com` (5/5, 1.7 s), `api.anthropic.com` (5/5, 1.9 s), `registry.npmjs.org` (5/5, 1.9 s), `github.com` (4/5, 2.3 s), `chatgpt.com` (4/5, 2.3 s), `clerk.t3.codes` (5/5, 2.7 s), `us-east-1.aws.edge.axiom.co` (5/5, 6.4 s), `ingest.t3.codes` (5/5, 11.5 s).

Processes attributed to the app:

| Process | Command | Runs seen | CPU per instance (s, median) |
| --- | --- | ---: | ---: |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --require /data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/resources/app.asar/apps/desktop/dist-` | 5/5 | 2.42 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=renderer --enable-crash-reporter=b1cdff3b-5d59-491c-8d55-ac1f89edc596,no_channel --user-data-dir=$HOME/.config/t3` | 1/5 | 1.46 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code` | 5/5 | 1.45 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=renderer --enable-crash-reporter=bbe7350f-ec10-474e-a756-cef4621239ce,no_channel --user-data-dir=$HOME/.config/t3` | 1/5 | 1.44 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=renderer --enable-crash-reporter=3b3203e8-5bc9-479a-9bc0-b251af27d727,no_channel --user-data-dir=$HOME/.config/t3` | 1/5 | 1.44 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=renderer --enable-crash-reporter=2a9b561b-2459-4153-8a06-159815179f05,no_channel --user-data-dir=$HOME/.config/t3` | 1/5 | 1.35 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=renderer --enable-crash-reporter=56bba9f3-3443-4c31-ba20-92dc5250531e,no_channel --user-data-dir=$HOME/.config/t3` | 1/5 | 1.30 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=gpu-process --ozone-platform=x11 --enable-crash-reporter=b1cdff3b-5d59-491c-8d55-ac1f89edc596,no_channel --user-d` | 1/5 | 0.52 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=gpu-process --ozone-platform=x11 --enable-crash-reporter=2a9b561b-2459-4153-8a06-159815179f05,no_channel --user-d` | 1/5 | 0.44 |
| claude | `claude --output-format stream-json --verbose --input-format stream-json --setting-sources=user,project,local --strict-mcp-config --permission-mode default --no-session-persistence --settings {"disable` | 5/5 | 0.35 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=gpu-process --ozone-platform=x11 --enable-crash-reporter=bbe7350f-ec10-474e-a756-cef4621239ce,no_channel --user-d` | 1/5 | 0.31 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=gpu-process --ozone-platform=x11 --enable-crash-reporter=3b3203e8-5bc9-479a-9bc0-b251af27d727,no_channel --user-d` | 1/5 | 0.29 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=gpu-process --ozone-platform=x11 --enable-crash-reporter=56bba9f3-3443-4c31-ba20-92dc5250531e,no_channel --user-d` | 1/5 | 0.25 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US --service-sandbox-type=none --enable-crash-r` | 5/5 | 0.08 |
| codex | n/a | 1/5 | 0.06 |
| codex | `/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex app-server` | 4/5 | 0.04 |
| node | `node /usr/local/bin/codex --version` | 2/5 | 0.03 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=zygote --no-zygote-sandbox` | 5/5 | 0.01 |
| node | `node /usr/local/bin/codex app-server` | 5/5 | 0.01 |
| node | `node /usr/local/bin/codex app-server --help` | 1/5 | 0.01 |
| claude | `claude --version` | 1/5 | 0.01 |
| t3code | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/t3code --type=zygote` | 5/5 | 0.01 |
| git-remote-http | `/usr/lib/git-core/git-remote-https https://github.com/openai/plugins.git https://github.com/openai/plugins.git` | 2/5 | 0.01 |
| t3-resource-mon | `/data/home/tc/x/T3-Code-0.1.3-nightly.20261026.3717-x86_64/squashfs-root/resources/resource-monitor/t3-resource-monitor` | 5/5 | 0.00 |
| git | `/usr/bin/git -c safe.bareRepository=explicit ls-remote https://github.com/openai/plugins.git HEAD` | 2/5 | 0.00 |
| git | `/usr/lib/git-core/git remote-https https://github.com/openai/plugins.git https://github.com/openai/plugins.git` | 2/5 | 0.00 |
| tokio-rt-worker | n/a | 1/5 | 0.00 |
| git | n/a | 2/5 | 0.00 |
| claude.exe | n/a | 2/5 | 0.00 |
| hostnamectl | `hostnamectl --pretty` | 1/5 | 0.00 |
| codex | `/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --version` | 2/5 | 0.00 |
| xdg-mime | `/bin/sh /usr/bin/xdg-mime query default inode/directory` | 1/5 | 0.00 |
| grep | n/a | 1/5 | 0.00 |
| head | n/a | 1/5 | 0.00 |
| cut | n/a | 1/5 | 0.00 |

Non-loopback listening sockets: none.

## Where the launch writes

PandaCode (last run, largest paths under the fresh $HOME): `.cache/mesa_shader_cache_db` 1280 KB, `.local/share/ai.pandacode.desktop/kingcode.sqlite3-wal` 455 KB, `.cache/fontconfig` 257 KB, `.cache/mesa_shader_cache_db/part0/mesa_cache.db` 219 KB, `.local/share/ai.pandacode.desktop/kingcode.sqlite3-shm` 32 KB, `.local/share/ai.pandacode.desktop/hsts-storage.sqlite` 12 KB, `.local/share/ai.pandacode.desktop/localstorage` 12 KB, `.local/share/ai.pandacode.desktop/kingcode.sqlite3` 4 KB, `.cache/mesa_shader_cache_db/part0/mesa_cache.idx` 2 KB, `.npm/_logs` 1 KB, `.local/share/opencode/log` 0 KB, `.cache/app.pandacode` 0 KB.

T3 Code (last run, largest paths under the fresh $HOME): `.cache/t3code/compile-cache/v24.22.0-x64-31bda926-1000` 12446 KB, `.codex` 2518 KB, `.local/share/icons/com.t3tools.T3Code.desktop.png` 1384 KB, `.cache/mesa_shader_cache_db` 1280 KB, `.t3/userdata/logs/server.trace.ndjson` 870 KB, `.t3/userdata` 869 KB, `.config/t3code-v2/Cache/Cache_Data` 726 KB, `.config/t3code-v2/Dictionaries/en-US-10-1.bdic` 441 KB, `.cache/fontconfig` 411 KB, `.config/t3code-v2/DawnGraphiteCache/data_1` 264 KB, `.config/t3code-v2/DawnWebGPUCache/data_1` 264 KB, `.config/t3code-v2/GPUCache/data_1` 264 KB.

Machine: 4 vCPU 8 GB, Debian GNU/Linux 13 (trixie), kernel 6.18.54-instabox, AMD EPYC. PandaCode 0.3.79, T3 Code 0.1.3-nightly.20261026.3717. Raw numbers: 2026-10-30.json; packet captures: pcap/.
