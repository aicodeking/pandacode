import { ROW_TEXT } from './tool-text.ts';
import { clip, field, type Fields, type Trace } from './tool-trace.ts';
import { escape } from './dom.ts';
import { PARTIAL, resultCard } from './tool-trace.ts';
import { count, isObj, out, type PandaFamily, type Status } from './tool-trace-pandacode-parts.ts';
import { CATALOG } from './tool-trace-pandacode-catalog.ts';
export type { PandaFamily };

/** Rows and result cards for PandaCode's own MCP tools (team, tasks, VMs, simulators, design, browser, cloud, bots, Jev):
 *  builders in tool-trace-pandacode-parts.ts, one catalog entry per tool in tool-trace-pandacode-catalog.ts. Pure and escaped. */

const PREFIX = /^(?:mcp__)?pandacode(?:_architect)?(?:__| · |\.|\/)(.+)$/;

/** The bare PandaCode tool (`dispatch_workers`) from any harness's spelling, else undefined. */
export function pandacodeTool(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  const served = PREFIX.exec(n);
  const rest = (served ? served[1] : n).replace(/^pandacode_architect_/, '');
  if (rest.startsWith('pandacode_')) return rest.slice('pandacode_'.length) || undefined;
  return served && /^[a-z0-9_]+$/.test(rest) ? rest : undefined;
}

/** The tool's family (team, vm, …) for summaries and tints; undefined for non-PandaCode tools. */
export function pandacodeFamily(name: string): PandaFamily | undefined {
  const tool = pandacodeTool(name);
  return tool ? CATALOG[tool]?.family : undefined;
}

// --- Machine orchestration (docs/machine-orchestration.md) -------------------

/** One `pandacode_machine_list` row. `runningThreads` and `harnesses` come from newer hosts only. */
export type MachineListEntry = {
  id: string; name: string; platform: string; online: boolean; hosting: boolean; access: string | null;
  runningThreads?: number; harnesses?: unknown[];
};
export type MachineResult = { thread?: string; machine?: string; status?: string; linked?: boolean; pending?: boolean };
/** What a PandaCode machine tool returned (`{ thread, machine: { name }, status }`, or `{ linked, pending }` for a link). */
export function machineResult(output: string): MachineResult {
  const start = output.indexOf('{'), end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    const value: unknown = JSON.parse(output.slice(start, end + 1));
    if (!isObj(value)) return {};
    const { thread, machine, status, linked, pending } = value;
    const name = typeof machine === 'string' ? machine : isObj(machine) && typeof machine.name === 'string' ? machine.name : undefined;
    const str = (item: unknown) => typeof item === 'string' ? item : undefined;
    return { thread: str(thread), machine: name, status: str(status), linked: linked === true, pending: pending === true };
  } catch { return {}; }
}

/** `Starting a thread on ProMini`-style rows for the `machine_*` tools. */
/** Threads running across the listed machines (newer hosts report them). */
function busyThreads(output: string): number {
  const listed = out(output).obj.machines;
  if (!Array.isArray(listed)) return 0;
  return (listed as Partial<MachineListEntry>[]).reduce((sum, machine) => sum + (Number(machine?.runningThreads) || 0), 0);
}

function machineTrace(tool: string, fields: Fields, output: string, running: boolean): { verb: string; object: string } | undefined {
  const tense = (now: string, done: string) => running ? now : done;
  // `machine: "auto"` lets PandaCode pick, so only the tool's answer can name the machine.
  const asked = field(fields, 'machine'), result = machineResult(output);
  const name = result.machine ?? (asked.toLowerCase() === 'auto' ? '' : asked);
  const threads = Array.isArray(fields.threads) ? fields.threads.length : 0;
  const on = name ? clip(name, 40) : '';
  const title = field(fields, 'title') ? ` · ${clip(field(fields, 'title'), ROW_TEXT)}` : '';
  switch (tool) {
    case 'list': {
      const busy = busyThreads(output);
      return { verb: tense('Listing', 'Listed'), object: `machines${busy ? ` · ${count(busy, 'running thread')}` : ''}` };
    }
    case 'link':
      // The tool returns after ~40 s with `pending` while the card still waits for the user.
      if (!running && result.pending) return { verb: 'Waiting for you', object: 'to link a machine' };
      if (!running && result.linked) return { verb: 'Linked', object: on || 'a machine' };
      return { verb: tense('Asking', 'Asked'), object: `to link ${on || 'a machine'}` };
    case 'capabilities': return { verb: tense('Checking', 'Checked'), object: `orchestration capabilities${on ? ` on ${on}` : ''}` };
    case 'launch': {
      const verb = running ? 'Launching' : result.status === 'starting' ? 'Starting' : 'Launched';
      return { verb, object: `a thread on ${on || 'another machine'}${title}` };
    }
    case 'wait': return { verb: tense('Waiting on', 'Waited on'), object: threads ? count(threads, 'thread') : 'threads' };
    case 'read': return { verb: tense('Reading', 'Read'), object: 'a thread' };
    case 'stop': return { verb: tense('Stopping', 'Stopped'), object: `a thread${on ? ` on ${on}` : ''}` };
    case 'message': {
      const steer = field(fields, 'action') === 'steer';
      return { verb: steer ? tense('Steering', 'Steered') : tense('Messaging', 'Messaged'), object: 'a thread' };
    }
    default: return;
  }
}

/** Row parts for a known PandaCode tool; undefined lets the caller use the generic `Used [PandaCode] tool` row. */
export function pandacodeTrace(tool: string, fields: Fields, output: string, running: boolean): Omit<Trace, 'kind'> | undefined {
  const machine = tool.startsWith('machine_') ? machineTrace(tool.slice(8), fields, output, running) : undefined;
  if (machine) return { ...machine, chip: { icon: 'server', label: 'PandaCode', title: tool }, family: 'cloud', icon: 'server' };
  const spec = CATALOG[tool];
  if (!spec) return;
  const row = spec.row?.(fields, out(output)) ?? {};
  const verbs = row.verbs ?? spec.verbs;
  return { verb: verbs[running ? 0 : 1], chip: row.chip, object: row.object ?? '', ...(row.note ? { note: row.note } : {}), mono: row.mono, family: spec.family, icon: spec.icon };
}

/** Result card for a known PandaCode tool; failures lead with the error. Undefined for unknown tools. */
export function pandacodeCard(tool: string, fields: Fields, output: string, status: Status): string | undefined {
  const spec = CATALOG[tool];
  if (!spec) return;
  const parsed = out(output);
  const failed = status === 'failed' && output.trim() && !parsed.json;
  const error = failed ? `${output.length > 400 ? PARTIAL : ''}<p class="tool-trace-note is-error">${escape(clip(output, 400))}</p>` : '';
  const body = spec.card ? spec.card(fields, error ? { json: undefined, obj: {}, text: '' } : parsed, status) : error ? '' : resultCard(output);
  return error + body;
}

export const PANDACODE_TOOLS = Object.keys(CATALOG);

