# Bot bundles: shareable bot packs

A bot bundle is one JSON document that stands up a set of bots, their channels, schedules,
approval rules and skills on a machine that has none of them. It is the file
`pandacode serve --import-bots` already reads ([headless](headless.md#bots)) with four
additions: groups, portable skills, provenance, and a preview before anything is written.

The point is a link. Paste a repository URL into Bots, see exactly what it will create, and
get a working team — or decline and change nothing.

## What already exists

`headless_bots::apply` is the single constructors path the Settings UI also uses, and it is
already idempotent: bots match by canonical name, channels by kind+label, schedules by
title, rules by pattern (an edited decision replaces the old rule rather than stacking).
`export` is the secret-free inverse. Tests cover convergence, a failing bot not blocking the
rest, `env:` secret resolution, and that secrets and web tokens never export.

So the format is not the gap. Everything below layers on that function rather than
replacing it.

## Gaps

Each gap is numbered as a requirement in [required features](#required-features-in-order),
where the build order and dependencies are settled; the analysis below explains why each is
load-bearing.

### Groups are not in the bundle

`bot_shared_channels` (with members, messages and deliveries) is a real group abstraction —
lead, `@mention` routing, eight-post context carry — but the bundle has no field for it, so
an imported pack produces bots that cannot talk to each other. Add:

```json
"sharedChannels": [
  { "name": "Trading Floor", "lead": "Desk Lead",
    "members": ["Desk Lead", "Market Analyst", "Strategist"] }
]
```

Matched by name like bots, so re-applying updates membership instead of creating a second
floor. Members are bot names inside the same bundle, resolved after every bot exists.

### Skills do not travel

`bots.skills` holds library IDs. On a fresh machine those IDs mean nothing, so a bundle's
`skills: [...]` imports as dangling references — which is fatal for a pack whose value *is*
its skills. A bundle needs to carry them:

```json
"skills": [
  { "name": "hyperliquid-setup", "source": "https://github.com/owner/repo",
    "ref": "v1.10.0", "path": "skills/hyperliquid-setup", "sha256": "…" }
]
```

Installed into the library first, then bound by name. `sha256` is required when `source` is
remote: a skill is standing instructions the agent will follow, so an unpinned one is a
supply-chain hole. Bare strings stay supported for bots on the machine that made the bundle.

### No preview, and no IPC

`apply` is reachable only from the serve process (`headless.rs`), so the desktop cannot
import without a shell. Add a dry-run: `bots_import_preview` runs the same matching logic
and returns the diff — created, updated, unchanged, and failures — without writing. The UI
shows that before the user commits. `bots_import` then applies.

This is the simple, highest-value gap: it turns the feature from a CLI flag into the paste-a-link
flow.

### No provenance or review

A bundle is instructions and `allow` rules for your fleet. Importing one unread is equivalent
to trusting its author with your workspace. Every bundle gets:

- a `sha256` per remote skill and per remote document;
- a review pane showing instructions, soul, guard rules and channel kinds before apply;
- a recorded origin (repo, ref, commit) on each bot it created, so you can answer "where did
  this come from" later and diff against an upstream update.

### Nothing can be undone

One artifact can create seven bots, a group and ten skills. Deleting the bundle must offer
the inverse: bots it created (tracked by origin), the group, and skills no other bot uses.
Bots it only *updated* are not deleted — that is data loss on someone else's work.

## Bot-scoped provisioning

Today a bot can remember, schedule, notify and message one other bot. It cannot create a bot,
add a channel, or make a group: `bot_create`, `bot_channel_add` and
`bot_shared_channel_create` are all `guard_main` IPC, and the bot tool catalog in
`bots/tools.rs` has seven self-scoped tools and no provisioning.

Add three tools, all self-scoped to the calling bot:

| Tool | Effect |
| --- | --- |
| `bot_create` | Create a bot from a profile, or apply a bundle |
| `bot_channel_add` | Add a chat channel to a bot this bot created |
| `bot_shared_channel_create` | Create a group and set its members |

### Approval follows the bot's existing mode

These tools must not invent a second permission system. They emit an ordinary approval
request, so `guard::decide` and the mode mapping apply unchanged:

| Bot mode | Harness behaviour | What the user sees |
| --- | --- | --- |
| `ask` | `default` | Every provisioning call asks |
| `auto` | `acceptEdits` / `yolo` | Routine creation proceeds; anything not covered asks |
| `review` | `auto` | Claude Code's reviewer approves routine actions |
| `plan` | `plan` / read-only | Nothing is written |
| `full` | `bypassPermissions` | Creates bots without asking |

That is the "full creates automatically, otherwise it asks" behaviour requested, expressed
as a property of the existing mode rather than a new switch. Note `full` is
`bypassPermissions`, so a Full-access bot will genuinely provision silently — the caps below
are what bound it.

### Escalation: ALWAYS_ASK does not cover tools

`guard::decide` takes free text and matches it against `ALWAYS_ASK`, which today lists shell
and finance phrases (`sudo `, `git push --force`, `transfer money`) — nothing about bot
creation. Two consequences:

1. A provisioning call that `full` bypasses never reaches the guard at all, so the guard is
   not a safety net here. Only the caps and the review step are.
2. `ALWAYS_ASK` should gain provisioning-shaped entries so that a broad `allow` rule cannot
   cover them while the bot is *not* in `full`: creating a bot, adding a remote skill, or
   adding a channel. Text matching is the existing mechanism; these entries fit it.

### Asking smartly, not uniformly

Asking on every call trains the user to approve reflexively, which is worse than not asking.
Ask always for these, regardless of mode except `full`:

- **A remote skill or a remote bundle** — new standing instructions from outside.
- **A channel that reaches the internet** — Telegram, Slack, Discord, WhatsApp. A web chat
  is loopback-only and does not qualify.
- **Instructions, soul or guard-rule changes on a bot this caller did not create.** Editing
  someone else's bot is how a small permission becomes a large one.
- **Any call that would exceed a cap** (below), since the answer is always no.

Let the following proceed under `auto`/`review` because they are local, reversible, and
already bounded:

- Creating a bot in the local workspace with no channel.
- Creating a shared channel among bots this caller created.
- Adding a web chat channel (loopback, token-gated).

The distinction is: does this action bring in outside text, outside instructions, or reach
outside the machine? Those three ask.

### Caps

The fork-bomb risk is a bot that creates bots that create bots. Bound it in the native
function, not in the prompt:

| Cap | Value | Rationale |
| --- | --- | --- |
| Bots one bot may create | 20 | A team is a handful; 20 is generous and finite |
| Creation depth | 1 | A created bot cannot create bots; only a user-made bot may |
| Bundles one bot may apply | 1 per turn | Prevents a loop applying a template repeatedly |
| Total bots | Existing limit | Whatever Settings already enforces |

Depth 1 is the load-bearing one: it makes recursion impossible rather than merely slow, so
the cap is a backstop and not the only defence. Record the creating bot on each new bot
(a `created_by_bot_id` column) — that is what both the depth check and the rollback read.

Cap violations fail the call with a message the agent can relay, rather than asking, because
there is no answer that makes it succeed.

## Required features, in order

The substrate is roughly 80% present. What follows is everything missing, ordered so that each
item is buildable on what precedes it. The ordering is a dependency order, not a priority
list: nothing in stage 3 works without stage 2, and nothing in stage 4 works without stage 2
either — a provisioning bot applies the same bundle a human does.

Ordering constraints that drive it:

- **#468 and #261 constrain everything from B3 on.** Adding fields to the bundle before the
  channel registry lands and webhook configuration settles means documenting a shape that is
  about to change. B1–B2 are deliberately field-free, so they can land first.
- **B4, B5 and B7 edit the same format.** They are three changes to one document and one
  `apply`; doing them out of order means three passes over the same matching logic.
- **B7 must precede B8 and B9.** An update diff and a rollback both read provenance. Without
  it, "what did this import create" is guesswork.
- **B6 must precede B12.** Provisioning tools write bots, and writing bots without pre-flight
  is how a half-built fleet happens.
- **B11 must precede B12.** Depth and caps are the only bound on a `full` bot, which never
  reaches the guard; shipping the tools first would ship the fork bomb.

### Stage 1 — one code path, two callers

**B1. Bundle IPC (`bots_import_preview`, `bots_import`).** Thin Tauri commands over the
existing `headless_bots::apply`/`export`. `preview` returns the diff — created, updated,
unchanged, failures — and writes nothing. Highest value per line: it converts a serve-only CLI
flag into the paste-a-link flow without touching the format.

**B2. Bots import/export entry in the UI.** A file picker and a URL field in the Bots section,
showing the B1 diff before the user commits. Reuses `src/bots-connect.ts`'s guided-flow style
rather than inventing a new panel idiom.

Acceptance for stage 1: the same `bots.json` that works with `pandacode serve --import-bots`
imports from the desktop, and previewing it twice changes nothing.

### Stage 2 — make an imported pack actually work

**B3. Channel kinds from the registry.** Bundle `channels[].kind` cites `KINDS` rather than
listing kinds inline. Doc-only today; load-bearing once a new kind is added. Blocked on #468.

**B4. `sharedChannels` in the bundle.** Lead plus members, resolved after every bot exists,
matched by name so re-applying updates membership instead of creating a second floor. Without
this, an imported set is a set of bots that cannot talk to each other.

**B5. Portable skills.** Two forms, following the two options #285 already establishes for
library skills generally: **carried** (`source` + `ref` + `path` + required `sha256`) and
**linked** (a local path read live, no copy). Bare library IDs stay valid for same-machine
exports. A bundle whose value is its skills is hollow without this.

**B6. Cold-start pre-flight.** Resolve providers, model names, MCP servers and skill refs
*before* writing anything, and fail with one clear reason. Today a bad bundle fails per-bot
after it has already created seven workspaces.

Acceptance for stage 2: exporting a two-bot pack with one group and one remote skill on
machine A, and importing it on machine B, yields two working bots that can message each other.

### Stage 3 — trust it with other people's documents

**B7. Provenance.** `sha256` per remote document and per remote skill; a recorded origin
(repo, ref, commit) on each bot a bundle created; a review pane showing instructions, soul,
guard rules and channel kinds before apply. A bundle is standing instructions for a fleet —
importing one unread is trusting its author with the workspace.

**B8. Bundle update diff.** When a bundle's upstream moves, re-previewing shows what changed
against what is installed, so an update is a reviewed diff rather than a silent overwrite.

**B9. Rollback.** Delete what an import created — bots it created, its group, skills no other
bot uses — while leaving bots it merely *updated* alone. Reads B7's origin.

**B10. Secrets checklist.** Export strips secrets by design, so an import produces bots that
exist but cannot connect. Report the exact missing names per bot, and let re-applying the same
file resume after the user adds them. (Partly free today: `env:NAME` resolution already
reports per-bot.)

Acceptance for stage 3: importing a pack you do not trust is safe to decline, and importing
one you do trust is reversible.

### Stage 4 — a bot provisions the team

**B11. Caps and depth, before anything can call them.** `created_by_bot_id`, depth 1, 20 bots
per creator, one bundle per turn. Depth 1 is the real defence; the numbers are backstops. This
lands as a native check first — a `create` that takes a caller — so no tool exists before the
bound does.

**B12. Three provisioning tools** — `bot_create`, `bot_channel_add`,
`bot_shared_channel_create` — self-scoped to the caller, emitting ordinary approval requests so
the mode mapping above applies unchanged.

**B13. Smart escalation.** `ALWAYS_ASK` entries for provisioning shapes, plus the
outside-text / outside-instructions / outside-the-machine rule above deciding what asks.

**B14. Relay the import report to chat.** A provisioning bot works in a chat channel, so the
diff and any failures must reach the user there, not only the desktop.

Acceptance for stage 4: a Full-access bot given a bundle URL creates the team and reports what
it made; the same bot in `ask` mode asks before each bot and cannot recurse.

### Stage 5 — correctness under real use

**B15. Identity over names.** Bundles match bots by name; two packs both shipping "Risk
Manager" collide silently. Namespacing by origin is the largest change here and the only one
that can wait for evidence — ship stages 1–4, and do this when a collision actually bites.

**B16. Skip lists.** "Don't offer me this bot again" and per-bundle opt-out for members, so
re-applying a bundle the user deliberately trimmed does not resurrect it.

**B17. Docs.** Fold the settled format into [headless](headless.md#bots) (server) and this
document (desktop), and drop the "Not yet built" line in [bots](bots.md).

### Deliberately not required

- **A hosted registry or index.** `source` is any git URL; a curated catalogue is a website.
- **Bundling secrets or per-bot provider credentials.** `export` strips them on purpose and
  bots share the machine's auth by design.
- **A general plugin system.** Issue #459 asks for one; a bundle is not a plugin, and building
  the former to get the latter is the scope creep that stops this shipping.

## Open work this builds on

Written against the tree as it is now. These overlap and should land first:

- **#468** (channel-kind registry): one `KINDS` list per side. Any channel kind a bundle
  serialises must come from it, so the bundle's `channels[].kind` documentation should cite
  the registry rather than list kinds inline.
- **#261** (webhook triggers): changes channel `config` and secret names, which is exactly
  what `export` writes. Adding bundle fields before this lands means documenting a shape
  that is about to change.
- **#467 / #476**: both touch `src/bots.ts`, where an import entry point goes.
- **#470** (Rooms): the mobile surface for shared channels. Groups in a bundle become
  reachable on a phone because of it, so group wiring is worth more once #470 merges.
- **#389** (extension runtime): a plausible distribution surface for bundles later. Not a
  prerequisite.
