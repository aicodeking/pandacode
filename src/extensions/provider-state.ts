import type { Mode, Provider, ProviderId } from '../types';

/** Public catalog data only: never a credential, executable path or an execution grant. */
export interface ProviderMetadata {
  modes: Exclude<Mode, 'review'>[];
  authentication: string;
  /** Opt-in role-scoped core team tools; not permission to start a team. */
  teams?: boolean;
  readiness: { state: 'ready' | 'signedOut' | 'unavailable'; reason: string };
  icon?: string;
  usage: { context: boolean; limitsReason: string };
}
export const UNAVAILABLE_PROVIDER = 'This extension provider is unavailable. Enable or reinstall its extension in Settings → Extensions, or choose another provider.';
const providers = new Map<ProviderId, Provider>();
export function setPackageProviders(values: Provider[]): void {
  providers.clear();
  for (const provider of values) providers.set(provider.id, provider);
}
export function packageProvider(id: ProviderId): Provider | undefined { return providers.get(id); }
/** ZCode's built-in protocol has no team-tools bridge. Dynamic adapters must opt in. */
export function providerSupportsTeams(provider: Pick<Provider, 'id' | 'metadata'>): boolean {
  return provider.id.includes('/') ? provider.metadata?.teams === true : provider.id !== 'zcode';
}
export function defaultProviderMetadata(): ProviderMetadata {
  return { modes: ['ask'], authentication: 'Authentication is managed by the trusted extension; no credentials are returned to PandaCode.', readiness: { state: 'ready', reason: 'Ready through its trusted extension.' }, usage: { context: false, limitsReason: 'This extension does not expose account limits. Check its provider dashboard.' } };
}
