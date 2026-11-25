// Guards the native command surface: every `#[tauri::command]` in this branch's
// modules stays registered in `main_invoke_handler` (a merge can silently drop a
// line from `generate_handler!`). The web-tab review of every registered command
// (`WEB_ALLOWED_COMMANDS` / `DESKTOP_ONLY`) is checked only by the Rust test
// `web_server::tests::every_main_window_command_is_reviewed_for_web`, which CI
// runs; this file only checks that guard still exists, so its parser is not duplicated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const COMMAND_MODULES = [
  "src-tauri/src/providers/warm.rs",
  "src-tauri/src/explore.rs",
  "src-tauri/src/architect.rs",
  "src-tauri/src/custom_tools/ipc.rs",
];

const stripLineComment = (line) => line.split("//")[0];

/** Names of `#[tauri::command]` functions, skipping attributes, docs and blank lines in between. */
export function parseTauriCommands(source) {
  const names = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*#\[tauri::command\b/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j].trim();
      if (line === "" || line.startsWith("#[") || line.startsWith("//")) continue;
      const match = line.match(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      assert.ok(match, `#[tauri::command] at line ${i + 1} not followed by a fn: ${line}`);
      names.push(match[1]);
      break;
    }
  }
  return names;
}

/** Command names inside `generate_handler![...]` of `pub(crate) fn main_invoke_handler`. */
export function parseMainInvokeHandler(source) {
  const start = source.indexOf("pub(crate) fn main_invoke_handler");
  assert.ok(start >= 0, "main_invoke_handler not found");
  const open = source.indexOf("generate_handler![", start);
  assert.ok(open >= 0, "generate_handler! not found in main_invoke_handler");
  const close = source.indexOf("];", open);
  assert.ok(close > open, "unterminated generate_handler!");
  return source
    .slice(open + "generate_handler![".length, close)
    .split("\n")
    .map((line) => stripLineComment(line).trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => line.split(","))
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => path.split("::").pop());
}

export function missingRegistrations(commands, registered) {
  const set = new Set(registered);
  return commands.filter((name) => !set.has(name));
}

export function duplicates(names) {
  const seen = new Set();
  return [...new Set(names.filter((name) => (seen.has(name) ? true : (seen.add(name), false))))];
}

const lib = read("src-tauri/src/lib.rs");
const web = read("src-tauri/src/web_server.rs");
const registered = parseMainInvokeHandler(lib);
const branchCommands = COMMAND_MODULES.flatMap((path) => parseTauriCommands(read(path)));

test("every branch #[tauri::command] is registered in main_invoke_handler", () => {
  assert.ok(branchCommands.length >= 17, `parsed only ${branchCommands.length} branch commands`);
  assert.deepEqual(duplicates(branchCommands), []);
  assert.deepEqual(missingRegistrations(branchCommands, registered), [], "add these to main_invoke_handler in lib.rs");
});

test("main_invoke_handler parses sanely and has no duplicates", () => {
  assert.ok(registered.length > 300, `parsed only ${registered.length} commands`);
  for (const name of registered) assert.match(name, /^[A-Za-z0-9_]+$/);
  assert.deepEqual(duplicates(registered), []);
});

test("the Rust web-tab review guard still exists", () => {
  const guard = web.match(/#\[test\]\s*fn every_main_window_command_is_reviewed_for_web\(\)\s*\{/);
  assert.ok(guard, "web_server.rs must keep #[test] fn every_main_window_command_is_reviewed_for_web()");
  const rest = web.slice(guard.index + guard[0].length);
  const next = rest.search(/\n\s*#\[(?:tokio::)?test\]/);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  for (const name of ["main_window_commands()", "WEB_ALLOWED_COMMANDS", "web_blocked_command("]) {
    assert.ok(body.includes(name), `the web review guard no longer references ${name}`);
  }
  assert.match(web, /fn main_window_commands\(\)[\s\S]*?main_invoke_handler/, "main_window_commands must read main_invoke_handler");
  assert.match(web, /const DESKTOP_ONLY\b/, "web_blocked_command must keep its DESKTOP_ONLY list");
});

test("guards catch synthetic drift", () => {
  const module = [
    "#[tauri::command]",
    "/// doc",
    "#[allow(dead_code)]",
    "pub(crate) async fn alpha() {}",
    "#[tauri::command(rename_all = \"snake_case\")]",
    "pub fn beta() {}",
  ].join("\n");
  const commands = parseTauriCommands(module);
  assert.deepEqual(commands, ["alpha", "beta"]);
  const handler = [
    "pub(crate) fn main_invoke_handler(invoke: X) -> bool {",
    "    let handler = tauri::generate_handler![",
    "        m::alpha, // beta was dropped in a merge",
    "        #[cfg(test)]",
    "        m::alpha,",
    "        gamma, overlay_show,",
    "    ];",
  ].join("\n");
  const reg = parseMainInvokeHandler(handler);
  assert.deepEqual(missingRegistrations(commands, reg), ["beta"]);
  assert.deepEqual(duplicates(reg), ["alpha"]);
  assert.deepEqual(reg, ["alpha", "alpha", "gamma", "overlay_show"]);
});
