# Exact-resource project reads (experimental)

The fixed **Project context inspector** action supports additional host-rendered controls. Installation,
enable and `projects.summary` grant **no paths, metadata, content or Git access**. The installable
`tests/fixtures/extensions/project-reads/extension.json` declares each independent capability:

| Capability | Resource | User-selected scope / result |
|---|---|---|
| `projects.files.metadata` | `metadata` | One exact relative file; relative path, byte count, kind only |
| `projects.files.read` | `file` | One exact relative file; UTF-8 text only |
| `projects.git.read` | `git` | `.`; local `.git/HEAD` branch or detached commit only |

Host requests use the existing native `extensions_context` dispatcher and opaque captured handle:
`{op:'readConsent', handle, capability, path, allow}` and
`{op:'read', handle, resource, path, cursor?, revision?}`. No project ID, extension identity, absolute
root, environment, raw bridge, Git arguments or mutation operation is accepted. These are fixed
declarative host controls, **not** an executable SDK or a sandbox qualification claim.

Consent is launch-scoped by installed extension/version, captured project, operation and exact path.
Metadata does not authorize content; file permission does not authorize Git. A different file needs
its own explicit consent. Navigation never retargets an existing handle. Revoke, close and disable
suppress late rendering; disable/recovery invalidates handles and grants without changing core data.

## Safety and bounds

- File paths are portable `/`-separated relative paths, at most 1024 UTF-8 bytes and 32 components.
  Traversal, alternate separators, absolute/drive/UNC paths, ADS, device names, empty components,
  hidden files/directories and common credential/auth/private-key names are denied. No directory
  enumeration or recursive grant exists. Deliberately authorized ordinary project text is untrusted
  content, not automatically secret-redacted; never put secrets into a file you choose to share.
- Consent captures the canonical project root **and its filesystem identity**. Every access rechecks
  the current stored root and opened root identity. Windows pins the entire ancestor chain with
  handles denying delete sharing and rejects reparse points, including junctions; POSIX uses
  descriptor-relative `openat(O_NOFOLLOW)` for every component. All symlinks (even in-root links),
  hard-linked files and nonregular files are denied. Files are consumed from the verified open handle,
  never by reopening a checked path. Root replacement cannot silently reuse old consent.
- Content is at most 128 KiB, read in bounded chunks; NUL/binary/non-UTF-8 returns
  `UnsupportedCapability`. Larger files return `LimitExceeded`, while metadata remains available.
  Each page is at most 4096 UTF-8 bytes, ending on a code-point boundary. `nextCursor` is the next byte
  offset; subsequent pages require the returned `revision`. Changed content or invalidated roots
  return `StaleContext`; invalid byte boundaries return `InvalidShape`. Refresh starts at byte zero.
- Responses are versioned `{schemaVersion:1,state:'Ready',revision,items,content,nextCursor}` in the
  existing typed envelope; errors are fixed non-echoing codes. SHA-256 content/metadata/HEAD revisions
  and file-size/mtime stability checks prevent mixed pagination. Metadata never includes the absolute
  root. Requests/replies keep the existing 8 KiB / 64 KiB limits and two-second single-worker deadline.
- `{op:'cancelRead',handle}` bypasses the worker queue and increments a native cancellation generation.
  Chunk reads and final delivery check it; cancellation affects no core job/process. The client waits
  for its pending read before release/revoke to avoid worker admission races. OS I/O can finish late;
  the existing one-worker bound and deadline discard late replies without starting unlimited workers.
- Git is intentionally a **HEAD snapshot**, not `git status`, history, diff, remotes or config. It
  starts no executable and therefore cannot invoke hooks, filters, fsmonitor, credential helpers or
  writes. Linked-worktree/submodule external `gitdir` files and linked `.git` directories are not
  followed: this experimental query supports only an ordinary in-root `.git/HEAD`. A missing root,
  project, file or HEAD returns `NotFound`; denied links/unsupported repository layouts fail closed.

The preview producer is synthetic. Native policy tests exercise actual files and Windows junctions;
POSIX symlink/descriptor tests are platform-gated. Installed desktop UI and native macOS/Linux
execution remain separate qualification inputs. Safe rollback is disable: no migration, write API,
Git mutation, network request, task termination or credential access is introduced.
