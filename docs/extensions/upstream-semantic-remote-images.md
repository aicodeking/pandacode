# Remote sends and tool images after the upstream merge

Upstream sync P4 (S04A2). PandaCode 0.3.128 was merged into the extension build; this page records how two
independent behaviors were checked and repaired on the merged tree, and which fixture holds each. With no extension
installed, all disabled, or in safe mode, both behave exactly as upstream 0.3.128.

## Remote send, steer and start retries

Upstream's rule is unchanged: a `task.send`, `task.steer` or `bot.message` carrying a `sendId` runs once per
(viewer, task, `sendId`); a repeat answers the first reply, or waits for it while it runs. A failure before anything
was saved is not remembered, so a retry tries again; a failure after the prompt was saved (`saved_failure`) is
answered again and the prompt is never saved twice. Send and steer share one memory per task: a `sendId` names one
prompt, whichever method carries it. Without a `sendId` (older viewers) every call runs.

Starts run once per (viewer, `startId`) through `host::start_keyed`. The extension build binds a package provider's
start to its captured operation, so an altered retry is refused with `Conflict` instead of answering another
operation's task. Before the merge only `task.start` did this; upstream's newer start methods (`chat.start`,
`team.start`, `github.startTask`) now key their start with `host::StartKey::captured(id, provider, captured)`:

| First start | Retry with the same `startId` | Answer |
|---|---|---|
| package provider | unchanged | the first start's result, run once |
| package provider | another provider, project, prompt, mode or admitted Full access switch | `Conflict`, nothing runs |
| package provider | a built-in provider | `Conflict` |
| built-in provider | anything built-in | the first start's result (upstream's unbound rule, unchanged) |
| built-in provider | a package provider | `Conflict`: a package retry never adopts a built-in start's task |
| any | another viewer | refused, as upstream |

Package identity survives projection: `providers.models` accepts `publisher.extension/local-id` identities (also a
retired package's) and built-ins, and refuses `panda.*` and malformed ids; `providers.list` keeps every id verbatim
through the phone path and size trimming, while a viewer without `extensionApiVersion: 1` still gets built-ins
only; `tasks.list` and team workers project the stored provider identity, never a label. The desktop composer still
sends `send_message` with exactly `sessionId`, `text`, `imageIds` and `moodboardIds`, as upstream's `src/main.ts`;
a rejected send is restored to the composer and saved once when sent again.

Fixture: `tests/fixtures/extensions/upstream-semantic-remote-images/remote-sends.json`, read by
`remote::host::tests::upstream_semantic_remote_sends_follow_the_fixture`; `webview-sends.json`, read by
`tests/upstream-semantic-remote-images.spec.ts`.

## Tool images

The `tool_image` command keeps upstream's rules on every platform: the session must run on this computer (a remote
mirror or cloud task answers "This image is on another machine"), one of the session's own tool records must name
the path in an image-bearing place, a relative path resolves inside the task's checkout, the bytes must really be
PNG, JPEG, GIF or WebP within 25 MB, and network paths are never opened. The image goes to the webview as a `data:`
URL; no secret or credential is involved, and nothing is requested over the network.

A package provider's task gets exactly the built-in rules: its tool records authorize its images and nothing else.
There is no permanent exclusion of package threads and no extra permission; the webview asks with only the thread
and path, never the harness.

Repairs, Windows only (upstream runs its native tests on Linux, so these never showed there):

- `canonicalize` spells a local path `\\?\C:\…`. Upstream's two-leading-separators rule took it for a network
  path, so every relative tool image (a progress snapshot, `test-results/…`) was refused as "Network image paths
  are not shown". A verbatim local-disk prefix is now local; every other such spelling (`\\host\share`,
  `\\?\UNC\…`, `\\.\…`) stays a network path, and a verbatim path's `..` or `.` is refused by its text.
- A path whose canonical form is a share (a mapped network drive resolves to `\\?\UNC\…`) is refused before it is
  opened, and the open handle's final path (`GetFinalPathNameByHandleW`) is checked against the checkout and for a
  share, as macOS and Linux check their descriptors. The open does not follow a link swapped in for the file.
- Relative requests are joined part by part to the canonical root (where `/` is not a separator), and a canonical
  root also goes by its plain `C:\…` spelling when matching tool records.

Fixture: `tests/fixtures/extensions/upstream-semantic-remote-images/tool-images.json`, read by
`tool_images::upstream_semantic_tests` (request rules per platform, on-disk authorization for a built-in and a
package thread, remote and cloud refusals) and by the browser spec (the webview never asks for a network path, a
permanent refusal keeps its words and is not asked again, the viewer asks once for the whole image).

## Not covered here

Crash restore and service quit accounting stay with R0107 and S0608. Installed multi-machine qualification of
remote package starts remains pending, as in [Providers](providers.md#remote-and-headless-placement-experimental-api-1).
