import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CompanionLifetime } from '../src/extensions/runtime-companion-lifetime';
import { CallbackSession, callbackProfile, translateCallback } from '../src/extensions/runtime-callback-companions';
import type { Json } from '../src/extensions/runtime-hook-payload';

type Obj = { [key: string]: Json };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-callback-companions/frames.json', import.meta.url), 'utf8')) as {
  provenance: string; liveCapture: boolean; modes: string[]; harnesses: string[]; request: Obj; answer: Obj;
};
function setup(harness: string) {
  const host = new CompanionLifetime('fixture-host'); const profile = callbackProfile(harness)!;
  const installed = { harness, version: profile.versions[0]!, apis: [profile.api] };
  const key = { taskId: 'task', runId: 'run' };
  const launch = host.begin(key, ['sample.guard'], installed, profile, () => ({ env: {}, close() {} }));
  return { host, key, session: new CallbackSession(host, launch.lease, installed) };
}
test('extensions callback companions: source frames route once by id in every supported mode', () => {
  expect(fixture.provenance).toBe('synthetic'); expect(fixture.liveCapture).toBe(false);
  for (const harness of fixture.harnesses) for (const mode of fixture.modes.filter(mode => mode !== 'review' || ['claude', 'glm', 'mimo'].includes(harness))) {
    const { host, key, session } = setup(harness); const pi = ['pi', 'omp'].includes(harness);
    expect(session.registration()).toBeTruthy();
    const frame = pi ? { protocol: 1, id: 'callback-a', event: 'PreToolUse', input: { tool_use_id: 'call-a', tool_name: 'bash', tool_input: { command: mode } } } : fixture.request;
    expect(session.receive(frame).call).toBe('call-a');
    const other = pi ? { ...frame, id: 'callback-b' } : { ...frame, request_id: 'callback-b' };
    session.receive(other);
    expect(JSON.stringify(session.reply('callback-b', { decision: 'deny', reason: 'Guard reason' }))).toContain('Guard reason');
    const reply = session.reply('callback-a', fixture.answer);
    expect(JSON.stringify(reply)).toContain('echo rewritten');
    expect(() => session.reply('callback-a', fixture.answer)).toThrow('StaleContext');
    expect(() => session.receive(frame)).toThrow('Conflict');
    const late = pi ? { ...frame, id: 'late' } : { ...frame, request_id: 'late' }; session.receive(late);
    host.end(key, 'revoked'); expect(() => session.reply('late', { decision: 'approve' })).toThrow('StaleContext');
  }
});
test('extensions callback companions: unknown versions and event powers keep their boundary', () => {
  const { host } = setup('claude');
  expect(() => new CallbackSession(host, { taskId: 'other', runId: 'other', leaseId: 'invented' }, { harness: 'claude', version: 'installed-unqualified', apis: ['claude.initialize.hooks.v1'] })).toThrow('UnsupportedCapability');
  expect(translateCallback('PreCompact', { summary: 'Cannot supply Claude summary' })).toEqual({});
  expect(translateCallback('UserPromptSubmit', { prompt: 'Cannot replace via callback' })).toEqual({});
  expect(translateCallback('PostCompact', { cancel: true })).toEqual({});
});
test('extensions callback companions: actual Pi bridge consults full mode and mutates structured input', async () => {
  const previous = process.env.PANDACODE_PI_BRIDGE;
  process.env.PANDACODE_PI_BRIDGE = JSON.stringify({ mode: 'full', companion: { protocol: 1 } });
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
  try {
    // The shipped extension runs against an in-process fixture API; no Pi/omp CLI is executed.
    const extension = await import(pathToFileURL(resolve('src-tauri/src/providers/pi-extension.mjs')).href);
    await extension.default({ on(name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) { handlers.set(name, fn); }, registerTool() {} });
    const event = { toolName: 'bash', toolCallId: 'call-a', input: { command: 'old' } };
    let consulted = 0;
    await handlers.get('tool_call')!(event, { ui: { async input() { consulted++; return JSON.stringify({ input: { command: 'new' } }); }, async confirm() { throw new Error('Rewrite should not prompt'); } } });
    expect(consulted).toBe(1); expect(event.input).toEqual({ command: 'new' });
    expect(process.env.PANDACODE_PI_BRIDGE).toBeUndefined();
  } finally { if (previous === undefined) delete process.env.PANDACODE_PI_BRIDGE; else process.env.PANDACODE_PI_BRIDGE = previous; }
});
