/**
 * Model, effort and permission changes that show at once and save behind (the model picker's optimistic switch).
 *
 * Per task, at most one model or permission change saves at a time, and effort changes queue so replies arrive in order. Anything
 * that must follow the saved choice (a send, a board start, reopening the picker) waits with `settled()`. Waiters are
 * woken explicitly after each save's bookkeeping (busy cleared, labels repainted), never by racing a promise that
 * other code also awaits, so what they see does not depend on the order promises settle in.
 */
import { call } from './bridge';
import type { TeamConfig, TeamEvent, TeamSnapshot } from './architect-types';
import type { ProviderId, Session } from './types';

type Hooks = {
  /** Marks a task as being configured (main.ts' configuringSessions), so other controls hold back meanwhile. */
  setBusy(id: string, busy: boolean): void;
  /** A model picker is open or on its way: painting the transcript now would close it. */
  pickerOpening(): boolean;
  /** Shows a short notice (main.ts' toast). */
  notify(text: string): void;
  /** The task as main.ts holds it, and a newer copy of it to hold. */
  task(id: string): Session | undefined;
  put(task: Session): void;
  /** The task's team setup, and a team change to apply (main.ts' onArchitect). */
  team(id: string): TeamConfig | undefined;
  teamChanged(event: TeamEvent): void;
  /** An automatic team's setup refreshed from the catalogs already loaded (never waiting on a provider). */
  autoTeam(base: TeamConfig): Promise<TeamConfig>;
  /** After a harness change on this computer: drop the task's saved account binding, if it has one. */
  releaseAccount(id: string): Promise<void>;
  /** The model's and the effort's names as the composer shows them, for notices. */
  label(task: Session): string;
  effortName(task: Session): string;
  /** The model picker is open (it shows an effort refusal itself). */
  pickerShown(): boolean;
  /** Remembers a saved pick as the next new task's default (local picks only). */
  remember(choice: ModelChoice): void;
};
const nothing = () => undefined;
let hooks: Hooks = {
  setBusy: nothing, pickerOpening: () => false, notify: nothing, task: nothing, put: nothing, team: nothing, teamChanged: nothing,
  autoTeam: base => Promise.resolve(base), releaseAccount: () => Promise.resolve(), label: task => task.model, effortName: task => task.reasoningEffort ?? '',
  pickerShown: () => false, remember: nothing,
};
export function initModelSwitch(next: Hooks): void { hooks = next; readStartAhead(); }

/** Settings → Agents → Start agents ahead, as last read or saved; unknown (not yet read, or unreadable) counts as off. */
let startAhead: boolean | undefined;
function readStartAhead(): void {
  void call<{ on: boolean }>('start_ahead_get').then(value => { startAhead = value.on; }).catch(() => { startAhead = undefined; });
}
// Settings announces each saved flip (settings.ts mountStartAhead).
window.addEventListener('pandacode:start-ahead', event => { startAhead = (event as CustomEvent<{ on: boolean }>).detail.on; });
const warmOn = (): boolean => startAhead === true;
const warmArg = (warm: boolean) => warm && warmOn() ? { warm: true } : {};

/** Model changes saving, by task, resolving to whether the change saved. */
const switches = new Map<string, Promise<boolean>>();
/** Effort changes per task: requests in flight, the newest one's number, the last effort the backend confirmed. */
type EffortQueue = { seq: number; inFlight: number; confirmed: string | null; chain: Promise<unknown> };
const efforts = new Map<string, EffortQueue>();
const waiters = new Map<string, (() => void)[]>();
/** Per-task counts: saves in flight (a model or permission change counts one each, an effort queue one while it runs),
 *  held sends and held permission-menu opens. A count reaching zero is what clears the shared busy state. */
const count = (counts: Map<string, number>, id: string, step: 1 | -1): number => {
  const next = (counts.get(id) ?? 0) + step;
  if (next > 0) counts.set(id, next); else counts.delete(id);
  return next;
};
const savesBusy = new Map<string, number>();
function busy(id: string, step: 1 | -1): void {
  const next = count(savesBusy, id, step);
  if (step === 1 && next === 1) hooks.setBusy(id, true);
  if (step === -1 && next === 0) hooks.setBusy(id, false);
}
const sendsHeld = new Map<string, number>();
const opensHeld = new Set<string>();
/** The task's last refused change, kept until its next pick starts, so whatever waited on it can say what wasn't changed. */
export type Unchanged = { what: 'model' | 'permissions' | 'effort'; reason: string };
const refused = new Map<string, Unchanged>();
/** Whether this refusal still needs saying for what it held back: true once per refused change, so several held
 *  presses of Enter (or a send and a board start) show one notice. */
const announced = new WeakSet<Unchanged>();
export function announce(refusal: Unchanged): boolean {
  if (announced.has(refusal)) return false;
  announced.add(refusal);
  return true;
}
/** "the model wasn't changed (reason)", for notices about something held back by a refused change. */
export const unchangedText = ({ what, reason }: Unchanged): string =>
  `${what === 'permissions' ? 'the permissions weren’t' : `the ${what} wasn’t`} changed${reason ? ` (${reason})` : ''}`;

export const saving = (id: string): boolean => switches.has(id) || efforts.has(id);
/** Whether the task's send button or model trigger should show it is held (aria-busy). */
export const sendHeld = (id: string): boolean => sendsHeld.has(id);
export const triggerBusy = (id: string): boolean => (switches.has(id) && !modesSaving.has(id)) || opensHeld.has(id);
/** Whether the task's permissions button should show its pick is saving (aria-busy). */
export const modeBusy = (id: string): boolean => modesSaving.has(id) || modeOpensHeld.has(id);
const modesSaving = new Set<string>();
const modeOpensHeld = new Map<string, number>();

/* ----- Busy pulses ----- */
/** Pulses under `root` (a redrawn trigger or composer, or a control just marked busy) join the shared `state-pulse`
 *  phase now. motion.ts syncPulses aligns each on its first animationstart, a frame late, so a repaint mid-save showed
 *  its pulse back at the start of the cycle for a frame: a blink on every redraw. Reduced motion has none to align. */
export function joinPulses(root: Element | null | undefined): void {
  for (const animation of root?.getAnimations({ subtree: true }) ?? []) {
    if ((animation as CSSAnimation).animationName === 'state-pulse' && animation.startTime !== 0) animation.startTime = 0;
  }
}

function wake(id: string): void {
  if (saving(id)) return;
  const waiting = waiters.get(id) ?? [];
  waiters.delete(id);
  waiting.forEach(resolve => resolve());
}

/** Waits until the task's model, permission and effort changes have landed; then what was refused, if anything (each
 *  refusal is already rolled back and reported). */
export async function settledChange(id: string): Promise<Unchanged | null> {
  await switches.get(id);
  if (saving(id)) await new Promise<void>(resolve => waiters.set(id, [...(waiters.get(id) ?? []), resolve]));
  return refused.get(id) ?? null;
}
/** As settledChange: whether everything that was saving saved. */
export const settled = async (id: string): Promise<boolean> => !await settledChange(id);

/* ----- Keeping a pick on screen through a task listing read before it saved ----- */
/** The task fields each kind of pick writes. */
type ChoiceField = 'provider' | 'model' | 'reasoningEffort' | 'codexSettings' | 'contextUsage' | 'mode';
const MODEL_FIELDS: readonly ChoiceField[] = ['provider', 'model', 'reasoningEffort', 'codexSettings', 'contextUsage'];
const CHOICE_FIELDS: readonly ChoiceField[] = [...MODEL_FIELDS, 'mode'];
/** Counts every pick's write to a task, and for each task the count at each field's last write. */
let writes = 0;
const written = new Map<string, ReadonlyMap<ChoiceField, number>>();
/** Model changes saving (not permission ones, which share `switches`). */
const modelsSaving = new Set<string>();
/** Holds a newer copy of the task and marks the fields this pick wrote. */
function put(task: Session, fields: readonly ChoiceField[]): void {
  writes += 1;
  written.set(task.id, new Map([...(written.get(task.id) ?? []), ...fields.map(field => [field, writes] as const)]));
  hooks.put(task);
}
/** Where a task listing starts: a pick written after this is newer than what the listing reads. */
export const listingStamp = (): number => writes;
/** A task as a listing read it (`since`: its `listingStamp()`), keeping the fields a pick wrote after it was read or is
 *  still saving: native stores a pick a little later, so an earlier read would put the old model back on screen. */
export function heldChoices(listed: Session, since: number): Session {
  const local = hooks.task(listed.id), marks = written.get(listed.id);
  if (!local || (!marks && !saving(listed.id))) return listed;
  const savingField = (field: ChoiceField) => field === 'mode' ? modesSaving.has(listed.id)
    : modelsSaving.has(listed.id) || (field === 'reasoningEffort' && efforts.has(listed.id));
  const kept = CHOICE_FIELDS.filter(field => savingField(field) || (marks?.get(field) ?? 0) > since);
  return kept.length ? { ...listed, ...Object.fromEntries(kept.map(field => [field, local[field]])) } : listed;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Saves a model or permission change: `save` resolves whether it saved, `after` repaints. Waiters resume after `after`,
 *  which runs (and wakes them) even when `save` throws; a throw counts as not saved and is reported. */
export function switchModel(id: string, save: () => Promise<boolean>, after: (saved: boolean) => void): Promise<boolean> {
  busy(id, 1);
  const run = (async () => {
    let saved = false;
    try { saved = await save(); } catch (error) { console.error(error); hooks.notify(message(error)); } finally {
      busy(id, -1); switches.delete(id);
      try { after(saved); } finally { wake(id); }
    }
    return saved;
  })();
  switches.set(id, run);
  return run;
}

/** A model pick: `warm` asks native to start it ahead (a main thread's own pick only); `local`: on this computer. */
export type ModelChoice = { provider: ProviderId; model: string; warm: boolean; local: boolean };
/** A plain model leaves a named team. Runs before the configure, which refuses a
 *  task its team manages, and describes the team it left ("team Reviewers", "its team"), if any. */
async function leaveTeam(id: string): Promise<string | null> {
  const team = hooks.team(id);
  if (!team?.rosterOnly) return null;
  await call<TeamSnapshot | null>('architect_configure', { sessionId: id, config: null, architect: null, profileId: null });
  hooks.teamChanged({ sessionId: id, removed: true });
  return team.name ? `team ${team.name}` : 'its team';
}
/** After the durable configure: the account binding a new harness can't use, the automatic team's roster, the default. */
async function settlePick(id: string, choice: ModelChoice, harness: boolean): Promise<void> {
  // Same-harness model choices keep the account and its resumable conversation.
  if (choice.local && harness) await hooks.releaseAccount(id);
  // An automatic team keeps its limits but learns about newly installed models.
  const auto = hooks.team(id);
  if (auto?.auto && !auto.rosterOnly) {
    const team = await call<TeamSnapshot | null>('architect_configure', { sessionId: id, config: await hooks.autoTeam(auto), architect: null, profileId: null });
    hooks.teamChanged(team ?? { sessionId: id, removed: true });
  }
  hooks.remember(choice);
}
/** A model the user picked: shown at once, then saved (team removal, configure, then `settlePick`). If the configure
 *  fails, only the task's own model fields go back (a title or status that changed meanwhile stays) and the notice
 *  names the model it is back on and any team it left. `ui.repaint` runs once the save is done. */
export function pickModel(id: string, choice: ModelChoice, ui: { show(): void; repaint(saved: boolean, harness: boolean): void }): Promise<boolean> {
  const previous = hooks.task(id);
  if (!previous) return Promise.resolve(false);
  let previousEffort = previous.reasoningEffort;
  const harness = choice.provider !== previous.provider;
  sentWarm.delete(id); refused.delete(id);
  modelsSaving.add(id);
  const run = switchModel(id, async () => {
    // A model picked while an effort change saves goes after it, so the effort reply can't land on the new model.
    for (let queue = efforts.get(id); queue; queue = efforts.get(id)) {
      await queue.chain;
      previousEffort = hooks.task(id)?.reasoningEffort;
    }
    let left: string | null = null;
    try {
      left = await leaveTeam(id);
      put(await call<Session>('configure_session', { sessionId: id, provider: choice.provider, model: choice.model, ...warmArg(choice.warm) }), MODEL_FIELDS);
    } catch (error) {
      console.error(error);
      const restored = { ...(hooks.task(id) ?? previous), provider: previous.provider, model: previous.model, reasoningEffort: previousEffort, codexSettings: previous.codexSettings, contextUsage: previous.contextUsage };
      put(restored, MODEL_FIELDS);
      hooks.notify(`Model not changed — still on ${hooks.label(restored)}${left ? `; the task left ${left}` : ''}: ${message(error)}`);
      refused.set(id, { what: 'model', reason: message(error) });
      return false;
    }
    try { await settlePick(id, choice, harness); } catch (error) { console.error(error); hooks.notify(message(error)); }
    return true;
  }, saved => { modelsSaving.delete(id); ui.repaint(saved, harness); });
  // Shown once the save is registered, so the repaint already marks the trigger busy.
  // A new harness or model starts at its default effort; the same model keeps its effort, as native does.
  const sameModel = !harness && (choice.model || 'default') === (previous.model || 'default');
  put({ ...previous, provider: choice.provider, model: choice.model, reasoningEffort: sameModel ? previous.reasoningEffort : null, codexSettings: harness ? null : previous.codexSettings, contextUsage: sameModel ? previous.contextUsage : null }, MODEL_FIELDS);
  ui.show();
  return run;
}

/** What a pick of effort or permissions repaints, and whether it may warm the task (a main thread's own pick only). */
type PickUi = { warm: boolean; paint(): void };
/** Puts a changed field on the task as held now (a title or status that changed meanwhile stays) and repaints. */
function setField(id: string, patch: Partial<Pick<Session, ChoiceField>>, ui: PickUi): void {
  const now = hooks.task(id); if (!now) return;
  put({ ...now, ...patch }, Object.keys(patch) as ChoiceField[]); ui.paint();
}

/** Permissions the user picked: shown at once with the button busy, saved behind; a refusal restores them and says so. */
export function pickMode(id: string, mode: Session['mode'], ui: PickUi & { name(mode: Session['mode']): string; trigger(): HTMLElement | null }): Promise<boolean> {
  const before = hooks.task(id)?.mode ?? mode;
  modesSaving.add(id); refused.delete(id);
  const run = switchModel(id, async () => {
    try { await call('update_session', { sessionId: id, mode, ...warmArg(ui.warm) }); return true; } catch (error) {
      console.error(error);
      setField(id, { mode: before }, ui);
      hooks.notify(`Permissions not changed — still ${ui.name(before)}: ${message(error)}`);
      refused.set(id, { what: 'permissions', reason: message(error) });
      return false;
    }
  }, () => { modesSaving.delete(id); ui.trigger()?.removeAttribute('aria-busy'); });
  setField(id, { mode }, ui);
  ui.trigger()?.setAttribute('aria-busy', 'true');
  return run;
}

/** An effort the user picked: shown at once and queued behind any before it (`saveEffort`). A refusal of the newest
 *  choice says which effort stays: in the picker if it is open (the thrown error), else as a notice. */
export async function pickEffort(id: string, effort: string | null, ui: PickUi): Promise<void> {
  refused.delete(id);
  try {
    await saveEffort(id, effort, {
      initial: hooks.task(id)?.reasoningEffort ?? null,
      request: () => call<Session>('set_reasoning_effort', { sessionId: id, reasoningEffort: effort, ...warmArg(ui.warm) }),
      confirmed: updated => updated.reasoningEffort ?? null,
      paint: value => setField(id, { reasoningEffort: value }, ui),
    });
  } catch (error) {
    if (error instanceof SupersededEffort) throw error;
    const now = hooks.task(id);
    const failure = new Error(`Effort not changed — still ${now ? hooks.effortName(now) || 'Default' : 'as before'}: ${message(error)}`);
    if (!hooks.pickerShown()) { console.error(error); hooks.notify(failure.message); }
    throw failure;
  }
}

/** An older effort request's refusal, while a newer choice decides: nothing to show or report. */
export class SupersededEffort extends Error {}
/** Saves an effort change behind any before it. Only the newest request's reply paints; its refusal returns to the
 *  last confirmed effort and rethrows (an older request's refusal throws SupersededEffort without painting). */
export async function saveEffort<T>(id: string, effort: string | null, options: {
  initial: string | null; request: () => Promise<T>; confirmed: (reply: T) => string | null; paint: (effort: string | null) => void;
}): Promise<void> {
  const queue = efforts.get(id) ?? { seq: 0, inFlight: 0, confirmed: options.initial, chain: Promise.resolve() };
  const seq = queue.seq + 1;
  const reply = queue.chain.then(options.request);
  efforts.set(id, { ...queue, seq, inFlight: queue.inFlight + 1, chain: reply.catch(() => undefined) });
  if (queue.inFlight === 0) busy(id, 1);
  const latest = () => efforts.get(id)?.seq === seq;
  options.paint(effort);
  try {
    const confirmed = options.confirmed(await reply);
    efforts.set(id, { ...efforts.get(id)!, confirmed });
    if (latest()) options.paint(confirmed);
  } catch (error) {
    if (!latest()) throw new SupersededEffort(error instanceof Error ? error.message : String(error));
    options.paint(efforts.get(id)!.confirmed);
    // A model queued behind this save owns the outcome; its rollback still needs the confirmed effort.
    if (switches.has(id)) throw new SupersededEffort(message(error));
    refused.set(id, { what: 'effort', reason: message(error) });
    throw error;
  } finally {
    const entry = efforts.get(id)!;
    if (entry.inFlight > 1) efforts.set(id, { ...entry, inFlight: entry.inFlight - 1 });
    else { efforts.delete(id); busy(id, -1); wake(id); }
  }
}

/** A send made while the choice saves: held (the button shows it) until it lands; then what was refused, if anything. */
export async function holdSend(id: string, button: () => Element | null): Promise<Unchanged | null> {
  count(sendsHeld, id, 1);
  button()?.setAttribute('aria-busy', 'true'); joinPulses(button());
  try { return await settledChange(id); } finally {
    // Another press of Enter may still be held: the cue stays until the last one ends.
    if (count(sendsHeld, id, -1) === 0) button()?.removeAttribute('aria-busy');
  }
}

/** The model trigger pressed while the choice saves: opens once it lands. The task stays marked until the open is done,
 *  so a transcript reload landing meanwhile waits (`deferTranscript`) rather than closing menus and losing the open. */
export async function holdOpen(id: string, trigger: () => HTMLElement | null, open: () => Promise<void>, signal: AbortSignal): Promise<void> {
  if (opensHeld.has(id) || signal.aborted) return;
  opensHeld.add(id);
  trigger()?.setAttribute('aria-busy', 'true'); joinPulses(trigger());
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    opensHeld.delete(id);
    if (!triggerBusy(id)) trigger()?.removeAttribute('aria-busy');
    signal.removeEventListener('abort', release);
    flushTranscript();
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    await settled(id);
    if (signal.aborted) return;
    // An automatic team's new snapshot repaints the composer on the next frame (scheduleTeamRender): open after it.
    await new Promise(requestAnimationFrame);
    if (!signal.aborted) await open();
  } finally { release(); }
}

/** The permissions button pressed while the choice saves: busy (kept by modeTriggerHtml through a repaint) until it lands. */
export async function holdModeOpen(id: string, trigger: () => HTMLElement | null, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  count(modeOpensHeld, id, 1);
  trigger()?.setAttribute('aria-busy', 'true'); joinPulses(trigger());
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (count(modeOpensHeld, id, -1) === 0 && !modesSaving.has(id)) trigger()?.removeAttribute('aria-busy');
    signal.removeEventListener('abort', release);
    flushTranscript();
  };
  signal.addEventListener('abort', release, { once: true });
  try { await settledChange(id); } finally { release(); }
}

/** A transcript paint held while a model picker is open or opening; painted when it closes (`flushTranscript`). */
let heldTranscript: (() => void) | undefined;
const pickerBusy = () => hooks.pickerOpening() || opensHeld.size > 0;
export function deferTranscript(paint: () => void): void {
  if (pickerBusy()) heldTranscript = paint; else paint();
}
export function flushTranscript(): void {
  if (!heldTranscript || pickerBusy()) return;
  const paint = heldTranscript; heldTranscript = undefined;
  paint();
}

/* ----- Warming a task's harness once its composer gets a draft ----- */
const sentWarm = new Set<string>();
/** The composer's draft changed: the first text (a sign the user is about to send) asks native to start the task's next
 *  turn ahead (warm_task; native skips a task already warm). Not again until the draft is cleared, the task sends or
 *  its model changes. Failures are ignored: warming is only a head start. */
export function draftChanged(id: string, draft: string): void {
  if (!draft.trim()) { sentWarm.delete(id); return; }
  if (!warmOn()) return;
  if (sentWarm.has(id)) return;
  sentWarm.add(id);
  void call('warm_task', { sessionId: id }).catch(() => undefined);
}
/** The task sent: its next draft may warm again. */
export const sent = (id: string): void => { sentWarm.delete(id); };
