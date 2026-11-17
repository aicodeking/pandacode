# Selectable presentations (`ui.presentation`)

Runtime phase R10, slice R1002. A trusted package can change how the conversation looks, with three closed additions: a
conversation-only transcript, a working indicator and a backdrop. The permission is `ui.presentation` (global): granted with the
trust decision, rechecked on every request, revocable by the user. A package that holds it is never asked again per action
(ADR-0005). Everything is additive: disabling the package, revoking the grant or safe mode brings the built-in presentation back,
and no task, draft or approval is touched.

## What a package declares

### Conversation-only transcript

A `contributes.components` entry for the slot `panda.transcript` whose `presentation` is `conversation`:

```json
{ "id": "sample.look/conversation", "title": "Conversation only", "slot": "panda.transcript", "contractVersion": 1,
  "presentation": "conversation", "capabilities": ["streaming", "questions", "approvals", "stop-resume", "host-history"] }
```

The host hides the tool steps and keeps the text of the turns, the questions and the approvals. `capabilities` must include
`streaming`, `stop-resume` and `host-history` (what the host keeps running under it) and may name any other transcript capability.
This recipe delivers no transcript or tool content to the package, so it needs only `ui.presentation`, not
`tasks.transcript.read` or `tasks.tools.read` (the `timeline` recipe keeps those two). The user picks the provider the same way as
for every transcript replacement.

### Working indicator and backdrop

`contributes.presentations` (at most 16 per package, unique ids), chosen by the user:

```json
"presentations": [
  { "id": "sample.look/dots", "title": "Dots", "kind": "working-indicator", "frames": ["·", "··", "···"], "intervalMs": 240 },
  { "id": "sample.look/sky", "title": "Night sky", "kind": "backdrop", "image": "assets/sky.svg", "opacity": 0.2 },
  { "id": "sample.look/aurora", "title": "Aurora", "kind": "backdrop", "view": "sample.look/aurora-panel", "opacity": 0.3 }
]
```

| Kind | Fields and bounds |
|---|---|
| `working-indicator` | `frames`: 2 to 16 text frames of at most 16 characters; `intervalMs`: 80 to 1,000 |
| `backdrop` | exactly one of `image` (an `assets/` SVG that the package also lists in `contributes.icons`, so it travels the same checked static-image channel) or `view` (the id of one of the package's own rich views); `opacity`: a number from 0 to 0.5 |

Out-of-range values answer `LimitExceeded`, a wrong shape or source `InvalidShape`. `opacity` is the first fractional number in the
schema, so both evaluators gained a `number` type (finite, with `minimum`/`maximum`).

## What the user sees

- A small **Look** button beside the thread (hidden while nothing is offered). Its menu is the host's choice menu (Enter or Space
  opens it, arrows move, Esc closes) and lists, per kind, `Built-in` and each offer as `Working indicator: Dots (Package name)`.
  The choice is stored in the user's own preferences and survives restarts. **Nothing changes until the user chooses.** A choice
  whose package is gone, disabled or no longer granted falls back to the built-in presentation.
- The **indicator** is shown beside the thread while the task runs, labelled with the package name. It swaps text frames on a
  timer; with reduced motion the first frame is shown still and no timer runs. No CSS animation is involved.
- The **backdrop** is a static layer behind the thread with `pointer-events: none`, `aria-hidden` and the declared opacity (never
  above 0.5), so the text stays readable over it and the layer can never take a click or the keyboard.
- The **conversation** transcript hides the tool steps (`#transcript.component-conversation`); the built-in transcript returns
  when the provider is deselected, the package is disabled or the grant is revoked.

## Ghost text

`panda.tasks.draft.suggest` (`tasks.draft`, slice R0403) draws a suggestion above the composer. It is integrated with these
presentations by one rule set: it is never sent, typing dismisses it, Tab accepts it as draft text (one undo step), switching or
redrawing the composer for another task removes it, and a revoked grant or a stopped service clears it. Selecting a different
presentation never touches a suggestion or the draft.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_transcript_presentation.rs`): `check_presentation` and `check_all` (bounds,
  sources, unique ids), `check_conversation_provider`, `gate` (`PermissionDenied` without `ui.presentation` now), `offers`/`resolve`
  (the selection rule) and the pure `frame_index`/`opacity`. Both manifest validators (`contracts.ts`, `contracts.rs`) call the same rules.
- **Interface** (`src/extensions/runtime-transcript-presentation.ts`): the same rules as a pure model, and `mountPresentations`,
  which draws the strip right after the thread and the backdrop as the first child of the conversation pane. `replacement.ts`
  applies the `conversation` recipe through the same rules and the live grant probe the mount publishes.
- **Styling** is in `src/extensions/extensions.css`, which `main.ts` imports at start. Colors are `--accent`/`--ds-*` tokens;
  nothing animates layout and nothing transitions backdrop-filter.

## Failure and limits

Limits are for reliability and legibility, never for trust. A backdrop panel is mounted by the same trusted mount as every rich
panel and stays contained (a fault shows the host note and removes the layer; the thread is untouched). A native panel is a child
webview placed over its element, so it cannot sit behind the thread: a panel backdrop is drawn only by the preview technique
(`browser-iframe`); in the installed app the user is told once and the built-in background stays until installed-app
qualification of a behind-the-thread panel exists. An image backdrop is a static SVG (the icon channel); raster images wait for
an archive reader that is not part of this slice.

## Verification

`tests/extensions-runtime-transcript-presentation.spec.ts` (model and preview column) and
`runtime_transcript_presentation::tests` (native unit column). Installed-app qualification of native panels is reported separately in
the receipt.
