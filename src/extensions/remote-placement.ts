/** Compatibility presentation only; native host revalidates installation/trust at execution. */
export const REMOTE_UNSUPPORTED = 'UnsupportedCapability: this remote host does not support extension API 1 workspace providers. History and core commands remain available. Run locally or update the host explicitly.';
export const REMOTE_MISSING = "MissingProvider: enable and explicitly trust this provider's workspace extension on the owning computer. No package or credentials are copied. History remains available.";
export function remoteProviderPlacement(peer: unknown, deviceId: string, provider: string): string | null {
  if (!peer || typeof peer !== 'object') return REMOTE_UNSUPPORTED;
  const value = peer as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 180 * 1024 || value.apiVersion !== 1 || value.deviceId !== deviceId
    || !Array.isArray(value.placements) || !value.placements.includes('workspace')
    || !Array.isArray(value.protocols) || !value.protocols.includes('conversation.v1')) return REMOTE_UNSUPPORTED;
  if (!Array.isArray(value.providers) || value.providers.length > 512 || !value.providers.some(entry => entry && typeof entry === 'object' && entry.id === provider && entry.apiVersion === 1)) return REMOTE_MISSING;
  return null;
}
