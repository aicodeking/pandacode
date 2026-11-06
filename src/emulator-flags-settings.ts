import { call } from './bridge';
import { escape } from './dom';
import { infoMark } from './tooltip';

/* Settings → Tools & add-ons: launch flags for Android emulators. One default
 * for every device plus per-device overrides, saved through the same simulator
 * IPC an emulator boot reads. */

type EmulatorFlags = { default: string; devices: Record<string, string> };
type SimDevice = { udid: string; name: string; platform?: string };

const HELP = 'Appended after PandaCode’s own flags when an Android emulator boots. Space separated; quotes keep a group together. A device’s own flags replace the default.';

export function mountEmulatorFlags(host: HTMLElement, notify: (text: string) => void): void {
  let flags: EmulatorFlags = { default: '', devices: {} };
  let avds: SimDevice[] = [];
  let error = '';
  let saving = false;

  const draw = (): void => {
    host.innerHTML = `<form id="emulator-flags-form" data-testid="emulator-flags-form">
      <div class="field-label-row"><label class="field-label" for="emulator-flags-default">Default flags</label>${infoMark(HELP, 'About emulator flags')}</div>
      <input id="emulator-flags-default" name="default" value="${escape(flags.default)}" placeholder="e.g. -no-snapshot -gpu swiftshader_indirect" autocomplete="off" spellcheck="false">
      ${avds.length ? `<div class="field-label-row"><label class="field-label" for="emulator-flags-device-0">Per device</label></div>${avds.map((avd, index) => `
      <label class="field-label" for="emulator-flags-device-${index}">${escape(avd.name)}</label>
      <input id="emulator-flags-device-${index}" data-emulator-flags-device="${escape(avd.udid)}" value="${escape(flags.devices[avd.udid] ?? '')}" placeholder="Same as the default" autocomplete="off" spellcheck="false">`).join('')}` : ''}
      <p class="field-help" role="alert" data-emulator-flags-error ${error ? '' : 'hidden'}>${escape(error)}</p>
      <div class="dialog-footer">
        <button type="button" class="secondary-button" data-action="close-dialog">Cancel</button>
        <button type="button" class="primary-button" data-emulator-flags-save ${saving ? 'disabled' : ''}>Save</button>
      </div>
    </form>`;
    host.querySelector<HTMLButtonElement>('[data-emulator-flags-save]')?.addEventListener('click', () => void save());
  };

  const save = async (): Promise<void> => {
    const form = host.querySelector<HTMLFormElement>('#emulator-flags-form');
    if (!form || saving) return;
    saving = true;
    const button = form.querySelector<HTMLButtonElement>('[data-emulator-flags-save]')!;
    button.disabled = true;
    const devices: Record<string, string> = {};
    for (const input of [...form.querySelectorAll<HTMLInputElement>('[data-emulator-flags-device]')]) devices[input.dataset.emulatorFlagsDevice!] = input.value;
    const defaultText = form.querySelector<HTMLInputElement>('#emulator-flags-default')!.value;
    // The draft becomes the drawn state, so a refused save keeps what was typed.
    flags = { default: defaultText, devices };
    try {
      await call('simulator_set_emulator_flags', { default: defaultText, devices });
      notify('Emulator flags saved');
      host.closest('dialog')?.close();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      saving = false;
      draw();
    }
  };

  void (async () => {
    try {
      const [saved, status] = await Promise.all([
        call<EmulatorFlags>('simulator_emulator_flags'),
        call<{ devices: SimDevice[] }>('simulator_status'),
      ]);
      flags = saved;
      avds = status.devices.filter(device => device.platform === 'android');
      draw();
    } catch (cause) {
      host.innerHTML = `<p class="field-help" role="alert">${escape(cause instanceof Error ? cause.message : String(cause))}</p>`;
    }
  })();
}
