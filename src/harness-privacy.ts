import { call } from './bridge';
import { escape } from './dom';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import type { ProviderId } from './types';

type Status = 'off' | 'manual' | 'unknown';
interface Harness { provider: ProviderId; name: string; status: Status; detail: string }
interface Privacy { off: boolean; harnesses: Harness[] }

const TITLE = 'Turn off agent telemetry';
const ABOUT = 'Agents started by PandaCode get each vendor’s own opt-outs for usage analytics, error reports and feedback uploads, plus DO_NOT_TRACK=1, which tools the agents run may also honor. Your agent config files are not changed, and agents already running keep their setting until they restart.';

/** What the switch does for one harness right now. */
function stateLabel(h: Harness, off: boolean): string {
  if (h.status === 'off') return off ? 'Turned off' : 'Vendor default';
  return h.status === 'manual' ? `Turn off in ${h.name}` : 'No verified switch';
}

/** Settings → Agents → Privacy: one switch for every harness's own telemetry opt-outs (`providers/privacy.rs`). */
export function mountHarnessPrivacy(host: HTMLElement): () => void {
  let disposed = false, saving = false, loaded = false;
  let retry: (() => void) | undefined;
  host.innerHTML = `<div class="settings-group">
      <div class="setting-row"><div><strong>${TITLE} ${infoMark(ABOUT, 'About agent telemetry')}</strong><small>Uses each agent’s own opt-outs.</small><span class="sr-only" id="harness-telemetry-about" aria-hidden="true">${escape(ABOUT)}</span></div><input type="checkbox" class="settings-switch" id="harness-telemetry-off" aria-label="${TITLE}" aria-describedby="harness-telemetry-about harness-telemetry-status" disabled></div>
    </div>
    <div class="harness-privacy-feedback"><p class="harness-privacy-status" id="harness-telemetry-status" role="status"></p><button type="button" class="secondary-button" data-privacy-retry hidden>Try again</button></div>
    <ul class="settings-group harness-privacy-list" aria-label="Telemetry by agent"></ul>`;
  const toggle = host.querySelector<HTMLInputElement>('#harness-telemetry-off')!;
  const status = host.querySelector<HTMLElement>('.harness-privacy-status')!;
  const list = host.querySelector<HTMLElement>('.harness-privacy-list')!;
  const retryButton = host.querySelector<HTMLButtonElement>('[data-privacy-retry]')!;
  /** Shows `text` (empty clears it); with `again`, the Try again button beside it runs that. */
  const say = (text: string, again?: () => void) => {
    retry = again;
    status.textContent = text;
    retryButton.hidden = !again;
  };
  const render = (privacy: Privacy) => {
    loaded = true;
    toggle.checked = privacy.off;
    toggle.disabled = false;
    list.innerHTML = privacy.harnesses.map(h => `<li class="setting-row" data-provider="${escape(h.provider)}" data-status="${h.status}" data-active="${h.status === 'off' && privacy.off}"><div>${providerLogo(h.provider)}<span><strong>${escape(h.name)}</strong><small>${escape(h.detail)}</small></span></div><em>${escape(stateLabel(h, privacy.off))}</em></li>`).join('');
  };
  const load = () => {
    say('');
    call<Privacy>('harness_privacy').then(p => { if (!disposed) render(p); })
      .catch(() => { if (!disposed) say('Agent telemetry settings couldn’t load.', load); });
  };
  retryButton.addEventListener('click', () => retry?.());
  const save = (wanted: boolean) => {
    saving = true; toggle.setAttribute('aria-busy', 'true'); say('');
    call<Privacy>('harness_privacy_set', { off: wanted })
      .then(p => { if (disposed) return; render(p); say(wanted ? 'Agents started from now on have telemetry turned off.' : 'Agents started from now on use their own telemetry settings.'); })
      .catch(() => { if (disposed) return; toggle.checked = !wanted; say('Couldn’t save this setting.', () => { toggle.checked = wanted; save(wanted); }); })
      .finally(() => { saving = false; toggle.removeAttribute('aria-busy'); });
  };
  // The switch stays enabled while saving so keyboard focus stays on it; extra changes wait.
  toggle.addEventListener('change', () => {
    if (saving || !loaded) { toggle.checked = !toggle.checked; return; }
    save(toggle.checked);
  });
  load();
  return () => { disposed = true; };
}
