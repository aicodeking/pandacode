# Localization glossary

How PandaCode's UI localization works, and the term choices the catalogs share.

## How it fits together

- Source English strings **are** the catalog keys. `src/i18n.ts` exports `t()`;
  call sites wrap literals (`t('New task')`, tagged `` t`Remove ${escape(name)}?` ``).
  Tagged templates become positional keys (`Remove {0}?`). Values pass through
  untouched — call sites keep their own `escape()` calls.
- `en-US` needs no catalog (source spelling). `en-GB` is a partial spelling
  override. `zh-Hant-HK` is the Taiwan table plus a small regional-vocabulary
  override. `zh-Hans` and `zh-Hant-TW` are full catalogs.
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

## Deliberately not translated

Agent-facing text (app instructions, token-saver packs, prompt templates),
preview sample data, log/diagnostic strings, Rust error strings, slash-command
descriptions that come from harnesses, and the bots web-chat page (served
separately by the local server).
