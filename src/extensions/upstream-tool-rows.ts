/** Host-only bindings for the upstream tool rows and result cards (docs/extensions/upstream-tool-rows.md): one action
 * slot per tool row and one per result card, mounted by thread-actions.ts at `panda.thread.trace.actions`, captured with
 * `selection.kind = "tool-row"` or `"tool-card"`. The renderer (tool-activity.ts, tool-trace-*.ts) keeps drawing every
 * row, card, badge, thumbnail and disclosure itself; this module only reads a row's own `data-tool-*` facts and adds or
 * removes a marker. No input, output, path or DOM handle ever crosses the package boundary, and the destructive and
 * failure signals, refusal rows and the shell-intent classifier are never touched. Order, hiding and restoring of the
 * contributed actions go through the shared layout store, as at every other action location. */
import { extensionsSnapshot, onExtensionsChanged } from './manager';
import { toolRowTarget, type ToolRowFacts, type ToolRowPart } from '../tool-trace';

const LOCATION = 'panda.thread.trace.actions';
const ROW_SELECTOR = '.tool-activity.tool-trace[data-tool-key]';
const MARKER = 'data-upstream-tool-slot';
const SELECTION_KINDS = ['tool-row', 'tool-card'] as const;

/** A package opts in by a menu at the trace action location whose `visible` condition names a tool selection kind, so a
 * package that only decorates a turn card never sees a marker on every tool row. Never in safe mode. */
export function toolRowKindsWanted(): ReadonlySet<ToolRowPart> {
  const snapshot = extensionsSnapshot(), wanted = new Set<ToolRowPart>();
  if (snapshot.safeMode) return wanted;
  for (const item of snapshot.packages) {
    if (!item.enabled) continue;
    for (const menu of item.manifest.contributes.menus ?? []) {
      if (menu.location !== LOCATION || menu.visible === undefined) continue;
      const text = JSON.stringify(menu.visible);
      if (text.includes(`"${SELECTION_KINDS[0]}"`)) wanted.add('row');
      if (text.includes(`"${SELECTION_KINDS[1]}"`)) wanted.add('card');
    }
  }
  return wanted;
}

function factsOf(row: HTMLElement): ToolRowFacts | undefined {
  const { toolKey, toolName, toolKind, toolStatus, toolFamily } = row.dataset;
  if (!toolKey || !toolName || !toolKind || !toolStatus) return undefined;
  return {
    key: toolKey, name: toolName, kind: toolKind, status: toolStatus, family: toolFamily,
    failed: 'toolFailed' in row.dataset, blocked: 'toolBlocked' in row.dataset, interrupted: 'toolInterrupted' in row.dataset, quiet: 'toolQuiet' in row.dataset,
  };
}

function makeSlot(part: ToolRowPart, row: HTMLElement, session: string): HTMLElement | undefined {
  const facts = factsOf(row);
  if (!facts) return undefined;
  const target = toolRowTarget(part, facts);
  const slot = document.createElement('span');
  slot.className = 'extension-action-slot upstream-tool-slot';
  slot.setAttribute(MARKER, part);
  Object.assign(slot.dataset, {
    extensionActionSlot: LOCATION, extensionSession: session, extensionSelectionKind: target.selectionKind,
    extensionSelectionIds: JSON.stringify(target.ids), upstreamToolIdentity: target.identity,
  });
  // A contributed button inside a row's <summary> reads as the button, it never opens or closes the row around it.
  slot.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
  slot.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); });
  return slot;
}

/** The anchor of each part: the end of the row's summary line (before the chevron) and the end of an open card. */
function anchorOf(part: ToolRowPart, row: HTMLElement): { parent: HTMLElement; before: Element | null } | undefined {
  if (part === 'row') {
    const line = row.querySelector<HTMLElement>(':scope > summary, :scope > .tool-trace-summary');
    return line ? { parent: line, before: line.querySelector(':scope > .tool-trace-chevron') } : undefined;
  }
  const body = row.querySelector<HTMLElement>(':scope > .tool-activity-body');
  return body && body.childElementCount > 0 && !body.hasAttribute('data-tool-body') ? { parent: body, before: null } : undefined;
}

export function mountToolRowActions(options: {
  root: HTMLElement;
  /** The thread a row belongs to when its own turn card does not name one (the live card, a tile). */
  session: () => string | undefined;
}): () => void {
  const { root } = options;
  let disposed = false, scheduled = false, wanted: ReadonlySet<ToolRowPart> = new Set();
  const sessionOf = (row: HTMLElement) => {
    const owner = row.closest<HTMLElement>('[data-turn-card]') ?? row.closest<HTMLElement>('#transcript, .workspace') ?? root;
    return owner.querySelector<HTMLElement>('[data-extension-session]')?.dataset.extensionSession ?? options.session();
  };
  const slotOf = (row: HTMLElement, part: ToolRowPart) => [...row.querySelectorAll<HTMLElement>(`[${MARKER}="${part}"]`)].find(slot => slot.closest(ROW_SELECTOR) === row);
  const drop = (slot: HTMLElement, row: HTMLElement) => {
    const focused = slot.contains(document.activeElement);
    slot.remove();
    // The slot's controls go away with it; focus returns to the row the user was on, never to the page.
    if (focused) row.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
  };
  const sync = (row: HTMLElement) => {
    for (const part of ['row', 'card'] as const) {
      const existing = slotOf(row, part), facts = factsOf(row), session = sessionOf(row);
      const want = wanted.has(part) && facts !== undefined && session !== undefined && anchorOf(part, row) !== undefined;
      if (!want) { if (existing) drop(existing, row); continue; }
      const identity = toolRowTarget(part, facts).identity;
      // An unchanged row keeps its mounted controls and focus; a new outcome is a new target, never a replayed action.
      if (existing && existing.dataset.upstreamToolIdentity === identity && existing.dataset.extensionSession === session && existing.parentElement === anchorOf(part, row)!.parent) continue;
      if (existing) drop(existing, row);
      const slot = makeSlot(part, row, session), anchor = anchorOf(part, row)!;
      if (slot) anchor.parent.insertBefore(slot, anchor.before);
    }
  };
  const scan = () => {
    scheduled = false;
    if (disposed) return;
    wanted = toolRowKindsWanted();
    for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      // A fault in one row never reaches the renderer or another row: its markers are removed and it reads as built-in.
      try { sync(row); } catch { for (const slot of row.querySelectorAll<HTMLElement>(`[${MARKER}]`)) slot.remove(); }
    }
    if (!wanted.size) for (const slot of root.querySelectorAll<HTMLElement>(`[${MARKER}]`)) slot.remove();
  };
  const schedule = () => { if (!scheduled && !disposed) { scheduled = true; queueMicrotask(scan); } };
  const observer = new MutationObserver(records => {
    const own = (node: Node) => node instanceof Element && (node.hasAttribute(MARKER) || node.closest(`[${MARKER}]`) !== null);
    // Text and token churn, mounted extension controls and this module's own markers never schedule another pass.
    if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node => !own(node) && node instanceof Element))) schedule();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tool-status', 'data-tool-failed', 'data-tool-blocked', 'data-tool-interrupted', 'data-tool-quiet', 'data-tool-name'] });
  const unsubscribe = onExtensionsChanged(schedule);
  schedule();
  return () => {
    disposed = true; observer.disconnect(); unsubscribe();
    for (const slot of root.querySelectorAll<HTMLElement>(`[${MARKER}]`)) slot.remove();
  };
}
