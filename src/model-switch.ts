/**
 * Model, effort and permission changes that show at once and save behind (the model picker's optimistic switch).
 *
 * Per task, model and permission changes save one at a time in pick order (each waits for the one before; one replaced
 * by a newer pick of its kind before its turn is skipped), and effort changes queue the same way, so native stores them
 * in the order they were made. Anything
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
  /** Remembers a saved pick as the next new task's default (local picks only). */
  remember(choice: ModelChoice): void;
};
const nothing = () => undefined;
let hooks: Hooks = {
  setBusy: nothing, pickerOpening: () => false, notify: nothing, task: nothing, put: nothing, team: nothing, teamChanged: nothing,
  autoTeam: base => Promise.resolve(base), releaseAccount: () => Promise.resolve(), label: task => task.model, effortName: task => task.reasoningEffort ?? '',
  remember: nothing,
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

/** Each task's newest model or permission change, resolving to whether it saved: the next change waits for it. */
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
/** Waits holding a refusal's notice for themselves (`holdChange`: a send, a board start, a picker row), and of those the
 *  held sends, whose button shows it. */
const waitsHeld = new Map<string, number>();
/** Concurrent held actions share one notice; a later action gets its own explanation if it is blocked. */
const heldGroups = new Map<string, { refusals?: readonly Unchanged[] }>();
const sendsHeld = new Map<string, number>();
const opensHeld = new Set<string>();
/** A refused change, kept until the task's next pick starts, so whatever waited on it can say what wasn't changed and
 *  what it stays on (`still`: "still on Claude Sonnet", "still Ask"). */
export type Unchanged = { what: 'model' | 'permissions' | 'effort'; reason: string; still: string };
/** Each task's refusals since its last pick started, oldest first: two picks in one queue (permissions, then a model)
 *  can both be refused before what waited on them wakes, and each must be said. */
const refused = new Map<string, readonly Unchanged[]>();
const refuse = (id: string, refusal: Unchanged): void => { refused.set(id, [...(refused.get(id) ?? []), refusal]); };
/** A refusal's own notice, held back because a held wait says it (with what stays) instead: one notice, not two. */
const unsaid = new WeakMap<Unchanged, string>();
/** Refusals a held wait has been handed (`holdChange`): it says them. */
const heldBack = new WeakSet<Unchanged>();
/** Says a refusal now (and marks it said, so nothing that waited on it says it again), unless a held wait will. */
function sayRefusal(id: string, refusal: Unchanged, notice: string): void {
  if (announced.has(refusal) || heldBack.has(refusal)) return;
  if (waitsHeld.has(id)) unsaid.set(refusal, notice);
  else if (announce(refusal)) hooks.notify(notice);
}
/** A new pick starts: the last refusals go, each said now if a held wait meant to say it but was never handed it (a
 *  newer pick replaced it before the wait ended). */
function clearRefusal(id: string): void {
  const kept = refused.get(id) ?? [];
  refused.delete(id);
  for (const refusal of kept) {
    const notice = unsaid.get(refusal);
    if (notice && !heldBack.has(refusal) && announce(refusal)) hooks.notify(notice);
  }
}
/** Whether this refusal still needs saying for what it held back: true once per refused change, so several held
 *  presses of Enter (or a send and a board start) show one notice. */
const announced = new WeakSet<Unchanged>();
/** An explicit group also claims its shared notice, even if an earlier action said the refusal itself. */
export function announce(refusal: Unchanged, group?: readonly Unchanged[]): boolean {
  if (group) saidGroups.add(group);
  if (announced.has(refusal)) return false;
  announced.add(refusal);
  return true;
}
/** "the model wasn't changed (reason); still on X", for notices about something held back by a refused change. */
export function unchangedText({ what, reason, still }: Unchanged, own = false): string {
  const subject = own ? `${what[0].toUpperCase()}${what.slice(1)} not` : what === 'permissions' ? 'the permissions weren’t' : `the ${what} wasn’t`;
  const because = reason.trim().replace(/\.+$/, '');
  return `${subject} changed${because ? ` (${because})` : ''}${still ? `; ${still}` : ''}`;
}
/** Every refusal a wait was handed, in order: "the permissions weren't changed (…); still Ask; and the model wasn't…". */
export const refusalsText = (refusals: readonly Unchanged[]): string => refusals.map(refusal => unchangedText(refusal)).join('; and ');
/** What held actions should say: fresh refusals, or what still blocks them if those were already said.
 *  Concurrent actions share one array from holdChange, so only the first says it. */
const saidGroups = new WeakSet<readonly Unchanged[]>();
export function unsaidText(refusals: readonly Unchanged[]): string | null {
  if (!refusals.length || saidGroups.has(refusals)) return null;
  saidGroups.add(refusals);
  const fresh = refusals.filter(refusal => announce(refusal));
  return refusalsText(fresh.length ? fresh : refusals);
}

export const saving = (id: string): boolean => switches.has(id) || efforts.has(id);
/** Whether the task's send button or model trigger should show it is held (aria-busy). */
export const sendHeld = (id: string): boolean => sendsHeld.has(id);
export const triggerBusy = (id: string): boolean => modelsSaving.has(id) || opensHeld.has(id);
/** Whether the task's permissions button should show its pick is saving (aria-busy). */
export const modeBusy = (id: string): boolean => modesSaving.has(id) || modeOpensHeld.has(id);
/** Permission changes saving per task: a count, so the first of two to finish leaves the button busy for the other. */
const modesSaving = new Map<string, number>();
const modeOpensHeld = new Map<string, number>();

/* ----- Busy pulses ----- */
const BUSY = '[aria-busy="true"]';
/** Pulses under `root` (a redrawn trigger or composer, or a control just marked busy) join the shared `state-pulse`
 *  phase now. motion.ts syncPulses aligns each on its first animationstart, a frame late, so a repaint mid-save showed
 *  its pulse back at the start of the cycle for a frame: a blink on every redraw. Reduced motion has none to align. */
export function joinPulses(root: Element | null | undefined): void {
  // Only busy controls pulse here: a render with none skips walking every animation under the root.
  if (!root || !(root.matches(BUSY) || root.querySelector(BUSY))) return;
  for (const animation of root.getAnimations({ subtree: true })) {
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
  return (await settledRefusals(id)).at(-1) ?? null;
}
/** As settledChange: every change refused since the task's last pick started (none: everything saved). */
async function settledRefusals(id: string): Promise<readonly Unchanged[]> {
  await switches.get(id);
  if (saving(id)) await new Promise<void>(resolve => waiters.set(id, [...(waiters.get(id) ?? []), resolve]));
  return refused.get(id) ?? [];
}
/** As settledChange: whether everything that was saving saved. */
export const settled = async (id: string): Promise<boolean> => !await settledChange(id);

/* ----- Keeping a pick on screen through a task read before it saved ----- */
/** The task fields each kind of pick writes. */
export type ChoiceField = 'provider' | 'model' | 'reasoningEffort' | 'codexSettings' | 'contextUsage' | 'resumeId' | 'goalState' | 'mode';
const MODEL_FIELDS: readonly ChoiceField[] = ['provider', 'model', 'reasoningEffort', 'codexSettings', 'contextUsage', 'resumeId', 'goalState'];
const CHOICE_FIELDS: readonly ChoiceField[] = [...MODEL_FIELDS, 'mode'];
/** Counts every pick's write to a task, and for each task the count at each field's last write. Marks only matter to
 *  a read that began before them, so they are kept only while a read is open (`openReads`) and pruned as reads end. */
let writes = 0;
const written = new Map<string, ReadonlyMap<ChoiceField, number>>();
/** Native task reads in flight (`beginRead`), by read: the write count when each began. */
const openReads = new Map<symbol, number>();
/** Model changes saving per task (not permission ones, which share `switches`): a count, so the first of two picks
 *  to finish does not stop holding the fields the other still saves. */
const modelsSaving = new Map<string, number>();
/** Each task's newest model pick: an older one's reply or refusal must not paint over it. */
const latestPick = new Map<string, symbol>();
/** Whether the active queued model pick kept the previous model's effort (e.g. leaving a named team for its lead). */
const modelKeepsEffort = new Map<string, boolean>();
/** While a task's model picks save: the task as native last confirmed it (before the first pick, then each saved
 *  reply), which a refused pick goes back to (not an older pick that was only shown, or itself refused). */
const modelBase = new Map<string, Session>();
/** The same for permission picks: each task's newest one, and the permissions native last confirmed. */
const latestMode = new Map<string, symbol>();
const modeBase = new Map<string, Session['mode']>();
/** The team an older model pick left while a newer pick waited (whether native then stored or refused the older one):
 *  the newer pick's refusal says so, since the task is out of the team whatever it ends up on. */
const leftTeams = new Map<string, string>();
/** While a task's model picks save: native's task before the first of them, and the newest of them native stored. Only
 *  the last pick settles the run of picks (account binding, automatic team, default), against where native started. */
const runStart = new Map<string, Session>();
const storedPick = new Map<string, ModelChoice>();
/** Marks the fields a pick wrote to a task (for the reads already open). */
function mark(id: string, fields: readonly ChoiceField[]): void {
  writes += 1;
  if (openReads.size) written.set(id, new Map([...(written.get(id) ?? []), ...fields.map(field => [field, writes] as const)]));
}
/** Holds a newer copy of the task and marks the fields this pick wrote. A task deleted meanwhile is never added back. */
function put(task: Session, fields: readonly ChoiceField[]): void {
  if (!hooks.task(task.id)) return;
  mark(task.id, fields);
  hooks.put(task);
}
/** Drops marks no open read began before (and with no read open, all of them): a later read sees them already. */
function pruneWritten(): void {
  if (!openReads.size) { written.clear(); return; }
  const oldest = Math.min(...openReads.values());
  for (const [id, marks] of written) {
    const kept = [...marks].filter(([, at]) => at > oldest);
    if (!kept.length) written.delete(id);
    else if (kept.length < marks.size) written.set(id, new Map(kept));
  }
}
/** Per-task pick state a deleted task must not keep (in-flight counts end with their saves). */
const perTask = (): readonly { has(id: string): boolean; delete(id: string): boolean }[] =>
  [written, modelBase, latestPick, modelKeepsEffort, leftTeams, runStart, storedPick, accountReleased, latestMode, modeBase, refused, sentWarm];
/** Tasks deleted: their marks and pick state go, so a pick still in flight acts as replaced (it shows and says nothing). */
export function forgetTasks(ids: Iterable<string>): void { for (const id of ids) perTask().forEach(map => map.delete(id)); }
/** Whether any pick state is kept for the task (for tests: a deleted task keeps none). */
export const remembersTask = (id: string): boolean => perTask().some(map => map.has(id));
/** How many tasks carry marks (for tests: they must not pile up). */
export const markedTasks = (): number => written.size;
/** A task as a read begun at `since` saw it, keeping the fields a pick wrote after the read began or is still saving:
 *  native stores a pick a little later, so an earlier read would put the old model back on screen. `owned` are the
 *  fields the read's own command wrote (`fieldsWrittenBy`): its reply is what native stored for them, so they pass. */
function heldChoices(listed: Session, since: number, owned: readonly ChoiceField[] = []): Session {
  const local = hooks.task(listed.id), marks = written.get(listed.id);
  if (!local || (!marks && !saving(listed.id))) return listed;
  const savingField = (field: ChoiceField) => field === 'mode' ? modesSaving.has(listed.id)
    : modelsSaving.has(listed.id) || (field === 'reasoningEffort' && efforts.has(listed.id));
  const kept = CHOICE_FIELDS.filter(field => !owned.includes(field) && (savingField(field) || (marks?.get(field) ?? 0) > since));
  return kept.length ? { ...listed, ...Object.fromEntries(kept.map(field => [field, local[field]])) } : listed;
}
/** A native read of tasks (a listing, get_task, or any command answering with the updated task) about to start: `hold`
 *  each task it brings before putting it in state, and `end` it once they are in (twice is harmless). */
export type TaskRead = { hold(task: Session): Session; end(): void };
export function beginRead(owned: readonly ChoiceField[] = []): TaskRead {
  const key = Symbol('read'), since = writes;
  openReads.set(key, since);
  return {
    hold: task => heldChoices(task, since, owned),
    end: () => { if (openReads.delete(key)) pruneWritten(); },
  };
}
/** The pick fields a native command itself writes, so its reply is authoritative for them: a speed, plan or fast
 *  change (set_task_preference) answers with the task's new codexSettings, which a model change saving meanwhile must
 *  not mask with the copy held before it; a configure or effort change made through taskCall likewise answers with
 *  the model or effort it stored. */
const WRITES: Readonly<Record<string, readonly ChoiceField[]>> = {
  set_task_preference: ['codexSettings'],
  // A bot's, a side thread's or another computer's model, or a project move: native's reply is the model it stored.
  configure_session: MODEL_FIELDS,
  set_reasoning_effort: ['reasoningEffort'],
};
export const fieldsWrittenBy = (command: string): readonly ChoiceField[] => WRITES[command] ?? [];
/** Whether a native reply is a task (get_task, an update's answer) rather than something else a command returns. */
const isTask = (value: unknown): value is Session => typeof value === 'object' && value !== null
  && typeof (value as Session).id === 'string' && typeof (value as Session).provider === 'string' && 'model' in value;
/** A native call (`read` starts it) whose reply may be a task or a list of tasks: each comes back with the fields a pick
 *  still saving, or written while the call ran, kept, except those the call itself wrote (`owned`, from
 *  `fieldsWrittenBy`). Any other reply is returned as it is. */
export async function readTasks<T>(read: () => Promise<T>, owned: readonly ChoiceField[] = []): Promise<T> {
  const open = beginRead(owned);
  try {
    const reply = await read();
    const hold = (value: unknown) => isTask(value) ? open.hold(value) : value;
    return (Array.isArray(reply) ? reply.map(hold) : hold(reply)) as T;
  } finally { open.end(); }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Saves a model or permission change after the task's previous one has landed (so native gets them in pick order):
 *  `save` resolves whether it saved, `after` repaints. Waiters resume after the last change's `after`, which runs (and
 *  wakes them) even when `save` throws; a throw counts as not saved and is reported. An `after` that throws is logged:
 *  the change still resolves whether it saved, and the next one still runs. */
export function switchModel(id: string, save: () => Promise<boolean>, after: (saved: boolean) => void): Promise<boolean> {
  busy(id, 1);
  // The newest change holds the task's slot until it lands, so saving() stays true until every change has settled.
  const before = switches.get(id);
  let run: Promise<boolean> | undefined, done = false;
  run = (async () => {
    // The previous change reported its own outcome: this one runs whatever it was.
    if (before) await before.catch(() => false);
    let saved = false;
    try { saved = await save(); } catch (error) { console.error(error); hooks.notify(message(error)); } finally {
      done = true;
      busy(id, -1); if (switches.get(id) === run) switches.delete(id);
      try { after(saved); } catch (error) { console.error(error); } finally { wake(id); }
    }
    return saved;
  })();
  if (!done) switches.set(id, run);
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
/** Tasks whose account binding a pick in the current run of picks already released: a newer pick settling the run
 *  after it does not release it again. */
const accountReleased = new Set<string>();
/** After the durable configure: the account binding a new harness can't use, the automatic team's roster, the default.
 *  `latest`: the pick is still the task's newest; a newer one picked during an await here settles the run itself, so
 *  this stops there (false) rather than refreshing the team or remembering the default twice. */
async function settlePick(id: string, choice: ModelChoice, harness: boolean, latest: () => boolean): Promise<boolean> {
  // Same-harness model choices keep the account and its resumable conversation.
  if (choice.local && harness && !accountReleased.has(id)) {
    await hooks.releaseAccount(id);
    // A deleted task (forgetTasks drops latestPick) keeps nothing.
    if (latestPick.has(id)) accountReleased.add(id);
  }
  if (!latest()) return false;
  // An automatic team keeps its limits but learns about newly installed models.
  const auto = hooks.team(id);
  if (auto?.auto && !auto.rosterOnly) {
    const config = await hooks.autoTeam(auto);
    if (!latest()) return false;
    const team = await call<TeamSnapshot | null>('architect_configure', { sessionId: id, config, architect: null, profileId: null });
    // What native now has, whoever settles next.
    hooks.teamChanged(team ?? { sessionId: id, removed: true });
    if (!latest()) return false;
  }
  hooks.remember(choice);
  return true;
}
/** A model the user picked: shown at once, then saved (team removal, configure, then `settlePick`). If the configure
 *  fails, only the task's own model fields go back (a title or status that changed meanwhile stays) and the notice
 *  names the model it is back on and any team it (or an older pick) left. A pick replaced by a newer one before its
 *  turn is skipped (resolving false): the newer one saves instead. `ui.repaint` runs once the save is done, told
 *  whether the harness changed from the one native had. */
export function pickModel(id: string, choice: ModelChoice, ui: { show(): void; repaint(saved: boolean, harness: boolean): void }): Promise<boolean> {
  const previous = hooks.task(id);
  if (!previous) return Promise.resolve(false);
  // Whether native's harness changed over the run of picks: told by the pick that settles it, false for a replaced one.
  let harness = false;
  sentWarm.delete(id); clearRefusal(id);
  count(modelsSaving, id, 1);
  if (!modelBase.has(id)) { modelBase.set(id, previous); runStart.set(id, previous); }
  const pick = Symbol('pick');
  latestPick.set(id, pick);
  const superseded = () => latestPick.get(id) !== pick;
  /** The task with a newer pick's model fields, as shown, kept over `task`. */
  const keepNewer = (task: Session): Session => {
    const shown = hooks.task(id);
    return shown ? { ...task, ...Object.fromEntries(MODEL_FIELDS.map(field => [field, shown[field]])) } : task;
  };
  const run = switchModel(id, async () => {
    // What a refusal goes back to: native's model once the picks before this one have landed.
    const base = modelBase.get(id) ?? previous, start = runStart.get(id) ?? previous;
    // Replaced before its turn: the newer pick saves instead (no configure, no warm start).
    if (superseded()) return false;
    // A model picked while an effort change saves goes after it, so the effort reply can't land on the new model.
    for (let queue = efforts.get(id); queue; queue = efforts.get(id)) {
      await queue.chain;
    }
    const previousEffort = (modelBase.get(id) ?? base).reasoningEffort;
    if (superseded()) return false;
    const saved = await configure(base, previousEffort);
    // Replaced while it saved: the newer pick settles the run, so nothing here (account, team, default, reload).
    if (superseded()) return saved;
    // The last pick settles what native now has: itself, or (refused) the newest pick before it that native stored.
    const kept = storedPick.get(id);
    if (kept) {
      harness = kept.provider !== start.provider;
      // Replaced while it settled: the newer pick finishes settling and reloads the thread, not this one as well.
      try { if (!await settlePick(id, kept, harness, () => !superseded())) harness = false; } catch (error) { console.error(error); hooks.notify(message(error)); }
    }
    return saved;
  }, saved => {
    count(modelsSaving, id, -1);
    if (!superseded()) [latestPick, modelBase, modelKeepsEffort, leftTeams, runStart, storedPick, accountReleased].forEach(map => map.delete(id));
    ui.repaint(saved, harness);
  });
  /** Team removal and the durable configure; a refusal (unless a newer pick decides) goes back to `base` and says so. */
  async function configure(base: Session, previousEffort: Session['reasoningEffort']): Promise<boolean> {
    // A deleted task (forgetTasks) drops latestPick: nothing is kept for it.
    const live = () => latestPick.has(id);
    let left: string | null = null;
    try {
      left = await leaveTeam(id);
      const effortBase = modelBase.get(id);
      // task-read-guard: ok the pick's own reply, put with its fields marked
      const saved = await call<Session>('configure_session', { sessionId: id, provider: choice.provider, model: choice.model, ...warmArg(choice.warm) });
      // saveEffort replaces this base when an effort saves while configure's reply is in flight.
      const confirmed = modelBase.get(id), effortChanged = Boolean(confirmed && confirmed !== effortBase);
      if (modelBase.has(id)) modelBase.set(id, effortChanged ? { ...saved, reasoningEffort: confirmed?.reasoningEffort } : saved);
      if (live()) storedPick.set(id, choice);
      const now = hooks.task(id);
      // The model reply predates queued permissions and effort; those picks own what is shown.
      put({ ...(superseded() ? keepNewer(saved) : saved),
        ...(now && modesSaving.has(id) ? { mode: now.mode } : {}),
        ...(now && (efforts.has(id) || effortChanged) ? { reasoningEffort: now.reasoningEffort } : {}),
      }, MODEL_FIELDS);
      // Should the newer pick be refused, its notice says the task left this team.
      if (left && superseded() && live()) leftTeams.set(id, left);
      return true;
    } catch (error) {
      console.error(error);
      // A newer pick is saving: its outcome decides what shows, and it reports its own refusal (and this team left).
      if (superseded()) { if (left && live()) leftTeams.set(id, left); return false; }
      left ??= leftTeams.get(id) ?? null;
      const now = hooks.task(id) ?? base;
      const confirmed = modelBase.get(id) ?? base;
      // The pick only cleared codexSettings for a new harness; on the same one a speed change saved meanwhile stays.
      const restored = { ...now, provider: base.provider, model: base.model, reasoningEffort: efforts.has(id) ? now.reasoningEffort : confirmed !== base ? confirmed.reasoningEffort : previousEffort, codexSettings: choice.provider !== base.provider ? base.codexSettings : now.codexSettings, contextUsage: base.contextUsage, resumeId: base.resumeId, goalState: base.goalState };
      put(restored, MODEL_FIELDS);
      const still = `still on ${hooks.label(restored)}${left ? `; the task left ${left}` : ''}`;
      const refusal: Unchanged = { what: 'model', reason: message(error), still };
      refuse(id, refusal);
      sayRefusal(id, refusal, unchangedText(refusal, true));
      return false;
    }
  }
  // Shown once the save is registered, so the repaint already marks the trigger busy.
  // A new harness or model starts at its default effort; the same model keeps its effort, as native does.
  // Back on native's harness after a pending pick to another one: its settings again.
  const native = modelBase.get(id) ?? previous;
  const shownHarness = choice.provider !== previous.provider;
  const sameModel = !shownHarness && (choice.model || 'default') === (previous.model || 'default');
  modelKeepsEffort.set(id, modelKeepsEffort.has(id) ? Boolean(modelKeepsEffort.get(id)) && sameModel : sameModel);
  const continuity = !shownHarness ? previous : choice.provider === native.provider ? native : undefined;
  put({ ...previous, provider: choice.provider, model: choice.model, reasoningEffort: sameModel ? previous.reasoningEffort : null, codexSettings: continuity?.codexSettings ?? null, resumeId: continuity?.resumeId ?? null, goalState: continuity?.goalState ?? null, contextUsage: sameModel ? previous.contextUsage : null }, MODEL_FIELDS);
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
  if (!modeBase.has(id)) modeBase.set(id, hooks.task(id)?.mode ?? mode);
  count(modesSaving, id, 1); clearRefusal(id);
  const pick = Symbol('mode');
  latestMode.set(id, pick);
  const superseded = () => latestMode.get(id) !== pick;
  const run = switchModel(id, async () => {
    // Replaced before its turn: the newer pick saves instead.
    if (superseded()) return false;
    try {
      await call('update_session', { sessionId: id, mode, ...warmArg(ui.warm) });
      if (modeBase.has(id)) modeBase.set(id, mode);
      // Native stored it: a read begun before this, landing after the pick stops saving, must not put the old mode back.
      if (hooks.task(id)) mark(id, ['mode']);
      return true;
    } catch (error) {
      console.error(error);
      // A newer pick is saving: its outcome decides what shows, and it reports its own refusal.
      if (superseded()) return false;
      const before = modeBase.get(id) ?? mode;
      setField(id, { mode: before }, ui);
      const refusal: Unchanged = { what: 'permissions', reason: message(error), still: `still ${ui.name(before)}` };
      refuse(id, refusal);
      sayRefusal(id, refusal, unchangedText(refusal, true));
      return false;
    }
  }, () => {
    if (!superseded()) { latestMode.delete(id); modeBase.delete(id); }
    if (count(modesSaving, id, -1) === 0 && !modeOpensHeld.has(id)) ui.trigger()?.removeAttribute('aria-busy');
  });
  setField(id, { mode }, ui);
  ui.trigger()?.setAttribute('aria-busy', 'true'); joinPulses(ui.trigger());
  return run;
}

/** An effort the user picked: shown at once and queued behind any before it (`saveEffort`). A refusal of the newest
 *  choice says which effort stays: in the picker if it is open (the thrown error), else as a notice. */
export async function pickEffort(id: string, effort: string | null, ui: PickUi & { /** The originating picker can still show this refusal. */ pickerShown?(): boolean }): Promise<void> {
  clearRefusal(id);
  const still = () => { const now = hooks.task(id); return now ? `still ${hooks.effortName(now) || 'Default'}` : ''; };
  try {
    await saveEffort(id, effort, {
      initial: hooks.task(id)?.reasoningEffort ?? null,
      // task-read-guard: ok the effort queue's own reply, confirmed and painted by saveEffort
      request: () => call<Session>('set_reasoning_effort', { sessionId: id, reasoningEffort: effort, ...warmArg(ui.warm) }),
      confirmed: updated => updated.reasoningEffort ?? null,
      paint: value => setField(id, { reasoningEffort: value }, ui),
      still,
    });
  } catch (error) {
    if (error instanceof SupersededEffort) throw error;
    const failure = new Error(unchangedText({ what: 'effort', reason: message(error), still: still() || 'as before' }, true));
    const refusal = refused.get(id)?.at(-1);
    if (!ui.pickerShown?.()) {
      console.error(error);
      if (refusal) sayRefusal(id, refusal, failure.message); else hooks.notify(failure.message);
    }
    throw failure;
  }
}

/** An older effort request's refusal, while a newer choice decides: nothing to show or report. */
export class SupersededEffort extends Error {}
/** Saves an effort change behind any before it. Only the newest request's reply paints; its refusal returns to the
 *  last confirmed effort and rethrows (an older request's refusal throws SupersededEffort without painting). */
export async function saveEffort<T>(id: string, effort: string | null, options: {
  initial: string | null; request: () => Promise<T>; confirmed: (reply: T) => string | null; paint: (effort: string | null) => void;
  /** What the effort stays on once a refusal is painted back ("still High"), for whatever it held back. */
  still?: () => string;
}): Promise<void> {
  const queue = efforts.get(id) ?? { seq: 0, inFlight: 0, confirmed: options.initial, chain: Promise.resolve() };
  const seq = queue.seq + 1;
  const pickAtStart = latestPick.get(id);
  const reply = queue.chain.then(options.request);
  efforts.set(id, { ...queue, seq, inFlight: queue.inFlight + 1, chain: reply.catch(() => undefined) });
  if (queue.inFlight === 0) busy(id, 1);
  const latest = () => efforts.get(id)?.seq === seq;
  // A different model queued behind this effort owns the shown effort (null); don't clobber it in state or UI.
  const queuedNewModel = () => modelsSaving.has(id) && latestPick.get(id) !== pickAtStart && !modelKeepsEffort.get(id);
  options.paint(effort);
  try {
    const confirmed = options.confirmed(await reply);
    efforts.set(id, { ...efforts.get(id)!, confirmed });
    // A model pick saving goes back to the effort native now has, should it be refused.
    const base = modelBase.get(id);
    if (base) modelBase.set(id, { ...base, reasoningEffort: confirmed });
    if (latest() && !queuedNewModel()) options.paint(confirmed);
  } catch (error) {
    if (!latest() || !hooks.task(id)) throw new SupersededEffort(message(error));
    const confirmed = efforts.get(id)!.confirmed;
    const base = modelBase.get(id);
    if (base) modelBase.set(id, { ...base, reasoningEffort: confirmed });
    if (!queuedNewModel()) options.paint(confirmed);
    // A model queued behind this save owns the outcome; its rollback still needs the confirmed effort.
    if (switches.has(id) && latestPick.get(id) !== pickAtStart) throw new SupersededEffort(message(error));
    refuse(id, { what: 'effort', reason: message(error), still: options.still?.() ?? '' });
    throw error;
  } finally {
    const entry = efforts.get(id)!;
    if (entry.inFlight > 1) efforts.set(id, { ...entry, inFlight: entry.inFlight - 1 });
    else { efforts.delete(id); busy(id, -1); wake(id); }
  }
}

/** Something that must follow the choice (a send, a board start, a picker row, a team change) waiting while it saves:
 *  the refusals it lands with are handed to it, held back from their own notices, so it says them in one notice of its
 *  own (`unsaidText`). Resolves to every refusal since the task's last pick (none: everything saved). */
export async function holdChange(id: string): Promise<readonly Unchanged[]> {
  count(waitsHeld, id, 1);
  const group = heldGroups.get(id) ?? {};
  heldGroups.set(id, group);
  try {
    const refusals = await settledRefusals(id);
    refusals.forEach(refusal => heldBack.add(refusal));
    return group.refusals ??= [...refusals];
  } finally { if (count(waitsHeld, id, -1) === 0) heldGroups.delete(id); }
}
/** A send made while the choice saves: held (the button shows it) until it lands; then what was refused (`holdChange`).
 *  `bucket` separates independent send controls that wait on the same choice (e.g. a first `/btw` send vs the main composer). */
export async function holdSend(id: string, button: () => Element | null, bucket = id): Promise<readonly Unchanged[]> {
  count(sendsHeld, bucket, 1);
  button()?.setAttribute('aria-busy', 'true'); joinPulses(button());
  try { return await holdChange(id); } finally {
    // Another press of Enter may still be held: the cue stays until the last one ends.
    if (count(sendsHeld, bucket, -1) === 0) button()?.removeAttribute('aria-busy');
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
