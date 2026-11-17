import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import {
  checkCliIntentDeclarations, CliIntentRegistry, classify, classificationJson, merge, parseSegment, PERMISSION, program, resolve, splitSegments, tokens,
  type Entry,
} from '../src/extensions/runtime-cli-intent';
// Preview column of R0705 (intent rules for package command-line tools). The browser preview runs no harness, so this
// spec runs in the test runner's Node: it checks the declarations, refusals, matching, precedence, collisions and the
// merge into the host classifier through the webview twin (src/extensions/runtime-cli-intent.ts) of the native module
// (src-tauri/src/extensions/runtime_cli_intent.rs, whose tests read the same cases.json). The operations are those of the
// B2 fake command-line tool; the host classification is a stand-in with the fields describeShell returns. No real
// harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-cli-intent/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const cases = read('cases.json');
type Obj = Record<string, any>;

function refusalManifest(scripted: Obj): Obj {
  const copy = structuredClone(manifest);
  const rule = structuredClone(copy.contributes.cliIntents[0]);
  for (const [key, value] of Object.entries(scripted.set ?? {})) rule[key] = value;
  for (const key of scripted.drop ?? []) delete rule[key];
  const list = [rule];
  if (scripted.duplicate) list.push({ ...structuredClone(rule), ...scripted.duplicate });
  copy.contributes.cliIntents = list;
  if (scripted.permissions) copy.permissions = scripted.permissions;
  return copy;
}
const entry = (owner: string, source: Obj): Entry => ({ owner, version: '1.0.0', packageName: owner, rules: (checkCliIntentDeclarations(source) as { rules: Entry['rules'] }).rules });
const tracker = entry('sample.tracker', manifest);
const usable = resolve([tracker]).available;

test.describe('extensions cli intent: R0705 intent rules for command-line tools', () => {
  test('the fixture package is valid and declares the operations', () => {
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    expect(tracker.rules).toHaveLength(manifest.contributes.cliIntents.length);
  });

  for (const scripted of cases.refusals as Obj[]) {
    test(`refuses ${scripted.name} as ${scripted.code}`, () => {
      const result = checkCliIntentDeclarations(refusalManifest(scripted));
      expect(result.ok).toBe(false);
      expect((result as { refusal: { code: string } }).refusal.code).toBe(scripted.code);
      const contract = validateContract('packages', [refusalManifest(scripted)]) as Obj;
      expect(contract.ok).toBe(false);
      expect(JSON.stringify(contract)).toContain(scripted.code);
    });
  }

  test('sixty-five rules are refused as LimitExceeded', () => {
    const copy = structuredClone(manifest);
    copy.contributes.cliIntents = Array.from({ length: 65 }, (_, index) => ({ id: `sample.tracker/r${index}`, command: 'tracker', words: [`w${index}`], intent: { kind: 'read', verb: 'Read' } }));
    expect((checkCliIntentDeclarations(copy) as { refusal: { code: string } }).refusal.code).toBe('LimitExceeded');
  });

  for (const scripted of cases.classify as Obj[]) {
    test(`classifies ${JSON.stringify(scripted.command)} as ${scripted.status}`, () => {
      const result = classify(usable, scripted.command);
      expect(result.status).toBe(scripted.status);
      expect(result.hint?.rule.id ?? null).toBe(scripted.rule);
    });
  }

  test('segments and tokens keep quotes together and Windows paths intact', () => {
    expect(splitSegments('a && b | c; d "x ; y"')).toEqual(['a', 'b', 'c', 'd "x ; y"']);
    expect(splitSegments('tracker "open')).toBeNull();
    expect(tokens('tracker comment 7 "two words"')).toEqual(['tracker', 'comment', '7', 'two words']);
    expect(program('C:\\tools\\Tracker.EXE')).toBe('tracker');
    expect(parseSegment('A=1 B=2 tracker list --json')).toEqual({ command: 'tracker', words: ['list'], flags: ['--json'] });
  });

  test('a collision goes to the earlier package and is recorded', () => {
    const other = structuredClone(manifest);
    other.id = 'sample.other';
    other.contributes.cliIntents = other.contributes.cliIntents.map((rule: Obj) => ({ ...rule, id: rule.id.replace('sample.tracker', 'sample.other') }));
    const { available, conflicts } = resolve([tracker, entry('sample.other', other)]);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.every(conflict => conflict.heldBy === 'sample.tracker')).toBe(true);
    expect(available.every(listed => listed.owner === 'sample.tracker')).toBe(true);
  });

  test('the same operation in a later package with a different match is not a collision', () => {
    const other = structuredClone(manifest);
    other.id = 'sample.other';
    other.contributes.cliIntents = [{ id: 'sample.other/other', command: 'tracker', words: ['list'], flags: ['--json'], intent: { kind: 'search', verb: 'Searched' } }];
    const { available, conflicts } = resolve([tracker, entry('sample.other', other)]);
    expect(conflicts).toEqual([]);
    // The more specific rule (a flag) wins for a line that has it; the plain one still serves the rest.
    expect(classify(available, 'tracker list --json').hint?.rule.id).toBe('sample.other/other');
    expect(classify(available, 'tracker list').hint?.rule.id).toBe('sample.tracker/list');
  });

  test('the host classification keeps its risk and its specific kind: a hint is no gate', () => {
    const result = classify(usable, 'tracker close 7');
    const generic = { kind: 'shell', verb: 'Ran', label: 'tracker', destructive: true, risks: ['Deleted src'] };
    const merged = merge(generic, result) as Obj;
    expect(merged.verb).toBe('Closed');
    expect(merged.destructive).toBe(true);
    expect(merged.risks).toEqual(['Deleted src']);
    expect(merged.packageIntent).toMatchObject({ applied: true, owner: 'sample.tracker', rule: 'sample.tracker/close' });
    const specific = { kind: 'git', verb: 'Pushed', label: 'origin', destructive: false, risks: [] };
    const kept = merge(specific, result) as Obj;
    expect(kept.verb).toBe('Pushed');
    expect(kept.packageIntent.applied).toBe(false);
    expect(merge(generic, classify(usable, 'git status'))).toEqual(generic);
  });

  test('the registry checks the grant per project on every classification and annotates the hook payload', () => {
    let granted = true;
    const registry = new CliIntentRegistry({ source: () => [tracker], holds: (_owner, _version, permission, project) => granted && permission === PERMISSION && project === 'p1' });
    const base = { kind: 'tool.before', tool: { kind: 'shell' } };
    const hit = registry.annotate('p1', 'tracker claim --id=7', base, { kind: 'shell', verb: 'Ran', destructive: false, risks: [] });
    expect((hit.payload.intent as Obj).hint.package).toBe('sample.tracker');
    expect(hit.host.verb).toBe('Started');
    // Another project, or a revoked grant, leaves the host answer and the payload exactly as they were.
    expect(registry.annotate('p2', 'tracker claim --id=7', base, { kind: 'shell', verb: 'Ran' }).payload).toBe(base);
    granted = false;
    expect(registry.classify('p1', 'tracker claim --id=7').status).toBe('NoRule');
    expect(JSON.stringify(classificationJson(classify(usable, 'tracker list')))).not.toContain('secret');
  });
});
