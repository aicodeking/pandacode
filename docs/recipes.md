# Workflow recipes

Local, reusable multi-step flows (issue #44). A recipe is one JSON file: `.pandacode/recipes/<name>.json` in a project, or the same folder under app data (`recipes/`) for all projects. A project recipe hides a global one of the same name. Names are `[a-z0-9][a-z0-9_-]{0,63}`; recipes have at most 50 steps, 4000 characters per step, 64 KB per file.

```json
{ "name": "review-diff", "description": "Review, check, approve",
  "steps": [
    { "kind": "prompt", "text": "Review the changed files." },
    { "kind": "slash", "command": "/review", "text": "fallback prompt if /review is missing", "requires": ["slash:review"] },
    { "kind": "check", "text": "npm test" },
    { "kind": "approval", "text": "Ready to commit?" } ] }
```

Kinds: `prompt` (text), `slash` (command, optional fallback text), `check` (the agent runs it and reports), `approval` (the agent stops and asks you to confirm). `requires`: `slash:<name>`, `mcp`, `steer`.

Dry run (`recipes.rs::dry_run`) gives each step `supported`, `fallback` (missing slash command with fallback text; `steer` on a harness that cannot steer), `manual` (approval) or `blocked` (missing command, no fallback), with a reason. A `steer` step is `supported` on the harnesses whose running turn takes a message (Claude Code, GLM, MiMo, Codex, Pi, Oh My Pi, Muse Code and OpenCode) and a `fallback` on the others. Run is disabled while any step is blocked; otherwise it enqueues one ordinary queued message per step, in order. No secrets live in recipes, and nothing runs an agent or touches the network.

Not built (from the issue): role/task scopes, evidence records, skills/rules references.

## Wiring

`src-tauri/src/lib.rs`: add `mod recipes;` near `mod slash_commands;`, the commands below next to `list_slash_commands`, and register them in `generate_handler![...]`.

```rust
fn recipes_dir(app: &AppHandle, state: &State<'_, AppState>, project_id: &str, scope: &str) -> Result<std::path::PathBuf> {
    if scope == "global" {
        return Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recipes"));
    }
    let root = state.store.lock().map_err(|e| e.to_string())?.workspace_root(project_id, None)?;
    Ok(recipes::project_dir(&root))
}
#[tauri::command]
async fn recipes_list(app: AppHandle, state: State<'_, AppState>, project_id: String) -> Result<Vec<recipes::Recipe>> {
    let root = state.store.lock().map_err(|e| e.to_string())?.workspace_root(&project_id, None).ok();
    let global = recipes_dir(&app, &state, &project_id, "global")?;
    blocking(move || Ok(recipes::list(root.as_deref(), &global))).await
}
#[tauri::command]
async fn recipes_save(app: AppHandle, state: State<'_, AppState>, project_id: String, scope: String, recipe: recipes::Recipe) -> Result<()> {
    let dir = recipes_dir(&app, &state, &project_id, &scope)?;
    blocking(move || recipes::save(&dir, &recipe)).await
}
#[tauri::command]
async fn recipes_delete(app: AppHandle, state: State<'_, AppState>, project_id: String, scope: String, name: String) -> Result<()> {
    let dir = recipes_dir(&app, &state, &project_id, &scope)?;
    blocking(move || recipes::delete(&dir, &name)).await
}
#[tauri::command]
async fn recipes_dry_run(recipe: recipes::Recipe, provider: String, slash: Vec<String>) -> Result<recipes::Plan> {
    recipes::plan(&recipe, &provider, &slash)
}
```

(A mirror task has no local root, so `recipes_list` then shows only global recipes.) Adjust `AppHandle`/`Manager` imports to what lib.rs already uses (`app.path()` needs `tauri::Manager`).

`src/preview.ts`: import and delegate before the `switch (command)`:

```ts
import { recipesCommand } from './preview-recipes';
// inside invoke(), before `switch (command) {`:
if (command.startsWith('recipes_')) { const r = recipesCommand(command, args); if (r.handled) return r.result as T; }
```

`src/main.ts` entry point (composer `+` menu item "Workflow recipes…", or a Go to anything action): open a dialog and mount the panel for the current task:

```ts
import { mountRecipes } from './recipes';
// in the click handler for the menu item, with `s` the current session:
const body = document.createElement('div');
/* put `body` into the app's dialog plate, then: */
mountRecipes(body, {
  call, projectId: s.projectId, provider: s.provider,
  slashCommands: async () => (await call<{ commands: { name: string }[] }>('list_slash_commands', { sessionId: s.id })).commands.map(c => c.name),
  enqueue: async text => { await call('queue_add', { sessionId: s.id, text, attachments: [] }); /* then refresh the queue panel as queue_add callers do (main.ts ~line 1999) */ },
  done: () => closeDialog(),
});
```

`playwright.config.ts` and `playwright.webkit.config.ts`: add `'**/recipes.spec.ts'` to `testMatch`. The spec imports `/src/recipes.ts` and `/src/preview-recipes.ts` directly, so it needs no main.ts wiring.
