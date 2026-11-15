/** Host-only bindings for the composer slash menu and the harness command center: the user's order and reversible
 * visibility of PandaCode's slash entries and of the harness entries that open the command center, package slash
 * commands (`contributes.slashCommands`) run as their package command with the captured task, harness and arguments,
 * contributed command center actions with the captured task, harness and panel, and captured actions that run the
 * original handlers. The draft, Send, resolving a typed command and the command center's panels never cross the
 * package boundary. */
import { openChoiceMenu } from '../choice-menu';
import type { Json } from './contracts';
import { createCommandsControls, packageSlashEntries, slashArguments, snapshotCommands, COMMANDS_CHOICE_CONTROLS, type CommandsAction, type CommandsControl, type CommandsPanel, type CommandsPresentation, type SlashDeclaration } from './commands-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import { invokeExtensionCommand } from './commands';
import { COMMANDS_PINNED, HARNESS_ENTRIES, HARNESS_LOCATION, SLASH_ENTRIES, SLASH_LOCATION } from './surfaces';

/** What the slash menu lists: the shape slash-commands.ts renders. */
type Command = { id: string; name: string; description: string; argumentHint?: string; kind: 'prompt' | 'action' | 'unsupported'; source: string; reason?: string };
type Catalog = { commands: Command[]; warnings: string[] };
/** `task` is the composer's task, `provider` its harness, `panel` the command center panel open for it ('none'
 * otherwise). The draft text never leaves this module: only its digest enters the revision. */
export type CommandsHostState = { task?: string; project?: string; provider?: string; panel: CommandsPanel; draft: string; busy: boolean; generation: number };
type Control = { id: string; controlId: CommandsControl; resource: string; enabled: boolean; hidden: boolean };

const digest = (text: string) => { let hash = 0; for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0; return `${text.length}:${hash}`; };
const shown = (element: Element) => element.getClientRects().length > 0;
const SLASH_IDS = new Map<string, string>(SLASH_ENTRIES.map(([id, name]) => [name, id]));
const HARNESS_IDS = new Map<string, string>(HARNESS_ENTRIES.map(([id, name]) => [name, id]));
const HOST_NAMES: ReadonlySet<string> = new Set(SLASH_ENTRIES.map(([, name]) => name));

export function mountCommandsAdoption(options: {
  state: () => CommandsHostState;
  /** The command center's own panels (main.ts `openCommandPanel` / `openGoal`), run after a fresh host choice. */
  openPanel: (task: string, panel: CommandsPanel) => void;
  /** Reloads the slash menu after the user's arrangement or the packages change. */
  refresh: () => void;
  notify: (message: string) => void;
}) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  /** The names each task's last catalog listed (PandaCode's and the harness's own), for conflicts at send. */
  const taken = new Map<string, Set<string>>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const enabled = () => safe() ? [] : extensionsSnapshot().packages.filter(item => item.enabled);
  const contributes = (location: string) => enabled().some(item => item.manifest.contributes.menus?.some(menu => menu.location === location));
  const declarations = () => enabled().map(item => ({ id: item.manifest.id, commands: (item.manifest.contributes.slashCommands ?? []) as SlashDeclaration[] })).filter(item => item.commands.some(command => command.command));
  const arranged = (location: string, local: readonly string[]) => {
    const ids = local.map(id => `${location}/${id}`);
    return ids.some(id => !COMMANDS_PINNED[id] && layout.isHidden(id, layoutProject())) || orderedControls(location, ids).some((id, index) => id !== ids[index]);
  };
  /** The adapter touches the slash menu only when a package declares a slash command or the user arranged its entries;
   * otherwise, and in safe mode, the menu lists exactly what the host and the harness return. */
  const slashEngaged = () => !safe() && (enabled().some(item => item.manifest.contributes.slashCommands?.length) || arranged(SLASH_LOCATION, SLASH_ENTRIES.map(([id]) => id)) || arranged(HARNESS_LOCATION, HARNESS_ENTRIES.map(([id]) => id)));

  /** One group's entries in the user's order, in the group's own places; hidden ones leave the list (typing still runs
   * them). Pinned entries never hide. */
  function arrange(commands: Command[], location: string, ids: ReadonlyMap<string, string>, member: (command: Command) => boolean): Command[] {
    const slots = commands.map((command, index) => member(command) && ids.has(command.name) ? index : -1).filter(index => index >= 0);
    const present = slots.map(index => `${location}/${ids.get(commands[index].name)}`);
    const order = orderedControls(location, present), byId = new Map(slots.map((index, offset) => [present[offset], commands[index]]));
    const next = [...commands];
    slots.forEach((index, offset) => { next[index] = byId.get(order[offset])!; });
    return next.filter(command => !(member(command) && ids.has(command.name)) || COMMANDS_PINNED[`${location}/${ids.get(command.name)}`] || !layout.isHidden(`${location}/${ids.get(command.name)}`, layoutProject()));
  }
  /** The slash menu's catalog for a task: unchanged unless engaged; otherwise arranged, with package entries after it. */
  function slashCatalog<T extends Catalog>(catalog: T, task: string): T {
    taken.set(task, new Set(catalog.commands.map(command => command.name)));
    if (!slashEngaged()) return catalog;
    let commands = arrange(catalog.commands, SLASH_LOCATION, SLASH_IDS, command => command.source === 'PandaCode');
    commands = arrange(commands, HARNESS_LOCATION, HARNESS_IDS, () => true);
    // A provider package's advertised commands carry their declaration's id: the user can hide them too.
    const declared = new Set(enabled().flatMap(item => (item.manifest.contributes.slashCommands ?? []).map(slash => slash.id)));
    commands = commands.filter(command => !declared.has(command.id) || !layout.isHidden(command.id, layoutProject()));
    const packages = packageSlashEntries(declarations(), new Set([...taken.get(task)!, ...HOST_NAMES])).filter(({ entry }) => !layout.isHidden(entry.id, layoutProject()));
    return { ...catalog, commands: [...commands, ...packages.map(({ entry }) => entry)] } as T;
  }
  /** The package slash command a sent draft names, if it may run: enabled, declared once and not PandaCode's or the
   * harness's own name. */
  function slashCommand(text: string, task: string): SlashDeclaration | undefined {
    if (safe()) return;
    const name = /^\s*(\/[^\s]+)/.exec(text)?.[1]; if (!name) return;
    return packageSlashEntries(declarations(), new Set([...taken.get(task) ?? [], ...HOST_NAMES])).find(({ entry, declaration }) => declaration && entry.name === name)?.declaration;
  }
  /** Runs a package slash command's package command once, with the captured task, harness, revision and arguments.
   * Nothing is inserted into the draft or sent to the harness; a refusal leaves the draft as typed. */
  function runSlash(declaration: SlashDeclaration, text: string): { ok: true } | { ok: false; reason: string } {
    const state = options.state(); if (!state.task) return { ok: false, reason: 'Open a task to run this command.' };
    const parsed = slashArguments(declaration, text); if (!parsed.ok) return parsed;
    const captured: Record<string, Json> = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands.slash', ...(state.project ? { projectId: state.project } : {}), sessionId: state.task, revision: state.generation, selection: { kind: 'slash-command', ids: [state.task] }, slash: { command: declaration.id, provider: state.provider ?? '', arguments: parsed.arguments } };
    try { if (invokeExtensionCommand(declaration.command!, captured, options.notify)) return { ok: true }; }
    catch { /* A faulted activation runs nothing; the draft stays. */ }
    return { ok: false, reason: `${declaration.name} is not available right now. Its extension may be disabled or faulted; the draft is unchanged.` };
  }

  /** The command center's contributed actions: none unless a package contributes, so the panel keeps its markup. */
  function centerExtension(target: { task: string; project?: string; provider: string; panel: CommandsPanel; revision: number }): { mount(footer: HTMLElement): () => void } | undefined {
    if (!contributes('panda.commands.harness.actions')) return;
    const captured: Record<string, Json> = { ...(target.project ? { projectId: target.project } : {}), sessionId: target.task, revision: target.revision, selection: { kind: 'harness-command', ids: [`${target.provider}:${target.panel}`] } };
    return { mount(footer) {
      const host = document.createElement('div'); host.className = 'command-center-extensions'; footer.prepend(host);
      const dispose = mountExtensionActions(host, 'panda.commands.harness.actions', () => captured, options.notify);
      return () => { dispose(); host.remove(); };
    } };
  }

  function authority() {
    const provider = componentSelection.resolve('panda.composer', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    const composer = document.querySelector<HTMLElement>('#composer');
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && composer?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }
  const center = () => document.querySelector<HTMLElement>('#dialog.command-center-dialog[open] .command-center-footer');
  function presentation(): CommandsPresentation {
    const state = options.state(), auth = authority(), task = state.task ?? '', panel = task ? state.panel : 'none';
    finders.clear();
    const controls: Control[] = [];
    const add = (key: string, controlId: CommandsControl, resource: string, find: () => HTMLElement | null, hidden = false) => {
      const element = find(); if (find !== none && !element) return;
      finders.set(key, find); controls.push({ id: key, controlId, resource, enabled: !(element as HTMLButtonElement | null)?.disabled, hidden: hidden || Boolean(element && (element.closest('[data-layout-hidden], [hidden]') || !shown(element))) });
    };
    if (task) {
      // A harness entry the user hid from the slash menu is not acted on for a package either.
      const names = taken.get(task) ?? new Set<string>();
      for (const [id, name, kind] of HARNESS_ENTRIES) if (names.has(name)) add(handle(`open:${task}:${id}`), 'harness-open', handle(`panel:${task}:${kind}`), none, !safe() && layout.isHidden(`${HARNESS_LOCATION}/${id}`, layoutProject()));
      if (panel !== 'none') {
        add(handle(`refresh:${task}:${panel}`), 'harness-refresh', handle(`panel:${task}:${panel}`), () => center()?.querySelector<HTMLElement>(':scope > button.secondary-button') ?? null);
        add(handle(`close:${task}:${panel}`), 'harness-close', handle(`panel:${task}:${panel}`), () => center()?.querySelector<HTMLElement>(':scope > button.primary-button') ?? null);
      }
    }
    const composer = document.querySelector<HTMLElement>('#composer'), menu = [...document.querySelectorAll('.slash-menu')].some(shown);
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: task && state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '', provider: task && state.provider ? handle(`provider:${state.provider}`) : '',
      revision: 0, visible: !disposed && Boolean(task && (composer && shown(composer) || center())),
      // An open slash menu (the user is typing), another dialog, menu or host choice holds input.
      busy: choosing || menu || state.busy || Boolean(document.querySelector('dialog[open]:not(#dialog), .model-menu, .choice-menu')),
      safeMode: extensionsSnapshot().safeMode, menu, panel, slash: Math.min(32, safe() ? 0 : packageSlashEntries(declarations(), new Set([...taken.get(task) ?? [], ...HOST_NAMES])).filter(({ declaration }) => declaration).length),
      controls: controls.slice(0, 64), truncated: controls.length > 64,
    };
    const next = JSON.stringify([value, digest(state.draft), auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotCommands({ ...value, revision });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createCommandsControls(presentation(), owner, presentation, authority, (action: CommandsAction) => {
      if (!COMMANDS_CHOICE_CONTROLS.includes(action.controlId)) { finders.get(action.control)?.()?.click(); return; }
      const state = options.state(), task = state.task!, entry = HARNESS_ENTRIES.find(([id]) => handle(`open:${task}:${id}`) === action.control);
      if (!entry) return;
      const [, name, kind, label] = entry, held = identity, anchor = document.querySelector<HTMLElement>('#prompt') ?? document.body;
      choosing = true; closeChoice?.();
      // The choice opens the same panel for the same task it was asked for; Escape declines and nothing opens.
      closeChoice = openChoiceMenu({ anchor, title: 'Extension requested a harness command', items: [{ id: 'continue', label: `Continue: Open ${label} (${name})`, icon: 'command' }], onSelect: id => {
        if (id !== 'continue') return;
        const live = options.state();
        if (live.task !== task || held !== identity || !authority().active) return;
        closeChoice?.(); options.openPanel(task, kind);
      }, onClose: () => { choosing = false; closeChoice = undefined; } });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  /** The slash menu reloads only while the adapter is or was engaged: with zero extensions it is never touched. */
  let engaged = false;
  function changed() { if (disposed) return; const now = slashEngaged(); if (now || engaged) options.refresh(); engaged = now; }
  const stopExtensions = onExtensionsChanged(changed), stopLayout = layout.subscribe(changed);
  const watchProject = () => { if (layoutProject() !== lastProject) { lastProject = layoutProject(); changed(); } };
  window.addEventListener('pandacode-components-change', changed);
  // After main.ts holds the adoption: the slash menu reads its catalog through it.
  queueMicrotask(changed);
  return {
    slashCatalog, slashCommand, runSlash, centerExtension, presentation, dispatch, watchProject,
    dispose() {
      if (disposed) return;
      closeChoice?.(); stopExtensions(); stopLayout(); window.removeEventListener('pandacode-components-change', changed);
      disposed = true; if (engaged) options.refresh();
    },
  };
}
/** A control whose node is the host's own menu entry rather than a button on screen. */
function none(): HTMLElement | null { return null; }
