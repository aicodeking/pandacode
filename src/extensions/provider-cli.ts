import { parseProviderId, providerOwner } from './provider-identity';

export const CONSOLE_UNSUPPORTED = 'UnsupportedCapability: this provider has no core-managed interactive console. Continue in PandaCode task chat.';
export const SLASH_UNSUPPORTED = 'UnsupportedCapability: extension-native slash commands are not supported. Use PandaCode controls or task chat.';
/** UI feedback only: native terminal admission independently enforces this policy. */
export function requireProviderConsole(id: string): void {
  if (!parseProviderId(id)) throw new Error('Unknown provider.');
  if (providerOwner(id) || ['antigravity', 'deepseek', 'commandcode', 'kilo', 'zcode'].includes(id)) throw new Error(CONSOLE_UNSUPPORTED);
}
