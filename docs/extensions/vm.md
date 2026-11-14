# VM presentation v1

The explicitly selected `panda.vm` `controls-first` recipe requires
`host-machine`, `host-input`, `host-frames`, and `original-actions`. It moves the
original dock before the original stage; it never recreates the canvas, connection,
frame pump or serialized input controller. Arbitrary renderers and generic IPC are
not supported. A toolbar-only wrapper was rejected: the contract also captures
state, machine/connection identity and original-policy action admission.

`vmPresentation` and `vmAction` are bounded JSON-only schema v1 records. Actions
capture context, project, session, opaque machine and connection, platform and
revision. The host rejects stale identity, replay, unavailable controls, wrong
owner, revoked selection and missing UI grant. Names and descriptive metadata
require the independent `projects.summary` declaration; no paths, credentials,
frame bytes or raw input are public. Input means focus the original input stage,
not send arbitrary machine events. Share changes only the existing read-only
start preference; no writable share is expressible.

Select, power, suspend and desktop use original handlers. New, delete, setup and
share requests require an explicit host user choice before their original handler;
extensions cannot provision on activation or accept that choice themselves.
Selection and approvals capture their original target and project; a later switch
expires them rather than retargeting. Host work already accepted is not restarted
or cancelled by presentation disable/fault/recovery.

`panda.vm.controls`, `.actions` and `.context` reuse catalog, layout and declarative
action machinery. Compatible movement is dock-before-stage and sibling control
ordering only; setup/create/delete remain in their original contextual anchors.
Visibility never grants an operation. Disable, malformed/conflicting providers,
fault and safe mode restore the original nodes and handlers. Local VM support
remains Apple silicon/macOS; the existing macOS inspector gate is unchanged.
Browser fixtures prove synthetic controller behavior, not actual virtualization,
cloud provisioning or installed cross-platform qualification (deferred separately).
