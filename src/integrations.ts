import './integrations.css';
import { call, preview } from './bridge';
import { escape, icon } from './dom';
import { t } from './i18n.ts';

interface Tool { name: string; description: string; }
interface Entry extends Tool { status: string; }
interface Server extends Entry { authStatus: string; tools: Tool[]; }
interface Catalog { servers: Server[]; skills: Entry[]; apps: Entry[]; warnings: string[]; }

export async function showIntegrations(dialog: HTMLDialogElement, context: { projectId: string; sessionId?: string }): Promise<void> {
  const host = document.createElement('div');
  host.className = 'integrations-view';
  host.innerHTML = `<div class="dialog-heading"><h2>${t('Tools & integrations')}</h2><button data-action="close-dialog" aria-label="${t('Close')}">${icon('close')}</button></div>
    <p class="dialog-description">${t('Codex uses its own coding tools, your configured MCP servers, and skills for this project.')}</p>
    <div class="integration-content" role="status">${t('Checking available integrations…')}</div>
    <div class="dialog-footer"><button class="secondary-button" data-integration-refresh>${t('Refresh')}</button><button class="primary-button" data-action="close-dialog">${t('Done')}</button></div>`;
  dialog.className = 'settings-dialog'; dialog.replaceChildren(host); if (!dialog.open) dialog.showModal();
  let revision = 0;
  const row = (item: Tool, status?: string) => `<div class="integration-row"><div><strong>${escape(item.name)}</strong>${item.description ? `<small>${escape(item.description)}</small>` : ''}</div>${status ? `<span class="integration-status">${escape(status)}</span>` : ''}</div>`;
  async function refresh(): Promise<void> {
    const ticket = ++revision;
    const refreshButton = host.querySelector<HTMLButtonElement>('[data-integration-refresh]')!;
    refreshButton.disabled = true;
    const results = await Promise.allSettled([
      call<Catalog>('list_agent_integrations', context), call<Tool[]>('list_app_tools'),
    ]);
    if (ticket !== revision || !host.isConnected || !dialog.open) return;
    refreshButton.disabled = false;
    const target = host.querySelector('.integration-content')!;
    const catalog = results[0].status === 'fulfilled' ? results[0].value : undefined;
    const tools = results[1].status === 'fulfilled' ? results[1].value : [];
    target.innerHTML = `${preview ? `<div class="preview-notice">${t('Browser preview · integration status is sample data.')}</div>` : ''}
      <div class="integration-note">${t('Shell commands, file editing, image inspection, web search, and subagents are supplied by Codex when available under its configuration and your task permissions.')}</div>
      <div class="integration-row"><div><strong>${t('Jev · Optional add-on')}</strong><small>${t('Browser tests, work review, context matching, and worker suggestions. No Jev key is needed for normal agent work.')}</small></div><button class="secondary-button" data-action="jev-settings">${t('Set up Jev')}</button></div>
      <details class="integration-group"><summary>${t('PandaCode tools')} <span>${tools.length}</span></summary><p class="integration-note">${t('Core app tools are available in new Codex tasks and their continuations. Older tasks keep their original catalog. When enabled, Jev joins new and resumed tasks across connected harnesses. App actions use your approval mode; embedded browser controls require the task to be visible.')}</p>${tools.map(tool => row({ ...tool, name: tool.name.replace(/^pandacode_/, '').replaceAll('_', ' ') })).join('')}</details>
      ${catalog ? `<details class="integration-group" open><summary>${t('MCP servers')} <span>${catalog.servers.length}</span></summary>${catalog.servers.length ? catalog.servers.map(server => `<details class="integration-server"><summary>${escape(server.name)}<span>${escape(server.status)} · ${escape(server.authStatus)}</span></summary>${server.description ? `<p class="integration-note">${escape(server.description)}</p>` : ''}${server.tools.map(tool => row(tool)).join('') || `<p class="integration-note">${t('No tools were reported.')}</p>`}</details>`).join('') : `<p class="integration-note">${t('No servers were reported for this Codex configuration.')}</p>`}</details>
      <details class="integration-group"><summary>${t('Skills')} <span>${catalog.skills.length}</span></summary>${catalog.skills.map(skill => row(skill, skill.status)).join('') || `<p class="integration-note">${t('No skills were reported for this project.')}</p>`}</details>
      <details class="integration-group"><summary>${t('Apps')} <span>${catalog.apps.length}</span></summary>${catalog.apps.map(app => row(app, app.status)).join('') || `<p class="integration-note">${t('No apps were reported by this Codex installation.')}</p>`}</details>
      ${catalog.warnings.map(warning => `<p class="integration-note" role="status">${escape(warning)}</p>`).join('')}` : `<p class="integration-note" role="alert">${t('Integration discovery is unavailable. Check that Codex CLI is installed and try Refresh.')}</p>`}
      <p class="integration-note">${t('Configure servers through Codex CLI. PandaCode inherits that configuration on the next task run. Codex desktop-only services, including its hosted image generation and automations, are not included in this bridge.')}</p>
      <button class="secondary-button" data-integration-guide>${t('MCP setup guide')} ${icon('globe')}</button>`;
    target.removeAttribute('role');
    target.querySelector('[data-integration-guide]')?.addEventListener('click', () => {
      void call('open_external_url', { url: 'https://developers.openai.com/codex/mcp/' }).catch(() => {
        const note = document.createElement('p'); note.className = 'integration-note'; note.textContent = t('Unable to open the browser. The guide is at developers.openai.com/codex/mcp/.'); target.append(note);
      });
    });
  }
  host.querySelector('[data-integration-refresh]')!.addEventListener('click', () => { void refresh(); });
  await refresh();
}
