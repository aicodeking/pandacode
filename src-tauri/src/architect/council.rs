//! Council: independent read-only reviewers score the team's work out of 10, and `finish_team`
//! refuses until every reviewer of a current round reaches the user's target (docs/architect-workers.md).
//! A round is the seats sharing a number among this cycle's reviewers; rounds are derived from the
//! workers on every check, so nothing can drift out of step with them.
use super::{unsettled, TeamSnapshot, Worker};
use crate::{storage, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_ROUNDS: usize = 100;
const MAX_REVIEWERS: usize = 8;
const MIN_REVIEWERS: usize = 2;
const LENS_CHARS: usize = 80;
/// Characters read from a report's end for the score line; `summary` is only the report's head.
const SCORE_TAIL_CHARS: i64 = 8192;
/// The whole report again, so read_worker and the summary carry it with its score.
pub(super) const SCORE_PROMPT: &str = "Your final report did not end with a score. Repeat your final report in full, ending with the exact line `Council score: N/10`, where N is your score for the work you just reviewed.";
pub(super) const SCORE_ERROR: &str = "The reviewer ended two runs without a `Council score: N/10` line. Cancel it and dispatch a fresh reviewer with councilLens.";
pub(super) const NO_FOLLOWUP: &str = "Dispatch a fresh reviewer for the next round";
/// Below the target, the user decides whether a blocker must be fixed.
const ESCAPE: &str = "If a remaining blocker should not be fixed, end your turn and tell the user, who can lower the target or turn Council off; if they say to accept the current scores, tell them to press Accept and finish on the Council card.";
pub(super) const NUDGE_PENDING: &str = "This reviewer has reported and its score is on the way. Wait for it to settle.";
pub(super) const RUNNING_SEAT: &str = "This reviewer is running. Wait for its report; PandaCode fails it if it goes silent.";
pub(super) const SCORED_STANDS: &str = "A scored seat stands. Fix the work and convene a new round.";
/// For the failed-worker turn and the retry cap, when the worker is a reviewer.
pub(super) const FAILED_REVIEWER: &str = " A failed Council reviewer is never followed up: cancel it (it has no score) and dispatch a fresh reviewer with councilLens.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct CouncilConfig {
    /// The score every reviewer must reach.
    pub target: f64,
    /// Rounds that may start this cycle (a round starts when one of its seats runs), 1..=100.
    pub max_rounds: usize,
    /// 0 = the lead decides.
    pub reviewers: usize,
}
impl Default for CouncilConfig {
    fn default() -> Self {
        Self { target: 9.0, max_rounds: 10, reviewers: 0 }
    }
}
impl CouncilConfig {
    pub(super) fn validate(&self) -> Result<()> {
        if !self.target.is_finite() || !(1.0..=10.0).contains(&self.target) {
            return Err("The Council target must be between 1 and 10.".into());
        }
        if !(1..=MAX_ROUNDS).contains(&self.max_rounds) {
            return Err(format!("Council takes 1 to {MAX_ROUNDS} rounds."));
        }
        if self.reviewers > MAX_REVIEWERS {
            return Err(format!("Council allows at most {MAX_REVIEWERS} reviewers."));
        }
        Ok(())
    }
    fn needed(&self) -> usize {
        self.reviewers.max(MIN_REVIEWERS)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CouncilSeat {
    pub round: usize,
    pub lens: String,
    pub score: Option<f64>,
    /// When this seat first ran (`storage::now`); its round is timed from its seats' first runs, so a
    /// reviewer that waits on a dependency or a free slot is not out of date before it reads anything.
    #[serde(skip_serializing_if = "is_zero")]
    pub started_at: i64,
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// Where Council stands, on every snapshot while it is on; the webview shows this as it is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilStatus {
    /// "accepted" (the user accepted this cycle's scores), "waiting" (no round yet), "reviewing" (a seat
    /// of the latest round is live), "dispatch" (the
    /// latest round is incomplete with no live seat: the lead must act), "asking" (the lead asks the
    /// user), "fixing" (below target or out of date), "passed" or "limit" (the round limit is reached
    /// without passing).
    pub state: String,
    pub round: usize,
    pub lowest: Option<f64>,
    pub target: f64,
    /// Changes landed after the latest round started.
    pub stale: bool,
    /// A short plain sentence for the user while a Council refusal holds the team (asking or paused).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// The lead's setting on a task's team; takes effect at once. It starts a lead turn only when it ends
/// the lead's question to the user (the team was asking and no longer is).
pub(super) fn set(state: &AppState, session_id: &str, council: Option<CouncilConfig>) -> Result<TeamSnapshot> {
    if let Some(config) = &council {
        config.validate()?;
    }
    let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    super::refuse_mirror(&store, session_id)?;
    let mut team = super::load(&store, session_id)?.ok_or("This task has no team.")?;
    // Turning it off stops this cycle's reviewers that are still out: nothing waits for their scores.
    let stops = if council.is_none() {
        let since = team.council_since;
        let out: Vec<String> = team.workers.iter().filter(|w| w.council.is_some() && w.created_at >= since && !w.abandoned && unsettled(&w.status)).map(|w| w.id.clone()).collect();
        stop_seats(&mut team, &out, "Stopped: Council was turned off.")
    } else {
        Vec::new()
    };
    // A queued setup must not bring back what this replaces when it applies.
    if let Some(pending) = &mut team.pending_setup {
        pending.config.council = council.clone();
    }
    // Turning it on reviews what comes next, not the thread's earlier work. A request under way,
    // paused, failed or interrupted keeps its start, so its writes are still reviewed.
    if team.config.council.is_none() && council.is_some() && !super::active(&team.status) && !super::can_resume(&team.status) {
        team.council_since = storage::now();
    }
    let old = finish_refusal(&team);
    let asking = |team: &TeamSnapshot| status(team).is_some_and(|s| s.state == "asking");
    let was_asking = asking(&team);
    // A team resting with nothing for Council to refuse (passed, or at its round limit).
    let resting = matches!(team.status.as_str(), "ready" | "completed") && old.is_none();
    let old_rounds = team.config.council.as_ref().map(|c| c.max_rounds);
    team.config.council = council;
    super::refresh_council(&store, &mut team);
    // The team's error shows the refusal as it now stands; a lifted one leaves only the rest (a pause note).
    if let Some(old) = old.filter(|old| team.error.as_deref().is_some_and(|e| e.contains(old.as_str()))) {
        let error = team.error.take().unwrap_or_default().replace(&old, &finish_refusal(&team).unwrap_or_default());
        let error = error.split_whitespace().collect::<Vec<_>>().join(" ");
        team.error = (!error.is_empty()).then_some(error);
    }
    // The user answered the lead's question: the lead verifies and finishes, once.
    if was_asking && !asking(&team) {
        let ask = match finish_refusal(&team) {
            Some(refusal) => format!("The user changed the Council setting, which answers your question, but Council still refuses: {refusal}"),
            None => finish_prompt(&team, "The user changed the Council setting, which answers your question."),
        };
        super::lift_turn(&store, &mut team, &ask)?;
    } else if let Some(refusal) = finish_refusal(&team).filter(|_| resting) {
        // The setting reopened work the lead can act on (a raised limit makes a new round possible): it
        // gets one turn, and a completed team returns to running for it.
        let rounds = team.config.council.as_ref().map(|c| c.max_rounds).filter(|n| old_rounds.is_some_and(|old| old < *n));
        let why = rounds.map_or_else(|| "The user changed the Council setting".to_string(), |n| format!("The user raised the Council round limit to {n}"));
        super::lift_turn(&store, &mut team, &format!("{why}, so Council refuses again: {refusal}"))?;
    }
    super::save(&store, &mut team)?;
    for sid in stops {
        if let Some(agent) = agents.get(&sid) {
            let _ = agent.send(crate::RunInput::Stop);
        }
    }
    Ok(team)
}

/// Asks the lead to finish with the first-and-final table; the scores travel in the prompt, since the
/// review may have no `council` block (Council off) or no refusal (accepted).
fn finish_prompt(team: &TeamSnapshot, why: &str) -> String {
    let table: Vec<String> = score_table(team).iter().map(|(lens, first, last)| format!("{lens}: first {first}, final {last}")).collect();
    format!("{why} Verify the work and call finish_team, ending with the table of each lens's first and final score ({}).", table.join("; "))
}
fn accepted(team: &TeamSnapshot) -> bool {
    team.council_accepted == Some(team.council_since)
}
/// The user accepts this cycle's scores: the gate lets the lead finish, Council stays on, and the next
/// cycle reviews as usual. An idle team's lead is woken once to finish.
pub(super) fn accept(state: &AppState, session_id: &str) -> Result<TeamSnapshot> {
    let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    super::refuse_mirror(&store, session_id)?;
    let mut team = super::load(&store, session_id)?.ok_or("This task has no team.")?;
    if team.config.council.is_none() {
        return Err("Council is off for this team.".into());
    }
    let refusal = finish_refusal(&team);
    // Nothing waits for scores once they are accepted.
    let since = team.council_since;
    let out: Vec<String> = team.workers.iter().filter(|w| w.council.is_some() && w.created_at >= since && !w.abandoned && unsettled(&w.status)).map(|w| w.id.clone()).collect();
    let stops = stop_seats(&mut team, &out, "Stopped: the user accepted the Council scores.");
    let wake = refusal.is_some();
    team.council_accepted = Some(team.council_since);
    if let Some(refusal) = refusal.filter(|r| team.error.as_deref().is_some_and(|e| e.contains(r.as_str()))) {
        let error = team.error.take().unwrap_or_default().replace(&refusal, "");
        let error = error.split_whitespace().collect::<Vec<_>>().join(" ");
        team.error = (!error.is_empty()).then_some(error);
    }
    // Only a resting team is woken: a paused, failed or interrupted one keeps its note, and Resume
    // continues it. A cycle that already passed has nothing for the lead to do.
    if wake && team.status == "ready" {
        let ask = finish_prompt(&team, "The user accepted the current Council scores.");
        super::lift_turn(&store, &mut team, &ask)?;
    }
    super::save(&store, &mut team)?;
    for sid in stops {
        if let Some(agent) = agents.get(&sid) {
            let _ = agent.send(crate::RunInput::Stop);
        }
    }
    Ok(team)
}

/// The score in a report: the last line that starts (past markdown) with "council score", read as
/// the number after it, optionally `/10`. A last line that does not read as 0..=10 is no score.
pub(super) fn parse_score(report: &str) -> Option<f64> {
    const LABEL: &str = "council score";
    let rest = report.lines().rev().find_map(|line| {
        let line = line.trim_start_matches(|c: char| c.is_whitespace() || "*#_>-`~".contains(c));
        line.get(..LABEL.len()).filter(|head| head.eq_ignore_ascii_case(LABEL))?;
        Some(&line[LABEL.len()..])
    })?;
    let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || ":*_`=".contains(c));
    let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    let fraction = rest[digits..].strip_prefix('.').map_or(0, |after| {
        let count = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
        if count == 0 { 0 } else { count + 1 }
    });
    let end = digits + fraction;
    let tail = rest[end..].trim_start();
    if digits == 0 || rest[end..].starts_with(|c: char| c.is_alphanumeric()) {
        return None;
    }
    if let Some(over) = tail.strip_prefix('/') {
        let over = over.trim_start();
        if !over.starts_with("10") || over[2..].starts_with(|c: char| c.is_ascii_digit()) {
            return None;
        }
    }
    rest[..end].parse().ok().filter(|score: &f64| (0.0..=10.0).contains(score))
}

/// The score in a reviewer's latest reply, read from the message's tail. Reads no more than that,
/// as a report can be megabytes.
pub(super) fn latest_score(store: &storage::Store, session_id: &str) -> Option<f64> {
    store.db.query_row("SELECT substr(content,?2) FROM messages WHERE session_id=?1 AND role='assistant' AND id>(SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1 AND role IN ('user','coordination')) ORDER BY id DESC LIMIT 1", params![session_id, -SCORE_TAIL_CHARS], |r| r.get::<_, String>(0)).optional().ok().flatten().and_then(|tail| parse_score(&tail))
}

/// This cycle's reviewers: each new user objective starts a new cycle.
fn seats(team: &TeamSnapshot) -> impl Iterator<Item = (&Worker, &CouncilSeat)> {
    team.workers.iter().filter(|w| w.created_at >= team.council_since).filter_map(|w| Some((w, w.council.as_ref()?)))
}
fn latest_round(team: &TeamSnapshot) -> usize {
    seats(team).map(|(_, seat)| seat.round).max().unwrap_or(0)
}
fn in_round(team: &TeamSnapshot, round: usize) -> impl Iterator<Item = (&Worker, &CouncilSeat)> {
    seats(team).filter(move |(_, seat)| seat.round == round)
}
/// A seat that counts: one not abandoned, or one that scored, since a score stands once given. An
/// abandoned seat that never scored drops out.
fn counts(worker: &Worker, seat: &CouncilSeat) -> bool {
    !worker.abandoned || seat.score.is_some()
}
fn same_lens(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}
/// Seats that have settled with a score.
fn scored(team: &TeamSnapshot, round: usize) -> impl Iterator<Item = f64> + '_ {
    in_round(team, round).filter(|(w, seat)| counts(w, seat) && !unsettled(&w.status)).filter_map(|(_, seat)| seat.score)
}
fn lowest(team: &TeamSnapshot, round: usize) -> Option<f64> {
    scored(team, round).reduce(f64::min)
}
fn live(team: &TeamSnapshot, round: usize) -> bool {
    in_round(team, round).any(|(w, _)| unsettled(&w.status))
}
/// One check's view of the cycle's rounds, computed once: the latest round, whether each is complete
/// (oldest first), how many started, and the lenses the first round fixed.
struct Rounds {
    latest: usize,
    done: Vec<bool>,
    started: usize,
    lenses: Vec<String>,
}
impl Rounds {
    fn of(team: &TeamSnapshot, config: &CouncilConfig) -> Self {
        let latest = latest_round(team);
        let mut lenses: Vec<String> = Vec::new();
        // Every round-1 seat fixes its lens, a cancelled or overtaken one too: dropping a seat cannot
        // drop its lens from later rounds.
        for (_, seat) in in_round(team, 1) {
            if !lenses.iter().any(|lens| same_lens(lens, &seat.lens)) {
                lenses.push(seat.lens.clone());
            }
        }
        let mut view = Rounds { latest, done: Vec::new(), started: 0, lenses };
        for round in 1..=latest {
            let seated = in_round(team, round).filter(|(w, seat)| counts(w, seat)).count();
            let count = scored(team, round).count();
            let complete = count == seated && count >= config.needed() && view.missing(team, round).is_empty();
            view.done.push(complete);
            view.started += usize::from(in_round(team, round).any(|(_, seat)| seat.started_at > 0));
        }
        view
    }
    fn complete(&self, round: usize) -> bool {
        round > 0 && self.done.get(round - 1).copied().unwrap_or(false)
    }
    fn at_limit(&self, config: &CouncilConfig) -> bool {
        self.started >= config.max_rounds
    }
    /// The first round's lenses with no seat in `round`: every one sits again in each later round.
    fn missing(&self, team: &TeamSnapshot, round: usize) -> Vec<String> {
        if round <= 1 {
            return Vec::new();
        }
        self.lenses.iter().filter(|lens| !in_round(team, round).any(|(w, seat)| counts(w, seat) && same_lens(&seat.lens, lens))).cloned().collect()
    }
}
#[cfg(test)]
pub(super) fn complete(team: &TeamSnapshot, config: &CouncilConfig, round: usize) -> bool {
    Rounds::of(team, config).complete(round)
}
/// When a round began: its earliest seat's first run, an abandoned one included, as the rest may
/// have read the work that early. A round none of whose seats has run has not begun.
fn round_start(team: &TeamSnapshot, round: usize) -> i64 {
    in_round(team, round).map(|(_, seat)| seat.started_at).filter(|at| *at > 0).min().unwrap_or(i64::MAX)
}
/// A writer ran, or any team conversation recorded changed files (`changed_at`), after `start`.
fn written_since(team: &TeamSnapshot, start: i64) -> bool {
    team.changed_at > start || team.workers.iter().any(|w| w.wrote_at > start)
}
fn has_writer(team: &TeamSnapshot) -> bool {
    let since = team.council_since;
    (team.changed_at > 0 && team.changed_at >= since) || team.workers.iter().any(|w| w.wrote_at > 0 && w.wrote_at >= since)
}
fn stale(team: &TeamSnapshot, round: usize) -> bool {
    round > 0 && written_since(team, round_start(team, round))
}

/// The round a new reviewer takes its seat in: the seat it replaces, else the latest round while it
/// is open, current and has room, else the next one if the limit allows. A complete round below the
/// target with nothing changed since is not re-rolled.
pub(super) fn round_for(team: &TeamSnapshot, config: &CouncilConfig, replaces: Option<&str>) -> Result<usize> {
    let view = Rounds::of(team, config);
    let latest = view.latest;
    let current = latest > 0 && !stale(team, latest);
    let replaced = replaces.is_some_and(|id| in_round(team, latest).any(|(w, _)| w.id == id));
    let done = view.complete(latest);
    // Abandoned seats take room too, so dropping and re-dispatching cannot go on forever.
    let room = in_round(team, latest).count() < MAX_REVIEWERS;
    if current && room && (replaced || !done) {
        return Ok(latest);
    }
    if view.at_limit(config) {
        return Err(format!("The Council round limit of {} is reached. Finish and report the scores plainly, or ask the user to raise the limit.", config.max_rounds));
    }
    // Any current round with a score below the target, full or complete: a fresh round needs a change.
    if let Some(low) = lowest(team, latest).filter(|low| current && *low < config.target) {
        return Err(format!("Council round {latest} scored lowest {low}, below the target {}, and nothing changed since it started. Fix the blockers with workers before convening a new round.", config.target));
    }
    Ok(latest + 1)
}

/// The seat for a dispatched assignment, if it is a reviewer. A reviewer's replacement stays one,
/// with its lens unless it names another. Call before the replaced seat is abandoned.
pub(super) fn seat_for(team: &TeamSnapshot, lens: Option<&str>, replaces: Option<&str>) -> Result<Option<CouncilSeat>> {
    if let Some(lens) = lens {
        if lens.trim().is_empty() || lens.chars().count() > LENS_CHARS || lens.chars().any(char::is_control) {
            return Err(format!("councilLens must be a plain name of 1-{LENS_CHARS} characters."));
        }
    }
    let inherited = replaces.and_then(|id| team.workers.iter().find(|w| w.id == id)).and_then(|w| w.council.as_ref()).map(|seat| seat.lens.as_str());
    let Some(config) = team.config.council.as_ref() else {
        return match lens {
            Some(_) => Err("Council is off for this team, so councilLens cannot be used.".into()),
            None => Ok(None),
        };
    };
    if let (Some(named), Some(old)) = (lens, inherited) {
        if !same_lens(named, old) {
            return Err(format!("A replacement keeps the lens of the seat it replaces ({old}): omit councilLens or use that one."));
        }
    }
    let Some(lens) = lens.or(inherited) else {
        return Ok(None);
    };
    let round = round_for(team, config, replaces)?;
    let fixed = Rounds::of(team, config).lenses;
    if round > 1 && !fixed.is_empty() && !fixed.iter().any(|known| same_lens(known, lens)) {
        return Err(format!("Council lenses are fixed by round 1: {}. Use one of them for {lens:?}.", fixed.join(", ")));
    }
    Ok(Some(CouncilSeat { round, lens: lens.trim().into(), score: None, started_at: 0 }))
}

/// When a new round opens over an incomplete one (changes overtook it), that round's unscored
/// reviewers stop and are abandoned, so they stop spending; their seats block nothing any more.
pub(super) fn overtake(team: &mut TeamSnapshot, round: usize) -> Vec<String> {
    let since = team.council_since;
    let note = format!("Stopped: changes landed after its round started, and round {round} replaces it.");
    let overtaken: Vec<String> = team.workers.iter()
        .filter(|w| w.created_at >= since && !w.abandoned && w.council.as_ref().is_some_and(|seat| seat.round < round && seat.score.is_none()))
        .map(|w| w.id.clone())
        .collect();
    stop_seats(team, &overtaken, &note)
}
/// Settles these reviewers (parked ones included) as stopped and abandoned, with their sub-workers,
/// and returns the sessions whose runs the caller stops once its changes are saved.
fn stop_seats(team: &mut TeamSnapshot, ids: &[String], note: &str) -> Vec<String> {
    let mut stops = Vec::new();
    let none = std::collections::HashMap::new();
    for id in ids {
        stops.extend(team.workers.iter().filter(|w| (w.id == *id || super::child_of(w, id)) && super::stoppable(&w.status)).map(|w| w.session_id.clone()));
        let Some(worker) = team.workers.iter_mut().find(|w| w.id == *id) else { continue };
        if unsettled(&worker.status) {
            worker.status = "stopped".into();
        }
        worker.abandoned = true;
        worker.error = Some(note.into());
        worker.updated_at = storage::now();
        super::settle_children(team, id, &none, "Its Council seat was stopped.");
    }
    stops
}

/// The opening of a Continue turn when Council has not passed.
pub(super) fn continue_note(team: &TeamSnapshot, refusal: &str) -> String {
    if asks_user(team) {
        format!("Council has not passed this work: {refusal} Fix the blockers through workers and convene a new round; only if a remaining blocker should not be fixed, end your turn and tell the user.")
    } else {
        format!("Council has not passed this work: {refusal} Act on that now.")
    }
}

/// Why a reviewer may not be cancelled or replaced: a score, once given, stands.
/// A seat whose score nudge is pending has a report too, and its score is on the way.
pub(super) fn refuse_unseat(worker: &Worker) -> Result<()> {
    match worker.council.as_ref().and_then(|seat| seat.score) {
        Some(_) => Err(SCORED_STANDS.into()),
        None if worker.council.is_some() && worker.score_nudged && unsettled(&worker.status) => Err(NUDGE_PENDING.into()),
        // A running reviewer is reading the work: let it report. The watchdog fails a hung one.
        None if worker.council.as_ref().is_some_and(|seat| seat.started_at > 0) && super::holds(&worker.status) => Err(RUNNING_SEAT.into()),
        None => Ok(()),
    }
}

/// Whether the refusal is a round below the target: the lead fixes it, or else asks the user. A lead
/// that ends its turn on it after one Continue is asking the user.
pub(super) fn asks_user(team: &TeamSnapshot) -> bool {
    verdict(team).is_some_and(|(_, asks)| asks)
}

/// Why the lead may not finish yet, naming what to do next; `None` lets it finish. A cycle with no
/// changes and no round finishes as it always has; once a round exists its scores bind.
// ponytail: changes are seen through writers' runs and the lead's and workers' recorded turn changes
// (write tools, or edits reported through track_files). Known ceilings: the lead's unreported shell
// edits are not seen (nor edits from outside PandaCode); a writer run that changed nothing still counts
// as a change; and a reviewer that stopped or failed before scoring can be cancelled and its lens seated
// again within the round's 8 seats. Fingerprint the checkout if the first two start to matter.
pub(super) fn finish_refusal(team: &TeamSnapshot) -> Option<String> {
    verdict(team).map(|(refusal, _)| refusal)
}
fn verdict(team: &TeamSnapshot) -> Option<(String, bool)> {
    let config = team.config.council.as_ref()?;
    verdict_in(team, config, &Rounds::of(team, config))
}
/// The verdict from a view the caller already computed.
fn verdict_in(team: &TeamSnapshot, config: &CouncilConfig, view: &Rounds) -> Option<(String, bool)> {
    if accepted(team) {
        return None;
    }
    let round = view.latest;
    let needed = config.needed();
    if round == 0 {
        return has_writer(team).then(|| (format!("No Council round yet. Once writers settle, dispatch at least {needed} reviewers in one batch with councilLens."), false));
    }
    // The limit is the user's brake: no further round can open. The lead finishes once nothing is live
    // and the last round is complete, out of date, or full; a current round it can still fill comes first.
    if view.at_limit(config) && !live(team, round) && (view.complete(round) || stale(team, round) || in_round(team, round).count() >= MAX_REVIEWERS) {
        return None;
    }
    if !view.complete(round) {
        let missing = view.missing(team, round);
        let count = scored(team, round).count();
        let lenses = if missing.is_empty() { String::new() } else { format!(" It still needs the lenses round 1 seated: {}.", missing.join(", ")) };
        // Seats that stopped or failed without a score hold the round until they are cancelled.
        let stopped: Vec<String> = in_round(team, round).filter(|(w, seat)| !w.abandoned && seat.score.is_none() && !unsettled(&w.status)).map(|(w, _)| format!("{} ({})", w.name, w.id)).collect();
        let next = if stopped.is_empty() { "Dispatch the missing reviewers with councilLens, or wait for those still running.".to_string() } else { format!("Cancel the stopped reviewers {}, then dispatch the missing reviewers with councilLens.", stopped.join(", ")) };
        return Some((format!("Council round {round} is not complete: {count} scored, at least {needed} needed.{lenses} {next}"), false));
    }
    if stale(team, round) {
        return Some((format!("Council round {round} is out of date: changes landed after it started. Dispatch a new round with councilLens."), false));
    }
    let low = lowest(team, round)?;
    if low >= config.target {
        return None;
    }
    Some((format!("Council round {round}: lowest {low}, target {}. Fix the blockers with workers, then dispatch a new round with councilLens. {ESCAPE}", config.target), true))
}

/// The refusal that should bring the lead back after it answered without delegating: this cycle has
/// changes that no passing round covers.
pub(super) fn unreviewed(team: &TeamSnapshot) -> Option<String> {
    finish_refusal(team).filter(|_| has_writer(team))
}

/// Whether a new user message starts a new cycle: only once the old one has nothing outstanding.
/// Otherwise "keep going" after a stop continues its rounds.
pub(super) fn new_cycle(team: &TeamSnapshot) -> bool {
    finish_refusal(team).is_none()
}

/// The snapshot's `councilStatus`, from the same checks as the gate.
pub(super) fn status(team: &TeamSnapshot) -> Option<CouncilStatus> {
    let config = team.config.council.as_ref()?;
    Some(status_in(team, config, &Rounds::of(team, config)))
}
fn status_in(team: &TeamSnapshot, config: &CouncilConfig, view: &Rounds) -> CouncilStatus {
    let round = view.latest;
    let low = lowest(team, round);
    let stale = stale(team, round);
    let verdict = verdict_in(team, config, view);
    // A refusal the team is resting or paused on, as its error.
    let held = verdict.as_ref().filter(|(refusal, _)| team.error.as_deref().is_some_and(|e| e.contains(refusal.as_str())));
    let asking = held.is_some_and(|(_, asks)| *asks && team.status == "ready");
    let state = if accepted(team) {
        "accepted"
    } else if round == 0 {
        "waiting"
    } else if asking {
        "asking"
    } else if live(team, round) {
        "reviewing"
    } else if view.complete(round) && !stale && low.is_some_and(|low| low >= config.target) {
        "passed"
    } else if view.at_limit(config) {
        "limit"
    } else if !view.complete(round) {
        "dispatch"
    } else {
        "fixing"
    };
    let (low_shown, target) = (low.unwrap_or_default(), config.target);
    let notice = held.map(|_| match () {
        _ if asking => format!("The lead is asking how to continue: lowest score {low_shown:.1}, target {target:.1}, after round {round}."),
        _ if round == 0 => "The team stopped before Council reviewed the work.".to_string(),
        _ if !view.complete(round) => format!("The team stopped with Council round {round} unfinished."),
        _ if stale => format!("The team stopped: the work changed after Council round {round}."),
        _ => format!("The team stopped after Council round {round}: lowest score {low_shown:.1}, target {target:.1}."),
    });
    CouncilStatus { state: state.into(), round, lowest: low, target, stale, notice }
}

/// Each lens's first score this cycle, for the lead's first-and-final table.
fn score_table(team: &TeamSnapshot) -> Vec<(String, f64, f64)> {
    let mut seats: Vec<_> = seats(team).filter(|(w, seat)| counts(w, seat)).filter_map(|(_, seat)| Some((seat.round, &seat.lens, seat.score?))).collect();
    seats.sort_by_key(|(round, _, _)| *round);
    let mut table: Vec<(String, f64, f64)> = Vec::new();
    for (_, lens, score) in seats {
        match table.iter_mut().find(|(known, _, _)| same_lens(known, lens)) {
            Some(row) => row.2 = score,
            None => table.push((lens.clone(), score, score)),
        }
    }
    table
}
fn first_scores(team: &TeamSnapshot) -> serde_json::Map<String, Value> {
    score_table(team).into_iter().map(|(lens, first, _)| (lens, json!(first))).collect()
}

/// The `council` object in the lead's review, when Council is on.
pub(super) fn review(team: &TeamSnapshot) -> Option<Value> {
    let config = team.config.council.as_ref()?;
    let view = Rounds::of(team, config);
    let status = status_in(team, config, &view);
    let round = status.round;
    let done = view.complete(round);
    let passed = status.state == "passed";
    let next = match verdict_in(team, config, &view) {
        Some((refusal, _)) => refusal,
        None if passed => "Every reviewer reached the target: verify, then finish with the table of first and final scores.".into(),
        None if view.at_limit(config) => "The round limit is reached: make no more changes, finish, and say plainly which scores fell short and what no round reviewed.".into(),
        None => "No worker has changed anything this cycle, so no council is needed yet.".to_string(),
    };
    let rounds_left = config.max_rounds.saturating_sub(view.started);
    let scores: Vec<Value> = in_round(team, round).filter(|(w, seat)| counts(w, seat)).map(|(_, seat)| json!({"lens":seat.lens,"score":seat.score})).collect();
    Some(json!({"round":round,"target":config.target,"lowest":status.lowest,"complete":done,"passed":passed,"roundsLeft":rounds_left,"scores":scores,"firstScores":first_scores(team),"next":next}))
}

/// The newest time any team conversation recorded changed files this cycle: worker turns, and
/// reviewers' only for real writes (`lastWriteAt`: a write tool or track_files), since a reviewer that
/// edits the work outdates its round but one rendering with shell commands must not,
/// and lead turns by the files the lead changed itself (`ownFiles`, saved before its workers' changes
/// are rolled up; a rolled-up row from before that marker counts only when it had none). One query:
/// the session index finds each team conversation's rows, and only this cycle's are read. A change is
/// dated by its turn's last write tool (`lastWriteAt`), else by when its turn ended.
pub(super) fn changed_at(store: &storage::Store, team: &TeamSnapshot) -> Result<i64> {
    if team.config.council.is_none() {
        return Ok(0);
    }
    let reviewer = |id: &str| team.workers.iter().any(|w| w.id == id && w.council.is_some());
    let reviewers: Vec<&str> = team.workers.iter().filter(|w| w.council.is_some() || w.parent_worker.as_deref().is_some_and(reviewer)).map(|w| w.session_id.as_str()).collect();
    let reviewers = serde_json::to_string(&reviewers).map_err(|e| e.to_string())?;
    // This cycle's rows only: message ids grow with time, so every row of the cycle has a message id
    // above the lead's last message from before it. `messages_session` finds that id by walking back
    // through this cycle's lead messages, and `turn_changes_session` then range-scans each session.
    let before: i64 = store.db.query_row("SELECT COALESCE((SELECT id FROM messages WHERE session_id=?1 AND created_at<?2 ORDER BY id DESC LIMIT 1),0)", params![team.session_id, team.council_since], |r| r.get(0)).map_err(|e| e.to_string())?;
    store.db.query_row("SELECT COALESCE(MAX(COALESCE(json_extract(summary,'$.lastWriteAt'),created_at)),0) FROM turn_changes WHERE (session_id=?2 OR session_id IN (SELECT session_id FROM architect_workers WHERE parent_session_id=?2)) AND (session_id NOT IN (SELECT value FROM json_each(?3)) OR json_extract(summary,'$.lastWriteAt') IS NOT NULL) AND message_id>?4 AND created_at>=?1 AND json_valid(summary) AND json_extract(summary,'$.attributed')=1 AND COALESCE(json_extract(summary,'$.ownFiles'),CASE WHEN json_type(summary,'$.teamSources') IS NULL THEN json_array_length(summary,'$.files') END,0)>0", params![team.council_since, team.session_id, reviewers, before], |r| r.get(0)).map_err(|e| e.to_string())
}

/// The lead's Council rules: config values only, because any change here resends the full rules.
pub(super) fn lead_rules(team: &TeamSnapshot, routed: bool) -> String {
    let Some(config) = team.config.council.as_ref() else {
        return String::new();
    };
    let count = match config.reviewers {
        0 => format!("at least {MIN_REVIEWERS}"),
        n => format!("exactly {n}"),
    };
    let models: std::collections::HashSet<_> = team.config.workers.iter().map(|p| (&p.provider, &p.model)).collect();
    let models = if routed || models.len() < 2 { "profileId \"auto\"" } else { "a different roster model for each reviewer, since one model is a weak council" };
    let limit = format!("Never finish below the target unless the limit of {} rounds is reached; after the last round make no more changes, and say so plainly.", config.max_rounds);
    format!(" Council is on, target {}/10. Before finishing work that changed anything, convene a council: you decide the reviewers, choosing distinct lenses that fit this work (correctness, security, UX, performance, visual quality, pacing, overall senior review, whatever matters here; round 1 fixes the lenses: each sits again in every later round under its name, and no new lens joins later), {count}, dispatched in one batch with councilLens and {models}, after writers settle. Give each reviewer the user's goal, where the work is and its lens; never prior scores, and never the score you want. The bar is every reviewer at or above the target, not the average. After a round below it, read the reports, fix real blockers through workers, verify, and convene FRESH reviewers. {limit} If the user says to accept the current scores, tell them to press Accept and finish on the Council card. End your final message with a table of each lens's first and final score.", config.target)
}

/// A reviewer's rules. They never carry the target or earlier scores.
pub(super) fn reviewer_rules(worker: &Worker) -> String {
    let Some(seat) = &worker.council else {
        return String::new();
    };
    format!(" You are an independent Council reviewer; your lens is {}. Hunt real defects and verify each by inspecting the work itself (code, output, frames, renders) or running checks; skip nitpicks that do not affect the result. Say what would raise the score. Score strictly: 10 means you found nothing worth improving; deduct for each real defect, in proportion to its impact. End your final report with the exact line `Council score: N/10`.", seat.lens)
}

/// The read-only rule for a reviewer: it reviews the work its assignment names, and its findings go
/// back as its report, not as a request for a writing follow-up.
pub(super) fn reviewer_access(worker: &Worker) -> String {
    let scope = if worker.files.is_empty() { "the work your assignment names".into() } else { worker.files.join(", ") };
    format!("This is a read-only review. Do not change the work under review: do not edit, create, or delete files, or run commands that change the checkout; put any renders or builds outside it, such as in a temporary directory. Inspect {scope} and report findings; do not fix them. Concurrent workers may change files while you inspect them.")
}

/// A live or stopped run's edits may have landed until now. A run that ended was marked when it did.
pub(super) fn note_stopped(worker: &mut Worker) {
    // Only a live run may have written just now; a parked or stopped one was marked when its run ended
    // or was stopped.
    if worker.wrote_at > 0 && !worker.read_only && !worker.abandoned && super::active(&worker.status) {
        worker.wrote_at = storage::now();
    }
}
