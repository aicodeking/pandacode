import './overlay-settings.css';
import { overlayCall, type OverlayPreferences } from './overlay-client';
import { isMac, isWindows } from './platform';
import { infoMark } from './tooltip';
export { syncOverlayContext } from './overlay-client';

export function mountOverlaySettings(host: HTMLElement): () => void {
  host.classList.add('overlay-settings');
  host.innerHTML = `<div class="settings-group"><div class="setting-row"><div><strong>Quick launcher</strong><small>Start tasks and check agents from any app.</small></div><input type="checkbox" class="settings-switch" aria-label="Enable quick launcher" disabled></div><form class="overlay-shortcut-form"><div class="overlay-shortcut-heading"><label for="overlay-shortcut">Keyboard shortcut</label><small id="overlay-shortcut-hint" class="sr-only">Use CommandOrControl, Shift, Alt, and a key separated by +.</small></div><div class="overlay-shortcut-controls"><input id="overlay-shortcut" aria-describedby="overlay-shortcut-hint" spellcheck="false" autocomplete="off" maxlength="100" placeholder="CommandOrControl+Shift+Space" disabled><button class="secondary-button" type="button" data-overlay-record disabled>Record</button><button class="secondary-button" type="submit" disabled>Save</button><button class="secondary-button" type="button" data-overlay-preview disabled>Open</button>${infoMark('Use CommandOrControl, Shift, Alt, and a key separated by +.', 'About Keyboard shortcut')}</div><p class="overlay-settings-status" role="status" hidden></p></form></div>`;
  const enabled = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  const input = host.querySelector<HTMLInputElement>('#overlay-shortcut')!;
  const form = host.querySelector<HTMLFormElement>('form')!;
  const save = host.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const open = host.querySelector<HTMLButtonElement>('[data-overlay-preview]')!;
  const status = host.querySelector<HTMLElement>('[role=status]')!;
  const record = host.querySelector<HTMLButtonElement>('[data-overlay-record]')!;
  let disposed = false, busy = false, recording = false, preparing = false, suspended = false, preferences: OverlayPreferences | null = null;
  let recordingTimeout: number | undefined;
  const message = (value: string, error = false) => { status.textContent = value; status.hidden = !value; status.classList.toggle('error', error); };
  function update(value: OverlayPreferences): void { preferences = value; enabled.checked = value.enabled; input.value = value.shortcut; message(value.error || '', Boolean(value.error)); }
  function controls(): void {
    enabled.disabled = busy || recording || preparing || !preferences;
    input.disabled = busy || preparing || !preferences; input.readOnly = recording;
    save.disabled = busy || recording || preparing || !preferences; open.disabled = save.disabled;
    record.disabled = busy || preparing || !preferences; record.textContent = recording ? 'Cancel' : 'Record';
  }
  async function endRecording(): Promise<void> {
    recording = false; clearTimeout(recordingTimeout); controls();
    if (suspended) { suspended = false; await overlayCall('overlay_recording',{active:false}); }
  }
  async function beginRecording(): Promise<void> {
    if (recording) { await endRecording(); message(''); return; }
    preparing = true; controls(); message('Preparing shortcut recorder…');
    try {
      await overlayCall('overlay_recording',{active:true}); suspended = true;
      if (disposed) { await endRecording(); return; }
      recording = true; preparing = false; controls(); input.focus(); message('Press your shortcut. Escape cancels.');
      recordingTimeout = window.setTimeout(() => { void endRecording().catch(error => message(String(error),true)); message('Recording timed out. Your shortcut is unchanged.'); }, 28000);
    } catch (error) { if (!disposed) message(String(error),true); }
    finally { preparing = false; if (!disposed) controls(); }
  }
  function keydown(event: KeyboardEvent): void {
    if (!recording) return;
    if (event.key === 'Tab' || event.key === 'Escape') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      void endRecording().catch(error => message(String(error),true)); message(''); return;
    }
    event.preventDefault(); event.stopPropagation();
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { message(isMac ? 'Include Command, Control, Option, or Shift.' : `Include Control, Alt, Shift, or the ${isWindows ? 'Windows' : 'Super'} key.`); return; }
    if (!/^(Key[A-Z]|Digit[0-9]|Space|F[1-9][0-9]?|Arrow(?:Up|Down|Left|Right)|Enter|Backspace|Delete|Home|End|PageUp|PageDown)$/.test(event.code)) return;
    const modifiers = [event.metaKey ? isMac ? 'Command' : 'Super' : '',event.ctrlKey ? 'Control' : '',event.altKey ? 'Alt' : '',event.shiftKey ? 'Shift' : ''].filter(Boolean);
    input.value = [...modifiers,event.code].join('+');
    void endRecording().then(() => { if (!disposed) { message('Shortcut captured. Save to apply.'); save.focus(); } }).catch(error => message(String(error),true));
  }
  function blur(): void { if (recording) void endRecording().catch(error => message(String(error),true)); }

  async function persist(event?: Event): Promise<void> {
    event?.preventDefault(); event?.stopPropagation(); if (busy || recording || !preferences) return;
    busy = true; controls();
    try {
      const next = await overlayCall<OverlayPreferences>('overlay_save_preferences',{enabled:enabled.checked,shortcut:input.value});
      if (!disposed) { update(next); if (!next.error) message('Saved'); }
    } catch (error) { if (!disposed) { enabled.checked = preferences.enabled; message(String(error instanceof Error ? error.message : error), true); } }
    finally { busy = false; if (!disposed) controls(); }
  }
  async function openLauncher(): Promise<void> { try { await overlayCall('overlay_toggle'); } catch (error) { if (!disposed) message(String(error), true); } }
  record.addEventListener('click', beginRecording); input.addEventListener('keydown',keydown); window.addEventListener('blur',blur);
  form.addEventListener('submit', persist); enabled.addEventListener('change', persist); open.addEventListener('click', openLauncher);
  void overlayCall<OverlayPreferences>('overlay_preferences').then(value => { if (!disposed) { update(value); controls(); } }).catch(error => { if (!disposed) message(String(error), true); });
  return () => { disposed = true; void endRecording().catch(error => console.warn('Shortcut restore failed.',error)); record.removeEventListener('click',beginRecording); input.removeEventListener('keydown',keydown); window.removeEventListener('blur',blur); form.removeEventListener('submit', persist); enabled.removeEventListener('change', persist); open.removeEventListener('click', openLauncher); };
}
