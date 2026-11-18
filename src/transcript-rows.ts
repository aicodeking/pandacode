/* A long thread is drawn from its newest turns, and redrawn by touching only the turns that changed.
 * Parsing and laying out every turn is what makes a thread slow to open: a tail within TAIL_TURNS and
 * OPEN_BUDGET usually fills the window, older turns join when it does not or as the reader nears the top,
 * or all at once for a find that has a query.
 *
 * A window is anchored on a message id, never a turn key or a position: ids are unique where turn keys can
 * repeat, and a message stays findable when an older page joins the turn it is in and changes that turn's key. */

/** How many of the newest turns a thread opens with, and how many more each step up adds. */
export const TAIL_TURNS = 24;
export const MORE_TURNS = 24;
/** The most weight (turnWeight: messages, plus long text) a thread opens with: an agent's turn holds several messages and a
 *  reply can run to tens of kilobytes, so a turn count alone would not bound it. */
export const OPEN_BUDGET = 40;
/** The most weight one step up takes on: few enough that a step costs about one frame's budget on a slow machine. */
export const ROW_BUDGET = 40;
/** Drawn text this long weighs as much as one more message: formatting and laying out a 30 KB reply costs what about
 *  fifteen short messages do. A tool's record is not counted: its body draws only when opened. */
export const WEIGHT_CHARS = 2000;
/** A thread always opens with this many turns, so a wake taking the last one into its live card leaves the anchor listed. */
export const MIN_TAIL_TURNS = 2;
/** Older turns join this far (px) before the reader reaches the top, so the scroll rarely meets the edge. */
export const ROWS_MARGIN = 1600;
/** A window this much taller than its viewport is full: shorter, and older turns join until it can scroll. */
export const FILL_MARGIN = 240;
/** A trim leaves at least this much more than ROWS_MARGIN above the reader, so the next scroll does not draw it all back. */
export const TRIM_SLACK = 400;
/** A trim is not worth a layout for fewer turns than this, unless they hold MIN_TRIM_MESSAGES. */
export const MIN_TRIM_TURNS = 4;
/** Messages that make a trim worth it however short their rows are: a folded agent turn is a line tall but thousands of nodes. */
export const MIN_TRIM_MESSAGES = ROW_BUDGET;

/** A turn as the window sees it: the ids of its messages (its key if it lists none), never empty, and what drawing it
 *  weighs (turnWeight). */
export type TurnIds = readonly string[] & { readonly weight?: number };
/** What a turn costs to draw, in messages: its message count, plus one per WEIGHT_CHARS of drawn text. */
export const turnWeight = (ids: TurnIds): number => ids.weight ?? ids.length;
/** A drawn turn: the markup it came from and the transcript children it became. */
export type DrawnRow = { html: string; nodes: ChildNode[] };

type TurnMessage = { id: number; role?: string; content?: string };
type TurnMessages = {
  key: string;
  handoff?: TurnMessage; user?: TurnMessage; coordination?: TurnMessage; final?: TurnMessage;
  activity: readonly TurnMessage[]; errors: readonly TurnMessage[]; notes: readonly TurnMessage[];
};

export function turnIds(turn: TurnMessages): string[] & { weight: number } {
  const messages = [turn.handoff, turn.user, turn.coordination, ...turn.activity, turn.final, ...turn.errors, ...turn.notes].filter((message): message is TurnMessage => Boolean(message));
  const ids = messages.map(message => String(message.id));
  const chars = messages.reduce((total, message) => message.role === 'tool' ? total : total + (message.content?.length ?? 0), 0);
  // Not enumerable: the list still reads (and compares) as its ids.
  return Object.defineProperty(ids.length ? ids : [turn.key], 'weight', { value: Math.max(1, ids.length) + Math.floor(chars / WEIGHT_CHARS) }) as string[] & { weight: number };
}

/** The oldest index whose turns up to `until` stay within `turns` turns and `budget` weight; always at least one turn. */
function stepStart(list: readonly TurnIds[], until: number, turns: number, budget: number): number {
  let from = until, used = 0;
  while (from > 0 && until - from < turns) {
    used += turnWeight(list[from - 1]);
    if (used > budget && from < until) break;
    from--;
  }
  return from;
}

/** The index of the first turn to draw. `first` is the anchor of the oldest drawn turn: null means every turn is
 *  drawn, undefined a thread being opened, and an anchor no longer listed draws everything rather than hide what was shown. */
export function windowStart(list: readonly TurnIds[], first: string | null | undefined, tail = TAIL_TURNS, budget = OPEN_BUDGET): number {
  if (first === undefined) return Math.min(stepStart(list, list.length, tail, budget), Math.max(0, list.length - MIN_TAIL_TURNS));
  if (first === null) return 0;
  return Math.max(0, list.findIndex(ids => ids.includes(first)));
}

/** The index to draw from after one more step above `from`, or 0 once that reaches the start of the thread. */
export function widerWindow(list: readonly TurnIds[], from: number, more = MORE_TURNS, budget = ROW_BUDGET): number {
  return stepStart(list, from, more, budget);
}

/** The anchor for a window starting at `from`: null when that is the whole thread. */
export function windowAnchor(list: readonly TurnIds[], from: number): string | null {
  return from > 0 ? list[from][0] : null;
}

/** Whether a window `content` px tall leaves a `viewport` px scroller short of content. A hidden scroller measures 0 and never is. */
export function windowShort(content: number, viewport: number): boolean {
  return viewport > 0 && content < viewport + FILL_MARGIN;
}

/** Where `drawn`, the turns on screen, sit in `list` once an older page has joined: the index of its first turn,
 *  which may have gained messages at its head. Undefined if any other turn changed, so the caller draws afresh. */
export function joinIndex(drawn: readonly TurnIds[], list: readonly TurnIds[]): number | undefined {
  if (!drawn.length) return undefined;
  const at = list.length - drawn.length;
  if (at < 0 || !drawn[0].every(id => list[at].includes(id))) return undefined;
  return drawn.slice(1).every((ids, index) => ids.length === list[at + 1 + index].length && ids.every((id, position) => id === list[at + 1 + index][position])) ? at : undefined;
}

/** How many leading rows a return to the bottom can drop: as far as `limit`, less any row that would leave the
 *  reader within reach of the top. `rowTops[i]` is row i's distance below the first row, `scrollTop` the reader's,
 *  `weights[i]` the messages row i holds. Rows heavy in messages but short in pixels (folded agent turns) go by weight:
 *  as many as leave the window able to scroll, since keeping them costs far more than one step drawing them back. */
export function trimCount(rowTops: readonly number[], limit: number, scrollTop: number, weights: readonly number[] = rowTops.map(() => 1)): number {
  const cap = Math.min(limit, rowTops.length - 1);
  const weight = (cut: number): number => weights.slice(0, cut).reduce((total, value) => total + value, 0);
  let cut = cap;
  while (cut > 0 && scrollTop - rowTops[cut] <= ROWS_MARGIN + TRIM_SLACK) cut--;
  if (cut >= MIN_TRIM_TURNS || (cut > 0 && weight(cut) >= MIN_TRIM_MESSAGES)) return cut;
  let heavy = cap;
  while (heavy > 0 && scrollTop - rowTops[heavy] < FILL_MARGIN) heavy--;
  return heavy > 0 && weight(heavy) >= MIN_TRIM_MESSAGES ? heavy : 0;
}

/** How many entries two lists share at their start and, not overlapping that, at their end. */
export function sharedEnds(before: readonly string[], after: readonly string[]): { start: number; end: number } {
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before[start] === after[start]) start++;
  let end = 0;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { start, end };
}

/** Finds, in one pass per turn, the first saved view matching a turn's key or any of its tools. */
export function viewIndex<View extends { key: string; toolKeys: string[] }>(views: readonly View[]): (key: string | undefined, toolKeys: Iterable<string | undefined>) => View | undefined {
  const byKey = new Map<string, number>(), byTool = new Map<string, number>();
  views.forEach((view, index) => {
    if (!byKey.has(view.key)) byKey.set(view.key, index);
    for (const tool of view.toolKeys) if (!byTool.has(tool)) byTool.set(tool, index);
  });
  return (key, toolKeys) => {
    let found = key === undefined ? undefined : byKey.get(key);
    for (const tool of toolKeys) {
      const at = tool === undefined ? undefined : byTool.get(tool);
      if (at !== undefined && (found === undefined || at < found)) found = at;
    }
    return found === undefined ? undefined : views[found];
  };
}

/** Whether rows drawn earlier are all still where they were (a placeholder or welcome page replaces them).
 *  No rows at all is not intact: nothing was windowed yet, so the next draw opens the thread afresh. */
export function rowsIntact(host: Node, rows: readonly DrawnRow[]): boolean {
  return rows.length > 0 && rows.every(row => row.nodes.every(node => node.parentNode === host));
}

/** The same rows after `swaps` put older nodes back in place of freshly drawn ones (a reader's open account note). */
export function swapRowNodes(rows: readonly DrawnRow[], swaps: ReadonlyMap<ChildNode, ChildNode>): DrawnRow[] {
  if (!swaps.size) return [...rows];
  return rows.map(row => row.nodes.some(node => swaps.has(node)) ? { ...row, nodes: row.nodes.map(node => swaps.get(node) ?? node) } : row);
}

export function parseRow(html: string): DrawnRow {
  const template = document.createElement('template');
  template.innerHTML = html;
  return { html, nodes: [...template.content.childNodes] };
}

/** Makes `host` show `next` then `trailing`, keeping the nodes of turns whose markup did not change at either
 *  end, so their Markdown, open folds, focus and measured sizes stay. `added` is what was newly drawn, trailing included. */
export function drawRows(host: HTMLElement, drawn: readonly DrawnRow[], next: readonly string[], trailing: string): { rows: DrawnRow[]; added: ChildNode[] } {
  const usable = rowsIntact(host, drawn) ? drawn : [];
  const { start, end } = sharedEnds(usable.map(row => row.html), next);
  const head = usable.slice(0, start), tail = usable.slice(usable.length - end);
  const kept = new Set([...head, ...tail].flatMap(row => row.nodes));
  if (kept.size) { for (const node of [...host.childNodes]) if (!kept.has(node)) node.remove(); }
  else host.replaceChildren();
  const fresh = next.slice(start, next.length - end).map(parseRow);
  const added = fresh.flatMap(row => row.nodes);
  const firstKept = tail.flatMap(row => row.nodes)[0] ?? null;
  const inserted = document.createDocumentFragment();
  inserted.append(...added);
  host.insertBefore(inserted, firstKept);
  const after = parseRow(trailing).nodes;
  host.append(...after);
  return { rows: [...head, ...fresh, ...tail], added: [...added, ...after] };
}

/** A cache of rendered turn markup, keyed by each turn's first message. An entry holds while every one of `parts` (the
 *  turn's own messages and fields) is identical and `env` (everything else the markup reads, as one string) is equal.
 *  RULE: any new input to turnHtml must go into the parts or the env, or a redraw serves a stale row
 *  (tests/transcript-markup.test.mjs fails when turnHtml's code changes, to make that check). */
export function markupCache<Head extends object>() {
  const kept = new WeakMap<Head, { parts: readonly unknown[]; env: string; html: string }>();
  return (head: Head, parts: readonly unknown[], env: string, render: () => string): string => {
    const entry = kept.get(head);
    if (entry && entry.env === env && entry.parts.length === parts.length && entry.parts.every((part, index) => part === parts[index])) return entry.html;
    const html = render();
    kept.set(head, { parts, env, html });
    return html;
  };
}

/** The fields of `details` (fetched for a record that was `asked` when the request went out) that `current` has not
 *  changed since, compared by value, less `held`: what changed here meanwhile (a rename, a model picked, a run
 *  starting) is newer than the fetch. Without `asked` (the record was not known then) every field but `held` applies. */
export function untouchedFields<T extends object>(details: T, current: T, asked: T | undefined, held: readonly string[]): Partial<T> {
  const same = (key: string): boolean => !asked || JSON.stringify(current[key as keyof T]) === JSON.stringify(asked[key as keyof T]);
  return Object.fromEntries(Object.entries(details).filter(([key]) => !held.includes(key) && same(key))) as Partial<T>;
}
