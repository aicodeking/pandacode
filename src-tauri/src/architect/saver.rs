//! A worker's token saver: the `tokenSaver` schema, how a launch's packs are resolved, and the
//! block its prompt carries. The packs and their text live in `crate::token_saver`.
use super::*;
use crate::token_saver::Applied;

pub(super) fn token_saver_schema() -> Value {
    json!({"type":["string","object"],"description":"\"none\" or {packs, level}."})
}

/// The lead's tokenSaver guidance, sent with its rules only when it can matter (the schema
/// itself stays one line on every team request): measured, packs saved nothing. Keep the
/// literal's `Start assignments` opening: the pinned `findLeadGuidance` in
/// `scripts/agent-bench/saver.mjs` finds it by that and reads from `tokenSaver:` onward.
pub(super) const LEAD_SAVER_GUIDANCE: &str = concat!(" ", "Start assignments with tokenSaver: \"none\" or {packs: caveman|lean-code|quiet-tools|rtk, level: lite|full|ultra, caveman only}; default \"none\". Measured: packs did not cut worker cost; leave it unless the user asks. lean-code+quiet-tools for edits is optional and unproven.");

/// `LEAD_SAVER_GUIDANCE` when the user turned token saver packs on in the lead's thread (its
/// newest token saver block is not a switch-off) or the team guidance mentions them, else "".
pub(super) fn lead_saver_guidance(store: &Store, sid: &str, guidance: &str) -> Result<&'static str> {
    let lower = guidance.to_lowercase();
    if lower.contains("tokensaver") || lower.contains("token saver") {
        return Ok(LEAD_SAVER_GUIDANCE);
    }
    let header = crate::token_saver::HEADER;
    let newest: Option<String> = store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND role='user' AND instr(content,?2)>0 ORDER BY id DESC LIMIT 1", params![sid, header], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let on = newest.and_then(|text| text.rfind(header).map(|at| !text[at + header.len()..].starts_with("): off."))).unwrap_or(false);
    Ok(if on { LEAD_SAVER_GUIDANCE } else { "" })
}

/// A worker's token saver: the one asked for, else `existing` (follow-ups). The dispatching
/// thread's own saver is not inherited: measured, packs did not cut worker cost. `rtk` is not
/// checked: its pack says to run a rejected command plainly.
pub(super) fn resolve_saver(requested: Option<&Value>, existing: &Applied) -> Result<Applied> {
    let Some(value) = requested else {
        return Ok(Applied { switch_off: false, ..existing.clone() });
    };
    let mut applied = crate::token_saver::parse(value)?;
    // Only a conversation whose last launch carried packs needs to hear they are off.
    applied.switch_off = applied.packs.is_empty() && !existing.packs.is_empty();
    Ok(applied)
}

/// The token saver block a worker launch carries: its packs, or a switch-off when the packs
/// its previous launch carried are now off.
pub(super) fn saver_block(worker: &Worker) -> String {
    if worker.token_saver.is_empty() {
        String::new()
    } else {
        worker.token_saver.block()
    }
}
