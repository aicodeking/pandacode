// R0306: the installed Windows scenarios of the rich-panel qualification. Driven through the WebView2 debugging
// connection of the installed app (`qualify.mjs` launches it); every observation is read from the real webviews,
// the fixture service's record file and the fake agent's frame log. Nothing here runs in a browser preview.
//
// Each scenario fills its part of `record.scenarios`; a failure records `error` and the run goes on, so one record
// always comes out. The expected values live in `expected.json`; `evaluate.mjs` compares them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BOARD = { id: 'sample.windows-panels', view: 'sample.windows-panels/board', title: 'Qualification board', open: 'Open qualification board' };
const CHART = { id: 'sample.windows-panels', view: 'sample.windows-panels/chart', title: 'Qualification chart', open: 'Open qualification chart' };
const TWIN = { id: 'sample.windows-panels-twin', view: 'sample.windows-panels-twin/board', title: 'Qualification twin', open: 'Open qualification twin' };
const INLINE = { id: 'sample.rich-mount', view: 'sample.rich-mount/board', title: 'Mounted board', open: 'Open mounted board' };
const BAND = { id: 'sample.band-rich', view: 'sample.band-rich/band', title: 'Rich band' };
export const REMOTE_ORIGIN = 'https://charts.windows-panels.test';
const NOTE = 'qualification-note';
const SHELL = /^http:\/\/pandapanel\.(p[0-9a-f]{32})\.localhost\/~panda\/shell\/(extension-(?:panel|view)-[0-9a-f-]+)/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The per-package origin key, as `runtime_rich_assets::origin_key` computes it. */
export function originKey(id) { return `p${createHash('sha256').update(`pandacode-panel-origin-v1:${id}`).digest('hex').slice(0, 32)}`; }
export const panelOrigin = id => `http://pandapanel.${originKey(id)}.localhost`;

/** A task prompt for the B5 fake agent: `ticks` lines one second apart, then the end of the turn. */
export function agentPrompt(ticks = 12) {
  const steps = [];
  for (let tick = 1; tick <= ticks; tick++) steps.push({ say: `tick ${tick}` }, { sleep: 1000 });
  return `#script ${JSON.stringify(steps)}`;
}

async function until(read, { timeout = 10_000, every = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await delay(every);
  }
}

/** Helpers over one connected app; `session` is built by `qualify.mjs`. */
function host(session) {
  const main = () => session.main();
  const invoke = (command, args = {}) => main().evaluate(([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);
  const pages = () => session.context().pages().filter(page => SHELL.test(page.url()));
  const pagesOf = id => pages().filter(page => SHELL.exec(page.url())[1] === originKey(id));
  const pageFor = label => until(() => pages().find(page => SHELL.exec(page.url())[2] === label), { what: `the webview of ${label}` });
  const packageFrame = (page, id) => page.frames().find(frame => frame.url().startsWith(`${panelOrigin(id)}/`) && !frame.url().includes('/~panda/'));
  const slot = view => main().locator(`.extension-rich-panel[aria-label="${view.title} panel — ${view.id}"]`);
  async function open(view) {
    await main().getByRole('button', { name: view.open, exact: true }).click();
    const label = await until(() => slot(view).getAttribute('data-mount-id').catch(() => null), { what: `${view.title} mounted` });
    const page = await pageFor(label);
    const frame = await until(() => packageFrame(page, view.id), { what: `${view.title} document` });
    await until(() => frame.evaluate(() => !!window.__windowsPanels?.init).catch(() => false), { what: `${view.title} initialized` });
    return { label, page, frame };
  }
  const observed = frame => frame.evaluate(() => JSON.parse(JSON.stringify(window.__windowsPanels)));
  const act = (frame, name, ...args) => frame.evaluate(([name, args]) => window.__windowsPanelsDo[name](...args), [name, args]);
  const state = view => slot(view).getAttribute('data-rich-state').catch(() => null);
  const service = () => session.readService();
  return { main, invoke, pages, pagesOf, pageFor, packageFrame, slot, open, observed, act, state, service };
}

async function scenario(record, name, work) {
  const part = record.scenarios[name] = {};
  const started = Date.now();
  try { await work(part); } catch (error) { part.error = String(error?.stack ?? error).slice(0, 2000); }
  part.ms = Date.now() - started;
}

/** Install, trust, enable and grant the staged packages through the main window's own commands. */
async function setup(session, h, part) {
  part.errors = []; part.packages = [];
  for (const item of session.packages) {
    const step = async (what, work) => { try { return await work(); } catch (error) { part.errors.push(`${item.id} ${what}: ${String(error?.message ?? error)}`); return null; } };
    await step('install', () => h.invoke('extensions_install', { path: item.archive }));
    const snapshot = await step('snapshot', () => h.invoke('extensions_snapshot'));
    const digest = snapshot?.packages?.find(entry => entry.manifest.id === item.id)?.executable?.digest;
    if (digest) {
      const reply = await step('trust', () => h.invoke('extensions_runtime', { request: { op: 'trust', id: item.id, digest, allow: true } }));
      if (reply && reply.ok === false) part.errors.push(`${item.id} trust: ${reply.error?.code}`);
    }
    await step('enable', () => h.invoke('extensions_enable', { id: item.id, enabled: true }));
    for (const permission of item.grants) await step(`grant ${permission}`, () => h.invoke('extensions_runtime_grant', { request: { op: 'grant', id: item.id, permission, scope: {} } }));
    part.packages.push({ id: item.id, trusted: !!digest, grants: item.grants });
  }
  const project = await h.invoke('add_project', { path: session.paths.project }).catch(error => { part.errors.push(`project: ${String(error?.message ?? error)}`); return null; });
  part.projectId = project?.id ?? null;
  // The window reads the new snapshot, grants and project the way it does at launch.
  await h.main().reload();
  await until(() => h.main().locator('#prompt').isEnabled().catch(() => false), { timeout: 30_000, what: 'the composer after reload' });
}

export async function runScenarios(session) {
  const record = { scenarios: {} };
  let h = host(session);
  const remoteRequests = [];
  const route = () => session.context().route(`${REMOTE_ORIGIN}/**`, async request => {
    remoteRequests.push(request.request().url());
    const name = new URL(request.request().url()).pathname.slice(1);
    if (name !== 'chart.html') return request.fulfill({ status: 404, body: 'not a fixture' });
    await request.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: readFileSync(new URL('./remote/chart.html', import.meta.url)) });
  });
  await route();
  let board = null;

  await scenario(record, 'setup', part => setup(session, h, part));

  await scenario(record, 'stream', async part => {
    board = await h.open(BOARD);
    part.technique = await h.slot(BOARD).getAttribute('data-rich-mount');
    part.shellHasMinSize = board.page.url().includes('#panda-min=320x240');
    await h.act(board.frame, 'stream', 40);
    await until(async () => (await h.observed(board.frame)).frames.done, { timeout: 30_000, what: 'the end of the stream' });
    part.frames = (await h.observed(board.frame)).frames;
    const service = h.service();
    part.service = service?.stream ?? null;
  });

  await scenario(record, 'action', async part => {
    await h.act(board.frame, 'claim');
    part.claim = await until(async () => (await h.observed(board.frame)).claim, { timeout: 5_000, what: 'the claim answer' });
    part.serviceClaims = h.service()?.claims?.length ?? null;
  });

  await scenario(record, 'storage', async part => {
    part.boardInspector = await h.act(board.frame, 'store', NOTE);
    part.boardOrigin = part.boardInspector.origin;
    const before = new Set(h.pages());
    part.windowOpened = await h.invoke('extensions_rich_view_open', { request: { viewId: BOARD.view, version: '1.0.0' } });
    const page = await until(() => h.pages().find(candidate => !before.has(candidate) && /\/extension-view-/.test(candidate.url()) && SHELL.exec(candidate.url())[1] === originKey(BOARD.id)), { what: 'the separate window' });
    const frame = await until(() => h.packageFrame(page, BOARD.id), { what: 'the window document' });
    await until(() => frame.evaluate(() => !!window.__windowsPanels?.init).catch(() => false), { what: 'the window initialized' });
    part.boardWindow = await h.act(frame, 'read');
    record.scenarios.state = { ...(record.scenarios.state ?? {}), windowInit: (await h.observed(frame)).init };
  });

  await scenario(record, 'remote', async part => {
    const chart = await h.main().getByRole('button', { name: CHART.open, exact: true }).click().then(() => until(() => h.slot(CHART).getAttribute('data-mount-id').catch(() => null), { what: 'the chart mounted' }));
    const page = await h.pageFor(chart);
    const frame = await until(() => page.frames().find(candidate => candidate.url().startsWith(`${REMOTE_ORIGIN}/`)), { what: 'the remote frame' });
    const remote = await until(() => frame.evaluate(() => window.__windowsPanelsRemote ?? null).catch(() => null), { what: 'the remote page' });
    part.technique = await h.slot(CHART).getAttribute('data-rich-mount');
    part.text = await frame.locator('#remote-chart').textContent();
    part.origin = remote.origin; part.framed = remote.framed; part.requests = remoteRequests.length;
  });

  await scenario(record, 'twin', async part => {
    const parked = record.scenarios.state ?? (record.scenarios.state = {});
    const bootBefore = (await h.observed(board.frame)).boot;
    const twin = await h.open(TWIN);
    const storage = record.scenarios.storage ?? (record.scenarios.storage = {});
    storage.twin = await h.act(twin.frame, 'read');
    storage.twinAfterStore = await h.act(twin.frame, 'store', 'twin-note');
    storage.twinPost = await h.act(twin.frame, 'post');
    storage.twinOrigin = storage.twin.origin;
    storage.distinctOrigins = !!storage.boardOrigin && storage.twinOrigin !== storage.boardOrigin;
    // The board was parked while the twin was shown; showing it again resumes the same document.
    await h.main().getByRole('button', { name: BOARD.open, exact: true }).click();
    await until(async () => (await h.slot(BOARD).getAttribute('data-mount-id').catch(() => null)) === board.label && board.page.isClosed() === false, { what: 'the board resumed' });
    const after = await h.observed(board.frame);
    parked.parked = { bootBefore, bootAfter: after.boot, sameDocument: after.boot === bootBefore, sawHidden: after.visibility.some(entry => entry.visible === false), visibility: after.visibility };
    storage.boardAfterTwinStore = await h.act(board.frame, 'read');
    part.done = true;
  });

  await scenario(record, 'inline', async part => {
    await h.main().getByRole('button', { name: INLINE.open, exact: true }).click();
    const label = await until(() => h.slot(INLINE).getAttribute('data-mount-id').catch(() => null), { what: 'the inline panel mounted' });
    const started = Date.now();
    // The watchdog ends a panel after 6 s without a title heartbeat; 15 s alive means the signals arrive.
    await delay(15_000);
    part.label = label;
    part.richState = await h.state(INLINE);
    part.aliveAfterMs = (await h.slot(INLINE).getAttribute('data-mount-id').catch(() => null)) === label && part.richState === null ? Date.now() - started : 0;
  });

  await scenario(record, 'focus', async part => {
    await h.main().getByRole('button', { name: BOARD.open, exact: true }).click();
    await until(async () => (await h.slot(BOARD).getAttribute('data-mount-id').catch(() => null)) === board.label, { what: 'the board shown' });
    await h.main().evaluate(() => {
      window.__windowsPanelsForwarded = [];
      // The host re-dispatches a forwarded chord as an untrusted key-down on the app's body.
      document.body.addEventListener('keydown', event => { if (!event.isTrusted) window.__windowsPanelsForwarded.push(`${event.ctrlKey ? 'Control+' : ''}${event.key}`); }, true);
    });
    part.trace = [];
    const look = async step => {
      await delay(600);
      const main = await h.main().evaluate(() => ({ focus: document.hasFocus(), active: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}${document.activeElement.id ? `#${document.activeElement.id}` : ''}${document.activeElement.classList.contains('extension-rich-panel') ? '.extension-rich-panel' : ''}` : null }));
      const panel = await board.frame.evaluate(() => document.hasFocus()).catch(() => null);
      part.trace.push({ step, main: main.focus, panel, active: main.active });
    };
    const enter = async () => { await h.main().locator('#prompt').focus(); await h.slot(BOARD).focus(); };
    await enter(); await look('slot-enter');
    await h.act(board.frame, 'focusButton'); await look('panel-button');
    await board.page.keyboard.press('Escape'); await look('escape');
    await enter(); await look('re-enter');
    await h.act(board.frame, 'focusButton'); await h.act(board.frame, 'releaseFocus'); await look('release-focus');
    await enter(); await h.act(board.frame, 'focusButton'); await look('chord-enter');
    await board.page.keyboard.press('Control+F12'); await look('chord');
    part.forwarded = await h.main().evaluate(() => window.__windowsPanelsForwarded);
    part.forwardedCount = part.forwarded.length;
    part.panelKeys = (await h.observed(board.frame)).keys;
  });

  await scenario(record, 'restart', async part => {
    // DOM storage commits on a short delay; the restart is the app's own (`process:allow-restart`), so it shuts down
    // cleanly and relaunches with the same environment and debugging port.
    await delay(10_000);
    await session.restart();
    h = host(session);
    await route();
    board = await h.open(BOARD);
    const storage = record.scenarios.storage ?? (record.scenarios.storage = {});
    storage.boardAfterRestart = await h.act(board.frame, 'read');
    part.restarted = true;
  });

  await scenario(record, 'fault', async part => {
    const state = record.scenarios.state ?? (record.scenarios.state = {});
    await h.act(board.frame, 'remember', 'remembered');
    const projectId = record.scenarios.setup?.projectId;
    if (!projectId) throw new Error('No project to start the task in.');
    await h.act(board.frame, 'startTask', projectId, agentPrompt(12));
    const task = await until(async () => (await h.observed(board.frame)).task, { timeout: 30_000, what: 'the started task' });
    part.taskId = task.id;
    const events = () => (h.service()?.events ?? []).filter(event => event.taskId === task.id).map(event => event.kind);
    await until(() => events().includes('turn.started'), { timeout: 30_000, what: 'the turn started' });
    await delay(2_000);
    part.runningAtFault = events().includes('turn.started') && !events().includes('turn.finished');
    const label = board.label;
    await h.act(board.frame, 'fault');
    part.panelState = await until(() => h.state(BOARD), { timeout: 15_000, what: 'the panel ended' });
    await until(() => !h.pages().some(page => SHELL.exec(page.url())[2] === label), { timeout: 5_000, what: 'the faulted webview gone' }).catch(() => null);
    part.panelPagesAfter = h.pages().filter(page => SHELL.exec(page.url())[2] === label).length;
    await until(() => events().some(kind => kind === 'turn.finished' || kind === 'turn.failed' || kind === 'task.stopped'), { timeout: 45_000, what: 'the end of the turn' });
    await delay(1_000);
    part.events = events();
    part.turnFinished = part.events.includes('turn.finished');
    part.turnFailed = part.events.includes('turn.failed');
    part.taskStopped = part.events.includes('task.stopped');
    const frames = session.readAgentLog();
    part.agentPrompts = frames.filter(frame => frame.method === 'session/prompt').length;
    part.agentCancel = frames.filter(frame => frame.method === 'session/cancel').length;
    part.promptEnabled = await h.main().locator('#prompt').isEnabled();
    await h.slot(BOARD).getByRole('button', { name: 'Reload panel', exact: true }).click();
    const label2 = await until(async () => { const value = await h.slot(BOARD).getAttribute('data-mount-id').catch(() => null); return value && value !== label ? value : null; }, { what: 'the reloaded panel' });
    const page = await h.pageFor(label2);
    const frame = await until(() => h.packageFrame(page, BOARD.id), { what: 'the reloaded document' });
    await until(() => frame.evaluate(() => !!window.__windowsPanels?.init).catch(() => false), { what: 'the reloaded panel initialized' });
    board = { label: label2, page, frame };
    const init = (await h.observed(frame)).init;
    part.reload = { restored: init.restored, state: init.state };
    state.afterReload = part.reload;
  });

  await scenario(record, 'band', async part => {
    // R1001: the manifest band segment shows for the task in view (the one the fault scenario started).
    const segment = h.main().locator(`.extension-rich-panel[aria-label="${BAND.title} panel — ${BAND.id}"]`);
    const label = await until(() => segment.getAttribute('data-mount-id').catch(() => null), { timeout: 20_000, what: 'the band panel mounted' });
    part.technique = await segment.getAttribute('data-rich-mount');
    part.height = Math.round((await segment.boundingBox())?.height ?? 0);
    const started = Date.now();
    await delay(10_000);
    part.richState = await segment.getAttribute('data-rich-state').catch(() => null);
    part.aliveAfterMs = (await segment.getAttribute('data-mount-id').catch(() => null)) === label && part.richState === null ? Date.now() - started : 0;
    part.webview = h.pages().some(page => SHELL.exec(page.url())[2] === label);
  });

  await scenario(record, 'lifecycle', async part => {
    const channelAfter = since => {
      const service = h.service() ?? {};
      const beats = (service.heartbeat ?? []).filter(entry => entry.at > since);
      const counts = (service.instances ?? []).filter(entry => entry.at > since);
      return { beats, counts, closed: beats.length > 0 && beats.every(entry => entry.error || entry.delivered === 0) && counts.every(entry => entry.count === 0) };
    };
    // Revoke ui.richViews while the board is shown.
    const revokeAt = Date.now();
    await h.invoke('extensions_runtime_grant', { request: { op: 'revoke', id: BOARD.id, permission: 'ui.richViews' } });
    const revoke = part.revoke = {};
    revoke.panelState = await until(() => h.state(BOARD), { what: 'the revoked panel' }).catch(() => null);
    await until(() => h.pagesOf(BOARD.id).length === 0, { timeout: 5_000, what: 'no webview of the package' }).catch(() => null);
    revoke.pages = h.pagesOf(BOARD.id).length;
    await delay(2_000);
    const after = channelAfter(revokeAt + 1_000);
    revoke.channel = after.closed ? 'closed' : 'open'; revoke.heartbeats = after.beats.slice(-4);
    // Grant again and show it, then disable the package.
    await h.invoke('extensions_runtime_grant', { request: { op: 'grant', id: BOARD.id, permission: 'ui.richViews', scope: {} } });
    board = await h.open(BOARD);
    const disableAt = Date.now();
    await h.invoke('extensions_enable', { id: BOARD.id, enabled: false });
    const disable = part.disable = {};
    disable.panelState = await until(async () => (await h.slot(BOARD).count()) === 0 ? 'gone' : h.state(BOARD), { what: 'the disabled panel' }).catch(() => null);
    await until(() => h.pagesOf(BOARD.id).length === 0, { timeout: 5_000, what: 'no webview of the package' }).catch(() => null);
    disable.pages = h.pagesOf(BOARD.id).length;
    await until(() => (h.service()?.stopped?.at ?? 0) >= disableAt, { timeout: 10_000, what: 'the service stopped' }).catch(() => null);
    disable.serviceStopped = (h.service()?.stopped?.at ?? 0) >= disableAt;
    disable.stopReason = h.service()?.stopped?.reason ?? null;
    // Enable again, show a panel of each package and the separate window, then safe mode for this launch.
    await h.invoke('extensions_enable', { id: BOARD.id, enabled: true });
    await h.main().reload();
    await until(() => h.main().locator('#prompt').isEnabled().catch(() => false), { timeout: 30_000, what: 'the composer after reload' });
    board = await h.open(BOARD);
    await h.open(TWIN);
    await h.invoke('extensions_rich_view_open', { request: { viewId: BOARD.view, version: '1.0.0' } });
    await until(() => h.pages().some(page => /extension-view-/.test(page.url())), { what: 'the separate window' });
    const safeAt = Date.now();
    await h.invoke('extensions_safe_mode');
    const safe = part.safeMode = {};
    await until(() => h.pages().length === 0, { timeout: 8_000, what: 'no panel webview' }).catch(() => null);
    safe.pages = h.pages().filter(page => /extension-panel-/.test(page.url())).length;
    safe.windows = h.pages().filter(page => /extension-view-/.test(page.url())).length;
    await until(() => (h.service()?.stopped?.at ?? 0) >= safeAt, { timeout: 10_000, what: 'the service stopped' }).catch(() => null);
    safe.serviceStopped = (h.service()?.stopped?.at ?? 0) >= safeAt;
    safe.promptEnabled = await h.main().locator('#prompt').isEnabled();
  });

  return record;
}
