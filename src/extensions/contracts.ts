/** Pure v1 data validation. This module grants no permissions and activates nothing. */
import schemaDocument from './schema-v1.json' with { type: 'json' };
import { proposalOrder, OrderingCycle, type Placement } from './ordering.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Schema = { [key: string]: unknown };
export type ContractError = { schemaVersion: 1; code: string; path: string; ids: string[] };
export type Diagnostic = { code: 'UnknownOptionalField' | 'UnknownOptionalCapability'; path: string };
export type Validation = { ok: true; value: Json; diagnostics: Diagnostic[] } | { ok: false; error: ContractError };
const definitions = schemaDocument.$defs as Record<string, Schema>;
export const CONTRACT_LIMITS = Object.freeze({ ...schemaDocument['x-dataLimits'] });
export const MENU_LIMITS = Object.freeze({ ...schemaDocument['x-menuLimits'] });
const knownContributions = ['commands', 'icons', 'menus', 'views', 'layouts', 'settings', 'keybindings', 'dialogExtras'];
const capabilities = ['ui.contribute', 'ui.customize', 'projects.summary', 'tasks.summary', 'harnesses.inventory', 'connections.summary', 'jobs.summary', 'projects.files.metadata', 'projects.files.read', 'projects.git.read'];
const publicShapes = ['command', 'surface', 'contribution', 'context', 'error', 'expression', 'dialog', 'selectOptions'];
const object = (v: Json): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
class ContractFailure {
  detail: ContractError;
  constructor(detail: ContractError) { this.detail = detail; }
}
function error(code: string, path: string, ids: string[] = []): never { throw new ContractFailure({ schemaVersion: 1, code, path: [...path].slice(0, 512).join(''), ids: ids.slice(0, 64) }); }
// Match Rust's Unicode scalar/UTF-8 order, not JavaScript's UTF-16 default sort.
function compareText(a: string, b: string): number {
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
function fullMatch(pattern: string, value: string): boolean {
  const match = new RegExp(pattern).exec(value);
  return match !== null && match[0] === value;
}

function quotedBytes(value: string): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
function bounded(value: unknown, path = '$', depth = 0, budget = { nodes: 0, bytes: 0 }): asserts value is Json {
  if (depth > CONTRACT_LIMITS.depth || ++budget.nodes > CONTRACT_LIMITS.nodes) error('LimitExceeded', path);
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value)) error('InvalidShape', path);
    budget.bytes += quotedBytes(value); return;
  }
  if (value === null || typeof value === 'boolean') { budget.bytes += value === null ? 4 : value ? 4 : 5; return; }
  if (typeof value === 'number' && Number.isFinite(value)) { budget.bytes += CONTRACT_LIMITS.numberBytes; return; }
  if (typeof value !== 'object' || !value) error('InvalidShape', path);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) error('InvalidShape', path);
  // Accessors are host code, not parsed JSON. Never invoke one while inspecting data.
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(field => field.get || field.set)) error('InvalidShape', path);
  const entries = Array.isArray(value) ? Object.entries(value) : Object.entries(value).sort(([a], [b]) => compareText(a, b));
  budget.bytes += 2 + Math.max(0, entries.length - 1);
  for (const [key, item] of entries) {
    if (!Array.isArray(value)) {
      if (/[\uD800-\uDFFF]/u.test(key)) error('InvalidShape', path);
      budget.bytes += quotedBytes(key) + 1;
    }
    bounded(item, `${path}/${key}`, depth + 1, budget);
  }
}

function shape(value: Json, schema: Schema, path: string, diagnostics: Diagnostic[]): Json {
  if (schema.$ref) return shape(value, definitions[String(schema.$ref).split('/').at(-1)!], path, diagnostics);
  if (schema.anyOf) {
    for (const alternative of schema.anyOf as Schema[]) {
      const notes: Diagnostic[] = [];
      try { const result = shape(value, alternative, path, notes); diagnostics.push(...notes); return result; }
      catch (cause) { if (!(cause instanceof ContractFailure)) throw cause; }
    }
    return error('InvalidShape', path);
  }
  if ('const' in schema && value !== schema.const) error('InvalidShape', path);
  if (schema.enum && !(schema.enum as Json[]).includes(value)) error('InvalidShape', path);
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') error('InvalidShape', path);
      if ([...value].length < Number(schema.minLength ?? 0) || [...value].length > Number(schema.maxLength ?? Infinity)) error('LimitExceeded', path);
      if (schema.pattern && !fullMatch(String(schema.pattern), value)) error('InvalidShape', path);
      break;
    case 'boolean': if (typeof value !== 'boolean') error('InvalidShape', path); break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) error('InvalidShape', path);
      if (value < Number(schema.minimum ?? -Infinity) || value > Number(schema.maximum ?? Infinity)) error('LimitExceeded', path);
      break;
    case 'array':
      if (!Array.isArray(value)) error('InvalidShape', path);
      if (value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems ?? Infinity)) error('LimitExceeded', path);
      return value.map((item, i) => shape(item, schema.items as Schema, `${path}/${i}`, diagnostics));
    case 'object': {
      if (!object(value)) error('InvalidShape', path);
      for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(value, key)) error('InvalidShape', `${path}/${key}`);
      if (Object.keys(value).length > Number(schema.maxProperties ?? Infinity)) error('LimitExceeded', path);
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const result: ObjectValue = {};
      for (const key of Object.keys(value).sort(compareText)) {
        const child = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
        if (child === false) error('InvalidShape', `${path}/${key}`);
        if (child && typeof child === 'object') Object.defineProperty(result, key, { value: shape(value[key], child as Schema, `${path}/${key}`, diagnostics), enumerable: true, writable: true });
        else diagnostics.push({ code: 'UnknownOptionalField', path: `${path}/${key}` });
      }
      return result;
    }
  }
  return value;
}

type Version = [number, number, number];
function version(text: string): Version | undefined {
  return fullMatch('^(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})$', text) ? text.split('.').map(Number) as Version : undefined;
}
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function matches(text: string, actual: string, path: string): boolean {
  const prefix = /^[~^]/.test(text) ? text[0] : '';
  const base = version(prefix ? text.slice(1) : text);
  const current = version(actual)!;
  if (base) {
    if (!prefix) return compare(current, base) === 0;
    const upper: Version = prefix === '~' ? [base[0], base[1] + 1, 0] : base[0] ? [base[0] + 1, 0, 0] : base[1] ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
    return compare(current, base) >= 0 && compare(current, upper) < 0;
  }
  const interval = /^>=(\S+) <(\S+)$/.exec(text);
  if (interval && interval[0] === text) {
    const lower = version(interval[1]), upper = version(interval[2]);
    if (lower && upper && compare(lower, upper) < 0) return compare(current, lower) >= 0 && compare(current, upper) < 0;
  }
  return error('InvalidVersionRange', path);
}

function packageId(id: string, path: string) {
  if (!fullMatch('^[a-z][a-z0-9-]*[.][a-z][a-z0-9-]*$', id)) error('InvalidId', path, [id]);
  if (id.startsWith('panda.')) error('ReservedId', path, [id]);
}

function distinct(items: ObjectValue[], key: string, path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = item[key] as string;
    if (seen.has(id)) error('DuplicateId', path, [id]);
    seen.add(id);
  }
}
function dialogFields(dialog: ObjectValue, path: string): void {
  const fields = dialog.fields as ObjectValue[];
  distinct(fields, 'id', path);
  for (const field of fields) if (field.kind === 'select') distinct(field.options as ObjectValue[], 'value', `${path}/${field.id}/options`);
}

function menuItems(items: ObjectValue[], owner: string, owned: Set<string>, path: string, reference?: (kind: string, value: Json, field: string) => void, depth = 1, budget = { count: 0 }): void {
  if (depth > MENU_LIMITS.depth || (budget.count += items.length) > MENU_LIMITS.items) error('LimitExceeded', path);
  const checkedGroups = new Set<string>();
  for (const item of items) {
    const id = item.id as string;
    if (id.startsWith('panda.')) error('ReservedId', path, [id]);
    if (!id.startsWith(`${owner}/`)) error('InvalidId', path, [id]);
    if (owned.has(id)) error('DuplicateId', path, [id]);
    owned.add(id);
    if (item.kind === 'separator') {
      if (Object.keys(item).some(key => !['id', 'kind', 'visible'].includes(key))) error('InvalidShape', path);
      continue;
    }
    if (!item.title || (item.kind === 'submenu' ? !item.items || item.command !== undefined : !item.command || item.items !== undefined)) error('InvalidShape', path);
    if (item.kind !== 'checkbox' && item.kind !== 'radio' && item.checked !== undefined || item.kind === 'radio' && !item.group || item.kind !== 'radio' && item.group !== undefined) error('InvalidShape', path);
    if (item.kind === 'radio' && item.checked) {
      if (checkedGroups.has(item.group as string)) error('InvalidShape', path);
      checkedGroups.add(item.group as string);
    }
    if (item.command) reference?.('commands', item.command, 'menus');
    if (item.icon) reference?.('icons', item.icon, 'menus');
    if (item.items) menuItems(item.items as ObjectValue[], owner, owned, path, reference, depth + 1, budget);
  }
}

/** Returns a deterministic topological order, or the sorted IDs still in a cycle. */
function orderGraph(nodes: string[], edges: [string, string][], code: string, path: string, rank: (a: string, b: string) => number = (a, b) => a < b ? -1 : a > b ? 1 : 0): string[] {
  const remaining = new Set(nodes), result: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => !edges.some(([from, to]) => to === id && remaining.has(from))).sort(rank);
    if (!ready.length) error(code, path, [...remaining].sort());
    const id = ready[0]; remaining.delete(id); result.push(id);
  }
  return result;
}

function manifests(input: Json, diagnostics: Diagnostic[]): Json {
  if (!Array.isArray(input)) error('InvalidShape', '$');
  if (input.length > CONTRACT_LIMITS.packages) error('LimitExceeded', '$');
  const packages = input.map((value, i) => shape(value, definitions.manifest, `$/${i}`, diagnostics) as ObjectValue);
  const ids = new Set<string>();
  const allMenus: ObjectValue[] = [];
  for (const [index, manifest] of packages.entries()) {
    const path = `$/${index}`, id = manifest.id as string;
    packageId(id, `${path}/id`);
    if (ids.has(id)) error('DuplicateId', `${path}/id`, [id]);
    ids.add(id);
    // Entry points and lifecycle fields must not be silently treated as harmless metadata.
    const raw = input[index];
    if (object(raw) && ['entrypoint', 'activationEvents', 'scripts'].some(key => Object.hasOwn(raw, key))) error('UnsupportedRuntime', path, [id]);
    if (!matches((manifest.engines as ObjectValue).pandacodeApi as string, '1.0.0', `${path}/engines/pandacodeApi`)) error('IncompatibleApi', `${path}/engines/pandacodeApi`, [id]);
    for (const key of ['permissions', 'requiredCapabilities']) for (const capability of (manifest[key] ?? []) as string[]) if (!capabilities.includes(capability)) error('UnsupportedCapability', `${path}/${key}`, [capability]);
    const optional = (manifest.optionalCapabilities ?? []) as string[];
    for (const [i, capability] of optional.entries()) if (!capabilities.includes(capability)) diagnostics.push({ code: 'UnknownOptionalCapability', path: `${path}/optionalCapabilities/${i}` });
    if (manifest.optionalCapabilities) manifest.optionalCapabilities = optional.filter(c => capabilities.includes(c));
    for (const key of (manifest.requiredContributions ?? []) as string[]) if (!knownContributions.includes(key)) error('UnsupportedContribution', `${path}/requiredContributions`, [key]);
    const contributions = manifest.contributes as ObjectValue;
    const owned = new Set<string>();
    for (const kind of knownContributions) for (const item of (contributions[kind] ?? []) as ObjectValue[]) {
      const itemId = item.id as string;
      if (itemId.startsWith('panda.')) error('ReservedId', `${path}/contributes/${kind}`, [itemId]);
      if (!itemId.startsWith(`${id}/`)) error('InvalidId', `${path}/contributes/${kind}`, [itemId]);
      if (owned.has(itemId)) error('DuplicateId', `${path}/contributes/${kind}`, [itemId]);
      owned.add(itemId);
    }
    const find = (kind: string, reference: Json) => ((contributions[kind] ?? []) as ObjectValue[]).some(item => item.id === reference);
    const reference = (kind: string, value: Json, field: string) => { if (!find(kind, value)) error('UnknownReference', `${path}/contributes/${field}`, [String(value)]); };
    for (const icon of (contributions.icons ?? []) as ObjectValue[]) {
      const asset = icon.asset as string;
      if (!fullMatch('^assets/[a-zA-Z0-9_./-]+[.](svg|png|webp)$', asset) || asset.split('/').some(part => !part || part === '.' || part === '..')) error('UnsafeAsset', `${path}/contributes/icons`, [icon.id as string]);
    }
    for (const command of (contributions.commands ?? []) as ObjectValue[]) {
      if (command.icon) reference('icons', command.icon, 'commands');
      const action = command.action as ObjectValue;
      if (action.kind === 'openView') reference('views', action.view, 'commands');
      if (action.kind === 'showDialog') dialogFields(action.dialog as ObjectValue, `${path}/contributes/commands`);
    }
    for (const page of (contributions.settings ?? []) as ObjectValue[]) {
      dialogFields(page, `${path}/contributes/settings`);
      if ((page.fields as ObjectValue[]).some(field => field.async === true)) error('UnsupportedContribution', `${path}/contributes/settings`, [page.id as string]);
    }
    for (const binding of (contributions.keybindings ?? []) as ObjectValue[]) reference('commands', binding.command, 'keybindings');
    for (const menu of (contributions.menus ?? []) as ObjectValue[]) {
      reference('commands', menu.command, 'menus');
      if (menu.icon) reference('icons', menu.icon, 'menus');
      if (menu.items) menuItems(menu.items as ObjectValue[], id, owned, `${path}/contributes/menus`, reference);
      allMenus.push(menu);
    }
    for (const layout of (contributions.layouts ?? []) as ObjectValue[]) {
      if (!(manifest.permissions as string[]).includes('ui.customize')) error('PermissionDenied', `${path}/permissions`, [id]);
      const rules = layout.rules as unknown as Placement[];
      for (const rule of rules) for (const target of [rule.id, rule.target]) if (!(target.startsWith(`${layout.location}/`) || ((contributions.menus ?? []) as ObjectValue[]).some(menu => menu.id === target && menu.location === layout.location))) error('UnknownReference', `${path}/contributes/layouts`, [target]);
      try { proposalOrder([], rules); } catch (cause) { if (cause instanceof OrderingCycle) error('OrderingCycle', `${path}/contributes/layouts`, cause.ids); else throw cause; }
    }
    if (knownContributions.some(kind => ((contributions[kind] ?? []) as Json[]).length) && !(manifest.permissions as string[]).includes('ui.contribute')) error('PermissionDenied', `${path}/permissions`, [id]);
  }
  const dependencies: [string, string][] = [];
  for (const [index, manifest] of packages.entries()) for (const [id, range] of Object.entries((manifest.dependencies ?? {}) as ObjectValue).sort(([a], [b]) => compareText(a, b))) {
    const path = `$/${index}/dependencies/${id}`;
    packageId(id, path);
    // Parse even when the dependency is absent so malformed ranges have a stable error.
    matches(range as string, '1.0.0', path);
    const dependency = packages.find(item => item.id === id);
    if (!dependency) error('UnknownReference', path, [id]);
    if (!matches(range as string, dependency.version as string, path)) error('IncompatibleDependency', path, [id]);
    dependencies.push([id, manifest.id as string]);
  }
  const activationOrder = orderGraph([...ids], dependencies, 'DependencyCycle', '$/dependencies');
  const edges: [string, string][] = [];
  for (const menu of allMenus) for (const key of ['before', 'after']) for (const target of (menu[key] ?? []) as string[]) {
    if (!allMenus.some(item => item.id === target && item.location === menu.location)) error('UnknownReference', '$/ordering', [target]);
    edges.push(key === 'before' ? [menu.id as string, target] : [target, menu.id as string]);
  }
  const menuOrder = orderGraph(allMenus.map(item => item.id as string), edges, 'OrderingCycle', '$/ordering', (a, b) => {
    const left = allMenus.find(item => item.id === a)!, right = allMenus.find(item => item.id === b)!;
    for (const key of ['location', 'group']) { const x = String(left[key] ?? ''), y = String(right[key] ?? ''); if (x !== y) return compareText(x, y); }
    return Number(left.order ?? 0) - Number(right.order ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  });
  return { packages, activationOrder, menuOrder };
}

/** Inputs are JSON data, not host objects. Callers must bound raw bytes before parsing as well. */
export function validateContract(kind: string, value: unknown): Validation {
  try {
    const budget = { nodes: 0, bytes: 0 };
    bounded(value, '$', 0, budget);
    if (budget.bytes > CONTRACT_LIMITS.bytes) error('LimitExceeded', '$');
    const diagnostics: Diagnostic[] = [];
    const result = kind === 'packages' ? manifests(value, diagnostics) : publicShapes.includes(kind) ? shape(value, definitions[kind], '$', diagnostics) : error('InvalidShape', '$');
    if (kind === 'dialog') dialogFields(result as ObjectValue, '$');
    if (kind === 'selectOptions') distinct(result as ObjectValue[], 'value', '$');
    if (kind === 'command' && ((result as ObjectValue).definition as ObjectValue).action) {
      const action = ((result as ObjectValue).definition as ObjectValue).action as ObjectValue;
      if (action.kind === 'showDialog') dialogFields(action.dialog as ObjectValue, '$/definition/action/dialog');
    }
    if (kind === 'command' || kind === 'contribution') {
      const entry = result as ObjectValue, owner = entry.owner as ObjectValue, definition = entry.definition as ObjectValue;
      packageId(owner.extensionId as string, '$/owner/extensionId');
      if (!(definition.id as string).startsWith(`${owner.extensionId}/`)) error('InvalidId', '$/definition/id', [definition.id as string]);
      if (kind === 'contribution' && definition.items) menuItems(definition.items as ObjectValue[], owner.extensionId as string, new Set([definition.id as string]), '$/definition/items');
    }
    return { ok: true, value: result, diagnostics };
  } catch (cause) { return { ok: false, error: cause instanceof ContractFailure ? cause.detail : { schemaVersion: 1, code: 'InvalidShape', path: '$', ids: [] } }; }
}

/** Explicit AST interpretation; missing keys never compare equal and there is no coercion. */
export function evaluateCondition(expression: unknown, context: unknown): Validation {
  const parsed = validateContract('expression', expression), captured = validateContract('context', context);
  if (!parsed.ok) return parsed;
  if (!captured.ok) return captured;
  const values = captured.value as ObjectValue;
  const visit = (node: Json): boolean => {
    if (typeof node === 'boolean') return node;
    const item = node as ObjectValue;
    const value = item.key === 'selection.kind' ? (values.selection as ObjectValue | undefined)?.kind : values[String(item.key)];
    switch (item.op) {
      case 'has': return value !== undefined;
      case 'eq': return value !== undefined && value === item.value;
      case 'not': return !visit(item.arg);
      case 'all': return (item.args as Json[]).every(visit);
      case 'any': return (item.args as Json[]).some(visit);
      default: return false;
    }
  };
  return { ok: true, value: visit(parsed.value), diagnostics: [...parsed.diagnostics, ...captured.diagnostics] };
}
