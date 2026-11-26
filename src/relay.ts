/* Context relay (issue #397): the transcript's relay card, the checkpoint chip, the
 * relay IPC reader and the composer's Extras preferences.
 *
 * A `relay` message carries one JSON record. Both the compact record the UI writes and a
 * full Rust `Packet` decode here, and anything else is treated as an unknown row so the
 * caller can draw nothing rather than throw. Every string that reaches the page is bounded
 * and escaped. */
import { escape, icon, isImeKey } from './dom.ts';

export interface RelayCheckpoint {
  id: string;
  sessionId: string;
  ordinal: number;
  at: number;
  messageHighWater: number;
  goal: string;
  taskStage: string;
  decisions: string[];
  openQuestions: string[];
  files: string[];
  commands: string[];
}

export interface RelayPacketMessage {
  id: number;
  role: string;
  excerpt: string;
  shortened: boolean;
}

export interface RelayPacket {
  v: number;
  relayId: string;
  taskId: string;
  source: { sessionId: string; provider: string; model: string; cwd?: string; branch?: string; resumeId?: string };
  goal: string;
  taskStage: string;
  checkpoint?: { id: string; ordinal: number; at: number; messageHighWater: number };
  decisions: string[];
  openQuestions: string[];
  files: string[];
  commands: string[];
  messages: RelayPacketMessage[];
  truncated?: { omittedMessages: number; droppedNewest: number; shortenedMessages: number };
  tokenAccounting: { before: number; packet: number };
}

export interface PendingRelay {
  relayId: string;
  sessionId: string;
  packet: RelayPacket;
  createdAt: number;
}

export interface RelayEscalation {
  sessionId: string;
  lastEnd: 'harness' | 'stalled' | 'crashed' | null;
  resumes: number;
  relays: number;
  updatedAt: number;
}

export interface RelayDoneGate {
  sessionId: string;
  done: boolean;
  stage: string;
  completedAt: number | null;
  checkpoint: RelayCheckpoint | null;
  blocked: boolean;
}

/** The relay preferences the backend enforces (`relay_settings` / `relay_set_settings`). */
export interface Settings {
  autoRelayOnCrash: boolean;
  retrySameAgentFirst: boolean;
  requireCheckpointBeforeRelay: boolean;
  doneGate: boolean;
}

export interface RelayState {
  sessionId: string;
  escalation: RelayEscalation;
  latestCheckpoint: RelayCheckpoint | null;
  pending: PendingRelay | null;
  doneGate: RelayDoneGate;
  checkpoints: RelayCheckpoint[];
  nextStep: 'resume' | 'relay';
  settings: Settings;
}

export interface ExpandedRelayMessage {
  id: number;
  role: string;
  content: string;
  createdAt: number;
}

/** The state a `relay` row renders from. Unknown fields are ignored, never shown. */
interface RelayView {
  from: string;
  to: string;
  checkpointId: string;
  ordinal: number;
  summary: string;
  messages: number;
  files: number;
  decisions: number;
  commands: number;
  messageIds: number[];
  before: number;
  packet: number;
  truncated: boolean;
  sessionId: string;
}

type RelayMessage = { role: string; content: string; sessionId?: string };
type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 1_000_000) : 0;

/** Bounded text: code points, not UTF-16 units, so a cap never splits a surrogate pair. */
function clip(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function providerLabel(id: string): string {
  const known: Record<string, string> = {
    claude: 'Claude', codex: 'Codex', kimi: 'Kimi', opencode: 'OpenCode', glm: 'GLM', antigravity: 'Antigravity',
    grok: 'Grok', mimo: 'MiMo', alibaba: 'Alibaba', pi: 'Pi', deepseek: 'DeepSeek', commandcode: 'Command Code',
    cline: 'Cline', kilo: 'Kilo', omp: 'Oh My Pi', 'github-copilot': 'GitHub Copilot', muse: 'Muse', devin: 'Devin',
    zcode: 'ZCode', hermes: 'Hermes', cursor: 'Cursor',
  };
  const key = id.trim().toLowerCase();
  if (known[key]) return known[key];
  const words = key.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 3);
  return clip(words.map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ') || 'Agent', 32);
}

function ordinalFromId(id: string): number {
  const match = /(\d+)\s*$/.exec(id);
  return match ? count(Number(match[1])) : 0;
}

function listCount(record: RecordValue, key: string): number {
  const value = record[key];
  return Array.isArray(value) ? Math.min(value.length, 999) : count(value);
}

function messageIds(record: RecordValue, carried: RecordValue): number[] {
  const ids: number[] = [];
  const add = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const id = isRecord(item) ? count(item.id) : count(item);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= 200) return;
    }
  };
  add(record.messageIds);
  add(record.messages);
  add(carried.messages);
  return ids.slice(0, 200);
}

/** Decode a relay row. Returns null for a non-relay row, bad JSON, or JSON with no relay fields. */
function decodeRelay(message: RelayMessage): RelayView | null {
  if (!message || message.role !== 'relay' || typeof message.content !== 'string' || !message.content.trim()) return null;
  let raw: unknown;
  try { raw = JSON.parse(message.content); } catch { return null; }
  if (!isRecord(raw)) return null;
  const source = isRecord(raw.source) ? raw.source : {};
  const target = isRecord(raw.target) ? raw.target : {};
  const checkpoint = isRecord(raw.checkpoint) ? raw.checkpoint : {};
  const carried = isRecord(raw.carried) ? raw.carried : {};
  const accounting = isRecord(raw.tokenAccounting) ? raw.tokenAccounting : {};

  const fromId = text(source.provider) || text(raw.fromProvider) || text(raw.from);
  const toId = text(raw.toProvider) || text(target.provider) || text(raw.targetProvider) || text(raw.to);
  const from = fromId ? providerLabel(fromId) : '';
  const to = toId ? providerLabel(toId) : '';
  const checkpointId = clip(text(checkpoint.id) || text(raw.checkpointId) || text(raw.checkpoint_id) || text(raw.checkpoint), 64);
  const ordinal = count(checkpoint.ordinal) || count(raw.checkpointOrdinal) || ordinalFromId(checkpointId);
  const summary = clip(text(raw.summary) || text(raw.goal), 320);
  const files = Math.max(listCount(raw, 'files'), listCount(carried, 'files'));
  const decisions = Math.max(listCount(raw, 'decisions'), listCount(carried, 'decisions'));
  const commands = Math.max(listCount(raw, 'commands'), listCount(carried, 'commands'));
  const messages = Math.max(
    Array.isArray(raw.messages) ? Math.min(raw.messages.length, 999) : count(raw.messages),
    Array.isArray(carried.messages) ? Math.min(carried.messages.length, 999) : count(carried.messages),
    count(raw.messageCount),
  );
  const recognized = Boolean(from || to || checkpointId || ordinal || summary || text(raw.relayId)
    || messages || files || decisions || commands || Array.isArray(raw.messageIds));
  if (!recognized) return null;

  const truncatedRecord = isRecord(raw.truncated) ? raw.truncated : {};
  const truncated = Boolean(raw.truncated) && (
    typeof raw.truncated === 'boolean'
    || count(truncatedRecord.omittedMessages) + count(truncatedRecord.droppedNewest) + count(truncatedRecord.shortenedMessages) > 0
  );
  const sessionId = clip(text(raw.taskId) || text(raw.sessionId) || text(message.sessionId), 128);

  return {
    from, to, checkpointId, ordinal, summary, messages, files, decisions, commands,
    messageIds: messageIds(raw, carried),
    before: count(accounting.before),
    packet: count(accounting.packet),
    truncated,
    sessionId,
  };
}

const plural = (value: number, word: string): string => `${value} ${word}${value === 1 ? '' : 's'}`;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    const kb = value / 1024;
    return `${kb >= 10 || Number.isInteger(kb) ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

let relayCardSequence = 0;
let relayExpandBound = false;

/** One delegated listener for every card, wherever the transcript draws it. */
function bindRelayExpand(): void {
  if (relayExpandBound || typeof document === 'undefined') return;
  relayExpandBound = true;
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-relay-expand]') : null;
    if (!target) return;
    event.preventDefault();
    void expandRelayCard(target);
  });
}

/** The transcript card for one `relay` row, or null so the caller can draw nothing. */
export function relayCardHtml(message: RelayMessage): string | null {
  const view = decodeRelay(message);
  if (!view) return null;
  bindRelayExpand();
  const checkpoint = view.ordinal ? `cp-${view.ordinal}` : clip(view.checkpointId, 24);
  const pair = Boolean(view.from && view.to);
  const route = pair
    ? `<span class="relay-card-provider">${escape(view.from)}</span><span class="sr-only">to</span>${icon('forward')}<span class="relay-card-provider">${escape(view.to)}</span>`
    : `<span class="relay-card-provider">${escape(checkpoint ? `Checkpoint ${checkpoint}` : view.from ? `From ${view.from}` : view.to ? `To ${view.to}` : 'Relay packet')}</span>`;
  const title = pair && checkpoint ? `Checkpoint ${checkpoint}` : 'Context relayed';
  const carried = [
    view.messages ? plural(view.messages, 'message') : '',
    view.files ? plural(view.files, 'file') : '',
    view.decisions ? plural(view.decisions, 'decision') : '',
    view.commands ? plural(view.commands, 'command') : '',
  ].filter(Boolean);
  const size = view.before && view.packet ? `${formatBytes(view.packet)} of ${formatBytes(view.before)}` : '';
  const counts = [...carried.map(item => `<span class="relay-card-count">${escape(item)}</span>`), size ? `<span class="relay-card-count">${escape(size)}</span>` : ''].filter(Boolean).join('');
  const cardId = `relay-originals-${++relayCardSequence}`;
  const ids = view.messageIds.join(',');
  return `<details class="provider-handoff relay-card" data-relay-card data-relay-session="${escape(view.sessionId)}" data-relay-ids="${escape(ids)}">
    <summary><span class="relay-card-route">${route}</span><span class="relay-card-title">${escape(title)}</span>${icon('down')}</summary>
    <div class="relay-card-body">
      ${view.summary ? `<p class="relay-card-summary">${escape(view.summary)}</p>` : ''}
      ${counts ? `<p class="relay-card-carried">${counts}</p>` : ''}
      ${view.truncated ? '<p class="relay-card-note">Some entries were shortened or left out to fit the packet.</p>' : ''}
      <div class="relay-card-actions"><button type="button" class="relay-expand" data-relay-expand aria-expanded="false" aria-controls="${cardId}">Expand originals</button><span class="relay-card-status" role="status"></span></div>
      <div class="relay-card-expanded" id="${cardId}" hidden></div>
    </div>
  </details>`;
}

/** The `.architect-worker-chip` pattern for a saved progress mark: `checkpointed · cp-3`. */
export function checkpointChip(checkpoint: { ordinal?: unknown } | null | undefined): string {
  const ordinal = checkpoint && typeof checkpoint === 'object' ? count(checkpoint.ordinal) : 0;
  if (!ordinal) return '';
  return `<span class="relay-checkpoint-chip" title="Checkpoint cp-${ordinal}">checkpointed · cp-${ordinal}</span>`;
}

/** Read one task's relay state (src-tauri/src/relay.rs `relay_state`). */
export async function relayState(sessionId: string): Promise<RelayState> {
  const { call } = await import('./bridge.ts');
  return call<RelayState>('relay_state', { sessionId });
}

/** One expanded original: bounded and escaped, with a role label. */
function expandedHtml(messages: ExpandedRelayMessage[]): string {
  const shown = messages.slice(0, 50);
  const rows = shown.map(message => `<article class="relay-expanded-message" data-role="${escape(clip(message.role, 24))}"><header><span class="relay-expanded-role">${escape(clip(message.role || 'message', 24))}</span></header><pre>${escape(clip(message.content, 4000))}</pre></article>`).join('');
  const more = messages.length > shown.length ? `<p class="relay-card-note">${escape(plural(messages.length - shown.length, 'more message'))} not shown.</p>` : '';
  return rows + more;
}

/** The transcript's Expand action: fetch the originals a packet referenced, bounded for the page. */
export async function expandRelayCard(button: HTMLElement): Promise<void> {
  const card = button.closest<HTMLElement>('.relay-card');
  if (!card) return;
  const expanded = card.querySelector<HTMLElement>('.relay-card-expanded');
  const status = card.querySelector<HTMLElement>('.relay-card-status');
  if (!expanded) return;
  if (expanded.dataset.loaded === 'true') {
    const show = expanded.hidden;
    expanded.hidden = !show;
    button.setAttribute('aria-expanded', String(show));
    button.textContent = show ? 'Hide originals' : 'Expand originals';
    return;
  }
  const sessionId = card.dataset.relaySession ?? '';
  const ids = (card.dataset.relayIds ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 200);
  if (!sessionId) {
    if (status) status.textContent = 'This relay does not name its task.';
    return;
  }
  const control = button as HTMLButtonElement;
  control.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (status) status.textContent = 'Loading…';
  try {
    const { call } = await import('./bridge.ts');
    const messages = await call<ExpandedRelayMessage[]>('relay_expand', { sessionId, ids });
    if (!Array.isArray(messages)) throw new Error('The relay originals could not be read.');
    expanded.innerHTML = messages.length ? expandedHtml(messages) : '<p class="relay-card-empty">No original messages were kept for this relay.</p>';
    expanded.dataset.loaded = 'true';
    expanded.hidden = false;
    button.textContent = 'Hide originals';
    button.setAttribute('aria-expanded', 'true');
    if (status) status.textContent = messages.length ? `${plural(messages.length, 'original')} shown` : '';
  } catch (error) {
    if (status) status.textContent = clip(error instanceof Error ? error.message : String(error), 180);
  } finally {
    control.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/* ---------- Extras: the relay preferences the backend enforces ---------- */

/** Every preference key. These four are the settings `src-tauri/src/relay.rs` reads. */
export type RelayToggleId = keyof Settings;

export interface RelayToggle {
  id: RelayToggleId;
  label: string;
  description: string;
  default: boolean;
}

export type RelayToggleState = Settings;

export const RELAY_TOGGLES: readonly RelayToggle[] = [
  { id: 'autoRelayOnCrash', label: 'Relay after a crash', description: 'Queue a relay packet when a run dies, so the next run continues from its newest checkpoint.', default: true },
  { id: 'retrySameAgentFirst', label: 'Retry the same agent first', description: 'Resume once in place before PandaCode relays the task to a different agent.', default: true },
  { id: 'requireCheckpointBeforeRelay', label: 'Require a checkpoint', description: 'Never relay automatically on a task with no saved progress mark. A relay you ask for still works.', default: false },
  { id: 'doneGate', label: 'Hold tasks until done', description: 'A task with a checkpoint but no completion is reported as blocking the tasks that depend on it.', default: true },
];

const RELAY_DEFAULTS: RelayToggleState = Object.fromEntries(
  RELAY_TOGGLES.map(toggle => [toggle.id, toggle.default]),
) as unknown as RelayToggleState;

/** Last state read from the backend, so a popover renders without a round trip per row. */
let relayCache: RelayToggleState = { ...RELAY_DEFAULTS };

/** The saved preferences as the backend enforces them. A failed read keeps the last known set. */
export async function relayToggles(): Promise<RelayToggleState> {
  try {
    const { call } = await import('./bridge.ts');
    const saved = await call<Settings>('relay_settings');
    relayCache = { ...RELAY_DEFAULTS, ...saved };
  } catch { /* Keep the last known set. */ }
  return relayCache;
}

/** Save one preference; the backend is the record, so a failed save reverts the row. */
export async function setRelayToggle(id: RelayToggleId, on: boolean): Promise<RelayToggleState> {
  const next = { ...relayCache, [id]: Boolean(on) };
  try {
    const { call } = await import('./bridge.ts');
    relayCache = await call<Settings>('relay_set_settings', { settings: next });
  } catch { /* The caller re-renders from relayCache, which still holds the old value. */ }
  return relayCache;
}

/** The last set read from the backend, for a synchronous render such as Settings' markup. */
export function relayTogglesCached(): RelayToggleState {
  return relayCache;
}

/** The composer control beside the token saver. */
export function relayExtrasButton(): string {
  return `<button type="button" class="composer-relay-button" data-action="relay-extras" aria-haspopup="dialog" aria-expanded="false" aria-label="Relay and context extras" data-tip="Relay and context extras">${icon('settings')}<span class="sr-only">Extras</span></button>`;
}

export interface RelayExtrasHost {
  /** Optional announcement when a choice is saved. */
  notify?(text: string): void;
}

export interface RelayExtras {
  button(): string;
  open(anchor: HTMLElement): void;
  close(): void;
}

/** The composer's Extras popover: the same shape as the token-saver panel, one switch per row. */
export function mountRelayExtras(host: RelayExtrasHost = {}): RelayExtras {
  let panel: HTMLElement | undefined;
  let opener: HTMLElement | undefined;
  let cleanup: (() => void) | undefined;
  let popover: typeof import('./popover-motion.ts') | undefined;
  let openToken = 0;

  function render(focus = ''): void {
    if (!panel) return;
    const state = relayCache;
    panel.innerHTML = `<header class="relay-extras-head"><span class="relay-extras-title" id="relay-extras-title">Extras</span></header>
      <ul class="relay-extras-list">${RELAY_TOGGLES.map(toggle => `<li class="relay-extras-row"><span class="relay-extras-copy"><span class="relay-extras-name" id="relay-extras-${toggle.id}">${escape(toggle.label)}</span><small id="relay-extras-${toggle.id}-about">${escape(toggle.description)}</small></span><button type="button" role="switch" class="relay-extras-switch" data-relay-toggle="${toggle.id}" aria-labelledby="relay-extras-${toggle.id}" aria-describedby="relay-extras-${toggle.id}-about" aria-checked="${state[toggle.id]}"></button></li>`).join('')}</ul>`;
    if (focus) panel.querySelector<HTMLElement>(`[data-relay-toggle="${focus}"]`)?.focus({ preventScroll: true });
    else panel.querySelector<HTMLElement>('[data-relay-toggle]')?.focus({ preventScroll: true });
  }

  function place(anchor: HTMLElement): void {
    if (!panel) return;
    const rect = anchor.getBoundingClientRect(), width = Math.min(300, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))}px`;
    panel.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`;
    panel.dataset.placement = 'above';
  }

  function closePanel(): void {
    if (!panel) return;
    const closing = panel;
    panel = undefined;
    cleanup?.();
    cleanup = undefined;
    opener?.setAttribute('aria-expanded', 'false');
    opener = undefined;
    popover?.hidePopover(closing);
  }

  function close(): void {
    openToken += 1;
    closePanel();
  }

  function open(anchor: HTMLElement): void {
    if (panel && opener === anchor) { close(); return; }
    const token = ++openToken;
    closePanel();
    void openPanel(anchor, token).catch(() => { /* No panel when its module cannot load. */ });
  }

  async function openPanel(anchor: HTMLElement, token: number): Promise<void> {
    // Read the saved set first, so the switches show the backend's values rather than defaults.
    await relayToggles();
    const module = popover ??= await import('./popover-motion.ts');
    if (token !== openToken) return;
    panel = document.createElement('div');
    panel.className = 'floating-menu relay-extras-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'relay-extras-title');
    document.body.append(panel);
    const owner = panel;
    render();
    place(anchor);
    module.showPopover(panel, anchor);
    opener = anchor;
    anchor.setAttribute('aria-expanded', 'true');

    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-relay-toggle]') : null;
      if (!target || !panel?.contains(target)) return;
      const id = target.dataset.relayToggle as RelayToggleId;
      const on = !relayCache[id];
      // Optimistic: the switch flips now; a failed save reverts it from the cache below.
      relayCache = { ...relayCache, [id]: on };
      render(id);
      void setRelayToggle(id, on).then(state => {
        if (!panel) return;
        panel.querySelector<HTMLElement>(`[data-relay-toggle="${id}"]`)?.setAttribute('aria-checked', String(state[id]));
        host.notify?.(`${RELAY_TOGGLES.find(toggle => toggle.id === id)?.label ?? 'Extras'} ${state[id] ? 'on' : 'off'}`);
      });
    };
    // Enter is the switch's own activation; only Escape needs a handler here, and an IME's
    // committing Escape must reach the input rather than close the panel.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKey(event)) return;
      event.preventDefault();
      const focus = opener;
      close();
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    };
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel && !panel.contains(target) && !target.closest('[data-action="relay-extras"]')) close();
    };
    panel.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    cleanup = () => {
      owner.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
    };
  }

  return { button: relayExtrasButton, open, close };
}
