import type { Page } from '@playwright/test';

/* Long threads for the windowing specs. The preview keeps its messages private to its module, so the test copy of
 * that module also exposes them, and applies any threads given before it loads. */

export type FixtureMessage = { id: number; sessionId: string; role: string; content: string; createdAt: number };

const BASE_ID = 100_000, BASE_TIME = 1_700_000_000_000;

export function say(n: number, role: string, content: string, sessionId = 'mirror-long', createdAt = BASE_TIME + n * 1000): FixtureMessage {
  return { id: BASE_ID + n, sessionId, role, content, createdAt };
}
export const accountSwitch = (n: number, detail: string): FixtureMessage => say(n, 'system', `Account switched\n${detail}`);

/** Call before `page.goto`. `threads` are in place before the app's first request. */
export async function exposePreviewMessages(page: Page, threads: Record<string, FixtureMessage[]> = {}): Promise<void> {
  await page.addInitScript(seeded => { (window as any).__previewSeed = seeded; }, threads);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    if (!/switch\s*\(command\)\s*\{/.test(source)) throw new Error('Preview fixture changed: no command switch');
    // `window.__holdTask = id` holds that thread's get_task until `window.__releaseTask()` (which ends the hold); `window.__holdTeam = id` its
    // team (architect_get, or remote_team for a remote thread) until `window.__releaseTeam()`. `window.__teams[id]`
    // answers for that thread's team in place of the preview's own.
    const hold = [
      // A held command can be asked for more than once (the open, a later refresh): one release lets every waiting call go,
      // and ends the hold, so a call made after it (a run finishing reloads the task list) is never held for good.
      `const holdUntil = name => new Promise(resolve => { const waiting = window['__waiting' + name] ??= []; waiting.push(resolve); window['__release' + name] = () => { window['__hold' + name] = undefined; waiting.splice(0).forEach(go => go()); }; });`,
      `if (command === 'get_task' && args.sessionId === window.__holdTask) await holdUntil('Task');`,
      `if ((command === 'architect_get' || command === 'remote_team') && args.sessionId === window.__holdTeam) await holdUntil('Team');`,
      `if ((command === 'architect_get' || command === 'remote_team') && window.__teams?.[args.sessionId]) return structuredClone(window.__teams[args.sessionId]);`,
    ].join('\n');
    const held = source.replace(/switch\s*\(command\)\s*\{/, `${hold}\n$&`);
    await route.fulfill({ response, body: `${held}\nObject.assign(messages, window.__previewSeed);\nwindow.__previewMessages = messages;\n` });
  });
}

export async function setThread(page: Page, sessionId: string, messages: FixtureMessage[]): Promise<void> {
  await page.evaluate(([id, list]) => { (window as any).__previewMessages[id as string] = list; }, [sessionId, messages] as const);
}

/** The host copied new messages: the open mirror thread redraws. */
export async function announceMirror(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(id => (window as any).__previewEmit('mirror-messages', { sessionId: id }), sessionId);
}

/** `turns` user/assistant pairs, numbered from 0 as `Message 000`, `Message 001`… */
export function pairs(turns: number, sessionId = 'mirror-long'): FixtureMessage[] {
  const text = (n: number) => `Message ${String(n).padStart(3, '0')}`;
  return Array.from({ length: turns }, (_, turn) => [say(turn * 2, 'user', text(turn * 2), sessionId), say(turn * 2 + 1, 'assistant', text(turn * 2 + 1), sessionId)]).flat();
}

const toolRecord = (n: number): string => JSON.stringify({ type: 'tool_activity', version: 1, id: `t${n}`, name: 'Read', status: 'completed', input: `src/file-${n}.ts`, output: 'contents\n'.repeat(20) });

/** `turns` agent turns of six messages: a prompt, narration, three tools and a reply, as `Prompt 000`, `Looking at part 000.`, `Result 000`. */
export function agentTurns(turns: number, sessionId = 'mirror-long', reply: (label: string) => string = label => `Result ${label}`): FixtureMessage[] {
  return Array.from({ length: turns }, (_, turn) => {
    const n = turn * 6, label = String(turn).padStart(3, '0');
    return [
      say(n, 'user', `Prompt ${label}`, sessionId),
      say(n + 1, 'assistant', `Looking at part ${label}.`, sessionId),
      say(n + 2, 'tool', toolRecord(n + 2), sessionId),
      say(n + 3, 'tool', toolRecord(n + 3), sessionId),
      say(n + 4, 'tool', toolRecord(n + 4), sessionId),
      say(n + 5, 'assistant', reply(label), sessionId),
    ];
  }).flat();
}

/** `turns` turns of only tools: a prompt, two tools and a reply, each numbered by `base` so a note can sit between them. */
export function toolTurns(turns: number, sessionId = 'mirror-long'): FixtureMessage[] {
  return Array.from({ length: turns }, (_, turn) => {
    const n = turn * 8, label = String(turn).padStart(3, '0');
    return [say(n, 'user', `Prompt ${label}`, sessionId), say(n + 1, 'tool', toolRecord(n + 1), sessionId), say(n + 2, 'tool', toolRecord(n + 2), sessionId), say(n + 3, 'assistant', `Result ${label}`, sessionId)];
  }).flat();
}

/** Scrolls the scroller at `selector` to its top until an element reading exactly `wanted` is drawn in it. It scrolls
 *  again whenever a step moved the reader off the top or drew rows above, and otherwise waits on the step in flight
 *  (formatting, a fetch): it waits on what the window does, never on a fixed time. */
export async function scrollTopUntil(page: Page, selector: string, wanted: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(([css, text]) => {
    const node = document.querySelector<HTMLElement>(css) as (HTMLElement & { __topFirst?: Element | null }) | null;
    if (!node) return false;
    for (const element of node.querySelectorAll('*')) if (!element.childElementCount && element.textContent?.trim() === text) return true;
    if (node.scrollTop > 0 || node.__topFirst !== node.firstElementChild) {
      node.__topFirst = node.firstElementChild;
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    }
    return false;
  }, [selector, wanted] as const, { polling: 'raf', timeout });
}

/** Waits until `selector`'s subtree stops changing: no mutation across two frames and the idle time after them, so
 *  steps, fills, formatting and far rows set aside have all landed. For a baseline taken before an action; a check
 *  that something does NOT happen still waits a fixed time. */
export async function settled(page: Page, selector = '#transcript'): Promise<void> {
  await page.waitForFunction(wanted => new Promise<boolean>(resolve => {
    const node = document.querySelector(wanted);
    let changed = false;
    const observer = new MutationObserver(() => { changed = true; });
    if (node) observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
    const idle = (run: () => void): unknown => typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 500 }) : setTimeout(run, 50);
    requestAnimationFrame(() => requestAnimationFrame(() => idle(() => { observer.disconnect(); resolve(!changed); })));
  }), selector, { polling: 100 });
}
