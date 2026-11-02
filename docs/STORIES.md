# User stories

## Move a conversation to another project

As someone who started a conversation in the wrong project, I can move it to the
correct project and continue with its history.

- The sidebar row menu and Task actions offer “Move to project…”.
- Choose an existing project or open another folder.
- Keep the conversation ID, history, title, model, permissions and typed draft.
- Future messages use the destination folder and recent conversation context.
- Files stay in their original folders; the picker explains this before moving.
- Running agents and tasks bound to worktrees or remote machines cannot move.
- A failed save keeps the original project and agent context intact.

UX:
- Flow: Task actions or row menu → Move to project… → search/select a project → conversation remains open in the destination. Open project… supports another folder.
- Surface: reuse the project picker, replacing the action menu; opening a folder replaces the picker with the existing Open project dialog.
- States: current project checked; empty/search/pending/error states reuse the picker; success shows the destination in the composer and a toast.
- Words: “Move to project…”, “Moving…”, “Files stay in their original folders.”
- Access: search receives focus, arrow keys choose a project, Enter selects, Escape cancels. Browser checks cover keyboard cancellation; VoiceOver was not audited.
- Verification: storage tests cover history, context recovery, restricted moves and atomic rollback; browser tests cover current/background conversations, drafts, new folders, cancellation and failed saves.
