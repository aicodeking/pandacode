/// <reference types="node" />
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { HOME, landing, SIGN_IN } from '../src/routes.ts';

const app = new URL('../src/app/', import.meta.url);

test('landing routes are real screens, not a group without an index', () => {
  assert.equal(landing(true), HOME);
  assert.equal(landing(false), SIGN_IN);
  assert.ok(existsSync(new URL('(tabs)/inbox/index.tsx', app)));
  assert.ok(existsSync(new URL('sign-in.tsx', app)));
});

test('every root guard names its redirect', () => {
  // Without redirectTo a flipped guard redirects to the anchor, `/(tabs)` = `/`: Unmatched Route.
  const layout = readFileSync(new URL('_layout.tsx', app), 'utf8');
  const guards = layout.match(/<Stack\.Protected\b[^>]*>/g) ?? [];
  assert.equal(guards.length, 2);
  for (const guard of guards) assert.match(guard, /redirectTo=\{(HOME|SIGN_IN)\}/);
});

test('every root screen the layout names has a route file', () => {
  const layout = readFileSync(new URL('_layout.tsx', app), 'utf8');
  const names = [...layout.matchAll(/<Stack\.Screen name="([^"]+)"/g)].map(m => m[1]);
  for (const name of ['pull', 'changes', 'diff']) assert.ok(names.includes(name), name);
  for (const name of names) assert.ok(existsSync(new URL(`${name}.tsx`, app)) || existsSync(new URL(`${name}/_layout.tsx`, app)), name);
});
