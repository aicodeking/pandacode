# Panel folders on isolated, persistent origins (R0302)

A trusted package's rich view (`contributes.views[].rich`, permission `ui.richViews`, executable trust, a qualified
platform: see [runtime-rich-mount.md](runtime-rich-mount.md)) may be a whole folder of web files or a remote page, not
only the legacy three inline files. ADR-0001 decides that panels are code in their own frames; ADR-0005 decides that
the boundaries below are fault isolation, predictability and memory, not security limits.

## Declaration

```json
"views": [{
  "id": "sample.rich-assets/board", "title": "Asset board", "text": "Host-rendered fallback.",
  "rich": { "folder": "panel", "entry": "index.html", "remote": ["https://charts.example.test"],
            "placement": "inspector", "minSize": { "width": 320, "height": 240 } }
}]
```

`$defs/richView` is three closed alternatives (a mixed form matches none and answers `InvalidShape`):

| Form | Required | Also allowed |
|---|---|---|
| Legacy | `html`, `css`, `script` (`assets/…`, 64 KiB each, inlined into one host-composed document) | `minSize`, `placement` |
| Folder | `folder` (an archive folder, the pattern of `runtime.files`), `entry` (a page path inside it, at most 256 characters, no leading `/`, no `.` or `..` segment) | `remote`, `minSize`, `placement` |
| Remote | `url` (https, at most 1,024 characters, lowercase host), `remote` | `minSize`, `placement` |

`remote` is 1 to 16 origins (`https://host[:port]`, lowercase, no path). For a remote page the origin of `url` must be
listed (a semantic rule in both validators and again at install). The declared origins are shown in the executable
trust dialog ("Its panels load pages and frames from: …").

Install checks the folder against the archive: every file in it, of any type, is a declared panel file (the package
limits of R0105 apply: 1,024 files, 8 MiB per file, 64 MiB expanded); the entry page must be in it ("the entry page
panel/missing.html is not in the archive"); a file outside every declared folder is still "Undeclared package file".

## Origin

Each package's panels are served by the `pandapanel` scheme from one origin that belongs to that package alone:

- Windows (WebView2 reaches custom schemes through this form): `http://pandapanel.<key>.localhost`
- other platforms: `pandapanel://<key>.localhost` (not qualified yet; their panels answer `UnsupportedRuntime`)

`<key>` is `p` followed by 32 hex digits of SHA-256 over `pandacode-panel-origin-v1:<package id>`. It is different from
the app's origin and from every other package's, and it is the same for every version, every restart, the inspector
placement and the separate window. So:

- the page's own storage (local storage, IndexedDB, the cache API) belongs to the package: two packages that use the
  same storage key never share it, and all panels of one package do;
- it survives task switches, closing and reopening a panel, the separate window, a restart and an update;
- "remove own data" (after uninstall) leaves a marker, and the next panel shell of that package clears the page's
  storage once before the package's page runs (`/~panda/wiped` removes the marker).

The panel webview (inspector) and the separate window both navigate to the host's shell on that origin,
`/~panda/shell/<webview label>`. The shell frames the entry page unsandboxed on the same origin, so the page's storage
is first-party (no partitioning under another top-level site) and both placements are top-level documents of the same
origin in the app's one WebView2 profile. A remote page is framed from its own origin (its storage is the remote's,
partitioned under the package origin where the engine partitions third-party storage).

## What is served

| Path on the package origin | Answer |
|---|---|
| `/~panda/shell/<label>` | The shell, only to the webview `<label>` it was composed for. Its own policy: `frame-src 'self'` plus `rich.remote`, hash-pinned script and style, `connect-src 'self'`. |
| `/~panda/client.js` | The client script (`rich-view-channel.js` + `rich-view-client.js`): `pandaView`, `pandaView.baseUrl`. |
| `/~panda/wiped` | Clears the "remove own data" marker (204). |
| any other path | The folder file of that relative path with its media type (modules as `text/javascript`, `.wasm` as `application/wasm`, images, fonts, media); HTML pages get the client script as their first script. A directory path names its `index.html`. |

`~` never occurs in an archive name, so `/~panda/` is the host's own namespace. **Package pages get no content policy
from the host**: network, workers, WebAssembly, `eval`, media, fonts and remote frames are the page's own business.
Every answer carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

The page learns its base from `pandaView.baseUrl` (never hard-code the origin). A remote page gets no injected client:
it is shown as is, without `pandaView` (the SDK's `sdk/panda-view.js` for remote pages and the channel are R0303).

## Failures, each with a useful panel error

| Failure | What the user sees |
|---|---|
| A path outside the folder (`../x`, `%2e%2e`, empty or `.` segments, a backslash) | A 404 page in the panel: "Outside the panel folder" |
| A path inside the folder that is not a file | A 404 page: "Not in the panel folder — `x` is not a file of this panel's folder…" |
| The panel's frame navigates to an origin outside `rich.remote` | The shell stops it (its own `frame-src` policy): the panel is shown failed with **Reload panel**, reason `origin` ("…tried to open an address its package does not declare in rich.remote…") |
| Another package's origin, or the app window, asks a package origin | A 403 page ("Another package's address" / "Not served here"): files of a package are served only to its own panels |
| The served folders of all open panels would pass 256 MiB in memory | `LimitExceeded`: "Open extension panels hold too many panel files (256 MiB). Close a panel of another package, then reload this one." |
| The package changed while the panel opened | `StaleContext`: "Reload the panel to show the current version." |
| An install with a missing entry, a bad folder, an unlisted remote origin or a mixed form | The install fails with the reason (`Rich view <id>: …` or `Invalid manifest: InvalidShape`) |

A page that loops blocks its same-origin shell, so the heartbeat stops and the R0301 watchdog ends the panel
("stopped responding"); a page that throws reports a fault. Tasks, terminals and the draft are never touched.

## Update behaviour

The origin and the page's storage stay across an update. A live panel is pinned to its archive digest, so after an
update, rollback or same-version reload of the package `rich_views::reconcile` ends it with reason `changed`: "The
package changed; reload the panel to show the new version." Reloading opens the new files; nothing is cached across
generations (`no-store`), and the served folder is replaced in memory when the new generation is mounted.

## What a panel never obtains

- Native commands: panel webviews and separate windows have no command grant (`windows::command_allowed`, R0301) and
  the scheme handler only reads files; nothing in a panel becomes an IPC call.
- The app document: the shell and its frame are on the package origin, never the app's.
- Host-held credentials or secrets (ADR-0006): the scheme serves only the package's own archive files and the host's
  scripts; no header, query or page carries a held value.

## Refusals reconciled by this slice

| Row | Disposition |
|---|---|
| Q023 (`packages.rs` `rich_view_archive_validates_local_assets_without_exposing_source_in_snapshot`: a 65,537-byte script, a missing third file and an undeclared `assets/extra.js` are refused) | Retained for the legacy inline form: its three files are inlined into one host-composed document (predictability of that composition). Changed by the new permissioned form: a `rich.folder` of any number and type of files within the package limits (`installed_folder_and_remote_panels_validate_...`, with a 200 KiB module). Undeclared files outside every declared folder stay refused (the archive is what the manifest declares). |
| Q026 (`rich_views.rs` `composed_document_has_no_broad_csp_...`: `connect-src 'none'`, `worker-src 'none'`, no `https:`) | Retained for the legacy inline document (its policy pins the inlined files by hash). Changed for folder and remote panels: their pages get no host policy (`package_files_carry_media_types_and_no_content_policy_...`); only the host's shell pins its frame to the declared origins. No `unsafe-eval` or `blob:` in any host document (the app's own CSP is unchanged). |
| Q048 (`extensions-rich-views.test.mjs`: a remote or query-string `rich.html` does not validate) | Retained for `rich.html` (an archive path of the legacy form). Changed: a remote page is `rich.url` with its origin in `rich.remote` (new positive test in the same file; an unlisted origin answers `InvalidShape`). |
| Q118 (`extensions-rich-views.spec.ts`: the opaque frame reports `network: false`, `eval: false`) | Retained for the legacy inline form (same reason as Q026). `parentDom` and `rawIpc` stay false for every form (fault isolation, interface stability). Changed: a folder panel loads modules, images and a declared remote frame (`extensions-runtime-rich-assets.spec.ts`). |

Retained denials that are not security limits: a missing or revoked grant, untrusted content, a stale version and a
foreign owner (the grant, the trust and the files belong to the installed version of one package); the 256 MiB
in-memory budget (memory of the app); forged request fields (`InvalidShape`).

## Evidence columns

- Preview: `tests/extensions-runtime-rich-assets.spec.ts` (browser iframe and popup, `?rich-assets`). The browser has
  no `pandapanel` scheme: the spec answers the package origins with `respondPanel`, the TypeScript twin of the native
  handler (`src/extensions/runtime-rich-assets.ts`), through Playwright routes, and fulfils the declared remote origin
  from fixtures. Cross-placement storage sharing is not asserted there (a browser partitions the iframe's storage
  under the app page).
- Native fixtures: `rich_views::runtime_rich_assets::tests` (origins, forms, paths, media types, ownership, shell
  policy, budget, wipe, install through the real validator, update pin), fixture
  `tests/fixtures/extensions/runtime-rich-assets/` (`alpha` = folder and remote page, `twin` = same key and paths in
  another package, `remote` = the fake remote origin's pages).
- Installed qualification: pending. The WebView2 behaviour this relies on (one profile for the panel webviews and the
  separate windows, `http://pandapanel.*` interception for frames, modules and workers, `frame-src` violation events
  on the shell) is design, not observation, until the installed `rich-panel` scenario records it.

## Limits

- A remote page has no `pandaView` until R0303 ships the SDK client for remote pages and the channel.
- Requests of service workers are not intercepted by WebView2's resource filter; a panel that registers one gets no
  folder files through it (qualification pending).
- Navigations of frames nested inside the package's own page are the page's business (no host policy on package
  pages); only the shell's direct frame is pinned to `rich.remote`.
- The browser preview mounts folder panels only with `?rich-assets` and the spec's routes.
