# Replacing built-in tool rows and exposing risk signals

Runtime phase R10, slice R1004 (`ui.presentation`, ADR-0005). A trusted package can change how one kind of built-in tool
row reads in the transcript and can attach risk signals to it. This goes beyond the row actions of
[upstream-tool-rows.md](upstream-tool-rows.md): there a package only adds buttons; here it supplies the row's sentence
and result card. With no package installed, all disabled, or in safe mode, every row draws exactly as upstream 0.3.128.

## What a package declares

`contributes.toolRows` (at most 16, ids unique). Nothing is markup or code: the host draws every pixel, so a package
cannot touch a row, only describe it.

```json
{
  "id": "acme.rows/shell", "title": "Shell commands",
  "selector": { "kind": "shell", "name": "Bash" },
  "row": { "sentence": "Shell: {target}" },
  "card": { "title": "Command", "fields": [{ "label": "Output", "value": "{output}" }] },
  "signals": [{ "id": "denied", "risk": "destructive", "label": "Denied by Acme", "when": "hook-deny" }]
}
```

| Part | Shape and limits |
|---|---|
| `selector` | one to four of `kind`, `name`, `family`, `server` (each at most 96 characters); every key must equal the row's fact. A name beats a server, a server a family, a family a kind |
| `row.sentence` | at most 160 characters of text and tokens |
| `card` | optional; `title` at most 80 characters, at most 8 `fields` of a `label` (24) and a `value` (160, tokens) |
| `signals` | at most 8, ids unique: `risk` (`notice`, `caution`, `destructive`), `label` (24), `when` |
| tokens | `{name}` `{kind}` `{family}` `{server}` `{status}` `{target}` `{input}` `{output}`; an unknown token or an open brace is `InvalidShape` |

Failures are the frozen codes `InvalidShape` and `LimitExceeded`. The permission is `ui.presentation` (the install
dialog lists it; the user may revoke or narrow it). `{input}` and `{output}` additionally need `tasks.tools.read` for the
project; without it they read `[not granted]`. A package that holds them is never asked again per action.

## What the host draws

The host fills the tokens from its own facts, on one line and cut at 160 characters. Text the host marked secret is
`[hidden]`, so the project's privacy and secret requirements hold exactly as they did for the built-in row. The row shows
the package's name next to the sentence (`Shown by <name>`) and the built-in sentence stays in the page, hidden, so
removing the package's nodes restores it at once.

Never changed by a replacement: the destructive badge and its risks, the `exit N` and `then failed` badges, failure
blame, refusal rows (`Blocked: …`, `Interrupted: …`), the shell-intent classification and the chevron. There is no
permanent safety-only exclusion: a destructive or failed row can be replaced like any other row, and its built-in
badge stays on screen beside the replacement.

## Risk signals and decisions

- A signal with `when` `always`, `failed` or `blocked` is drawn from the row's own state, with provenance `package`.
- A signal with `when` `hook-approve`, `hook-deny`, `hook-ask` or `hook-rewrite` is **derived from a hook decision**
  (R0505, `decidedBy`): it shows only when that same package returned that decision for that call, provenance `hook`.
  A package cannot light a signal from another package's decision.
- Chips are ordered highest risk first. The built-in destructive chip is always first and is never hidden, lowered or
  replaced.
- The decision line is the host's: `approved`, `denied` or `pending` as it really happened, by the package named in
  `decidedBy` or by `host`. A package's claim only adds who decided when it agrees; when it disagrees (the user denied
  after the package approved) the row shows the native outcome and lists the claim as `overruled`. A native approval or
  denial is never misreported.

## Selection and fallback

| Situation | Result |
|---|---|
| Safe mode | built-in row (`SafeMode`) |
| Package disabled, uninstalled, or grant revoked | built-in row (`NoMatch`/`Revoked`) |
| Selector matches no row (stale or unknown) | built-in row (`NoMatch`) |
| Two packages claim the same row with equal specificity | built-in row (`Conflict`); neither wins |
| A more specific selector | wins over a broader one, even from another package |
| A replacement fails to draw | dropped for the session, built-in row returns, told once (`Faulted`); a broader declaration of the same package takes over |

Nothing is stored: the choice is recomputed from the installed packages and grants, so disable, revoke and safe mode
restore the built-in rows with no migration.

## Where it lives

- Interface and model: `src/extensions/runtime-tool-row-replacement.ts` (`mountToolRowReplacement`, mounted once in
  `src/main.ts`); styles in `src/extensions/extensions.css` (tokens only, no layout animation).
- Native twin and unit tests: `src-tauri/src/extensions/runtime_tool_row_replacement.rs`; the manifest check runs in
  `contracts.rs`.
- Schema `$defs/toolRow`, SDK type `ToolRowDeclaration`.
- Fixtures: `tests/fixtures/extensions/runtime-tool-row-replacement/` (`replace`, `rival`, `bad`, recorded-shape
  `rows.json`). Spec: `tests/extensions-runtime-tool-row-replacement.spec.ts` (written, run in the final test phase).
- No new IPC, so no preview mock. Installed-WebView qualification and a real harness capture are reported separately and
  are pending.
