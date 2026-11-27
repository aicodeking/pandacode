//! A supported launch's warm-spare check: which pool it counts in, its warm key (read off the
//! runtime, with the working tree's status beside it) and the spare it adopts, if any.
use super::*;

/// Why a pooled spare went unused for want of a warm key. An unavailable config fingerprint or
/// working-tree status say the pool's spares cannot be checked, so they join its miss streak
/// (`PoolChurn::missed`); a key check that failed to run says nothing about the spares.
const NO_CONFIG_FINGERPRINT: &str = "its config cannot be fingerprinted";
const NO_GIT_STATUS: &str = "its git status cannot be read";
pub(super) const KEY_CHECK_FAILED: &str = "its warm key check failed";

/// A pooled warm spare's launch check, made off the runtime: spares switched off, an unavailable
/// config fingerprint or working-tree status, or the warm key to adopt against.
#[derive(Debug, PartialEq, Eq)]
enum WarmKey {
    Disabled,
    NoKey,
    NoGitStatus,
    Key(String),
}

impl WarmKey {
    /// The check's outcome once the off-runtime walk and the working tree's `git status` (run
    /// side by side) are both in: spares off first, then an unreadable status, then an
    /// unavailable config fingerprint. `walked`: `None` with spares off, else the key's fields
    /// (`key_fields`); `git_status`: the working tree's digest, `None` if it could not be read.
    fn of(walked: Option<Option<Value>>, git_status: Option<String>) -> Self {
        match (walked, git_status) {
            (None, _) => WarmKey::Disabled,
            (Some(_), None) => WarmKey::NoGitStatus,
            (Some(None), _) => WarmKey::NoKey,
            (Some(Some(fields)), Some(status)) => WarmKey::Key(with_git_status(fields, Some(&status))),
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
    let discard_epoch = match prepare_launch(session_id, ordinary_eligible, is_lead) {
        LaunchPool::Pooled { discard_epoch } => discard_epoch,
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
    match launch_key(config, &tools.tools).await {
        Ok(WarmKey::Key(key)) => take_checked(session_id, &key, ordinary_eligible, is_lead, discard_epoch),
        Ok(WarmKey::Disabled) => {
            launched_without_spare(session_id);
            None
        }
        // No key: the pooled spare is retired and logged.
        Ok(WarmKey::NoKey) => without_key(NO_CONFIG_FINGERPRINT, true),
        Ok(WarmKey::NoGitStatus) => without_key(NO_GIT_STATUS, true),
        Err(err) => {
            eprintln!("Warm Claude key check failed: {err}");
            without_key(KEY_CHECK_FAILED, false)
        }
    }
}

/// The switch and the key read files (the key: the task's switches and saved settings), so both
/// run off the runtime. Every spare is keyed by the working tree's `gitStatus` too (git runs off
/// the runtime, bounded, beside the walk); an unknown status adopts nothing. Only a launch with a
/// pooled spare gets here, so a cold launch never runs git. The switch is read again once both
/// are in (`settle_launch_key`).
async fn launch_key(config: &RunConfig, catalog: &[Value]) -> Result<WarmKey, String> {
    let (keyed, catalog) = (config.clone(), catalog.to_vec());
    let walk = crate::blocking(move || Ok(enabled_now().then(|| key_fields(&keyed, &catalog))));
    let (walked, git_status) = tokio::join!(walk, git_status_digest(&config.cwd));
    Ok(settle_launch_key(walked?, git_status, enabled_off_runtime).await)
}

/// Settle the parallel walk and `git status` read, re-checking the opt-in switch once both
/// finish so deleting `warm-spares-on` on a headless host during `git status` still
/// settles to `WarmKey::Disabled` and retires the pooled spare instead of adopting it.
async fn settle_launch_key<E, EFut>(walked: Option<Option<Value>>, git_status: Option<String>, still_enabled: E) -> WarmKey
where
    E: FnOnce() -> EFut,
    EFut: std::future::Future<Output = bool>,
{
    if walked.is_none() || !still_enabled().await {
        return WarmKey::Disabled;
    }
    WarmKey::of(walked, git_status)
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
        let status = || Some("digest".to_string());
        assert_eq!(WarmKey::of(None, None), WarmKey::Disabled, "spares off wins");
        assert_eq!(WarmKey::of(None, status()), WarmKey::Disabled, "spares off wins over a status too");
        assert_eq!(WarmKey::of(Some(fields()), None), WarmKey::NoGitStatus);
        assert_eq!(WarmKey::of(Some(None), None), WarmKey::NoGitStatus, "an unreadable status first");
        assert_eq!(WarmKey::of(Some(None), status()), WarmKey::NoKey);
        let keyed = with_git_status(fields().unwrap(), Some("digest"));
        assert_eq!(WarmKey::of(Some(fields()), status()), WarmKey::Key(keyed));
    }

    #[tokio::test]
    async fn removing_the_opt_in_during_git_status_retires_instead_of_adopting() {
        let dir = std::env::temp_dir().join(format!("warm-adopt-switch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join(WARM_SPARES_ON_FILE);
        // The switch read again after the walk and `git status`, from this folder's marker.
        let enabled = || {
            let dir = dir.clone();
            move || async move { enabled_in(Ok(dir)) }
        };
        let fields = || Some(Some(serde_json::json!({ "model": "m" })));
        std::fs::write(&marker, "").unwrap();
        let keyed = with_git_status(serde_json::json!({ "model": "m" }), Some("digest"));
        assert_eq!(settle_launch_key(fields(), Some("digest".into()), enabled()).await, WarmKey::Key(keyed), "still on: the key to adopt against");
        // The walk saw spares on; the marker is removed while `git status` runs.
        std::fs::remove_file(&marker).unwrap();
        for git_status in [Some("digest".to_string()), None] {
            assert_eq!(settle_launch_key(fields(), git_status.clone(), enabled()).await, WarmKey::Disabled, "status {git_status:?}");
        }
        // Spares already off at the walk: the switch is not read again.
        std::fs::write(&marker, "").unwrap();
        let read = std::cell::Cell::new(false);
        let settled = settle_launch_key(None, Some("digest".into()), || {
            read.set(true);
            async { true }
        })
        .await;
        assert_eq!(settled, WarmKey::Disabled);
        assert!(!read.get(), "a walk with spares off never reads the switch again");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
