# Desktop platform support

PandaCode is built for three targets. Each [GitHub Release](https://github.com/aicodeking/pandacode/releases)
carries one installer per target, built by `.github/workflows/release.yml`
(see [releasing](releasing.md)). Windows and Linux builds are still previews:
CI builds them and checks that the packaged app starts, but interactive desktop
validation is incomplete.

| Target | Platform requirements | Release asset |
| --- | --- | --- |
| `darwin-aarch64` | Apple silicon, macOS 12 or later | `PandaCode-macOS-arm64.dmg` containing `PandaCode.app` |
| `darwin-x86_64` | Intel Mac, macOS 12 or later | `PandaCode-macOS-x64.dmg` containing `PandaCode.app` |
| `windows-x86_64` | x64 Windows 10 version 1809 or later, or Windows 11 | `PandaCode-Windows-x64-setup.exe` (current-user NSIS installer) |
| `windows-aarch64` | Windows 11 on ARM (arm64) | `PandaCode-Windows-arm64-setup.exe` (current-user NSIS installer, native arm64) |
| `linux-x86_64` | x64 Ubuntu 22.04 or a compatible newer distribution, glibc 2.35+, graphical X11 or XWayland session | `PandaCode-Linux-x86_64.AppImage` built on Ubuntu 22.04 |
| `linux-aarch64` | arm64 Ubuntu 24.04 or a compatible newer distribution, glibc 2.39+, graphical X11 or XWayland session | `PandaCode-Linux-aarch64.AppImage` built on Ubuntu 24.04 |

Other architectures are not release targets, but you can try building them
from source with `npm run tauri build`.

## Unsigned builds

Release builds are unsigned unless the maintainers configure signing secrets
(see [releasing](releasing.md#optional-signing)).

- **macOS:** an unsigned build has an ad-hoc signature. The first time you open
  it, macOS may say it cannot verify the app. Open **System Settings → Privacy &
  Security** and choose **Open Anyway**.
- **Windows:** SmartScreen may show an unknown-publisher warning. Choose
  **More info → Run anyway**.
- **Linux:** mark the AppImage executable (see below).

Each asset has a `.sha256` file beside it so you can check the download.

## Native runtimes and dependencies

The interface uses the platform webview: WKWebView on macOS, WebView2 on Windows,
and WebKitGTK on Linux. PandaCode adds no Electron, resident Node server, or bundled
Chromium runtime. Windows and Linux integration dependencies are conditional
Cargo dependencies; they do not enter the Mac build. The AppImage includes core
GTK and WebKitGTK 4.1 libraries, so its package size should be assessed separately.
It also bundles `xdg-open` to open external links in the user's configured
desktop browser.

AppKit Liquid Glass and vibrancy are Mac-only window materials. Windows and
Linux retain their native window controls; the app's wallpaper opacity and blur
settings are shared UI features, not a promise of equivalent native materials.

Windows uses Microsoft's Evergreen WebView2 runtime. The installer downloads the
bootstrapper only if the runtime is missing, which requires internet access; it
does not bundle a fixed WebView2 runtime. The integrated terminal uses ConPTY,
which sets the Windows 10 version 1809 minimum.

The Linux AppImage's GTK launch hook selects the X11 backend. A graphical X11
session or XWayland within a Wayland desktop is required; native Wayland without
XWayland is unsupported. Core GTK/WebKit libraries are bundled and do not require
a separate manual install for the AppImage.

Mark the downloaded AppImage executable before opening it. Some distributions
also require FUSE 2 (`libfuse2` on Ubuntu 22.04). Where FUSE is unavailable,
AppImage supports extract-and-run:

```sh
chmod +x ./PandaCode-Linux-x86_64.AppImage   # or PandaCode-Linux-aarch64.AppImage
APPIMAGE_EXTRACT_AND_RUN=1 ./PandaCode-Linux-x86_64.AppImage
```

Linux GLM key storage requires an unlocked desktop Secret Service. If it is
unavailable, configure `ZAI_API_KEY` in the app's environment.

## Local VMs

The inspector's VM tab runs local VMs for agents on Apple silicon Macs (Tart, on
Apple's Virtualization framework; macOS and Linux guests) and on x86_64 or arm64
Linux (Lima on QEMU with KVM; Ubuntu, Debian and Fedora guests). Intel Macs and
Windows have no local VMs; cloud sandboxes work everywhere.

On Linux, **Set up VMs** downloads a pinned Lima release from GitHub for your CPU,
checks its SHA-256 before anything in it runs, and installs it under
`~/.local/share/pandacode/` without root. QEMU comes from your distribution; the
panel shows the install command when something is missing:

| Distribution | Command |
| --- | --- |
| Fedora and RHEL-like | `sudo dnf install qemu-kvm-core qemu-img edk2-ovmf` (arm64: `edk2-aarch64`) |
| Ubuntu and Debian | `sudo apt install qemu-system-x86 qemu-utils ovmf` (arm64: `qemu-system-arm qemu-utils qemu-efi-aarch64`) |
| Arch | `sudo pacman -S qemu-base edk2-ovmf` |

VMs need a read-writable `/dev/kvm` (`sudo usermod -aG kvm $USER`, then log out and
back in); PandaCode will not run them under slow emulation. Each VM takes 2 GB of
memory while it runs and is stopped after 10 idle minutes and when PandaCode quits;
one left running after a crash is reconnected the next time it is started.

The desktop app and `pandacode serve` on the same computer share one Lima home, so
each sees the other's VMs, but each guards only its own starts, stops and deletes.
Don't drive the same VM from both: one may stop or delete it while the other is
using or still creating it.

Creating a VM downloads its guest image (about 1 GB, cached in `~/.cache/lima` for
later VMs), so the first one can take a while.

A Lima VM sees none of your files unless you share a project: no home folder, SSH
keys, proxy settings or port forwards, and it runs as user `agent` with the time
zone set to UTC. A shared project is mounted read-only at `/mnt/project` over 9p
(Ubuntu and Fedora; Debian's image has no 9p, and PandaCode never uses Lima's sshfs
mounts, which would expose the whole host to root in the guest). A folder whose
path holds a comma, a control character or `{{` cannot be shared.

The guest's network is not isolated from yours. QEMU's user-mode network lets it
reach anything your computer can: your LAN, a VPN you are connected to, and
services listening on your computer's loopback address (as `192.168.5.2`). Lima's
host resolver answers the guest's DNS with your computer's own, including names in
`/etc/hosts`. The `agent` user also has your user ID on the host. Don't leave
unauthenticated services running on your computer or network while untrusted code
runs in a VM.

## Coding tools and shortcuts

Install Git and at least one supported provider CLI on the machine, and sign in
using that CLI's normal flow. PandaCode does not include provider plans,
provider binaries, or their optional Node/runtime dependencies. Each CLI's own
platform requirements still apply. Build contributors also need Node.js 22+, Rust,
and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for their
host, including the Windows C++ build tools or Linux development libraries
(see [CONTRIBUTING.md](../CONTRIBUTING.md)).

The interface uses Command shortcuts on Mac and Control shortcuts on Windows
and Linux. The quick launcher's default is Command/Control + Shift + Space and
can be changed in Settings.

Linux global shortcuts use an X11 backend. In a Wayland session, XWayland may
allow registration without making the shortcut work outside XWayland apps;
behavior depends on the desktop. If only the global-shortcut backend cannot
initialize, PandaCode still opens and explains the limitation in launcher settings;
this does not remove the graphical X11/XWayland requirement. Use
**Settings → Quick launcher → Open** to open the panel manually. This is not a
Wayland portal implementation.

## Validation

CI (`.github/workflows/ci.yml`) typechecks, runs the unit tests, builds the
website and runs `cargo check`, `cargo test --lib` and strict Clippy on Linux.
The release workflow builds each installer on its native runner and, on Windows
and Linux, installs or launches the packaged app and checks that it stays alive
for a fixed interval (`scripts/release/ci-startup-smoke.mjs`). Staying alive
proves only that the process did not exit: it does not prove the webview
rendered, the window accepted input, or a provider turn completed. Browser
fixtures on a Mac do not establish native Windows/Linux compatibility either.

### Recording validation results

Keep build results separate from interactive checks. Mark unrun checks as
**Not run**:

```text
Commit / artifact SHA-256 / target:
CI run / native tests / Clippy / package build:
Startup probe: command, environment, duration, exit/log result:
Interactive OS / display session / webview version:
Manual checks: passed items, failures, and items not run:
```

### Manual native smoke checks

Use the packaged artifact on a real desktop session or an interactive VM. Record
the exact OS and artifact for each result; do not infer Windows 10 behavior from
a Windows Server runner, or Linux desktop behavior from Xvfb.

| Check | Evidence to record |
| --- | --- |
| Install and launch | Window visibly renders and accepts input; close/reopen preserves settings. Windows installs WebView2 when absent. Linux launches with FUSE and with extract-and-run; record X11 or XWayland. |
| Workspace and terminal | Open a Git project, inspect files/diffs, create a worktree, run and resize the terminal, then close it. Include a path with spaces. |
| Providers and persistence | Discover each provider being advertised on that OS. With a signed-in CLI, stream a small turn, handle approval, stop, restart the app, and resume the same task. Note any provider not tested. |
| Concurrent work | Run separate tasks and a team, inspect worker output, cancel them, and confirm their child processes exit. |
| Embedded browser | Open a local port, navigate back/forward/reload, select an element, and attach a readable screenshot. |
| Launcher and input | Open manually and with the configured shortcut, change the shortcut, inspect an active task, dismiss/refocus, and use platform keyboard shortcuts. Record Wayland limits instead of claiming universal global access. |
| Credentials | Check GLM store-unavailable messaging and environment fallback if GLM is included in the test. |

Record unrun native checks and known limitations alongside each preview's
results, even if CI packaging succeeds. Complete these checks before claiming
stable support. Reports from real machines are welcome as
[GitHub issues](https://github.com/aicodeking/pandacode/issues).
