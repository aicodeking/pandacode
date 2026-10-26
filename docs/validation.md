# Validation

Verified through September 16, 2026, on macOS arm64. These results describe the local
build and installed provider CLIs; Windows and Linux have not been validated.

## September 15: agent tools and integrations

- Rust: 211 passed, four opt-in tests ignored; Clippy passed with warnings denied.
- Chrome: tools, structured input, concurrency and sidebar checks passed. A menu
  measurement initially ran before its lazy import completed; the test now waits
  for the visible menu. The repeated 500-task checks held composer/menu/rows
  stable with zero navigation/header/board mutations and roughly 17 ms p95 frames.
- WebKit: six app-tool/browser checks, six structured-input checks and 15 sidebar
  layout checks passed, including a task switch during a pending native check.
- Native fixtures exercised real local child processes, callback cancellation,
  blocked stdin, scoped task mutations, oversized history, and invalid-answer
  retries. They did not invoke models or authenticate external integrations.
- The exact native browser inspection script was exercised in WebKit, including
  escaped selectors, deep component trees, text entry and excluded password values.
- The production entry remains approximately 40.4 KB gzip; integration UI is
  loaded on demand. No new always-running HTTP or integration server was added.

The older results below describe the September 13 baseline; their size numbers
are historical. See [agent tools](agent-tools.md) for the supported surface and
the existing-thread/private-service compatibility limits.

## September 13 baseline

| Check | Result |
| --- | --- |
| Native packaging | The macOS arm64 application bundle built successfully. The local bundle is ad-hoc signed; public distribution and notarization were not tested. |
| Claude Code | Explicit model `sonnet` completed two small read-only prompts. The second turn resumed the same provider session and recalled the first response. |
| Codex | Explicit model `gpt-5.6-sol` completed the same generation and resume check. |
| Kimi Code | ACP initialized successfully and returned an authentication-required error. Successful generation and resumption remain unverified. |
| Native project workflow | A normally launched app opened a temporary smoke-test project, listed its files and displayed its Git branch. |
| Native agent and persistence | Claude `sonnet` returned the requested exact response in the native app, and that response was persisted. |
| Native terminal | The terminal executed `printf` to create a file, and the resulting file was verified. |
| Native Git actions | The UI displayed that file's diff, staged it, committed it, and returned to a clean working tree. |
| Rust validation | 59 tests passed; the opt-in live test was excluded from the ordinary suite. `cargo clippy --all-targets -- -D warnings` passed. |
| Frontend validation | All 52 browser interaction tests, five tool-rendering checks and both production bundle checks passed. TypeScript and the release build passed. |
| Final packaged app | Reopened the saved conversation after restart; verified visible terminal output and zero active agents/terminals after closing it. |

The configured Claude and Codex defaults were unavailable in these checks: Claude's
default reported unavailable usage credits, and Codex's default required a newer
CLI. Explicit model overrides passed without changing the user's provider settings.
No login, purchase, CLI upgrade, or authentication configuration change was made.
See [provider details](providers.md) for protocol choices and opt-in smoke tests.

## macOS folder access

A normal application launch received `EPERM` when opening the project under
Documents. Launching the executable directly from the parent process could read
that folder using the parent's inherited access. The temporary project above
worked in a normal launch. This identifies a macOS privacy/access limitation of
the tested launch context; no privacy settings were changed during validation.

Use **Browse** to select the folder. If macOS still blocks access, allow PandaCode
under **System Settings → Privacy & Security → Files & Folders**, then use
**Retry** in the app. Recheck access after changing launch method or app location.

## Size and memory claims

The compiled native executable is 5,938,048 bytes before bundle signing. The main JavaScript entry is
60,326 bytes raw / 19,096 bytes gzip. The app bundle occupies about 5.7 MiB and the
macOS arm64 ZIP is 2,702,582 bytes (about 2.6 MiB). Optional terminal, Markdown and
menu chunks are separate from the startup entry. The model picker is 6,621 bytes
raw / 2,710 bytes gzip; the project picker is 5,507 bytes raw / 2,209 bytes gzip.
The shared choice menu is 6,508 bytes raw / 2,758 bytes gzip, and its animation
helper is 1,985 bytes raw / 900 bytes gzip. Menus load only when opened.
Provider logos total 16,447 bytes
as separate local assets, shared across rendered task rows.

Before the visual update, after the native workflow and opening/closing the terminal, a warm idle snapshot
showed 124,485,632 bytes (118.7 MiB) of native core RSS, zero provider children and
zero terminals. This is one point-in-time observation, not a cold-start baseline
or whole-app private-memory measurement. Run `node scripts/measure.mjs` for a fresh
snapshot.

The resource snapshot and measurement script do not include WebKit helper
processes in core RSS. No matched T3 Code workload comparison has been performed,
so this project does not claim a measured memory-reduction percentage.

Ordinary automated tests do not invoke paid models.

## Native macOS glass

macOS 26 uses `NSGlassEffectView` around the existing webview, with a native
behind-window Sidebar material underneath it to supply desktop colors. Opaque
conversation and inspector surfaces reveal this material only in the sidebar.
Earlier macOS uses vibrancy; other platforms and browser preview stay opaque.
Neither a rendering loop nor an additional webview was introduced.

All 52 browser tests passed, including glass/vibrancy styling, solid fallbacks,
serialized preference updates, stale-response protection, and preservation of
drafts, task selection, open menus and focus. All 59 Rust tests and Clippy passed;
native policy tests cover OS availability and accessibility overrides. TypeScript,
the release build, five tool-rendering checks and both bundle checks passed.

The macOS 26.2 app was rebuilt, ad-hoc signed and verified with strict signature
checking. Native checks covered the sidebar material, opaque conversation and
inspector, model menu, saved tool details after restart, and native window resizing.
The narrow-window check also exposed task rows exceeding their grid track. An
explicit shrinkable column corrected it; at 860px, long labels truncate and all
provider logos remain inside their cards without horizontal navigation overflow.
Accessibility fallbacks were tested through media preferences and the native
selection policy; system preferences were not changed. The older macOS vibrancy
path has not been run on an older OS. No inference turn was started.

## White and yellow visual update

Applied the apple-design skill: system typography, restrained white surfaces,
yellow actions and selection, immediate press feedback, fewer repeated labels,
and icon-only branding. Reduced-motion, reduced-transparency and increased-contrast
preferences are handled; the terminal enforces a minimum text contrast of 4.5:1.

All 10 browser checks passed. The final TypeScript/release build and both bundle
checks passed. The native app was reopened and visually checked for conversation
layout, the new-task dialog, and live terminal output. The updated application
bundle was ad-hoc signed and passed `codesign --verify --deep --strict` before
the release ZIP was refreshed. No provider protocol or storage behavior changed.

## Instant tasks and inline model selection

New task creates an empty conversation immediately in the last active project,
without a setup dialog, and focuses the composer. A searchable popover in the
message box groups models by harness and supports custom model IDs. The project
and last selected harness/model are remembered. Harness changes are allowed before
the first message; the native store rejects switching an established conversation
to a different harness while allowing model changes within its current harness.

All 14 browser checks passed, including project restoration, draft and history
preservation, keyboard selection and focus, and duplicate clicks while the picker
module loads. All 37 native tests and Clippy passed. The macOS bundle was rebuilt,
ad-hoc signed, and verified with `codesign --verify --deep --strict`.

The packaged app created a new task directly in the active temporary project.
Its picker loaded Claude aliases and the installed Codex CLI's live model catalog,
including `gpt-5.6-sol`. The empty task switched successfully between Codex, Kimi,
and Claude. Restarting restored the same project and the saved Claude `sonnet`
selection. These checks started no inference turn and changed no provider login.

## Provider logos and response-based activity

Official Claude, OpenAI and Kimi marks now appear in task rows, the header,
conversation, composer, model picker, command palette and provider settings.
The top has a restrained yellow gradient and a small application label. Brand asset
sources and checksums are recorded in [brand-assets.md](brand-assets.md).

The sidebar groups tasks across projects into Active and Inactive using the last
agent response, with a project filter above the groups. New tasks without a response
are Inactive. The 24-hour boundary is scheduled with one timer; the browser check
verified Active at the boundary minus one millisecond and Inactive at the boundary.
Tests also cover project filtering, collapse, metadata edits preserving recency,
streaming response timestamps surviving a metadata refresh before persistence, and
old inspector actions disappearing immediately during an asynchronous project switch.

All 21 UI checks, 40 native tests, TypeScript, Clippy and both bundle checks passed.
The rebuilt and ad-hoc-signed macOS app was opened normally. Its existing saved
assistant conversation backfilled into Active while three unanswered conversations
remained Inactive. The local provider marks, group labels, gradient, small title and
composer picker were visually verified in the packaged app. No inference was needed.

## Tool inputs and results

Tool disclosures now display bounded input and output previews. Provider starts,
progress and results share one stable record, and schema version 3 persists each
snapshot in place. Expansion, keyboard focus and output scroll survive live updates
and the asynchronous handoff to saved history. Interrupted turns retain partial
details with an explanatory note. Legacy label-only records state that their details
were not recorded.

All 51 native tests, 25 browser tests, five tool-rendering checks, both bundle checks,
TypeScript and Clippy passed. A browser test's paused-clock race was corrected by
waiting for its running fixture event before advancing the animation frame; its
count, expansion and persistence assertions were retained.

The macOS app was rebuilt, ad-hoc signed and verified with
`codesign --verify --deep --strict`. One Claude `sonnet` turn ran `pwd` and read the
synthetic README in the temporary smoke-test project, without changing files.
Bash displayed its command and working-directory output; Read displayed its path
and the README contents. Each had one completed row. Restarting the normally
launched app preserved both inputs and outputs in the **Tool details verified** task.
The older user conversation was preserved and its label-only entries display the
missing-history note. No provider credentials or settings changed.

## Centered new-task page and project picker

Empty tasks display a centered heading with a selectable project name, a provider
mark, and the composer at the bottom. The composer context row shows the project,
local execution, and Git branch. Both project controls open a searchable picker;
its folder action can register a project and assign it to the same empty task.
Project selection preserves draft and model, clears old project attachments, and
updates file/Git context. The native command rejects changing an established task's
project, including conversations whose messages are outside the visible page.

All 31 browser tests, 56 native tests, TypeScript, Clippy, five tool-rendering checks
and both bundle checks passed. Browser coverage includes keyboard selection and
focus, changing projects without replacing the task, delayed project changes during
navigation, and canceled folder requests leaving later dialogs untouched. The
layout and picker were inspected at desktop size; narrow-window checks also pass.

The rebuilt macOS bundle was ad-hoc signed and passed strict code-signature
verification. A normal launch displayed the user's existing empty task in the application project
with the new layout. Its heading picker switched the task to the temporary test
project; its composer picker restored the original project. The heading, sidebar project label,
and Git branch changed together. The user's selected Codex harness remained intact;
no prompt was sent and no inference turn was started during this check.

## Consistent dropdowns and transitions

Model, project, project-filter, permission, task-action and default-agent controls
use matching anchored menus with warm white surfaces, yellow selection and short
fade transitions. They remain interactive during entry and immediately leave the
focus/accessibility tree when dismissed. The shared motion code adds no dependency
and loads with the first menu. Reduced-motion, reduced-transparency and increased-
contrast preferences are supported.

All 48 browser checks passed, including nine delayed-import dismissal combinations,
typing and selection during a paused entrance, repeated close/reopen cleanup,
permissions saving across navigation, and nested Settings focus and hit-testing at
860 × 580. Project-filter search reaches entries beyond the first 100 and retains
the selected project on reopening. Five tool-rendering checks, both production
bundle checks, TypeScript and the macOS release build passed. Rust source and its
previously verified 56-test suite were unchanged in this frontend update.

The released app was rebuilt, ad-hoc signed and passed strict signature verification.
Native model and task-project menus were visually inspected; the project filter
accepted search text and reduced its results. Permissions and task actions exposed
the expected choices, and Escape restored each trigger's focus. No inference turn
was started during these dropdown checks. The native default-agent menu retained
Codex as selected, and Escape returned to its trigger while keeping Settings open.
The app was left on the user's empty task in the original project with the composer focused.

The project-picker spacing correction removes unused scrollbar reservation and
inconsistent child margins. Search, project rows and footer now share a measured
342-pixel content width inside the 360-pixel panel. Rows are 48 pixels tall with
3-pixel gaps, and search/footer padding is tighter. Desktop and 860 × 580 previews
were checked, including search and selection, and the rebuilt native app was
visually verified with the user's three projects. All 48 browser checks, seven
Node checks, TypeScript, packaging and strict code-signature verification passed.
Two existing browser assertions now wait for the settled empty-task page instead
of its transient loading heading. No application behavior changed in this fix.

## Dark mode

The sidebar moon/sun toggle changes all workspace surfaces and saves the explicit
light/dark choice. Native window chrome and glass follow the selected palette.
The terminal updates its colors in place, preserving its mounted session and the
composer draft. No dependency or recurring rendering loop was added.

All 55 browser checks, seven Node checks, three targeted native appearance tests,
TypeScript and the macOS release build passed. Coverage includes keyboard toggling,
reload persistence, terminal continuity, native appearance synchronization,
readability and opaque accessibility fallbacks. Native dark mode was visually
verified in the rebuilt app; its ad-hoc signature passed strict verification.

## Default appearance and model metadata

Dark is the first-launch default. Explicit light or dark preferences survive reload
without being overwritten at startup. The native window also starts with a dark
appearance and then follows the saved choice.

Model pickers now fetch `{id, name, description}` from installed harnesses. Native
verification showed Claude Sonnet 5, Opus 5, Haiku 4.5 and Fable 5.1, Codex's supplied
GPT-6-Astra/GPT-5.6 names, and configured Kimi K3/K2.7 names. Invocation aliases stay
unchanged. Discovery sent no inference prompt; Claude hooks/MCP and conversation
persistence were disabled. Live metadata checks passed for all three CLIs.

All 61 UI checks, 66 Rust tests, seven Node checks, TypeScript, Clippy and macOS
packaging passed. Four opt-in Rust tests are excluded from the regular suite;
the three metadata checks were also run separately. Coverage includes saved light
and dark preferences, searching full names or IDs, custom IDs after discovery
failure, retries, obsolete metadata replies and focus retention on catalog refresh.
The rebuilt signed app was reopened and its live dropdown visually verified.

## Browser and visual context

The Browser panel provides HTTP(S) navigation, back/forward/reload, local TCP
listener shortcuts, element selection and visible-page screenshots. Its system
webview is created on navigation and released on close. Browser code remains a
lazy chunk (3.08 KiB gzip); the production entry stays within the 80 KiB budget.

All 78 Playwright checks, 85 Rust tests, seven Node checks, TypeScript, Clippy and
macOS packaging passed. Four native integration tests remain opt-in. Coverage
includes listener parsing, URL restrictions, sanitized and bounded element context,
provider image payloads, screenshot limits, guest lifecycle, task switching during
capture/send, preserving newer attachments, and restoring the guest while a closed
menu's exit animation is suspended. The final snapshot identity guard also passed
the three targeted browser Rust tests and Clippy.

Native verification used a synthetic page served on localhost:8787. PandaCode
discovered the listener, navigated between two pages, selected a button without
activating it, and captured a legible PNG through WKWebView. An attempted guest
call to list_projects was rejected. A Codex turn receiving the screenshot and
element correctly read the page's large heading and identified the yellow buttons;
it used no tools and changed no files. The screenshot itself supplied those visual
details. Light/dark switching and the selection-hint layout were also inspected.

The released macOS app was rebuilt, ad-hoc signed, and passed strict signature
verification. Native browser visibility follows app-menu interaction state without
waiting for WebKit's animation callbacks; window visibility remains owned by macOS.
In the final build, dismissing the model menu immediately restored the live page
in both the native accessibility tree and the visible window.

## Approval behaviours

The composer now exposes four approval behaviours per harness, with descriptions
that match each provider's actual controls. Standard remains the default; the
selected mode is saved per task, and changing harness resets it to Standard.

All 84 UI tests, 91 Rust tests, seven Node checks, TypeScript, Clippy with warnings
denied, and macOS packaging passed. Four opt-in native tests remain ignored. New
coverage checks every harness/mode mapping, explicit policies on start/resume and
each Codex turn, Kimi's required mode acknowledgement before prompting, persistent
storage across reopen, active-turn rejection, failed saves, keyboard selection,
task switching and safe defaults after selecting Full access. The production
entry remains below its 80 KiB gzip budget (21.46 KiB).

The permission menu was visually inspected in the browser preview. The rebuilt,
ad-hoc signed Mac app passed strict signature verification and exposed Standard,
Approve for me, Read only and Full access for its selected Codex task. Its existing
Standard selection was preserved and the user's unsent draft was restored after
the update. No agent turn was sent during native menu verification.

## Worktrees belong to tasks

Creating a worktree now saves a new task under its original project, with a
worktree icon beside its title. Task metadata supplies the checkout for agent
turns, Git, files and terminals. Switching checkouts immediately clears old file
actions and closes the previous terminal, including delayed terminal-start errors.
New worktree tasks inherit the harness/model and start with Standard approvals.

All 91 browser tests, 96 Rust tests, seven Node checks, TypeScript and Clippy
passed. Four optional native integration tests remain ignored. Coverage includes
same-project creation, isolated Git changes and file reads, task context in native
requests, restart persistence, missing checkouts, project reassignment rejection,
draft preservation, canceled creation and stale responses. Schema v5 migration
tests cover both the previous schema and partially migrated v4 databases,
nested worktrees in either project order, and untouched custom/unrelated checkouts.

In the packaged macOS app, creating a worktree in the temporary native test project
immediately selected a new task with the worktree badge and correct branch. Its
terminal's `pwd` returned the isolated checkout path. The existing Minesweeper draft
remained intact after switching back. No inference turn was started.

The final macOS bundle was rebuilt, ad-hoc signed and passed strict signature
verification. After restarting, both legacy `New` and nested `Yo` checkouts appeared
as worktree tasks under their original project, and neither remained in the project dropdown.
The verification task and its checkout also survived restart. The user's unsent
draft was restored, and the app was left on the migrated `Yo` task.

## Compact timed activity

Each turn's tools and intermediate commentary are collapsed beneath a compact
“Worked for …” disclosure; the final answer stays visible. Nested calls retain
inputs/output, while redundant legacy “Tool finished” rows are omitted. Errors
and approval actions remain outside the collapsed section. Exact elapsed time is
stored on the initiating user message; older completed turns label estimates.

All 96 browser tests, 98 Rust tests, 15 Node checks, TypeScript and Clippy passed.
Four optional native provider checks remain ignored. Coverage includes independent
turn timing, v5→v6 migration and restart persistence, unknown/partial history,
keyboard disclosure behavior, live-to-saved expansion/focus/scroll preservation,
approval visibility, and a 40-tool stream that stays within its live buffer limit
without dropping the focused tool. Commentary previews are bounded to 16 KiB.
The production entry is 23.01 KiB gzip, within the existing 80 KiB budget.

The macOS build initially exhausted available disk space; removing this project's
disposable incremental compilation cache allowed packaging to succeed. The final
bundle was ad-hoc signed and passed strict signature verification. Native visual
verification opened the conversation from the user's screenshot: its collapsed
row displayed “Worked for about 23s”, and opening it revealed three closely spaced
tool calls while keeping the answer visible. No provider turn was sent. The user's
existing Minesweeper draft was restored after restart.

## Live agent status

Nonempty response text now replaces startup/retry labels with “Generating response”.
Tool events display the running tool, retain another active tool when one completes,
and return to “Working…” when none remain. Buffered provider events preserve
“Stopping agent”; delayed approval replies preserve newer activity status.

Both new controlled-stream regressions failed against the previous implementation
and passed after the fix. All 98 browser tests, 15 Node checks, TypeScript and macOS
packaging passed. No native code changed. The delivered app was rebuilt and ad-hoc
signed with strict signature verification; its ZIP was refreshed.
The app reopened successfully after the user's active task completed. The existing
unsent draft was restored, and no provider turn was sent for this verification.

## Playful working phrases

Live activity summaries randomly choose among 24 short phrases beside the elapsed
time, rotating every eight seconds without immediately repeating. Rapid provider
events preserve the current phrase. The existing timer updates only the selected,
visible live task; no polling, dependency or extra timer was added. Pending approvals,
stopping and specific provider notices retain literal labels. Saved turns still
display their completed duration.

All 100 browser tests, 15 Node checks, TypeScript and macOS packaging passed.
The browser screenshot confirmed a compact, readable collapsed activity row in dark
mode. The Mac app and ZIP were refreshed and passed strict signature verification.
The app reopened successfully and the existing unsent draft was restored.

## Reasoning effort and reported context

The model menu now offers only advertised reasoning settings and saves the choice
per task. Claude and Codex use their supported effort values; the installed Kimi
ACP adapter exposes thinking On/Off. Default leaves the harness's saved settings
in control. Context capacity and the latest reported usage appear when available;
unknown values remain hidden and cumulative billing totals are excluded.

All 109 browser tests, 108 Rust tests, 15 Node checks, TypeScript and Clippy passed.
Four optional native provider checks remain ignored. Coverage includes schema
v6→v7 migration, restart persistence, active-task guards, model-change resets,
worktree inheritance, provider configuration acknowledgements, bounded usage,
foreign-session events, delayed saves and catalog refreshes, composer preservation,
and focus recovery. Two focus regressions reproduced before their fixes. The
production entry is 24.42 kB gzip and remains within the existing bundle budget.

Browser screenshots verified the compact settings footer at full and narrow window
sizes, along with reported context usage. The rebuilt macOS app and refreshed ZIP
were ad-hoc signed and passed strict signature verification. Native verification
loaded real Codex effort metadata, selected High, and confirmed it remained selected
when reopening the menu. Kimi's configured context capacities also appeared in the
catalog. The original effort preference and unsent draft were restored, and the app
was returned to the previously open task. No provider turn was sent during this
native verification.

## Effort slider

The effort buttons are now a rounded card with a purple gradient track, static
specks, white thumb, selected-level label, model name and reset control. A native
range input preserves keyboard and pointer behavior without an animation library
or background timer. Dragging previews a supported level; release saves it while
the menu stays open. Reset delegates back to the harness's saved settings.

All 110 browser tests, 15 Node checks, TypeScript and macOS packaging passed.
Coverage includes drag preview versus saved state, same-position selection from
Default, Home/End/arrows, right-click rejection, removal of a supported level while
dragging, reset, failed saves, task navigation and focus. Dark, light and compact
screenshots were visually checked. No native provider or storage code changed.

The refreshed Mac app and ZIP passed strict signature verification. The native
menu exposed the range and reset control with real Codex metadata and showed High
selected. The existing unsent draft was restored without changing the selected
effort. No provider turn was sent during verification.

The slider was subsequently reduced to a plain row: a 4 px yellow track, 14 px
yellow thumb and small reset control. Duplicate effort/model headings, the card,
bolt and specks were removed. The accessible value and hover text still identify
the level. Ten existing reasoning/context browser checks and all 15 Node checks
passed; dark, light and narrow screenshots were inspected. TypeScript and macOS
packaging passed, and the updated app and ZIP passed strict signature verification.

## Native slider dragging and particles

Reproduced the drag failure in the packaged Mac app and Playwright WebKit: pointer
moves arrived but the native thumb emitted no input events. Removing only the
explicit `setPointerCapture` call restored the thumb's own drag handling. The
retained WebKit configuration runs eight effort regressions, including movement
in both directions, release outside the track and persistence only on release.

The yellow track is now 8 px tall with a 16 px thumb. Twelve small CSS particles
drift inside the fill using transform and opacity, with static specks under Reduce
Motion. Closing the menu releases the particles; no animation library or JavaScript
animation timer was added. Their motion and reduced-motion behavior are covered by
the browser checks.

All 110 Chrome tests, eight WebKit tests, 15 Node checks, TypeScript and macOS
packaging passed. The Mac app and ZIP passed strict signature verification. Native
mouse drags moved the selected Claude effort from Max to Medium and back to Max,
and reopening the menu retained Max. The unsent draft was restored. No provider
turn was sent during this verification. Browser test runs should be separate from
packaging: Vite can detect generated Tauri HTML and reload a test page mid-run.

## Stable effort menu updates

The track is 14 px tall with an 18 px thumb. Effort saves update the existing
controls and composer label; they no longer replace model rows or header content.
Pending saves retain the same appearance and use an out-of-flow status, avoiding
the previous height change. Unchanged model catalogs retain rows and scroll position.

Two browser regressions reproduced row replacement, disabled-state fading and
slider movement before the fix. They now check DOM identity, menu/slider bounds,
scroll position and uninterrupted particle animations through delayed saves,
resets and identical catalog refreshes. Equivalent search queries retain keyboard
selection. Dark, light and compact screenshots were visually checked.

All 112 Chrome cases, 11 WebKit cases, 15 Node checks and TypeScript passed. The
WebKit suite retains both effort gestures and equivalent-query keyboard selection.

The rebuilt Mac app and ZIP passed strict signature verification. Native mouse
drags changed Extra high to High and back without shifting the menu; reopening
retained Extra high. The existing unsent draft and selected task were restored.
No provider turn was sent during verification.

## Effort colors

The slider fill and thumb now share a color for each effort level: mint/green at
lower levels, yellow at Medium, amber at High, coral at Extra high and violet at
Max/Ultra. Colors blend over 160 ms and reverse from their current displayed
color. Native thumb movement remains immediate. Reduce Motion uses an immediate
color change. The blend runs only during a change and cancels on dismissal; no
idle animation loop or dependency was added.

Twelve focused Chrome cases and twelve WebKit cases passed, including sampled
color interpolation, quick reversals, reset, release-only persistence, reduced
motion and retained dropdown/particle nodes. All 15 Node checks and TypeScript
passed. Dark and light screenshots were visually checked.

Native WKWebView could retain an old color with CSS transitions, so the blend
paints frames directly and has a 200 ms completion deadline if frames stall.
The rebuilt Mac app was checked with actual mouse drags from Default to Ultra
and back to High without reopening the picker: the fill and thumb changed from
yellow to violet to amber. Reset returned to yellow. The menu stayed stationary.
The signed Mac app and ZIP were updated, and strict signature verification passed.
The selected task, Default effort preference and existing unsent draft were
restored. No provider turn was sent during verification.

## Project board

Added a remembered Board/Conversation view switch. The board uses the same task
and message records, with Pending, In progress, Review and Completed columns.
Only one conversation is loaded in the right-side details/comments panel.
Descriptions in task lists are bounded to 512 Unicode characters; get_task and
Start use the full stored description. No new dependency was added. Production
entry JavaScript is 27.63 kB gzip; the startup budget checks still pass.

126 Chrome cases and 25 WebKit cases passed, including 13 board regressions for
queueing without running, saved project/details, successful completion, stopped
and failed starts, reopening from either view, archive deadlines, keyboard access,
draft preservation, delayed metadata and canceled creation. Dark/light and narrow
window screenshots were inspected. Synchronous initial dialog focus fixes an
observed race that moved typed descriptions into the title field.

117 Rust tests passed, with four existing opt-in provider tests ignored. Native
coverage includes schema migration, transactional run claims, cancellation versus
success, completion timestamps, seven-day boundaries and catch-up, full prompt
preservation, archive sweeps outside the 500-row UI cap, and recovery after failed
status persistence. Clippy with warnings denied, rustfmt, TypeScript, and all 15
Node tests passed.

The native Mac app migrated existing tasks and displayed all four board columns.
A fresh “Board workflow verified” task remained Pending with no messages until
Start was clicked. One small, read-only Codex request returned the exact requested
text without tool calls. Its task moved through In progress to Review, and Mark
complete moved it to Completed with a September 21 archive date (seven days after
the September 14 completion). The temporary task was manually archived after the
check. A label-only cleanup hides future archive dates on already archived tasks;
all 13 Chrome board tests passed again afterward.

The final Mac app and ZIP passed strict ad-hoc signature verification. Reopening
retained Board view and the migrated task stages. The existing unsent draft was
restored in its original task, and the worktree selection was restored with the
board left open. A pre-migration SQLite backup is retained locally in release/.

## Response streaming across views

Conversation and Board share incremental, sanitized Markdown rendering. Completed
blocks and growing text nodes stay in place; formatting is coalesced at 32 ms
without waiting for the response to finish. Final text stays visible while saved
history loads, including an explicit retry if that load fails. Claude, Codex and
Kimi now preserve assistant message boundaries and recover verified missing
completion suffixes without duplicating streamed text. Provider tracking is
bounded, and no dependency was added.

All 13 new streaming cases passed in Chrome and WebKit, covering partial Markdown,
stable DOM and selection, switching views and tasks during a response, late tool
updates, message boundaries, final-chunk retention, sanitization and failed-history
recovery. The full Chrome run passed 138 of 140 cases; two existing checks missed
a brief preview-response timing window. Their assertions now wait for the first
chunk rather than a later phrase, and both passed on the targeted rerun. The full
configured WebKit suite passed all 40 cases.

141 Rust tests passed, with four opt-in provider tests ignored. Clippy with warnings
denied, all 15 Node checks, TypeScript, production build and diff whitespace checks
passed. Production entry JavaScript is 28.80 KiB gzip, within the startup budget.

The rebuilt Mac app completed one read-only Codex request for 24 numbered lines,
with formatted output visible in both Board and Conversation and no duplicate
response or tool calls. The native accessibility snapshot arrived after completion;
partial-response behavior was verified by the controlled browser tests above.
The temporary task was archived, the existing unsent draft was confirmed intact,
and Board view was restored. The updated app and ZIP passed strict ad-hoc signature
verification.

## Effort footer fade

Replaced the hard divider above the effort slider with a theme-matched background
gradient that fades into the model list over 28 pixels. The decorative layer ignores
pointer events; slider, particles, reset and focus styling remain fully opaque.
Reduced transparency and increased contrast omit the gradient.

Dark and light dropdown screenshots were inspected in WebKit. Ten of eleven
existing effort checks passed initially; the color-animation check encountered its
reduced-motion timing window and passed unchanged on a targeted rerun. Dragging,
stable dropdown geometry, release-only persistence and saved preferences passed.
The Mac package build, TypeScript and whitespace checks passed.

## Concurrent tasks and performance

Exercised four independent runs with interleaved text, tool output, approvals,
completion and cancellation. Submission preparation now locks only its own task,
including Board Start. Failed background admission restores that task's draft;
returning during attachment preparation preserves newer edits. History requests
cannot replace newer optimistic or completed messages, discard a newer finishing
buffer, or reinstate an obsolete loading error.

Native approval IDs are scoped to a run and task, with stale, duplicate and
stopped-run replies rejected. Answering one request keeps the task waiting for
others; provider cancellation removes only its matching request. Completion is
queued before another run may claim the task. Concurrent admission tests verify
the existing four-agent limit and that duplicate starts do not save extra prompts.

Measurements used deterministic local fixtures rather than paid model latency:

| Workload | Before | After |
| --- | --- | --- |
| 500 tasks, four running, 180 background events, Conversation | 120 navigation rebuilds; 70.9 ms p95 frame | 0 rebuilds; 17.7 ms p95 frame |
| Same workload, Board | 120 hidden navigation rebuilds; 44.6 ms p95 frame | 0 rebuilds; 16.8 ms p95 frame |
| Four real child processes, each emitting a 3 MiB tool frame | Exceeded 10 seconds | 183–247 ms |

Tool/status traffic no longer redraws navigation or headers. Hidden transcripts
pause Markdown rendering and elapsed-time updates. Provider newline scanning is
linear in received bytes, and stderr readers are owned and cancelled with their
run. The large-frame test also checks that output previews remain capped at 8 KiB.
No dependency or additional provider process was introduced.

Four threads persisted 800 tool snapshots through the existing SQLite WAL store
in 111–126 ms, with p95 operation time including lock contention at 1.1–2.0 ms.
This did not justify changing the storage architecture. Measurements are local
synthetic workloads, not a whole-app memory comparison or a guarantee of model
throughput. Harness CPU/memory and upstream limits still affect concurrent runs.

The full native suite passed 151 tests, with four existing opt-in provider tests
ignored. All-target Clippy with warnings denied passed.

All 16 new browser concurrency regressions passed in both engines. The full Chrome
suite passed 154 cases; two subsequently added stale-selection/completion cases
passed in targeted runs. The configured WebKit suite passed 55 cases, followed by
the added stale-selection failure case. Tests assert no runtime errors, preserved
drafts/dropdowns, isolated approvals/stopping, simultaneous completion, pending
admission, and protection against duplicate Board starts.

TypeScript and all 15 Node checks passed. Production entry JavaScript is 28.98 kB
gzip, within the existing 80 KiB startup budget.

The rebuilt Mac app and ZIP were refreshed, and the app passed strict ad-hoc
signature verification. Reopening loaded the existing tasks. The unsent new-t
draft was restored, along with the original selected task, collapsed Inactive
group, and Browser panel showing Local servers. This concurrency validation used
controlled fixtures and did not send live inference requests.

## Subagent activity viewer

A compact badge at the right of the task opens a nonmodal subagent list in both
Conversation and Board details. Selecting a child shows its streamed Markdown,
assignment, parent relationship, status, and expandable tool previews. The panel
keeps its controls and response nodes mounted during updates; only the selected
child is formatted. Completed work is restored from separate task-scoped history.
The panel uses existing theme/motion primitives, supports keyboard navigation,
and stays within the thread bounds at narrow widths.

All 14 initial browser regressions passed in Chrome and WebKit, including nested
work, same-ID task isolation, stale history, failed-history retry, identical-response
reopening, safe content rendering, and Escape without stopping the parent.
The full Chrome suite passed 170 cases; the configured WebKit suite passed 70.
Dark Conversation/Board list and detail screenshots and a narrow light-theme
detail screenshot were inspected. Hidden child updates produced zero parent
transcript mutations. Existing 500-task/four-run tests retained zero navigation
rebuilds, with Chrome p95 frame times around 17.5 ms.

The adapters use verified provider event metadata. Claude and Codex expose child
streams and lifecycle information; current Kimi ACP exposes identifiable Agent
calls and their results but does not forward child-internal streams. See
[provider coverage](providers.md#subagent-activity) for sources and limits.

Three additional browser regressions passed in both engines for long run-scoped
tool IDs, foreground picker Escape priority, and preserving focus/scroll while
reading live tool output. All 17 subagent cases are covered. The full native suite
passed 169 tests, with four existing opt-in provider tests ignored. Ten provider
cases cover child routing, result reconciliation, nested/background lifecycle,
and sequential retention; eight native cases cover persistence, isolation,
recovery, and settlement events even when final writes fail. Older worktree
migration fixtures were updated to recreate their actual pre-subagent schema.
All-target Clippy with warnings denied, TypeScript, all 15 Node checks, and the
Mac package build passed. Entry JavaScript is 32.52 kB gzip, within the 80 KiB budget.

The final Mac app and ZIP were refreshed, and the app passed strict ad-hoc
signature verification. Native reopening migrated the database to schema 9 and
retained all 17 existing tasks. The original task selection, collapsed Inactive
group, and unsent new-t draft were restored. A pre-migration SQLite backup is
retained locally in release/. No live inference requests were used for this update.

Subagent labels now preserve provider names and use stable per-task numbers for
unnamed agents or legacy path labels. Paths and assignment previews no longer
appear in list rows or badge tooltips. Focused Chrome and WebKit checks covered
saved-history ordering, names, numbered fallbacks, nested labels, detail views,
and live status updates. The ten protocol cases, TypeScript, 15 Node checks, and
Mac package build passed. The signed app and ZIP were refreshed without
restarting the active user task; its original app files were retained in a hidden
release backup directory to preserve the running instance.

The effort slider's reset button was replaced by the chosen effort name. Its
fixed-width label shares the fill/thumb color on every animation frame, and
updates in place while dragging. All 11 focused effort cases passed in Chrome
and WebKit, covering keyboard input, persistence, save failures, live colors,
catalog refreshes, and stable DOM/layout. The first parallel runs collided over
nested Playwright artifact directories; the affected case passed separately in
each engine with independent output directories. Dark and light screenshots
were inspected. TypeScript, 15 Node checks, and the signed Mac package passed.

## PandaCode identity — September 15, 2026

Renamed the visible UI, native product/window name, provider client identity,
package metadata, preview fixtures, and release artifacts to PandaCode. Original
bamboo vector artwork now appears in the app icon, sidebar, welcome page, board,
browser home, and resource indicator. Existing yellow actions and both themes
remain. Decorative vectors add no timers or third-party dependencies.

The existing bundle identifier, database filename, and legacy worktree prefixes
remain compatible. A one-time preference migration copies older keys only when
the new key is absent, preserving both explicit themes and workspace choices.
It does not revive preferences removed after migration. User projects, source
folders, and saved conversation contents are not renamed or rewritten.

Validation:

- Native Rust suite: 170 passed, four opt-in tests ignored.
- Production TypeScript/Vite build and all 15 Node tests passed.
- Chromium: 174 passed in the full 178-case run. Four outdated test assertions
  were corrected (old search text and controls hidden by Board view); the final
  15-case rerun passed, covering all five preference migrations, both project
  searches, narrow layout, and worktree workflows.
- WebKit: 73 regression cases plus all five migration cases passed.
- Original/legacy worktree prefixes remain consistent in the preview and native
  app. An isolated check confirmed the bamboo mark fits the 58px collapsed
  sidebar at a 580px viewport with no document overflow.
- Visually inspected the new icon and dark/light welcome and board views.
- Built `release/PandaCode.app`, verified its app name, executable, unchanged data
  identifier, and strict ad-hoc signature. The new arm64 ZIP is 3,062,600 bytes.
  The previous app and archive are retained in a hidden release backup; running
  app processes were not restarted. Public notarization was not performed.

The production entry remains about 32.9 kB gzip. This is a bundle-size check, not
a new whole-app memory benchmark or a claim about memory savings.

## Daily anime wallpapers — September 15, 2026

Generated 21 distinct scenery images with built-in GPT Image, one for each
weekday/time band. Preserved the generated PNGs in the ignored release directory
and shipped 1600px-wide WebP copies. All 21 images were inspected individually
and in the complete review gallery. The collection is 2,594,988 bytes, with
unique file hashes and valid WebP headers. Prompts are in wallpaper-prompts.json.

The local schedule changes at 06:00, 12:00, 18:00, and midnight for weekday
rollover. Tests cover all 21 selections, exact boundaries and DST transitions.
Only the active scene is requested, with at most two scene images during a
transition. The thread and board share the background without re-rendering
controls. Settings can disable it; accessibility preferences select solid
surfaces. Narrow board detail overlays remain opaque.

Validation:

- TypeScript and Vite production build passed; 19 Node tests passed, including
  calendar/DST cases and the complete image collection size/integrity check.
- Eight wallpaper cases passed in Chromium and eight in WebKit, covering shared
  loading, midnight/noon/focus changes, draft/menu preservation, persisted opt-out,
  contrast/reduced-motion behavior, failed images, stale decoding, and narrow
  board details.
- Existing Chromium regression suite: 176/178 passed initially. Preserved the
  original Compact conversation keyboard order when adding the wallpaper
  setting; its focused rerun passed. A paused-clock streaming assertion needed
  time for the existing coalesced Markdown paint; the corrected case passed
  three consecutive runs. Both original failing cases also passed a focused run.
- Inspected dark/light thread and board screenshots and the complete 21-scene
  gallery. Body/muted/faint text against worst-case black/white wallpaper pixels
  and the least opaque overlay yields a minimum contrast of 4.77:1 in light
  and 4.70:1 in dark. This calculation covers these text tokens, not every
  possible interactive state.
- No new runtime dependencies, resident network services, background animation
  loops, or eagerly loaded image collection. Main entry is about 33.8 kB gzip.

The macOS bundle was rebuilt, all 21 wallpaper paths were verified in the native
executable, and the release copy passed strict ad-hoc signature verification.
The updated ZIP is 5,666,425 bytes. The previous bundle is preserved in
a hidden release backup; the running app was not interrupted.

## Synced slash commands — September 15, 2026

Added provider-backed slash completion in Conversation and Board task panels,
including custom-command/skill discovery, runtime updates, and native dispatch.
The menu preserves composer and option nodes, keyboard focus, drafts, and
attachments. App control commands do not start model turns.

Validation:

- TypeScript/Vite production build and all 19 Node checks passed. The entry is
  140.43 kB raw / 43.88 kB gzip, within the existing 80 KiB compressed budget.
- 264 Rust tests passed; five opt-in checks are ignored by the normal suite.
  Clippy passed with all targets and warnings denied. Coverage includes actual
  compact/review protocol requests, explicit Codex skill input, Claude local
  command output and startup revalidation, Kimi early notifications, bounded
  subprocess cleanup, native admission races, and maintenance board stages.
- 57 Chrome checks passed: the 16 new slash cases plus streaming, concurrency,
  agent inputs, and app-tool regressions. All 16 slash cases and 13 streaming
  cases passed in WebKit. The 500-task checks kept composer/menu/row nodes
  stable with zero navigation/header/board mutations and p95 frame samples of
  18.6 ms (Conversation) and 16.8 ms (Board). This is not a whole-app RSS claim.
- Visually inspected the compact command menu against the existing wallpaper
  and dark surfaces; scaled/narrow layout, reduced motion, IME, keyboard
  completion, unsupported commands, and stale lookups have browser coverage.
- Metadata-only live checks read 189 Codex catalog entries (123 native commands
  or skills) and 117 Claude entries (100 native commands). No prompts, compaction,
  reviews, or authentication requests were sent. Kimi 0.26.0 initialized but
  returned ACP -32000, “Authentication required,” from session/new, both inside
  and outside the sandbox. The opt-in combined metadata smoke correctly failed
  on that account prerequisite; it is not reported as a successful Kimi live
  command check. Fake-CLI tests validate its discovery/dispatch interface and
  the app now presents an allowlisted sign-in warning. Authentication state was
  not changed.

See [command compatibility](slash-commands.md) for unsupported terminal-only
commands and Kimi's session-discovery behavior. The normal app approval policies
remain in effect when a command requests agent work.

Built and staged `release/PandaCode.app` and the 5,829,721-byte arm64 ZIP. Strict
ad-hoc signature verification passed. The previous bundle remains in a hidden
rollback directory, and the running application was not restarted. No public
notarization or release publication was performed. Temporary preview stopped.

## Native goals and complete command workflows — 2026-09-15

- Full Rust suite: **313 passed**, five opt-in checks ignored. Includes native
  two-turn goal fixtures, pause-before-exit, saved-goal inspection without
  continuation, token/usage limits, restart recovery, repeated tool IDs, and
  Plan/Fast normalization when the selected model changes.
- All-target Clippy with warnings denied passes. Production TypeScript/Vite
  build and all **19 Node checks** pass. Entry JavaScript is **50.36 kB gzip**;
  the compressed startup bundle remains within the 80 KiB budget.
- Fresh complete Chrome run: **250 passed**. Focused WebKit run: **76 passed**,
  covering goals, command panels, slash dispatch, streaming, approvals, and
  concurrent tasks. UI fixture imports now reuse the app's exact Vite module
  URL; resize-drag tests await stable geometry. Wallpaper/focus expectations
  match the existing UI.
- With 500 task fixtures, conversation and board both recorded approximately
  **17.1 ms p95 frame time**, with no navigation/header/board mutations during
  background activity and retained composer/menu/row nodes.
- Native command/console tests verify exact argument construction, safe import
  candidates, bounded history, task ownership, and protection against opening a
  console that would unexpectedly resume an active goal. Protocol tests use
  fake processes; no model inference or personal authentication/configuration
  changes were performed for validation.
- Reviewed goal dialog at enlarged text size in a narrow window. Goal controls
  retain their nodes during updates, including errors and task switching.

Built and staged `release/PandaCode.app` and the **5,990,647-byte** macOS arm64 ZIP.
Strict ad-hoc signature verification passed. Previous bundle retained under
`release/.pandacode-update-x__5dp2q`; the running application was not restarted.
Public notarization and publication are outside this local build.

## Architect and workers — 2026-09-15

- Full native suite: **337 passed**, five opt-in checks ignored. Strict all-target
  Clippy passed. Coverage includes independent worker sessions, parallel admission,
  overlapping file scopes, idempotent dispatch, dependencies, pause/stop races,
  permission changes, bounded review prompts, and restart recovery.
- Claude and Kimi loopback MCP tests use real local fixture processes; Codex
  exercises its existing dynamic-tool path. Authentication, request limits,
  cancellation, endpoint cleanup, and rejection of broader app-tool catalogs have
  regression coverage. No paid inference or personal harness configuration changes
  were used for validation.
- TypeScript/Vite production build and all **29 Node checks** passed. Entry
  JavaScript is **51.92 kB gzip**, within the 80 KiB startup budget. Team setup and
  worker inspection load on demand; the feature adds no runtime dependencies.
- All **14 architect UI checks** passed in Chrome and all **14** passed in WebKit.
  These cover setup persistence, model and effort selection, limits, lifecycle,
  independent streaming in Conversation and Board, worker history races, approvals,
  safe rendering, and preserved controls. The WebKit picker fix also keeps modal
  focus from dismissing a choice before its click is handled.
- Inspected dark/light setup and worker panels against the existing wallpaper.
  Worker details use the shared rounded, frosted design and readable model names.
- A clean run of **179 existing Chrome checks** passed, including board, streaming,
  concurrent tasks, goals, commands, approvals, and model controls. With 500 task
  fixtures, concurrency checks recorded about **17 ms p95 frame time** with stable
  navigation/header/composer nodes. This is not a whole-app memory benchmark.
- Existing WebKit picker and appearance subset: **16 passed**, one explicitly
  skipped because its reduced-transparency emulation requires Chromium CDP.
  The frozen-clock color test waits for WebKit's existing MediaQueryList to
  receive the emulated preference before the keypress; its immediate-color and
  no-animation assertions remain intact. Both adjusted checks also passed in
  Chrome after the fixture changes.

Workers share their parent checkout with declared file scopes; those scopes are
coordination boundaries, not filesystem sandboxes. Token savings depend on model
choice and workload; no billing or savings percentage is claimed. See
[architect and workers](architect-workers.md) for operation and recovery details.

Built and staged `release/PandaCode.app` and the **6,320,423-byte** macOS arm64 ZIP.
Strict ad-hoc signature verification passed. The previous bundle remains under
`release/.pandacode-update-98ku3or9`; the running application was not restarted.
No public notarization or publication was performed.

## Persistent team defaults and profiles — 2026-09-15

- SQLite schema 12 remembers the last applied setup and up to 20 named team
  profiles. Upgrade seeding, disk reopen, profile CRUD, disabled defaults,
  inherited conversation/board/worktree tasks, worker exclusion, and atomic
  rollback have native coverage. Full native suite: **345 passed**, five opt-in
  checks ignored; strict all-target Clippy passed.
- All **34 Node checks** passed, including 11 preview orchestration and profile
  checks. The preview mirrors native default, validation, and task-history rules.
- Production TypeScript/Vite build passed. Entry JavaScript remains **52.01 kB
  gzip**, below the 80 KiB startup budget; profile controls share the existing
  lazily loaded architect module and add no dependencies.
- Combined architect/profile coverage: **23 passed in Chrome and 23 in WebKit**.
  Targeted profile and task-creation regression runs passed **11 checks in each
  engine**, with two final Chrome profile checks after tightening template equality.
  Cases cover relaunch/new task, board/worktree creation, saved templates versus
  applied defaults, rename/delete, single-agent mode, validation, failed saves,
  and immutable used teams.
- Catalog labels for inherited harnesses now refresh in place after task
  selection. The new-task regression verifies the full supplied model name after
  reloading, without opening the model menu first.
- Inspected dark and light profile menus. The existing anchored menu motion,
  keyboard interaction, and compact setup controls are retained.

Validation used disposable preview data and local native fixtures; no paid model
inference or user project edits were performed by the sample agents.

Built and staged `release/PandaCode.app` and the **6,351,758-byte** macOS arm64 ZIP.
Strict ad-hoc signature verification passed. The previous bundle remains under
`release/.pandacode-update-sbmg55pu`; the running application was not restarted.
Temporary preview and browser processes were stopped. No public publication or
notarization was performed.

## Saved turn changes and Pierre diffs — 2026-09-15

- Full native suite: **362 passed**, five existing opt-in checks ignored. Strict
  all-target Clippy passed. Seventeen capture tests cover dirty/untracked and
  committed bytes, worktree isolation, overlapping runs, autonomous boundaries,
  idle edits, additions/deletions/renames, binary/empty/mode-only files, symlink
  safety, retention, restart, and read-only Git enumeration. Canonical patches
  produced by the native implementation passed Pierre's strict parser for all
  eight text fixtures; the binary fixture uses the explicit fallback.
- All **40 Node checks** passed. Turn grouping keeps changes markers out of tool
  activity and separates goal continuations; preview snapshots remain immutable,
  scoped to the task, persisted, and bounded. The post-build startup budget
  checks passed too.
- **Nine new UI checks passed in Chrome and nine in WebKit**. They cover
  Conversation and Board completion, worker histories, folders, saved file
  selection, unified/split layouts, theme changes, reload persistence, delayed
  requests, binary/partial/unavailable states, hostile patch text, current Git
  inspection, and a long autonomous response completing while history loads.
- **Sixteen related regression checks passed in each engine**: thirteen
  streaming cases and three goal lifecycle/view/event cases. Failed final
  history loads retain exactly one visible completed response and allow retry.
- TypeScript and production Vite build passed. Entry JavaScript is **53.87 kB
  gzip**, below the 80 KiB limit. Pierre, the viewer, and syntax grammars are lazy
  chunks; large grammar chunks explain Vite's 500 kB warning and are not loaded
  at startup. The viewer disposes renderers and observers on close or replacement.
- Inspected the compact frosted file card and dark/light diff dialogs. Browser
  assertions check actual highlighted shadow-DOM content, rather than a rendered
  placeholder. Temporary browsers and Vite were stopped before packaging.

Tests used disposable previews and temporary local repositories. No paid model
inference or changes to user projects were required. See
[turn changes](turn-changes.md) for precise scope, partial-capture behavior, and
platform support.

Built and staged `release/PandaCode.app` and the **8,236,265-byte** macOS arm64 ZIP.
Strict ad-hoc signature verification passed; the prior bundle is retained under
`release/.pandacode-update-abgschmw`. The running app was not restarted, and no app
data was moved. No public publication or notarization was performed.


## Conversation recovery after team changes — 2026-09-16

- Confirmed the affected task's saved architect-reset notice between its original
  C++ answer and follow-up. Its visible transcript survived, but the native resume
  ID had been replaced without sending the earlier conversation.
- Verified installed Codex 0.154.0 protocol schemas: dynamic tools are registered
  on `thread/start`; `thread/resume` does not replace that catalog. Its
  `excludeTurns` option only suppresses returned history. Claude and Kimi reload
  MCP configuration during native resumption and keep their existing IDs.
- Native suite: **381 passed, 5 opt-in tests ignored**. The 19 new tests cover
  no-op/team-toggle preservation, bounded UTF-8/JSON history, exact C++ handoff,
  failed requests followed by “try again,” schema-13 migration, database reopen,
  stale acknowledgments, rollback, admission order, and native-command guards.
  The full suite required loopback access for its existing local MCP fixtures.
- **40 frontend tests passed**; Clippy passed with warnings denied. No frontend
  rendering or streaming paths changed. All new tests use local data and fixture
  protocols; no paid model inference was invoked.
- TypeScript, Vite, and macOS arm64 release packaging passed. The staged app was
  ad-hoc signed and passed strict signature verification; ZIP size is **8,240,686
  bytes**. The prior bundle is retained for rollback. No running app was restarted
  and no user database was edited during validation.


## Keep the latest streamed response visible — 2026-09-16

- Reproduced the message disappearing into activity when a tool/message boundary
  cleared the live text. The latest response now retains its live element until
  actual replacement text arrives; previous messages keep their history order.
- All **17 streaming browser tests passed in Chrome and WebKit**. New regressions
  cover tools and standalone message boundaries, repeated boundaries, empty
  deltas, stable DOM identity, replacement text, duplicate prevention, and
  completion with no subsequent text while saved history is delayed.
- Visually inspected the after-tool screenshot with the activity collapsed and
  the latest response still visible. Independent review found no defects in
  completion handling, history limits, or per-task/view isolation.
- The broader **31 completion, concurrency, tool-focus, and change-summary checks
  passed in each browser**. Four obsolete container-specific assertions also
  failed on the unchanged baseline; they now require one visible completed
  response and preserved tool focus/scroll. Fixture setup waits for app readiness.
- The 500-task checks preserved composer/menu/row identity with zero navigation,
  header, or board mutations during background tool updates (Chrome frame p95
  around 17 ms). The change adds one bounded per-stream marker and retains the
  existing limits on message bodies and activity previews.
- All **40 Node tests**, TypeScript, Vite, and the macOS arm64 release build
  passed. The staged app passed strict ad-hoc signature verification; ZIP size
  is **8,240,776 bytes**. No running app or user conversation was interrupted.


## Changed-files card alignment — 2026-09-16

- Reproduced a 206.5px left-edge mismatch at a 1920px viewport: the card's
  fixed margin overrode the transcript's centered content column.
- Wrapped transcript cards in the same centered column with matching message
  insets. Board and small-window layouts keep their respective insets; worker
  cards and vertical spacing are unchanged.
- Browser geometry checks matched both card edges to the response body with no
  horizontal overflow at 480–1920px, enlarged text, and board view. Visually
  inspected conversation and board screenshots. All 9 existing changed-files
  tests passed in both Chrome and WebKit, including worker snapshots and diffs.
- All 40 Node tests, TypeScript, Vite, and macOS release packaging passed. The
  staged app passed strict ad-hoc signature verification; the running app was
  left open and the previous bundle retained for rollback.


## Frosted changed-files modal — 2026-09-16

- The saved-diff modal now uses a 56% theme tint and a 28px backdrop blur. Its
  toolbar and file hover state are translucent, and a modal-scoped renderer
  variable removes the opaque code canvas while preserving syntax and diff
  colors. Inspector styling is unchanged.
- All 9 changed-files WebKit tests passed. Separate Chrome and WebKit checks
  confirmed translucent modal/code backgrounds, the blur declaration, light/dark
  switching, the solid high-contrast fallback, and dialog dismissal. Chrome
  screenshots verified the frosted appearance over a bright wallpaper. Headless
  WebKit snapshots did not composite backdrop blur, so they were used for styles
  and interactions rather than as visual proof of the effect.
- Reduced-transparency and increased-contrast preferences restore an opaque
  surface and remove both modal and backdrop blur.
- All 40 Node tests, TypeScript, Vite, and macOS release packaging passed. The
  staged app passed strict ad-hoc signature verification; the previous bundle
  remains available for rollback and the running app was not restarted.


## Frosted right sidebar — 2026-09-16

- The right inspector shares the left sidebar's translucent material and 24px
  blur. Its header, tabs, commit field, file previews, diff canvas, and browser
  controls let the wallpaper show through without additional blur layers.
  Navigated browser pages retain their own opaque surface.
- Chrome screenshots verified both themes over a bright wallpaper. Two focused
  checks passed in each of Chrome and WebKit, covering matching sidebar
  materials, Changes/Files/Browser navigation, transparent diff/code surfaces,
  narrow windows, guest content, and the high-contrast fallback.
- All 19 existing wallpaper and changed-files WebKit tests passed. Wallpaper
  disabling and accessibility preferences retain solid surfaces; no app state,
  rendering logic, or dependencies changed.
- All 40 Node tests, TypeScript, Vite, and macOS release packaging passed. The
  staged app passed strict ad-hoc signature verification; the prior bundle is
  retained for rollback and the running app was left open.

## Launcher, moodboards, and new providers — 2026-09-16

- The full native suite passed 411 tests with five opt-in discovery tests ignored.
  A subsequent regression for preserving saved team effort when launching from
  the overlay passed with all seven overlay tests. All 40 Node tests and the
  production TypeScript/Vite build passed.
- All 15 new browser cases passed in Chrome and WebKit across focused runs:
  launcher actions, keyboard recording/persistence, moodboard CRUD and send
  failure recovery, provider connections, and preserving settings drafts during
  delayed loads/saves. The existing UI/architect/profile/concurrency/slash/streaming
  regression run passed 168 cases; its nine stale catalog/menu/diff assertions
  were updated to the current UI and all nine passed on rerun.
- Moodboards were visually checked in light/dark themes and at narrow width with
  enlarged text. The launcher was checked at its minimum size. Both are loaded
  on demand, and the launcher does not import the full workspace.
- Installed OpenCode 1.18.30 confirmed ACP, image, HTTP MCP, session-resume, and
  configuration-option discovery. GLM credential isolation and provider streaming,
  approvals, resumption, and image transport were verified with deterministic
  protocol tests. Antigravity's official ACP executable was not installed locally;
  its adapter is protocol-tested. No paid provider inference was used.
- A separate native bundle (`dev.pandacode.overlay-smoke`) built and stayed running
  without startup errors in a direct launch. Native UI automation stalled before
  keyboard/window checks, so global-hotkey and focus behavior still needs an
  interactive macOS check. The isolated test process was closed afterward.
- The refreshed macOS release bundle and ZIP were staged, and strict ad-hoc
  signature verification passed. The previous bundle is retained for rollback;
  existing application data and user processes were not replaced or restarted.

## Active agents in the quick overlay — 2026-09-16

- The overlay now lists live tasks, architect workers, and provider subagents.
  Waiting-for-approval agents remain visible, and a coordinating architect is
  included while its workers run. Idle/completed/stopped history and stale
  persisted statuses are excluded. The count matches the displayed entries.
- Polling copies only bounded labels/status/IDs, never child responses or tool
  output. The live registry establishes liveness; active children are not cut off
  by the previous 24-item recent-history limit. Ownership is checked before a
  click opens the correct task, worker, or subagent response.
- Twelve native overlay tests and nine subagent-state tests passed. Nine overlay
  browser cases and six worker/subagent navigation cases passed in each of Chrome
  and WebKit. These cover completed-entry removal, stable sibling DOM, empty
  state, correct response selection, live updates, and both workspace views.
- All 37 architect/subagent browser regression cases passed in Chrome, and all
  40 Node tests passed. TypeScript checking and the production frontend build
  passed.
- The macOS release build passed, and the refreshed app and ZIP were staged with
  strict ad-hoc signature verification. The prior app bundle remains available
  for rollback; the user's running app was not restarted.

## Conversations inside the quick overlay — 2026-09-16

- Clicking an active task, worker, or subagent now reads its conversation inside
  the launcher window. Only the explicit Open in app control shows the workspace.
  Back/Escape returns to the active list; completed work remains readable in the
  selected reader. The original shortcut and window behavior are unchanged.
- The reader loads lazily, reuses sanitized streaming Markdown, keeps the latest
  response visible during tools, and retains compact expandable tool details.
  It loads older history automatically and limits retained messages to 300.
- The read-only native snapshot shares the existing bounded assistant buffer.
  Stream events coalesce into at most five selected-thread reads per second;
  unchanged database revisions skip retransmitting history. Hidden readers do
  no polling, and delayed reads cannot replace another selection or newer text.
- All 30 overlay browser checks passed (15 each in Chrome and WebKit), including
  inline navigation, explicit-only workspace opening, live responses, completion,
  delayed reads, keyboard navigation, collapsed-history pagination, and narrow
  window layout. The 490 × 410 conversation screenshot was visually checked.
- Native overlay tests (18), concurrent-agent regressions (16), stream settlement
  checks (6), all 40 Node tests, and the production frontend build passed.
- The release app and ZIP were rebuilt and staged with strict ad-hoc signature
  verification. The previous bundle was retained; no running app was restarted.

## Harness and model selection in the quick overlay — 2026-09-16

- The launcher composer now opens the shared searchable harness/model picker,
  with provider logos, discovered model names, and unavailable harness states.
  The catalog and picker load on demand without importing the workspace.
- An explicit selection persists across restarts and workspace task changes.
  Older preferences remain compatible; delayed snapshots and catalog responses
  cannot overwrite a newer choice. Launch waits for pending saves, and failed
  saves preserve the previous selection.
- New tasks use the selected harness and model. For saved teams, the choice
  applies to the new architect while preserving workers and saved profiles.
  Invalid configurations roll back task creation.
- All 48 overlay browser checks passed (24 each in Chromium and WebKit), along
  with three main-workspace picker regressions, 24 native overlay tests, and all
  40 Node tests. TypeScript checking and the production build passed.
- The settled picker was visually checked at the minimum 490 × 410 window size.
  Keyboard dismissal and clicking the trigger again both close it cleanly.
- The macOS release app and ZIP were rebuilt and staged with strict ad-hoc
  signature verification. The prior bundle remains available for rollback;
  no running app was restarted and no paid provider inference was used.

## Astro landing page — 2026-09-16

- Added an independent Astro 7 static site under `website/`, leaving the native
  app's Vite entry and dependencies intact. It uses existing original scenery,
  system fonts, provider assets, and HTML product mockups rendered at build time.
- Scroll chapters reveal conversation, board, team, and review scenes. Model
  selection, task peeks, worker updates, diff layouts, quick-overlay threads, and
  wallpaper choices are interactive local examples, explicitly labeled previews.
  Native scrolling is preserved; there is no continuous animation loop.
- The production build passed. Its JavaScript is 7,999 bytes / 2,606 gzip, and
  CSS is 30,216 bytes / 7,527 gzip: 10,133 compressed bytes combined. HTML is
  6,759 gzip bytes. There are no external runtime scripts, fonts, or requests.
  Observed image/logo requests across the page totaled 392,249 bytes on desktop
  and 142,655 bytes on mobile. These are asset measurements, not network latency
  or whole-app memory claims.
- The final Playwright run passed all 48 checks in 33.6 seconds across Chrome
  and WebKit, desktop/mobile, and reduced-motion settings. Tests cover native
  scroll progression, manual scene controls, keyboard focus/dismissal, menus,
  task/worker/diff previews, quick threads, scenery changes, no-JS content, and
  ZIP/checksum integrity. No console errors, warnings, missing assets, or page
  horizontal overflow were found. Desktop and mobile screenshots were reviewed.
- Fixed scroll anchoring that could undo manual scene selections, keyboard
  scroll resumption, exact originating-task focus on overlay dismissal, missing
  heading labels, a missing icon, and low-contrast small text.
- The current 8,706,683-byte Apple silicon macOS preview is copied during the
  build with a generated SHA-256 checksum. The page states its unnotarized preview
  status and provider prerequisites. The static output includes Cloudflare
  cache/security headers, canonical metadata, sitemap, robots.txt, and a 404.
- Packaged `release/PandaCode-website.zip` for direct upload. No Cloudflare account
  was connected, so no public deployment or domain/DNS change was made.

## Conversation memory and overlay refresh — 2026-09-18

- Measured the native `Store.message_page` path using an 8 MiB saved assistant
  reply over 30 local debug-build iterations. The returned 128 KiB preview had
  retained an 8,388,608-byte String allocation. Bounding the SQLite read before
  conversion reduced capacity to 131,076 bytes; median read time changed from
  743 to 370 microseconds (p95 1,284 to 861 microseconds). These are buffer and
  local fixture timings, not whole-app memory or typical-response claims.
- Assistant previews preserve embedded NUL, Unicode, empty responses, exact
  size limits, full stored content, and pagination. Structured tool records and
  coordination envelopes use their existing decoding paths. Regression tests
  cover oversized ASCII/Unicode replies and older-page continuity.
- Measured 200 overlay `load()` calls with 300 cached messages and cloned,
  unchanged native-style snapshots. Mean frontend refresh work fell from
  0.510 to 0.0015 ms, and transcript DOM mutations from 450 to zero per refresh.
  This fixture excludes native IPC latency. Changed text, status, history,
  error recovery, older pages and subagents still render normally.
- Validation: 475 native tests passed (6 ignored), strict Clippy, 42 frontend
  unit tests, all 29 Chromium overlay tests and three focused WebKit regressions
  passed. TypeScript, production build, changed-file formatting and diff checks
  passed. No paid model inference was used.

## Interface localization (en-US, en-GB, 简体中文, 繁體中文, October 2026)

- Wrapped ~2,900 user-visible desktop strings (workspace shell, settings family,
  provider/cloud/github/bots/jev/vm panels, inspector panels, quick launcher,
  menu bar popover) and ~210 mobile strings behind the catalogs. English output
  is byte-identical to before: the whole existing Playwright suite passes
  unchanged in en-US.
- Language preference defaults to the system language (zh-Hans/zh-Hant-HK/
  zh-Hant-TW/en-GB/en-US mapping) with an override in Settings → General and the
  mobile Settings tab; the native tray menu and launcher title follow the
  persisted `ui-language.json` so they open in the chosen language.
- Validation: desktop `tsc`, 147 Node unit tests (including the seven-case i18n
  guardrail: catalog completeness, placeholder signatures, source coverage scan,
  locale mapping, `t()` substitution), the six-case `tests/language.spec.ts`
  (default/override/reload/auto-detect/en-GB spelling), the full Playwright
  chromium suite (842 passed), the WebKit run (646 passed, 1 standard skip),
  `cargo test` (1,322 passed, 53 standard live-test ignores), production build
  (locale catalogs are lazy chunks; the 80 KiB entry budget holds), and mobile
  `tsc`/39 unit tests (including desktop-mapping parity)/`expo lint`.
  Terminology and generation notes in
  [src/locales/GLOSSARY.md](../src/locales/GLOSSARY.md).
- Follow-up: stable Rust error strings (838 sentence-like `Err` literals)
  translate through `tBackend()` at the toast boundary; PandaCode's own slash
  command descriptions render translated; the bots web chat page resolves its
  locale from `Accept-Language` and ships per-locale string tables. The i18n
  guardrail scans `src-tauri/src` for both literal sets.
