import './provider-settings.css';
import { call, preview } from './bridge';
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import type { ConnectionSnapshot } from './connections';
import type { ProviderId } from './types';

type ClaudeMode = 'inherit' | 'subscription';
interface ClaudeStatus { mode: ClaudeMode; source: string; environmentVariables: string[]; endpoint: string | null; savedLogin: 'signedIn' | 'notSignedIn' | 'otherCredentials' | 'unknown'; conflict: boolean; }
const claudeHelp = 'Use current environment preserves your existing Claude setup. Prefer saved Claude login removes inherited API credentials, endpoints, and model routing overrides from new Claude processes in PandaCode. Claude settings, credential helpers, profiles, and organization policies can still affect authentication. Check /status in Claude to confirm.';

interface Configuration {
  executablePaths: Record<string, string>;
  glmKeySaved: boolean;
  glmKeyFromEnvironment: boolean;
  deepseekKeySaved: boolean;
  deepseekKeyFromEnvironment: boolean;
  commandcodeKeySaved: boolean;
  commandcodeKeyFromEnvironment: boolean;
  mimoKeySaved: boolean;
  mimoKeyFromEnvironment: boolean;
  mimoEndpoint: string | null;
  mimoEndpoints: { id: string; url: string; label: string }[];
  secureStorageAvailable: boolean;
  credentialStorageError?: string | null;
  claudeConnectionMode?: ClaudeMode;
}

/** Key-based connections share one form/status/remove pattern; the native side owns the secret. */
const keyed = {
  glm: { env: 'ZAI_API_KEY', save: 'provider_save_glm_key', remove: 'provider_remove_glm_key', saved: 'GLM key saved. Choose GLM Coding Plan in the model selector.', savedFlag: 'glmKeySaved', envFlag: 'glmKeyFromEnvironment' },
  mimo: { env: 'MIMO_API_KEY', save: 'provider_save_mimo_key', remove: 'provider_remove_mimo_key', saved: 'MiMo key saved. Choose MiMo Token Plan in the model selector.', savedFlag: 'mimoKeySaved', envFlag: 'mimoKeyFromEnvironment' },
  deepseek: { env: 'DEEPSEEK_API_KEY', save: 'provider_save_deepseek_key', remove: 'provider_remove_deepseek_key', saved: 'DeepSeek key saved. Choose DeepSeek in the model selector.', savedFlag: 'deepseekKeySaved', envFlag: 'deepseekKeyFromEnvironment' },
  commandcode: { env: 'COMMAND_CODE_API_KEY', save: 'provider_save_commandcode_key', remove: 'provider_remove_commandcode_key', saved: 'Command Code key saved. Choose Command Code in the model selector.', savedFlag: 'commandcodeKeySaved', envFlag: 'commandcodeKeyFromEnvironment' },
} as const;
type KeyedProvider = keyof typeof keyed;

function keyForm(provider: KeyedProvider, label: string): string {
  return `<form id="${provider}-key-form" data-key-provider="${provider}"><label for="${provider}-key">${escape(label)}</label><div class="connection-input-row"><input id="${provider}-key" type="password" autocomplete="off" spellcheck="false" placeholder="Enter API key" maxlength="4096"><button class="primary-button" type="submit">Save key</button></div></form>
      <div class="connection-key-status"><span id="${provider}-key-status" role="status">Checking connection…</span><button type="button" class="secondary-button" id="remove-${provider}-key" data-remove-key="${provider}" hidden>Remove saved key</button></div>`;
}

export function mountProviderSettings(host: HTMLElement, saved: () => Promise<unknown>, named?: { harnesses: { id: ProviderId; name: string }[]; saved: (snapshot: ConnectionSnapshot) => void }): () => void {
  let disposed = false, pending = false, unmountNamed: (() => void) | undefined;
  let configurationRevision = 0;
  const editedPaths = new Set<HTMLInputElement>();
  host.classList.add('provider-connections');
  host.innerHTML = `<p class="dialog-description">Use your existing agent accounts. Each connection keeps its own configuration.</p>${named ? '<section id="named-connections"></section>' : ''}
    <section class="connection-card" id="claude-connection"><h3>${providerLogo('claude')}Claude Code</h3>
      <div class="connection-auth-label"><label for="claude-connection-mode">Claude connection</label>${infoMark(claudeHelp, 'Claude connection details')}<span class="sr-only" id="claude-connection-help">${escape(claudeHelp)}</span></div>
      <div class="connection-select"><select id="claude-connection-mode" aria-describedby="claude-connection-help"><option value="inherit">Use current environment</option><option value="subscription">Prefer saved Claude login</option></select></div>
      <div class="connection-key-status"><span class="claude-auth-source" role="status">Checking Claude login…</span><span class="claude-auth-details"></span><button type="button" class="secondary-button" data-check-claude>Check login</button></div>
      <p class="claude-auth-endpoint" hidden></p><p class="claude-auth-conflict" hidden>Environment credentials can override your saved Claude login.</p><p class="claude-auth-login" hidden></p>
      <a href="https://code.claude.com/docs/en/authentication" target="_blank" rel="noopener noreferrer">Claude sign-in help ${icon('forward')}</a>
    </section>
    <section class="connection-card"><h3>${providerLogo('glm')}GLM Coding Plan<small>via Claude Code</small></h3>
      <p>Use a Z.ai Coding Plan key with your installed Claude Code. Your regular Claude account stays separate.</p>
      ${keyForm('glm', 'Z.ai API key')}
      <a href="https://docs.z.ai/devpack/tool/claude" target="_blank" rel="noopener noreferrer">Coding Plan setup ${icon('forward')}</a>
    </section>
    <section class="connection-card"><h3>${providerLogo('mimo')}MiMo Token Plan<small>Xiaomi, via Claude Code</small></h3>
      <p>Use your Token Plan (or pay-as-you-go) key with your installed Claude Code. Pick the cluster shown on your Token Plan page; keys look like <code>tp-…</code>, <code>ttp-…</code> or <code>sk-…</code>.</p>
      <label for="mimo-endpoint">Endpoint</label><div class="connection-select"><select id="mimo-endpoint" aria-describedby="mimo-endpoint-hint"><option value="">Choose your cluster…</option></select></div>
      <small id="mimo-endpoint-hint" class="connection-endpoint-hint" data-live></small>
      ${keyForm('mimo', 'MiMo API key')}
      <a href="https://platform.xiaomimimo.com/token-plan" target="_blank" rel="noopener noreferrer">Token Plan ${icon('forward')}</a>
    </section>
    <section class="connection-card"><h3>${providerLogo('opencode')}OpenCode</h3><p>Uses the accounts and models configured in OpenCode. Sign in once with <code>opencode auth login</code>.</p><div class="connection-model-actions"><a href="https://opencode.ai/docs/" target="_blank" rel="noopener noreferrer">Install & sign in ${icon('forward')}</a><button type="button" class="secondary-button" data-action="opencode-models">Choose models</button></div>${pathForm('opencode', 'OpenCode executable', '/path/to/opencode')}</section>
    <section class="connection-card"><h3>${providerLogo('antigravity')}Antigravity</h3><p>Connect the official Google Antigravity ACP server. The standalone <code>agy</code> terminal CLI is a different executable.</p><a href="https://antigravity.google/docs/ide/extensions" target="_blank" rel="noopener noreferrer">Get the official ACP server ${icon('forward')}</a>${pathForm('antigravity', 'Antigravity ACP executable', '/path/to/agy_acp_server.par')}</section>
    <section class="connection-card"><h3>${providerLogo('grok')}Grok Build<small>xAI, via ACP</small></h3><p>Uses your Grok sign-in and models. Install with <code>curl -fsSL https://x.ai/cli/install.sh | bash</code>, then run <code>grok login</code> once; PandaCode talks to <code>grok agent stdio</code>.</p><a href="https://docs.x.ai/build/overview" target="_blank" rel="noopener noreferrer">Grok Build docs ${icon('forward')}</a>${pathForm('grok', 'Grok executable', '/path/to/grok')}</section>
    <section class="connection-card"><h3>${providerLogo('pi')}Pi</h3><p>Uses the accounts, models and extensions configured in Pi. Install Pi and sign in from its CLI before starting a task.</p><a href="https://github.com/earendil-works/pi" target="_blank" rel="noopener noreferrer">Install Pi ${icon('forward')}</a>${pathForm('pi', 'Pi executable', '/path/to/pi')}</section>
    <section class="connection-card"><h3>Oh My Pi<small>omp</small></h3><p>A Pi fork with its own accounts and models. Install it with <code>bun install -g @oh-my-pi/pi-coding-agent</code>, then sign in from the <code>omp</code> CLI before starting a task.</p><a href="https://github.com/can1357/oh-my-pi" target="_blank" rel="noopener noreferrer">Install omp ${icon('forward')}</a>${pathForm('omp', 'omp executable', '/path/to/omp')}</section>
    <section class="connection-card"><h3>${providerLogo('deepseek')}DeepSeek<small>DeepSeek Harness, via ACP</small></h3><p>Install with <code>npm i -g @deepseek-ai/dsh</code>. A key is optional: DeepSeek can use its own stored credentials.</p>
      ${keyForm('deepseek', 'DeepSeek API key')}
      <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">Get an API key ${icon('forward')}</a>${pathForm('deepseek', 'DeepSeek executable', '/path/to/dsh')}</section>
    <section class="connection-card"><h3>${providerLogo('commandcode')}Command Code<small>via ACP</small></h3><p>Install with <code>npm i -g command-code</code>, then sign in once with <code>command-code login</code>. A key is optional: either one authenticates the same account.</p>
      ${keyForm('commandcode', 'Command Code API key')}
      <a href="https://commandcode.ai/docs/acp" target="_blank" rel="noopener noreferrer">Command Code docs ${icon('forward')}</a>${pathForm('commandcode', 'Command Code executable', '/path/to/command-code')}</section>
    <section class="connection-card"><h3>${providerLogo('cline')}Cline<small>via ACP</small></h3><p>Install with <code>npm i -g cline</code>, then sign in once with <code>cline auth</code> (or set <code>CLINE_API_KEY</code>). PandaCode talks to <code>cline --acp</code> and uses the provider and models chosen in Cline.</p><a href="https://docs.cline.bot/cline-cli/overview" target="_blank" rel="noopener noreferrer">Cline CLI docs ${icon('forward')}</a>${pathForm('cline', 'Cline executable', '/path/to/cline')}</section>
    <section class="connection-card"><h3>${providerLogo('github-copilot')}GitHub Copilot CLI<small>GitHub Copilot, via ACP</small></h3><p>Install with <code>npm install -g @github/copilot</code>, then run <code>copilot login</code> in a terminal. PandaCode uses the CLI sign-in; GitHub credentials stay with Copilot CLI.</p><div class="connection-model-actions"><a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli" target="_blank" rel="noopener noreferrer">Install and sign in ${icon('forward')}</a><a href="https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server" target="_blank" rel="noopener noreferrer">ACP support details ${icon('forward')}</a></div>${pathForm('github-copilot', 'GitHub Copilot CLI executable', '/path/to/copilot')}</section>
    <section class="connection-card"><h3>Kilo Code<small>via ACP</small></h3><p>Install with <code>npm i -g @kilocode/cli</code>, then sign in with <code>kilo auth login</code>. PandaCode talks to <code>kilo acp</code> and uses the accounts and models configured in Kilo.</p><a href="https://kilo.ai/docs/code-with-ai/platforms/cli" target="_blank" rel="noopener noreferrer">Kilo CLI docs ${icon('forward')}</a>${pathForm('kilo', 'Kilo executable', '/path/to/kilo')}</section>
    <section class="connection-card"><h3>${providerLogo('muse')}Muse Code<small>Meta, via MSP</small></h3><p>Install Muse Code, then run <code>muse login</code> once in a terminal. PandaCode talks to <code>muse serve</code> and uses that sign-in.</p>${pathForm('muse', 'Muse Code executable', '/path/to/muse')}</section>
    <p class="connection-feedback" role="status" hidden></p>${preview ? '<p class="settings-preview-note">Browser preview · keys are never saved here.</p>' : ''}`;
  const feedback = host.querySelector<HTMLElement>('.connection-feedback')!;
  const keyInput = (provider: KeyedProvider) => host.querySelector<HTMLInputElement>(`#${provider}-key`)!;
  const keyInputs = (Object.keys(keyed) as KeyedProvider[]).map(keyInput);
  const endpoint = host.querySelector<HTMLSelectElement>('#mimo-endpoint')!;
  const endpointHint = host.querySelector<HTMLElement>('#mimo-endpoint-hint')!;
  const claudeMode = host.querySelector<HTMLSelectElement>('#claude-connection-mode')!;
  const claudeSource = host.querySelector<HTMLElement>('.claude-auth-source')!;
  const claudeCheck = host.querySelector<HTMLButtonElement>('[data-check-claude]')!;
  let claudeEdited = false, claudeRevision = 0;
  async function checkClaude(): Promise<void> {
    const ticket = ++claudeRevision;
    claudeSource.textContent = 'Checking Claude login…'; claudeCheck.disabled = true;
    for (const node of host.querySelectorAll<HTMLElement>('.claude-auth-endpoint,.claude-auth-conflict,.claude-auth-login')) node.hidden = true;
    host.querySelector('.claude-auth-details')!.replaceChildren();
    try {
      const status = await call<ClaudeStatus>('provider_claude_status');
      if (disposed || ticket !== claudeRevision) return;
      if (!claudeEdited) claudeMode.value = status.mode;
      claudeSource.textContent = status.source;
      const endpoint = host.querySelector<HTMLElement>('.claude-auth-endpoint')!;
      endpoint.textContent = status.endpoint ? `Endpoint: ${status.endpoint}` : ''; endpoint.hidden = !status.endpoint;
      host.querySelector<HTMLElement>('.claude-auth-conflict')!.hidden = !status.conflict;
      const details = status.environmentVariables.length ? `${status.mode === 'subscription' ? 'Ignored for new Claude processes' : 'Detected in the app environment'}: ${status.environmentVariables.join(', ')}. No credential values are shown.` : 'No inherited Claude credential or routing overrides detected.';
      host.querySelector<HTMLElement>('.claude-auth-details')!.innerHTML = `${infoMark(details, 'Claude environment details')}<span class="sr-only">${escape(details)}</span>`;
      const login = host.querySelector<HTMLElement>('.claude-auth-login')!;
      login.textContent = status.savedLogin === 'notSignedIn' ? 'Saved login not found. Run claude auth login, then check again.' : status.savedLogin === 'unknown' ? 'Saved login could not be verified. Run claude auth status to check it.' : status.savedLogin === 'otherCredentials' ? 'Saved credentials use an API key. Sign in to Claude Code with your Claude account to use its login.' : '';
      login.hidden = !login.textContent;
    } catch { if (!disposed && ticket === claudeRevision) claudeSource.textContent = 'Claude login could not be checked. Try Check login again.'; }
    finally { if (!disposed && ticket === claudeRevision) claudeCheck.disabled = pending; }
  }
  let endpointEdited = false;
  function message(text: string, error = false): void { feedback.textContent = text; feedback.hidden = false; feedback.classList.toggle('error', error); }
  function keysDisabled(config: Configuration): boolean { return !config.secureStorageAvailable || preview; }
  function render(config: Configuration): void {
    if (!claudeEdited) claudeMode.value = config.claudeConnectionMode ?? 'inherit';
    for (const input of host.querySelectorAll<HTMLInputElement>('[data-executable]')) {
      if (!editedPaths.has(input)) input.value = config.executablePaths[input.dataset.executable!] ?? '';
    }
    for (const provider of Object.keys(keyed) as KeyedProvider[]) {
      const spec = keyed[provider];
      const status = host.querySelector(`#${provider}-key-status`)!;
      status.textContent = config[spec.savedFlag] ? 'Key saved in secure system storage.' : config[spec.envFlag] ? `Using ${spec.env} from your environment.` : 'No API key configured.';
      host.querySelector<HTMLButtonElement>(`#remove-${provider}-key`)!.hidden = !config[spec.savedFlag];
      keyInput(provider).disabled = keysDisabled(config);
      host.querySelector<HTMLButtonElement>(`#${provider}-key-form button`)!.disabled = keysDisabled(config);
      if (!config.secureStorageAvailable) status.textContent += ` Set ${spec.env} in the app environment on this platform.`;
      else if (config.credentialStorageError) status.textContent += ` ${config.credentialStorageError} You can also set ${spec.env} in the app environment.`;
    }
    // The native side is the authority on which MiMo clusters exist.
    if (!endpointEdited) {
      endpoint.replaceChildren(new Option('Choose your cluster…', ''), ...config.mimoEndpoints.map(entry => new Option(entry.label, entry.id)));
      endpoint.value = config.mimoEndpoint ?? '';
    }
    const chosen = config.mimoEndpoints.find(entry => entry.id === config.mimoEndpoint);
    endpointHint.textContent = chosen ? chosen.url : 'Required before MiMo tasks can start. The Token Plan page shows your cluster.';
    endpointHint.classList.toggle('error', !chosen);
  }
  async function perform(operation: () => Promise<Configuration>, success: string, submittedInput?: HTMLInputElement): Promise<void> {
    if (pending || disposed) return;
    const submittedValue = submittedInput?.value;
    pending = true; host.setAttribute('aria-busy', 'true');
    claudeMode.disabled = true;
    host.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = true);
    try {
      const configuration = await operation();
      if (disposed) return;
      configurationRevision++;
      if (submittedInput && submittedInput.value === submittedValue) {
        editedPaths.delete(submittedInput);
        if (keyInputs.includes(submittedInput)) submittedInput.value = '';
      }
      render(configuration); message(success);
      await saved();
    } catch (error) { if (!disposed) message(String(error), true); }
    finally {
      pending = false;
      if (!disposed) { claudeMode.disabled = false; host.removeAttribute('aria-busy'); host.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = false); for (const input of keyInputs) host.querySelector<HTMLButtonElement>(`#${input.id}-form button`)!.disabled = input.disabled; }
    }
  }
  const submit = (event: Event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('form'); if (!form || !host.contains(form)) return;
    event.preventDefault(); event.stopPropagation();
    const keyedProvider = form.dataset.keyProvider as KeyedProvider | undefined;
    if (keyedProvider) {
      const key = keyInput(keyedProvider);
      if (preview) { key.value = ''; message('API keys can only be saved in the desktop app.'); return; }
      const secret = key.value.trim(); if (!secret) { key.focus(); return; }
      void perform(() => call(keyed[keyedProvider].save, { key: secret }), keyed[keyedProvider].saved, key);
    } else {
      const provider = form.dataset.provider!;
      const input = form.querySelector<HTMLInputElement>('input')!;
      const path = input.value.trim();
      void perform(() => call('provider_set_executable', { provider, path }), path ? 'Executable saved.' : 'Automatic discovery restored.', input);
    }
  };
  const click = async (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
    if (target.hasAttribute('data-check-claude')) { void checkClaude(); return; }
    const removing = target.dataset.removeKey as KeyedProvider | undefined;
    if (removing) { void perform(() => call(keyed[removing].remove), 'Saved key removed.'); return; }
    if (target.dataset.chooseExecutable) {
      event.preventDefault();
      if (preview) { message('Choose executable is available in the desktop app.'); return; }
      try {
        const path = await (await import('@tauri-apps/plugin-dialog')).open({ directory: false, multiple: false, title: 'Choose agent executable' });
        if (!disposed && typeof path === 'string') {
          const input = host.querySelector<HTMLInputElement>(`[data-executable="${target.dataset.chooseExecutable}"]`)!;
          input.value = path; editedPaths.add(input);
        }
      } catch (error) { if (!disposed) message(String(error), true); }
    }
  };
  const input = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.executable) editedPaths.add(target);
  };
  const change = (event: Event) => {
    if (event.target === claudeMode) {
      if (pending) return;
      claudeEdited = true; claudeRevision++;
      void perform(() => call('provider_set_claude_connection_mode', { mode: claudeMode.value }), 'Claude connection saved for new agent processes.').finally(() => {
        claudeEdited = false;
        if (!disposed) void checkClaude();
      });
      return;
    }
    if (event.target !== endpoint || !endpoint.value) return;
    if (preview) { message('The MiMo endpoint can only be saved in the desktop app.'); return; }
    endpointEdited = true;
    const chosen = endpoint.value;
    void perform(() => call('provider_set_mimo_endpoint', { endpoint: chosen }), 'MiMo endpoint saved.').finally(() => { endpointEdited = false; });
  };
  host.addEventListener('submit', submit); host.addEventListener('click', click); host.addEventListener('input', input); host.addEventListener('change', change);
  void call<Configuration>('provider_configuration').then(config => { if (!disposed && configurationRevision === 0) render(config); }).catch(error => { if (!disposed && configurationRevision === 0) message(String(error), true); });
  void checkClaude();
  if (named) void import('./connections').then(({ mountConnections }) => { if (!disposed) unmountNamed = mountConnections(host.querySelector<HTMLElement>('#named-connections')!, named.harnesses, named.saved); });
  return () => { disposed = true; unmountNamed?.(); for (const input of keyInputs) input.value = ''; editedPaths.clear(); host.removeEventListener('submit', submit); host.removeEventListener('click', click); host.removeEventListener('input', input); host.removeEventListener('change', change); };
}

function pathForm(provider: string, label: string, placeholder: string): string {
  return `<details class="connection-path"><summary>Executable location ${icon('down')}</summary><form data-provider="${provider}"><label for="executable-${provider}">${escape(label)}</label><div class="connection-input-row"><input id="executable-${provider}" data-executable="${provider}" placeholder="${escape(placeholder)}" autocomplete="off" spellcheck="false"><button type="button" class="secondary-button" data-choose-executable="${provider}" aria-label="Choose ${escape(label)}">${icon('folder')}</button><button class="secondary-button" type="submit">Apply</button></div><small>Leave empty to find it automatically.</small></form></details>`;
}
