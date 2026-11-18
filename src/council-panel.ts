import { escape, icon, isImeKey, morph } from './dom';
import { reducedMotion, springKeyframes, trackSegment } from './motion';
import { hidePopover, showPopover } from './popover-motion';
import { teamActive, type CouncilConfig, type TeamSnapshot } from './architect-types';
import { COUNCIL_REVIEWERS, COUNCIL_ROUNDS, COUNCIL_TARGETS, councilDefaults, councilForNewThreads, setCouncilForNewThreads, councilAsking, councilNotice, councilProgress, councilStateText, firstAndFinal, finishedBelow, formatScore, outOfTen, provisional, saveCouncilDefaults, seatScore, type CouncilProgress, type CouncilRound, type CouncilSeatWorker } from './council';

/* Council in the composer: the tray's settings button and panel, and one compact strip inside the prompt box (its state,
 * the reviewers on demand, and what to do next). The Agents flyout shows the same state line and rows. */

export type CouncilHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  team(sessionId: string): TeamSnapshot | null;
  /** Whether the thread's team (or that it has none) is known yet: false while it still loads. */
  loaded(sessionId: string): boolean;
  /** Turns on an automatic team; false when nothing changed. May throw with the reason. */
  startTeam(sessionId: string): Promise<boolean>;
  /** A snapshot from native, for the app's usual team update. */
  updated(team: TeamSnapshot): void;
  /** Keep fixing: a follow-up to the lead. Throws with the reason when it cannot go. */
  keepFixing(sessionId: string): Promise<void>;
  /** Settings → Classic team setup: a thread with no team opens that setup rather than starting an automatic team. */
  classicSetup(): boolean;
  openClassicSetup(anchor: HTMLElement): void;
  /** Reads a change aloud through the composer's live region. */
  announce(text: string): void;
};

type Field = keyof CouncilConfig;
const FIELDS: readonly { key: Field; label: string; options: readonly number[]; name(value: number): string }[] = [
  { key: 'target', label: 'Target score', options: COUNCIL_TARGETS, name: formatScore },
  { key: 'maxRounds', label: 'Max rounds', options: COUNCIL_ROUNDS, name: String },
  { key: 'reviewers', label: 'Reviewers', options: COUNCIL_REVIEWERS, name: value => value ? String(value) : 'Auto' },
];
/** Wide enough that "10.0" keeps clear of its segment's edge. */
const PANEL_WIDTH = 300;
const BUTTON = '.composer-council-button';
/** A balance: reviewers weighing the work. Its own glyph, apart from the sidebar's Agent usage. */
const COUNCIL_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16M8 20h8M5 7h14M5 7l-3 6.5a3 3 0 0 0 6 0zM19 7l-3 6.5a3 3 0 0 0 6 0z"/></svg>';
/** The panel's one description, at most two lines: what Council does, then what turning it on means. */
const ABOUT = 'Reviewers score the work until all reach your target.';
/** The strip control whose panel is open (`session:field`), so a redraw of the strip keeps its aria-expanded. */
let expandedOpener = '';
const NOTE_ON = 'Uses more of your plan.';
const NOTE_OFF = 'These settings become your defaults.';
const NOTE_NO_TEAM = 'Starts a team; these become your defaults.';
const AUTO = 'Auto: the lead picks reviewers for the work';
/** Every refusal reads the same in the panel, the strip and announcements. */
const notChanged = (reason: string): string => `Council was not changed: ${reason}`;


/** The team as the composer shows it: native's snapshot, except that a sent Keep fixing reads as running and fixing at once,
 *  until native's snapshot moves on and replaces it. */
function shownTeam(team: TeamSnapshot): TeamSnapshot {
  if (team.councilStatus?.state !== 'asking' || !actions.get(team.sessionId)?.sent) return team;
  return { ...team, status: 'running', error: null, councilStatus: { ...team.councilStatus, state: 'fixing', notice: null } };
}
const settled = (state: string): boolean => state === 'passed' || state === 'accepted' || state === 'limit';
/** The tray button is settings only: on or off, and a cue while asking or once the cycle has settled (not accepted). */
function face(native: TeamSnapshot | null): { label: string; on: boolean; cue: '' | 'asking' | 'settled' } {
  const team = native && shownTeam(native), progress = team && councilProgress(team);
  if (!progress) return { label: 'Council: off', on: false, cue: '' };
  if (councilAsking(progress.status)) return { label: 'Council needs you', on: true, cue: 'asking' };
  const ended = (settled(progress.state) && progress.state !== 'accepted') || finishedBelow(progress, team!);
  return { label: progress.rounds.length ? `Council: ${councilStateText(progress, team!, lowered(team!))}` : `Council: on, target ${formatScore(progress.status.target)}`, on: true, cue: ended ? 'settled' : '' };
}

export function createCouncil(host: CouncilHost) {
  let panel: HTMLElement | undefined, panelSession = '', cleanup: (() => void) | undefined, panelCount = 0;
  /** The control that opened the panel (the composer button, or the strip's Lower target or Raise max rounds). */
  let opener: HTMLElement | undefined;
  /** Places the open panel again when its content changes, so nothing scrolls out of view. */
  let placeNow: (() => void) | undefined;
  /** Per thread: requests in flight, in order (one thread never waits on another's), with the newest asked-for council
   *  shown until they all answer; and a refusal not yet seen in the panel. */
  const pending = new Map<string, { tail: Promise<void>; count: number; asked: CouncilConfig | null }>(), failures = new Map<string, string>();
  /** The rounds this cycle has run: Raise max rounds offers only more than that. */
  const roundsUsed = (sessionId: string): number => { const team = host.team(sessionId), progress = team && councilProgress(team); return Math.max(progress?.status.round ?? 0, progress?.latest?.number ?? 0); };
  const shownConfig = (sessionId: string): CouncilConfig | null => pending.has(sessionId) ? pending.get(sessionId)!.asked : host.team(sessionId)?.config.council ?? null;

  /** The visible thread's state text and scored seats as last seen, so a change is read aloud once. Seeing another
   *  thread (or council turning on) only sets a new baseline: what changed while a thread was not shown is never replayed. */
  let heard: { sessionId: string; text: string; scored: Set<string> } | undefined;
  function observe(sessionId: string): void {
    const native = host.team(sessionId), team = native && shownTeam(native), progress = team && councilProgress(team);
    const text = progress ? councilStateText(progress, team, lowered(team!)) : '', scored = progress?.rounds.flatMap(round => round.seats).filter(seat => seatScore(seat) !== null) ?? [];
    const before = heard?.sessionId === sessionId && heard.text ? heard : undefined;
    heard = { sessionId, text, scored: new Set(scored.map(seat => seat.id)) };
    if (!before || !progress) return;
    const news = scored.filter(seat => !before.scored.has(seat.id)).map(seat => `${seat.council.lens.trim() || seat.name} scored ${outOfTen(seatScore(seat)!, progress.status.target)}`);
    if (text !== before.text) {
      // A new state ends what the strip's last action said (a sent Keep fixing waits for native to leave asking).
      if (!(actions.get(sessionId)?.sent && native!.councilStatus?.state === 'asking')) actions.delete(sessionId);
      const { lowest, state } = progress.status, detail = lowest !== null && (state === 'fixing' || state === 'limit' || state === 'accepted') ? `, lowest ${outOfTen(lowest, progress.status.target)}` : '';
      news.push(`Council: ${text}${detail}${councilAsking(progress.status) ? `. ${councilNotice(team!)}` : ''}`);
    }
    if (news.length) host.announce(news.join('. '));
  }

  function button(sessionId: string): string {
    threadShown(sessionId);
    // The composer is drawing another thread: the panel belongs to the one it left.
    if (panel && panelSession !== sessionId) close();
    if (host.loaded(sessionId)) loaded(sessionId);
    observe(sessionId);
    const { label, on, cue } = face(host.team(sessionId));
    // The composer mounts this markup after it returns.
    faceSoon(sessionId);
    return `<button type="button" class="composer-council-button" data-action="council" data-session-id="${escape(sessionId)}" aria-haspopup="dialog" aria-expanded="${Boolean(panel) && panelSession === sessionId}" aria-busy="${pending.has(sessionId)}" ${on ? 'data-on' : ''} aria-label="${escape(label)}" data-tip="${escape(label)}"><span class="council-glyph" data-cue="${cue}" aria-hidden="true">${COUNCIL_ICON}</span><span class="sr-only">Council</span></button>`;
  }
  /** The strip's slot inside the prompt box: always there (empty while hidden), so the strip updates in place. */
  function strip(sessionId: string): string {
    const team = host.team(sessionId);
    return `<div class="council-strip-slot" data-session-id="${escape(sessionId)}">${team ? stripHtml(team) : ''}</div>`;
  }

  function paint(sessionId: string): void {
    if (!panel || panelSession !== sessionId) return;
    const shown = shownConfig(sessionId), values = shown ?? councilDefaults();
    // One description under the title: what Council does, then what turning it on costs (or, off, what the choices do).
    const about = `${ABOUT} ${shown ? NOTE_ON : host.team(sessionId) ? NOTE_OFF : NOTE_NO_TEAM}`, aboutLine = panel.querySelector<HTMLElement>('#council-about')!;
    if (aboutLine.textContent !== about) aboutLine.textContent = about;
    // Council on, the team resting, and no round yet: say so quietly.
    const team = host.team(sessionId), idle = Boolean(shown && team && !teamActive(team) && !councilProgress(team)?.rounds.length);
    const idleLine = panel.querySelector<HTMLElement>('.council-idle')!;
    if (idleLine.hidden === idle) idleLine.hidden = !idle;
    // Raise max rounds: how many this cycle has used, under its title.
    if (panel.dataset.compact === 'maxRounds') {
      const used = `${roundsUsed(sessionId)} of ${values.maxRounds} rounds used`, usedLine = panel.querySelector<HTMLElement>('#council-maxRounds')!;
      if (usedLine.textContent !== used) usedLine.textContent = used;
    }
    const failure = failures.get(sessionId) ?? '';
    panel.querySelector<HTMLInputElement>('.council-switch')!.checked = Boolean(shown);
    // Which row had focus before this paint (its focused option may be hidden below).
    const hadFocus = document.activeElement?.closest<HTMLElement>('.council-panel [data-field]') ?? null;
    for (const { key, options, name } of FIELDS) {
      const group = panel.querySelector<HTMLElement>(`[data-field="${key}"]`)!;
      // A value set elsewhere (native allows any target, 1-100 rounds) shows as one more, selected option.
      let extra = group.querySelector<HTMLElement>('[data-extra]');
      if (options.includes(values[key])) extra?.remove();
      else {
        if (!extra) { extra = document.createElement('button'); extra.setAttribute('type', 'button'); extra.dataset.extra = ''; }
        extra.dataset.value = String(values[key]); extra.textContent = name(values[key]);
        // In numeric order among the offered options.
        const after = [...group.querySelectorAll<HTMLElement>(':scope > button:not([data-extra])')].find(option => Number(option.dataset.value) > values[key]) ?? null;
        if (extra.nextElementSibling !== after || extra.parentElement !== group) group.insertBefore(extra, after);
      }
      // A value that arrives while the panel is open fades in; the panel's own opening is the first sight.
      motion(sessionId, `panel${panelCount}:extra:${key}`, extra?.isConnected ? extra.dataset.value! : '', extra?.isConnected ? extra : null, element => fade(element));
      let selected: HTMLElement | null = null;
      const buttons = [...group.querySelectorAll<HTMLElement>('button')];
      for (const option of buttons) {
        const on = Number(option.dataset.value) === values[key];
        option.setAttribute('aria-pressed', String(on));
        if (on) selected = option;
      }
      // Compact from the strip: Lower target offers the current target and those below it; Raise max rounds only more rounds
      // than the team has used.
      if (panel.dataset.compact === 'target' && key === 'target') for (const option of buttons) option.hidden = Number(option.dataset.value) >= values.target;
      if (panel.dataset.compact === 'maxRounds' && key === 'maxRounds') for (const option of buttons) option.hidden = Number(option.dataset.value) <= roundsUsed(sessionId);
      // One Tab stop per row: the selected option (else, raising max rounds, your default limit when it is more than the rounds
      // used, else the first shown); arrows move within it.
      // (Lower target: the highest target below the current one.)
      const preferred = panel.dataset.compact === 'maxRounds' && key === 'maxRounds' ? buttons.find(option => !option.hidden && Number(option.dataset.value) === councilDefaults().maxRounds)
        : panel.dataset.compact === 'target' && key === 'target' ? buttons.filter(option => !option.hidden).at(-1) : undefined;
      const stop = selected && !selected.hidden ? selected : preferred ?? buttons.find(option => !option.hidden);
      for (const option of buttons) option.tabIndex = option === stop ? 0 : -1;
      // An option that had focus and is now hidden (Lower target to a value still above the lowest) hands focus to the row's
      // new Tab stop, so focus never drops to <body>.
      const focused = buttons.find(option => option === document.activeElement);
      if (focused?.hidden || (!document.activeElement || document.activeElement === document.body) && hadFocus === group) stop?.focus({ preventScroll: true });
      trackSegment(group, selected);
    }
    const error = panel.querySelector<HTMLElement>('.council-error')!, failed = failure && notChanged(failure);
    if (error.textContent !== failed) error.textContent = failed;
    error.hidden = !failure;
    // Beside Target score: native's current lowest, so lowering it is an informed choice.
    const status = host.team(sessionId)?.councilStatus, lowest = status?.lowest, open = status?.state === 'reviewing' || status?.state === 'dispatch';
    const lowestNote = shown && typeof lowest === 'number' ? ` · lowest ${open ? 'so far' : 'now'} ${formatScore(lowest)}` : '';
    const lowestLine = panel.querySelector<HTMLElement>('.council-lowest')!;
    if (lowestLine.textContent !== lowestNote) lowestLine.textContent = lowestNote;
    panel.querySelector<HTMLInputElement>('.council-new-threads')!.checked = councilForNewThreads();
    // The switch is busy while an automatic team starts for it.
    const sw = panel.querySelector<HTMLInputElement>('.council-switch')!, starting = pending.has(sessionId) && !host.team(sessionId);
    if (sw.getAttribute('aria-busy') !== String(starting)) sw.setAttribute('aria-busy', String(starting));
    placeNow?.();
  }

  /** Keeps the composer's thread's button, strip and open panel on the true state without redrawing the composer. */
  function sync(sessionId: string): void {
    if (panel && panelSession !== sessionId) close();
    if (host.loaded(sessionId)) loaded(sessionId);
    refresh(sessionId);
  }
  /** A compact panel belongs to the strip control that opened it. A redrawn strip hands it the same control; once the
   *  control is gone (the target passed, the limit raised) the panel closes and focus goes to the composer's prompt. */
  function keepOpener(): void {
    if (!panel?.dataset.compact || opener?.isConnected) return;
    const again = document.querySelector<HTMLElement>(`#composer .council-strip [data-council-focus="${panel.dataset.compact}"]`);
    if (again) { opener = again; again.setAttribute('aria-expanded', 'true'); return; }
    opener = undefined;
    close();
    document.querySelector<HTMLElement>('#prompt')?.focus({ preventScroll: true });
  }
  /** Once per frame, on whichever button is mounted then: asking pops the glyph (the composer may rebuild the button). */
  let faceFrame = 0, faceThread = '';
  function faceSoon(sessionId: string): void {
    faceThread = sessionId;
    faceFrame ||= requestAnimationFrame(() => {
      faceFrame = 0;
      const live = document.querySelector<HTMLElement>(BUTTON);
      if (live?.dataset.sessionId !== faceThread) return;
      const { cue } = face(host.team(faceThread));
      motion(faceThread, 'face-cue', cue, live.querySelector<HTMLElement>('.council-glyph'), element => cue === 'asking' ? pop(element) : []);
    });
  }
  function refresh(sessionId: string): void {
    const current = document.querySelector<HTMLElement>(BUTTON);
    if (current?.dataset.sessionId === sessionId) {
      observe(sessionId);
      const { label, on, cue } = face(host.team(sessionId));
      if (current.getAttribute('aria-label') !== label) {
        current.setAttribute('aria-label', label); current.dataset.tip = label;
        // Its tooltip, if showing, follows: the tooltip module has no update call, so the bubble's text changes here and a
        // scroll event (which the module listens for) places it again.
        const bubble = document.querySelector<HTMLElement>('.tip-bubble.tip-visible');
        if (bubble && (current.matches(':hover') || current.contains(document.activeElement))) { bubble.textContent = label; document.dispatchEvent(new Event('scroll')); }
      }
      current.toggleAttribute('data-on', on); current.querySelector<HTMLElement>('.council-glyph')!.dataset.cue = cue;
      current.setAttribute('aria-busy', String(pending.has(sessionId)));
      faceSoon(sessionId);
    }
    const slot = document.querySelector<HTMLElement>(`#composer .council-strip-slot[data-session-id="${CSS.escape(sessionId)}"]`), team = host.team(sessionId);
    if (slot) paintStrip(slot, team);
    paint(sessionId);
    keepOpener();
  }

  /** Native answers in the order asked; what stays shown is the newest request, then native's answer. */
  /** `remember`: save as the default for new threads (the composer panel), not when opened from an asking card. */
  function apply(sessionId: string, next: CouncilConfig | null, remember = true): Promise<void> {
    const entry = pending.get(sessionId) ?? { tail: Promise.resolve(), count: 0, asked: next };
    entry.count++; entry.asked = next;
    pending.set(sessionId, entry); failures.delete(sessionId);
    // The button and the panel show the change as on its way.
    refresh(sessionId);
    entry.tail = entry.tail.then(async () => {
      let reason = '';
      try {
        if (next && !host.team(sessionId) && !await host.startTeam(sessionId)) {
          // The user moved to another thread while the team started: nothing to report.
          if (document.querySelector<HTMLElement>(BUTTON)?.dataset.sessionId !== sessionId) return;
          throw new Error('The team could not start. Try again.');
        }
        const was = host.team(sessionId);
        const team = await host.call<TeamSnapshot | null>('architect_set_council', { sessionId, council: next });
        // A lowered target that is still above the lowest score: say so.
        const lowest = was?.councilStatus?.lowest;
        if (next && was?.config.council && next.target < was.config.council.target && typeof lowest === 'number' && lowest < next.target) host.announce(`Target ${formatScore(next.target)}. Lowest score ${formatScore(lowest)} is still below it.`);
        if (team) host.updated(team);
        else if (next) throw new Error('This task has no team.');
        if (next && remember) saveCouncilDefaults(next);
        // Turning Council on or off is read aloud too (the badge and panel change silently otherwise).
        if (next && !was?.config.council) host.announce(`Council is on. Target ${formatScore(next.target)}.`);
        else if (!next && was?.config.council) host.announce('Council is off.');
      } catch (cause) { reason = cause instanceof Error ? cause.message : String(cause); }
      finally {
        // Only the newest request's outcome is shown; an older one's was overtaken.
        if (--entry.count) return;
        pending.delete(sessionId);
        if (reason) {
          failures.set(sessionId, reason);
          // Closed since: say it now, and show it when the panel opens again for this thread.
          // Read aloud whether or not the panel is open (it also shows it, in its alert).
          host.announce(notChanged(reason));
        }
        refresh(sessionId);
      }
    });
    return entry.tail;
  }

  function close(focus = false): void {
    if (!panel) return;
    const closing = panel;
    // A refusal seen in the panel is done with; one that lands after closing waits for the next open.
    failures.delete(panelSession);
    panel = undefined; panelSession = ''; placeNow = undefined; cleanup?.(); cleanup = undefined;
    hidePopover(closing);
    const current = document.querySelector<HTMLElement>(BUTTON), back = opener?.isConnected ? opener : current;
    current?.setAttribute('aria-expanded', 'false'); opener?.setAttribute('aria-expanded', 'false'); opener = undefined; expandedOpener = '';
    if (focus) back?.focus({ preventScroll: true });
  }

  /** `focusField`: the row to focus first (Lower target opens on Target score); otherwise the switch. */
  function open(anchor: HTMLElement, sessionId: string, focusField?: Field): void {
    if (panel && panelSession === sessionId) { close(); return; }
    close();
    panelSession = sessionId; opener = anchor; panelCount++;
    expandedOpener = anchor.dataset.councilFocus ? `${sessionId}:${anchor.dataset.councilFocus}` : '';
    panel = document.createElement('div');
    panel.className = 'floating-menu council-panel';
    // From the strip (Lower target, Raise max rounds): compact, that one row, no intro.
    if (anchor.closest('.council-strip')) panel.dataset.compact = focusField ?? 'target';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'council-title');
    panel.innerHTML = `<div class="council-panel-head"><label id="council-title" for="council-switch">Council</label><input id="council-switch" class="ds-toggle council-switch" type="checkbox" role="switch" tabindex="0" aria-describedby="council-about"></div><p id="council-about">${ABOUT}</p><p class="council-idle" role="status" hidden>No changes to review yet</p>${FIELDS.map(({ key, label, options, name }) => `<div class="council-field" data-field-row="${key}"><span id="council-${key}">${label}${key === 'target' ? '<small class="council-lowest"></small>' : ''}</span><div class="ds-seg" role="group" aria-labelledby="council-${key}" data-field="${key}">${options.map(value => `<button type="button" data-value="${value}" aria-pressed="false"${key === 'reviewers' && !value ? ` aria-label="${AUTO}" data-tip="${AUTO}"` : ''}>${name(value)}</button>`).join('')}</div></div>`).join('')}<p class="council-error" role="alert" hidden></p><div class="council-foot"><label class="council-new"><input type="checkbox" class="council-new-threads" tabindex="0"><span>Start new threads with Council on</span></label></div>`;
    document.body.append(panel);
    // Compact (from the strip): only the row it opened on, titled by what it does (a heading, no longer the switch's label).
    if (panel.dataset.compact) {
      for (const row of panel.querySelectorAll<HTMLElement>('[data-field-row]')) row.hidden = row.dataset.fieldRow !== panel.dataset.compact;
      const title = panel.querySelector<HTMLElement>('#council-title')!;
      title.removeAttribute('for'); title.textContent = panel.dataset.compact === 'target' ? 'Lower target' : 'Raise max rounds';
      // Raise max rounds: the title names the row and its line says how many rounds were used (said once each).
      if (panel.dataset.compact === 'maxRounds') {
        const group = panel.querySelector<HTMLElement>('[data-field="maxRounds"]')!;
        group.setAttribute('aria-labelledby', 'council-title'); group.setAttribute('aria-describedby', 'council-maxRounds');
      }
    }
    const place = () => {
      // Anchored to the control that opened it; the composer button again if that one is gone (a redraw).
      const current = opener?.isConnected ? opener : document.querySelector<HTMLElement>(BUTTON);
      if (!panel || !current) return;
      const rect = current.getBoundingClientRect(), width = Math.min(PANEL_WIDTH, window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))}px`;
      // Above it when it fits (the composer), else on the roomier side; never over the opener: capped to the space and
      // scrolling inside.
      panel.style.maxHeight = '';
      // Its full height with borders (max-height counts them), so a panel with room never scrolls.
      const room = { above: rect.top - 22, below: window.innerHeight - rect.bottom - 22 }, natural = panel.offsetHeight;
      const above = natural <= room.above || room.above >= room.below;
      panel.style.maxHeight = `${Math.max(0, Math.min(natural, above ? room.above : room.below))}px`;
      panel.style.bottom = above ? `${window.innerHeight - rect.top + 10}px` : '';
      panel.style.top = above ? '' : `${rect.bottom + 10}px`;
      panel.dataset.placement = above ? 'above' : 'below';
    };
    paint(sessionId);
    place(); placeNow = place;
    showPopover(panel, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    const field = focusField && panel.querySelector<HTMLElement>(`[data-field="${focusField}"]`);
    // Focus starts on the row's Tab stop (paint chose it: the selection, or for Raise max rounds your default limit).
    (field?.querySelector<HTMLElement>('button[tabindex="0"]:not([hidden])') ?? field?.querySelector<HTMLElement>('button:not([hidden])') ?? panel.querySelector<HTMLElement>('.council-switch')!).focus({ preventScroll: true });

    // Lowering the target from the strip is for this thread only; the composer panel also sets the defaults.
    const remember = !anchor.closest('.council-strip');
    const onChange = (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (input.classList.contains('council-new-threads')) { setCouncilForNewThreads(input.checked); return; }
      // Classic team setup and no team yet: the user sets the team up first, rather than an automatic team starting.
      if (input.checked && !host.team(sessionId) && host.classicSetup()) {
        input.checked = false; close();
        host.openClassicSetup(document.querySelector<HTMLElement>(BUTTON) ?? anchor);
        return;
      }
      apply(sessionId, input.checked ? councilDefaults() : null, remember);
    };
    const onClick = (event: MouseEvent) => {
      const option = (event.target as Element).closest<HTMLElement>('[data-value]');
      if (!option) return;
      const key = option.closest<HTMLElement>('[data-field]')!.dataset.field as Field, value = Number(option.dataset.value);
      const current = shownConfig(sessionId);
      // While council is off, this only sets what it starts with.
      if (current) apply(sessionId, { ...current, [key]: value }, remember);
      else { saveCouncilDefaults({ ...councilDefaults(), [key]: value }); paint(sessionId); }
    };
    const onKey = (event: KeyboardEvent) => {
      // An IME cancelling its composition (in the prompt, say) keeps its Escape.
      if (event.key === 'Escape' && !isImeKey(event)) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      // A segmented row is one Tab stop: arrows, Home and End move focus along it.
      const option = (event.target as Element | null)?.closest?.<HTMLElement>('.council-panel .ds-seg > button');
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (option && (step || event.key === 'Home' || event.key === 'End')) {
        const row = [...option.parentElement!.querySelectorAll<HTMLElement>(':scope > button:not([hidden])')], at = row.indexOf(option);
        const next = row[event.key === 'Home' ? 0 : event.key === 'End' ? row.length - 1 : (at + step! + row.length) % row.length];
        // Focus only; Enter or Space picks (buttons do), so arrowing never changes the council.
        event.preventDefault(); for (const button of row) button.tabIndex = button === next ? 0 : -1; next.focus(); return;
      }
      // Tab and Shift+Tab always move inside the panel, in document order (the switch, each row's stop, the footer
      // checkbox), wrapping like a dialog: WebKit would otherwise skip plain checkboxes and leave the panel.
      if (event.key !== 'Tab' || !panel?.contains(document.activeElement)) return;
      const controls = [...panel.querySelectorAll<HTMLElement>('input, button:not(:disabled)')].filter(control => control.tabIndex !== -1 && control.offsetParent !== null);
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement), dir = event.shiftKey ? -1 : 1;
      controls[at < 0 ? 0 : (at + dir + controls.length) % controls.length].focus();
    };
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Element;
      // Any Council opener (the composer button, or the strip's Lower target or Raise max rounds) toggles the panel itself.
      if (panel && !panel.contains(target) && !target.closest('[data-action="council"]')) close();
    };
    panel.addEventListener('change', onChange);
    panel.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', place);
    cleanup = () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onOutside, true); window.removeEventListener('resize', place); };
  }

  /** The strip's Keep fixing or Accept and finish (Council stays on; the strip reads "Accepted at …"). While one runs all three
   *  actions are busy (still focusable); a failure shows once, in the strip's alert, and focus returns to the button
   *  pressed; done, focus goes to the strip's disclosure (or the prompt once the strip is gone). */
  async function act(sessionId: string, action: 'keep' | 'accept', pressed: HTMLElement): Promise<void> {
    if (actions.get(sessionId)?.busy) return;
    actions.set(sessionId, { busy: true, error: '' }); refresh(sessionId);
    let error = '';
    try {
      if (action === 'keep') await host.keepFixing(sessionId);
      else { const team = await host.call<TeamSnapshot | null>('architect_council_accept', { sessionId }); if (team) host.updated(team); }
    } catch (cause) {
      error = `${action === 'keep' ? 'Keep fixing' : 'Accept and finish'} did not go through: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    // A sent follow-up reads as fixing until native's state changes (which clears this entry).
    actions.set(sessionId, { busy: false, error, sent: action === 'keep' && !error }); refresh(sessionId);
    // After the composer's own redraw (a send rebuilds it), so focus lands on what stays.
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const again = pressed.isConnected ? pressed : document.querySelector<HTMLElement>(`#composer .council-strip [data-action="${pressed.dataset.action}"]`);
    (error ? again : document.querySelector<HTMLElement>('#composer .council-strip-toggle') ?? document.querySelector<HTMLElement>('#prompt'))?.focus({ preventScroll: true });
  }
  /** The disclosure: the reviewer rows, remembered per thread; collapsed by default. */
  function toggle(sessionId: string): void {
    if (expanded.has(sessionId)) expanded.delete(sessionId); else expanded.add(sessionId);
    refresh(sessionId);
  }
  /** A settled strip's ×: hidden until the next cycle. */
  function dismiss(sessionId: string): void {
    const team = host.team(sessionId);
    if (team) dismissed.add(cycleKey(team));
    refresh(sessionId);
    document.querySelector<HTMLElement>('#prompt')?.focus({ preventScroll: true });
  }
  /** "Turn on for new threads": Council on for a new thread (its team starting, or its first send), with the defaults. */
  /** Resolves to the reason it failed, or '' (also when there was nothing to do). Classic team setup starts no automatic team. */
  const enableForNewThread = async (sessionId: string): Promise<string> => {
    if (!councilForNewThreads() || host.classicSetup() || pending.has(sessionId) || host.team(sessionId)?.config.council) return '';
    await apply(sessionId, councilDefaults(), false);
    return failures.get(sessionId) ?? '';
  };
  return { button, strip, open, close, sync, act, toggle, dismiss, enableForNewThread };
}

/** Per thread: a strip action under way (all three are busy), its failure, and a Keep fixing already sent. */
const actions = new Map<string, { busy: boolean; error: string; sent?: boolean }>();
/** Threads whose strip shows its reviewer rows; cycles whose settled strip was dismissed. */
const expanded = new Set<string>(), dismissed = new Set<string>();
const cycleKey = (team: TeamSnapshot): string => `${team.sessionId}:${team.councilSince ?? 0}`;

const MARK_PULSE = '<span class="council-pulse" aria-hidden="true"></span>';
/** A seat's score or state, in words for every reader, plus its mark. The shape says what the tone says. */
type SeatState = 'passed' | 'below' | 'failed' | 'stopped' | 'attention' | 'reviewing' | 'quiet';
/** A seat's score or state, in words for every reader, plus its mark. Shape and tone both differ by state, so colour never
 *  carries it alone: a check (saver) at target, a warning (full) below it, a plain cross (no tone) for a reviewer that failed. */
function seatStatus(seat: CouncilSeatWorker, target: number, active: boolean, asking: (sessionId: string) => boolean, first?: number, { lowest = false, accepted = false } = {}): { html: string; spoken: string; tone: string; mark: string; scored: boolean; state: SeatState } {
  const score = seat.council.score;
  if (typeof score === 'number' && Number.isFinite(score)) {
    const passed = score >= target, moved = first !== undefined && formatScore(first) !== formatScore(score);
    // Settled: first → final, the first muted; just the final when they match.
    const html = `${moved ? `<span class="council-first">${formatScore(first!)} → </span>` : ''}${formatScore(score)}`;
    // Below target: the round's lowest seat carries the warning (muted once accepted); the others a quiet open ring.
    // Accepted: every mark neutral (a plain check at target, a ring below), so no warning sits under "Accepted".
    // Below target and not its complete round's lowest (or accepted): a small muted ring, apart from pending reviewers (pulse
    // or clock) and from the lowest's warning.
    const mark = passed ? icon('check') : lowest && !accepted ? icon('alert') : '<span class="council-ring" aria-hidden="true"></span>', tone = accepted ? '' : passed ? 'success' : lowest ? 'full' : '';
    return { html, spoken: `${moved ? `first ${formatScore(first!)}, final ` : ''}${formatScore(score)}, ${passed ? 'at target' : 'below target'}`, tone, mark, scored: true, state: passed ? 'passed' : 'below' };
  }
  const [word, state]: [string, SeatState] = seat.status === 'failed' ? ['Failed', 'failed'] : seat.status === 'stopped' ? ['Stopped', 'stopped'] : seat.status === 'completed' ? ['No score', 'failed']
    : !active ? ['Paused', 'quiet'] : seat.status === 'waiting' || asking(seat.sessionId) ? ['Needs attention', 'attention'] : seat.status === 'running' ? ['Reviewing', 'reviewing'] : ['Queued', 'quiet'];
  const marks: Record<SeatState, string> = { passed: '', below: '', failed: icon('close'), stopped: icon('stop'), attention: icon('alert'), reviewing: MARK_PULSE, quiet: icon('clock') };
  return { html: escape(word), spoken: word.toLowerCase(), tone: state === 'reviewing' ? 'team' : state === 'attention' ? 'full' : '', mark: marks[state], scored: false, state };
}

const lowestOf = ({ status }: CouncilProgress, round: CouncilRound): number | null => status.round === round.number && status.lowest !== null ? status.lowest : round.lowest;
/** The target each cycle started with (by thread and cycle), as first seen here: a pass after lowering it says so. Kept for
 *  this window only (after a reload a pass reads plainly). */
const firstTargets = new Map<string, number>();
function lowered(team: TeamSnapshot): boolean {
  const target = team.councilStatus?.target ?? team.config.council?.target;
  if (target === undefined) return false;
  const key = `${team.sessionId}:${team.councilSince ?? 0}`, first = firstTargets.get(key);
  if (first === undefined) { firstTargets.set(key, target); return false; }
  return target < first;
}
/** The round whose rows show: the latest, or while the team rests with an unscored latest round, the last scored one. */
function shownRound(progress: CouncilProgress, team: TeamSnapshot): CouncilRound | undefined {
  const resting = !teamActive(team) || councilAsking(progress.status) || settled(progress.state);
  return resting && progress.latest?.lowest === null ? [...progress.rounds].reverse().find(round => round.lowest !== null) ?? progress.latest : progress.latest;
}
/** One short row per reviewer (shared by the strip and the Agents flyout): mark, lens, score; first → final once settled.
 *  A row opens that reviewer, like a worker row. */
function rowsHtml(progress: CouncilProgress, team: TeamSnapshot): string {
  const round = shownRound(progress, team);
  if (!round) return '';
  const { state, status } = progress, ended = settled(state) || finishedBelow(progress, team);
  const firsts = ended ? new Map(firstAndFinal(progress.rounds).map(({ lens, first }) => [lens, first])) : null;
  return round.seats.map(seat => {
    const lens = seat.council.lens.trim() || seat.name, lowest = seatScore(seat) !== null && seatScore(seat) === round.lowest && !provisional(progress, round);
    const s = seatStatus(seat, status.target, teamActive(team), () => false, firsts?.get(lens), { lowest, accepted: state === 'accepted' });
    return `<button type="button" class="council-row" data-id="${escape(seat.id)}" data-action="open-team-worker" data-worker-id="${escape(seat.id)}" aria-label="${escape(`${lens}: ${s.spoken}. Open reviewer`)}"><span class="council-row-mark"${s.tone ? ` data-state-tone="${s.tone}"` : ''}>${s.mark}</span><span class="council-row-lens">${escape(lens)}</span><span class="council-row-score"${s.scored ? ` data-scored="${formatScore(seatScore(seat)!)}"` : ''}>${s.html}</span></button>`;
  }).join('');
}
/** The strip's state line: the state, then the lowest against the target ("so far" while the round is open). */
function stateLine(progress: CouncilProgress, team: TeamSnapshot): { text: string; score: string } {
  const round = shownRound(progress, team), lowest = round ? lowestOf(progress, round) : null, target = formatScore(progress.status.target);
  const sofar = round && provisional(progress, round) ? ' <small>so far</small>' : '';
  return { text: councilStateText(progress, team, lowered(team)), score: lowest === null ? `Target ${target}` : `${formatScore(lowest)} / ${target}${sofar}` };
}
/** The Agents flyout's Council: the state line and the rows, no actions (they live in the composer's strip). */
export function councilSummaryHtml(native: TeamSnapshot): string {
  const team = shownTeam(native), progress = councilProgress(team);
  if (!progress?.rounds.length) return '';
  const { text, score } = stateLine(progress, team);
  return `<section class="council-summary" data-session-id="${escape(team.sessionId)}" aria-label="Council"><p class="council-summary-state"><span>${escape(text)}</span><span class="council-strip-score">${score}</span></p><div class="council-rows">${rowsHtml(progress, team)}</div></section>`;
}
/** The composer's strip: shown while Council is on and the cycle has a round or is asking, until a settled strip is
 *  dismissed. One line (glyph, state, lowest / target, disclosure), the reviewers when expanded, and what to do next. */
function stripHtml(native: TeamSnapshot): string {
  const team = shownTeam(native), progress = councilProgress(team);
  if (!progress) return '';
  const asks = councilAsking(progress.status), finished = finishedBelow(progress, team), ended = settled(progress.state) || finished;
  if ((!progress.rounds.length && !asks) || (ended && dismissed.has(cycleKey(team)))) return '';
  const id = team.sessionId, open = expanded.has(id), { text, score } = stateLine(progress, team), { busy = false, error = '' } = actions.get(id) ?? {};
  const off = busy ? ' aria-disabled="true" aria-busy="true"' : '';
  const panelButton = (field: 'target' | 'maxRounds', label: string, cls = 'ds-btn') => `<button type="button" class="${cls}" data-action="council" data-council-focus="${field}" aria-haspopup="dialog" aria-expanded="${expandedOpener === `${id}:${field}`}"${off}>${label}</button>`;
  // What to do next: asking, the three ways on; at the limit, raise it; finished or stopped, a short hint.
  const halted = !teamActive(team) && team.status !== 'completed' && team.status !== 'ready' && !ended && !asks;
  const canLower = COUNCIL_TARGETS.some(target => target < progress.council.target);
  const used = Math.max(progress.status.round, progress.latest?.number ?? 0);
  const canRaise = COUNCIL_ROUNDS.some(rounds => rounds > used);
  const next = asks ? `<span class="council-strip-actions" role="group" aria-label="Council needs you"><button type="button" class="ds-btn-primary" data-action="council-keep-fixing"${off}>Keep fixing</button>${canLower ? panelButton('target', 'Lower target') : ''}<button type="button" class="ds-btn" data-action="council-accept"${off}>Accept and finish</button></span>`
    : progress.state === 'limit' && canRaise ? `<span class="council-strip-actions">${panelButton('maxRounds', 'Raise max rounds')}</span>`
    : finished ? '<span class="council-strip-hint">Send a message to continue, or lower the target.</span>'
    : halted ? '<span class="council-strip-hint">Send a message to continue.</span>' : '';
  const close = ended ? '<button type="button" class="icon-button council-strip-dismiss" data-action="council-dismiss" aria-label="Dismiss Council result" data-tip="Dismiss">' + icon('close') + '</button>' : '';
  const tone = asks || progress.state === 'limit' || finished ? 'full' : progress.state === 'passed' ? 'success' : '';
  return `<section class="council-strip" data-session-id="${escape(id)}" data-state="${progress.state}" aria-label="Council"><div class="council-strip-head"><button type="button" class="council-strip-toggle" data-action="council-strip-toggle" aria-expanded="${open}" aria-controls="council-rows-${escape(id)}"><span class="council-glyph" aria-hidden="true">${COUNCIL_ICON}</span><span class="council-strip-state"${tone ? ` data-state-tone="${tone}"` : ''}>${escape(text)}</span><span class="council-strip-score">${score}</span>${icon('chevron')}</button>${next || close ? `<span class="council-strip-end">${next}${close}</span>` : ''}</div>${error ? `<p class="council-strip-error" role="alert">${escape(error)}</p>` : ''}<div class="council-rows" id="council-rows-${escape(id)}"${open ? '' : ' hidden'}>${open ? rowsHtml(progress, team) : ''}</div></section>`;
}
const STRIP_EXIT_MS = 120;
/** Draws the strip in place (morph keeps focus), with its motion: it enters and leaves with a short fade and a few pixels of
 *  rise (never the height of anything else), its state cross-fades, and a score lands. */
function paintStrip(slot: HTMLElement, team: TeamSnapshot | null): void {
  const html = team ? stripHtml(team) : '', id = slot.dataset.sessionId!, shown = slot.querySelector<HTMLElement>(':scope > .council-strip');
  if (!html && shown) {
    if (shown.dataset.leaving) return;
    const out = motion(id, 'strip', '', shown, element => [element.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }], { duration: STRIP_EXIT_MS, easing: 'ease-in', fill: 'forwards' })]);
    if (!out.length) { slot.replaceChildren(); return; }
    shown.dataset.leaving = 'true'; shown.inert = true;
    setTimeout(() => { if (shown.dataset.leaving && shown.parentElement === slot) slot.replaceChildren(); }, STRIP_EXIT_MS);
    return;
  }
  if (shown?.dataset.leaving) slot.replaceChildren();
  morph(slot, html);
  const strip = slot.querySelector<HTMLElement>(':scope > .council-strip');
  if (!strip) return;
  loaded(id);
  const entered = motion(id, 'strip', 'shown', strip, element => [element.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' })], { fromNothing: true });
  if (entered.length) return;
  const state = strip.querySelector<HTMLElement>('.council-strip-state');
  motion(id, 'strip-state', state?.textContent ?? '', state, element => fade(element, 180, 0.4));
  for (const score of strip.querySelectorAll<HTMLElement>('.council-row-score')) motion(id, `score:${score.closest<HTMLElement>('.council-row')!.dataset.id}`, score.dataset.scored ?? '', score, element => element.dataset.scored ? land(element) : []);
}

/* Motion: one gate for every Council animation. An animation plays for a change seen while its thread is the one shown,
 * and has been for 500 ms (so a launch, a reload or a thread switch plays nothing), in a visible, ready window without
 * reduced motion, on an element on screen. A change is known by what it is (thread, subject, new value), never by the
 * element: a node rebuilt mid-animation joins it at its elapsed time, and one rebuilt after it plays nothing. Presentation
 * only, through the Web Animations API on opacity, transform and scale. */
let shownThread = '', shownAt = 0;
/** When the shown thread's team was first known (or its card first drawn): the quiet window runs from the later of that and
 *  the thread showing, so a slow first load plays nothing either. */
const loadedAt = new Map<string, number>();
function threadShown(sessionId: string): void {
  if (sessionId !== shownThread) { shownThread = sessionId; shownAt = performance.now(); loadedAt.clear(); }
}
function loaded(sessionId: string): void {
  if (!loadedAt.has(sessionId)) loadedAt.set(sessionId, performance.now());
}
const QUIET_MS = 500;
const lastSeen = new Map<string, string>();
const played = new Map<string, { at: number; end: number; prev: string | undefined; on: WeakSet<Element> }>();
type Play = (element: HTMLElement, prev: string | undefined) => Animation[];
const moving = (): boolean => document.documentElement.hasAttribute('data-ready') && !document.hidden && !reducedMotion();
const onScreen = (element: Element): boolean => { const rect = element.getBoundingClientRect(); return element.isConnected && rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight; };
const endOf = (animation: Animation): number => Number(animation.effect?.getComputedTiming().endTime) || 0;
/** Records `value` for the thread's `subject` and plays `play` on `element` when it is a change the gate lets through.
 *  `fromNothing`: a subject first seen counts as a change (a card appearing); otherwise the first sight is a baseline. */
function motion(sessionId: string, subject: string, value: string, element: HTMLElement | null | undefined, play: Play, { fromNothing = false } = {}): Animation[] {
  const slot = `${sessionId}\n${subject}`, key = `${slot}\n${value}`, prev = lastSeen.get(slot), now = performance.now();
  lastSeen.set(slot, value);
  if (!element) return [];
  if (prev !== value && (prev !== undefined || fromNothing)) {
    played.delete(key);
    if (sessionId !== shownThread || now - Math.max(shownAt, loadedAt.get(sessionId) ?? Infinity) < QUIET_MS || !moving() || !onScreen(element)) return [];
    const animations = play(element, prev);
    for (const [old, change] of played) if (change.end < now) played.delete(old);
    if (animations.length) played.set(key, { at: now, end: now + Math.max(...animations.map(endOf)), prev, on: new WeakSet([element]) });
    return animations;
  }
  // The same change on a rebuilt node: it joins the running animation where it is, or stays still.
  const change = played.get(key);
  if (!change || change.on.has(element) || now >= change.end || !moving()) return [];
  change.on.add(element);
  const animations = play(element, change.prev);
  for (const animation of animations) animation.currentTime = now - change.at;
  return animations;
}
/** `from`: a kept node that changes cross-fades from part-way (never blinking to nothing); a new one fades from 0. */
function fade(element: Element | null | undefined, duration = 160, from = 0): Animation[] {
  return element ? [element.animate([{ opacity: from }, { opacity: 1 }], { duration, easing: 'ease-out' })] : [];
}
/** A small scale pop on a short spring (a touch of overshoot), for a cue that needs noticing. */
function pop(element: Element): Animation[] {
  const { keyframes, duration } = springKeyframes({ response: 0.22, damping: 0.72 }, progress => ({ scale: String(0.9 + 0.1 * progress) }));
  return [element.animate(keyframes, { duration, easing: 'linear' })];
}
/** A score lands once: it fades and scales in on a short spring from 0.94 (about 300 ms); its ink changes by the score's
 *  CSS colour transition. The number is final from the first frame, so a screen reader never hears a count. */
function land(score: HTMLElement): Animation[] {
  const { keyframes, duration } = springKeyframes({ response: 0.22 }, progress => ({ opacity: Math.min(1, progress * 1.6), scale: String(0.94 + 0.06 * progress) }));
  return [score.animate(keyframes, { duration, easing: 'linear' })];
}
