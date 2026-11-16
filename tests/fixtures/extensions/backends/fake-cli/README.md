# B2 fake command-line tool

Start B1, keep its stdin open, then spawn this program with an argument array:
`node fake-cli.mjs --daemon 127.0.0.1:<returned-port> --json <command>`.
No shell expansion or real command-line agent is used. Keep the child's stdin
open until completion; EOF cancels delay/socket work. It exits after one result
and never owns tracker state. `runCli()` is also importable.

Commands: `version`, `list [--status=<s>]`, `ready`, `blocked`,
`show --id=<id>`, `create --title=<t> [--type=<type>] [--priority=<n>]`,
`update --id=<id> [--status=<s>] [--assignee=<a>] [--title=<t>]`,
`claim --id=<id> --actor=<a>`, `close --id=<id> [--reason=<r>]`,
`reopen --id=<id> [--if-revision=<n>]`, `dep add <id> <dependsOn>`,
`comment <id> <text>`. Command flags use `--name=value`; daemon accepts either
syntax. Lists return issue arrays. Chunked snapshots are assembled internally.

Exactly one JSON document is printed. Exit 0 = result; 1 = daemon/injected
failure; 2 = usage; 3 = unreachable/disconnected/timed-out daemon or cancelled
work. Failures are `{error:{code,message}}`. Socket inactivity timeout is 5 s.

Environment controls: `FAKE_CLI_DELAY_MS` (0–3,600,000), `FAKE_CLI_FAIL=<code>`
(an error code, exit 1), `FAKE_CLI_PAD_BYTES` (0–16 MiB of trailing spaces,
keeping JSON valid). Delay precedes injected failure and any connection.
There is no extra ready line or HTTP control server for this finite tool.

Work board (1): all mutations, daemon-computed ready/blocked reads, revision
conflicts for undo, large reads, failure/delay/output-limit cases are reachable.
Host process caps, stale-board rendering and task start remain product work.

Test: `node --test fake-cli.test.mjs` (two tests).
