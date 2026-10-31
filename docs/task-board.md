# Project board

PandaCode offers Conversation and Board views, remembered on this device. Both
views use the same tasks, provider sessions, worktrees, approvals and messages.
The view toggle is borderless and shares the sidebar's frosted material over wallpapers.
Board view fills the window without a sidebar. Its header provides project
filtering and opening projects; Conversation restores the sidebar.
The board follows the project filter and opens one task at a time in a right
panel. It reuses the conversation renderer instead of loading every transcript.

Tasks have four durable stages: Pending, In progress, Review and Settled
(stored as `completed`).
Adding a title and description queues a task without starting an agent. Start
sends the saved description with the task's selected harness, model and approval
policy. An accepted run enters In progress; success enters Review. Errors and
stops remain In progress, with a retry action. Follow-up messages from Review
start another run. The user settles reviewed work or reopens it.

There is no archive: settled tasks stay on the board and in the sidebar's
Settled section. A task still marked archived by older data counts as settled,
and reopening it clears that flag. Reopening clears completion time. No Git
commit or merge is implied by settling.

The board has four compact columns, quiet stage colors and provider/worktree
icons. Rounded task cards share the sidebar and thread panel's frosted material
when wallpapers are enabled. The right panel presents task details followed by comments from the user
and agent, with existing tool disclosures and composer controls. It can close
without stopping work. On narrow windows it overlays the board, with a visible
close control. With wallpapers enabled, the panel matches the sidebar's translucent
tint and backdrop blur. Both layouts have rounded corners and a small inset, with
no left divider or heavy shadow. Increased contrast or reduced
transparency restores a solid surface. Existing conversations remain available
through the view switch.

Verification covers queued-task persistence, guarded starts, successful and
failed runs, settling/reopening, migration, preserved
drafts, light/dark layouts and keyboard access. Board cards update on metadata
changes, not on every streamed token.

The task list includes only 512 characters of each description. Full details
are fetched for the selected task and released when selecting another task;
Start reads the complete description from storage. A late metadata refresh
cannot replace those details with the short card preview. Editing is unavailable
until details have loaded, and a canceled, delayed creation never changes the
current selection.

Reopen returns a settled task to Review and clears completion time; a new reply
starts work again.
