# Registered local test runner (experimental)

ZIP **only** `extension.json` and `main.cjs` at the archive root. Install the ZIP in
Settings → Extensions, review the normal-account executable authority, trust the
reviewed content and explicitly enable `sample.test-runner`. Installation alone
never executes code. Changed executable content requires a new review.

Select a project and click **Run local tests**. The host shows the captured project,
packaged executable and deadline; **Authorize this project and run tool** is separate
from executable trust. This example runs a deterministic local assertion in its owned
Node process and reports progress plus `{ passed: 1, args, cwd }`. The optional argument
is delivered as literal data, not Node options or shell text. `wait` exercises timeout
or cancellation, `flood`, `progress-flood` and `result-flood` exercise output limits.
No test server, download, global runtime, dependency install or network is needed.

The v1 managed executable adapter is `node`, the exact packaged runtime, calling the
tool's exported handler in reviewed `main.cjs`. Other executable paths, PATH lookup,
environment overrides and arbitrary cwd are unsupported. Cwd is the captured native
project root, with its directory chain retained during execution. Native support is
experimental Windows x64; ordinary browser preview does not execute this package.
The opt-in `?extension-jobs` test transport is explicitly synthetic.

Jobs are bounded to 8 concurrent processes and 64 retained records, a declared deadline
of 100–30,000 ms, 32 progress messages of at most 512 JSON bytes and a result of at most
8192 JSON bytes. Arguments are at most 32 strings of 1024 UTF-8 bytes each (the entire
request is also limited to 8192 bytes). This sample narrows them to one string and 3 s.
Stdout is a framed host protocol, stderr is bounded/discarded, not a terminal stream.
Job IDs are opaque; the API does not accept a PID, owner, executable or project override.

Cancel, revoke authorization, close the tool panel, disable/uninstall the owner, revoke
executable trust, development reload or safe mode stop applicable managed work. Terminal
state is settled once after supervisor cleanup; unrelated owners and core agents are not
targeted. Closing the panel revokes its scope grant before releasing its captured handle.
Grants are session-memory owner/version/content/project/tool authorizations, not global
process privileges or permission to execute arbitrary tools. Already completed jobs keep
their terminal result; cancellation does not retroactively change it.

Trusted code still has the user's normal OS authority: these API grants do **not** sandbox
its independent file, network or process calls, nor undo prior effects. Installed WebView2
and other platform qualification are deferred; do not infer them from synthetic browser tests.
