// Named provider connections (issue #29): several setups of one harness, each with its own
// executable, arguments, environment and config folder. Secret values go to the native
// secure store and never come back; the list only carries their names.
import { call, subscribe } from './bridge';
import { accountPlan, accountState, accountWindows, meterTone, resetsAt, type PoolMember } from './account-status';
import type { AgentUsage } from './agent-usage';
import { openChoiceMenu } from './choice-menu';
import { escape, icon, isImeKey } from './dom';
import { isWindows } from './platform';
import { infoMark } from './tooltip';
import type { ProviderId } from './types';

export interface Connection { id: string; provider: ProviderId; name: string; executable?: string | null; args: string[]; env: Record<string, string>; secretEnv: string[]; configDir?: string | null; revision: number; }
export interface ConnectionSnapshot { connections: Connection[]; tasks: Record<string, string>; pools?: string[]; poolExcluded?: string[]; }
/** `connection_new_account`: the saved connection's folder and the line that signs it in. */
interface NewAccount { snapshot: ConnectionSnapshot; id: string; configDir: string; command: string; }
/** An `account-sign-in` event (`account_sign_in.rs`); `starting` is local until the first one arrives. */
interface SignIn { id: string; state: 'starting' | 'waiting' | 'needs-code' | 'done' | 'failed'; url?: string; message?: string; }
interface EnvRow { name: string; value: string; secret: boolean; saved: boolean; }

export const emptyConnections = (): ConnectionSnapshot => ({ connections: [], tasks: {} });
/** The folder variable each harness reads; others set theirs under Environment. */
const CONFIG_DIR: Partial<Record<ProviderId, string>> = { claude: 'CLAUDE_CONFIG_DIR', glm: 'CLAUDE_CONFIG_DIR', mimo: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', pi: 'PI_CODING_AGENT_DIR', opencode: 'OPENCODE_CONFIG_DIR', kilo: 'KILO_CONFIG_DIR' };

/** Harnesses whose accounts can form a pool (`account_pool.rs`). */
const POOLED: ProviderId[] = ['claude', 'codex'];
/** How to sign another account in with its own config folder. */
const SETUP = { claude: 'CLAUDE_CONFIG_DIR=~/.claude-2 claude auth login', codex: 'CODEX_HOME=~/.codex-2 codex login' };
/** How often the visible pool section re-reads its members' status. */
const POOL_REFRESH_MS = 60_000;
/** Usage is read when the section first shows, then on window focus no more often than this. */
const USAGE_REFRESH_MS = 300_000;
const rendered = new WeakMap<Element, string>();
/** Puts `parts` (key, markup) into `container` in order, keeping every child whose markup is unchanged, and
 *  any existing child whose key `keep` names (an open form, so a background refresh never loses typing). */
function patch(container: HTMLElement, parts: [string, string][], keep: (key: string) => boolean = () => false): void {
  const existing = new Map([...container.children].map(child => [(child as HTMLElement).dataset.key ?? '', child]));
  parts.forEach(([key, html], index) => {
    let node = existing.get(key);
    if (!node || (rendered.get(node) !== html && !keep(key))) {
      const template = document.createElement('template'); template.innerHTML = html.trim();
      const next = template.content.firstElementChild as HTMLElement; next.dataset.key = key; rendered.set(next, html);
      if (node) node.replaceWith(next);
      node = next;
    }
    existing.delete(key);
    if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null);
  });
  for (const node of existing.values()) node.remove();
}
/** Attributes that name a control in the pool cards (runtime ones such as a switch's `data-armed` are left out). */
const CONTROL_KEYS = new Set(['id', 'data-pool-toggle', 'data-pool-member-toggle', 'data-pool-provider', 'data-member-menu', 'data-usage-refresh', 'data-new-account', 'data-sign-in', 'data-sign-in-code', 'data-sign-in-submit', 'data-sign-in-cancel', 'data-open-url', 'data-copy-command', 'data-confirm-cancel', 'data-confirm-delete']);
/** A selector that finds the same control after a redraw. */
function focusKey(element: HTMLElement): string | null {
  const attributes = [...element.attributes].filter(a => CONTROL_KEYS.has(a.name));
  return attributes.length ? element.tagName.toLowerCase() + attributes.map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('') : null;
}
/** The line that signs a harness in with a config folder, quoted as `connection_new_account` quotes it. */
function signInCommand(provider: string, dir: string): string {
  const [variable, login] = provider === 'codex' ? ['CODEX_HOME', 'codex login'] : ['CLAUDE_CONFIG_DIR', 'claude auth login'];
  return isWindows ? `$env:${variable}='${dir.replace(/['\u2018-\u201B]/g, '$&$&')}'; ${login}; Remove-Item Env:${variable}` : `${variable}='${dir.replace(/'/g, "'\\''")}' ${login}`;
}
const POOL_TERMS = 'Pool only accounts you own; each needs its own subscription.';
const POOL_HINT = 'Moves to the next account when one reaches its usage limit.';
const ABOUT = 'Add named setups of a harness, such as Claude Work and Claude Personal, each with its own executable, arguments, environment and config folder. Choose one in the model picker; tasks keep theirs.';

export function mountConnections(host: HTMLElement, harnesses: { id: ProviderId; name: string }[], saved: (snapshot: ConnectionSnapshot) => void): () => void {
  let snapshot = emptyConnections(), editing: Connection | 'new' | null = null, disposed = false, members: Partial<Record<string, PoolMember[]>> = {}, signing: Partial<Record<string, SignIn>> = {};
  /** Usage per pool account (`provider/id`): read when the section first shows, then on focus at most every 5 minutes. */
  let usage: Partial<Record<string, AgentUsage | null>> = {}, closeMenu: (() => void) | undefined, visible = false, redrawWaiting = false;
  /** A newer usage pass bumps its harness's generation; an older pass stops instead of landing stale results. */
  let usageGeneration: Partial<Record<string, number>> = {}, usageReadAt = 0, confirming: string | null = null, added: string[] = [];
  const harnessName = (id: string) => harnesses.find(h => h.id === id)?.name ?? id;
  /** Deferred steps (after a menu closes), cleared on dispose. */
  const timers = new Set<number>();
  const later = (step: () => void) => { const id = window.setTimeout(() => { timers.delete(id); if (!disposed) step(); }); timers.add(id); };
  const pooled = () => POOLED.filter(p => harnesses.some(h => h.id === p));
  const editingPooled = () => editing && editing !== 'new' && pooled().includes(editing.provider) ? editing : null;
  /** Builds the three parts once; later redraws patch them, so focus, an open disclosure and typed text survive. */
  function render(): void {
    if (!host.querySelector('[data-pools]')) host.innerHTML = '<div data-pools></div><section class="connection-card named-connections-list" aria-label="Connections"></section><p class="named-connection-feedback" role="status" hidden></p>';
    // Accounts of a pooled harness are rows in its accounts card; the list here keeps the rest.
    const shown = pooled(), others = snapshot.connections.filter(c => !shown.includes(c.provider));
    const rows = others.map(c => `<li class="ds-row named-connection" data-connection="${escape(c.id)}"><span class="ds-row-main"><span class="ds-row-title">${escape(c.name)}</span><span class="ds-row-sub">${escape(harnessName(c.provider))}</span></span><span class="ds-row-trail"><button type="button" class="ds-btn" data-edit-connection="${escape(c.id)}" aria-label="Edit ${escape(c.name)}">Edit</button><button type="button" class="ds-btn" data-delete-connection="${escape(c.id)}" aria-label="Delete ${escape(c.name)}">Delete</button></span></li>`).join('');
    const formHere = editing && !editingPooled();
    host.querySelector('.named-connections-list')!.innerHTML = `<div class="settings-heading"><h3>Connections</h3>${infoMark(ABOUT, 'About connections')}<span class="sr-only">${ABOUT}</span></div>${rows ? `<ul class="named-connections">${rows}</ul>` : ''}${formHere ? form(editing === 'new' ? null : editing as Connection) : `<button type="button" class="ds-btn" data-add-connection>${icon('plus')}Add connection</button>`}`;
    redrawPools(true);
  }
  /** Each pool card as keyed parts, and its list as keyed rows. */
  function poolParts(provider: ProviderId): { section: [string, string][]; rows: [string, string][]; off: boolean } {
    const on = snapshot.pools?.includes(provider) ?? false, name = escape(harnessName(provider));
    const ready = snapshot.connections.some(c => c.provider === provider), list = members[provider];
    const add = `<button type="button" class="ds-btn" data-new-account="${provider}" aria-label="Add a ${name} account">${icon('plus')}Add account</button>`;
    const rows: [string, string][] = !ready ? [['empty', `<li class="ds-row account-pool-empty"><span class="ds-row-sub">Add a second account to pool</span>${add}</li>`]]
      : !list ? [['loading', '<li class="ds-row account-pool-empty"><span class="ds-row-main"><span class="ds-row-sub">Loading accounts…</span></span></li>']]
      : list.flatMap(m => memberParts(provider, m, on));
    const command = SETUP[provider as keyof typeof SETUP], terms = ready || added.includes(provider);
    return { off: !on, rows, section: [
      ['head', `<div class="settings-heading account-pool-head"><span class="account-pool-title"><h3>${name} accounts</h3><span class="account-pool-hint">${POOL_HINT}</span></span>${checkedLine(provider)}<button type="button" class="icon-button" data-usage-refresh="${provider}" aria-label="Refresh ${name} usage" title="Refresh usage"${ready ? '' : ' hidden'}>${icon('refresh')}</button><input type="checkbox" role="switch" class="ds-toggle" data-pool-toggle="${provider}" aria-label="Account pool · ${name}" ${on ? 'checked' : ''}${ready ? '' : ' disabled'}></div>`],
      ['list', `<ul class="account-pool-members" aria-label="${name} account pool"></ul>`],
      ['feedback', '<p class="account-pool-feedback" role="status" hidden></p>'],
      ['foot', ready ? `<div class="account-pool-foot">${add}${terms ? `<span class="account-pool-terms">${POOL_TERMS}</span>` : ''}</div>` : terms ? `<p class="account-pool-terms">${POOL_TERMS}</p>` : ''],
      ['manual', `<details class="account-pool-manual"><summary>Set up an account by hand${icon('chevron')}</summary><p>Run this in a terminal, then add a connection with that config folder:</p><div class="account-pool-command"><code>${escape(command)}</code><button type="button" class="ds-btn" data-copy-command="${escape(command)}" aria-label="Copy ${name} sign-in command">${icon('copy')}Copy</button></div></details>`],
    ] };
  }
  /** 'Checked 10:57 AM' from the oldest usage result on screen, so the line never claims fresher numbers than shown. */
  function checkedLine(provider: string): string {
    const times = (members[provider] ?? []).map(m => usage[`${provider}/${m.id}`]?.checkedAt ?? 0).filter(at => at > 0);
    return times.length ? `<span class="account-pool-checked" data-checked>Checked ${escape(new Date(Math.min(...times)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>` : '';
  }
  const memberName = (id: string) => id ? snapshot.connections.find(c => c.id === id)?.name ?? id : 'Default setup';
  /** A member row, then the parts that open under it: delete confirmation, inline edit form, sign-in. */
  function memberParts(provider: string, m: PoolMember, on: boolean): [string, string][] {
    const result = usage[`${provider}/${m.id}`], { tone, text: status } = accountState(m, result), name = escape(memberName(m.id)), dir = snapshot.connections.find(c => c.id === m.id)?.configDir;
    const identity = [m.email, accountPlan(m, result), (m.active ?? 0) > 0 ? `Running ${m.active}` : ''].filter(Boolean).join(' · ');
    const sub = m.sameAs !== null ? `Same login as ${escape(memberName(m.sameAs))} — give it its own config folder` : !m.signedIn ? escape(dir ? 'Sign in to add it to the pool' : 'Not signed in') : escape(identity || dir || 'Signed in');
    const busy = signing[m.id] && signing[m.id]!.state !== 'failed';
    const signIn = !m.signedIn && m.sameAs === null && dir && !busy ? `<button type="button" class="ds-btn" data-sign-in="${escape(m.id)}" aria-label="Sign in ${name}">Sign in</button>` : '';
    // With the pool off only the neutral states show; switches and limit chips return when it is on.
    const chip = on || !tone ? `<span class="ds-chip ds-chip-text account-pool-status" data-status><span class="ds-dot"${tone ? ` data-state-tone="${tone}"` : ''} aria-hidden="true"></span>${status}</span>` : '';
    const toggle = on && m.signedIn && m.sameAs === null ? `<input type="checkbox" role="switch" class="ds-toggle" data-pool-member-toggle="${escape(m.id)}" data-pool-provider="${provider}" aria-label="In pool: ${name}" ${m.excluded ? '' : 'checked'}>` : '';
    const more = actions(m).length ? `<button type="button" class="icon-button" data-member-menu="${escape(m.id)}" data-pool-provider="${provider}" aria-haspopup="menu" aria-label="More for ${name}" title="More">${icon('more')}</button>` : '';
    const usageBlock = m.signedIn && m.sameAs === null ? usageLines(result, m) : '';
    const row = `<li class="ds-row account-pool-member${m.excluded ? ' ds-row-dim' : ''}" data-pool-member="${escape(m.id)}"${m.signedIn ? '' : ' data-signed-out'}><span class="ds-row-main"><span class="ds-row-title">${name}</span><span class="ds-row-sub" data-identity>${sub}</span></span><span class="ds-row-trail">${chip}${signIn}${toggle}${more}</span>${usageBlock}</li>`;
    const editForm = editingPooled()?.id === m.id && m.id ? `<li class="account-pool-edit" data-edit-panel="${escape(m.id)}">${form(editingPooled())}</li>` : '';
    return [[`m:${m.id}`, row], ...confirming === m.id ? [[`c:${m.id}`, confirmPanel(m.id, name, dir)] as [string, string]] : [], ...editForm ? [[`e:${m.id}`, editForm] as [string, string]] : [], ...signing[m.id] ? [[`s:${m.id}`, signInPanel(m.id, name)] as [string, string]] : []];
  }
  function confirmPanel(id: string, name: string, dir: string | null | undefined): string {
    return `<li class="account-pool-confirm" data-confirm-panel="${escape(id)}" role="group" aria-label="Delete ${name}?"><span><b>Delete ${name}?</b> Its sign-in stays in its folder${dir ? ` (<code>${escape(dir)}</code>)` : ''}, so adding a connection for that folder brings it back.</span><span class="account-pool-confirm-actions"><button type="button" class="ds-btn" data-confirm-cancel>Cancel</button><button type="button" class="ds-btn account-pool-danger" data-confirm-delete="${escape(id)}">Delete</button></span></li>`;
  }
  /** Up to two limit windows as thin meters with the percent and reset, or why there are none. */
  function usageLines(result: AgentUsage | null | undefined, m: PoolMember): string {
    if (result === undefined) return '<span class="account-usage" data-usage aria-busy="true"></span>';
    const windows = accountWindows(result);
    if (!windows.length) return '<span class="account-usage account-usage-none" data-usage>Usage not available</span>';
    return `<span class="account-usage" data-usage>${windows.map(w => {
      const used = Math.round(Math.min(100, Math.max(0, w.usedPercent))), at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      const reset = Number.isFinite(at) ? `<span class="account-meter-reset"> · ${escape(resetsAt(at))}</span>` : '';
      return `<span class="account-meter" data-level="${meterTone(used, m, w.label)}"><span class="account-meter-label">${escape(w.label)}${reset}</span><span class="account-meter-value"> ${used}%</span><span class="ds-meter" aria-hidden="true"><span style="--ds-value:${used}%"></span></span></span>`;
    }).join('')}</span>`;
  }
  /** The row's overflow actions. */
  function actions(m: PoolMember): { id: string; label: string; icon: string; danger?: boolean }[] {
    const dir = snapshot.connections.find(c => c.id === m.id)?.configDir;
    return [
      ...m.signedIn && m.sameAs === null && (m.limitedUntil || m.nearUntil) ? [{ id: 'try', label: 'Try now', icon: 'refresh' }] : [],
      ...dir ? [{ id: 'copy', label: 'Copy sign-in command', icon: 'copy' }] : [],
      ...m.id ? [{ id: 'edit', label: 'Edit…', icon: 'edit' }, { id: 'delete', label: 'Delete…', icon: 'trash', danger: true }] : [],
    ];
  }
  function openMemberMenu(anchor: HTMLElement): void {
    if (closeMenu) { closeMenu(); return; }
    const provider = anchor.dataset.poolProvider!, id = anchor.dataset.memberMenu!, m = members[provider]?.find(other => other.id === id); if (!m) return;
    const dir = snapshot.connections.find(c => c.id === id)?.configDir;
    closeMenu = openChoiceMenu({ anchor, title: `Actions for ${memberName(id)}`, actions: true, items: actions(m), onSelect: choice => {
      if (choice === 'try') call('account_pool_clear', { provider, id }).then(refreshPools, error => message(String(error), true, provider));
      else if (choice === 'copy' && dir) copy(signInCommand(provider, dir), provider);
      else if (choice === 'edit') later(() => edit(id));
      else if (choice === 'delete') later(() => { confirming = id; redrawPools(); host.querySelector<HTMLElement>('[data-confirm-cancel]')?.focus(); });
    }, onClose: () => { closeMenu = undefined; if (redrawWaiting) later(() => redrawPools()); } });
  }
  /** The sign-in under a signed-out row: the link, Cancel, a code field when the CLI asks for one, or why it failed. */
  function signInPanel(id: string, name: string): string {
    const run = signing[id]; if (!run) return '';
    if (run.state === 'failed') return `<li class="account-pool-sign-in" data-sign-in-panel="${escape(id)}" role="alert">${escape(run.message ?? 'The sign-in did not finish.')}</li>`;
    const link = run.url ? `<a href="${escape(run.url)}" data-open-url="${escape(run.url)}">Open the sign-in page${icon('external')}</a>` : '';
    const code = run.state === 'needs-code' ? `<span class="account-pool-code"><span>If the page shows a code, paste it here:</span><input data-sign-in-code="${escape(id)}" aria-label="Sign-in code for ${name}" placeholder="Paste code" autocomplete="off" spellcheck="false" maxlength="4096"><button type="button" class="ds-btn" data-sign-in-submit="${escape(id)}">Submit</button></span>` : '';
    const text = run.state === 'starting' ? 'Starting sign-in…' : 'Waiting for you to sign in in your browser…';
    return `<li class="account-pool-sign-in" data-sign-in-panel="${escape(id)}"><span class="account-pool-sign-in-line"><span class="account-pool-pulse" aria-hidden="true"></span><span role="status">${text}</span>${link}<button type="button" class="ds-btn" data-sign-in-cancel="${escape(id)}" aria-label="Cancel signing in ${name}">Cancel</button></span>${code}</li>`;
  }
  /** Patches the pool cards in place: only parts whose markup changed are replaced, and focus returns to the same
   *  control. While a row menu is open the redraw waits, so the menu keeps its anchor. */
  function redrawPools(force = false): void {
    if (disposed) return;
    const section = host.querySelector<HTMLElement>('[data-pools]'); if (!section) return;
    if (closeMenu && !force) { redrawWaiting = true; return; }
    redrawWaiting = false;
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    const typed = [...section.querySelectorAll<HTMLInputElement>('[data-sign-in-code]')].map(input => [input.dataset.signInCode!, input.value] as const);
    patch(section, pooled().map(provider => [provider, `<section class="connection-card account-pool" data-pool="${provider}" aria-label="${escape(harnessName(provider))} accounts"></section>`]));
    for (const provider of pooled()) {
      const card = section.querySelector<HTMLElement>(`[data-pool="${provider}"]`)!, parts = poolParts(provider);
      card.toggleAttribute('data-off', parts.off);
      patch(card, parts.section.filter(([, html]) => html));
      patch(card.querySelector<HTMLElement>('.account-pool-members')!, parts.rows, key => key.startsWith('e:'));
    }
    for (const [id, value] of typed) { const input = section.querySelector<HTMLInputElement>(`[data-sign-in-code="${CSS.escape(id)}"]`); if (input && !input.value) input.value = value; }
    if (focused && !host.contains(document.activeElement)) host.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
  }
  function startSignIn(id: string): void {
    signing = { ...signing, [id]: { id, state: 'starting' } }; redrawPools();
    call('account_sign_in_start', { id }).catch(error => { if (!disposed) { signing = { ...signing, [id]: { id, state: 'failed', message: String(error instanceof Error ? error.message : error) } }; redrawPools(); } });
  }
  function submitCode(id: string): void {
    const code = host.querySelector<HTMLInputElement>(`[data-sign-in-code="${CSS.escape(id)}"]`)?.value ?? '';
    if (!code.trim()) return;
    call('account_sign_in_code', { id, code }).catch(error => message(String(error instanceof Error ? error.message : error), true, providerOf(id)));
  }
  function signInEvent(event: SignIn): void {
    if (disposed || !signing[event.id]) return;
    const { [event.id]: _done, ...rest } = signing;
    signing = event.state === 'done' ? rest : { ...signing, [event.id]: { ...event, url: event.url ?? signing[event.id]!.url } };
    if (event.state === 'done') { message(`${memberName(event.id)} is signed in.`, false, providerOf(event.id)); refreshPools(); } else redrawPools();
  }
  /** Loads member status for each pool harness with a connection (on or off, so a shared login shows before turning
   *  it on) and patches the pool cards, so an open form is kept. Accounts without usage yet get it while on screen;
   *  the minute timer only re-reads this local status. */
  function refreshPools(): void {
    for (const provider of POOLED.filter(p => snapshot.connections.some(c => c.provider === p))) void call<PoolMember[]>('account_pool_status', { provider }).then(list => {
      if (disposed) return;
      members = { ...members, [provider]: list };
      redrawPools();
      if (visible) void loadUsage(provider, false);
    }).catch(error => { if (!disposed) message(String(error), true, provider); });
  }
  /** Reads usage one account at a time, so a slow CLI cannot crowd the others. `all` re-reads every account and
   *  starts a new generation; otherwise only accounts never read are fetched. */
  async function loadUsage(provider: string, all: boolean, refresh = false): Promise<void> {
    const targets = (members[provider] ?? []).filter(m => m.signedIn && m.sameAs === null && (all || !(`${provider}/${m.id}` in usage)));
    if (!targets.length) return;
    const generation = all ? (usageGeneration = { ...usageGeneration, [provider]: (usageGeneration[provider] ?? 0) + 1 })[provider]! : usageGeneration[provider] ?? 0;
    if (!all) usage = { ...usage, ...Object.fromEntries(targets.map(m => [`${provider}/${m.id}`, undefined])) };
    usageReadAt = Date.now();
    for (const m of targets) {
      let result: AgentUsage | null;
      try {
        result = await call<AgentUsage>('agent_usage', m.id ? { provider, refresh, connection: m.id } : { provider, refresh });
        if (!result || !Array.isArray(result.windows)) result = null;
      } catch { result = null; }
      if (disposed || (usageGeneration[provider] ?? 0) !== generation) return;
      usage = { ...usage, [`${provider}/${m.id}`]: result };
      redrawPools();
    }
  }
  function envRow(row: EnvRow): string {
    return `<div class="connection-input-row" data-env-row><input aria-label="Variable name" data-env-name value="${escape(row.name)}" placeholder="NAME" autocomplete="off" spellcheck="false" maxlength="128"><input aria-label="Value" data-env-value type="${row.secret ? 'password' : 'text'}" value="${escape(row.value)}" placeholder="${row.saved ? 'Saved · leave empty to keep' : 'value'}" autocomplete="off" spellcheck="false" maxlength="4096"><label class="connection-secret"><input type="checkbox" data-env-secret ${row.secret ? 'checked' : ''}${row.saved ? ' data-saved' : ''}> Secret</label><button type="button" class="secondary-button" data-remove-env aria-label="Remove variable">Remove</button></div>`;
  }
  function form(connection: Connection | null): string {
    const options = harnesses.map(h => `<option value="${h.id}" ${connection?.provider === h.id ? 'selected' : ''}>${escape(h.name)}</option>`).join('');
    const env: EnvRow[] = connection ? [...Object.entries(connection.env).map(([name, value]) => ({ name, value, secret: false, saved: false })), ...connection.secretEnv.map(name => ({ name, value: '', secret: true, saved: true }))] : [];
    return `<form class="named-connection-form" aria-label="${connection ? 'Edit connection' : 'New connection'}">
      <label for="connection-provider">Harness</label><div class="connection-select"><select id="connection-provider" ${connection ? 'disabled' : ''}>${options}</select></div>
      <label for="connection-name">Name</label><div class="connection-input-row"><input id="connection-name" required maxlength="60" value="${escape(connection?.name ?? '')}" placeholder="Claude Work" autocomplete="off"></div>
      <label for="connection-executable">Executable</label><div class="connection-input-row"><input id="connection-executable" value="${escape(connection?.executable ?? '')}" placeholder="Leave empty to use the harness's executable" autocomplete="off" spellcheck="false"></div>
      <label for="connection-args">Extra arguments, one per line</label><textarea id="connection-args" rows="2" spellcheck="false">${escape((connection?.args ?? []).join('\n'))}</textarea>
      <label for="connection-config-dir">Config folder <small data-config-var data-live></small></label><div class="connection-input-row"><input id="connection-config-dir" value="${escape(connection?.configDir ?? '')}" placeholder="/Users/you/.claude-work" autocomplete="off" spellcheck="false"></div>
      <label>Environment</label><div data-env-rows>${env.map(envRow).join('')}</div><button type="button" class="secondary-button" data-add-env>Add variable</button>
      <div class="dialog-footer"><button type="button" class="secondary-button" data-cancel-connection>Cancel</button><button type="submit" class="primary-button">Save connection</button></div></form>`;
  }
  function syncConfigVar(): void {
    const provider = host.querySelector<HTMLSelectElement>('#connection-provider')?.value as ProviderId | undefined;
    const hint = host.querySelector<HTMLElement>('[data-config-var]'), input = host.querySelector<HTMLInputElement>('#connection-config-dir');
    if (!provider || !hint || !input) return;
    const variable = CONFIG_DIR[provider];
    hint.textContent = variable ? `(sets ${variable})` : '(set it under Environment for this harness)';
    input.disabled = !variable;
  }
  const providerOf = (id: string) => snapshot.connections.find(c => c.id === id)?.provider;
  /** Shows one status line: inside the pool card a pool action came from, else under the Connections card. */
  /** `quiet` keeps a success for screen readers only, when the row already shows the same thing. */
  function message(text: string, error = false, provider?: string, quiet = false): void {
    const pool = provider && pooled().includes(provider as ProviderId) ? host.querySelector<HTMLElement>(`[data-pool="${CSS.escape(provider)}"] .account-pool-feedback`) : null;
    const feedback = pool ?? host.querySelector<HTMLElement>('.named-connection-feedback'); if (!feedback) return;
    for (const other of host.querySelectorAll<HTMLElement>('.account-pool-feedback,.named-connection-feedback')) if (other !== feedback) other.hidden = true;
    feedback.textContent = text; feedback.hidden = false; feedback.classList.toggle('error', error); feedback.classList.toggle('sr-only', quiet && !error);
  }
  async function perform(operation: () => Promise<ConnectionSnapshot>, success: string, closeForm: boolean, provider?: string, quiet = false): Promise<void> {
    host.setAttribute('aria-busy', 'true');
    try {
      const next = await operation(); if (disposed) return;
      snapshot = next; if (closeForm) editing = null;
      render(); syncConfigVar(); message(success, false, provider, quiet); saved(next); refreshPools();
    } catch (error) { if (!disposed) message(String(error instanceof Error ? error.message : error), true, provider); }
    finally { host.removeAttribute('aria-busy'); }
  }
  function collect(form: HTMLFormElement): unknown {
    const value = (selector: string) => form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!.value.trim();
    const env = [...form.querySelectorAll<HTMLElement>('[data-env-row]')].map(row => ({
      name: row.querySelector<HTMLInputElement>('[data-env-name]')!.value.trim(),
      value: row.querySelector<HTMLInputElement>('[data-env-value]')!.value || null,
      secret: row.querySelector<HTMLInputElement>('[data-env-secret]')!.checked,
    })).filter(row => row.name || row.value);
    return { id: editing && editing !== 'new' ? editing.id : null, provider: editing && editing !== 'new' ? editing.provider : value('#connection-provider'), name: value('#connection-name'), executable: value('#connection-executable') || null, args: value('#connection-args').split('\n').map(line => line.trim()).filter(Boolean), env, configDir: value('#connection-config-dir') || null };
  }
  /** Opens the edit form: under the account's row for a pooled harness, in the Connections card otherwise. */
  function edit(id: string): void {
    editing = snapshot.connections.find(c => c.id === id) ?? null; confirming = null; render(); syncConfigVar();
    const name = host.querySelector<HTMLInputElement>('#connection-name'); name?.scrollIntoView({ block: 'nearest' }); name?.focus();
  }
  function cancelConfirm(): void {
    const id = confirming; confirming = null; redrawPools();
    if (id !== null) host.querySelector<HTMLElement>(`[data-member-menu="${CSS.escape(id)}"]`)?.focus();
  }
  const remove = (id: string) => { confirming = null; void perform(() => call<ConnectionSnapshot>('connection_delete', { id }), 'Connection deleted. Its tasks use the harness setup again.', false, providerOf(id)); };
  const copy = (text: string, provider?: string) => navigator.clipboard.writeText(text).then(() => message('Command copied.', false, provider), error => message(String(error), true, provider));
  const click = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-open-url]');
    const pool = (event.target as HTMLElement).closest<HTMLElement>('[data-pool]')?.dataset.pool;
    if (link && host.contains(link)) { event.preventDefault(); call('open_external_url', { url: link.dataset.openUrl }).catch(error => message(String(error), true, pool)); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button || !host.contains(button)) return;
    if (button.hasAttribute('data-add-connection')) { editing = 'new'; render(); syncConfigVar(); host.querySelector<HTMLInputElement>('#connection-name')?.focus(); }
    else if (button.dataset.editConnection) edit(button.dataset.editConnection);
    else if (button.dataset.deleteConnection) remove(button.dataset.deleteConnection);
    else if (button.dataset.memberMenu !== undefined) openMemberMenu(button);
    else if (button.hasAttribute('data-cancel-connection')) { const id = editingPooled()?.id; editing = null; render(); if (id) host.querySelector<HTMLElement>(`[data-member-menu="${CSS.escape(id)}"]`)?.focus(); }
    else if (button.hasAttribute('data-confirm-cancel')) cancelConfirm();
    else if (button.dataset.confirmDelete !== undefined) remove(button.dataset.confirmDelete);
    else if (button.dataset.usageRefresh) void loadUsage(button.dataset.usageRefresh, true, true);
    else if (button.hasAttribute('data-add-env')) { host.querySelector('[data-env-rows]')!.insertAdjacentHTML('beforeend', envRow({ name: '', value: '', secret: false, saved: false })); }
    else if (button.hasAttribute('data-remove-env')) button.closest('[data-env-row]')?.remove();
    else if (button.dataset.newAccount) {
      // One click: create the account, then sign it in.
      const provider = button.dataset.newAccount; let id = '';
      added = [...added, provider];
      void perform(async () => { const account = await call<NewAccount>('connection_new_account', { provider }); id = account.id; return account.snapshot; }, 'Account added. Sign in in your browser to add it to the pool.', false, provider, true).then(() => { if (id && !disposed) startSignIn(id); });
    }
    else if (button.dataset.signIn) startSignIn(button.dataset.signIn);
    else if (button.dataset.signInCancel) call('account_sign_in_cancel', { id: button.dataset.signInCancel }).catch(error => message(String(error instanceof Error ? error.message : error), true, pool));
    else if (button.dataset.signInSubmit) submitCode(button.dataset.signInSubmit);
    else if (button.dataset.copyCommand) copy(button.dataset.copyCommand, pool);
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === 'connection-provider') syncConfigVar();
    if (target.dataset.poolToggle) { const provider = target.dataset.poolToggle, enabled = target.checked; void perform(() => call<ConnectionSnapshot>('connection_pool_set', { provider, enabled }), enabled ? 'Account pool on.' : 'Account pool off.', false, provider); }
    if (target.dataset.poolMemberToggle !== undefined) { const provider = target.dataset.poolProvider, id = target.dataset.poolMemberToggle, included = target.checked; void perform(() => call<ConnectionSnapshot>('connection_pool_member_set', { provider, id, included }), included ? 'Account added to the pool.' : 'Account left out of the pool.', false, provider); }
    if (target.matches('[data-env-secret]')) {
      const value = target.closest('[data-env-row]')!.querySelector<HTMLInputElement>('[data-env-value]')!;
      value.type = target.checked ? 'password' : 'text';
      // A saved secret turned plain needs its value typed again.
      if (target.hasAttribute('data-saved') && !target.checked) value.placeholder = 'value';
    }
  };
  const submit = (event: Event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('.named-connection-form'); if (!form) return;
    event.preventDefault(); event.stopPropagation();
    const connection = collect(form);
    const provider = editingPooled()?.provider;
    void perform(() => call<ConnectionSnapshot>('connection_save', { connection }), 'Connection saved. Choose it in the model picker.', true, provider);
  };
  host.classList.add('named-connections-card');
  const keydown = (event: KeyboardEvent) => {
    const id = (event.target as HTMLElement).dataset?.signInCode;
    if (id !== undefined && event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); submitCode(id); }
    if (event.key === 'Escape' && !isImeKey(event) && (event.target as HTMLElement).closest('[data-confirm-panel]')) { event.preventDefault(); event.stopPropagation(); cancelConfirm(); }
  };
  host.addEventListener('click', click); host.addEventListener('change', change); host.addEventListener('submit', submit); host.addEventListener('keydown', keydown);
  let unlisten: (() => void) | undefined;
  void (subscribe as (name: string, callback: (event: any) => void) => Promise<() => void>)('account-sign-in', signInEvent).then(stop => { if (disposed) stop(); else unlisten = stop; });
  render();
  void call<ConnectionSnapshot>('connections_list').then(next => { if (!disposed) { snapshot = next; if (!editing) render(); refreshPools(); } }).catch(error => { if (!disposed) message(String(error), true); });
  // Statuses refresh on focus and every minute, only while the section is on screen.
  let timer: number | undefined;
  const focus = () => {
    if (!visible) return;
    refreshPools();
    if (Date.now() - usageReadAt >= USAGE_REFRESH_MS) for (const provider of pooled()) void loadUsage(provider, true);
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting; window.clearInterval(timer); timer = undefined;
    if (visible) { refreshPools(); timer = window.setInterval(refreshPools, POOL_REFRESH_MS); }
  });
  observer.observe(host); window.addEventListener('focus', focus);
  return () => { disposed = true; closeMenu?.(); for (const id of timers) window.clearTimeout(id); observer.disconnect(); window.clearInterval(timer); window.removeEventListener('focus', focus); host.removeEventListener('click', click); host.removeEventListener('change', change); host.removeEventListener('submit', submit); host.removeEventListener('keydown', keydown); unlisten?.(); };
}
