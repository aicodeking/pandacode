import { validWebUiAction, type NativeWebUiAction } from './web-actions';
import { appearanceSnapshot, storeAppearance, validatedWallpaperAccentSeed } from './web-preferences';
import { palette } from './palette';
/** Native window broker. Network requests never construct or bypass Tauri IPC. */
export async function initializeWebNativeHost(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const [{ listen }, { invoke }] = await Promise.all([
    import('@tauri-apps/api/event'), import('@tauri-apps/api/core'),
  ]);
  const hostAppearance = () => ({ preferences: appearanceSnapshot(), wallpaperAccentSeed: validatedWallpaperAccentSeed(palette.wallpaperColor) ?? null });
  await listen<{ id: string; command: string; args: Record<string, unknown> }>('web-gateway-request', async ({ payload }) => {
    if (!payload || typeof payload.id !== 'string' || payload.id.length > 128 ||
        !/^[a-z][a-z0-9_]{0,96}$/.test(payload.command) || payload.command.startsWith('web_gateway_')) return;
    let result: unknown = null;
    let error: string | null = null;
    try {
      if (payload.command === 'web_ui_action') {
        if (!validWebUiAction(payload.args)) throw new Error('Invalid browser workspace action');
        const args = payload.args;
        result = await new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('Host action timed out; refresh the workspace before retrying.')), 40000);
          const detail: NativeWebUiAction = { args,
            resolve: value => { window.clearTimeout(timer); resolve(value); },
            reject: error => { window.clearTimeout(timer); reject(error); },
          };
          window.dispatchEvent(new CustomEvent('pandacode-web-ui-action', { detail }));
        });
      } else result = await invoke(payload.command, payload.args);
      if (result instanceof ArrayBuffer) {
        if (payload.command !== 'read_document_file' || result.byteLength > 8 * 1024 * 1024) throw new Error('Unsupported binary response');
        const bytes = new Uint8Array(result);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
        result = { __pandacode_web_binary__: btoa(binary) };
      }
      if (result === undefined) result = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Native command failed';
    }
    await invoke('web_gateway_resolve', { id: payload.id, result, error });
  });
  await listen<{ id: string; preferences: Record<string, string | null> }>('web-gateway-preferences', async ({ payload }) => {
    storeAppearance(payload.preferences);
    window.dispatchEvent(new Event('pandacode-appearance-reload'));
    await invoke('web_gateway_preferences_publish', { ...hostAppearance(), requestId: payload.id });
  });
  const publish = () => { void invoke('web_gateway_preferences_publish', { ...hostAppearance(), requestId: null }); };
  for (const name of ['pandacode-theme-change', 'pandacode-palette-change', 'pandacode-ui-scale-change', 'pandacode-wallpaper-change', 'pandacode-compact-change', 'storage']) window.addEventListener(name, publish);
  await invoke('web_gateway_preferences_publish', { ...hostAppearance(), requestId: null });
  window.addEventListener('pandacode-workspace-ready', () => {
    void invoke('web_gateway_preferences_publish', { ...hostAppearance(), requestId: null })
      .then(() => invoke('web_gateway_ready', { ready: true }));
  }, { once: true });
  window.addEventListener('pagehide', () => { void invoke('web_gateway_ready', { ready: false }); }, { once: true });
}
