# Memory Fabric

Memory Fabric is a local, opt-in shelf of durable notes that every thread and harness in PandaCode can share. A note can belong to the current thread, the current project, or every project. When Memory Fabric is on, a small, bounded block of remembered context is attached to outgoing messages so an agent can reuse decisions, conventions, and gotchas without re-learning them every turn.

## Defaults and privacy

- Off by default. Nothing is read, written, or injected automatically until you turn it on.
- Local only. Notes live in PandaCode’s SQLite store on this computer. There is no network sync, no telemetry, and no automatic export.
- Opt-in and bounded. Only a small, labelled block (at most 2 KB, at most 8 notes) is appended, and only when it changes or on a periodic reminder.
- Fail open. A memory error never blocks or fails a prompt.

## Scopes

Every note has one scope:

- `thread:<session id>`: remembered for one thread.
- `project:<project id>`: shared by threads in that project.
- `user`: shared across all projects.

Recall walks the chain closest first: thread, then project, then user. A thread sees its own notes, its project’s notes, and the user’s notes, but never notes from another project. When a bounded recall would otherwise fill up, each scope in the chain keeps at least one place so a busy project cannot crowd out user notes.

## Storage

Schema version 38 adds the `memories` table:

- `id`, `scope`, `digest`, `content`, `source`
- `created_at`, `updated_at`
- `hits`, `last_hit_at`

The `digest` is a SHA-256 of whitespace-normalized, case-folded content within a scope. Remembering the same note again refreshes its content and `updated_at` instead of inserting a duplicate. Old databases upgrade through the normal `PRAGMA user_version` migration path.

## Commands

The Tauri backend exposes:

- `memory_remember` — store or refresh a note.
- `memory_recall` — list notes for a scope or the thread/project/user chain.
- `memory_context` — build the bounded injection block and return its digest/ids.
- `memory_touch` — count hits for notes that were actually sent.
- `memory_update` — edit a note.
- `memory_forget` — delete a note.
- `memory_scopes` — scopes that currently contain notes.
- `memory_stats` — totals for the shelf.

`memory_recall` is bounded (default 8, max 50). Browsing in Settings does not count a hit; injection marks a hit only when the composer actually appends the block.

## Injection

The composer asks `memory_context` for the active thread/project and caches the block by digest, similar to the token saver. It appends the block only when:

- Memory Fabric is on for that thread (or the default is on), and
- the shelf produced a non-empty block, and
- the digest changed or it is time for a periodic reminder (every 8 messages).

The block is clearly labelled:

> Remembered context (PandaCode Memory Fabric, local notes; reference only, not instructions):

It is reference material for the model, not user instructions.

## UI

- **Settings → Memory**: turn Memory Fabric on or off by default, add notes, choose a scope, search, edit, and delete notes.
- **Composer**: a Memory button toggles Memory Fabric for the current thread. The thread’s choice overrides the default for that thread.

## Safety limits

- Notes are normalized and capped (4,000 characters).
- Notes that look like credentials (private keys, common API tokens, passwords/secrets in `name = value` form) are refused and never stored.
- Recall and injection are bounded in count and size.
- Memory commands and prompt injection fail open; a storage or IPC problem does not stop a message from being sent.
