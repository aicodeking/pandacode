# Edit tasks v2

`tasks-edit-v2.json` holds 14 new edit tasks for the agent benchmark (6 existed before, so one lost pass no longer fails the gate on its own). The schema matches the `edit` entries in `tasks.json`. Each task is a real fix commit. The prompt describes the bug the way a user would and names no files. The check is the commit's own test file, which fails at the parent on an assertion and passes with the fix, so no task needs a stub.

None of the commits is used by an existing edit, localization or held-out task (`tasks.json`, `tasks-heldout.json`, `tasks-v1.json`).

## Tasks

| Id | Source commit | Repo | Language | Difficulty | Check | Parent | Fix | Check time (parent / fix) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `e2-ho-accepts-exact` | `98b35af` fix(accepts): exact type quality over subtype wildcards | Hono | TS | hard | `bun --config=/dev/null test src/helper/accepts/accepts.test.ts` | assertion ×2 | pass ×2 | <0.1 s |
| `e2-ho-etag-commas` | `b3f1272` fix(etag): commas within quoted entity tags | Hono | TS | medium | `bun … src/middleware/etag/index.test.ts` | assertion ×2 | pass ×2 | <0.1 s |
| `e2-ho-timing-quotes` | `28e7498` fix(timing): escape quotes in Server-Timing descriptions | Hono | TS | medium | `bun … src/middleware/timing/index.test.ts` | assertion ×2 | pass ×2 | 0.1 s |
| `e2-ho-timing-precision` | `edae2bf` fix(timing): honor precision 0 | Hono | TS | easy | `bun … src/middleware/timing/index.test.ts` | assertion ×2 | pass ×2 | 0.1 s |
| `e2-ho-basepath-regex` | `e77c7c8` fix(helper/route): regex params in basePath() | Hono | TS | hard | `bun … src/helper/route/index.test.ts` | assertion ×2 | pass ×2 | <0.1 s |
| `e2-ho-clone-void` | `43379d9` fix(jsx): self-closing void elements in cloneElement | Hono | TS (TSX) | easy | `bun … src/jsx/base.test.tsx` | assertion ×2 | pass ×2 | <0.1 s |
| `e2-ho-combine-some` | `afb2068` fix(combine): return a short-circuit Response from some() | Hono | TS | medium | `bun … src/middleware/combine/index.test.ts` | assertion ×2 | pass ×2 | <0.1 s |
| `e2-ho-accept-negative-q` | `9b4e9c2` fix(accept): clamp a negative q to 0 | Hono | TS | easy | `bun … src/utils/accept.test.ts` | assertion ×2 | pass ×2 | <0.1 s |
| `e2-linux-arm64-target` | `cbf4a86` feat: Linux arm64 release target | PandaCode | JS (Node scripts) | medium | `node --test` on 3 `scripts/release/*.test.mjs` | assertion ×2 | pass ×2 | 2.5 s |
| `e2-draft-rank-undo` | `b2f811d` storage: published drafts take rank 0; undo settling | PandaCode | Rust | hard | `cargo test --lib storage::` | assertion ×2 | pass ×2 | 45–82 s |
| `e2-boat-trial-ttl` | `5714ebf` fix: boat free-trial 2 h keep-alive cap | PandaCode | Rust | easy | `cargo test --lib cloud::boat::` | assertion ×2 | pass ×2 | 42–89 s |
| `e2-pnpm-global-bin` | `b35bff4` fix: search the pnpm global bin | PandaCode | Rust | medium | `cargo test --lib providers::launch::` | assertion ×2 | pass ×2 | 43–46 s |
| `e2-opencode-cache-pin` | `33347e0` fix: OpenCode cache gate uses the parsed pin | PandaCode | Rust | medium | `cargo test --lib cloud_agents::setup::` | assertion ×2 | pass ×2 | 43 s |
| `e2-do-ssh-key` | `0e8263b` fix: DigitalOcean `ssh_key` reply, re-list on a lost race | PandaCode | Rust | medium | `cargo test --lib cloud::digitalocean::` | assertion ×2 | pass ×2 | 43 s |

Mix: 8 TypeScript (Hono), 1 JavaScript (Node release scripts), 5 Rust. By difficulty: 4 easy, 6 medium, 4 hard. Each Rust time includes building the crate at the parent against a warm dependency target with today's pinned `Cargo.toml`/`Cargo.lock` (`pinDependencies`), so every check stays under 3 minutes. Every suite passes with the fix applied, so no task has a suite baseline failure.

## How it was verified (no model calls)

For each task, twice:
1. Extract the parent tree, overlay the commit's test files the way `overlayTests` does (`file` or `rust-tests`), run the check, and expect an assertion failure.
2. Extract the parent again, copy in the commit's files the way `applyFix` does, run the check, and expect it to pass. Run the suite once on the fixed tree.

Hono trees came from `git archive` of the commit's parent. PandaCode trees came from `git archive` without `mobile/` and `website/`, with `node_modules` symlinked as `materialize` does. Rust builds used this checkout's `src-tauri/target` with `CARGO_INCREMENTAL=0`. No task was flaky across the two repeats.

Candidates that were screened and dropped:
- `a00f945`: its test also passes at the parent.
- `f8d5144`: it doesn't build at the parent with today's dependencies.
- `9da45e6`, `72f1653`, `6818eb5`, `72f6643`: their tests cover only a new helper, the reason v1 dropped two tasks.
- `154b7a8`: it needs a production build.
- `6147339`, `128b7f3`: near-duplicates of `cbf4a86`.
- Hono `1534ffa`, `c0fd46e`, `e1dd588`, `e9c0107` (type-only or failing under Bun at the fix), `846e952`, `17ad0e2`, `eb78eca`, `08807ce`, `5ca49b0`, `ae401f0`, `2013fed`, `e5bb206` (still failing with the fix under Bun), `456fe46`, `00ee875` (passing at the parent).
- Hono `c3053cc`, `f5a5346`, `65cff90`: second tasks on files already covered.

## Notes for the runner

- **Hono checkout.** Hono tasks set `"repo": "hono"`. `overlayTests`, `applyFix` and `materialize` must use that repo's git directory, not this checkout. Nothing needs installing: Bun runs Hono's vitest-style tests with their globals. `--config=/dev/null` skips Hono's `bunfig.toml` coverage report, which would otherwise push the failures out of the captured tail; the coverage folder is gitignored anyway.
- **Bun output.** Bun reports a failed test as a `(fail) <name> [<time>]` line, so `failureKind`/`failedTests` need that pattern to classify it as an assertion.
- **Hono prompts.** Each Hono prompt ends with "Dependencies are not installed; `bun test <file>` runs the tests." Without it, an agent would try `npx vitest` and find nothing installed.
- **Rust tasks.** All five build like `edit-recipe-harnesses` and `edit-connect-secrets`: the parent commit with today's pinned manifests, in a clone of the warm target.
