import type { Provider } from '../types';
import { parseProviderId } from './provider-identity.ts';
import type { ExtensionSnapshot } from './manager';
import { defaultProviderMetadata, type ProviderMetadata } from './provider-state.ts';
import type { DiscoveryRoot } from './provider-discovery.ts';

export type HarnessContribution = { apiVersion: 1; id: string; name: string; metadata?: ProviderMetadata; discovery?: DiscoveryRoot[]; models: { id: string; name: string; efforts: string[]; contextWindow?: number }[] };
/** Catalog metadata only. The native host separately admits executable content. */
export function packageHarnesses(snapshot: ExtensionSnapshot, placement: 'desktop' | 'workspace' = 'desktop'): Provider[] {
  if (snapshot.safeMode) return [];
  return snapshot.packages.filter(item => item.enabled && !item.update?.draining && item.executable?.trusted && (placement === 'desktop' || ['workspace', 'split'].includes(String(item.manifest.extensionKind)))).flatMap(item => {
    const contributions = item.manifest.contributes as typeof item.manifest.contributes & { providers?: HarnessContribution[] };
    return (contributions.providers ?? []).map(provider => ({
      id: parseProviderId(provider.id)!, name: provider.name, installed: (provider.metadata?.readiness.state ?? 'ready') === 'ready', path: null, version: item.manifest.version,
      metadata: provider.metadata ?? defaultProviderMetadata(),
      models: provider.models.map(model => ({ id: model.id, name: model.name, description: '', reasoningEfforts: model.efforts.map(id => ({ id, name: id, description: '' })), defaultReasoningEffort: null, contextWindow: model.contextWindow ?? null })),
    }));
  });
}
