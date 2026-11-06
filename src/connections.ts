// Named provider connections (issue #29): several setups of one harness, each with its own
// executable, arguments, environment and config folder. Secret values go to the native
// secure store and never come back; the list only carries their names.
import { call, subscribe } from './bridge';
import { escape, isImeKey } from './dom';
import { isWindows } from './platform';
import { infoMark } from './tooltip';
import type { ProviderId } from './types';

export interface Connection { id: string; provider: ProviderId; name: string; executable?: string | null; args: string[]; env: Record<string, string>; secretEnv: string[]; configDir?: string | null; revision: number; }
export interface ConnectionSnapshot { connections: Connection[]; tasks: Record<string, string>; pools?: string[]; poolExcluded?: string[]; }
/** `connection_new_account`: the saved connection's folder and the line that signs it in. */
interface NewAccount { snapshot: ConnectionSnapshot; id: string; configDir: string; command: string; }
interface PoolMember { id: string; excluded: boolean; sameAs: string | null; limitedUntil: number | null; nearUntil: number | null; active: number; signedIn: boolean; }
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
/** A reset time, with the weekday when it is not today. */
function until(at: number): string {
  const date = new Date(at), time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
/** The line that signs a harness in with a config folder, quoted as `connection_new_account` quotes it. */
function signInCommand(provider: string, dir: string): string {
  const [variable, login] = provider === 'codex' ? ['CODEX_HOME', 'codex login'] : ['CLAUDE_CONFIG_DIR', 'claude auth login'];
  return isWindows ? `$env:${variable}='${dir.replace(/['\u2018-\u201B]/g, '$&$&')}'; ${login}; Remove-Item Env:${variable}` : `${variable}='${dir.replace(/'/g, "'\\''")}' ${login}`;
}
const POOL_TERMS = 'Pool only accounts you own; each needs its own subscription.';
const POOL_HINT = 'Switch to the next account automatically when one reaches its usage limit. The conversation continues on the new account.';
const ABOUT = 'Add named setups of a harness, such as Claude Work and Claude Personal, each with its own executable, arguments, environment and config folder. Choose one in the model picker; tasks keep theirs.';

export function mountConnections(host: HTMLElement, harnesses: { id: ProviderId; name: string }[], saved: (snapshot: ConnectionSnapshot) => void): () => void {
  let snapshot = emptyConnections(), editing: Connection | 'new' | null = null, disposed = false, members: Partial<Record<string, PoolMember[]>> = {}, signing: Partial<Record<string, SignIn>> = {};
  const harnessName = (id: string) => harnesses.find(h => h.id === id)?.name ?? id;
  function render(): void {
    const rows = snapshot.connections.map(c => `<li class="named-connection" data-connection="${escape(c.id)}"><span><strong>${escape(c.name)}</strong> <small>${escape(harnessName(c.provider))}</small></span><span class="connection-row-actions"><button type="button" class="secondary-button" data-edit-connection="${escape(c.id)}" aria-label="Edit ${escape(c.name)}">Edit</button><button type="button" class="secondary-button" data-delete-connection="${escape(c.id)}" aria-label="Delete ${escape(c.name)}">Delete</button></span></li>`).join('');
    host.innerHTML = `<div class="settings-heading"><h3>Connections</h3>${infoMark(ABOUT, 'About connections')}<span class="sr-only">${ABOUT}</span></div>${rows ? `<ul class="named-connections">${rows}</ul>` : ''}<div data-pools>${pools()}</div>${editing ? form(editing === 'new' ? null : editing) : '<button type="button" class="secondary-button" data-add-connection>Add connection</button>'}<p class="named-connection-feedback" role="status" hidden></p>`;
  }
  function pools(): string {
    return POOLED.filter(p => harnesses.some(h => h.id === p)).map(provider => {
      const on = snapshot.pools?.includes(provider) ?? false, name = escape(harnessName(provider));
      const ready = snapshot.connections.some(c => c.provider === provider);
      const list = ready && members[provider] ? `<ul class="account-pool-members" aria-label="${name} account pool">${members[provider]!.map(m => member(provider, m)).join('')}</ul>` : '';
      const command = SETUP[provider as keyof typeof SETUP];
      return `<div class="account-pool" data-pool="${provider}"><label class="account-pool-switch"><input type="checkbox" role="switch" class="ds-toggle" data-pool-toggle="${provider}" ${on ? 'checked' : ''}${ready ? '' : ' disabled'}> Account pool · ${name}</label><p class="account-pool-hint">${POOL_HINT}${ready ? '' : ' Add a connection for another account to turn it on.'}</p><p class="account-pool-hint">${POOL_TERMS}</p><p class="account-pool-add"><button type="button" class="secondary-button" data-new-account="${provider}" aria-label="Add a ${name} account">Add account…</button></p><p class="account-pool-hint">Or set one up by hand: <code>${escape(command)}</code> <button type="button" class="secondary-button" data-copy-command="${escape(command)}" aria-label="Copy ${name} sign-in command">Copy</button> then add a connection with that config folder.</p>${list}</div>`;
    }).join('');
  }
  const memberName = (id: string) => id ? snapshot.connections.find(c => c.id === id)?.name ?? id : 'Default setup';
  function member(provider: string, m: PoolMember): string {
    const name = escape(memberName(m.id)), row = (tone: string, status: string, actions = '', extra = '') => `<li class="account-pool-member" data-pool-member="${escape(m.id)}"${extra}><span class="account-pool-dot" data-state-tone="${tone}" aria-hidden="true"></span><span>${name}</span><small>${status}</small><span class="account-pool-actions">${actions}</span></li>`;
    if (m.sameAs !== null) return row('near', `Same login as ${escape(memberName(m.sameAs))} — give it its own config folder`);
    if (!m.signedIn) {
      const dir = snapshot.connections.find(c => c.id === m.id)?.configDir;
      const copy = dir ? `<button type="button" class="account-pool-copy" data-copy-command="${escape(signInCommand(provider, dir))}" aria-label="Copy sign-in command for ${name}">Copy sign-in command</button>` : '';
      const busy = signing[m.id] && signing[m.id]!.state !== 'failed';
      const start = dir && !busy ? `<button type="button" class="secondary-button" data-sign-in="${escape(m.id)}" aria-label="Sign in ${name}">Sign in</button>` : '';
      return row('near', 'Not signed in', `${copy}${start}`, ' data-signed-out') + signInPanel(m.id, name);
    }
    const [tone, text] = m.limitedUntil ? ['limited', `Out until ${until(m.limitedUntil)}`] : m.nearUntil ? ['near', 'Near limit'] : ['ready', 'Ready'];
    const retry = tone === 'ready' ? '' : `<button type="button" class="secondary-button" data-pool-clear="${escape(m.id)}" data-pool-provider="${provider}" aria-label="Try ${name} now">Try now</button>`;
    return row(tone, `${text}${m.active > 0 ? ` · Running ${m.active}` : ''}`, `${retry}<input type="checkbox" role="switch" class="ds-toggle" data-pool-member-toggle="${escape(m.id)}" data-pool-provider="${provider}" aria-label="In pool: ${name}" ${m.excluded ? '' : 'checked'}>`);
  }
  /** The sign-in under a signed-out row: the link, Cancel, a code field when the CLI asks for one, or why it failed. */
  function signInPanel(id: string, name: string): string {
    const run = signing[id]; if (!run) return '';
    if (run.state === 'failed') return `<li class="account-pool-sign-in" data-sign-in-panel="${escape(id)}" role="alert">${escape(run.message ?? 'The sign-in did not finish.')}</li>`;
    const link = run.url ? ` <a href="${escape(run.url)}" data-open-url="${escape(run.url)}">Open the sign-in page</a>` : '';
    const code = run.state === 'needs-code' ? `<span class="account-pool-code">If the page shows a code, paste it here: <input data-sign-in-code="${escape(id)}" aria-label="Sign-in code for ${name}" autocomplete="off" spellcheck="false" maxlength="4096"><button type="button" class="secondary-button" data-sign-in-submit="${escape(id)}">Submit</button></span>` : '';
    const text = run.state === 'starting' ? 'Starting sign-in…' : 'Waiting for you to sign in in your browser…';
    return `<li class="account-pool-sign-in" data-sign-in-panel="${escape(id)}"><span role="status">${text}</span>${link}<button type="button" class="secondary-button" data-sign-in-cancel="${escape(id)}" aria-label="Cancel signing in ${name}">Cancel</button>${code}</li>`;
  }
  /** Redraws the pool section, keeping a code being typed. */
  function redrawPools(): void {
    const section = host.querySelector<HTMLElement>('[data-pools]'); if (!section) return;
    const typing = section.querySelector<HTMLInputElement>('[data-sign-in-code]'), focused = typing === document.activeElement;
    section.innerHTML = pools();
    const input = typing && section.querySelector<HTMLInputElement>(`[data-sign-in-code="${CSS.escape(typing.dataset.signInCode!)}"]`);
    if (input) { input.value = typing.value; if (focused) input.focus(); }
  }
  function startSignIn(id: string): void {
    signing = { ...signing, [id]: { id, state: 'starting' } }; redrawPools();
    call('account_sign_in_start', { id }).catch(error => { if (!disposed) { signing = { ...signing, [id]: { id, state: 'failed', message: String(error instanceof Error ? error.message : error) } }; redrawPools(); } });
  }
  function submitCode(id: string): void {
    const code = host.querySelector<HTMLInputElement>(`[data-sign-in-code="${CSS.escape(id)}"]`)?.value ?? '';
    if (!code.trim()) return;
    call('account_sign_in_code', { id, code }).catch(error => message(String(error instanceof Error ? error.message : error), true));
  }
  function signInEvent(event: SignIn): void {
    if (disposed || !signing[event.id]) return;
    const { [event.id]: _done, ...rest } = signing;
    signing = event.state === 'done' ? rest : { ...signing, [event.id]: { ...event, url: event.url ?? signing[event.id]!.url } };
    if (event.state === 'done') { message(`${memberName(event.id)} is signed in.`); refreshPools(); } else redrawPools();
  }
  /** Loads member status for each pool harness with a connection (on or off, so a shared login shows before turning
   *  it on) and redraws only the pool section, so an open form is kept. */
  function refreshPools(): void {
    for (const provider of POOLED.filter(p => snapshot.connections.some(c => c.provider === p))) void call<PoolMember[]>('account_pool_status', { provider }).then(list => {
      if (disposed) return;
      members = { ...members, [provider]: list };
      redrawPools();
    }).catch(error => { if (!disposed) message(String(error), true); });
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
  function message(text: string, error = false): void {
    const feedback = host.querySelector<HTMLElement>('.named-connection-feedback'); if (!feedback) return;
    feedback.textContent = text; feedback.hidden = false; feedback.classList.toggle('error', error);
  }
  async function perform(operation: () => Promise<ConnectionSnapshot>, success: string, closeForm: boolean): Promise<void> {
    host.setAttribute('aria-busy', 'true');
    try {
      const next = await operation(); if (disposed) return;
      snapshot = next; if (closeForm) editing = null;
      render(); syncConfigVar(); message(success); saved(next); refreshPools();
    } catch (error) { if (!disposed) message(String(error instanceof Error ? error.message : error), true); }
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
  const click = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-open-url]');
    if (link && host.contains(link)) { event.preventDefault(); call('open_external_url', { url: link.dataset.openUrl }).catch(error => message(String(error), true)); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button || !host.contains(button)) return;
    if (button.hasAttribute('data-add-connection')) { editing = 'new'; render(); syncConfigVar(); host.querySelector<HTMLInputElement>('#connection-name')?.focus(); }
    else if (button.dataset.editConnection) { editing = snapshot.connections.find(c => c.id === button.dataset.editConnection) ?? null; render(); syncConfigVar(); host.querySelector<HTMLInputElement>('#connection-name')?.focus(); }
    else if (button.dataset.deleteConnection) { const id = button.dataset.deleteConnection; void perform(() => call<ConnectionSnapshot>('connection_delete', { id }), 'Connection deleted. Its tasks use the harness setup again.', false); }
    else if (button.hasAttribute('data-cancel-connection')) { editing = null; render(); }
    else if (button.hasAttribute('data-add-env')) { host.querySelector('[data-env-rows]')!.insertAdjacentHTML('beforeend', envRow({ name: '', value: '', secret: false, saved: false })); }
    else if (button.hasAttribute('data-remove-env')) button.closest('[data-env-row]')?.remove();
    else if (button.dataset.poolClear !== undefined) { const provider = button.dataset.poolProvider, id = button.dataset.poolClear; button.disabled = true; call('account_pool_clear', { provider, id }).then(refreshPools, error => { button.disabled = false; message(String(error), true); }); }
    else if (button.dataset.newAccount) {
      // One click: create the account, then sign it in.
      const provider = button.dataset.newAccount; let id = '';
      void perform(async () => { const account = await call<NewAccount>('connection_new_account', { provider }); id = account.id; return account.snapshot; }, 'Account added. Sign in in your browser to add it to the pool.', false).then(() => { if (id && !disposed) startSignIn(id); });
    }
    else if (button.dataset.signIn) startSignIn(button.dataset.signIn);
    else if (button.dataset.signInCancel) call('account_sign_in_cancel', { id: button.dataset.signInCancel }).catch(error => message(String(error instanceof Error ? error.message : error), true));
    else if (button.dataset.signInSubmit) submitCode(button.dataset.signInSubmit);
    else if (button.dataset.copyCommand) navigator.clipboard.writeText(button.dataset.copyCommand).then(() => message('Command copied.'), error => message(String(error), true));
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === 'connection-provider') syncConfigVar();
    if (target.dataset.poolToggle) { const provider = target.dataset.poolToggle, enabled = target.checked; void perform(() => call<ConnectionSnapshot>('connection_pool_set', { provider, enabled }), enabled ? 'Account pool on.' : 'Account pool off.', false); }
    if (target.dataset.poolMemberToggle !== undefined) { const provider = target.dataset.poolProvider, id = target.dataset.poolMemberToggle, included = target.checked; void perform(() => call<ConnectionSnapshot>('connection_pool_member_set', { provider, id, included }), included ? 'Account added to the pool.' : 'Account left out of the pool.', false); }
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
    void perform(() => call<ConnectionSnapshot>('connection_save', { connection }), 'Connection saved. Choose it in the model picker.', true);
  };
  host.classList.add('connection-card', 'named-connections-card');
  const keydown = (event: KeyboardEvent) => {
    const id = (event.target as HTMLElement).dataset?.signInCode;
    if (id !== undefined && event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); submitCode(id); }
  };
  host.addEventListener('click', click); host.addEventListener('change', change); host.addEventListener('submit', submit); host.addEventListener('keydown', keydown);
  let unlisten: (() => void) | undefined;
  void (subscribe as (name: string, callback: (event: any) => void) => Promise<() => void>)('account-sign-in', signInEvent).then(stop => { if (disposed) stop(); else unlisten = stop; });
  render();
  void call<ConnectionSnapshot>('connections_list').then(next => { if (!disposed) { snapshot = next; if (!editing) render(); refreshPools(); } }).catch(error => { if (!disposed) message(String(error), true); });
  // Statuses refresh on focus and every minute, only while the section is on screen.
  let timer: number | undefined, visible = false;
  const focus = () => { if (visible) refreshPools(); };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting; window.clearInterval(timer); timer = undefined;
    if (visible) { refreshPools(); timer = window.setInterval(refreshPools, POOL_REFRESH_MS); }
  });
  observer.observe(host); window.addEventListener('focus', focus);
  return () => { disposed = true; observer.disconnect(); window.clearInterval(timer); window.removeEventListener('focus', focus); host.removeEventListener('click', click); host.removeEventListener('change', change); host.removeEventListener('submit', submit); host.removeEventListener('keydown', keydown); unlisten?.(); };
}
