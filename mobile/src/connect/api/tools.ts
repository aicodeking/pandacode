// Host calls for the `tools` feature group (src-tauri/src/remote/methods/tools.rs): progress
// snapshots, a task's fast check, recipes, skills, the run script and local servers. See
// docs/remote-access.md, "Adding a method".
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { hostCallOnce } from './github.ts';
import { assembleData, type DataPage } from '../../store/files.ts';
import type { FileTarget } from './files.ts';

export const TOOLS_METHODS = registerMethods(['progress.list', 'progress.thumb', 'progress.media', 'checks.plan', 'checks.run', 'recipes.list', 'recipes.plan',
  'recipes.run', 'skills.list', 'skills.activate', 'runScript.get', 'runScript.start', 'runScript.stop', 'localServers.list'] as const);

/** A check runs the project's tests: the host allows it 120 s. */
const CHECK_TIMEOUT_MS = 150_000;
/** A recipe's dry run asks the harness for its slash commands. */
const RECIPE_TIMEOUT_MS = 45_000;

const target = (t: FileTarget) => (t.sessionId ? { sessionId: t.sessionId } : { projectId: t.projectId });

// ---- progress ----

export interface Annotation { type: string; x: number; y: number; label?: string }
export interface Snapshot { id: string; iteration: number; title: string; note?: string; kind: 'image' | 'idea'; annotations: Annotation[]; createdAt: number; width?: number; height?: number }

/** Newest first. */
export const progressList = (deviceId: string, sessionId: string) =>
  hostCall<{ snapshots: Snapshot[]; truncated: boolean }>(deviceId, 'progress.list', { sessionId });

export const progressImage = (deviceId: string, sessionId: string, id: string, full: boolean) =>
  assembleData(offset => hostCall<DataPage>(deviceId, full ? 'progress.media' : 'progress.thumb', { sessionId, id, offset }, { background: !full }));

// ---- checks ----

export type CheckReport =
  | { checked: false; reason: string }
  | { checked: true; name: string; ok: boolean; output: string; truncated: boolean };

export const checksPlan = (deviceId: string, sessionId: string) => hostCall<{ name: string | null }>(deviceId, 'checks.plan', { sessionId });
export const runChecks = (deviceId: string, sessionId: string) => hostCall<CheckReport>(deviceId, 'checks.run', { sessionId }, { timeoutMs: CHECK_TIMEOUT_MS });

// ---- recipes ----

export interface RecipeStep { kind: 'prompt' | 'slash' | 'check' | 'approval'; text?: string; command?: string; requires?: string[] }
export interface Recipe { name: string; description: string; steps: RecipeStep[]; scope: 'project' | 'global' }
export interface StepReport { index: number; status: 'supported' | 'fallback' | 'manual' | 'blocked'; reason: string }
export interface RecipePlan { steps: StepReport[]; count: number; blocked: boolean }

export const recipesList = (deviceId: string, t: FileTarget) => hostCall<{ recipes: Recipe[] }>(deviceId, 'recipes.list', target(t)).then(r => r.recipes ?? []);
export const recipePlan = (deviceId: string, sessionId: string, name: string) =>
  hostCall<RecipePlan>(deviceId, 'recipes.plan', { sessionId, name }, { timeoutMs: RECIPE_TIMEOUT_MS });
/** Runs a recipe once per call: a lost reply is retried under the same `sendId` (github.ts `runOnce`). */
export const runRecipe = (deviceId: string, sessionId: string, name: string) =>
  hostCallOnce<{ sent: number; queued: number }>(deviceId, 'recipes.run', { sessionId, name }, { timeoutMs: RECIPE_TIMEOUT_MS });

// ---- skills ----

export interface SkillItem { id: string; name: string; kind: 'skill' | 'rule'; description: string; source: string; findings: number; acknowledged: boolean }
export interface SkillCell { id: string; scope: 'user' | 'project'; status: 'active' | 'outdated' | 'drifted' | 'missing' | 'prompt' | 'off'; surface: string }
export interface HarnessRow { harness: string; installed: boolean; prompt: boolean; cells: SkillCell[] }
export interface SkillsList { project: string | null; items: SkillItem[]; harnesses: HarnessRow[]; truncated: boolean }

export const skillsList = (deviceId: string, projectId?: string) => hostCall<SkillsList>(deviceId, 'skills.list', projectId ? { projectId } : {});
export const setSkill = (deviceId: string, change: { id: string; harness: string; scope: 'user' | 'project'; projectId?: string; active: boolean }) =>
  hostCall<{ kept: string[] }>(deviceId, 'skills.activate', change);

// ---- run script and servers ----

export interface RunScript { path: string; previewUrl?: string; previewPath?: string }
export interface LocalServer { port: number; process: string; url: string }

/** What runScript.get answers. `running` is the project's run-script terminal that runScript.stop
 * may close; null with the computer's Full access switch off, and absent from older hosts. */
export interface RunScriptStatus { script: RunScript | null; running?: { terminalId: string } | null }

export const runScriptGet = (deviceId: string, t: FileTarget) => runScriptStatus(deviceId, t).then(r => r.script);
export const runScriptStatus = (deviceId: string, t: FileTarget) => hostCall<RunScriptStatus>(deviceId, 'runScript.get', target(t));
export const runScriptStart = (deviceId: string, t: FileTarget) => hostCall<{ status: string; terminalId: string }>(deviceId, 'runScript.start', target(t));
/** Stops a run-script terminal this phone started (Full, and the computer's Full access switch). */
export const runScriptStop = (deviceId: string, terminalId: string) => hostCall<{ status: string }>(deviceId, 'runScript.stop', { terminalId });
export const localServers = (deviceId: string) => hostCall<{ servers: LocalServer[] }>(deviceId, 'localServers.list').then(r => r.servers ?? []);
