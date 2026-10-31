# Localization glossary

How PandaCode's UI localization works, and the term choices the catalogs share.

## How it fits together

- Source English strings **are** the catalog keys. `src/i18n.ts` exports `t()`;
  call sites wrap literals (`t('New task')`, tagged `` t`Remove ${escape(name)}?` ``).
  Tagged templates become positional keys (`Remove {0}?`). Values pass through
  untouched — call sites keep their own `escape()` calls.
- `en-US` needs no catalog (source spelling). `en-GB` is a partial spelling
  override. `zh-Hant-HK` is the Taiwan table plus a small regional-vocabulary
  override. The full catalogs — `zh-Hans`, `zh-Hant-TW`, `de`, `es`, `fr`,
  `it`, `ja`, `ko`, `pl`, `pt-BR`, `ru` — translate every key; any missing
  key falls back to English at runtime.
- The language preference lives in `localStorage` (`pandacode.language`,
  `'auto'` or a locale). `auto` follows the system language; the tray menu and
  launcher title read the persisted copy (`ui-language.json`, set through the
  `set_ui_language` command) so native chrome opens in the right language.
- Changing the language persists the choice, stashes unsent composer text in
  sessionStorage, and reloads — all three windows (main, launcher, tray
  popover) pick it up.
- `tests/i18n.test.mjs` is the guardrail: every literal `t()`/`` t`` `` key in
  `src/**` (excluding previews) must exist in both full catalogs, with
  matching `{n}` placeholder signatures. New UI strings fail CI until
  translated — that is deliberate.

## Product nouns (kept untranslated)

| Term | Treatment |
| --- | --- |
| PandaCode | Always the app name |
| Agent | The coding agents (Claude Code, Codex, …) and the word "harness" in UI |
| Bot | The bots feature |
| Architect, worker, Lead | Team roles (worker kept lowercase in zh) |
| Skill / Skills & rules | The skills feature |
| Jev, RTK, TypeSafe, InstaBox | Add-on/product names |
| MCP, ACP, VM, PR | Standard developer abbreviations |
| GitHub, Slack, Discord, Telegram, WhatsApp, Tarte etc. | Proper nouns |

## Chinese terminology (简体 → 繁體台灣 → 繁體香港)

| English | 简体 | 台灣 | 香港 |
| --- | --- | --- | --- |
| settings | 设置 | 設定 | 設定 |
| file/folder | 文件 / 文件夹 | 檔案 / 資料夾 | 檔案 / 資料夾 |
| software | 软件 | 軟體 | 軟件 |
| network | 网络 | 網路 | 網絡 |
| click | 点击 | 點選 | 點擊 |
| cloud | 云 | 雲端 | 雲端 |
| information | 信息 | 資訊 | 資訊 |

`zh-Hant-TW` is generated from `zh-Hans` with OpenCC `s2twp` (Taiwan standard
with phrase conversion); `zh-Hant-HK` re-imports it and applies the override
table at the top of `zh-Hant-HK.ts`. When you add a term that differs across
regions, translate it in `zh-Hans.ts` and, if OpenCC's Taiwan output needs a
correction, patch it there — the HK override only lists genuine vocabulary
differences.

## The nine machine-translated languages (de, es, fr, it, ja, ko, pl, pt-BR, ru)

These catalogs ship as machine-translated first passes over the full key set;
native review is explicitly welcome (the guardrail test keeps them complete
and placeholder-faithful, and missing keys fall back to English at runtime).
Register choices, so fixes stay consistent:

| Language | Register | Notes |
| --- | --- | --- |
| Deutsch | formal Sie | Branch/Commit/Workspace kept (dev-German usage) |
| Español | usted, buttons as infinitives | branch=rama |
| Français | vous | commit kept |
| Italiano | informal tu (product-UI convention) | branch=branch, commit=commit |
| 日本語 | です/ます polite | keep katakana for loanwords (タスク, セッション) |
| 한국어 | 합니다체 polite | |
| Polski | neutral (no gendered Pan/Pani forms) | |
| Português (Brasil) | você | |
| Русский | formal вы | |

Product nouns from the table above stay untranslated in all nine; ASCII
punctuation everywhere except the CJK locales (Japanese may use 、。！？).

## Multi-language notes

- All non-English catalogs keep `{n}` placeholders verbatim, ellipses `…`,
  middle dots `·`, keyboard glyphs, URLs, paths and CLI flags as-is; values
  keep the key's leading/trailing spaces so sentence-fragment keys still glue.
- Adding an eleventh+ language: create `src/locales/<id>.ts` (UI + `backend`
  tables, zh-Hans key order), register it in `src/i18n.ts` (`Locale`,
  `LOCALES`, `LANGUAGES`), `src/entry.ts`, `ui_language.rs` (`LOCALES` + tray
  labels + launcher title), `web.rs` (`ui_language` + the `STRINGS` table),
  the mobile `core.ts`/`catalogs.ts`, and the guardrail test's
  `FULL_CATALOGS`/`FULL_BACKENDS` lists. `tests/i18n.test.mjs` fails until
  every surface is complete.

## Style rules

- Full-width punctuation (，。：？) in zh prose; keep ASCII punctuation inside
  code, paths, commands and units.
- Keep `{0}` placeholders verbatim, in the order the sentence needs
  (reordering is allowed; dropping one is a test failure).
- Keep ellipses `…`, middle dots `·` and keyboard glyphs (⌘↩, ⇧↩) as-is.
- Plurals are separate keys per branch (`{0} task` / `{0} tasks`); Chinese
  catalogs translate both to the same text.
- "token" stays untranslated in zh (industry usage); "Task/任务" etc. follow
  the table above.

## Backend strings

- **Rust error strings**: the stable, sentence-like `Err("…")` literals are
  translated through `tBackend()` at the toast boundary (`report()`/`notify()`
  in main.ts, `showFeedback()` in the launcher) — exact-match lookup, anything
  dynamic (`format!`-built errors), already-translated text, or unknown passes
  through unchanged. The values that flow back to agents and comparisons stay
  raw English; only the display copy is translated. The backend tables export
  alongside each locale catalog (`export const backend`), and
  `tests/i18n.test.mjs` scans `src-tauri/src` for the literal set and fails
  until both full backend tables cover it.
- **Slash commands**: PandaCode's own commands (the `LOCAL_ACTIONS` table in
  `slash_commands.rs`) render their descriptions through `t()`; harness-provided
  commands and descriptions pass through as data.
- **Bots web chat page** (`bots/channels/web.rs`): the local server picks the
  locale from the `Accept-Language` header with the same resolution rules and
  injects a per-locale string table into the page; unknown keys fall back to
  the page's source English.

## Deliberately not translated

Agent-facing text (app instructions, token-saver packs, prompt templates),
preview sample data, `console`/log output, dynamic `format!`-built Rust errors
(they embed technical detail; the stable sentence set above is what users
see), harness-provided slash commands and descriptions, and the
`Approval needed:` message prefix (it is bot-channel protocol, shared with
Telegram/Slack).
