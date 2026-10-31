// Named provider connections (issue #29): several setups of one harness, each with its own
// executable, arguments, environment and config folder. Secret values go to the native
// secure store and never come back; the list only carries their names.
import { call } from './bridge';
import { escape } from './dom';
import type { ProviderId } from './types';

export interface Connection { id: string; provider: ProviderId; name: string; executable?: string | null; args: string[]; env: Record<string, string>; secretEnv: string[]; configDir?: string | null; revision: number; }
export interface ConnectionSnapshot { connections: Connection[]; tasks: Record<string, string>; }
interface EnvRow { name: string; value: string; secret: boolean; saved: boolean; }

export const emptyConnections = (): ConnectionSnapshot => ({ connections: [], tasks: {} });
/** The folder variable each harness reads; others set theirs under Environment. */
const CONFIG_DIR: Partial<Record<ProviderId, string>> = { claude: 'CLAUDE_CONFIG_DIR', glm: 'CLAUDE_CONFIG_DIR', mimo: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', pi: 'PI_CODING_AGENT_DIR', opencode: 'OPENCODE_CONFIG_DIR', kilo: 'KILO_CONFIG_DIR' };

export function mountConnections(host: HTMLElement, harnesses: { id: ProviderId; name: string }[], saved: (snapshot: ConnectionSnapshot) => void): () => void {
  let snapshot = emptyConnections(), editing: Connection | 'new' | null = null, disposed = false;
  const harnessName = (id: string) => harnesses.find(h => h.id === id)?.name ?? id;
  function render(): void {
    const rows = snapshot.connections.map(c => `<li class="named-connection" data-connection="${escape(c.id)}"><span><strong>${escape(c.name)}</strong> <small>${escape(harnessName(c.provider))}</small></span><span class="connection-row-actions"><button type="button" class="secondary-button" data-edit-connection="${escape(c.id)}" aria-label="Edit ${escape(c.name)}">Edit</button><button type="button" class="secondary-button" data-delete-connection="${escape(c.id)}" aria-label="Delete ${escape(c.name)}">Delete</button></span></li>`).join('');
    host.innerHTML = `<h3>Connections</h3><p>Add named setups of a harness, such as Claude Work and Claude Personal, each with its own executable, arguments, environment and config folder. Choose one in the model picker; tasks keep theirs.</p>${rows ? `<ul class="named-connections">${rows}</ul>` : ''}${editing ? form(editing === 'new' ? null : editing) : '<button type="button" class="secondary-button" data-add-connection>Add connection</button>'}<p class="named-connection-feedback" role="status" hidden></p>`;
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
      render(); syncConfigVar(); message(success); saved(next);
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
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button || !host.contains(button)) return;
    if (button.hasAttribute('data-add-connection')) { editing = 'new'; render(); syncConfigVar(); host.querySelector<HTMLInputElement>('#connection-name')?.focus(); }
    else if (button.dataset.editConnection) { editing = snapshot.connections.find(c => c.id === button.dataset.editConnection) ?? null; render(); syncConfigVar(); host.querySelector<HTMLInputElement>('#connection-name')?.focus(); }
    else if (button.dataset.deleteConnection) { const id = button.dataset.deleteConnection; void perform(() => call<ConnectionSnapshot>('connection_delete', { id }), 'Connection deleted. Its tasks use the harness setup again.', false); }
    else if (button.hasAttribute('data-cancel-connection')) { editing = null; render(); }
    else if (button.hasAttribute('data-add-env')) { host.querySelector('[data-env-rows]')!.insertAdjacentHTML('beforeend', envRow({ name: '', value: '', secret: false, saved: false })); }
    else if (button.hasAttribute('data-remove-env')) button.closest('[data-env-row]')?.remove();
  };
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === 'connection-provider') syncConfigVar();
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
  host.addEventListener('click', click); host.addEventListener('change', change); host.addEventListener('submit', submit);
  render();
  void call<ConnectionSnapshot>('connections_list').then(next => { if (!disposed) { snapshot = next; if (!editing) render(); } }).catch(error => { if (!disposed) message(String(error), true); });
  return () => { disposed = true; host.removeEventListener('click', click); host.removeEventListener('change', change); host.removeEventListener('submit', submit); };
}
