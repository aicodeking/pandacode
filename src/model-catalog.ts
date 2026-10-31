import type { ContextUsage, ProviderId, ProviderModel } from './types';

/** Unknown IDs stay literal; never infer a version from a moving alias. */
export function fallbackModel(provider: ProviderId, id = 'default'): ProviderModel {
  id ||= 'default';
  if (id === 'default' && provider === 'glm') return { id, name: 'GLM-5.3', description: 'Default Z.AI Coding Plan model via Claude Code.' };
  if (id === 'default' && provider === 'mimo') return { id, name: 'MiMo-V2.6-Pro', description: 'Default MiMo Token Plan model via Claude Code.' };
  if (id === 'default') return { id, name: 'Default', description: 'Uses the model selected by your harness.' };
  const alias = provider === 'claude' ? ({ sonnet: 'Claude Sonnet', opus: 'Claude Opus', haiku: 'Claude Haiku' } as Record<string, string>)[id] : '';
  return { id, name: alias || id, description: alias ? 'Version resolved by Claude Code.' : '' };
}

/** Harnesses that accept only the model IDs they advertise: no custom IDs. */
export function advertisedModelsOnly(provider: ProviderId): boolean {
  return provider === 'github-copilot' || provider === 'devin';
}

export function modelChoices(provider: ProviderId, catalog: ProviderModel[], current = ''): ProviderModel[] {
  const models = new Map<string, ProviderModel>([['default', fallbackModel(provider)]]);
  for (const model of catalog) if (model.id) models.set(model.id, model);
  if (current && !models.has(current)) models.set(current, fallbackModel(provider, current));
  return [...models.values()];
}

export function tokenCount(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function contextSummary(usage?: ContextUsage | null, capacity?: number | null): { label: string; detail: string } | null {
  const window = usage?.contextWindow ?? capacity;
  if (usage) {
    const used = tokenCount(usage.usedTokens);
    return window
      ? { label: `${used} / ${tokenCount(window)} context`, detail: `${usage.usedTokens.toLocaleString()} of ${window.toLocaleString()} context tokens (${Math.round(usage.usedTokens / window * 100)}%). Last reported by the harness.` }
      : { label: `${used} tokens in context`, detail: `${usage.usedTokens.toLocaleString()} context tokens. Last reported by the harness; total capacity is unavailable.` };
  }
  return window ? { label: `${tokenCount(window)} context`, detail: `${window.toLocaleString()} token context window reported by the harness.` } : null;
}

export function parseContextUsage(value: unknown): ContextUsage | null {
  if (!value || typeof value !== 'object') return null;
  const { usedTokens, contextWindow } = value as Record<string, unknown>;
  if (typeof usedTokens !== 'number' || !Number.isSafeInteger(usedTokens) || usedTokens < 0 || usedTokens > 1_000_000_000) return null;
  if (contextWindow != null && (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0 || contextWindow > 1_000_000_000)) return null;
  return { usedTokens, contextWindow: (contextWindow as number | null) ?? null };
}
