# Simulator presentation v1

The explicitly selected `panda.simulator` component uses the closed
`controls-first` recipe with `host-device`, `host-input`, `host-frames` and
`original-actions`. It moves the original dock before the original stage; it
does not remount a device, change selection, restart frames or own connections.
No provider is selected by installation or by conflict resolution.

Design decision: reuse ComponentSlot selection, shared catalog/layout/action
locations and captured JSON admission. Reject arbitrary IPC, selector/click
adapters and package-owned frame/input controllers: they bypass identity and
lifetime validation. Reject a toolbar-only API: the recipe also supplies bounded
state, capability reasons, original structured actions and recovery semantics.

`SimulatorPresentation` captures context, project, session, opaque selected
device, platform and revision. At most 64 devices are listed; `truncated` requires
host selection for any omitted device. Names/runtime require the independently
declared `projects.summary` metadata grant; opaque handles alone reveal no UDID.
No screenshot, clipboard, install command, screen content, gesture or typing
endpoint is granted. Device content remains host-only, even with metadata consent.

Actions carry the same captured identity/revision plus a bounded request ID,
control ID and value. Device handles, pose and finish values must come from the
current snapshot. Foreign/stale, unsupported, revoked, busy, duplicate and invalid
requests return explicit reasons. The host validates current authority on every
dispatch; visibility is not authority. State is immutable and resynchronized by
reading a new snapshot after revision changes; no incremental stream is exposed.

Controls: device, pose, finish, appearance, power, back, recents, reset, home,
lock, capture, copy-axe, add-duo and android-setup. Their platform/readiness reasons
are data, not missing-implementation exceptions. Windows/Linux Android setup
retains the Android Studio instructions; iOS/Duo/AXe require macOS/Xcode.
Clipboard and setup/create effects open a host-owned explicit confirmation menu
and only its user choice calls the original handler. Packages cannot approve it.
Downloading is never an activation effect. Extension actions/context contributions
are ordinary public declarative commands, not a new device service.

`panda.simulator.controls`, `.actions` and `.context` use existing visibility,
ordering and selected layout policies. Menus preserve original applicability.
Compatible movement is only dock-before-stage; arbitrary device relocation is
unsupported. Disable, fault and safe mode restore the same nodes and original
handlers. Pending host work is not cancelled by presentation changes. Native
schema/package evidence, synthetic browser controller evidence and real device
qualification must be reported separately; installed/device qualification is
deferred, not passed.
