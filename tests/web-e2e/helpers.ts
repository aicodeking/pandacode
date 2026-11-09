import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';

export type Workspace = { base: string; workspace: string; repo: string; outside: string };
export const workspace = (): Workspace => JSON.parse(readFileSync('.web-e2e/host.json', 'utf8')).workspace;

export type Reply = { status: number; body: any };

/** Calls the gateway exactly like the web client: same origin, session cookie, CSRF header. */
export async function api(page: Page, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply> {
  return page.evaluate(async ({ method, path, body, extraHeaders }) => {
    const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('pandacode_csrf='))?.slice('pandacode_csrf='.length) ?? '';
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-request-id': crypto.randomUUID(), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, body: parsed };
  }, { method, path, body, extraHeaders });
}

const exercised = new Set<string>();
/** Runs a brokered native command and records it as exercised end to end. */
export async function cmd(page: Page, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const reply = await api(page, 'POST', `/api/pandacode/commands/${name}`, args);
  if (reply.status === 200) record(name);
  return reply;
}
export function record(name: string) {
  if (exercised.has(name)) return;
  exercised.add(name);
  mkdirSync('.web-e2e', { recursive: true });
  appendFileSync('.web-e2e/exercised.txt', `${name}\n`);
}

/** A page on the paired origin (no workspace UI needed for API-level specs). */
export async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => document.cookie.includes('pandacode_csrf='));
}

export async function rootId(page: Page): Promise<string> {
  const roots = await api(page, 'GET', '/api/pandacode/files/roots');
  const list = Array.isArray(roots.body) ? roots.body : roots.body.roots;
  return list.find((root: { label: string }) => root.label === 'E2E').id;
}

export async function grant(page: Page, path: string, kind: 'file' | 'folder', purpose: string): Promise<Reply> {
  return api(page, 'POST', '/api/pandacode/files/select', { root: await rootId(page), path, kind, purpose });
}

/** Adds workspace/<relative> as a project through a fresh project grant; returns the project. */
export async function addProject(page: Page, relative = 'repo') {
  const selected = await grant(page, relative, 'folder', 'project');
  if (selected.status !== 200) throw new Error(`select failed ${selected.status} ${JSON.stringify(selected.body)}`);
  const added = await cmd(page, 'add_project', { path: selected.body.grant });
  if (added.status !== 200) throw new Error(`add_project failed ${added.status} ${JSON.stringify(added.body)}`);
  return added.body as { id: string; name: string; path: string };
}
