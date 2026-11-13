import type { SkillHarness } from '../skill-manager-model';
import type { HarnessContribution } from './harnesses';
import { packageHarnesses } from './harnesses.ts';
import type { ExtensionSnapshot } from './manager';

/** Host discovery only, not authority to read files through the public extension API. */
export type DiscoveryRoot = { kind: 'skills' | 'rules' | 'config'; scope: 'user' | 'project'; path: string };
export const INSTALL_UNSUPPORTED = 'UnsupportedCapability: the pinned skills CLI has no reviewed adapter for this extension harness. Manage skills with its own tools.';
export const SYNC_UNSUPPORTED = 'UnsupportedCapability: extension harness configuration sync is not supported; PandaCode never writes its agent configuration.';
export function discoveryPath(id: string, kind: DiscoveryRoot['kind']): string {
  return `.panda-harnesses/${id}/${kind === 'config' ? 'settings.json' : kind}`;
}
export function validDiscoveryRoots(id: string, roots: DiscoveryRoot[]): boolean {
  return roots.length <= 6 && new Set(roots.map(root => `${root.scope}:${root.kind}`)).size === roots.length &&
    roots.every(root => root.path === discoveryPath(id, root.kind));
}
export function discoveryHarness(provider: Pick<HarnessContribution, 'id' | 'name' | 'discovery'>, installed: boolean): SkillHarness {
  return { id: provider.id, name: provider.name, installed, enforcement: 'asked', consoleEnforcement: 'none', installable: false,
    installReason: INSTALL_UNSUPPORTED, syncable: false, syncReason: SYNC_UNSUPPORTED, discovery: provider.discovery ?? [] };
}
export function packageDiscoveryHarnesses(snapshot: ExtensionSnapshot): SkillHarness[] {
  return packageHarnesses(snapshot).map(provider => {
    const owner = snapshot.packages.find(item => provider.id.startsWith(`${item.manifest.id}/`))!;
    const definition = (owner.manifest.contributes as typeof owner.manifest.contributes & { providers: HarnessContribution[] }).providers.find(item => item.id === provider.id)!;
    return discoveryHarness(definition, provider.installed);
  });
}
