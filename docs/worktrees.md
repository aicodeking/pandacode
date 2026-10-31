# Worktrees

Every task shows a context bar above the prompt: the project, whether the task
works in the main checkout (**Local**) or its own **Worktree**, the current
branch, and any linked GitHub work. The branch chip is the one place to act on
branches and worktrees; the task menu, the inspector's Changes tab, the command
palette, and the `/worktree` command open the same dialogs. The statusbar names
the checkout folder and copies its path.

## Creating a worktree

Open the branch chip. A task that has not started yet offers **Work in a new
worktree…**: the same task moves into an isolated checkout, keeping its draft,
title, harness, model, and permission mode. A task with history offers **New
task in a worktree…**, which starts a sibling task in the same project with the
current harness and model and the default permission mode.

The dialog suggests a branch name from the task title, the draft, or a linked
issue (`128-search-index-rebuilds`), shows the final name (`pandacode/<name>`;
`pandacode/`, `kingcode/`, and `codex/` prefixes are kept as typed) and its
folder, and lets you start from any local branch instead of the current one. If
the branch already exists, the dialog says so and offers to check it out into
the new worktree instead of creating it. Names use letters, numbers, hyphens,
underscores, and slashes, never `..`.

Worktrees live beside the project as `<project>-worktrees/<branch-with-dashes>`.
The task's agent, terminal, Files and Changes tabs, and file mentions all use
that checkout. A worktree task stays in its project; its branch is stored with
the task so chips and recovery never need Git.

## Cleaning up

Settling a worktree task checks the checkout first. A clean
checkout can be removed together with its branch in the same step (the branch
is deleted only when it is merged into the main checkout; otherwise it is kept
and the dialog says so). Commits that are neither pushed nor merged leave the
removal unchecked by default. A checkout with uncommitted changes is never
removed; the dialog names the count and the task is settled on its own.
**Remove worktree…** in the chip menu uses the same guard and settles the task.
Removal runs `git worktree remove` without `--force`, then `git worktree prune`.

## When the folder is gone

If a worktree folder disappears, the chip reads **Worktree missing**. The menu
offers **Recreate worktree**, which prunes the stale registration and checks the
stored branch out at the same path, or **Settle task**, which keeps the history
and forgets the checkout.

## Native behavior

`create_worktree` and `attach_worktree` validate the branch, verify the start
point, refuse duplicates and missing branches, and run `git worktree add` from
the task's checkout. `worktree_status` reports existence, uncommitted changes,
upstream and ahead counts, and whether the branch is merged into the main
checkout. `remove_worktree`, `recreate_worktree`, and `git_branches` complete the
lifecycle. All Git calls use argument arrays, a null stdin, bounded output, and
timeouts; nothing is forced.
