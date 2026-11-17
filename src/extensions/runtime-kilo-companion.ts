/** Kilo is independently negotiated; only its pinned V1 callback contract is shared. */
import { CompanionError, negotiateCompanion } from './runtime-companion-lifetime';
import type { CompanionProfile, InstalledCompanionApi } from './runtime-companion-lifetime';
import { opencodeInline, v1Hooks } from './runtime-opencode-companion';
export { v1Hooks as kiloHooks };
export const KILO_SOURCE = '37b2900fcb6223fec33c2bd5f59263e93682c670';
export function kiloProfile(installed: InstalledCompanionApi): CompanionProfile | null {
  return installed.harness === 'kilo' && installed.version === KILO_SOURCE
    ? { id: 'kilo.v1', harness: 'kilo', versions: [KILO_SOURCE], api: 'kilo.plugin.v1', protocol: 1, evidence: 'sourceFeasible' } : null;
}
export function kiloInline(installed: InstalledCompanionApi, fileUrl: string, pure: boolean, previous = '{}', entry: 'v1' | 'v2' = 'v1'): Record<string, string> {
  if (pure || entry !== 'v1' || negotiateCompanion(installed, kiloProfile(installed)).code) throw new CompanionError('UnsupportedCapability', 'UnsupportedCapability');
  const config: unknown = JSON.parse(previous);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new CompanionError('InvalidShape', 'Invalid inline configuration.');
  if (Object.hasOwn(config, 'plugins')) throw new CompanionError('UnsupportedCapability', 'Kilo does not accept plural plugins.');
  const inline = opencodeInline({ harness: 'opencode', version: 'v1.19.5', apis: ['opencode.plugin.v1'] }, fileUrl, false, previous);
  return { KILO_CONFIG_CONTENT: inline.OPENCODE_CONFIG_CONTENT };
}
