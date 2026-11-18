/* What main.ts hands the windowed transcript (transcript-view.ts) beyond drawing rows: the folds a reader set in a row (tools, account notes),
 * the lazy bodies of saved tools, Find's in-memory counts for turns not drawn yet, and a thread's details landing after
 * its rows. Each piece takes what it reads from main.ts as callbacks, so it holds no state of the app's own. */
import { fileIconsReady, markdownCache } from './dom';
import { drawnText, exactCount, replyCount, type ReplyText } from './thread-find';
import { decodeToolActivity, renderToolActivity } from './tool-activity';
import { parseRow, untouchedFields, type DrawnRow } from './transcript-rows';
import { touchedRows } from './transcript-window';
import type { TranscriptTurn } from './turn-activity';
import type { Message, Session } from './types';

/** Every message a saved turn draws from, in order (absent parts as undefined). */
export const turnMessages = (turn: TranscriptTurn): (Message | undefined)[] =>
  [turn.handoff, turn.user, turn.coordination, ...turn.activity, turn.final, ...turn.errors, ...turn.notes];

/** The id of the last handoff in a thread's messages, by message array (a new message makes a new array). */
const lastHandoffs = new WeakMap<readonly Message[], number>();
export function lastHandoff(messages: readonly Message[]): number {
  let known = lastHandoffs.get(messages);
  if (known !== undefined) return known;
  known = 0;
  for (let index = messages.length - 1; index >= 0 && !known; index--) if (messages[index].role === 'handoff') known = messages[index].id;
  lastHandoffs.set(messages, known);
  return known;
}

/** What every saved turn's markup reads from outside the app's state, for main.ts markupEnv: an epoch bumped by whatever
 *  changes saved markup from outside a turn (a sent image arriving), the locale's clock as formatTime reads it (read
 *  again only after a languagechange), and a changes card's file icons (turn-changes.ts fileTree, dom.ts fileIcon):
 *  plain glyphs until their chunk loads, then in the theme's variant. */
export function markupShared() {
  let epoch = 0, iconsLoaded = false, clock: Intl.ResolvedDateTimeFormatOptions | undefined;
  addEventListener('languagechange', () => { clock = undefined; });
  void fileIconsReady.then(() => { iconsLoaded = true; });
  return {
    bump(): void { epoch++; },
    inputs(): unknown[] {
      clock ??= new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions();
      return [epoch, clock.locale, clock.hourCycle, iconsLoaded, document.documentElement.dataset.theme === 'light'];
    },
  };
}

const rowRoots = (row: DrawnRow): HTMLElement[] => row.nodes.filter((node): node is HTMLElement => node instanceof HTMLElement);

/** What a reader set in a row (folds, change cards, open notes), kept across the row's redraw or a trim. Only rows the
 *  reader touched are captured; an untouched row redraws as it was. */
export function rowViews<Views>(scroller: HTMLElement, capture: (roots: HTMLElement[]) => Views, restore: (root: HTMLElement, views: Views) => void) {
  const touched = touchedRows(scroller);
  return {
    capture(row: DrawnRow): Views | undefined {
      const roots = rowRoots(row);
      return roots.some(root => touched.has(root)) ? capture(roots) : undefined;
    },
    restore(row: DrawnRow, views: Views): void {
      const roots = rowRoots(row);
      for (const root of roots) touched.add(root);
      for (const root of roots) restore(root, views);
    },
  };
}

/** What the reader set in a saved tool: its fold, its raw record's fold, and where its panes were scrolled. */
export type ToolView = { open: boolean; rawOpen: boolean; controls: { selector: string; top: number; left: number; focused: boolean }[] };
export function captureTools(root: ParentNode): Map<string, ToolView> {
  const views = new Map<string, ToolView>();
  const selectors = ['summary', '.tool-trace-raw > summary', '.tool-trace-card pre', '[data-tool-section="input"] pre', '[data-tool-section="output"] pre', '.tool-activity-legacy-body'];
  root.querySelectorAll<HTMLDetailsElement>('details[data-tool-key]').forEach(tool => {
    const controls: ToolView['controls'] = [];
    for (const selector of selectors) {
      const control = tool.querySelector<HTMLElement>(selector);
      // A folded tool cannot be scrolled; reading its offsets would only force a layout of the whole thread.
      if (control) controls.push({ selector, top: tool.open ? control.scrollTop : 0, left: tool.open ? control.scrollLeft : 0, focused: control === document.activeElement });
    }
    views.set(tool.dataset.toolKey!, { open: tool.open, rawOpen: Boolean(tool.querySelector<HTMLDetailsElement>('.tool-trace-raw')?.open), controls });
  });
  return views;
}
/** Puts back what captureTools kept; `fill` draws a lazy tool body the reader had open. */
export function restoreToolViews(root: ParentNode, views: Map<string, ToolView>, fill: (tool: HTMLDetailsElement) => void): void {
  root.querySelectorAll<HTMLDetailsElement>('details[data-tool-key]').forEach(tool => {
    const view = views.get(tool.dataset.toolKey!); if (!view) return;
    if (view.open || view.rawOpen) fill(tool);
    if (tool.open !== view.open) tool.open = view.open;
    const raw = tool.querySelector<HTMLDetailsElement>('.tool-trace-raw');
    if (raw && raw.open !== view.rawOpen) raw.open = view.rawOpen;
    for (const saved of view.controls) {
      const control = tool.querySelector<HTMLElement>(saved.selector);
      if (saved.focused) (control ?? tool.querySelector<HTMLElement>('summary'))?.focus({ preventScroll: true });
      // Writing an offset forces layout, and a fresh control is already at zero.
      if (control && saved.top) control.scrollTop = saved.top;
      if (control && saved.left) control.scrollLeft = saved.left;
    }
  });
}
/** An account-switch note on screen, and whether it held focus. */
export type AccountSwitchView = { node: HTMLDetailsElement; focused: boolean };
export const captureAccountSwitches = (root: ParentNode): AccountSwitchView[] => [...root.querySelectorAll<HTMLDetailsElement>('details[data-account-switch]')].map(node => ({ node, focused: node.querySelector('summary') === document.activeElement }));
export function takeAccountSwitch(views: AccountSwitchView[], key: string, sessionId: string, detail: string, keys: Set<string>): AccountSwitchView | undefined {
  let index = views.findIndex(view => view.node.dataset.accountSwitch === key);
  // A transient event becomes a saved row. Match occurrences, never all equal prose across turns.
  if (index < 0) for (let i = views.length - 1; i >= 0; i--) {
    const view = views[i];
    if (!keys.has(view.node.dataset.accountSwitch!) && view.node.dataset.accountSwitchSession === sessionId && view.node.querySelector('p')?.textContent === detail && (/:-\d+$/.test(view.node.dataset.accountSwitch!) || /:-\d+$/.test(key))) { index = i; break; }
  }
  return index < 0 ? undefined : views.splice(index, 1)[0];
}
/** Puts each note's earlier node back in place of its redraw; returns what replaced what, for the rows that list them. */
export function restoreAccountSwitches(root: ParentNode, views: AccountSwitchView[], departing?: Element): Map<ChildNode, ChildNode> {
  const swaps = new Map<ChildNode, ChildNode>();
  const notes = [...root.querySelectorAll<HTMLDetailsElement>('details[data-account-switch]')].filter(note => !departing?.contains(note)), keys = new Set(notes.map(note => note.dataset.accountSwitch!));
  for (const fresh of notes.reverse()) {
    const view = takeAccountSwitch(views, fresh.dataset.accountSwitch!, fresh.dataset.accountSwitchSession!, fresh.querySelector('p')!.textContent!, keys);
    if (!view || view.node === fresh) continue;
    view.node.dataset.accountSwitch = fresh.dataset.accountSwitch;
    fresh.replaceWith(view.node);
    swaps.set(fresh, view.node);
    if (view.focused) view.node.querySelector('summary')!.focus({ preventScroll: true });
  }
  return swaps;
}
export interface FindCountHost {
  /** A user's message as the transcript draws it. */
  userHtml(message: Message): string;
  /** Bumped when what a user message draws changes (its wake-up mark reads the schedules). */
  version(): number;
}

/** How long working out tools' text for Find may hold the main thread before it lets a frame through. */
const COUNT_SLICE_MS = 8;

/** How many times Find would match a query in a message or a turn once drawn (thread-find.ts): a reply or narration by
 *  its formatted text once known, else its Markdown source (replyCount); a user's message and a tool's body by the text
 *  they draw (an attached file shows as its chip, a tool's name sits in its summary row, which Find does not search);
 *  anything else (handoffs, coordination, notes, errors) draws no searched text. Each message's text is worked out once.
 *  A tool's text costs its whole card's markup, so outside `exact` (a drawn tool) it is worked out in slices by
 *  `prepare`, and counts nothing until then: a count that only grows never draws a turn that does not match. */
export function findCounter(host: FindCountHost) {
  const replies = new WeakMap<Message, ReplyText>();
  const users = new WeakMap<Message, { text: string; version: number }>(), tools = new WeakMap<Message, string>();
  const toolText = (message: Message): string => {
    const text = drawnText(renderToolActivity(decodeToolActivity(message.content) ?? message.content, ''));
    tools.set(message, text);
    return text;
  };
  function count(message: Message, query: string, exact = false): number {
    if (message.role === 'assistant') {
      let known = replies.get(message);
      if (!known) replies.set(message, known = {});
      return replyCount(known, message.content, markdownCache.get(message.content), query);
    }
    if (message.role === 'tool') {
      const text = tools.get(message) ?? (exact ? toolText(message) : undefined);
      return text === undefined ? 0 : exactCount(text, query);
    }
    if (message.role !== 'user') return 0;
    const version = host.version();
    let known = users.get(message);
    if (known?.version !== version) {
      known = { text: drawnText(host.userHtml(message)), version };
      users.set(message, known);
    }
    return exactCount(known.text, query);
  }
  /** Works out, a slice a task, the text of the tools in `turns` not known yet; undefined when every one is known. */
  function prepare(turns: readonly TranscriptTurn[]): Promise<void> | undefined {
    const pending = turns.flatMap(turn => turn.activity).filter(message => message.role === 'tool' && !tools.has(message));
    if (!pending.length) return undefined;
    return new Promise(resolve => {
      let at = 0;
      const slice = (): void => {
        const start = performance.now();
        while (at < pending.length && performance.now() - start < COUNT_SLICE_MS) { if (!tools.has(pending[at])) toolText(pending[at]); at++; }
        if (at < pending.length) setTimeout(slice); else resolve();
      };
      setTimeout(slice);
    });
  }
  return {
    count, prepare,
    turn: (turn: TranscriptTurn, query: string): number => turnMessages(turn).reduce((total, message) => message ? total + count(message, query) : total, 0),
  };
}

/** A saved tool's body, drawn the first time it is needed from the messages of the view it is in (`messagesOf`). */
export function fillToolBody(tool: HTMLDetailsElement, messages: readonly Message[]): void {
  const body = tool.querySelector<HTMLElement>(':scope > [data-tool-body]');
  const id = body?.dataset.toolBody;
  const message = id === undefined ? undefined : messages.find(item => String(item.id) === id);
  if (!body || !message) return;
  const [drawn] = parseRow(renderToolActivity(decodeToolActivity(message.content) ?? message.content, tool.dataset.toolKey!)).nodes;
  body.removeAttribute('data-tool-body');
  body.replaceChildren(...((drawn as Element).querySelector(':scope > .tool-activity-body')?.childNodes ?? []));
}

/** Draws the lazy body of every drawn tool in `root` whose body holds `query`, so Find reaches text inside a closed tool. */
export function fillMatchingToolBodies(root: HTMLElement, query: string, messages: readonly Message[], count: (message: Message, query: string) => number): void {
  const empty = root.querySelectorAll<HTMLElement>('[data-tool-body]');
  if (!empty.length) return;
  const byId = new Map(messages.map(message => [String(message.id), message]));
  for (const body of empty) {
    const message = byId.get(body.dataset.toolBody!), tool = body.parentElement;
    if (message && tool instanceof HTMLDetailsElement && count(message, query)) fillToolBody(tool, messages);
  }
}

/** What a run changes on its task: details read before a run started or ended must not put these back. */
export const RUN_FIELDS = ['status', 'taskStage', 'updatedAt', 'lastResponseAt', 'lastPromptAt', 'completedAt', 'resumeId', 'contextUsage', 'limitedAt', 'limitedUntil', 'resumeAtReset'] as const;
/** A thread's details, landing after its rows, applied to its task: only fields still as they were when the details
 *  were asked for (`asked`) take the details' value; `steady` says no run started or ended since, otherwise the run's
 *  own fields keep what that run set; `streaming` keeps a running task running. True when the change alters how the
 *  rows read (their markup reads the task's harness, resume id, device and project). */
export function mergeTaskDetails(loaded: Session, details: Session, asked: Session | undefined, steady: boolean, streaming: boolean): boolean {
  const drawnAs = (task: Session): string => JSON.stringify([task.provider, task.resumeId, task.remoteDevice, task.projectId]);
  const before = drawnAs(loaded);
  Object.assign(loaded, untouchedFields(details, loaded, asked, ['pinned', 'sidebarOrder', ...(steady ? [] : RUN_FIELDS)]));
  if (streaming) { loaded.taskStage = 'in_progress'; loaded.status = 'running'; }
  return before !== drawnAs(loaded);
}

/** What a thread's load reads to send what its queue held back (main.ts queueOf, teams, loadTeam, dispatchQueue). */
export interface HeldQueueHost {
  queued(sessionId: string): boolean;
  hasTeam(sessionId: string): boolean;
  loadTeam(sessionId: string): Promise<unknown>;
  dispatch(sessionId: string): Promise<void>;
  /** Runs a background promise, reporting its failure. */
  run(work: Promise<unknown>): void;
}
/** A thread's queue waits for its load to know whether the thread is a team's, so a send never goes out as a plain
 *  message to what turns out to be a team thread. Once `after` settles (a load another one took over, or nothing for a
 *  load that failed), what the queue holds goes, the team asked for first if that load did not bring it. */
export function dispatchHeld(host: HeldQueueHost, sessionId: string, after: Promise<unknown> = Promise.resolve()): void {
  if (!host.queued(sessionId)) return;
  host.run(after.catch(() => undefined).then(() => host.hasTeam(sessionId) ? null : host.loadTeam(sessionId)).then(() => host.dispatch(sessionId)));
}
