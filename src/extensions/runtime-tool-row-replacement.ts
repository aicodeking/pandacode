// Tool row replacement and risk signals (`ui.presentation`, runtime phase R10, slice R1004).
//
// A trusted package can replace how one kind of built-in tool row reads in the transcript and attach risk signals to it
// (ADR-0005: trust and the named grant are the safeguard, no per-action confirmation). It is declarative: a package names a
// selector (which rows) and a row (a sentence and an optional result card made of host tokens), never markup or code, so the
// host draws every pixel and the package never touches the row. The shapes are `contributes.toolRows` in schema-v1.json; the
// native twin is src-tauri/src/extensions/runtime_tool_row_replacement.rs. This file has two halves: the model (no DOM,
// importable by the deterministic checks of tests/extensions-runtime-tool-row-replacement.spec.ts) and `mountToolRowReplacement`,
// which draws it over the rows the renderer already made.
//
// What never changes: the built-in row stays in the DOM (hidden while replaced), so disable, revoke, safe mode, a conflict or a
// fault restore it by removing the package's nodes. The destructive badge, the exit status and a refusal row stay visible next
// to a replacement. The native approval or denial is the truth: a package's claim is shown only where it agrees, otherwise it is
// listed as overruled. Text the host marked secret never reaches the sentence. No permanent safety-only exclusion exists: a
// destructive or failed row is replaceable like any other.
import type { Json } from './contracts';
import type { ExtensionSnapshot } from './manager';

export const PERMISSION = 'ui.presentation';
/** What `{input}` and `{output}` additionally need. */
export const READ_PERMISSION = 'tasks.tools.read';
export const MAX_ROWS = 16;
export const MAX_SIGNALS = 8;
export const MAX_FIELDS = 8;
export const MAX_TITLE = 80;
export const MAX_SENTENCE = 160;
export const MAX_LABEL = 24;
export const MAX_SELECTOR_VALUE = 96;
export const MAX_TOKEN_CHARS = 160;
export const TOKENS = ['name', 'kind', 'family', 'server', 'status', 'target', 'input', 'output'] as const;
export const RISKS = ['notice', 'caution', 'destructive'] as const;
export const WHEN = ['always', 'failed', 'blocked', 'hook-approve', 'hook-deny', 'hook-ask', 'hook-rewrite'] as const;
const SELECTOR_KEYS = ['kind', 'name', 'family', 'server'];
const ROW_KEYS = ['id', 'title', 'selector', 'row', 'card', 'signals'];

type Definition = Record<string, Json>;
export type Granted = (owner: string, version: string, permission: string) => boolean;
export type Facts = {
  kind: string; name: string; family: string; server: string; status: string; target: string; input?: string; output?: string;
  failed: boolean; blocked: boolean; secret: boolean; builtinDestructive: boolean;
};
export type Candidate = { owner: string; version: string; label: string; enabled: boolean; holds: boolean; read: boolean; row: Definition };
export type Pick = { kind: 'builtin'; reason: 'SafeMode' | 'NoMatch' | 'Revoked' | 'Conflict' | 'Faulted' } | { kind: 'replace'; candidate: Candidate };
export type Signal = { id: string; risk: string; label: string; source: 'package' | 'hook'; owner: string; decision?: string };
export type HookClaim = { decision: string; by: string };
export type Chip = { label: string; risk: string; source: 'builtin' | 'package' | 'hook'; owner?: string; decision?: string };
export type Line = { state: string; by: string; overruled?: string };
export type Rendered = { sentence: string; cardTitle?: string; fields: [string, string][] };

const record = (value: unknown): value is Definition => typeof value === 'object' && value !== null && !Array.isArray(value);
const chars = (text: string) => [...text].length;
const text = (value: unknown): value is string => typeof value === 'string';

/** Every `{token}` of the text is a known token and no brace is left open. */
function tokensKnown(value: string): boolean {
  let rest = value;
  for (;;) {
    const open = rest.search(/[{}]/);
    if (open < 0) return true;
    if (rest[open] === '}') return false;
    const close = rest.indexOf('}', open);
    if (close < 0 || !(TOKENS as readonly string[]).includes(rest.slice(open + 1, close))) return false;
    rest = rest.slice(close + 1);
  }
}

/** The frozen failure of one `toolRows` entry (`null` when valid). */
export function checkRow(row: Definition): string | null {
  if (!record(row) || Object.keys(row).some(key => !ROW_KEYS.includes(key))) return 'InvalidShape';
  if (!text(row.id) || row.id === '' || chars(row.id) > MAX_SELECTOR_VALUE) return 'InvalidShape';
  if (!text(row.title) || row.title === '') return 'InvalidShape';
  if (chars(row.title) > MAX_TITLE) return 'LimitExceeded';
  const selector = row.selector;
  if (!record(selector) || Object.keys(selector).length === 0 || Object.keys(selector).some(key => !SELECTOR_KEYS.includes(key))) return 'InvalidShape';
  for (const value of Object.values(selector)) {
    if (!text(value) || value === '') return 'InvalidShape';
    if (chars(value) > MAX_SELECTOR_VALUE) return 'LimitExceeded';
  }
  const sentence = record(row.row) ? row.row.sentence : undefined;
  if (!text(sentence) || sentence === '') return 'InvalidShape';
  if (chars(sentence) > MAX_SENTENCE) return 'LimitExceeded';
  if (!tokensKnown(sentence)) return 'InvalidShape';
  if (row.card !== undefined && row.card !== null) {
    const card = row.card;
    if (!record(card) || !text(card.title) || card.title === '') return 'InvalidShape';
    if (chars(card.title) > MAX_TITLE) return 'LimitExceeded';
    if (!Array.isArray(card.fields)) return 'InvalidShape';
    if (card.fields.length > MAX_FIELDS) return 'LimitExceeded';
    for (const field of card.fields) {
      if (!record(field) || !text(field.label) || field.label === '') return 'InvalidShape';
      if (chars(field.label) > MAX_LABEL) return 'LimitExceeded';
      if (!text(field.value) || field.value === '' || !tokensKnown(field.value)) return 'InvalidShape';
      if (chars(field.value) > MAX_SENTENCE) return 'LimitExceeded';
    }
  }
  if (row.signals !== undefined && row.signals !== null) {
    if (!Array.isArray(row.signals)) return 'InvalidShape';
    if (row.signals.length > MAX_SIGNALS) return 'LimitExceeded';
    const seen = new Set<string>();
    for (const signal of row.signals) {
      if (!record(signal) || !text(signal.id) || signal.id === '' || seen.has(signal.id)) return 'InvalidShape';
      seen.add(signal.id);
      if (!(RISKS as readonly unknown[]).includes(signal.risk) || !(WHEN as readonly unknown[]).includes(signal.when)) return 'InvalidShape';
      if (!text(signal.label) || signal.label === '') return 'InvalidShape';
      if (chars(signal.label) > MAX_LABEL) return 'LimitExceeded';
    }
  }
  return null;
}

/** The failure of a package's whole `toolRows` list: the bound, unique ids, then each entry. */
export function checkAll(list: readonly Definition[]): string | null {
  if (list.length > MAX_ROWS) return 'LimitExceeded';
  const seen = new Set<string>();
  for (const row of list) {
    if (!record(row) || !text(row.id) || seen.has(row.id)) return 'InvalidShape';
    seen.add(row.id);
    const failure = checkRow(row);
    if (failure) return failure;
  }
  return null;
}

export const gate = (holds: boolean): 'ok' | 'PermissionDenied' => holds ? 'ok' : 'PermissionDenied';

export function matches(selector: Json | undefined, facts: Facts): boolean {
  if (!record(selector) || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([key, want]) => {
    switch (key) { case 'kind': return facts.kind === want; case 'name': return facts.name === want; case 'family': return facts.family === want; case 'server': return facts.server === want; default: return false; }
  });
}
/** A tool name beats a server, a server beats a family, a family beats a kind. */
export const specificity = (selector: Definition): number => (selector.name !== undefined ? 8 : 0) + (selector.server !== undefined ? 4 : 0) + (selector.family !== undefined ? 2 : 0) + (selector.kind !== undefined ? 1 : 0);

/** Which declaration draws `facts`. `faulted` holds `owner\u0000rowId` of replacements that failed to draw this session. */
export function select(candidates: readonly Candidate[], facts: Facts, safeMode: boolean, faulted: ReadonlySet<string> = new Set()): Pick {
  if (safeMode) return { kind: 'builtin', reason: 'SafeMode' };
  let revoked = false, broken = false;
  const live: [Candidate, number][] = [];
  for (const candidate of candidates) {
    if (!candidate.enabled || checkRow(candidate.row) !== null || !matches(candidate.row.selector, facts)) continue;
    if (gate(candidate.holds) !== 'ok') { revoked = true; continue; }
    if (faulted.has(faultKey(candidate.owner, String(candidate.row.id)))) { broken = true; continue; }
    live.push([candidate, specificity(candidate.row.selector as Definition)]);
  }
  if (!live.length) return { kind: 'builtin', reason: broken ? 'Faulted' : revoked ? 'Revoked' : 'NoMatch' };
  const best = Math.max(...live.map(([, weight]) => weight));
  const top = live.filter(([, weight]) => weight === best).map(([candidate]) => candidate);
  // Two different packages claiming the same row equally is a conflict: neither wins, the built-in row draws.
  if (top.some(candidate => candidate.owner !== top[0].owner)) return { kind: 'builtin', reason: 'Conflict' };
  return { kind: 'replace', candidate: top[0] };
}
export const faultKey = (owner: string, rowId: string) => `${owner}\u0000${rowId}`;

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  const line = value.split(/\s+/).filter(Boolean).join(' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const all = [...line];
  return all.length > MAX_TOKEN_CHARS ? `${all.slice(0, MAX_TOKEN_CHARS - 1).join('')}…` : line;
}
function token(name: string, facts: Facts, read: boolean): string {
  const priv = (value: string) => facts.secret ? '[hidden]' : clean(value);
  switch (name) {
    case 'name': return clean(facts.name); case 'kind': return clean(facts.kind); case 'family': return clean(facts.family);
    case 'server': return clean(facts.server); case 'status': return clean(facts.status);
    case 'target': return priv(facts.target);
    case 'input': return !read ? '[not granted]' : priv(facts.input ?? '');
    case 'output': return !read ? '[not granted]' : priv(facts.output ?? '');
    default: return '';
  }
}
export function fill(value: string, facts: Facts, read: boolean): string {
  return clean(value.replace(/\{([a-z]+)\}/g, (_, name: string) => token(name, facts, read)));
}
/** The sentence and card of a replaced row, drawn by the host from the declaration. */
export function render(row: Definition, facts: Facts, read: boolean): Rendered {
  const card = record(row.card) ? row.card : undefined;
  const fields = Array.isArray(card?.fields) ? (card!.fields as unknown as Definition[]).map((field): [string, string] => [clean(String(field.label)), fill(String(field.value), facts, read)]) : [];
  return { sentence: fill(String((row.row as Definition).sentence), facts, read), ...(card ? { cardTitle: clean(String(card.title)) } : {}), fields };
}

/** The signals a row shows now. A `hook-*` signal needs a claim by this very package for that decision. */
export function signals(row: Definition, owner: string, facts: Facts, claim?: HookClaim): Signal[] {
  const out: Signal[] = [];
  for (const signal of (Array.isArray(row.signals) ? row.signals : []) as unknown as Definition[]) {
    const when = String(signal.when);
    let live = false, source: 'package' | 'hook' = 'package', decision: string | undefined;
    if (when === 'always') live = true;
    else if (when === 'failed') live = facts.failed;
    else if (when === 'blocked') live = facts.blocked;
    else { source = 'hook'; const wanted = when.replace(/^hook-/, ''); if (claim && claim.by === owner && claim.decision === wanted) { live = true; decision = wanted; } }
    if (live) out.push({ id: String(signal.id), risk: String(signal.risk), label: clean(String(signal.label)), source, owner, ...(decision ? { decision } : {}) });
  }
  return out;
}
const level = (risk: string) => (RISKS as readonly string[]).indexOf(risk);
/** The chips, highest risk first. The host's destructive badge is always first and always kept: a package adds signals, it never hides, lowers or replaces it. */
export function riskView(builtinDestructive: boolean, found: readonly Signal[]): Chip[] {
  const out: Chip[] = builtinDestructive ? [{ label: 'destructive', risk: 'destructive', source: 'builtin' }] : [];
  for (const signal of [...found].sort((a, b) => level(b.risk) - level(a.risk))) out.push({ label: signal.label, risk: signal.risk, source: signal.source, owner: signal.owner, ...(signal.decision ? { decision: signal.decision } : {}) });
  return out;
}

/** The decision line: the native state (`approved`, `denied`, `pending`, `none`) is the truth; a package's claim fills in nothing and is listed as overruled when it disagrees. */
export function reconcile(native: string, decidedBy: string | undefined, claim?: HookClaim): Line {
  const agrees = (claimed: string) => (['approve', 'rewrite'].includes(claimed) && native === 'approved') || (claimed === 'deny' && native === 'denied') || (claimed === 'ask' && native === 'pending');
  return { state: native, by: decidedBy ?? 'host', ...(claim && !agrees(claim.decision) ? { overruled: `${claim.by} ${claim.decision}` } : {}) };
}

/** The candidates of the packages that may show anything: declaring `ui.presentation`, with `granted` answering the live grants. */
export function candidates(snapshot: ExtensionSnapshot, granted: Granted): Candidate[] {
  const out: Candidate[] = [];
  for (const item of snapshot.packages) {
    const manifest = item.manifest as unknown as { id: string; version: string; name?: string; permissions?: string[]; contributes: Record<string, Definition[] | undefined> };
    const declared = (manifest.permissions ?? []).includes(PERMISSION);
    for (const row of manifest.contributes.toolRows ?? []) {
      out.push({
        owner: manifest.id, version: manifest.version, label: typeof manifest.name === 'string' ? manifest.name : manifest.id, row,
        enabled: item.enabled && declared, holds: granted(manifest.id, manifest.version, PERMISSION), read: granted(manifest.id, manifest.version, READ_PERMISSION),
      });
    }
  }
  return out;
}

// ---- The interface ----------------------------------------------------------------------------------------------------

export type RowDecision = { native: string; decidedBy?: string; claim?: HookClaim };
export type ToolRowOptions = {
  /** The transcript root the rows live in. */
  root: HTMLElement;
  /** The host's own bounded, redacted detail of one call (input, output, secret), by tool key. Absent: those tokens are empty. */
  details?: (key: string) => { input?: string; output?: string; secret?: boolean } | undefined;
  /** What the host recorded for the call's approval (the native state and `decidedBy`) and what a package claimed. */
  decision?: (key: string) => RowDecision | undefined;
  notify: (message: string) => void;
};

const ROW = '.tool-activity.tool-trace[data-tool-key]';
const MARK = 'data-row-replacement';
const NODE = 'data-row-replacement-node';

export async function mountToolRowReplacement(options: ToolRowOptions) {
  const [manager, grantsModule, rich] = await Promise.all([import('./manager'), import('./runtime-grants'), import('./runtime-rich-mount')]);
  const { root } = options;
  let disposed = false, scheduled = false;
  const faulted = new Set<string>();
  const told = new Set<string>();
  const granted: Granted = (owner, version, permission) => {
    const grants = grantsModule.createRuntimeGrantsPreview();
    grants.sync(manager.extensionsManagementSnapshot() as unknown as Parameters<typeof grants.sync>[0]);
    return grants.check(owner, version, permission) === 'ok';
  };
  const factsOf = (row: HTMLElement): Facts | undefined => {
    const { toolKey, toolName, toolKind, toolStatus, toolFamily } = row.dataset;
    if (!toolKey || !toolName || !toolKind || !toolStatus) return undefined;
    const detail = options.details?.(toolKey);
    const server = /^mcp__(.+?)__/.exec(toolName)?.[1] ?? (toolName.indexOf(' · ') > 0 ? toolName.slice(0, toolName.indexOf(' · ')) : '');
    return {
      kind: toolKind, name: toolName, family: toolFamily ?? '', server, status: toolStatus,
      target: row.querySelector('.tool-trace-object')?.textContent?.trim() ?? '',
      ...(detail?.input !== undefined ? { input: detail.input } : {}), ...(detail?.output !== undefined ? { output: detail.output } : {}),
      failed: 'toolFailed' in row.dataset, blocked: 'toolBlocked' in row.dataset, secret: detail?.secret === true,
      builtinDestructive: row.querySelector('[data-trace-badge]') !== null,
    };
  };
  const clear = (row: HTMLElement) => { for (const node of row.querySelectorAll(`[${NODE}]`)) if (node.closest(ROW) === row) node.remove(); row.removeAttribute(MARK); row.removeAttribute('data-row-owner'); };
  const line = (row: HTMLElement) => row.querySelector<HTMLElement>(':scope > summary, :scope > .tool-trace-summary');
  const el = (tag: string, className: string, content: string) => { const node = document.createElement(tag); node.className = className; node.textContent = content; node.setAttribute(NODE, ''); return node; };

  function draw(row: HTMLElement, pick: Pick & { kind: 'replace' }, facts: Facts) {
    const { candidate } = pick, definition = candidate.row, key = row.dataset.toolKey!;
    const anchor = line(row);
    if (!anchor) throw Error('Row without a summary line');
    const decision = options.decision?.(key);
    const found = signals(definition, candidate.owner, facts, decision?.claim);
    const drawn = render(definition, facts, candidate.read);
    const signature = JSON.stringify([candidate.owner, candidate.version, definition, drawn, found, decision, facts.status, facts.failed, facts.blocked]);
    if (row.getAttribute(MARK) === String(definition.id) && row.dataset.rowSignature === signature) return;
    clear(row);
    const sentence = el('span', 'tool-replacement', drawn.sentence);
    sentence.dataset.owner = candidate.owner;
    sentence.title = `Shown by ${candidate.label}`;
    const credit = el('span', 'tool-replacement-credit', candidate.label);
    const chips = riskView(facts.builtinDestructive, found).filter(chip => chip.source !== 'builtin').map(chip => {
      const node = el('span', 'tool-replacement-chip', chip.label);
      node.dataset.risk = chip.risk; node.dataset.source = chip.source;
      if (chip.owner) node.dataset.owner = chip.owner;
      node.title = chip.source === 'hook' ? `${candidate.label}: ${chip.decision} decision` : `${candidate.label}: ${chip.risk}`;
      return node;
    });
    const verdict = decision ? reconcile(decision.native, decision.decidedBy, decision.claim) : undefined;
    const decided = verdict && verdict.state !== 'none' ? el('span', 'tool-replacement-decision', `${verdict.state} by ${verdict.by}${verdict.overruled ? ` (${verdict.overruled} overruled)` : ''}`) : undefined;
    if (decided) decided.dataset.state = verdict!.state;
    // The replacement sits after the lead icon; the built-in destructive badge, exit status and chevron stay where they were.
    const lead = anchor.querySelector('.tool-trace-icon');
    const first = [sentence, credit, ...chips, ...(decided ? [decided] : [])];
    if (lead) lead.after(...first); else anchor.prepend(...first);
    if (drawn.fields.length) {
      const body = row.querySelector<HTMLElement>(':scope > .tool-activity-body');
      if (body && !body.hasAttribute('data-tool-body')) {
        const card = el('div', 'tool-replacement-card', '');
        const title = el('div', 'tool-replacement-card-title', drawn.cardTitle ?? '');
        card.append(title);
        for (const [label, value] of drawn.fields) { const rowNode = el('div', 'tool-replacement-field', ''); rowNode.append(el('span', 'tool-replacement-label', label), el('span', 'tool-replacement-value', value)); card.append(rowNode); }
        body.prepend(card);
      }
    }
    row.setAttribute(MARK, String(definition.id)); row.dataset.rowOwner = candidate.owner; row.dataset.rowSignature = signature;
  }

  function sync(row: HTMLElement, snapshot: ExtensionSnapshot, list: Candidate[]) {
    const facts = factsOf(row);
    if (!facts) { clear(row); return; }
    const pick = select(list, facts, snapshot.safeMode, faulted);
    if (pick.kind === 'builtin') { clear(row); row.removeAttribute('data-row-signature'); return; }
    try { draw(row, pick, facts); }
    catch {
      // A faulting replacement is dropped for the session and the built-in row returns, told once.
      clear(row); row.removeAttribute('data-row-signature');
      faulted.add(faultKey(pick.candidate.owner, String(pick.candidate.row.id)));
      const once = faultKey(pick.candidate.owner, 'told');
      if (!told.has(once)) { told.add(once); options.notify(`${pick.candidate.label}: the tool row it replaces failed to draw. The built-in row is back.`); }
    }
  }
  const scan = () => {
    scheduled = false;
    if (disposed) return;
    const snapshot = manager.extensionsSnapshot();
    const list = candidates(snapshot, granted);
    for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
      try { sync(row, snapshot, list); } catch { clear(row); }
    }
  };
  const schedule = () => { if (!scheduled && !disposed) { scheduled = true; queueMicrotask(scan); } };
  const observer = new MutationObserver(records => {
    const own = (node: Node) => node instanceof Element && (node.hasAttribute(NODE) || node.closest(`[${NODE}]`) !== null);
    if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node => !own(node) && node instanceof Element))) schedule();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tool-status', 'data-tool-failed', 'data-tool-blocked', 'data-tool-name'] });
  const stop = manager.onExtensionsChanged(schedule);
  window.addEventListener(rich.GRANTS_CHANGED, schedule);
  schedule();
  return {
    rescan: schedule,
    dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect(); stop(); window.removeEventListener(rich.GRANTS_CHANGED, schedule);
      for (const row of root.querySelectorAll<HTMLElement>(`[${MARK}]`)) { clear(row); row.removeAttribute('data-row-signature'); }
    },
  };
}
