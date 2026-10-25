import './model-picker.css';
import './overlay-model-picker.css';
import { openModelPicker } from './model-picker';
import { t } from './i18n.ts';
import { nativeOverlay, overlayCall, type LaunchContext } from './overlay-client';
import type { Provider, ProviderId, ProviderModel } from './types';

let discovery: Promise<Provider[]> | undefined;
let discoveredAt = 0;
const catalogs = new Map<ProviderId, {time: number; promise: Promise<ProviderModel[]>}>();
let watching: Promise<unknown> | undefined;
function watchModelPreferences(): Promise<unknown> {
  return watching ??= (async () => {
    const invalidate = () => { catalogs.delete('opencode'); discovery = undefined; };
    if (nativeOverlay) {
      await (await import('@tauri-apps/api/event')).listen<{provider:string}>('provider-models-changed', event => { if (event.payload.provider === 'opencode') invalidate(); });
    } else {
      window.addEventListener('storage', event => { if (event.key === 'pandacode.preview.opencode-models') invalidate(); });
      window.addEventListener('pandacode-preview-models-changed', invalidate);
    }
  })().catch(error => { watching = undefined; throw error; });
}

/** Catalogs use the same native discovery as the workspace, only when requested. */
async function providers(): Promise<Provider[]> {
  if (!discovery || Date.now() - discoveredAt > 60_000) {
    discoveredAt = Date.now();
    discovery = overlayCall<Provider[]>('list_providers').catch(error => { discovery = undefined; throw error; });
  }
  return discovery;
}
export async function openOverlayModelPicker(options: {
  anchor: HTMLElement;
  current: LaunchContext;
  valid: () => boolean;
  select: (provider: ProviderId, model: string) => Promise<void>;
  catalog: (provider: ProviderId, models: ProviderModel[]) => void;
  close: () => void;
}): Promise<(() => void) | undefined> {
  await watchModelPreferences();
  const available = await providers();
  if (!options.valid()) return;
  available.forEach(provider => options.catalog(provider.id,provider.models));
  if (!available.length) throw new Error(t('No harnesses found. Check your agent connections in PandaCode.'));
  // Native discovery lists a saved OpenCode selection as its models; with none, shorten the full catalog.
  const openCodeSaved = (available.find(provider => provider.id === 'opencode')?.models.length ?? 0) > 1;
  return openModelPicker({
    recent: provider => provider === 'opencode' && !openCodeSaved ? [] : null,
    anchor:options.anchor, providers:available, current:{...options.current,provider:options.current.provider as ProviderId},
    canSwitchProvider:true, placement:'below', onSelect:options.select, onClose:options.close,
    loadModels: async provider => {
      let cached = catalogs.get(provider);
      if (!cached || Date.now() - cached.time > 60_000) {
        const promise = overlayCall<ProviderModel[]>('list_provider_models', {provider}).catch(error => { catalogs.delete(provider); throw error; });
        cached = {time:Date.now(),promise}; catalogs.set(provider,cached);
      }
      const models = await cached.promise;
      if (options.valid()) options.catalog(provider,models);
      return models;
    },
  });
}
