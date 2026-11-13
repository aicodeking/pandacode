# Terminal presentation v1

Design decision: `panda.terminal` accepts a selected closed `tabs-below` recipe.
It reorders the original host tab strip, not the PTY surface. A new renderer,
package-owned shell, PID dispatch and copied terminal buffers were rejected:
none preserves the original controller, approval and launch policy.

State captures a panel context, opaque group handle, project, optional session,
revision, selected/focused tab handles, visibility and bounded tab metadata.
Actions repeat that capture with a unique request ID and one of new/select/close/
minimize. New launches only the original ordinary terminal, with no command,
provider or executable argument. Close uses the original activity/consent flow;
it never bypasses running-process confirmation. Content and input are not granted
by UI consent: this contract exposes neither output nor write/execute APIs.

The selected enabled owner requires `ui.contribute`; dispose, disable, fault,
unsupported capability/version and safe mode revoke dispatch. Stale/foreign
captures, unknown tabs, replay and pending dispatch are rejected. Hiding controls
is presentation only. State reads resynchronize after revisions; there is no
public incremental terminal-output stream. Original native exit events advance
the revision. The host retains all groups, controllers, PTYs and jobs throughout
recipe, visibility and compatible T30 placement changes.

`panda.terminal.controls` exposes new/minimize and per-tab select/close visibility
and order. `panda.terminal.actions` and `panda.terminal.context` accept ordinary
declarative commands, with captured project/session and selected opaque tab only.
No public selector, DOM, native terminal ID, process ID or shell interpolation.
Keyboard tab navigation and close-dialog Escape/focus remain original handlers.
Fallback restores those same nodes, not a remounted terminal. Browser preview
continuity is synthetic; native library tests are separate evidence, not installed
WebView2/WKWebView/Linux drag/window qualification (deferred outside this run).
 
Limits: 1,000 tabs per eligible current group, 128-character request IDs, and
4,096 admitted request IDs per panel lifetime (exhaustion revokes further public
dispatch, never core controls). No original unbounded output is serialized.
Project-only groups use an empty session. Other tasks' groups remain private and
continue running; switching back restores their original selection and visibility.
The main-window panel owns its subscriptions for that window lifetime; package
activation subscriptions and contributed menu/action registrations dispose through
the existing manager. UI movement does not create a second panel instance.
