//! A supported launch's warm-spare check: which pool it counts in, its warm key (read off the
//! runtime, with a lead's working-tree status beside it) and the spare it adopts, if any.
use super::*;

/// Why a pooled spare went unused for want of a warm key. An unknowable config folder or
/// working-tree status say the pool's spares cannot be checked, so they join its miss streak
/// (`PoolChurn::missed`); a key check that failed to run says nothing about the spares.
const NO_CONFIG_FOLDER: &str = "its config folder cannot be known";
const NO_GIT_STATUS: &str = "its git status cannot be read";
pub(super) const KEY_CHECK_FAILED: &str = "its warm key check failed";

/// A pooled warm spare's launch check, made off the runtime: spares switched off, no key (the
/// config folder cannot be known, or a lead spare's working-tree status), or the warm key to
/// adopt against.
#[derive(Debug, PartialEq, Eq)]
enum WarmKey {
    Disabled,
    NoKey,
    NoGitStatus,
    Key(String),
}

impl WarmKey {
    /// The check's outcome once the off-runtime walk and a lead's `git status` (run side by side)
    /// are both in: spares off first, then an unreadable status, then an unknowable config
    /// folder. `walked`: `None` with spares off, else the key's fields (`key_fields`);
    /// `git_status`: `None` for an ordinary spare, else the lead's digest if it could be read.
    fn of(walked: Option<Option<Value>>, git_status: Option<Option<String>>) -> Self {
        match (walked, git_status) {
            (None, _) => WarmKey::Disabled,
            (Some(_), Some(None)) => WarmKey::NoGitStatus,
            (Some(None), _) => WarmKey::NoKey,
            (Some(Some(fields)), status) => WarmKey::Key(with_git_status(fields, status.flatten().as_deref())),
        }
    }
}

/// The warm spare this launch adopts, if any. Every launch is counted; a host-less or unsupported
/// one retires whatever spare its task holds, and one with no spare pooled skips the warm key's
/// config walk. Never aborts a turn over a warm key.
pub(in crate::providers) async fn adopt_for_launch(config: &RunConfig, host: Option<&ToolHost>) -> Option<Adopting> {
    let Some(tools) = host.filter(|_| supported(config)) else {
        launched_without_spare(&config.session_id);
        return None;
    };
    let session_id = &config.session_id;
    // Managed workers never get spares, and a brand-new conversation's first turn can never
    // have one, so neither counts as a cold launch without a spare.
    let ordinary_eligible = config.worker.is_none() && config.resume_id.is_some();
    // A team lead's launch offers the dispatch tool; its cold launches count in the lead pool.
    let is_lead = tools.tools.iter().any(|tool| tool["name"].as_str() == Some(crate::architect::DISPATCH_WORKERS_TOOL));
    let (discard_epoch, lead) = match prepare_launch(session_id, ordinary_eligible, is_lead) {
        LaunchPool::Pooled { discard_epoch, lead } => (discard_epoch, lead),
        // Counted and logged only while spares are on: with them off a launch says nothing.
        LaunchPool::Empty { may_record_cold, lead, gone } => {
            finish_empty_launch(may_record_cold, lead, gone).await;
            return None;
        }
    };
    // `discard_epoch` keeps a switch-off during the check from counting a cold launch.
    let without_key = |why: &str, joins_streak: bool| {
        launched_without_key_reason(session_id, why, joins_streak, ordinary_eligible, is_lead, discard_epoch);
        None
    };
    match launch_key(config, &tools.tools, lead).await {
        Ok(WarmKey::Key(key)) => take_checked(session_id, &key, ordinary_eligible, is_lead, discard_epoch),
        Ok(WarmKey::Disabled) => {
            launched_without_spare(session_id);
            None
        }
        // No key: the pooled spare is retired and logged.
        Ok(WarmKey::NoKey) => without_key(NO_CONFIG_FOLDER, true),
        Ok(WarmKey::NoGitStatus) => without_key(NO_GIT_STATUS, true),
        Err(err) => {
            eprintln!("Warm Claude key check failed: {err}");
            without_key(KEY_CHECK_FAILED, false)
        }
    }
}

/// The switch and the key read files (the key: the task's switches and saved settings), so both
/// run off the runtime. A `lead` spare is keyed by the working tree's `gitStatus` too (git runs
/// off the runtime, bounded, beside the walk); an unknown status adopts nothing.
async fn launch_key(config: &RunConfig, catalog: &[Value], lead: bool) -> Result<WarmKey, String> {
    let (keyed, catalog) = (config.clone(), catalog.to_vec());
    let walk = crate::blocking(move || Ok(enabled_now().then(|| key_fields(&keyed, &catalog))));
    let git = async {
        if lead { Some(lead_git_status_digest(&config.cwd).await) } else { None }
    };
    let (walked, git_status) = tokio::join!(walk, git);
    walked.map(|walked| WarmKey::of(walked, git_status))
}

/// A launch with no warm key: counts the launch, retires any pooled spare and logs the miss
/// (`why`) like `take` would, leaving no stale `gone` note.
fn launched_without_key_reason(session_id: &str, why: &str, joins_streak: bool, ordinary_eligible: bool, lead: bool, discard_epoch: u64) {
    if let Some(note) = launched_without_key_streak(&SPARES, session_id, why, joins_streak, ordinary_eligible, lead, discard_epoch) {
        eprintln!("{note}");
    }
}

/// `launched_without_key_streak` for a miss that joins the pool's miss streak.
#[cfg(test)]
pub(super) fn launched_without_key_since(pool: &Pool, session_id: &str, why: &str, ordinary_eligible: bool, lead: bool, discard_epoch: u64) -> Option<String> {
    launched_without_key_streak(pool, session_id, why, true, ordinary_eligible, lead, discard_epoch)
}

/// The note a launch without a key logs. `joins_streak`: the miss joins the pool's miss streak.
pub(super) fn launched_without_key_streak(pool: &Pool, session_id: &str, why: &str, joins_streak: bool, ordinary_eligible: bool, lead: bool, discard_epoch: u64) -> Option<String> {
    let (removed, gone) = remove_for_launch(pool, session_id);
    let Some((spare, pending)) = removed else {
        return no_spare_since(pool, gone, ordinary_eligible, lead, discard_epoch);
    };
    let note = decision_miss(pool, spare.lead, why, joins_streak);
    retire_now(session_id, spare, pending);
    Some(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_check_settles_off_then_status_then_folder() {
        let fields = || Some(serde_json::json!({ "model": "m" }));
        assert_eq!(WarmKey::of(None, Some(None)), WarmKey::Disabled, "spares off wins");
        assert_eq!(WarmKey::of(Some(fields()), Some(None)), WarmKey::NoGitStatus);
        assert_eq!(WarmKey::of(Some(None), Some(None)), WarmKey::NoGitStatus, "an unreadable status first");
        assert_eq!(WarmKey::of(Some(None), None), WarmKey::NoKey);
        let plain = with_git_status(fields().unwrap(), None);
        assert_eq!(WarmKey::of(Some(fields()), None), WarmKey::Key(plain));
        let lead = with_git_status(fields().unwrap(), Some("digest"));
        assert_eq!(WarmKey::of(Some(fields()), Some(Some("digest".into()))), WarmKey::Key(lead));
    }
}
