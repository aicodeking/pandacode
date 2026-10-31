# PandaCode

Original native desktop coding workspace, macOS first; Tauri 2 + Rust + TypeScript. The user authorized implementation and architecture decisions. Research T3 Code for requirements and architectural tradeoffs only; do not copy source or UI assets.

## Design

Native system webview, one Rust core, no bundled Node runtime/server. Plain TypeScript DOM updates, local SQLite persistence, bounded transcript pages and output buffers. Spawn provider processes only for active turns and terminate when complete; resume through provider session IDs. Lazy-load terminal and Markdown rendering. Native IPC only, no listening HTTP server in production.

Charcoal and white workspace themes, yellow primary actions and selection, bamboo-green accents, neutral secondary surfaces, and platform system typography. Three columns: task navigation, conversation/composer, collapsible inspector whose views (Files, Search, Changes, Browser, and PR, Simulators and VM where they apply) sit in a VS Code-style icon bar along its top edge, level with the workspace header; it opens on Files for tasks without saved panel state. A simple bamboo mark, a small PandaCode label, and subtle botanical details provide restrained branding. Keep the mark focused on application identity and leave working surfaces quiet. Official provider marks identify harnesses throughout the task list, conversation, composer, model picker, command palette and settings; all assets are local. The terminal follows the selected theme and is only mounted when opened. Immediate press feedback, clear keyboard focus, restrained translucent chrome, and reduced-motion, reduced-transparency and high-contrast preferences follow the apple-design skill. Avoid entrance animations that delay access or disappear in background WebKit windows.

A moon/sun toggle in the sidebar footer switches between the original light theme
and a charcoal theme with yellow and bamboo-green accents. Save the explicit choice locally and
apply it before constructing the workspace; dark is the default when no valid
preference is saved, and an explicit light choice is preserved. Update
menus, code, native window appearance and the already-mounted terminal together,
without rerendering the conversation, losing drafts or restarting the PTY.
Both palettes retain reduced-transparency and increased-contrast alternatives.

The sidebar groups tasks globally by the last agent response: Active within 24 hours,
Inactive otherwise, with a collapsible Inactive section. A project filter sits above
the groups, and every row retains its project context. Persist response timestamps
separately from metadata updates, backfill existing history once, and use one timer
for the next activity boundary instead of polling. Preserve observed response times
while native streaming output awaits persistence. Clear the previous inspector's
actions synchronously when switching projects.

Tool activity is grouped by user turn in a compact, initially collapsed
“Worked for …” disclosure. Opening it reveals intermediate commentary and tool
calls, each with its existing input/output disclosure. The final answer stays
outside, as do errors and actionable approvals. Native turn durations persist;
older completed history explicitly labels estimates from saved timestamps.
Unanchored or unfinished history does not invent a completion time.

Live activity uses the same disclosure and one elapsed-time timer only while
the selected task is running and the document is visible. Keep at most 30 live
activity entries, cap commentary previews at 16 KiB, preserve a focused tool at
the buffer limit, and identify omitted activity. Saved transcript paging retains
the existing 100-message/2 MiB limit. Expansion, keyboard focus and output scroll
survive tool updates and the handoff from live to saved messages. Native details
controls work immediately, with a short reveal and reduced-motion fallback.

## Working scope

Projects, threads, archive/search, provider/model and approval mode, streaming chat/tool activity, stop, approval replies, resume, files/context attachments, Git status/diffs/stage/unstage/commit, isolated worktree creation, real PTY terminal, keyboard shortcuts, provider installation diagnostics and local preferences. Claude Code, Codex and Kimi Code use their installed CLI authentication, never keys stored in the UI. Additional provider adapters fit the same normalized event interface.

## Guardrails and resource discipline

Project operations validate canonical paths. File reads stay inside project, cap output and reject binary data. Git commands use argv, not shell interpolation. Agents retain their own permission model; explicit approve/deny UI. Tasks default to Standard approvals; elevated modes require the user to select them for that task. Render provider content as untrusted text/sanitized Markdown. SQLite recent transcript loading is bounded. No recursive idle file watchers, background polling, eager Monaco editor or always-running agents. Metrics state scope honestly (core RSS excludes system webview and provider children).

## Verification

Exercise protocol parsers and request serialization, storage restart, path traversal, Git operations, cancellation and process cleanup. Compile production assets and native release. Browser interaction checks use explicitly identified fixture mode; actual provider smoke tests use a temporary repository and tiny read-only prompts. Compare measured package sizes; do not claim superiority over T3 without equivalent benchmarks.

## Execution

1. Fix shared TypeScript/Rust IPC contract.
2. Build native storage/project/Git/terminal core alongside UI and provider adapters.
3. Integrate real streaming, resume, approvals and process lifecycle.
4. Run tests, native build and UI checks; fix found issues.
5. Package macOS app, measure footprint, document runnable commands and remaining parity gaps.
## New-task project selection

The new-task page follows the supplied layout in PandaCode's selected theme:
a small provider mark above a centered “What should we build in …?” heading and a
composer anchored at the bottom. The heading's project name and the composer context
row open the same searchable, keyboard-accessible project picker. Project paths
distinguish duplicate names; the current project has a checkmark. The picker loads
on demand, renders at most 100 matching rows, and closes when its task changes.

New task continues to use the last active project without a setup dialog. An empty
task can change projects in place, preserving identity, draft, harness and model.
Old file attachments and inspector content clear on a project change, and a terminal
in the previous project closes. Established conversations retain their original
project. The native configure command verifies full history and resume state under
the same locks as turn startup; the UI guards asynchronous navigation and canceled
folder selection. The screenshot's promotional banner and projectless execution
are outside this change.

## Dropdowns

Model, project, permission, task-action and default-agent menus share a warm white
material, a fine border, soft shadow and yellow selection. Search fields are inset
into the surface. The project filter also supports search, so large project lists
remain reachable while rendering at most 100 matching rows.

Menus fade from their trigger with a small translation and scale over 170 ms;
dismissal takes 110 ms and starts from the current presentation. Input works during
the entrance. Reduced motion uses only a short opacity fade, and transparency and
contrast preferences have solid, legible alternatives. A shared animation helper
owns transient completion timers and removes dismissed nodes and listeners. Its
visible resting styles also work when a background webview suspends animation.

Menu code loads on demand. Escape, outside clicks and competing menus cancel even
a pending first load. Arrow keys, typeahead, selection states and focus restoration
are supported; a menu opened in Settings stays inside the native dialog's focus
scope. Permission changes preserve the composer and its draft.

## macOS glass

On macOS 26 and later, use Apple's native `NSGlassEffectView` with the webview as
its content view. The native material spans the window; opaque conversation and
inspector surfaces leave only the sidebar exposed. A small warm tint, translucent
yellow selection and a fine edge highlight retain PandaCode's white/yellow palette.
One native behind-window vibrancy backdrop supplies desktop colors beneath the
glass. Both views resize through AppKit, without shaders, per-frame JavaScript,
additional webviews or a CSS blur over the sidebar. The glass keeps the webview
in its supported content-view slot, and both native views are released together.

Older macOS versions use AppKit vibrancy. Other platforms and browser preview keep
the opaque theme. Reduced transparency or increased contrast selects a solid
surface; browser media changes and window activation refresh the native preference
query. Requests are serialized and coalesced, and CSS becomes opaque immediately
when an accessibility preference is enabled.

Glass uses the supported content-view hierarchy described in
[Apple's AppKit session](https://developer.apple.com/videos/play/wwdc2025/310/)
and the [NSGlassEffectView API](https://developer.apple.com/documentation/appkit/nsglasseffectview).
Tauri's transparent macOS webview requires its documented `macos-private-api`
feature. This local desktop build is therefore not suitable for Mac App Store
submission without revisiting that webview transparency mechanism; the AppKit
glass effect itself uses public APIs. The feature flag lives in the base config
for Tauri build validation; only the macOS window overlay enables transparency.
