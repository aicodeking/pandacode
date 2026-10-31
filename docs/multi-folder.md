# Multi-folder projects

A project can hold several folders, so one task works across a backend, a frontend and shared libraries at once (issue #213). Every folder belongs to at most one project; one folder is the primary.

## What a folder is

- Any folder can be attached. Git features (worktrees, branch state, pull requests) light up per folder that contains a repository; plain folders are context only.
- The primary folder is where the task's working directory, `pandacode-run.sh`, Deploy and the terminal live. It is mirrored into the project's path, so single-folder projects behave exactly as before.
- Folders are managed in Settings → Projects (add, remove, make primary). The last folder cannot be removed; removing the primary promotes the next folder.

## What a task sees

- The agent runs with the primary folder as its working directory. The other folders reach the harness natively where it supports them (`--add-dir` for Claude-family CLIs, the sandbox `writableRoots` for Codex, `additionalDirectories` for ZCode and, when the server advertises it, ACP), and every harness also gets a note with each folder's absolute path.
- Path rules: the primary folder is addressed with project-relative paths as always; other folders are addressed with `label/relative` paths or absolute paths. Labels are folder basenames, disambiguated as `parent/name` when two folders share a basename.
- A worktree task creates one worktree per git folder, all on the same branch name, each beside its own folder. A folder whose worktree cannot be created does not stop the task; the failure is reported in the branch menu. Non-git folders are used in place.
- Turn-change tracking and `pandacode_track_files` cover every folder; files outside the primary are reported as `label/relative`.

## Git and GitHub per repository

- The inspector's Changes view groups by repository (branch, ahead/behind, files) and stage, commit and push act on one repository at a time.
- The branch chip shows the primary branch plus a repository count; its menu lists each repository's state, and merge/remove report per-repo results.
- Pull requests are per repository: creation picks the repository, automatic detection links a PR to the repository whose branch it is on, and the PR tab lists every linked PR. An open link is never replaced, per repository.

## Limits

- Remote mirrors and cloud agents refuse multi-folder projects until they learn to sync several repositories.
- `attach_worktree` attaches to the primary repository only.
- The mobile app shows the primary repository's changes and PR.
