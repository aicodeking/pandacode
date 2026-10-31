import type { ToolActivity } from './types';
import { escape, icon } from './dom.ts';
import { machineResult, pandacodeTool } from './tool-trace-pandacode.ts';
import { PARTIAL, describeTool, toolFailed, summarizeGroup, summaryIcons, toolPreview, traceIcon, traceRowHtml } from './tool-trace.ts';

const MAX_CONTENT = 100_000;
const MAX_DETAIL = 20_000;
const MAX_LABEL = 256;
const MAX_ID = 512;

/** Read the versioned record without treating arbitrary JSON or older labels as a tool. */
export function decodeToolActivity(content: string): ToolActivity | undefined {
  if (content.length > MAX_CONTENT || !content.trimStart().startsWith('{')) return;
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (record.type !== 'tool_activity' || record.version !== 1
      || typeof record.id !== 'string' || record.id.length > MAX_ID
      || typeof record.name !== 'string' || record.name.length > MAX_LABEL
      || (record.status !== 'running' && record.status !== 'completed' && record.status !== 'failed')
      || typeof record.input !== 'string' || record.input.length > MAX_DETAIL
      || typeof record.output !== 'string' || record.output.length > MAX_DETAIL) return;
    return { id: record.id, name: record.name, status: record.status, input: record.input, output: record.output };
  } catch {
    return;
  }
}

function bounded(value: string, limit = MAX_DETAIL): string {
  return value.length > limit ? value.slice(0, limit) + '\n[Display truncated]' : value;
}

function section(kind: 'input' | 'output', content: string): string {
  const label = kind === 'input' ? 'Input' : 'Output';
  return `<section class="tool-activity-section" data-tool-section="${kind}"><h4>${label}</h4><pre tabindex="0" aria-label="Tool ${kind}">${escape(bounded(content))}</pre></section>`;
}

/** The row's verb already says a call is running or done; a note appears only when nothing else would explain an empty body. */
function toolNote(tool: ToolActivity): string {
  if (tool.output.trim()) return '';
  const note = tool.status === 'running' ? tool.input.trim() ? '' : 'Waiting for tool details…'
    : tool.status === 'failed' ? 'No output was recorded.' : '';
  return note ? `<p class="tool-activity-note">${note}</p>` : '';
}

const RAW_LABEL = 'Raw input and output';
const CODE_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5M13.5 4l-3 16"/></svg>';

/** The recorded input/output: behind a quiet `</>` button in the card's corner only when the card leaves something out; with no card they show open. */
function rawRecord(tool: ToolActivity, preview: string): string {
  // A running call without a card has nothing to show yet, and a PandaCode row with no card and no output already says it all.
  if (preview ? !preview.includes(PARTIAL) : tool.status === 'running' || pandacodeTool(tool.name) && !tool.output.trim()) return '';
  const sections = (tool.input.trim() ? section('input', tool.input) : '') + (tool.output.trim() ? section('output', tool.output) : '');
  return sections ? `<details class="tool-trace-raw"${preview ? '' : ' open'}><summary aria-label="${RAW_LABEL}" title="${RAW_LABEL}">${CODE_ICON}</summary><div class="tool-trace-raw-body">${sections}</div></details>` : '';
}

/** Caller owns the stable key and restores native details.open when replacing activity rows. */
export function renderToolActivity(content: string | ToolActivity, key: string): string {
  const tool = typeof content === 'string' ? decodeToolActivity(content) : content;
  if (!tool) return renderLegacyTool(content as string, key);
  const named = { ...tool, name: tool.name.slice(0, MAX_LABEL) };
  const trace = describeTool(named);
  const failed = toolFailed(named);
  const lead = icon(failed ? 'alert' : traceIcon(trace), 'tool-trace-icon');
  const preview = toolPreview(named);
  const visible = preview.replace(/<!--trace-[a-z]+-->/g, '');
  // The card and its raw `</>` toggle share a frame so the toggle can sit in the card's corner.
  const body = visible ? `<div class="tool-trace-frame">${visible}${rawRecord(tool, preview)}</div>${toolNote(tool)}` : toolNote(tool) + rawRecord(tool, preview);
  const attrs = `data-tool-key="${escape(key)}" data-tool-status="${escape(tool.status)}" data-tool-kind="${trace.kind}"${trace.family ? ` data-tool-family="${escape(trace.family)}"` : ''} data-tool-name="${escape(named.name)}"${failed ? ' data-tool-failed' : ''}`;
  // A launched machine thread is named on the row, so the transcript can group launches into one card.
  const thread = tool.status === 'completed' && tool.name.endsWith('machine_launch') ? machineResult(tool.output).thread : undefined;
  // Nothing beyond the row: a plain line, not an empty disclosure.
  if (!body) return `<div class="tool-activity tool-trace" ${attrs} data-static><div class="tool-trace-summary" title="${escape(named.name || 'Tool')}">${lead}${traceRowHtml(trace)}</div></div>`;
  return `<details class="tool-activity tool-trace" ${attrs}${thread ? ` data-machine-thread="${escape(thread)}"` : ''}><summary title="${escape(named.name || 'Tool')}">${lead}${traceRowHtml(trace)}${icon('chevron', 'tool-trace-chevron')}</summary><div class="tool-activity-body">${visible ? body : `<div class="tool-trace-frame">${body}</div>`}</div></details>`;
}

function renderLegacyTool(content: string, key: string): string {
  const text = bounded(content).trim();
  const newline = text.indexOf('\n');
  const name = bounded(newline < 0 ? text : text.slice(0, newline), MAX_LABEL) || 'Tool activity';
  const remainder = newline < 0 ? '' : text.slice(newline + 1).trim();
  const body = remainder
    ? `<pre class="tool-activity-legacy-body" tabindex="0" aria-label="Recorded tool details">${escape(remainder)}</pre>`
    : '<p class="tool-activity-note">Details were not recorded for this earlier tool call.</p>';
  return `<details class="tool-activity" data-tool-key="${escape(key)}"><summary>${icon('terminal')}<span class="tool-activity-name">${escape(name)}</span>${icon('chevron')}</summary><div class="tool-activity-body">${body}</div></details>`;
}

/** Generic status messages are plain rows, not empty expandable tool calls. */
export function renderToolStatus(content: string): string {
  return `<div class="tool-activity-status-row">${icon('terminal')}<span>${escape(bounded(content))}</span></div>`;
}

export type ToolRun<T> = { kind: 'tools'; key: string; items: T[] } | { kind: 'message'; item: T };

/** Narration/status rows are boundaries; each group keeps its first call's stable key. */
export function groupToolRuns<T>(entries: T[], toolKey: (entry: T) => string | undefined): ToolRun<T>[] {
  const runs: ToolRun<T>[] = [];
  for (const entry of entries) {
    const key = toolKey(entry);
    if (key === undefined) { runs.push({ kind: 'message', item: entry }); continue; }
    const previous = runs[runs.length - 1];
    if (previous?.kind === 'tools' && previous.items.length < 5) previous.items.push(entry);
    else runs.push({ kind: 'tools', key, items: [entry] });
  }
  return runs;
}

/** The folded header's mark stack: brand logos for MCP servers, line icons otherwise. */
export function toolStackHtml(tools: (ToolActivity | undefined)[]): string {
  return `<span class="tool-trace-stack" aria-hidden="true">${summaryIcons(tools).join('')}</span>`;
}

export function renderToolGroup(entries: { key: string; content: string | ToolActivity }[], expanded = false, live = false): string {
  if (!entries.length) return '';
  const tools = entries.map(entry => typeof entry.content === 'string' ? decodeToolActivity(entry.content) : entry.content);
  const failed = tools.some(tool => tool && toolFailed(tool));
  const running = tools.some(tool => tool?.status === 'running');
  const summary = summarizeGroup(tools, { live });
  const stack = toolStackHtml(tools);
  const status = (summary.running ? `<span class="tool-group-status is-running"> · ${summary.running} running</span>` : '')
    + (summary.failed ? `<span class="tool-group-status has-failure"> · ${summary.failed} failed</span>` : '');
  const sentence = summary.sentence;
  return `<details class="tool-group" data-tool-group-key="${escape('group:' + entries[0].key)}"${running ? ' data-running' : ''}${expanded ? ' open' : ''}><summary class="tool-group-summary">${failed ? icon('alert') : ''}<span class="tool-group-label">${escape(sentence)}</span>${stack}${status}${icon('chevron')}</summary><div class="tool-group-body">${entries.map(entry => renderToolActivity(entry.content, entry.key)).join('')}</div></details>`;
}
