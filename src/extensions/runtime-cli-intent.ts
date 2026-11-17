// Webview and preview twin of src-tauri/src/extensions/runtime_cli_intent.rs (runtime phase R7, slice R0705):
// the rules of `contributes.cliIntents` that contracts.ts applies after the schema (the same checks in the same order as
// the native `check`, so both validators answer the same first refusal), the segment/token/program parsing, the
// deterministic precedence (most specific rule, then host package order, then the package's own order), the collision
// of two packages declaring one match, and the merge into the host classifier's answer (`describeShell`).
// An author intent is a HINT: it names the row only where the host found nothing better than the generic `shell`; the
// host's destructive/risks and every approval and hook rule stay as they were. It is no new gate and no secret access.
import type { Json } from './runtime-hook-payload.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const PERMISSION = 'tools.model';
export const MAX_RULES = 64;
export const MAX_WORDS = 4;
export const MAX_FLAGS = 8;
export const MAX_TOKEN = 64;
export const MAX_VERB = 32;
export const MAX_LABEL = 48;
export const MAX_OBJECT = 96;
export const MAX_COMMAND_BYTES = 16 * 1024;
/** The host's `ShellKind` values an author may name. */
export const KINDS = ['read', 'search', 'list', 'test', 'typecheck', 'build', 'install', 'git', 'github', 'wait', 'fetch', 'script', 'db', 'file', 'process', 'media', 'system', 'shell'] as const;
const AT = 'contributes/cliIntents' as const;

// ---- Declarations ----------------------------------------------------------------------------------------------------

export interface Intent { kind: string; verb: string; label: string | null; object: string | null }
export interface Rule { id: string; command: string; words: string[]; flags: string[]; intent: Intent }
export interface Refusal { code: string; at: typeof AT | 'permissions'; ids: string[] }

const tokenOk = (text: string, extra: string) => text.length > 0 && text.length <= MAX_TOKEN && new RegExp(`^[A-Za-z0-9][A-Za-z0-9${extra}]*$`).test(text);
/** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. */
export const validCommand = (text: string) => tokenOk(text, '._-');
/** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. */
export const validWord = (text: string) => tokenOk(text, '._:-');
/** `-x` or `--long-name`. */
export const validFlag = (text: string) => text.length <= MAX_TOKEN && /^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(text);
const plain = (text: string, max: number) => text.trim().length > 0 && [...text].length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(text);

/** The match, ignoring the order of flags: two rules with one key compete for the same operation. */
export const ruleKey = (rule: Pick<Rule, 'command' | 'words' | 'flags'>) => `${rule.command}\u0000${rule.words.join('\u0001')}\u0000${[...new Set(rule.flags)].sort().join('\u0001')}`.toLowerCase();
const specificity = (rule: Rule): [number, number] => [rule.words.length, rule.flags.length];

const refuse = (code: string, at: Refusal['at'], id: string) => ({ ok: false as const, refusal: { code, at, ids: [id] } });

function strings(value: Json | undefined, max: number, ok: (text: string) => boolean): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) { if (typeof item !== 'string' || !ok(item)) return null; out.push(item); }
  return out;
}
function optionalText(value: Json | undefined, max: number): string | null | undefined {
  if (value === undefined) return null;
  return typeof value === 'string' && plain(value, max) ? value : undefined;
}

/** The rules after the schema; answers the rules, or the first refusal. */
export function checkCliIntentDeclarations(manifest: Json): { ok: true; rules: Rule[] } | { ok: false; refusal: Refusal } {
  const root = object(manifest) ? manifest : {};
  const contributes = object(root.contributes) ? root.contributes : {};
  const raw = Array.isArray(contributes.cliIntents) ? contributes.cliIntents : [];
  if (!raw.length) return { ok: true, rules: [] };
  const pkg = typeof root.id === 'string' ? root.id : '';
  if (raw.length > MAX_RULES) return refuse('LimitExceeded', AT, pkg);
  const permissions = new Set(Array.isArray(root.permissions) ? root.permissions.filter((item): item is string => typeof item === 'string') : []);
  const ids = new Set<string>(); const keys = new Set<string>(); const rules: Rule[] = [];
  for (const entry of raw) {
    const rule = object(entry) ? entry : {};
    const id = typeof rule.id === 'string' ? rule.id : '';
    if (id.startsWith('panda.')) return refuse('ReservedId', AT, id);
    if (!id.startsWith(`${pkg}/`)) return refuse('InvalidId', AT, id);
    if (ids.has(id)) return refuse('DuplicateId', AT, id);
    ids.add(id);
    if (typeof rule.command !== 'string' || !validCommand(rule.command)) return refuse('InvalidShape', AT, id);
    const words = strings(rule.words, MAX_WORDS, validWord);
    if (!words) return refuse('InvalidShape', AT, id);
    const flags = strings(rule.flags, MAX_FLAGS, validFlag);
    if (!flags || new Set(flags).size !== flags.length) return refuse('InvalidShape', AT, id);
    const intent = rule.intent;
    if (!object(intent) || Object.keys(intent).some(key => !['kind', 'verb', 'label', 'object'].includes(key))) return refuse('InvalidShape', AT, id);
    if (typeof intent.kind !== 'string' || !(KINDS as readonly string[]).includes(intent.kind)) return refuse('InvalidShape', AT, id);
    if (typeof intent.verb !== 'string' || !plain(intent.verb, MAX_VERB)) return refuse('InvalidShape', AT, id);
    const label = optionalText(intent.label, MAX_LABEL);
    const objectText = optionalText(intent.object, MAX_OBJECT);
    if (label === undefined || objectText === undefined) return refuse('InvalidShape', AT, id);
    const declared: Rule = { id, command: rule.command, words, flags, intent: { kind: intent.kind, verb: intent.verb, label, object: objectText } };
    const key = ruleKey(declared);
    if (keys.has(key)) return refuse('DuplicateId', AT, id);
    keys.add(key);
    rules.push(declared);
  }
  if (!permissions.has(PERMISSION)) return refuse('PermissionDenied', 'permissions', pkg);
  return { ok: true, rules };
}

// ---- Tokens and segments ---------------------------------------------------------------------------------------------

/** Cuts a command line at unquoted `&&`, `||`, `;`, `|` and newlines; `null` when a quote is left open. */
export function splitSegments(line: string): string[] | null {
  const chars = [...line]; const segments: string[] = []; let current = ''; let quote: string | null = null;
  for (let index = 0; index < chars.length; index += 1) {
    const c = chars[index];
    if (quote) { current += c; if (c === quote) quote = null; continue; }
    if (c === '\'' || c === '"') { quote = c; current += c; continue; }
    if (c === ';' || c === '\n' || c === '\r') { segments.push(current); current = ''; continue; }
    if (c === '&' || c === '|') {
      if (chars[index + 1] === c) index += 1;
      else if (c === '&') { current += c; continue; }
      segments.push(current); current = '';
      continue;
    }
    current += c;
  }
  if (quote) return null;
  segments.push(current);
  return segments.map(segment => segment.trim()).filter(segment => segment.length > 0);
}

/** The arguments of one segment (quotes removed); `null` when a quote is left open. */
export function tokens(segment: string): string[] | null {
  const out: string[] = []; let current = ''; let quote: string | null = null; let started = false;
  for (const c of segment) {
    if (quote) { if (c === quote) quote = null; else current += c; continue; }
    if (c === '\'' || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) { if (started) { out.push(current); current = ''; started = false; } continue; }
    current += c; started = true;
  }
  if (quote) return null;
  if (started) out.push(current);
  return out;
}

/** `C:\tools\Tracker.EXE` becomes `tracker`. */
export function program(token: string): string {
  const name = (token.split(/[\\/]/).pop() ?? token).toLowerCase();
  for (const suffix of ['.exe', '.cmd', '.bat', '.ps1']) if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length);
  return name;
}
const isAssignment = (token: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

export interface Parsed { command: string; words: string[]; flags: string[] }
export function parseSegment(segment: string): Parsed | null {
  const all = tokens(segment);
  if (!all) return null;
  let first = 0;
  while (first < all.length && isAssignment(all[first])) first += 1;
  const rest = all.slice(first);
  if (!rest.length) return null;
  const command = program(rest[0]);
  const words: string[] = []; const flags: string[] = [];
  for (const token of rest.slice(1)) {
    if (token.length > 1 && token.startsWith('-')) flags.push(token.split('=')[0].toLowerCase());
    else if (words.length < MAX_WORDS) words.push(token.toLowerCase());
  }
  return { command, words, flags };
}

const fits = (rule: Rule, parsed: Parsed) =>
  rule.command.toLowerCase() === parsed.command
  && parsed.words.length >= rule.words.length
  && rule.words.every((want, index) => want.toLowerCase() === parsed.words[index])
  && (rule.flags.length === 0 || rule.flags.some(flag => parsed.flags.includes(flag.toLowerCase())));

// ---- Inventory and classification ------------------------------------------------------------------------------------

export interface Entry { owner: string; version: string; packageName: string; rules: Rule[] }
export interface Listed { owner: string; version: string; packageName: string; rule: Rule }
export interface Conflict { owner: string; id: string; command: string; heldBy: string }

/** Splits the declared rules into those available and those that lost their match to an earlier package. */
export function resolve(entries: Entry[]): { available: Listed[]; conflicts: Conflict[] } {
  const held = new Map<string, string>(); const available: Listed[] = []; const conflicts: Conflict[] = [];
  for (const entry of entries) for (const rule of entry.rules) {
    const key = ruleKey(rule); const holder = held.get(key);
    if (holder !== undefined && holder !== entry.owner) conflicts.push({ owner: entry.owner, id: rule.id, command: rule.command, heldBy: holder });
    else { held.set(key, entry.owner); available.push({ owner: entry.owner, version: entry.version, packageName: entry.packageName, rule }); }
  }
  return { available, conflicts };
}

export type Status = 'Matched' | 'Unmatched' | 'NoRule' | 'Unparseable';
export interface Segment { text: string; status: Status; matched: Listed | null; candidates: string[] }
export interface Classification { segments: Segment[]; hint: Listed | null; status: Status }

/** Classifies `line` against `usable` rules (grants already applied, in host order). */
export function classify(usable: Listed[], line: string): Classification {
  const none = (status: Status): Classification => ({ segments: [], hint: null, status });
  if (new TextEncoder().encode(line).length > MAX_COMMAND_BYTES) return none('Unparseable');
  const texts = splitSegments(line);
  if (!texts || !texts.length) return none('Unparseable');
  const segments: Segment[] = [];
  for (const text of texts) {
    const parsed = parseSegment(text);
    if (!parsed) { segments.push({ text, status: 'Unparseable', matched: null, candidates: [] }); continue; }
    const declared = usable.filter(listed => listed.rule.command.toLowerCase() === parsed.command);
    if (!declared.length) { segments.push({ text, status: 'NoRule', matched: null, candidates: [] }); continue; }
    const fitting = declared.filter(listed => fits(listed.rule, parsed));
    const best = fitting.reduce<[number, number] | null>((top, listed) => {
      const own = specificity(listed.rule);
      return !top || own[0] > top[0] || (own[0] === top[0] && own[1] > top[1]) ? own : top;
    }, null);
    const winners = best ? fitting.filter(listed => specificity(listed.rule)[0] === best[0] && specificity(listed.rule)[1] === best[1]) : [];
    if (winners.length) segments.push({ text, status: 'Matched', matched: winners[0], candidates: winners.slice(1).map(listed => listed.rule.id) });
    else segments.push({ text, status: 'Unmatched', matched: null, candidates: [] });
  }
  const hint = segments.find(segment => segment.matched)?.matched ?? null;
  const status: Status = hint ? 'Matched' : segments.some(segment => segment.status === 'Unmatched') ? 'Unmatched' : segments.every(segment => segment.status === 'Unparseable') ? 'Unparseable' : 'NoRule';
  return { segments, hint, status };
}

/** The wire form of a classification: what the hook payload's `intent` field and the SDK show. */
export function classificationJson(result: Classification): Obj {
  return {
    schemaVersion: 1, status: result.status,
    segments: result.segments.map(segment => ({
      text: segment.text, status: segment.status, rule: segment.matched?.rule.id ?? null, owner: segment.matched?.owner ?? null,
      package: segment.matched?.packageName ?? null, intent: segment.matched ? { ...segment.matched.rule.intent } : null, candidates: segment.candidates,
    })),
    hint: result.hint ? { rule: result.hint.rule.id, owner: result.hint.owner, package: result.hint.packageName, intent: { ...result.hint.rule.intent } } : null,
  };
}

/**
 * The host classifier's answer (`describeShell`) with the author's hint. The hint names the row only when the host
 * found nothing more specific than `shell`; `destructive` and `risks` are never touched. `packageIntent` carries the
 * package attribution.
 */
export function merge<T extends Obj>(host: T, result: Classification): T | (T & { packageIntent: Obj }) {
  const hint = result.hint;
  if (!hint) return host;
  const intent = hint.rule.intent;
  const generic = host.kind === undefined || host.kind === 'shell';
  const out: Obj = { ...host };
  if (generic) {
    out.kind = intent.kind; out.verb = intent.verb;
    if (intent.label !== null) out.label = intent.label;
    if (intent.object !== null) out.object = intent.object;
  }
  out.packageIntent = { applied: generic, owner: hint.owner, package: hint.packageName, rule: hint.rule.id, intent: { ...intent } };
  return out as unknown as T & { packageIntent: Obj };
}

/** The preview registry: the grant is checked on every classification, like the native one. */
export interface Wiring { source: () => Entry[]; holds: (owner: string, version: string, permission: string, project: string | null) => boolean }
export class CliIntentRegistry {
  constructor(private readonly wiring: Wiring) {}
  usable(project: string | null): Listed[] { return resolve(this.wiring.source()).available.filter(listed => this.wiring.holds(listed.owner, listed.version, PERMISSION, project)); }
  conflicts(): Conflict[] { return resolve(this.wiring.source()).conflicts; }
  classify(project: string | null, line: string): Classification { return classify(this.usable(project), line); }
  /** Adds the intent to a shell call's hook payload and merges it into the host classification; the call is untouched. */
  annotate(project: string | null, command: string, payload: Obj, host: Obj): { payload: Obj; host: Obj } {
    const result = this.classify(project, command);
    if (!result.hint) return { payload, host };
    return { payload: { ...payload, intent: classificationJson(result) }, host: merge(host, result) };
  }
}
