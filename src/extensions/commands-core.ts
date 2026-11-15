/** JSON-only captured admission for the composer slash menu and the harness command center, and the pure rules for
 * package slash commands (arguments, conflicts). Typing and resolving a command, the draft, Send and the command
 * center's own panels stay in the host. */
import { validateContract } from './contracts.ts';
import { SLASH_ENTRIES, HARNESS_ENTRIES, COMMANDS_PINNED, COMMANDS_PROTECTED, SLASH_LOCATION, HARNESS_LOCATION, SLASH_PACKAGE_LOCATION, COMMANDS_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured command control ids (`commandsControlId`). */
export const COMMANDS_CONTROL_IDS = ['harness-open', 'harness-refresh', 'harness-close'] as const;
export type CommandsControl = typeof COMMANDS_CONTROL_IDS[number];
export type CommandsPanel = 'none' | 'goal' | 'usage' | 'hooks' | 'preferences' | 'imports' | 'conversations' | 'plugins' | 'jobs';
/** `task` is the composer's task, `provider` its harness (opaque handles); `menu` whether the slash menu is open, `panel`
 * the open command center's panel and `slash` how many package slash commands the menu offers. Never the draft text,
 * command names typed so far, panel contents or the harness's catalog. */
export type CommandsPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; provider: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean; menu: boolean; panel: CommandsPanel; slash: number;
  controls: readonly Readonly<{ id: string; controlId: CommandsControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type CommandsAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; provider: string; revision: number; control: string; controlId: CommandsControl; resource: string; requestId: string }>;
export type CommandsAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type CommandsAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Opening a harness command replaces whatever the shared dialog shows, so it runs the original handler only after a
 * fresh host user choice. Refresh and Done act on the command center the user already opened. */
export const COMMANDS_CHOICE_CONTROLS: readonly string[] = ['harness-open'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check of the
 * request's shape. Nothing writes the draft, reads it, sends it, changes a panel's state or opens a console. */
export const COMMANDS_PROTECTED_CONTROLS = ['slash-send', 'slash-insert', 'slash-read-draft', 'harness-execute', 'console-open'] as const;

/** One explicit entry per ledger member this adapter owns (`panda.commands.harness`, `panda.commands.slash`). */
export type CommandsRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const protectedReason = (...ids: string[]) => COMMANDS_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
export const COMMANDS_REGISTRY: readonly CommandsRegistryEntry[] = Object.freeze([
  { member: 'panda.commands.harness', source: 'src/command-center.ts', locations: ['panda.commands.harness.actions', HARNESS_LOCATION, COMMANDS_PROTECTED_LOCATION], controls: HARNESS_ENTRIES.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.commands.harness.actions', selection: 'harness-command', reason: `The harness entries that open the command center hide and reorder in the slash menu (typing one still opens its panel); contributed actions in the command center capture its task, harness and panel. Opening a panel for a package needs a fresh host choice. ${protectedReason('panel-actions', 'console')}` },
  { member: 'panda.commands.slash', source: 'src/main.ts', locations: [SLASH_PACKAGE_LOCATION, SLASH_LOCATION, COMMANDS_PROTECTED_LOCATION], controls: SLASH_ENTRIES.map(([id]) => id), order: true, hide: true, actions: true, context: SLASH_PACKAGE_LOCATION, selection: 'slash-command', reason: `help: ${COMMANDS_PINNED[`${SLASH_LOCATION}/help`]} A package slash command runs its package command with the captured task, harness and arguments. ${protectedReason('draft', 'send', 'resolve')}` },
].map(entry => Object.freeze(entry)));

/** A package slash command as the slash menu shows it, and the rules for running it. */
export type SlashDeclaration = { id: string; name: string; description: string; command?: string; provider?: string; arguments?: { hint?: string; required: boolean; maxLength: number } };
export type SlashEntry = { id: string; name: string; description: string; argumentHint?: string; kind: 'action' | 'unsupported'; source: string; reason?: string };
/** A conflict keeps PandaCode's and the harness's own names, and a name two packages declare runs neither. */
export function packageSlashEntries(packages: readonly { id: string; commands: readonly SlashDeclaration[] }[], taken: ReadonlySet<string>): { entry: SlashEntry; declaration?: SlashDeclaration; owner: string }[] {
  const declared = packages.flatMap(item => item.commands.filter(command => command.command).map(declaration => ({ owner: item.id, declaration })));
  const counts = new Map<string, number>(); for (const { declaration } of declared) counts.set(declaration.name, (counts.get(declaration.name) ?? 0) + 1);
  return declared.map(({ owner, declaration }) => {
    const base = { id: declaration.id, name: declaration.name, description: declaration.description, ...(declaration.arguments?.hint ? { argumentHint: declaration.arguments.hint } : {}), source: owner };
    if (taken.has(declaration.name)) return { owner, entry: { ...base, kind: 'unsupported' as const, reason: `Conflict: ${declaration.name} is PandaCode's or this harness's own command, which keeps the name. Edit the name or disable ${owner}.` } };
    if ((counts.get(declaration.name) ?? 0) > 1) return { owner, entry: { ...base, kind: 'unsupported' as const, reason: `Conflict: more than one extension declares ${declaration.name}, so none of them runs. Disable one of them.` } };
    return { owner, declaration, entry: { ...base, kind: 'action' as const } };
  });
}
/** The text after a package command's name, checked against its declared argument schema. */
export function slashArguments(declaration: SlashDeclaration, text: string): { ok: true; arguments: string } | { ok: false; reason: string } {
  const match = /^\s*(\/[^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || match[1] !== declaration.name) return { ok: false, reason: `Type ${declaration.name} first.` };
  const value = (match[2] ?? '').trim();
  if (!declaration.arguments) return value ? { ok: false, reason: `${declaration.name} does not accept arguments. Remove them and send again.` } : { ok: true, arguments: '' };
  if (declaration.arguments.required && !value) return { ok: false, reason: `${declaration.name} needs ${declaration.arguments.hint ?? 'arguments'}. Add them and send again.` };
  if ([...value].length > declaration.arguments.maxLength) return { ok: false, reason: `${declaration.name} accepts at most ${declaration.arguments.maxLength} characters of arguments.` };
  return { ok: true, arguments: value };
}

const CAPTURED = ['window', 'context', 'project', 'task', 'provider', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotCommands(props: CommandsPresentation): CommandsPresentation {
  if (!validateContract('commandsPresentation', props).ok) throw Error('Invalid commands presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate commands handle');
  return freeze(structuredClone(props));
}
export function createCommandsControls(props: CommandsPresentation, owner: string, current: () => CommandsPresentation, authority: () => CommandsAuthority, dispatch: (action: CommandsAction) => void, applied = new Set<string>()) {
  const captured = snapshotCommands(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): CommandsAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((COMMANDS_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('commandsAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as CommandsAction, live = current();
    // Another task, harness, edited draft, opened or closed panel or redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open slash menu, another dialog or a pending host choice keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (COMMANDS_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
