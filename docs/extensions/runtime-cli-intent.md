# Intent rules for package command-line tools

Runtime phase R7, slice R0705. A package that ships a command-line tool (a `tracker`, a `deploy` script) can tell
PandaCode what each operation of it is, so the transcript row and the approval row of an agent's shell call say
"Closed issue" and not "Ran tracker close 7". The rule is a **hint** routed into the host's existing shell classifier
(`describeShell`, `src/shell-intent*.ts`) and the normal approval and hook path. It is not a safety gate, not a new
permission to run anything and not access to a secret.

Twin implementations with one set of cases (`tests/fixtures/extensions/runtime-cli-intent/cases.json`):
`src-tauri/src/extensions/runtime_cli_intent.rs` (native) and `src/extensions/runtime-cli-intent.ts` (webview and preview).

## Declaration

`contributes.cliIntents[]`, with the `tools.model` permission declared (granted per project, checked on every
classification):

```json
{ "id": "acme.tracker/close-reason", "command": "tracker", "words": ["close"], "flags": ["--reason"],
  "intent": { "kind": "process", "verb": "Closed", "label": "issue", "object": "with a reason" } }
```

| Field | Rule |
|---|---|
| `id` | `<manifest id>/…`; `panda.` is `ReservedId`, a foreign prefix `InvalidId`, a repeat `DuplicateId` |
| `command` | the program name only (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), compared lower-cased without a directory or a `.exe`, `.cmd`, `.bat`, `.ps1` suffix |
| `words` | optional, at most 4: the first positional (not `-`) arguments in order |
| `flags` | optional, at most 8, `-x` or `--name`: the rule needs any one of them (`--name=value` counts) |
| `intent.kind` | one of the host's shell kinds (`read`, `search`, `list`, `test`, `typecheck`, `build`, `install`, `git`, `github`, `wait`, `fetch`, `script`, `db`, `file`, `process`, `media`, `system`, `shell`) |
| `intent.verb` | 1 to 32 characters of plain text |
| `intent.label`, `intent.object` | optional, at most 48 and 96 characters |

At most 64 rules per package (`LimitExceeded`). Two rules of one package with the same command, words and flags are
`DuplicateId`. Without `tools.model` the manifest is `PermissionDenied`. Anything else in `intent` is `InvalidShape`:
there is deliberately no `destructive`, `risk` or `approval` field.

A rule matches the program the agent runs. A launcher such as `node tool.mjs …` is `node`; ship a program of your own
name (a `.cmd`/shell wrapper) for the rule to see it. An option's separate value counts as a positional word, so
document options as `--name=value` where a rule depends on the words.

## Classification and results

The command line is cut at unquoted `&&`, `||`, `;`, `|` and newlines; each segment is tokenised (quotes only, no
backslash rules). Leading `NAME=value` words are skipped. Each segment answers one status:

| Status | Meaning |
|---|---|
| `Matched` | a rule fits; the segment names it |
| `Unmatched` | a package declares this program but no rule fits (the host row stays as is) |
| `NoRule` | no package declares this program |
| `Unparseable` | an open quote, an empty line or a line over 16 KiB |

The command line's status is `Matched` when any segment is, and the first matched segment is the hint. Frozen result:
`{ schemaVersion: 1, status, segments: [{ text, status, rule, owner, package, intent, candidates }], hint: { rule, owner,
package, intent } | null }`.

**Precedence (deterministic).** The most specific rule wins: more `words`, then more `flags`. On a tie the package
listed first by the host wins, then its earlier rule. **Collision:** two packages declaring the same command, words and
flags: the later package's rule is unavailable and listed in `conflicts` (`owner`, `id`, `command`, `heldBy`); it never
silently replaces the earlier one. **Errors** (an unreadable manifest, a revoked grant, safe mode, an open quote)
leave the host classification exactly as it was; nothing here can fail a tool call.

## The merge: a hint, not a gate

`merge(host, classification)` names the row (`kind`, `verb`, `label`, `object`) from the rule only where the host
classifier answered the generic `shell` kind. A more specific host answer (`git`, `test`, …) is kept. In every case the
host's `destructive`, `risks`, approval and hook decisions are untouched, and the answer gains
`packageIntent: { applied, owner, package, rule, intent }` so the row can say which package named it. A rule cannot
lower a risk, skip an approval, widen a grant or read a credential (ADR-0005, ADR-0006). Hooks and approvals see the
hint as `payload.intent` (the classification above) beside the normal `tool.before` fields, so `harness.hooks.decide`
packages and the user's normal prompt decide exactly as without it. The package's own tools keep the decided
capability under its grants and the host's fault isolation and project rules.

## Where it plugs in

`annotate(app, project, command, payload, host)` is the one entry for the host: it classifies the shell call of a run
for the run's project, adds `intent` to the hook payload and returns the merged host classification. The preview
twin is `CliIntentRegistry.annotate`. Wiring of the call sites (the `tool.before` hook call and the transcript row) is
listed in the receipt as the follow-up it is.
