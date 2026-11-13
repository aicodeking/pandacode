# Rich views and host-created windows (experimental, native execution disabled)

A view can declare `rich: { html, css, script }`, referencing exactly three UTF-8 files
under `assets/`. Each file is at most 65,536 bytes and retains the package archive's
traversal, symlink, duplicate, checksum and expansion validation. CSS/JS cannot contain
their HTML closing-element delimiters. Undeclared assets remain rejected. Declare both
`ui.contribute` and `ui.richViews` in `permissions`. No asset source appears in the public
package snapshot. See `tests/fixtures/extensions/rich-view/` for an installable example.

The normal host-rendered view, its `text`, controls and toolbar remain available. Its
**Open isolated extension window** button asks the native host for the installed view ID
and exact version. The package supplies no URL, native window options, project identity
or Tauri capabilities. At most eight rich windows may exist in the host service.

## Qualification gate

**No native target is currently qualified or enabled.** Windows/WebView2 installed
interactive acceptance and Linux/WSL checks are deferred until explicitly requested;
macOS/ARM evidence is unavailable. Browser preview is not native isolation proof. The
native service therefore returns a visible explanation without opening a webview. Trusting
an executable extension, setting an environment variable or enabling the package cannot
override this source-controlled gate. This is implementation availability, not a stable
or universally qualified rich-HTML API.

The separately opt-in `?rich-view&rich-view-characterization` browser scenario uses only
the canonical synthetic fixture and a user-clicked popup. It exercises the shared shell,
not Tauri, and cannot enable native HTML execution.

## Presentation contract

The composed native window uses a dedicated opaque data-document shell and an
opaque-origin frame with only `sandbox="allow-scripts"`. The shell uses no native IPC
for package messages. No main-window capability is assigned to its label; the actual
native dispatcher denies every command from rich windows. Native navigation is restricted
to the initial document and new-window creation is denied. The workspace CSP and existing
Tauri capability files are unchanged.

The CSP is generated from exact local script/style SHA-256 hashes: no `unsafe-inline`,
`unsafe-eval`, `wasm-unsafe-eval`, `blob:` images, remote host allowlist, network connection,
worker, object, media, font or form grant. Asset text is embedded only into the isolated
document; JSON configuration is escaped against HTML-script termination. Native E16
qualification must additionally establish actual frame bridge injection behavior,
all-frame navigation/resource handling (including hash/SRI remote-script requests),
popups, CSP enforcement and channel disposal on each installed target before enablement.
The browser attack checks cover parent DOM, raw bridge absence in the browser frame,
top navigation, eval and remote script/image/fetch attempts; they do not establish those
unrun native conditions or network confinement for a trusted executable extension.

The child exposes `pandaView.onDidInitialize(callback) -> dispose` and
`pandaView.onDidChangeTheme(callback) -> dispose`. Initialization
contains immutable, versioned presentation data (`owner`, `version`, `viewId`, host-created
`windowId`, `title`, `text`) and a versioned `dark | light` theme DTO. Browser characterization
also supplies a frozen, allowlisted public token snapshot and sequenced read-only theme
updates; native token/update parity is not qualified or enabled. Each subscription family
is bounded to 16 callbacks and disposed with the child. It contains no project,
credential, filesystem or task data. Additional core DTO grants need separate future API
adapters; package messages never dispatch arbitrary native commands.

Every message has schema version 1, an unpredictable per-window session, exact kind and
sequence, a strict field allowlist and a 32,768-byte serialized UTF-8 maximum. The host
accepts only one ready message from the actual frame window with opaque `null` origin;
the child accepts only one initialization from its actual parent. A sibling's claimed
identity cannot replace browser source identity. Duplicate/stale messages are ignored.
The child bounds subscribers at 16 and clears them on disposal. There is a five-second
initialization fallback. Closing a window disposes only its frame/listeners/timer/native
presentation record. Disable, safe mode, uninstall or changed owner assets/definition
revalidate and close owned UI without stopping core tasks, PTYs or workspace services;
unrelated owners remain open.

## Automated checks

- `npm test` includes channel/schema/source/disposal unit cases.
- `npx playwright test tests/extensions-rich-views.spec.ts` and the explicit
  `-c playwright.webkit.config.ts` runner exercise headless browser characterization.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` includes real ZIP
  installation/restart/asset-rejection and native owner/version/grant/unsupported policy
  tests. These are native Rust policy/composition tests, not installed WebView proof.

Use a verified free `PW_PORT`, `PW_PROD=1`, `PW_WORKERS=1` and the actual Windows Chrome
path in `PANDACODE_TEST_CHROME`. Both runners are registered in CI. Disabling the package
or using safe mode leaves the declarative fallback and built-in recovery available.
