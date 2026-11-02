# GitHub

PandaCode talks to GitHub through the GitHub CLI you already use. It stores no
tokens and asks for no sign-in of its own: when `gh` is installed and signed in,
issues and pull requests become available in the prompt, on the board, and from
the branch chip. **Settings → GitHub** shows the connection for the current
project (CLI missing, not signed in with the exact `gh auth login` hint, or
connected as *you* with the repository and its default branch) and has one
switch. Off means no `gh` process runs and no GitHub control appears. Projects
whose remote is not on GitHub simply show nothing.

A project can also pin one GitHub account of its own. When more than one account
is signed in to `gh`, the GitHub view's header shows a chip listing every one of
them, and the account you pick is the one that project's issues, pull requests
and searches run as. The pin stores a login only: each call resolves that
account's token from your own `gh` keyring and hands it to the one `gh` process
it starts, so PandaCode still stores no tokens. Repository listings in the
GitHub view keep using `gh`'s active account.

## GitHub view

The header's **GitHub** view (beside Conversation and Board) lists the repositories your
`gh` account can reach: your own, collaborations and organizations, most recently pushed
first, with a dot on those checked out on this computer (matched by each project's
`origin` remote). Choosing one shows three tabs:

- **Threads**: the repository's tasks, and a box to start a new one.
- **Pull requests**: open pull requests with review state, checks and size. **Review**
  starts a thread that checks the pull request out and reviews it; the menu also offers
  Open in thread, Fix failing checks, Address review comments and Merge when ready (which
  merges only when checks pass, it's approved and it merges cleanly).
- **Issues**: open issues. **Solve** starts a thread that fixes the issue on a branch;
  **Open in thread** opens one with the prompt ready for you to finish.

Every thread started here is an ordinary task, linked to its pull request or issue, and its
prompt mentions `#123` so the item's content is attached as GitHub context. A row whose
item already has a thread offers **Thread** to go back to it. A repository that is only on
GitHub can be browsed and cloned into a folder you choose; it then opens as a project.
Nothing is sent to GitHub except through `gh` and the agents you start.

## Mentions

Type `@` in the prompt to search project files and, when connected, open issues
and pull requests (`@keyboard`, `@128`). Choosing one inserts `#128`, GitHub's
own notation, as ordinary editable text. When the message is sent, every `#123`
in it (picked or typed, up to five) is resolved once and appended as a
`GitHub context:` block with the title, state, author, labels, URL, and a body
excerpt of up to 4 KiB. The block is labeled repository content, not
instructions, and travels with the message so every harness reads the same
thing. References that do not resolve are left as typed.

## Importing issues

In Board view, **Import from GitHub** lists up to fifty open issues with their
labels. Filter by *Assigned to me*, a label, or a search. Selected issues become
**Pending** tasks in the board's project: the issue title, its body followed by
the issue URL, the default harness, and full access. Nothing runs until you start
a task. Issues already linked to a task in that project are marked *On board*
and cannot be imported twice; if the linked task has not started and the issue
changed, **Update task** refreshes its title and description in place. Import is
a one-shot action with no background synchronization.

## Linked work

A task can carry one issue and one pull request. Cards, the task header, and the
context bar show chips (`#128 · open`, `PR #45 · merged`) that open GitHub.
States refresh in one batched GraphQL call per project when the window regains
focus, at most every five minutes, and only for projects with linked tasks.

## Pull requests

**Push & open pull request…** in the branch chip menu pushes the task's branch
with `git push --set-upstream` and runs `gh pr create` against the default
branch (or another base you choose). The title comes from the task, the
description from its description plus `Closes #128` when an issue is linked.
Uncommitted changes stop the action with a pointer to the Changes tab; so does
being on the base branch. The new pull request is linked to the task.

## Native behavior

`github.rs` runs `gh` with argument arrays, `--flag=value` for user text, a null
stdin, prompts disabled, a 2 MiB output limit, and timeouts. `github_status`,
`github_search`, `github_issues`, `github_resolve`, `github_refresh_links`,
`github_create_pull_request`, `set_task_link`, and the account-pin pair
`github_accounts`/`github_set_account` are the only commands; links live in the
`task_links` table beside the task.
