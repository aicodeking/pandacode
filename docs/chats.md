# Projectless chats

A chat is a conversation that is not about a codebase: questions, research, writing, or trying a plugin or skill.

- Start one with **New chat** in the sidebar, **New chat (no project)** in Go to anything (⌘K), or **No project** in a new task's project picker.
- Each chat gets its own folder, `~/PandaCode Chats/chat-<id>/`, so files from different chats stay apart. User-level config (`~/.claude/CLAUDE.md`, user plugins and skills) still loads; there is no project config.
- Chats are listed in the sidebar's **Chats** section, apart from project folders, with the usual rename, pin, settle and delete. The project bar, Deploy and Run Script are hidden, and the agent is not told about `pandacode-run.sh`.
- An empty chat can **Move to project…**, which uses the same in-place project switch as an empty task.
- Deleting a chat (or moving it to a project) forgets its hidden project. Its folder is removed only when nothing but PandaCode's own files (`.pandacode`, `.DS_Store`) is left in it.

## Implementation

- Native: `src-tauri/src/chats.rs`. `chat_create` makes the folder, registers it as a project named "Chat" and creates the task; `chat_cleanup` drops the project once no task uses it. A project is a chat when its folder sits directly in the chats root, so no schema change was needed. `app_instructions(chat)` in `lib.rs` leaves out the run script for chat folders.
- Window: `src/chats.ts` (`isChatProject`, matching the folder name), with the sidebar group, header, welcome and picker hooks in `src/main.ts`. `userProjects()` excludes chats. Preview mocks are in `src/preview.ts`; tests in `tests/chats.spec.ts`.
