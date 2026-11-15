/** Pure v1 data validation. This module grants no permissions and activates nothing. */
import schemaDocument from './schema-v1.json' with { type: 'json' };
import { proposalOrder, OrderingCycle, type Placement } from './ordering.ts';
import { contrast, parseHex } from '../color.ts';
import { validDiscoveryRoots, type DiscoveryRoot } from './provider-discovery.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Schema = { [key: string]: unknown };
export type ContractError = { schemaVersion: 1; code: string; path: string; ids: string[] };
export type Diagnostic = { code: 'UnknownOptionalField' | 'UnknownOptionalCapability'; path: string };
export type Validation = { ok: true; value: Json; diagnostics: Diagnostic[] } | { ok: false; error: ContractError };
const definitions = schemaDocument.$defs as Record<string, Schema>;
export const CONTRACT_LIMITS = Object.freeze({ ...schemaDocument['x-dataLimits'] });
export const MENU_LIMITS = Object.freeze({ ...schemaDocument['x-menuLimits'] });
type PrimitiveFamily = { carrier: { def: string; key: string }; kinds: string[]; limits: Record<string, { value: number; at: string[] }> };
/** Public primitive declaration shared with the native validator; renderers read their limits here. */
export const PRIMITIVES = deepFreeze(structuredClone(schemaDocument['x-primitives'])) as unknown as {
  readonly contractVersion: 1; readonly families: Readonly<Record<string, PrimitiveFamily>>;
  readonly hosts: Readonly<Record<string, { accepts: string[]; degrades: Record<string, string>; omits: string[]; disables: string[]; rejects?: string[] }>>;
  readonly accessibility: readonly string[]; readonly excluded: readonly string[];
};
/** One declared limit of a primitive family, e.g. `primitiveLimit('field', 'text')`. */
export function primitiveLimit(family: string, name: string): number { return PRIMITIVES.families[family].limits[name].value; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
const knownContributions = ['commands', 'icons', 'menus', 'views', 'layouts', 'settings', 'keybindings', 'dialogExtras', 'themes', 'components', 'tools', 'connections', 'services', 'providers'];
const capabilities = ['btw.content', 'btw.taskControl', 'services.call', 'connections.request', 'tools.execute', 'ui.contribute', 'ui.customize', 'ui.richViews', 'storage.private', 'projects.summary', 'tasks.summary', 'harnesses.inventory', 'connections.summary', 'jobs.summary', 'projects.files.metadata', 'projects.files.read', 'projects.git.read', 'tasks.transcript.read', 'tasks.tools.read'];
/** Every manifest permission/capability this validator accepts; author documentation is checked against it. */
export const MANIFEST_CAPABILITIES: readonly string[] = Object.freeze([...capabilities]);
export const MANIFEST_CONTRIBUTIONS: readonly string[] = Object.freeze([...knownContributions]);
const publicShapes = ['tilesPresentation', 'tilesAction', 'projectPickerPresentation', 'projectPickerAction', 'threadExtrasPresentation', 'threadExtrasAction', 'composerAttachPresentation', 'composerAttachAction', 'composerPanelsPresentation', 'composerPanelsAction', 'composerPresentation', 'composerAction', 'statusPresentation', 'statusAction', 'rosterPresentation', 'rosterAction', 'dockPresentation', 'dockAction', 'sidebarPresentation', 'sidebarAction', 'sidebarBotsPresentation', 'sidebarBotsAction', 'settingsPresentation', 'settingsAction', 'dialogAccessory', 'machinesPresentation', 'machinesAction', 'cloudPresentation', 'cloudAction', 'moodboardPresentation', 'moodboardAction', 'worktreePresentation', 'worktreeAction', 'pullPresentation', 'pullAction', 'githubHubPresentation', 'githubHubAction', 'boardPresentation', 'boardAction', 'btwPresentation', 'btwAction', 'designPresentation', 'designAction', 'command', 'surface', 'contribution', 'context', 'error', 'expression', 'dialog', 'selectOptions', 'view', 'viewControl', 'documentPresentation', 'documentAction', 'changesPresentation', 'changesAction', 'searchPresentation', 'searchAction', 'browserPresentation', 'browserAction', 'terminalPresentation', 'terminalAction', 'simulatorPresentation', 'simulatorAction', 'vmPresentation', 'vmAction', 'projectScope'];
const object = (v: Json): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
class ContractFailure {
  detail: ContractError;
  constructor(detail: ContractError) { this.detail = detail; }
}
function error(code: string, path: string, ids: string[] = []): never { throw new ContractFailure({ schemaVersion: 1, code, path: [...path].slice(0, 512).join(''), ids: ids.slice(0, 64) }); }
// Match Rust's Unicode scalar/UTF-8 order, not JavaScript's UTF-16 default sort.
// No `u` flag on purpose: this must match any surrogate code unit, paired or not.
const surrogate = /[\uD800-\uDFFF]/;
function compareText(a: string, b: string): number {
  // Without surrogates, UTF-16 code units are code points, so the native order already matches.
  if (!surrogate.test(a) && !surrogate.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
// Schema patterns are a small fixed set; non-global expressions keep no state between exec calls.
const compiledPatterns = new Map<string, RegExp>();
function fullMatch(pattern: string, value: string): boolean {
  let expression = compiledPatterns.get(pattern);
  if (!expression) { expression = new RegExp(pattern); compiledPatterns.set(pattern, expression); }
  const match = expression.exec(value);
  return match !== null && match[0] === value;
}

/** UTF-8 length of a string's JSON form, computed without encoding (validation runs on hot UI paths). */
function quotedBytes(value: string): number {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xD800 && unit <= 0xDBFF && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}
function codePoints(value: string): number { return surrogate.test(value) ? [...value].length : value.length; }
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
      { const length = codePoints(value); if (length < Number(schema.minLength ?? 0) || length > Number(schema.maxLength ?? Infinity)) error('LimitExceeded', path); }
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

/** Returns a deterministic topological order, or the sorted IDs still in a cycle. Each step takes the
 * lowest-ranked node with no remaining predecessor; `rank` is a total order over distinct IDs. Kahn's
 * algorithm keeps this linear in edges, so 1,000 menus no longer re-sort every step. */
function orderGraph(nodes: string[], edges: [string, string][], code: string, path: string, rank: (a: string, b: string) => number = (a, b) => a < b ? -1 : a > b ? 1 : 0): string[] {
  const remaining = new Set(nodes), result: string[] = [];
  const blockers = new Map<string, number>(), successors = new Map<string, string[]>();
  for (const [from, to] of edges) if (remaining.has(from) && remaining.has(to)) {
    blockers.set(to, (blockers.get(to) ?? 0) + 1);
    if (!successors.has(from)) successors.set(from, []);
    successors.get(from)!.push(to);
  }
  // Rank once (n log n comparisons); choosing the next ready node then compares positions only.
  const position = new Map([...remaining].sort(rank).map((id, index) => [id, index]));
  const ready = [...remaining].filter(id => !blockers.get(id));
  while (ready.length) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (position.get(ready[i])! < position.get(ready[best])!) best = i;
    const [id] = ready.splice(best, 1); remaining.delete(id); result.push(id);
    for (const to of successors.get(id) ?? []) { const left = blockers.get(to)! - 1; blockers.set(to, left); if (!left) ready.push(to); }
  }
  if (remaining.size) error(code, path, [...remaining].sort());
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
    for (const theme of (contributions.themes ?? []) as ObjectValue[]) for (const mode of ['light', 'dark']) {
      const colors = theme[mode] as ObjectValue;
      const background = parseHex(String(colors.background))!.rgb;
      if (contrast(background, parseHex(String(colors.foreground))!.rgb) < 7 || contrast(background, parseHex(String(colors.accent))!.rgb) < 3) error('InvalidAppearanceContrast', `${path}/contributes/themes`);
    }
    const executable = [...((contributions.commands ?? []) as ObjectValue[]).filter(command => (command.action as ObjectValue).kind === 'runCommand').map(command => command.id), ...((contributions.providers ?? []) as ObjectValue[]).map(provider => provider.id)];
    const events = (manifest.runtime as ObjectValue | undefined)?.activationEvents as Json[] | undefined;
    for (const provider of (contributions.providers ?? []) as ObjectValue[]) {
      if (!validDiscoveryRoots(String(provider.id), (provider.discovery ?? []) as DiscoveryRoot[])) error('PermissionDenied', `${path}/contributes/providers/discovery`, [String(provider.id)]);
      if (!manifest.runtime) error('UnsupportedRuntime', path, [id]);
      const metadata = provider.metadata as ObjectValue | undefined;
      const modes = metadata?.modes as Json[] | undefined;
      if (modes && new Set(modes).size !== modes.length) error('DuplicateId', path, [id]);
      if (metadata?.icon && (!String(metadata.icon).startsWith(`${id}/`) || !((contributions.icons ?? []) as ObjectValue[]).some(icon => icon.id === metadata.icon))) error('MissingReference', path, [String(metadata.icon)]);
      const models = provider.models as ObjectValue[];
      // Core storage and launcher validate UTF-8 bytes, not schema character counts.
      if (models.some(model => new TextEncoder().encode(String(model.id)).length > 200)) error('LimitExceeded', `${path}/contributes/providers/models`);
      if (new Set(models.map(model => model.id)).size !== models.length || models.some(model => new Set(model.efforts as Json[]).size !== (model.efforts as Json[]).length)) error('DuplicateId', path, [id]);
    }
    if (manifest.runtime && (!executable.length || events?.length !== new Set(events).size || events.some(event => !executable.includes(event))) || executable.some(id => !events?.includes(id))) error('UnsupportedRuntime', path, [id]);
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
    const toolCommands = new Set<Json>();
    for (const service of (contributions.services ?? []) as ObjectValue[]) {
      if (!manifest.runtime) error('UnsupportedRuntime', path);
      const methods = new Set<Json>();
      for (const method of service.methods as ObjectValue[]) { if (methods.has(method.id)) error('DuplicateId', path); methods.add(method.id); }
    }
    for (const connection of (contributions.connections ?? []) as ObjectValue[]) {
      reference('commands', connection.command, 'connections');
      if (!executable.includes(connection.command) || !(manifest.permissions as string[]).includes('connections.request') || toolCommands.has(connection.command)) error('PermissionDenied', `${path}/contributes/connections`);
      toolCommands.add(connection.command);
      const operations = connection.operations as ObjectValue[];
      if (new Set(operations.map(operation => operation.id)).size !== operations.length) error('DuplicateId', `${path}/contributes/connections`);
      for (const operation of operations) {
        let url: URL; try { url = new URL(String(operation.url)); } catch { error('PermissionDenied', `${path}/contributes/connections`); }
        if (!(url!.protocol === 'https:' || url!.protocol === 'http:' && url!.hostname === '127.0.0.1') || url!.username || url!.password || url!.search || url!.hash) error('PermissionDenied', `${path}/contributes/connections`);
      }
    }
    for (const tool of (contributions.tools ?? []) as ObjectValue[]) {
      reference('commands', tool.command, 'tools');
      if (!executable.includes(tool.command) || !(manifest.permissions as string[]).includes('tools.execute') || toolCommands.has(tool.command)) error('PermissionDenied', `${path}/contributes/tools`);
      toolCommands.add(tool.command);
    }
    for (const command of (contributions.commands ?? []) as ObjectValue[]) {
      if (command.icon) reference('icons', command.icon, 'commands');
      const action = command.action as ObjectValue;
      if (action.kind === 'openView') reference('views', action.view, 'commands');
      if (action.kind === 'showDialog') dialogFields(action.dialog as ObjectValue, `${path}/contributes/commands`);
    }
    for (const view of (contributions.views ?? []) as ObjectValue[]) {
      if (view.rich && !(manifest.permissions as string[]).includes('ui.richViews')) error('PermissionDenied', `${path}/permissions`, [id]);
      for (const item of (view.toolbar ?? []) as ObjectValue[]) reference('commands', item.command, 'views');
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
  const menusById = new Map(allMenus.map(item => [item.id as string, item]));
  for (const menu of allMenus) for (const key of ['before', 'after']) for (const target of (menu[key] ?? []) as string[]) {
    if (menusById.get(target)?.location !== menu.location) error('UnknownReference', '$/ordering', [target]);
    edges.push(key === 'before' ? [menu.id as string, target] : [target, menu.id as string]);
  }
  const menuOrder = orderGraph(allMenus.map(item => item.id as string), edges, 'OrderingCycle', '$/ordering', (a, b) => {
    const left = menusById.get(a)!, right = menusById.get(b)!;
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
    if (kind === 'projectScope') { const projects = ((result as ObjectValue).projects ?? []) as string[]; const duplicate = projects.find((id, index) => projects.indexOf(id) !== index); if (duplicate !== undefined) error('DuplicateId', '$/projects', [duplicate]); }
    if (kind === 'selectOptions') distinct(result as ObjectValue[], 'value', '$');
    if (kind === 'searchPresentation') distinct((result as ObjectValue).results as ObjectValue[], 'id', '$/results');
    if (kind === 'changesPresentation') {
      const props = result as ObjectValue, files = props.files as ObjectValue[];
      distinct(files, 'id', '$/files'); distinct(files, 'diffId', '$/files');
      distinct(props.controls as ObjectValue[], 'id', '$/controls');
      for (const file of files) { distinct(file.hunks as ObjectValue[], 'id', '$/files/hunks'); distinct(file.controls as ObjectValue[], 'id', '$/files/controls'); }
      if (props.selected && !files.some(file => file.id === props.selected)) error('InvalidShape', '$/selected');
    }
    if (kind === 'documentPresentation') {
      const props = result as ObjectValue, tabs = props.tabs as ObjectValue[];
      distinct(tabs, 'id', '$/tabs'); distinct(tabs, 'documentId', '$/tabs');
      for (const tab of tabs) distinct(tab.controls as ObjectValue[], 'id', '$/tabs/controls');
      if (props.selected && !tabs.some(tab => tab.id === props.selected)) error('InvalidShape', '$/selected');
    }
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
