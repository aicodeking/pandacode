import { call, preview } from './bridge';
import type { Connection, ConnectionSnapshot } from './connections';
import type { ProviderModel } from './types';

const keyName = 'PANDACODE_OPENAI_API_KEY';
const normalize = (value: string) => {
  try { const url = new URL(value.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return ''; return `${url.origin}${url.pathname === '/' ? '/v1' : url.pathname.replace(/\/+$/, '')}`; } catch { return ''; }
};

/** A direct server connection; model discovery never goes through a CLI. */
export function mountOpenaiCompatible(host: HTMLElement, saved: (snapshot: ConnectionSnapshot) => void | Promise<unknown>): () => void {
  let connection: Connection | undefined, disposed = false, pending = false, edited = false, loaded = false;
  let models: ProviderModel[] = [], discoveredBase = '', revision = 0, timer: ReturnType<typeof setTimeout> | undefined;
  host.innerHTML = `<h3>OpenAI Compatible</h3>
    <p>Connect directly to your model server. Enter its Base URL to find the models it exposes. No account or coding CLI is needed.</p>
    <form>
      <label for="compatible-url">Base URL</label><div class="connection-input-row"><input id="compatible-url" type="url" required maxlength="2048" autocomplete="off" spellcheck="false"></div>
      <label for="compatible-key">API key (optional)</label><div class="connection-input-row"><input id="compatible-key" type="password" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Leave blank if your server needs no key"></div>
      <label for="compatible-model">Model</label><div class="connection-select"><select id="compatible-model" required disabled><option value="">Enter a Base URL first</option></select><button type="button" class="secondary-button" data-refresh-models>Refresh models</button></div>
      <p class="compatible-model-status" role="status">Models are supplied by your server.</p>
      <div class="connection-key-status"><span data-key-status>No API key configured.</span><button type="button" class="secondary-button" data-remove-key hidden>Remove saved key</button></div>
      <div class="connection-model-actions"><button type="submit" class="primary-button" data-save-provider disabled>Save provider</button><button type="button" class="secondary-button" data-remove-provider hidden>Remove provider</button></div>
    </form><p class="compatible-feedback" role="status" hidden></p>`;
  const url = host.querySelector<HTMLInputElement>('#compatible-url')!;
  const key = host.querySelector<HTMLInputElement>('#compatible-key')!;
  const model = host.querySelector<HTMLSelectElement>('#compatible-model')!;
  const feedback = host.querySelector<HTMLElement>('.compatible-feedback')!;
  const status = host.querySelector<HTMLElement>('.compatible-model-status')!;
  const saveButton = host.querySelector<HTMLButtonElement>('[data-save-provider]')!;
  function message(text: string, error = false): void {
    feedback.textContent = text; feedback.hidden = false; feedback.classList.toggle('error', error);
  }
  function sync(): void { model.disabled = pending || !models.length; saveButton.disabled = pending || !loaded || !model.value || normalize(url.value) !== discoveredBase; }
  function choices(next: ProviderModel[], selected = ''): void {
    models = next;
    model.replaceChildren(...(models.length ? models.map(m => new Option(m.name || m.id, m.id)) : [new Option('No models available', '')]));
    if (models.some(m => m.id === selected)) model.value = selected;
    sync();
  }
  async function discover(): Promise<void> {
    clearTimeout(timer);
    const base = normalize(url.value), ticket = ++revision, selected = model.value;
    discoveredBase = ''; choices([]);
    if (!base) { status.textContent = 'Enter a valid HTTP or HTTPS Base URL.'; return; }
    if (preview && key.value.trim()) { key.value = ''; status.textContent = 'API keys can only be used in the desktop app.'; message(status.textContent, true); return; }
    status.textContent = 'Finding models…';
    try {
      const next = await call<ProviderModel[]>('provider_discover_compatible_models', {
        baseUrl: base, key: key.value.trim() || null, connectionId: connection?.id ?? null,
      });
      if (disposed || ticket !== revision) return;
      discoveredBase = base; choices(next, selected || connection?.openaiCompatible?.modelId);
      status.textContent = next.length ? `${next.length} model${next.length === 1 ? '' : 's'} available from your server.` : 'The server returned no models. Load or enable a model in your server, then refresh.';
    } catch (error) { if (!disposed && ticket === revision) { status.textContent = String(error); sync(); } }
  }
  function render(snapshot: ConnectionSnapshot): void {
    connection = snapshot.connections.find(c => c.openaiCompatible);
    if (!edited) {
      url.value = connection?.openaiCompatible?.baseUrl ?? '';
      const endpoint = connection?.openaiCompatible;
      discoveredBase = endpoint ? normalize(endpoint.baseUrl) : '';
      choices((endpoint?.models?.length ? endpoint.models : endpoint ? [endpoint.modelId] : []).map(id => ({ id, name: id, description: '' })), endpoint?.modelId);
    }
    const hasKey = connection?.secretEnv.includes(keyName) ?? false;
    key.placeholder = hasKey ? 'Saved · leave blank to keep' : 'Leave blank if your server needs no key';
    host.querySelector<HTMLElement>('[data-key-status]')!.textContent = hasKey ? 'Key saved in secure system storage.' : 'No API key configured.';
    host.querySelector<HTMLButtonElement>('[data-remove-key]')!.hidden = !hasKey;
    host.querySelector<HTMLButtonElement>('[data-remove-provider]')!.hidden = !connection;
    sync();
  }
  async function perform(operation: () => Promise<ConnectionSnapshot>, success: string): Promise<void> {
    if (disposed || pending || !loaded) return;
    pending = true; ++revision; clearTimeout(timer);
    host.setAttribute('aria-busy', 'true');
    host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select').forEach(el => el.disabled = true);
    try {
      const snapshot = await operation();
      if (disposed) return;
      key.value = ''; edited = false; render(snapshot); await saved(snapshot); message(success);
    } catch (error) { if (!disposed) message(String(error), true); }
    finally {
      pending = false;
      if (!disposed) { host.removeAttribute('aria-busy'); host.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(el => el.disabled = false); sync(); }
    }
  }
  function save(removeKey = false): Promise<ConnectionSnapshot> {
    const value = key.value.trim();
    if (preview && value && !removeKey) { key.value = ''; return Promise.reject(new Error('API keys can only be saved in the desktop app.')); }
    const sameServer = normalize(connection?.openaiCompatible?.baseUrl ?? '') === normalize(url.value);
    const env = !removeKey && (value || (sameServer && connection?.secretEnv.includes(keyName))) ? [{ name: keyName, value: value || null, secret: true }] : [];
    return call('connection_save', { connection: {
      id: connection?.id ?? null, provider: 'openai-compatible', name: 'OpenAI Compatible', env,
      openaiCompatible: removeKey ? connection!.openaiCompatible : { baseUrl: normalize(url.value), modelId: model.value, models: models.map(m => m.id) },
    } });
  }
  const input = (event: Event) => {
    edited = true;
    if (event.target === url || event.target === key) {
      ++revision; clearTimeout(timer); discoveredBase = ''; choices([]);
      status.textContent = 'Waiting for the server address…';
      if (normalize(url.value)) timer = setTimeout(() => void discover(), 500);
    }
  };
  const change = () => sync();
  const submit = (event: Event) => {
    event.preventDefault(); event.stopPropagation();
    if (!saveButton.disabled) void perform(() => save(), 'Provider saved. Choose OpenAI Compatible in the model picker.');
  };
  const click = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest('button');
    if (button?.hasAttribute('data-refresh-models')) { event.stopPropagation(); if (!pending) void discover(); }
    else if (button?.hasAttribute('data-remove-key') && connection) { event.stopPropagation(); void perform(() => save(true), 'Saved key removed.'); }
    else if (button?.hasAttribute('data-remove-provider') && connection) { event.stopPropagation(); const id = connection.id; void perform(() => call('connection_delete', { id }), 'Provider removed.'); }
  };
  host.addEventListener('input', input); host.addEventListener('change', change); host.addEventListener('submit', submit); host.addEventListener('click', click);
  void call<ConnectionSnapshot>('connections_list').then(snapshot => {
    if (disposed) return;
    loaded = true; render(snapshot);
    if (!edited && connection) void discover();
  }).catch(error => { if (!disposed) message(String(error), true); });
  return () => { disposed = true; ++revision; clearTimeout(timer); key.value = ''; host.removeEventListener('input', input); host.removeEventListener('change', change); host.removeEventListener('submit', submit); host.removeEventListener('click', click); };
}
