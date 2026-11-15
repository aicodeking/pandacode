/** Host-only bindings for the transcript extras: a sent message's attachment chips, thread find, a turn's changes card
 * and footer, and the usage-limit card. The user's order and reversible visibility of their eligible controls, host
 * markers for the action slots (mounted by thread-actions.ts with the captured message, turn, find or limit), and
 * captured actions that run the original handlers. Attachment contents, the find text, diffs, the limit and the task's
 * connection never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import { attachmentChipNodes } from '../message-attachments';
import { changeRequest, turnChangesControls } from '../turn-changes';
import { limitBannerControls } from '../usage-limit';
import type { ThreadFindExtension } from '../thread-find';
import { createThreadExtrasControls, snapshotThreadExtras, THREAD_EXTRAS_CHOICE_CONTROLS, type ThreadExtrasAction, type ThreadExtrasControl, type ThreadExtrasPresentation } from './thread-extras-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { threadExtrasSlot } from './thread-slots';
import { THREAD_ATTACHMENTS_CONTROLS, THREAD_ATTACHMENTS_LOCATION, THREAD_CHANGES_CONTROLS, THREAD_CHANGES_LOCATION, THREAD_EXTRAS_ACTION_SURFACES, THREAD_EXTRAS_FIXED, THREAD_EXTRAS_PINNED, THREAD_FIND_CONTROLS, THREAD_FIND_LOCATION, THREAD_LIMIT_CONTROLS, THREAD_LIMIT_LOCATION, type ThreadExtrasActionLocation } from './surfaces';

export type ThreadExtrasHostState = { project?: string; task?: string; provider?: string; limit: string; busy: boolean };
type FindState = { open: boolean; composing: boolean; query: string };
type Control = { id: string; controlId: ThreadExtrasControl; resource: string; enabled: boolean; hidden: boolean };

const LOCATIONS = [[THREAD_ATTACHMENTS_LOCATION, THREAD_ATTACHMENTS_CONTROLS], [THREAD_FIND_LOCATION, THREAD_FIND_CONTROLS], [THREAD_CHANGES_LOCATION, THREAD_CHANGES_CONTROLS], [THREAD_LIMIT_LOCATION, THREAD_LIMIT_CONTROLS]] as const;
/** Rows the adapter arranges; anything else the transcript or composer draws is ignored. */
const ARRANGED = '.message-attachments, .turn-changes, .limit-banner';
/** Order-sensitive digest: an edit changes the revision without the text leaving the host. */
const digest = (text: string) => { let hash = 0; for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0; return `${text.length}:${hash}`; };
const shown = (element: Element) => element.getClientRects().length > 0;

/** Moves each node into one of the nodes' own places, in the desired order; non-control siblings keep theirs and so does
 * focus. */
function place(current: readonly HTMLElement[], desired: readonly HTMLElement[]): void {
  if (current.length !== desired.length || current.every((node, index) => node === desired[index])) return;
  const focused = document.activeElement as HTMLElement | null;
  const marks = current.map(node => { const mark = document.createComment(''); node.before(mark); return mark; });
  marks.forEach((mark, index) => mark.replaceWith(desired[index]));
  if (focused && desired.some(node => node.contains(focused)) && document.activeElement !== focused) focused.focus({ preventScroll: true });
}
/** Hidden controls keep their node, out of view and inert; focus inside one moves to `fallback`. */
function setHidden(element: HTMLElement | null | undefined, hidden: boolean, fallback?: () => HTMLElement | null | undefined): void {
  if (!element || element.hasAttribute('data-layout-hidden') === hidden) return;
  const focused = hidden && element.contains(document.activeElement);
  element.toggleAttribute('data-layout-hidden', hidden); element.inert = hidden;
  if (focused) fallback?.()?.focus({ preventScroll: true });
}

export function mountThreadExtrasAdoption(options: {
  /** The workspace: the transcript, the find bar's pane and the composer area. */
  root: HTMLElement;
  state: () => ThreadExtrasHostState;
  find: () => { relayout(): void; state(): FindState } | undefined;
  onContextChanged: (listener: () => void) => () => void;
}) {
  const { root } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, engagedNow = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const contributes = (location: ThreadExtrasActionLocation) => !safe() && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const transcript = () => root.querySelector<HTMLElement>('#transcript');

  function authority() {
    const provider = componentSelection.resolve('panda.transcript', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && transcript()?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }

  /** The adapter only touches the transcript when it has something to show: a contribution, or the user's order or
   * hidden controls. Otherwise (and in safe mode) every row stays exactly as the host drew it. */
  function engaged(): boolean {
    if (safe()) return false;
    if (THREAD_EXTRAS_ACTION_SURFACES.some(contributes)) return true;
    return LOCATIONS.some(([location, controls]) => {
      const ids = controls.map(([id]) => `${location}/${id}`);
      return ids.some(id => !THREAD_EXTRAS_PINNED[id] && layout.isHidden(id, layoutProject())) || orderedControls(location, ids.filter(id => !THREAD_EXTRAS_FIXED[id])).some((id, index) => id !== ids[index]);
    });
  }
  const hiddenBy = (builtIn: boolean, id: string) => !builtIn && !THREAD_EXTRAS_PINNED[id] && layout.isHidden(id, layoutProject());
  /** The user's order of a location's movable controls (local ids); built-in when not engaged or in safe mode. */
  const ordered = (builtIn: boolean, location: string, local: readonly string[]) => {
    const ids = local.map(id => `${location}/${id}`).filter(id => !THREAD_EXTRAS_FIXED[id]);
    return (builtIn ? ids : orderedControls(location, ids)).map(id => id.slice(location.length + 1));
  };
  /** Adds or removes the host marker of a slot; a kept marker keeps its mounted actions. */
  function marker(parent: HTMLElement, location: ThreadExtrasActionLocation, wanted: boolean, make: () => HTMLElement, put: (slot: HTMLElement) => void): void {
    const existing = [...parent.querySelectorAll<HTMLElement>(':scope > [data-thread-extras]')].find(slot => slot.dataset.extensionActionSlot === location);
    if (!wanted) { existing?.remove(); return; }
    const next = make();
    if (existing && existing.dataset.extensionSelectionIds === next.dataset.extensionSelectionIds && existing.dataset.extensionSession === next.dataset.extensionSession) return;
    existing?.remove(); put(next);
  }

  function arrangeAttachments(row: HTMLElement, builtIn: boolean, task: string): void {
    const chips = attachmentChipNodes(row);
    if (!chips.length) return;
    const rank = ordered(builtIn, THREAD_ATTACHMENTS_LOCATION, THREAD_ATTACHMENTS_CONTROLS.map(([id]) => id));
    const position = (kind: string) => { const at = rank.indexOf(kind); return at < 0 ? rank.length : at; };
    place(chips.map(chip => chip.node), [...chips].sort((a, b) => (builtIn ? 0 : position(a.kind) - position(b.kind)) || a.index - b.index).map(chip => chip.node));
    for (const chip of chips) setHidden(chip.node, hiddenBy(builtIn, `${THREAD_ATTACHMENTS_LOCATION}/${chip.kind}`), () => document.querySelector<HTMLElement>('#prompt'));
    const message = chips[0].node.dataset.messageId ?? '';
    marker(row, 'panda.thread.attachments.actions', !builtIn && Boolean(task) && contributes('panda.thread.attachments.actions'), () => threadExtrasSlot('panda.thread.attachments.actions', task, 'message-attachment', chips.map(chip => `${message}:${chip.index}`)), slot => row.append(slot));
  }
  function arrangeChanges(section: HTMLElement, builtIn: boolean): void {
    const { open, run } = turnChangesControls(section), request = open ? changeRequest(open) : undefined;
    const nodes = { run, open } as Record<string, HTMLElement | null>, present = (ids: readonly string[]) => ids.map(id => nodes[id]).filter((node): node is HTMLElement => Boolean(node));
    // The card draws Run first; the turn card's footer draws Open diff first and Run last.
    const drawn = section.classList.contains('turn-card-foot') ? ['open', 'run'] : ['run', 'open'];
    place(present(['run', 'open']).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1), present(ordered(builtIn, THREAD_CHANGES_LOCATION, drawn)));
    setHidden(run, hiddenBy(builtIn, `${THREAD_CHANGES_LOCATION}/run`), () => open);
    const actions = section.querySelector<HTMLElement>(':scope > .turn-changes-actions'), parent = actions ?? section;
    marker(parent, 'panda.thread.changes.actions', !builtIn && Boolean(request) && contributes('panda.thread.changes.actions'), () => threadExtrasSlot('panda.thread.changes.actions', request!.sessionId, 'turn-changes', [request!.changes.id, ...request!.changes.files.map(file => file.path).slice(0, 99)]), slot => parent.append(slot));
  }
  function arrangeLimit(section: HTMLElement, builtIn: boolean, task: string, provider: string): void {
    const controls = limitBannerControls(section), nodes = { resume: controls.resume, continue: controls.continue, switch: controls.switches[0] ?? null } as Record<string, HTMLElement | null>;
    const present = (ids: readonly string[]) => ids.map(id => nodes[id]).filter((node): node is HTMLElement => Boolean(node));
    place(present(['resume', 'continue', 'switch']), present(ordered(builtIn, THREAD_LIMIT_LOCATION, ['resume', 'continue', 'switch'])));
    // Further "Continue on" buttons follow the first one.
    controls.switches.slice(1).reduce((previous, button) => { if (previous.nextElementSibling !== button) previous.after(button); return button; }, controls.switches[0]);
    setHidden(controls.resume, hiddenBy(builtIn, `${THREAD_LIMIT_LOCATION}/resume`), () => controls.continue);
    for (const button of controls.switches) setHidden(button, hiddenBy(builtIn, `${THREAD_LIMIT_LOCATION}/switch`), () => controls.continue);
    marker(section, 'panda.thread.usage-limit.actions', !builtIn && Boolean(task && provider) && contributes('panda.thread.usage-limit.actions'), () => threadExtrasSlot('panda.thread.usage-limit.actions', task, 'usage-limit', [provider]), slot => controls.dismiss ? controls.dismiss.before(slot) : section.append(slot));
  }
  function arrangeFind(bar: HTMLElement, builtIn: boolean, task: string): void {
    const nodes = Object.fromEntries(THREAD_FIND_CONTROLS.map(([id]) => [id, bar.querySelector<HTMLElement>(`:scope > [data-find-control="${id}"]`)])) as Record<string, HTMLElement | null>;
    const present = (ids: readonly string[]) => ids.map(id => nodes[id]).filter((node): node is HTMLElement => Boolean(node));
    place(present(THREAD_FIND_CONTROLS.map(([id]) => id)).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1), present(ordered(builtIn, THREAD_FIND_LOCATION, THREAD_FIND_CONTROLS.map(([id]) => id))));
    for (const id of ['previous', 'next', 'count']) setHidden(nodes[id], hiddenBy(builtIn, `${THREAD_FIND_LOCATION}/${id}`), () => bar.querySelector('input'));
    const input = bar.querySelector<HTMLElement>(':scope > input');
    marker(bar, 'panda.thread.find.actions', !builtIn && Boolean(task && input) && contributes('panda.thread.find.actions'), () => threadExtrasSlot('panda.thread.find.actions', task, 'find', [task]), slot => input!.after(slot));
  }
  /** Arranges every row the adapter owns, or puts each back as the host drew it. */
  function arrange(scope: ParentNode = root): void {
    const builtIn = !engagedNow, state = options.state(), task = state.task ?? '';
    const within = (selector: string) => [...(scope instanceof Element && scope.matches(selector) ? [scope as HTMLElement] : []), ...scope.querySelectorAll<HTMLElement>(selector)];
    for (const row of within('.message-attachments')) if (row.closest('#transcript')) arrangeAttachments(row, builtIn, task);
    for (const section of within('.turn-changes')) if (section.closest('#transcript')) arrangeChanges(section, builtIn);
    for (const banner of within('.limit-banner')) if (banner.closest('#composer-area')) arrangeLimit(banner, builtIn, task, state.provider ?? '');
  }
  const findLayout = (): ThreadFindExtension | undefined => disposed ? undefined : { painted: bar => arrangeFind(bar, !engagedNow, options.state().task ?? '') };

  // Only while engaged: rows the transcript or composer draws again are arranged before they paint.
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && (node.matches(ARRANGED) || node.querySelector(ARRANGED))) arrange(node);
  });
  function refresh() {
    if (disposed) return;
    lastProject = layoutProject();
    const was = engagedNow; engagedNow = engaged();
    if (engagedNow && !was) observer.observe(root, { childList: true, subtree: true });
    if (!engagedNow && was) observer.disconnect();
    if (engagedNow || was) { arrange(); options.find()?.relayout(); }
  }

  function presentation(): ThreadExtrasPresentation {
    const state = options.state(), auth = authority(), task = state.task ?? '', find = options.find()?.state();
    finders.clear();
    const controls: Control[] = [], turns: string[] = [];
    const add = (key: string, controlId: ThreadExtrasControl, resource: string, find: () => HTMLElement | null) => {
      const element = find(); if (!element) return;
      finders.set(key, find);
      controls.push({ id: key, controlId, resource, enabled: !(element as HTMLButtonElement | HTMLInputElement).disabled && element.getAttribute('aria-disabled') !== 'true', hidden: Boolean(element.closest('[data-layout-hidden], [hidden]')) || !shown(element) });
    };
    const rows = () => [...root.querySelectorAll<HTMLElement>('#transcript .message-attachments')];
    const sections = () => [...root.querySelectorAll<HTMLElement>('#transcript .turn-changes')];
    const banner = () => root.querySelector<HTMLElement>('#composer-area .limit-banner');
    let attachments = 0;
    if (task) {
      for (const row of rows()) for (const chip of attachmentChipNodes(row)) {
        const message = chip.node.dataset.messageId ?? '', index = chip.index;
        attachments++;
        add(handle(`attachment:${task}:${message}:${index}`), 'attachment-open', handle(`attachment-item:${task}:${message}:${index}:${chip.kind}`), () => rows().flatMap(item => attachmentChipNodes(item)).find(item => item.node.dataset.messageId === message && item.index === index)?.node ?? null);
      }
      if (find?.open) {
        const bar = () => root.querySelector<HTMLElement>('.conversation-pane > .thread-find'), resource = handle(`find:${task}`);
        for (const id of ['previous', 'next', 'close'] as const) add(handle(`find-${id}:${task}`), `find-${id}`, resource, () => bar()?.querySelector<HTMLElement>(`:scope > [data-find-control="${id}"]`) ?? null);
      }
      for (const section of sections()) {
        const { open } = turnChangesControls(section), request = open ? changeRequest(open) : undefined;
        if (!request) continue;
        const change = request.changes.id, resource = handle(`turn:${request.sessionId}:${change}`);
        const card = () => sections().find(item => { const found = turnChangesControls(item).open; return Boolean(found && changeRequest(found)?.changes.id === change && item.dataset.sessionId === request.sessionId); }) ?? null;
        if (turns.includes(resource)) continue;
        turns.push(resource);
        add(handle(`changes-open:${request.sessionId}:${change}`), 'changes-open', resource, () => { const found = card(); return found ? turnChangesControls(found).open : null; });
        add(handle(`changes-run:${request.sessionId}:${change}`), 'changes-run', resource, () => { const found = card(); return found ? turnChangesControls(found).run : null; });
        for (const file of turnChangesControls(section).files) {
          const path = file.dataset.path ?? '';
          add(handle(`changes-file:${request.sessionId}:${change}:${path}`), 'changes-file', handle(`turn-file:${request.sessionId}:${change}:${path}`), () => { const found = card(); return found ? turnChangesControls(found).files.find(item => item.dataset.path === path) ?? null : null; });
        }
      }
      const limit = banner();
      if (limit) {
        const resource = handle(`limit:${task}:${state.limit}`), parts = () => { const found = banner(); return found ? limitBannerControls(found) : undefined; };
        add(handle(`limit-resume:${task}`), 'limit-resume', resource, () => parts()?.resumeSwitch ?? null);
        add(handle(`limit-continue:${task}`), 'limit-continue', resource, () => parts()?.continue ?? null);
        for (const button of limitBannerControls(limit).switches) {
          const connection = button.dataset.connection ?? '';
          add(handle(`limit-switch:${task}:${connection}`), 'limit-switch', handle(`connection:${task}:${connection}`), () => parts()?.switches.find(item => item.dataset.connection === connection) ?? null);
        }
        add(handle(`limit-dismiss:${task}`), 'limit-dismiss', resource, () => parts()?.dismiss ?? null);
      }
    }
    const view = transcript(), limited = Boolean(task && banner());
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '',
      revision: 0, visible: !disposed && Boolean(view?.isConnected && shown(view)),
      // A dialog, menu, IME composition in the find field or a pending host choice holds input.
      busy: choosing || state.busy || Boolean(find?.composing) || Boolean(document.querySelector('dialog[open]')) || Boolean(document.querySelector('.model-menu, .choice-menu')),
      safeMode: extensionsSnapshot().safeMode, attachments: Math.min(attachments, 256), find: Boolean(find?.open),
      turns: turns.slice(0, 64), limited, provider: limited && state.provider ? handle(`provider:${state.provider}`) : '',
      controls: controls.slice(0, 256), truncated: controls.length > 256 || turns.length > 64,
    };
    const next = JSON.stringify([value, find?.open ? digest(find.query) : '', state.limit, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotThreadExtras({ ...value, revision });
  }
  const DETAILS: Readonly<Partial<Record<ThreadExtrasControl, string>>> = { 'changes-run': 'Run the project (pandacode-run.sh)', 'limit-continue': 'Continue now', 'limit-dismiss': 'Dismiss the usage limit' };
  /** Runs the original handler by activating the original node; opening an attachment, Run and every usage-limit
   * action need a fresh host choice first, bound to the same task, target and revision. */
  function execute(action: ThreadExtrasAction, alive: () => boolean) {
    const element = finders.get(action.control)?.(); if (!element) return;
    if (!THREAD_EXTRAS_CHOICE_CONTROLS.includes(action.controlId)) { element.click(); return; }
    const detail = action.controlId === 'limit-resume' ? ((element as HTMLInputElement).checked ? 'Stop resuming at reset' : 'Resume at reset')
      : action.controlId === 'limit-switch' ? element.textContent?.trim() || 'Continue on another connection'
      : action.controlId === 'attachment-open' ? element.getAttribute('aria-label') ?? 'Open this attachment' : DETAILS[action.controlId] ?? action.controlId;
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: element, title: 'Extension requested a transcript action', items: [{ id: 'continue', label: `Continue: ${detail}`, icon: action.controlId === 'changes-run' ? 'play' : action.controlId === 'attachment-open' ? 'attach' : 'alert' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createThreadExtrasControls(presentation(), owner, presentation, authority, action => {
      const ownerIdentity = identity, task = options.state().task;
      // The choice acts only on the same task and target it was asked for.
      execute(action, () => { const live = presentation(); return authority().active && ownerIdentity === identity && options.state().task === task && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  // After main.ts holds the adoption: an open find bar reads its layout through it.
  queueMicrotask(refresh);
  return {
    presentation, dispatch, findLayout,
    dispose() {
      if (disposed) return;
      closeChoice?.(); stopExtensions(); stopLayout(); stopContext();
      window.removeEventListener('pandacode-components-change', refresh);
      // Every row and an open find bar go back to the host's own order, visibility and no slot.
      observer.disconnect(); engagedNow = false; arrange(); options.find()?.relayout(); disposed = true;
    },
  };
}
