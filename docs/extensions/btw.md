# BTW presentation v1 (experimental)

Design decision: use an explicitly selected `panda.btw` `composer-first` closed
host recipe, not a package-owned editor or a copy of the main composer. The
original header, transcript, approvals, queue, textarea and stream controllers
remain mounted. Compatible movement changes their visual order only. Shared
`panda.thread.message.actions` continues to own saved/live message accessories;
this is not by itself whole-panel support.

Reject arbitrary markup/selectors/IPC and main-composer delegation: a delayed
side action must never resolve its target from the currently selected main task.
The host captures window, project, main task, side task and revision together.
Only host-issued opaque identities are public. Presentation metadata contains
counts/flags and bounded message handles, not transcript, draft or attachments.
Declare `btw.content` and/or `btw.taskControl`, then use the protected host permission
buttons shown beside the selected recipe to explicitly allow each independently.
Installation, enable and recipe selection alone grant neither. Consent is scoped
to this launch, owner/version/activation and captured project (not persisted).
Revoke takes effect immediately; changing activation, disabling or safe mode
requires new consent. Insertion needs both grants, while
send/queue/steer/Stop need task-control. Approvals and permission mode remain
protected core actions and cannot be dispatched by the recipe.

Actions carry the captured identities, revision, request ID and optional message
handle. Original send/queue/steer/model/header/insertion handlers execute them;
revision changes, foreign resources, owner changes, grant revocation, disposal,
replays and pending sends reject with stable reasons. No extension text payload
can overwrite a draft or answer an approval. Insertion appends only a captured
side answer to the captured main draft and never sends it.

Host-user visibility/order applies to compatible sibling header, toolbar, queue
and message controls. Essential Stop and approval controls are not suppressible.
Disable, conflict, fault and safe mode restore built-in presentation without
changing business IDs or deleting stored choices. Main/side switches save each
host draft independently; stale async completions cannot repaint another side.

Qualification: automated Node/schema/native-package and headless browser evidence
is separate from installed Windows/Linux and actual native IME qualification,
which remain deferred. This v1 does not add side attachment authoring (the
original BTW composer explicitly does not support attachments); main attachments
remain owned by the main composer.
