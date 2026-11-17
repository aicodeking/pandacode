import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import {
  baseName, blockedMessage, compactionCan, CompactionFold, compose, CONTEXT_HEADING, hookContextHtml, NOT_WRITTEN, NOTES_HEADING, PromptFold,
  splitHookContext, ToolAfterFold, type Fold, type Receipt, type Step,
} from '../src/extensions/runtime-hook-context';
// Preview column of R0504 (prompt context, rewrite and block, result rewrites and compaction answers). The browser
// preview runs no harness, so this spec runs in the test runner's Node: it folds the shared scripted returns through
// the webview twin (src/extensions/runtime-hook-context.ts) of the native folds
// (src-tauri/src/extensions/runtime_hook_context.rs, whose tests read the same fixture), checks the message as sent and
// the transcript's collapsible reading of it, and drives the fixture service (main.cjs) through a stand-in of the
// service SDK. No real harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-hook-context/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const script = read('returns.json');
const compaction = read('compaction.json');
type Obj = Record<string, any>;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fold(target: Fold, steps: Step[], base: Obj, seen: (payload: Obj) => unknown): { asked: number; shown: unknown[] } {
  let asked = 0; const shown: unknown[] = [];
  for (const step of steps) {
    if (target.stopped()) break;
    shown.push(seen(target.payload(base)));
    target.step(step);
    asked += 1;
  }
  return { asked, shown };
}
const receipts = (list: Receipt[]) => list.map(receipt => ({ owner: receipt.owner, applied: receipt.applied, ...(receipt.code ? { code: receipt.code } : {}), ...(receipt.refused ? { refused: receipt.refused } : {}) }));

test.describe('R0504 hook returns the host applies', () => {
  test('the fixture package is valid and declares the awaited events', () => {
    const result = validateContract('packages', [manifest]) as Obj;
    expect(result.ok).toBe(true);
    expect(manifest.contributes.hooks.map((hook: Obj) => hook.event)).toEqual(['prompt.submit', 'tool.after', 'compaction', 'turn.start']);
  });

  for (const scripted of script.cases as Obj[]) {
    test(`scripted returns: ${scripted.id}`, () => {
      const expected = scripted.expect;
      const steps = scripted.steps as Step[];
      if (scripted.event === 'prompt.submit') {
        const target = new PromptFold(scripted.text);
        const { asked, shown } = fold(target, steps, { text: '' }, payload => payload.text);
        expect(target.text).toBe(expected.text);
        expect(target.contexts).toEqual(expected.contexts);
        expect(target.rewrittenBy).toEqual(expected.rewrittenBy);
        expect(target.notes).toEqual(expected.notes);
        expect(target.blocked).toEqual(expected.blocked);
        expect(asked).toBe(expected.asked);
        if (expected.seen) expect(shown).toEqual(expected.seen);
        expect(receipts(target.receipts)).toEqual(expected.receipts);
      } else if (scripted.event === 'tool.after') {
        const target = new ToolAfterFold(scripted.can, scripted.output);
        const { asked, shown } = fold(target, steps, { output: scripted.output }, payload => payload.output);
        expect(target.output ?? null).toEqual(expected.output);
        expect(target.by).toEqual(expected.by);
        expect(target.notes).toEqual(expected.notes);
        expect(asked).toBe(expected.asked);
        if (expected.seen) expect(shown).toEqual(expected.seen);
        expect(receipts(target.receipts)).toEqual(expected.receipts);
      } else {
        const target = new CompactionFold(scripted.can);
        const { asked } = fold(target, steps, {}, payload => payload.can);
        expect(target.cancel === null ? null : { by: target.cancel[0], reason: target.cancel[1] }).toEqual(expected.cancel);
        expect(target.instructions).toEqual(expected.instructions);
        expect(target.summaries).toEqual(expected.summaries);
        expect(asked).toBe(expected.asked);
        expect(receipts(target.receipts)).toEqual(expected.receipts);
      }
    });
  }

  test('context is sent as attributed blocks and shown as one collapsible block', () => {
    const notes = `${NOTES_HEADING}\n- [Messenger] CI is flaky.`;
    const sent = compose('hello', [['Recall', 'Uses pnpm.\n\nAnd Node 22.']], notes);
    expect(sent).toBe(`hello\n\n${CONTEXT_HEADING} Recall ${NOT_WRITTEN}\nUses pnpm.\nAnd Node 22.\n\n${notes}`);
    const { typed, blocks } = splitHookContext(sent);
    expect(typed).toBe('hello');
    expect(blocks).toEqual([{ kind: 'context', by: ['Recall'], text: 'Uses pnpm.\nAnd Node 22.' }, { kind: 'notes', by: ['Messenger'], text: '- [Messenger] CI is flaky.' }]);
    const html = hookContextHtml(blocks, escape);
    expect(html).toMatch(/^<details class="message-context hook-context"><summary>Context added by Recall, Messenger<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    // A message a package sent (R0402) carries its notes in front: they fold the same way.
    expect(splitHookContext(`${notes}\n\nrun the tests`)).toEqual({ typed: 'run the tests', blocks: [{ kind: 'notes', by: ['Messenger'], text: '- [Messenger] CI is flaky.' }] });
    // Nothing added: the message is what the user wrote, and nothing is drawn.
    expect(splitHookContext('plain text\n\nwith a paragraph')).toEqual({ typed: 'plain text\n\nwith a paragraph', blocks: [] });
    expect(hookContextHtml([], escape)).toBe('');
    expect(hookContextHtml([{ kind: 'context', by: ['<b>'], text: '<script>' }], escape)).not.toContain('<script>');
  });

  test('a block returns the message to the draft with the reason', () => {
    expect(blockedMessage({ by: 'Guard', reason: 'The message names a secret.', failed: false })).toBe('Not sent: blocked by Guard. The message names a secret.');
    expect(blockedMessage({ by: 'Guard', reason: 'Guard did not answer (Timeout).', failed: true })).toBe('Not sent: Guard did not answer (Timeout).');
  });

  test('compaction offers only what the host can apply', () => {
    expect(compactionCan('claude')).toEqual(['cancel', 'instructions']);
    expect(compactionCan('codex')).toEqual(['cancel']);
    for (const harness of ['claude', 'codex', 'opencode', 'kimi']) expect(compactionCan(harness)).not.toContain('summary');
    expect(baseName('mcp__pandacode__pandacode_echo')).toBe('pandacode_echo');
    expect(baseName('pandacode.pandacode_echo')).toBe('pandacode_echo');
  });

  test('sinceCompaction resets once per step, with or without a running turn', () => {
    // The rule of HookRegistry::since_compaction / compacted, replayed on the shared script.
    const compacted = new Map<string, number | null>(); const seen = new Set<string>();
    let running: number | null = null; let since = 0;
    for (const step of compaction.steps as Obj[]) {
      if (step.op === 'turn') {
        const at = compacted.get('t');
        since = at === undefined ? step.index - 1 : at === null ? 0 : Math.max(0, step.index - (at + 1));
        if (at === null) compacted.set('t', step.index - 1);
        running = step.index;
        expect(since).toBe(step.expect);
      } else if (step.op === 'compaction') {
        const first = !seen.has(step.step); seen.add(step.step);
        if (first) compacted.set('t', running);
        expect(first && running !== null).toBe(step.delivered);
      } else running = null;
    }
  });

  test('the fixture service answers through the SDK stand-in and records receipts', async () => {
    const require = createRequire(import.meta.url);
    const main = require(fileURLToPath(new URL('main.cjs', fixtures)));
    const handlers = new Map<string, (payload: Obj) => unknown>();
    const applied: ((receipt: Obj) => void)[] = [];
    const commands = new Map<string, (context: Obj) => Promise<unknown>>();
    const panda = {
      hooks: {
        on: (event: string, handler: (payload: Obj) => unknown) => { handlers.set(event, handler); return { ready: Promise.resolve(), dispose: () => handlers.delete(event) }; },
        onApplied: (handler: (receipt: Obj) => void) => { applied.push(handler); return { dispose: () => applied.splice(applied.indexOf(handler), 1) }; },
      },
      commands: { register: (id: string, handler: (context: Obj) => Promise<unknown>) => { commands.set(id, handler); return { dispose: () => commands.delete(id) }; } },
    };
    await main.service(panda, { onStop: () => undefined });
    const ask = async (event: string, payload: Obj, owner = 'sample.hook-context'): Promise<Step> => {
      const value = await handlers.get(event)!(payload);
      return { owner, name: 'Recall', grants: ['harness.hooks.decide', 'harness.hooks.context', 'ui.presentation'], answer: { value: (value ?? null) as any } };
    };
    const turn = (text: string) => ({ schemaVersion: 1, taskId: 't', projectId: 'A', text, sinceCompaction: 0 });

    const recall = new PromptFold('recall: build');
    recall.step(await ask('prompt.submit', recall.payload(turn(''))));
    expect(recall.contexts).toEqual([['Recall', 'Remembered about build: the team uses pnpm.']]);
    expect(recall.notes).toEqual([['Recall', 'Recalled one memory']]);
    const fix = new PromptFold('fix:   tidy the README');
    fix.step(await ask('prompt.submit', fix.payload(turn(''))));
    expect(fix.text).toBe('tidy the README');
    const secret = new PromptFold('print the secret');
    secret.step(await ask('prompt.submit', secret.payload(turn(''))));
    expect(blockedMessage(secret.blocked!)).toBe('Not sent: blocked by Recall. The message names a secret.');

    const echo = new ToolAfterFold(['rewriteResult'], { echo: 'hi' });
    echo.step(await ask('tool.after', echo.payload({ tool: { kind: 'other', name: 'pandacode_echo' }, status: 'completed', output: { echo: 'hi' } })));
    expect(echo.output).toEqual({ rewritten: true, original: { echo: 'hi' } });
    // A call the harness ran: the package's return is not applied, and its receipt says why.
    const harnessRun = new ToolAfterFold([], 'ls');
    harnessRun.step(await ask('tool.after', harnessRun.payload({ tool: { kind: 'other', name: 'pandacode_echo' }, status: 'completed', output: 'ls' })));
    expect(harnessRun.output).toBeUndefined();
    expect(harnessRun.receipts[0]).toEqual({ owner: 'sample.hook-context', applied: false, code: 'UnsupportedCapability', refused: { output: 'UnsupportedCapability' } });
    // A denied call's after event carries no output: the handler returns nothing for it.
    const denied = new ToolAfterFold([], null);
    denied.step(await ask('tool.after', { tool: { kind: 'shell', name: 'Bash' }, status: 'denied', output: null, can: [] }));
    expect(denied.receipts).toEqual([]);

    const before = new CompactionFold(compactionCan('claude'));
    before.step(await ask('compaction', before.payload({ taskId: 't', projectId: 'A', harness: 'claude', phase: 'before' })));
    expect(before.instructions).toEqual([['Recall', 'Keep the API decisions.']]);
    expect(before.receipts[0]).toEqual({ owner: 'sample.hook-context', applied: true, refused: { summary: 'UnsupportedCapability' } });
    for (const receipt of before.receipts) for (const handler of applied) handler({ schemaVersion: 1, hookId: 'sample.hook-context/compaction', event: 'compaction', taskId: 't', ...receipt });

    const received = await commands.get('sample.hook-context/control')!({ args: { op: 'received' } }) as Obj;
    expect(received.received.map((entry: Obj) => entry.event)).toEqual(['prompt.submit', 'prompt.submit', 'prompt.submit', 'tool.after', 'tool.after', 'tool.after', 'compaction']);
    expect(received.receipts).toHaveLength(1);
    expect(received.receipts[0].refused).toEqual({ summary: 'UnsupportedCapability' });
  });
});
