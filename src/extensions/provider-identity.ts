import type { ExtensionProviderId, ProviderId } from '../types';

export const BUILTIN_PROVIDER_IDS = ['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'alibaba', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'zcode', 'hermes', 'cursor'] as const;
const extensionId = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/[a-z][a-zA-Z0-9._-]*$/;
/** Validation is independent of installation: uninstall must not invalidate saved history. */
export function parseProviderId(value: unknown): ProviderId | undefined {
  if (typeof value !== 'string') return;
  if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(value)) return value as ProviderId;
  if (value.length <= 200 && extensionId.exec(value)?.[0] === value && !value.startsWith('panda.')) return value as ExtensionProviderId;
}
export function providerOwner(value: string): string | undefined {
  return parseProviderId(value) && value.includes('/') ? value.split('/')[0] : undefined;
}
export const PROVIDER_RECOVERY = 'This extension provider is unavailable. History is preserved. Reinstall or enable its extension in Settings → Extensions, or change the provider using the model picker to continue.';
