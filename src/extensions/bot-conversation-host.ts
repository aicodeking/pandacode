/** Host-only bindings for a bot thread's header and welcome and a shared channel's conversation controls: an action slot
 * after the header breadcrumb for each view (mounted only while a package contributes to it, with the captured bot,
 * conversation or channel), the user's order and reversible visibility of the eligible controls (drawn by bot-thread.ts
 * and bot-shared-channels.ts), and captured actions that run the original handlers. Names, message text, the draft,
 * settings and credentials never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import type { Json } from './contracts';
import { createBotConversationControls, snapshotBotConversation, BOT_CONVERSATION_CHOICE_CONTROLS, type BotConversationAction, type BotConversationControl, type BotConversationPresentation, type BotConversationView } from './bot-conversation-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import { BOT_CHANNEL_CONTROLS, BOT_CHANNEL_LOCATION, BOT_CONVERSATION_ACTION_SURFACES, BOT_CONVERSATION_FIXED, BOT_CONVERSATION_PINNED, BOT_THREAD_CONTROLS, BOT_THREAD_LOCATION, type BotConversationActionLocation, type BotConversationLayout } from './surfaces';

/** What main.ts knows about the open conversation. Raw ids become opaque handles here; `botName` and `channelName` are
 * the host's own words for the fresh choice and never reach a package. `detail` is an opaque digest of the channel's
 * messages and work, so a refreshed channel is another revision. */
export type BotConversationHostState = {
  view: BotConversationView; project?: string; bot?: string; botName?: string; paused?: boolean; session?: string;
  channel?: string; channelName?: string; detail?: string; busy: boolean; generation: number;
};
type Control = { id: string; controlId: BotConversationControl; resource: string; enabled: boolean; hidden: boolean };

const shown = (element: Element) => element.getClientRects().length > 0;
/** Order-sensitive digest: a suggestion's text changes its resource without the text leaving the host. */
const digest = (text: string) => { let hash = 0; for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0; return `${text.length}:${hash}`; };
const TABS: Readonly<Record<string, string>> = { profile: 'Instructions', memory: 'Memory', schedules: 'Schedules', channels: 'Connections' };

export function mountBotConversationAdoption(options: {
  /** The workspace header's breadcrumb: each view's action slot follows it. */
  breadcrumb: HTMLElement;
  /** The transcript (a bot's welcome, a channel's header and history) and the composer area (a channel's controls). */
  transcript: HTMLElement; area: HTMLElement;
  state: () => BotConversationHostState;
  onContextChanged: (listener: () => void) => () => void;
  /** Redraws the open bot thread or channel through the original renderers. */
  rerender: () => void;
  notify: (message: string) => void;
}) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  const mounts = new Map<BotConversationActionLocation, { host: HTMLElement; dispose: () => void }>();
  const builtIn = JSON.stringify([null, null]);
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, arranged = builtIn, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const contributes = (location: BotConversationActionLocation) => !safe() && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));

  /** The user's arrangement of one view's controls, or undefined while it is the built-in one (and in safe mode), so
   * the zero-extension header, welcome and channel controls draw exactly as before. */
  function arrangement(location: string, controls: readonly (readonly [string, string])[]): BotConversationLayout | undefined {
    if (safe()) return undefined;
    const ids = controls.map(([id]) => `${location}/${id}`), movable = ids.filter(id => !BOT_CONVERSATION_FIXED[id]);
    const order = orderedControls(location, movable), hidden = ids.filter(id => !BOT_CONVERSATION_PINNED[id] && layout.isHidden(id, layoutProject()));
    if (!hidden.length && order.every((id, index) => id === movable[index])) return undefined;
    const local = (id: string) => id.slice(location.length + 1);
    return { order: order.map(local), hidden: hidden.map(local) };
  }
  const threadLayout = () => arrangement(BOT_THREAD_LOCATION, BOT_THREAD_CONTROLS);
  const channelLayout = () => arrangement(BOT_CHANNEL_LOCATION, BOT_CHANNEL_CONTROLS);

  /** Captured at each click by the shared action renderer: the open bot and its conversation, or the open channel. */
  function captured(location: BotConversationActionLocation): Record<string, Json> {
    const state = options.state();
    if (location === 'panda.bot.thread.actions' && state.view === 'bot-thread' && state.bot) return { ...(state.project ? { projectId: state.project } : {}), ...(state.session ? { sessionId: state.session } : {}), revision: state.generation, selection: { kind: 'bot', ids: [state.bot] } };
    if (location === 'panda.bot.channel.actions' && state.view === 'channel' && state.channel) return { revision: state.generation, selection: { kind: 'channel', ids: [state.channel] } };
    return { revision: state.generation };
  }
  /** Each slot follows the breadcrumb (the thread's before the channel's) and exists only while a package contributes. */
  function mount() {
    for (const location of BOT_CONVERSATION_ACTION_SURFACES) {
      const wanted = !disposed && contributes(location), current = mounts.get(location);
      if (wanted && !current) {
        const host = document.createElement('div');
        host.className = 'bot-conversation-actions'; host.dataset.botConversation = location === 'panda.bot.thread.actions' ? 'thread' : 'channel';
        const view = location === 'panda.bot.thread.actions' ? 'bot-thread' : 'channel';
        mounts.set(location, { host, dispose: mountExtensionActions(host, location, () => captured(location), options.notify, options.onContextChanged, () => !disposed && options.state().view === view) });
      } else if (!wanted && current) { current.dispose(); current.host.remove(); mounts.delete(location); }
    }
    let after: Element = options.breadcrumb;
    for (const location of BOT_CONVERSATION_ACTION_SURFACES) {
      const host = mounts.get(location)?.host; if (!host) continue;
      if (after.nextElementSibling !== host) after.after(host);
      after = host;
    }
  }
  /** Mounts or removes the slots and redraws the open view when the arrangement changed (never with zero extensions). */
  function refresh() {
    if (disposed) return;
    lastProject = layoutProject();
    mount();
    const next = JSON.stringify([threadLayout() ?? null, channelLayout() ?? null]);
    if (next === arranged) return;
    arranged = next;
    if (options.state().view !== 'none') options.rerender();
  }

  function authority() {
    const provider = componentSelection.resolve('panda.transcript', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && options.transcript.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }
  function presentation(): BotConversationPresentation {
    const state = options.state(), auth = authority();
    finders.clear();
    const controls: Control[] = [];
    /** `inMenu` controls sit in a closed host menu: only the user's layout hides them. */
    const add = (key: string, controlId: BotConversationControl, resource: string, find: () => HTMLElement | null, inMenu = false) => {
      const element = find(); if (!element) return;
      const id = handle(key); finders.set(id, find);
      controls.push({ id, controlId, resource: handle(resource), enabled: !(element as HTMLButtonElement).disabled, hidden: Boolean(element.closest('[data-layout-hidden]')) || !inMenu && !shown(element) });
    };
    if (state.view === 'bot-thread' && state.bot) {
      const bot = state.bot, session = state.session ?? '';
      add(`pause:${bot}`, 'bot-pause', `pause:${bot}:${state.paused ? 'paused' : 'running'}`, () => options.breadcrumb.querySelector<HTMLElement>('.bot-crumb-action[aria-pressed]'));
      add(`settings:${bot}`, 'bot-settings', `settings:${bot}:`, () => options.breadcrumb.querySelector<HTMLElement>('.bot-crumb-action:not([aria-pressed])'));
      for (const button of options.transcript.querySelectorAll<HTMLElement>('.bot-welcome .bot-welcome-setup > button')) {
        const tab = button.dataset.tab ?? '';
        add(`settings:${bot}:${tab}`, 'bot-settings', `settings:${bot}:${tab}`, () => [...options.transcript.querySelectorAll<HTMLElement>('.bot-welcome .bot-welcome-setup > button')].find(item => item.dataset.tab === tab) ?? null);
      }
      options.transcript.querySelectorAll<HTMLElement>('.bot-welcome .bot-suggestion').forEach((chip, index) => {
        add(`suggest:${session}:${index}`, 'bot-suggest', `suggest:${session}:${digest(chip.dataset.text ?? '')}`, () => options.transcript.querySelectorAll<HTMLElement>('.bot-welcome .bot-suggestion')[index] ?? null);
      });
    }
    if (state.view === 'channel' && state.channel) {
      const channel = state.channel, row = () => options.area.querySelector<HTMLElement>('.bc-channel-actions');
      add(`earlier:${channel}`, 'channel-earlier', `channel:${channel}`, () => options.transcript.querySelector<HTMLElement>('.bc-channel .bc-earlier'));
      add(`settings:${channel}`, 'channel-settings', `channel:${channel}`, () => options.transcript.querySelector<HTMLElement>('.bc-channel .bc-settings'));
      const message = row()?.querySelector<HTMLElement>('[data-shared-action=continue]')?.dataset.message ?? '';
      if (message) {
        add(`continue:${channel}:${message}`, 'channel-continue', `message:${channel}:${message}`, () => row()?.querySelector<HTMLElement>(`[data-shared-action=continue][data-message="${CSS.escape(message)}"]`) ?? null);
        add(`reassign-open:${channel}:${message}`, 'channel-reassign-open', `message:${channel}:${message}`, () => row()?.querySelector<HTMLElement>('[data-shared-action=reassign-toggle]') ?? null);
        for (const button of row()?.querySelectorAll<HTMLElement>('.bc-reassign-menu [data-shared-action=reassign]') ?? []) {
          const bot = button.dataset.bot ?? '';
          add(`reassign:${channel}:${message}:${bot}`, 'channel-reassign', `member:${channel}:${bot}`, () => row()?.querySelector<HTMLElement>(`.bc-reassign-menu [data-shared-action=reassign][data-message="${CSS.escape(message)}"][data-bot="${CSS.escape(bot)}"]`) ?? null, true);
        }
      }
    }
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, view: state.view,
      project: state.view === 'bot-thread' && state.project ? handle(`project:${state.project}`) : '',
      bot: state.view === 'bot-thread' && state.bot ? handle(`bot:${state.bot}`) : '', session: state.view === 'bot-thread' && state.session ? handle(`session:${state.session}`) : '',
      channel: state.view === 'channel' && state.channel ? handle(`channel:${state.channel}`) : '',
      revision: 0, visible: !disposed && state.view !== 'none' && options.breadcrumb.isConnected && shown(options.breadcrumb),
      // An open dialog or menu, or a pending host choice, holds input.
      busy: choosing || state.busy || Boolean(document.querySelector('dialog[open], .model-menu, .choice-menu')),
      safeMode: extensionsSnapshot().safeMode, controls: controls.slice(0, 128), truncated: controls.length > 128,
    };
    const next = JSON.stringify([value, state.paused ?? null, state.detail ?? '', auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotBotConversation({ ...value, revision });
  }
  /** The host's own words for the fresh choice; nothing here reaches a package. */
  function label(action: BotConversationAction, element: HTMLElement, state: BotConversationHostState): [string, string] {
    const bot = state.botName ?? 'this bot', channel = state.channelName ?? 'this channel';
    switch (action.controlId) {
      case 'bot-pause': return [`${state.paused ? 'Resume' : 'Pause'} ${bot}`, state.paused ? 'play' : 'pause'];
      case 'bot-settings': return [`Open ${bot} settings${element.dataset.tab && TABS[element.dataset.tab] ? `: ${TABS[element.dataset.tab]}` : ''}`, 'settings'];
      case 'bot-suggest': return [`Put “${element.dataset.text ?? ''}” in the message to ${bot}`, 'edit'];
      case 'channel-continue': return [`Continue the stopped message in ${channel}`, 'play'];
      case 'channel-reassign': return [`Reassign the stopped message to ${element.textContent?.trim() || 'another bot'}`, 'bot'];
      default: return [`Open ${channel} settings`, 'settings'];
    }
  }
  /** Runs the original handler through the original node; the changing controls ask first, bound to the same view,
   * bot, conversation or channel and target. */
  function execute(action: BotConversationAction, alive: () => boolean) {
    const element = finders.get(action.control)?.(); if (!element) return;
    if (!BOT_CONVERSATION_CHOICE_CONTROLS.includes(action.controlId)) { element.click(); return; }
    const [text, icon] = label(action, element, options.state());
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: shown(element) ? element : options.breadcrumb, title: 'Extension requested a bot conversation action', items: [{ id: 'continue', label: `Continue: ${text}`, icon }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createBotConversationControls(presentation(), owner, presentation, authority, action => {
      const held = identity;
      execute(action, () => { const live = presentation(); return authority().active && held === identity && (['project', 'bot', 'session', 'channel'] as const).every(key => live[key] === action[key]) && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  // After main.ts holds the adoption: an engaged arrangement redraws the open view through it.
  queueMicrotask(refresh);
  return {
    presentation, dispatch, threadLayout, channelLayout,
    dispose() {
      if (disposed) return;
      closeChoice?.(); stopExtensions(); stopLayout(); stopContext();
      window.removeEventListener('pandacode-components-change', refresh);
      disposed = true;
      for (const { host, dispose } of mounts.values()) { dispose(); host.remove(); }
      mounts.clear();
      // The open view goes back to the host's own order and visibility.
      if (arranged !== builtIn && options.state().view !== 'none') options.rerender();
    },
  };
}
