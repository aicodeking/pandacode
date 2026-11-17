/** Source-profile OpenCode configuration and hook semantics. Native code owns resources and credentials. */
import { CompanionError, negotiateCompanion } from './runtime-companion-lifetime';
import type { CompanionProfile, InstalledCompanionApi } from './runtime-companion-lifetime';
export type Generation = 'v1' | 'v2';
export const OPENCODE_V2_SOURCE = 'c5e741e787594e8c18fa70ab3a4705db1c927793';
export function opencodeProfile(installed: InstalledCompanionApi): CompanionProfile | null {
  if (installed.harness !== 'opencode') return null;
  const generation = installed.version === 'v1.19.5' ? 'v1' : installed.version === OPENCODE_V2_SOURCE ? 'v2' : null;
  return generation ? { id: `opencode.${generation}`, harness: 'opencode', versions: [installed.version!], api: `opencode.plugin.${generation}`, protocol: 1, evidence: 'sourceFeasible' } : null;
}
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export function opencodeInline(installed: InstalledCompanionApi, fileUrl: string, pure: boolean, previous = '{}'): Record<string, string> {
  const profile = opencodeProfile(installed);
  if (pure || negotiateCompanion(installed, profile).code) throw new CompanionError('UnsupportedCapability', 'UnsupportedCapability');
  const url = new URL(fileUrl);
  if (url.protocol !== 'file:' || url.search || url.hash || url.username || url.password || (url.hostname && url.hostname !== 'localhost')) throw new CompanionError('InvalidShape', 'A local file URL is required.');
  const generation: Generation = profile!.id.endsWith('v1') ? 'v1' : 'v2';
  if ((generation === 'v2') !== url.pathname.endsWith('/')) throw new CompanionError('UnsupportedCapability', 'V1 requires a file; V2 requires a directory package.');
  const config: unknown = JSON.parse(previous);
  if (!object(config)) throw new CompanionError('InvalidShape', 'Invalid inline configuration.');
  const key = generation === 'v1' ? 'plugin' : 'plugins';
  if (config[key] !== undefined && !Array.isArray(config[key])) throw new CompanionError('InvalidShape', 'Invalid plugin list.');
  if (generation === 'v2' && config.plugin !== undefined) throw new CompanionError('UnsupportedCapability', 'Normalize legacy inline plugins before injection.');
  config[key] = [...(config[key] as unknown[] ?? []), generation === 'v1' ? fileUrl : { package: fileUrl }];
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
export type Forward = (event: string, input: Obj) => Promise<Obj | null>;
/** Errors mean no decision; an explicit host denial is thrown outside this catch. */
export async function forwarded(forward: Forward, event: string, input: Obj): Promise<Obj | null> {
  try { const answer = await forward(event, input); return object(answer) ? answer : null; } catch { return null; }
}
export function rewriteInPlace(target: Obj, replacement: Obj): void {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(replacement)) Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
export function v1Hooks(forward: Forward) {
  return {
    async 'tool.execute.before'(input: Obj, output: { args: Obj }): Promise<void> {
      const answer = await forwarded(forward, 'tool.before', { ...input, tool_input: output.args });
      if (answer?.decision === 'deny') throw new Error(String(answer.reason ?? 'Declined by an extension.'));
      if (answer?.decision === 'rewrite' && object(answer.input)) rewriteInPlace(output.args, answer.input);
    },
    async 'tool.execute.after'(input: Obj, output: Obj): Promise<void> {
      const answer = await forwarded(forward, 'tool.after', { ...input, tool_response: output });
      if (object(answer?.output)) for (const key of ['title', 'output', 'metadata']) if (Object.hasOwn(answer.output, key)) output[key] = answer.output[key];
    },
  };
}
export function v2Hooks(forward: Forward) {
  return {
    async before(event: Obj): Promise<void> {
      const answer = await forwarded(forward, 'tool.before', { ...event, tool_input: event.input });
      if (answer?.decision === 'deny') throw new Error(String(answer.reason ?? 'Declined by an extension.'));
      if (answer?.decision === 'rewrite' && object(answer.input)) event.input = answer.input;
    },
    async after(event: Obj): Promise<void> {
      const answer = await forwarded(forward, 'tool.after', { ...event, tool_response: event.result });
      if (event.status === 'completed' && object(answer?.output)) event.result = answer.output;
    },
    async permission(event: Obj): Promise<void> {
      if (event.effect === 'deny') return;
      const answer = await forwarded(forward, 'permission', { ...event });
      if (answer?.decision === 'deny') { event.effect = 'deny'; event.message = answer.reason; }
      else if (answer?.decision === 'approve') event.effect = 'allow';
    },
  };
}
