import type { Fields, Tool, Trace, TraceChip, TraceKind } from './tool-trace.ts';
import { COMPLETE, PARTIAL, badge, clip, excerptCard, field, head, lines, linesPre, list, mcpParts, parseJson, section } from './tool-trace.ts';
import { escape } from './dom.ts';
import { brandFor } from './trace-brands.ts';
import { describeShell, formatDuration, testSummary, testSummaryHtml } from './shell-intent.ts';
import { ROW_TEXT, strings } from './tool-text.ts';
import { generatedImagePath, imagePathOf } from './tool-names.ts';
import { toolImageCardHtml } from './tool-images.ts';
import { githubFile, githubFileCard, programsCard, programsTrace } from './tool-trace-legacy-rows.ts';
import { pandacodeTool } from './tool-trace-pandacode.ts';
export { shellRunningVerb, shellTrace, flagsOnly, type ShellRun } from './tool-trace-shell.ts';

/* What a (normalized, see tool-names.ts) tool call did, beyond its name: images it looked at, the intent of a
 * shell command (shell-intent.ts), background shells, tool loading, context compaction, waits, JS REPL runs,
 * GitHub API fetches and Codex's own items (agent collaboration, sub-agents, image generation, plans, reviews). Pure and escaped; tool-trace.ts asks here first and falls back to its own rows. */

/** `settled`: the verb already reads as the outcome (`Tests failed`), so a failure keeps it rather than writing `Couldn't …`. */
export type TraceParts = Omit<Trace, 'kind' | 'verb'> & { verb?: string; settled?: boolean };

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_IN_TEXT = /(?:^|[\s"'(=:])((?:\/|[A-Za-z]:\\)[^\s"'()<>]+\.(?:png|jpe?g|gif|webp))\b/i;
const DIMENSIONS = /\((\d{2,5})\s*[x×]\s*(\d{2,5})\)/;
/** `image/png 1280x775`, `image/png image, 1280x775 px` (DeepSeek's and OpenCode's `read_image`). */
const MIME_DIMENSIONS = /\bimage\/[\w.+-]+(?: image,)? (\d{2,5})x(\d{2,5})\b/;
const TAIL_LINES = 8;
const CODE_LINES = 12;
const CHIP_LIMIT = 3;
const BACKGROUND_CHECK = /^(BashOutput)$/;
const BACKGROUND_STOP = /^(TaskStop|KillShell|KillBash)$/;
const REPL = /^(node_repl|cua_repl)$/;
const CAPTION_LIMIT = 200;
const PLAN_LINES = 12;

const tense = (failed: boolean, present: string, past: string) => failed ? present : past;

function replTool(name: string): boolean {
  const { server, tool } = mcpParts(name);
  return REPL.test(server) && /^js/.test(tool);
}
function githubFetch(name: string, fields: Fields): string {
  const { server, tool } = mcpParts(name);
  const url = field(fields, 'url');
  return /codex_apps|github/i.test(server) && /github[._]fetch|^fetch$/i.test(tool) && /^https:\/\/(?:api\.github\.com|raw\.githubusercontent\.com|github\.com)\//.test(url) ? url : '';
}

/** A kind that a tool's name alone does not give away; `tool` is already normalized. */
export function specialKind(tool: Tool): TraceKind | undefined {
  // Codex's legacy `imageView` (ViewImage once normalized) kept no path.
  if (imagePathOf(tool) || tool.name === 'Generate image' || tool.name === 'ViewImage') return 'image';
  if (collabTool(tool.name) || tool.name === 'Sub-agent') return 'agent';
  if (tool.name === 'Plan') return 'todo';
  if (tool.name === 'Review') return 'tool';
  if (BACKGROUND_CHECK.test(tool.name) || BACKGROUND_STOP.test(tool.name)) return 'shell';
  if (/^(ToolSearch|Compact context|sleep)$/.test(tool.name)) return 'tool';
  if (tool.name === 'ListMcpTools') return 'mcp';
  return undefined;
}

/** PandaCode tools that capture or post an image; any other tool's text that merely names a .png gets no thumbnail. */
const IMAGE_TOOLS = /^(?:\w+_screenshot|progress_snapshot|capture_browser|read_moodboard_image|design_\w+)$/;

/** An image a PandaCode tool captured or was given (a screenshot path, a progress snapshot's image), else ''. */
export function pandacodeImage(name: string, fields: Fields, output: string): string {
  if (!IMAGE_TOOLS.test(pandacodeTool(name) ?? '')) return '';
  const given = field(fields, 'image', 'image_path', 'screenshot', 'path');
  if (IMAGE.test(given)) return given;
  const json = parseJson(output);
  const saved = json && typeof json === 'object' && !Array.isArray(json) ? json as Fields : {};
  const named = field(saved, 'path', 'image', 'screenshot', 'file');
  if (IMAGE.test(named)) return named;
  return IMAGE_IN_TEXT.exec(output.slice(0, 4000))?.[1] ?? '';
}

// --- Codex items ------------------------------------------------------------------

/** Codex's agent collaboration calls, recorded as `Agent · <tool>`: [verb a failure rewrites, finished verb, names its agents]. */
const COLLAB: Record<string, [string, string, boolean]> = {
  spawnAgent: ['Spawning', 'Spawned', false],
  sendInput: ['Sending input to', 'Sent input to', true],
  sendMessage: ['Sending message to', 'Sent message to', true],
  followupTask: ['Sending follow-up to', 'Sent follow-up to', true],
  resumeAgent: ['Resuming', 'Resumed', true],
  wait: ['Waiting for', 'Waited for', true],
  closeAgent: ['Closing', 'Closed', true],
  interruptAgent: ['Interrupting', 'Interrupted', true],
  listAgents: ['Listing', 'Listed', true],
};
function collabTool(name: string): string {
  const tool = /^Agent · (\w+)$/.exec(name)?.[1] ?? '';
  return Object.hasOwn(COLLAB, tool) ? tool : '';
}

type AgentState = { thread: string; status: string; message: string };
/** The adapter's `thread: status — message` lines, one per agent. */
export function agentStates(output: string): AgentState[] {
  return lines(output).flatMap(line => {
    const match = /^(\S[^:]*): ([\w-]+)(?: — (.*))?$/.exec(line.trim());
    return match ? [{ thread: match[1], status: match[2], message: match[3] ?? '' }] : [];
  });
}

function receivers(fields: Fields): string[] {
  return Array.isArray(fields.receiverThreadIds) ? fields.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

function agentCount(count: number): string {
  return count > 1 ? `${count} agents` : 'agent';
}

function collabTrace(tool: string, fields: Fields, failed: boolean, output: string): TraceParts {
  const [present, past, named] = COLLAB[tool];
  const model = field(fields, 'model');
  const prompt = clip(field(fields, 'prompt'), ROW_TEXT);
  const chip = model ? { icon: 'bot', label: model, title: model } : undefined;
  if (!named) return { verb: tense(failed, `${present} agent`, `${past} agent`), chip, object: '', note: prompt, family: 'agent', icon: 'bot' };
  const count = receivers(fields).length || agentStates(output).length;
  const noun = tool === 'listAgents' ? (count ? `${count} ${count === 1 ? 'agent' : 'agents'}` : 'agents') : agentCount(count);
  return { verb: tense(failed, `${present} ${noun}`, `${past} ${noun}`), object: '', note: prompt, family: 'agent', icon: tool === 'wait' ? 'clock' : 'bot' };
}

function subAgentTrace(fields: Fields, failed: boolean): TraceParts {
  const path = field(fields, 'agentPath');
  const kind = field(fields, 'kind');
  const label = path ? path.split(/[\\/]/).filter(Boolean).pop() ?? path : kind;
  const object = [path ? kind : '', field(fields, 'model')].filter(Boolean).join(' · ');
  return { verb: tense(failed, 'Running sub-agent', 'Ran sub-agent'), chip: label ? { icon: 'bot', label, title: path || label } : undefined, object, family: 'agent', icon: 'bot' };
}

function generatedImageTrace(tool: Tool, fields: Fields, failed: boolean, output: string): TraceParts {
  const path = generatedImagePath(tool);
  if (path) return { verb: tense(failed, 'Generating image', 'Generated image'), image: path, object: '', icon: 'images' };
  // No saved path: the record carries the failure's type, if anything.
  const reason = output.trim();
  // describeTool rewrites only a failed record's verb; a completed one that saved nothing says so itself.
  const verb = failed ? 'Generating image' : reason ? "Couldn't generate image" : 'Generated image';
  return reason ? { verb, object: clip(reason, ROW_TEXT), icon: 'images' } : { verb, object: '', note: clip(field(fields, 'revisedPrompt'), ROW_TEXT), icon: 'images' };
}

/** Codex marks a review twice: entering it names what is reviewed, leaving it carries the review. */
function reviewTrace(fields: Fields, failed: boolean, output: string): TraceParts {
  const target = field(fields, 'review');
  if (target || !output.trim()) return { verb: tense(failed, 'Starting review', 'Started review'), object: target ? `of ${clip(target, ROW_TEXT)}` : '', icon: 'check' };
  const first = lines(output).map(line => line.trim()).find(Boolean) ?? '';
  return { verb: tense(failed, 'Finishing review', 'Finished review'), object: '', note: clip(first.replace(/^[#*>\-\s]+/, ''), ROW_TEXT), icon: 'check' };
}

function codexTrace(tool: Tool, fields: Fields, failed: boolean, output: string): TraceParts | undefined {
  const name = tool.name;
  const collab = collabTool(name);
  if (collab) return collabTrace(collab, fields, failed, output);
  if (name === 'Sub-agent') return subAgentTrace(fields, failed);
  if (name === 'Generate image') return generatedImageTrace(tool, fields, failed, output);
  if (name === 'Plan') return { verb: tense(failed, 'Updating the plan', 'Updated the plan'), object: '', icon: 'plan' };
  if (name === 'Review') return reviewTrace(fields, failed, output);
  return undefined;
}

function agentStatesCard(output: string): string {
  const states = agentStates(output);
  return list(states.map(({ thread, status, message }) => ({ title: message || thread, meta: message ? clip(thread, 24) : '', hint: thread, badge: status })), states.length);
}

function collabCard(fields: Fields, output: string, failed: boolean): string {
  if (failed && !agentStates(output).length) return errorNote(output);
  const model = field(fields, 'model');
  const effort = field(fields, 'reasoningEffort');
  const top = model ? head(`<span class="tool-trace-route">${escape(clip(model, 40))}</span>`, effort) : '';
  const prompt = field(fields, 'prompt');
  const promptBody = prompt ? `${prompt.length > 400 ? PARTIAL : ''}<p class="tool-trace-prose">${escape(clip(prompt, 400))}</p>` : '';
  const states = agentStatesCard(output);
  const body = top + (states && promptBody ? section('Message', promptBody) + section('Agents', states) : promptBody + states);
  return body || (output.trim() ? excerptCard(output) : COMPLETE);
}

function textCard(text: string, label: string): string {
  const all = lines(text.trim());
  const shown = all.slice(0, PLAN_LINES);
  return shown.length ? (all.length > shown.length ? PARTIAL : '') + linesPre(shown, label) : COMPLETE;
}

function codexCard(tool: Tool, fields: Fields, output: string, failed: boolean): string | undefined {
  const name = tool.name;
  if (collabTool(name)) return collabCard(fields, output, failed);
  if (name === 'Sub-agent') return failed ? errorNote(output) : COMPLETE;
  if (name === 'Generate image') {
    const path = generatedImagePath(tool);
    const prompt = field(fields, 'revisedPrompt');
    if (path) return toolImageCardHtml(path, prompt ? { caption: clip(prompt, CAPTION_LIMIT) } : {});
    return section('Prompt', prompt ? `<p class="tool-trace-prose">${escape(clip(prompt, 400))}</p>` : '') + errorNote(output) || COMPLETE;
  }
  if (name === 'Plan') return failed ? errorNote(output) : textCard(output, 'Plan');
  if (name === 'Review') return failed ? errorNote(output) : field(fields, 'review') ? COMPLETE : textCard(output, 'Review');
  return undefined;
}


/** `1920 × 1080`, the one size format in rows and cards. */
function imageSize(output: string): string {
  const size = DIMENSIONS.exec(output) ?? MIME_DIMENSIONS.exec(output.slice(0, 1000));
  return size ? `${size[1]} × ${size[2]}` : '';
}

function imageTrace(tool: Tool, failed: boolean, output: string): TraceParts {
  const path = imagePathOf(tool);
  // A refused or failed view has no image to show: its file name says what it meant to view (`Denied: view [a.png]`).
  if (path && failed) return { chip: { icon: 'images', label: path.split('/').pop() || path, title: path }, object: '', icon: 'images' };
  // Without a path there is no thumbnail, so the sentence names what was viewed.
  return { ...(path ? { image: path } : { verb: tense(failed, 'Viewing image', 'Viewed image') }), object: imageSize(output), icon: 'images' };
}

function toolChip(name: string): TraceChip {
  const short = name.replace(/^mcp__.+?__/, '').replace(/^pandacode_/, '');
  return { icon: 'command', label: short, title: name };
}

function toolSearchTrace(fields: Fields, failed: boolean): TraceParts {
  const query = field(fields, 'query');
  const select = /^select:(.*)$/s.exec(query.trim());
  if (!select) return { verb: tense(failed, 'Searching tools', 'Searched tools'), object: query ? `for “${clip(query, ROW_TEXT)}”` : '', icon: 'search' };
  const names = select[1].split(',').map(name => name.trim()).filter(Boolean);
  const chips = names.slice(0, CHIP_LIMIT).map(toolChip);
  const more = names.length - chips.length;
  return { verb: tense(failed, 'Loading tools', names.length === 1 ? 'Loaded tool' : 'Loaded tools'), chips, object: more > 0 ? `+${more} more ${more === 1 ? 'tool' : 'tools'}` : '', icon: 'download' };
}

/** Tool names from a server listing: a JSON array, `{ tools: [...] }`, or one name per line. */
export function listedTools(output: string): string[] {
  const json = parseJson(output);
  const items = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as Fields).tools) ? (json as Fields).tools as unknown[] : undefined;
  if (items) return items.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? field(item as Fields, 'name', 'title') : '').filter(Boolean);
  return lines(output).map(line => line.trim().replace(/^[-*•]\s+/, '').split(/[\s:(]/, 1)[0] ?? '').filter(name => /^[\w.-]+$/.test(name));
}

function listToolsTrace(fields: Fields, output: string, failed: boolean): TraceParts {
  const server = field(fields, 'server', 'server_name') || 'MCP';
  const count = listedTools(output).length;
  const brand = brandFor(server);
  const verb = failed ? 'Listing tools from' : count ? `Listed ${count} ${count === 1 ? 'tool' : 'tools'} from` : 'Listed tools from';
  return { verb, chip: { icon: 'server', label: brand?.label ?? server, title: server, svg: brand?.svg }, object: '', family: 'mcp', icon: 'server' };
}

function replTrace(fields: Fields, failed: boolean): TraceParts {
  const title = field(fields, 'title', 'description');
  const code = field(fields, 'code', 'source');
  const first = lines(code).map(line => line.trim()).find(line => line && !line.startsWith('//')) ?? '';
  return { verb: tense(failed, 'Running JS:', 'Ran JS:'), object: clip(title || first, ROW_TEXT), mono: !title, family: 'mcp', icon: 'terminal' };
}

const SINGULAR: Record<string, string> = { pulls: 'pull', issues: 'issue', commits: 'commit', releases: 'release', branches: 'branch', comments: 'comment', runs: 'run' };

/** `pulls for owner/repo`, `pull #12 in owner/repo`, `issues matching … in owner/repo`. */
export function githubTarget(url: string): { search: boolean; object: string } {
  const file = githubFile(url);
  if (file) return { search: false, object: `${clip(file.path, ROW_TEXT)} from ${file.repo}` };
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'search') {
      const query = parsed.searchParams.get('q') ?? '';
      const repo = /repo:(\S+)/.exec(query)?.[1];
      const rest = clip(query.replace(/repo:\S+/, '').trim(), ROW_TEXT);
      return { search: true, object: `${parts[1] ?? 'GitHub'}${rest ? ` matching ${rest}` : ''}${repo ? ` in ${repo}` : ''}` };
    }
    if (parts[0] === 'repos' && parts.length >= 3) {
      const repo = `${parts[1]}/${parts[2]}`;
      const [resource, id, ...sub] = parts.slice(3);
      if (!resource) return { search: false, object: `repo ${repo}` };
      if (id) return { search: false, object: `${SINGULAR[resource] ?? resource} ${/^\d+$/.test(id) ? '#' + id : clip(id, 30)}${sub.length ? ' ' + sub.join(' ') : ''} in ${repo}` };
      return { search: false, object: `${resource.replace(/_/g, ' ')} for ${repo}` };
    }
    return { search: false, object: clip(parts.join('/'), ROW_TEXT) };
  } catch {
    return { search: false, object: clip(url, ROW_TEXT) };
  }
}

const APP_VERBS: Record<string, [string, string]> = { fetch: ['Fetching', 'Fetched'], get: ['Fetching', 'Fetched'], search: ['Searching', 'Searched'], list: ['Listing', 'Listed'] };
const APP_NOUNS: Record<string, string> = { pr: 'PR', prs: 'PRs' };

/** `owner/repo` from a GitHub app call's fields. */
function appRepo(fields: Fields): string {
  const full = field(fields, 'repo_full_name', 'repository_full_name', 'repo');
  if (full.includes('/')) return full;
  const owner = field(fields, 'owner'), name = field(fields, 'repo_name', 'repository_name');
  return owner && name ? `${owner}/${name}` : full;
}

/** `codex_apps · github.fetch_workflow_run_jobs` → `Fetched [GitHub] workflow run jobs for owner/repo`, from the name's suffix. */
function githubAppTrace(name: string, fields: Fields, failed: boolean): TraceParts | undefined {
  const { server, tool } = mcpParts(name);
  const match = /^github\.(fetch|get|search|list)_(\w+)$/.exec(tool);
  if (!/codex_apps/i.test(server) || !match) return undefined;
  const [present, past] = APP_VERBS[match[1]];
  const noun = match[2].split('_').map(word => APP_NOUNS[word] ?? word).join(' ');
  const repo = appRepo(fields);
  const number = fields.issue_number ?? fields.pr_number ?? fields.pull_number;
  const path = field(fields, 'path');
  const query = clip(field(fields, 'query'), ROW_TEXT);
  const object = path && noun === 'file' ? `${clip(path.split('/').pop() ?? path, ROW_TEXT)}${repo ? ` from ${repo}` : ''}`
    : typeof number === 'number' ? `${noun} #${number}${repo ? ` in ${repo}` : ''}`
    : [noun, query ? `for ${query}` : repo ? `for ${repo}` : '', query && repo && !query.includes(repo) ? `in ${repo}` : ''].filter(Boolean).join(' ');
  const brand = brandFor('github');
  return { verb: tense(failed, present, past), chip: { icon: 'github', label: brand?.label ?? 'GitHub', title: name, svg: brand?.svg }, object, family: 'mcp', icon: match[1] === 'search' ? 'search' : 'github' };
}

function githubTrace(url: string, failed: boolean): TraceParts {
  const { search, object } = githubTarget(url);
  const brand = brandFor('github');
  const verb = search ? tense(failed, 'Searching', 'Searched') : tense(failed, 'Fetching', 'Fetched');
  return { verb, chip: { icon: 'github', label: brand?.label ?? 'GitHub', title: url, svg: brand?.svg }, object, family: 'mcp', icon: 'github' };
}

/** Claude in Chrome's `computer` tool taking a screenshot (`mcp__claude-in-chrome__computer`, `action: screenshot`). */
export function browserScreenshot(name: string, fields: Fields): boolean {
  const { server, tool } = mcpParts(name);
  return /chrome/i.test(server) && tool === 'computer' && field(fields, 'action') === 'screenshot';
}

/** Harness calls that are a sentence of their own: [running, finished, icon]. Kimi's `Requesting to enter plan mode` and
 *  OpenCode's `Begin file change capture …` reach here under the names tool-names.ts gives them. */
const HARNESS_ROWS: Record<string, [string, string, string]> = {
  EnterPlanMode: ['Entering plan mode', 'Entered plan mode', 'check'],
  AskUserQuestion: ['Asking you a question', 'Asked you a question', 'chat'],
  BeginFileCapture: ['Starting to track file changes', 'Started tracking file changes', 'edit'],
};
const QUESTION_LIMIT = ROW_TEXT;
function harnessTrace(name: string, fields: Fields, failed: boolean): TraceParts | undefined {
  const row = HARNESS_ROWS[name];
  if (!row) return undefined;
  const first = Array.isArray(fields.questions) && fields.questions[0] && typeof fields.questions[0] === 'object' ? field(fields.questions[0] as Fields, 'question') : '';
  return { verb: tense(failed, row[0], row[1]), object: '', icon: row[2], ...(first ? { note: clip(first, QUESTION_LIMIT) } : {}) };
}

/** Claude Code's rarer harness tools, each a sentence: `Watched tail -f a.log`, `Messaged [worker-1] summary`,
 *  `Sent notification “…”`, `Scheduled wake-up in [5m] reason`, `Listed agents`. */
function agentToolTrace(name: string, fields: Fields, failed: boolean): TraceParts | undefined {
  if (name === 'Monitor') return { verb: tense(failed, 'Watching', 'Watched'), object: clip(field(fields, 'command', 'description'), ROW_TEXT), mono: Boolean(field(fields, 'command')), icon: 'terminal' };
  if (name === 'ListAgents') return { verb: tense(failed, 'Listing agents', 'Listed agents'), object: '', icon: 'bot' };
  if (name === 'PushNotification') {
    const message = field(fields, 'message', 'title');
    return { verb: tense(failed, 'Sending notification', 'Sent notification'), object: message ? `“${clip(message, ROW_TEXT)}”` : '', icon: 'info' };
  }
  if (name === 'SendMessage') {
    const to = field(fields, 'to', 'recipient');
    const chip = to ? { icon: 'bot', label: clip(to, 40), title: to } : undefined;
    return { verb: tense(failed, 'Messaging', 'Messaged'), chip, object: clip(field(fields, 'summary', 'message'), ROW_TEXT), icon: 'chat' };
  }
  if (name !== 'ScheduleWakeup') return undefined;
  const seconds = Number(fields.delaySeconds);
  const delay = Number.isFinite(seconds) && seconds > 0 ? formatDuration(seconds * 1000) : '';
  const chip = delay ? { icon: 'clock', label: delay, title: `${seconds}s` } : undefined;
  return { verb: tense(failed, delay ? 'Scheduling wake-up in' : 'Scheduling wake-up', delay ? 'Scheduled wake-up in' : 'Scheduled wake-up'), chip, object: clip(field(fields, 'reason'), ROW_TEXT), icon: 'clock' };
}

/** Row parts for the tools above; undefined leaves the row to tool-trace.ts. `tool` is normalized. */
export function specialTrace(kind: TraceKind, tool: Tool, fields: Fields, failed: boolean, output: string): TraceParts | undefined {
  const name = tool.name;
  const codex = codexTrace(tool, fields, failed, output);
  if (codex) return codex;
  if (kind === 'image') return imageTrace(tool, failed, output);
  const programs = kind === 'shell' ? programsTrace(fields, failed) : undefined;
  if (programs) return programs;
  if (BACKGROUND_CHECK.test(name)) {
    const id = field(fields, 'shell_id', 'bash_id', 'task_id', 'id');
    return { verb: tense(failed, 'Checking background shell', 'Checked background shell'), chip: id ? { icon: 'terminal', label: id, title: id } : undefined, object: '', icon: 'terminal' };
  }
  if (BACKGROUND_STOP.test(name)) {
    const id = field(fields, 'task_id', 'shell_id', 'bash_id', 'id');
    const reason = field(fields, 'reason');
    // Kimi records why it stopped a task; its default reason says nothing.
    const note = reason && !/^Stopped by \w+$/.test(reason) ? { note: clip(reason, ROW_TEXT) } : {};
    return { verb: tense(failed, 'Stopping background task', 'Stopped background task'), chip: id ? { icon: 'stop', label: id, title: id } : undefined, object: '', icon: 'stop', ...note };
  }
  if (name === 'ToolSearch') return toolSearchTrace(fields, failed);
  if (name === 'Compact context') return { verb: tense(failed, 'Compacting context', 'Compacted context'), object: '', icon: 'archive', quiet: true };
  if (name === 'sleep') {
    // Kimi waits on a background task up to a timeout (tool-names.ts gives it `upTo`).
    if (typeof fields.upTo === 'string' && fields.upTo) return { verb: tense(failed, 'Waiting', 'Waited'), object: `up to ${fields.upTo}`, icon: 'clock' };
    const ms = Number(fields.durationMs);
    // Codex records some sleeps without a duration.
    return { verb: tense(failed, 'Waiting', 'Waited'), object: Number.isFinite(ms) && ms > 0 ? formatDuration(ms) : 'briefly', icon: 'clock' };
  }
  if (name === 'ListMcpTools') return listToolsTrace(fields, output, failed);
  const harness = harnessTrace(name, fields, failed) ?? agentToolTrace(name, fields, failed);
  if (harness) return harness;
  if (kind !== 'mcp') return undefined;
  if (replTool(name) && field(fields, 'code', 'source', 'title')) return replTrace(fields, failed);
  if (browserScreenshot(name, fields)) return { verb: tense(failed, 'Taking a screenshot', 'Took a screenshot'), object: '', family: 'mcp', icon: 'camera' };
  const url = githubFetch(name, fields);
  return url ? githubTrace(url, failed) : githubAppTrace(name, fields, failed);
}

// --- Cards ----------------------------------------------------------------------

function errorNote(output: string): string {
  return output.trim() ? `${output.length > 300 ? PARTIAL : ''}<p class="tool-trace-note is-error">${escape(clip(output, 300))}</p>` : '';
}

function tail(text: string, label: string): string {
  const all = lines(text.trimEnd());
  const shown = all.slice(-TAIL_LINES);
  return (all.length > shown.length ? PARTIAL : '') + linesPre(shown, label);
}

function backgroundCheckCard(fields: Fields, output: string): string {
  const status = /<status>([\w-]+)<\/status>/.exec(output)?.[1] ?? '';
  const id = field(fields, 'shell_id', 'bash_id', 'task_id', 'id');
  const shell = id ? `<span class="tool-trace-chip" title="${escape(id)}"><b>${escape(clip(id, 40))}</b></span>` : '';
  const streams = [...output.matchAll(/<(stdout|stderr)>([\s\S]*?)<\/\1>/g)].map(match => match[2]).join('\n');
  const body = streams || output.replace(/<\/?[a-z_]+>/g, '').replace(/^[ \t]*(running|completed|failed)[ \t]*$/m, '');
  // The status sits inline beside the shell id, not on a band of its own.
  const top = status ? head(shell + badge(status)) : '';
  return top + tail(body, 'Background shell output, last lines') || COMPLETE;
}

function backgroundStopCard(output: string, failed: boolean): string {
  if (failed) return errorNote(output);
  const json = parseJson(output);
  const record = json && typeof json === 'object' && !Array.isArray(json) ? json as Fields : {};
  const command = field(record, 'command') || parenthesized(field(record, 'message'));
  return command ? head(`<code class="tool-trace-command">${escape(clip(command, 300))}</code>`) : COMPLETE;
}

/** `Shell b1 killed (npm run dev)` → `npm run dev`: from the first `(` to a closing `)` that ends the text. */
function parenthesized(message: string): string {
  const text = message.trimEnd();
  const open = text.indexOf('(');
  return open >= 0 && text.endsWith(')') ? text.slice(open + 1, -1) : '';
}

function listToolsCard(output: string): string {
  const names = listedTools(output);
  return names.length ? list(names.map(title => ({ title })), names.length) : excerptCard(output);
}

function replCard(fields: Fields, output: string, failed: boolean): string {
  const code = lines(field(fields, 'code', 'source'));
  const shown = code.slice(0, CODE_LINES);
  const codeBlock = shown.length ? (code.length > shown.length ? PARTIAL : '') + linesPre(shown, 'JavaScript') : '';
  const result = failed ? errorNote(output) : excerptCard(output);
  return section('Code', codeBlock) + section('Result', result);
}

/** The JSON a Codex app call returned: `structuredContent.content`, a `content` string, or the body itself. */
function githubPayload(output: string): unknown {
  const start = output.search(/^[[{]/m);
  if (start < 0) return undefined;
  const outer = parseJson(output.slice(start));
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return outer;
  const record = outer as Fields;
  const structured = record.structuredContent && typeof record.structuredContent === 'object' ? record.structuredContent as Fields : undefined;
  const inner = typeof structured?.content === 'string' ? structured.content : typeof record.content === 'string' ? record.content : '';
  return inner ? parseJson(inner) ?? outer : structured ?? outer;
}

function githubItem(item: Fields): { title: string; meta: string; hint: string } {
  const number = typeof item.number === 'number' ? `#${item.number} ` : '';
  const user = item.user && typeof item.user === 'object' ? field(item.user as Fields, 'login') : '';
  const draft = item.draft === true ? 'draft' : '';
  const meta = [draft || field(item, 'state'), user].filter(Boolean).join(' · ');
  return { title: number + (field(item, 'title', 'name', 'full_name', 'sha') || 'item'), meta, hint: field(item, 'html_url', 'url') };
}

function githubCard(output: string): string {
  const payload = githubPayload(output);
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Fields : undefined;
  const items = Array.isArray(payload) ? payload : Array.isArray(record?.items) ? record.items as unknown[] : undefined;
  const objects = (items ?? []).filter((item): item is Fields => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  if (objects.length) {
    const total = typeof record?.total_count === 'number' ? record.total_count : objects.length;
    return list(objects.map(githubItem), total);
  }
  if (record && (record.title || record.name)) return list([githubItem(record)]);
  return excerptCard(output.replace(/^Action completed\.\s*/, ''));
}

/** Card body for the tools above (COMPLETE when the row says it all); undefined leaves it to tool-trace.ts. */
export function specialCard(kind: TraceKind, tool: Tool, fields: Fields, output: string): string | undefined {
  const name = tool.name, failed = tool.status === 'failed';
  const codex = codexCard(tool, fields, output, failed);
  if (codex !== undefined) return codex;
  if (kind === 'image') {
    const path = imagePathOf(tool);
    if (!path) return failed ? errorNote(output) : COMPLETE;
    // The row already names the size (`Viewed [thumb] 1920 × 1080`); the card does not repeat it.
    return toolImageCardHtml(path, {});
  }
  const programs = kind === 'shell' ? programsCard(fields, output) : undefined;
  if (programs !== undefined) return programs;
  if (kind === 'web' && !field(fields, 'query', 'q') && !output.trim()) return COMPLETE;
  if (BACKGROUND_CHECK.test(name)) return failed ? errorNote(output) : backgroundCheckCard(fields, output);
  if (BACKGROUND_STOP.test(name)) return backgroundStopCard(output, failed);
  if (name === 'ToolSearch') return failed ? errorNote(output) : COMPLETE;
  if (name === 'Compact context' || name === 'sleep') return failed ? errorNote(output) : COMPLETE;
  if (name === 'ListMcpTools') return failed ? errorNote(output) : listToolsCard(output);
  if (kind !== 'mcp') return undefined;
  if (replTool(name) && field(fields, 'code', 'source', 'title')) return replCard(fields, output, failed);
  const url = githubFetch(name, fields);
  if (url) return failed ? errorNote(output) : (githubFile(url) && githubFileCard(output)) || githubCard(output);
  return undefined;
}

/** A shell call's test results (node:test, Playwright, Vitest, Jest, cargo, pytest, go), or ''. */
export function testSummaryCard(output: string): string {
  const summary = testSummary(output);
  return summary ? testSummaryHtml(summary) : '';
}

/** Codex agent calls count by their own verb, without a count (`Waited for agents`); spawns stay `Started N agents`. */
const COLLAB_NOUNS: Record<string, [string, string]> = {
  sendInput: ['Messaging', 'Messaged'], sendMessage: ['Messaging', 'Messaged'], followupTask: ['Messaging', 'Messaged'],
  wait: ['Waiting for', 'Waited for'], resumeAgent: ['Resuming', 'Resumed'], closeAgent: ['Closing', 'Closed'],
  interruptAgent: ['Interrupting', 'Interrupted'], listAgents: ['Listing', 'Listed'],
};
type SummaryNoun = { key: string; noun: [string, string, string, string] };
/** How a call counts in a group summary when its kind's noun would misread it; `tool` is normalized. An empty singular means no count. */
export function specialSummaryNoun(tool: Tool): SummaryNoun | undefined {
  if (tool.name === 'Generate image') return { key: 'generated', noun: ['Generating', 'Generated', 'image', 'images'] };
  const collab = collabTool(tool.name);
  const verbs = collab ? COLLAB_NOUNS[collab] : undefined;
  return verbs ? { key: `agent-${verbs[1]}`, noun: [verbs[0], verbs[1], '', 'agents'] } : undefined;
}

const SHELL_NOUNS: Partial<Record<string, [string, string, string, string]>> = {
  read: ['Reading', 'Read', 'file', 'files'],
  search: ['Running', 'Ran', 'search', 'searches'],
  test: ['Running', 'Ran', 'tests', 'tests'],
  install: ['Installing', 'Installed', 'packages', 'packages'],
};
/** Shell steps that change a file's text (Codex's `apply_patch`, `sed -i`, `> file`) count with the files an agent edited. */
const FILE_EDIT_VERBS: Record<string, { key: string; noun: [string, string, string, string] }> = {
  Edited: { key: 'edit', noun: ['Editing', 'Edited', 'file', 'files'] },
  Wrote: { key: 'write', noun: ['Writing', 'Wrote', 'file', 'files'] },
};
/** How a shell call counts in a group summary: reads with files, searches with searches, edits with edits, test runs apart. */
export function shellSummaryNoun(command: string): { key: string; noun: [string, string, string, string] } | undefined {
  if (!command) return undefined;
  const intent = describeShell(command);
  const edit = intent.kind === 'file' && intent.steps === 1 ? FILE_EDIT_VERBS[intent.verb] : undefined;
  if (edit) return edit;
  const noun = SHELL_NOUNS[intent.kind];
  return noun ? { key: intent.kind, noun } : undefined;
}
