# Content contract compatibility (experimental)

The content contracts use version 1 DTOs and the existing declarative package
schema. This is **not** a stable API or a cross-platform qualification announcement.
The general platform completion/API stabilization gate is separate.

| Slot | Selectable presentation | Compatible movement | Core ownership retained |
| --- | --- | --- | --- |
| `panda.files` | `list` | Original file-list presentation | File enumeration, folder expansion, document open |
| `panda.documents` | `viewer-first` | Original header order; `panda.views/documents` Main/Inspector placement | Tab/document identities, bytes, selection, parsers/workers |
| `panda.changes` | `commit-first` | Original commit-form order | Repository/diff/hunk identity, viewer, staged scope and Git policy |
| `panda.search` | `results-first` | Original form/results order | Query/options scheduler, captured results and original open handlers |
| `panda.browser` | `controls-below` | Original toolbar order | Guest/session, navigation, geometry and task attachments |
| `panda.terminal` | `tabs-below` | Original strip order; compatible `panda.views/terminal` placement | PTY/controller/job, tab selection and close approval |

These are deliberately closed host-rendered recipes, not arbitrary executable
renderers, DOM/selector APIs or business-service ownership grants. Inspect the
catalog for eligible controls, action/context locations, visibility and order.
Catalog pages are bounded: follow `nextCursor` until exhausted. Discovery does not
authorize invocation. Menus, icons, commands, dialogs and selects use the same
contracts as header/sidebar contributions; there is no content-only UI framework.

Install/enable does not select a component or a customization proposal. The user
chooses the provider/proposal explicitly. Incompatible versions remain unavailable;
competing packages never win by activation order. Hiding is presentation, not
revocation. Independent metadata/content permissions remain independent.

Actions carry captured opaque host context, identities and revisions. Unsupported,
stale, revoked, malformed and replayed operations fail closed; do not retry an
ambiguous mutation automatically. Pull snapshots/pages require fresh reads after
invalidation; Search cursors report `ResyncRequired`. No new live event or source
content endpoint is implied. Original document control availability and native
process/approval policy still apply. The original read-only diff has no hunk-stage
handler; unsupported hunk mutations never become whole-file staging.

## Recovery and qualification

Choose Built-in, disable the package, or disable extensions for the launch. Safe
mode ignores saved hidden-control/order overlays, including later host refreshes,
without erasing the saved preferences. Original documents, draft, query, guest
and PTY remain core-owned. Package removal disposes its transient UI/listeners;
it does not repeat dispatched work or kill unrelated processes.

Automated Chromium/WebKit fixtures prove preview behavior, not installed WebView2,
WKWebView or WebKitGTK guest/drag/IME qualification. Native library/archive/policy
tests and the real Windows ConPTY registry/job test are separate native evidence.
Installed Windows and Linux/WSL interactive acceptance is user-deferred; macOS,
ARM, mobile devices and real multi-machine acceptance remain unavailable/deferred.
Native website context menus and Linux's existing system-browser fallback are
platform boundaries, not exemptions for missing supported host controls.

See [documents](documents.md), [diff](diff.md), [Search](search.md),
[Browser](browser.md) and [Terminal](terminal.md) for exact bounds and authoring
examples. Canonical implementation evidence and historical failed checks remain
in the project's extensibility receipt, not in a claim of universal API stability.
