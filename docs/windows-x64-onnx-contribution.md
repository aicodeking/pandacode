# Contributing and updating the Windows x64 ONNX profiler

This guide explains how to test the patch from source, prepare a first pull request
(PR), and carry the patch forward to a later release. The goal is to restore the
Panda Router profiler on supported CPUs while preserving startup and keyword
routing on older machines.

## What happened and what the patch changes

- [Issue #205](https://github.com/aicodeking/pandacode/issues/205) reports that
  [v0.3.55](https://github.com/aicodeking/pandacode/releases/tag/v0.3.55) started on the
  reporter's Ivy Bridge Xeon, but
  [v0.3.59](https://github.com/aicodeking/pandacode/releases/tag/v0.3.59) and
  [v0.3.70](https://github.com/aicodeking/pandacode/releases/tag/v0.3.70) failed with
  `0xc000001d` (`STATUS_ILLEGAL_INSTRUCTION`). Disassembly of v0.3.70 identifies
  `shlx` (BMI2) in ONNX Runtime, which was built with `/arch:AVX2` and statically
  linked. The C++ initializer in `.CRT$XCU` runs before `main()`, so a CPU check
  inside the profiler could not prevent the crash.
- [PR #207](https://github.com/aicodeking/pandacode/pull/207) (commit
  [`9fe768a3b289efe14df6f37f4b3dd474ca4701c4`](https://github.com/aicodeking/pandacode/commit/9fe768a3b289efe14df6f37f4b3dd474ca4701c4)
  and integration commit
  [`5301578bedd6cc960b33806edaae9a83ba23b33c`](https://github.com/aicodeking/pandacode/commit/5301578bedd6cc960b33806edaae9a83ba23b33c))
  removed static linking on Windows x64 and kept the keyword heuristic (`onnx_stub.rs`).
  The parent of that change, [`bad7f0b5`](https://github.com/aicodeking/pandacode/commit/bad7f0b5f4e2b0aa28126b5c4fa95c641a3ab276) (`v0.3.71`),
  still linked ONNX on Windows x64. The
  [v0.3.89 release notes](https://github.com/aicodeking/pandacode/releases/tag/v0.3.89)
  document the mitigation (commit `455711e5fb8a33df07bd8c50ff5f8679df41b4ec`).
  [v0.3.139](https://github.com/aicodeking/pandacode/releases/tag/v0.3.139)
  ([commit `69fe3bc1446424c7f6f5b1a0e6cd050df6db3e8f`](https://github.com/aicodeking/pandacode/commit/69fe3bc1446424c7f6f5b1a0e6cd050df6db3e8f))
  still uses the heuristic on Windows x64, as does the `main` revision this
  patch is based on ([`6915eddc`](https://github.com/aicodeking/pandacode/commit/6915eddcb759baab694e51575beaa5815853f00d), source version `0.3.140`).
  Editing the repository does not change the installed app. The validation
  described here did not produce a new full PandaCode build or a local installer.
- The patch does **not** link ONNX Runtime back into the Windows x64 executable.
  [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml) and [`src-tauri/build.rs`](../src-tauri/build.rs)
  enable `panda_onnx` with `ort` in `load-dynamic` mode for that target. The main
  process does not load the DLL. It checks for AVX, AVX2, FMA, F16C, BMI1, BMI2, SSE4.2,
  and the presence of the DLL before downloading the model or starting the child process.
  The same [`src-tauri/src/main.rs`](../src-tauri/src/main.rs) handles
  `__panda-router-worker` without opening the UI. The child rechecks the CPU, loads
  the DLL, and runs a smoke inference before accepting tasks. The protocol and
  wait times are bounded. If the runtime fails to load or the child crashes or
  times out, routing falls back to the keyword heuristic for the rest of the session.
  A model checksum mismatch, however, can be retried with **Retry**.
  Windows ARM64 is unchanged.

To trace the flow, see
[`windows_onnx.rs`](../src-tauri/src/panda_router/windows_onnx.rs) (child process and transport),
[`onnx.rs`](../src-tauri/src/panda_router/onnx.rs) (loading and inference),
[`model_routing.rs`](../src-tauri/src/model_routing.rs) (download, selection, and fallback),
and [`src/model-routing.ts`](../src/model-routing.ts) (UI). The official `win-x64`
CPU DLL comes from [Microsoft.ML.OnnxRuntime 1.31.0 on NuGet](https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime/1.31.0).
The [NuGet manifest](https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.0/microsoft.ml.onnxruntime.nuspec)
identifies commit `402979ac1bef89dcd55add41eaa7277c407599eb`.
[`scripts/release/windows-router-runtime.mjs`](../scripts/release/windows-router-runtime.mjs)
verifies the DLLs' file sizes, SHA-256 checksums, and PE architecture, then stages
`onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `LICENSE`, and
`ThirdPartyNotices.txt` in `panda-router-runtime/` next to the executable.
The app does not download these DLLs. The model and tokenizer are separate files
pinned by version and SHA-256. See [Model routing](model-routing.md#privacy) and the
[third-party notices](../THIRD_PARTY_NOTICES.md).

## Set up Windows and launch the development app

As described in [CONTRIBUTING.md](../CONTRIBUTING.md#prerequisites), install
**Node.js 22 x64** with npm (the latest 22.x patch, at least 22.13),
**Git for Windows** (which includes Git Bash), and **stable Rust via rustup**
for `x86_64-pc-windows-msvc` (not GNU). Install **Visual Studio Build Tools** with
the **Desktop development with C++** workload (MSVC and the Windows SDK), and
make sure **Microsoft Edge WebView2 Runtime** is installed. Testing ONNX also
requires the [Microsoft Visual C++ v14 Redistributable x64](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).
PandaCode does not bundle it; without it, the DLL may fail to load and the router
may fall back to the heuristic. Use native Windows x64, not WSL. If you do not
have the source yet, clone the official repository with
`git clone https://github.com/aicodeking/pandacode.git`. In Git Bash, run the
following from the root of the checkout **that contains the patch**:

```bash
node -v
node -p 'process.platform + "/" + process.arch'
rustc -vV
npm ci
```

Expect `v22.x`, `win32/x64`, and `host: x86_64-pc-windows-msvc`. Quit the installed
app completely before testing. `pandacode-run.sh` serves the browser preview,
which cannot verify native ONNX. For a native test, stage the verified DLLs
beside the Windows x64 debug executable and launch Tauri with a temporary
identifier. This does not isolate all data:
[`crash_guard.rs`](../src-tauri/src/crash_guard.rs) still uses the official path
on Windows. For complete isolation, use a separate Windows account or a
disposable VM. Run the following in a fresh Git Bash session:

```bash
set -e
export CARGO_TARGET_DIR="$(node -p 'require("node:path").resolve("src-tauri/target")')"
node scripts/release/windows-router-runtime.mjs "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/debug"
config="$(mktemp --suffix=.json)"
trap 'rm -f -- "$config"' EXIT
printf '%s\n' '{"identifier":"ai.pandacode.dev"}' > "$config"
npm run tauri -- dev --target x86_64-pc-windows-msvc --config "$(cygpath -w "$config")"
```

In **Settings → Agents → Model routing**, turn on **Pick worker models with Panda Router**,
enter a test task, and click **Route**. The summary shows `ONNX profiler` or
`keyword heuristic` to indicate which method classified that task. **Ready** only
means the verified model files are cached; it does not show that the runtime
loaded or that inference ran in this session. When routing is on and the target is
supported and those files are already cached, the child starts in the background at
desktop launch; launch never downloads files. Ordinary dispatch uses the heuristic
while the child starts, and the runtime still unloads after idleness. The explicit
**Route** test can wait for startup. `npm run dev` only opens the Vite preview with
mocked native commands and cannot verify this behavior on Windows.

The workspace header indicator is optional. On Windows x64 it shows the current
runtime lifecycle separately from the previous batch: `Router: Starting…` while
the child starts, `Router: ONNX Ready` once it accepts tasks, and
`Router: ONNX Unavailable` when it cannot run. When no lifecycle is current
(routing off, runtime idle or unloaded, or another target), the label falls back to
the latest actual routing batch completed by the Tauri backend: `Router: —` before
any batch completes, `Router: ONNX` or `Router: Keywords` when the batch used only
one method, and `Router: Mixed` when it used both. That fallback is historical, and
other targets keep only the historical label. The indicator does not download files
or run automatic probes; Settings' **Ready** is about cached model files. To see
which method classified a particular task, use **Settings → Agents → Model routing
→ Route**.

## Reproduce the checks

Earlier local validation ran on **Windows x64 with an AMD Ryzen 3 3200G**.
**45 tests passed in a Windows harness**, and two consecutive routing requests
ran inference with the real **ONNX Runtime 1.31.0** DLL in the same child process.
Terminating the child or suspending it until the timeout (~5 s) yielded the same
heuristic result without restarting the child in that session. The checks also
confirmed that a missing DLL was detected up front. `npm run test:release`:
**64 passed and 1 skipped** (65 total; the skipped test is macOS-only). These results
do not verify the full Tauri app, the CI timing test, the NSIS installer, or
startup without AVX2 (on physical hardware or in a VM with CPU features masked).

To run the repository's **native validation** rather than the local harness,
follow the `router` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
After `npm ci` completes, run the following in a fresh Git Bash session:

```bash
set -euo pipefail
npm run build
npm run test:release
mkdir -p .panda-router
base=https://raw.githubusercontent.com/aicodeking/PandaOrchestrator/83e408c794ef1d09b6d13b6ad8734e984f552402/artifacts/panda-router-v4
curl -fsSL --retry 3 "$base/model.int8.onnx" -o .panda-router/model.int8.onnx
curl -fsSL --retry 3 "$base/tokenizer.json" -o .panda-router/tokenizer.json
sha256sum -c <<'EOF'
b52d463905808efd892c91917e3010985359e259fe7a514ae083967c98fa2216  .panda-router/model.int8.onnx
ca870c678352403d107496dc78899fa666ed0f56fef63e88ae398fafe5d78c45  .panda-router/tokenizer.json
EOF
export PANDA_ROUTER_ASSETS="$(node -p 'require("node:path").resolve(".panda-router")')"
export CARGO_TARGET_DIR="$(node -p 'require("node:path").resolve("src-tauri/target")')"
export PANDA_ROUTER_TEST_EXE="$(node -p 'require("node:path").resolve("src-tauri/target/debug/pandacode.exe")')"
cargo build --locked --manifest-path src-tauri/Cargo.toml --bin pandacode
node scripts/release/windows-router-runtime.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- panda_router model_routing
```

Use the native MSVC x64 toolchain without overriding `CARGO_BUILD_TARGET`, so
the executable and DLLs land in the same location as in CI. Verify that
`windows_onnx_profiles_real_assets_in_child` and
`windows_onnx_dispatch_does_not_wait_or_duplicate_startup` pass. Do not count a
pass as evidence of real inference unless both `PANDA_ROUTER_ASSETS` and
`PANDA_ROUTER_TEST_EXE` are set: the test can finish without running the profiler.

To test the **NSIS package** on Windows x64, run
`npm run release:build -- windows-x86_64` after `npm ci`.
[`scripts/release/build.mjs`](../scripts/release/build.mjs) stages the resources and
produces `release/<version>/PandaCode-Windows-x64-setup.exe` and its `.sha256`
file without publishing anything. A generic `tauri build` does not replace
testing that package. Install it in a disposable account or VM, not over your
regular installation. See [releasing.md](releasing.md#local-builds) for details.

### Review matrix

Record the source commit SHA, Windows version, CPU (or hypervisor and the CPU
features visible to the guest), command, actual result, and installer hash if
you used the installer.

| Scenario | What to verify |
| --- | --- |
| Windows x64 with all required CPU features and the redistributable | In the native app, **Route** shows `ONNX profiler` and runs real inference with the pinned DLL. On a cold start, also check that dispatch neither waits for the child to start nor starts a duplicate child. |
| Supported Windows x64, induced failure | In a disposable copy, run a successful inference, terminate only the `__panda-router-worker` child, then click **Route** again. The window stays responsive, the router returns `keyword heuristic`, and ONNX does not restart in that session. Also check startup with the DLL missing, without touching your regular installation. |
| Windows x64 on a physical pre-AVX2 CPU (for example, Ivy Bridge) | Install and launch the package with its DLLs present. The window should open without `0xc000001d`. With a clean profile, **Route** uses `keyword heuristic` without downloading the model or starting the child. |
| Windows x64 VM with AVX2/BMI2 masked | Count this only if you confirm from inside the guest that those instructions are not exposed (for example, with Coreinfo) and repeat the preceding scenario. Record it as a VM test, not as evidence on older physical hardware. |
| Packaging and other architectures | Check the `.sha256` and the four files in `panda-router-runtime/` next to the executable in the x64 NSIS package. Verify that `dumpbin /IMPORTS` does not list `onnxruntime.dll` for `pandacode.exe`. Confirm in CI that ARM64 is unchanged and macOS retains its ONNX path. |

## Save the patch and port it to another version

1. **Preserve the original.** Before switching branches, review `git status --short`,
   `git diff`, and `git diff --cached`. Make a backup outside the repository,
   including any new files Git marks as `??`; `git diff` alone does not capture them.
   If the working tree is shared or contains unrelated edits, leave it intact.
   Run `git worktree add -b patch/windows-x64-onnx ../pandacode-onnx-patch HEAD`
   from that checkout to create a clean worktree at the same commit. Copy only the
   patch's new files and changes into that directory. If a file mixes unrelated
   edits with the patch, transfer only the patch hunks, not the whole file.
2. **Make a commit for the patch only.** On the dedicated branch, use `git add --`
   followed by each reviewed path (including new files), or use `git add -p` to
   select hunks in tracked files. If you keep the optional indicator, include
   `src/router-profiler-indicator.ts` and review the mounting, styling, and preview
   changes (`src/main.ts`, `src/styles.css`, `src/preview.ts`), the event in
   `src/bridge.ts`, the tests in `tests/model-routing.spec.ts`, and the backend
   hunks that supply its data. Separate the indicator by reviewing changes file
   by file and hunk by hunk: do not include entire Rust files in the indicator
   change if they also contain the Windows fix. Do not use `git add .` or
   `git commit -a`. Review `git diff --cached --name-status` and `git diff --cached`,
   then commit (for example, `git commit -m "fix: isolate ONNX on Windows x64"`)
   and check `git show --stat HEAD`. Record the SHA (`git rev-parse HEAD`) and
   create a backup branch: `git branch backup/windows-x64-onnx HEAD`.
3. **Choose and pin the base.** Keep `origin` pointed at the official repository
   (`git remote -v`). If you plan to open a PR, create your fork on GitHub and add
   it as a second remote with `git remote add fork https://github.com/YOUR-USERNAME/pandacode.git`
   without replacing `origin`. Run `git fetch origin main --tags`. To reproduce a
   release, use its upstream tag, such as `v0.3.139`, and verify the SHA with
   `git rev-parse 'v0.3.139^{commit}'`. For a PR, use the freshly fetched
   `origin/main` and record the output of `git rev-parse origin/main`. The release
   and `main` are different bases.
4. **Apply the commit to a new branch.** In a checkout where
   `git status --porcelain --untracked-files=all` returns no output, run
   `git switch -c fix/windows-x64-onnx origin/main` for the PR, or
   `git switch -c local/onnx-v0.3.139 v0.3.139` for the pinned release. Then run
   `git cherry-pick -x backup/windows-x64-onnx`. If there are conflicts, review
   `git status` and `git diff`, resolve them file by file, stage the resolved paths
   with `git add --`, and continue with `git cherry-pick --continue`. If the patch
   is already present, confirm that the changes are equivalent before running
   `git cherry-pick --skip`. If you cannot resolve the conflicts safely,
   `git cherry-pick --abort` leaves the backup branch intact and restores the
   previous state. Do not use `reset --hard` or force-push.
5. **Rerun the native checks on the new base.** Review the branch diff against its
   base, paying particular attention to Cargo target conditions, the DLLs, CI, and
   the fallback. Port the **source code** only: do not patch an `.exe` or copy DLLs
   into the installed app's directory.

## Open a draft pull request on GitHub

For a substantial change, [the repository asks you to open an issue first](../CONTRIBUTING.md#pull-requests).
Open the [Feature request form](https://github.com/aicodeking/pandacode/issues/new?template=feature_request.yml)
and link to #205 and #207. You can use the title below and this short proposal:

> I have a patch that restores ONNX on supported Windows x64 CPUs without
> reintroducing the startup failure in #205 and #207. It loads ONNX only in a child
> process and falls back to keywords. Would you be open to a draft PR, and could
> someone help validate it on a Windows x64 machine without AVX2 or BMI2?

When you are ready to share the patch, [create a fork](https://github.com/aicodeking/pandacode/fork),
add the `fork` remote as described above, and push the branch with
`git push -u fork fix/windows-x64-onnx`. In the [upstream comparison page](https://github.com/aicodeking/pandacode/compare),
choose **compare across forks**, select `aicodeking/pandacode:main` as the base and
`fix/windows-x64-onnx` from your fork as the compare branch. Create a **Draft PR**.
Do not target your fork or a release tag. Updating the official app is a separate
release process; building locally does not trigger it.

## PR template

**Title:** Restore the ONNX profiler on supported Windows x64 CPUs

**What and why:** Restore ONNX profiling without undoing the startup fix in #207
(see #205). Windows x64 checks CPU features, then loads the pinned CPU ONNX Runtime
1.31.0 DLL only in a child process and runs a smoke inference. Unsupported hosts
and runtime failures use the keyword heuristic; ordinary dispatch does not wait
for child startup. Windows ARM64 is unchanged.

**Optional workspace header indicator:** On Windows x64 the indicator separates the
current runtime lifecycle (`Router: Starting…`, `Router: ONNX Ready`, `Router: ONNX
Unavailable`) from the last completed batch (`Router: —` before any batch completes,
then `Router: ONNX`, `Router: Keywords`, or `Router: Mixed`), which it shows whenever
no lifecycle is current (routing off, runtime idle or unloaded, or another target). It
downloads nothing and runs no probes; Settings' Profiler **Ready** means the model
files are cached. Settings → Agents → Model routing → Route remains authoritative for
a specific task. The indicator is not required for the Windows fix and can be removed
or split out into a separate commit or PR.

**Validation:** On a Windows x64 Ryzen 3 3200G, 45 isolated harness tests passed,
with real inference using the 1.31.0 DLL and heuristic fallback when the child
was terminated or timed out. Release suite: 64 passed, 1 macOS-only test skipped.
The optional indicator passed browser preview tests with simulated native commands,
including a stale initial reply and an automatic team batch. The full Tauri app, CI
timing test, NSIS installer and pre-AVX2 Windows (physical or masked VM) are not
verified.
