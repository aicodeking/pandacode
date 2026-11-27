# Reference research

PandaCode is an original implementation. T3 Code source and documentation were inspected for product requirements, system boundaries and tradeoffs; no implementation, assets or layouts were copied.

## AI techniques survey (2026-11)

Seven area reports and a synthesis live in [research/ai-techniques/](research/ai-techniques/00-README.md): agent orchestration and test-time compute, context engineering and memory, verification and reliability, the model/routing layer, interfaces and computer use, evaluation and self-learning, and agent security. Each names only techniques with published or shipped evidence, ties every proposal to a real PandaCode surface with a cost and an acceptance signal, and lists what it rejected and why. Start with the synthesis: it merges the seven ranked shortlists into one table, splits the work into four delivery waves, separates enhancements from genuinely new features, and carries the merged do-not-build list. Treat them as proposals, not commitments — nothing there is implemented beyond what the synthesis' first-PR section describes.

## T3 Code

- [Architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md): Electron desktop shell, React renderer, Node/Effect server; execution and storage belong to the server.
- [Threads](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md): projects, persistent parallel tasks, worktrees, archive and navigation.
- [Composer](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md): provider/model choice and file context.
- [Permissions](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md): providers expose different capabilities; permission display labels must not substitute for protocol IDs.
- [Source control](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md): Git review and actions.
- [Connection runtime](https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md): T3 already loads selectively and evicts inactive transcript caches. Its [terminal](https://github.com/pingdotgg/t3code/blob/main/docs/user/terminal.md) is also bounded.

## Architectural decision

[Tauri's process model](https://v2.tauri.app/concept/process-model/) provides a Rust core and platform WebView. This avoids shipping an application-specific Chromium runtime and removes the requirement for a resident Node server. The OS still launches WebView helper processes, and provider CLI processes can dominate total memory. A smaller native core or installer alone is not a whole-app memory benchmark.

PandaCode deliberately uses one webview, a small vanilla TypeScript renderer, direct native IPC, on-demand agents, SQLite, one-directory-at-a-time file browsing, selected-file diff reads and lazy terminal code. It does not embed a general code editor. Core, renderer and child-agent measurements must be reported separately.

## Initial parity boundary

Working local projects, threads, provider chat, tool streams, approval prompts, stop/resume, file context, Git status/diff/stage/commit, worktrees and terminal form the initial scope. Remote connections, mobile, image attachments, voice, built-in PR creation/review stacks, checkpoints/rollback, cloud task execution, inline code editing, provider account pooling and automatic updates are follow-up work.
