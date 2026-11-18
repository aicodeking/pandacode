//! Account usage limits seen during a run. A `limited` event carries the reset
//! time in milliseconds when the harness reports one, and `null` otherwise:
//! a reset schedule is never guessed.

use super::*;

/// Latest reset among the exhausted windows of a Codex rate-limit snapshot, in ms.
pub(super) fn codex_exhausted_reset(snapshot: &Value) -> Option<i64> {
    ["primary", "secondary"]
        .iter()
        .map(|key| &snapshot[key])
        .filter(|window| window["usedPercent"].as_i64().is_some_and(|used| used >= 100))
        .filter_map(|window| window["resetsAt"].as_i64())
        .max()
        .map(|seconds| seconds * 1000)
}

fn codex_usage_limit(error: &Value) -> bool {
    let info = &error["codexErrorInfo"];
    info == "usageLimitExceeded" || info.get("usageLimitExceeded").is_some()
}

impl Protocol {
    pub(super) fn limited_event(&self, resets_at: Option<i64>, window: Option<&str>) -> AgentEvent {
        let label = match window {
            Some("five_hour") => "5-hour usage limit reached",
            Some("seven_day" | "seven_day_opus" | "seven_day_sonnet") => "Weekly usage limit reached",
            _ => "Usage limit reached",
        };
        // Structured data bypasses the generic metadata allowlist on purpose.
        let mut event = self.event("limited", label, None);
        event.data = Some(json!({"resetsAt":resets_at,"window":window}));
        event
    }

    /// Claude Code reports each limit check; `rejected` means the account is out until `resetsAt`.
    pub(super) fn claude_rate_limit(&self, value: &Value, step: &mut Step) {
        let info = &value["rate_limit_info"];
        // An account pool leaves an account near its limit for the next turn.
        if self.config.provider == "claude" {
            let window = info["rateLimitType"].as_str().unwrap_or("unknown");
            let resets = info["resetsAt"].as_i64().map(|seconds| seconds * 1000);
            match info["status"].as_str() {
                Some("allowed_warning") => crate::account_pool::note_usage(&self.config.session_id, "claude", window, crate::account_pool::NEAR_PERCENT, resets),
                Some("allowed") => crate::account_pool::note_usage(&self.config.session_id, "claude", window, 0.0, None),
                _ => {}
            }
        }
        if info["status"] == "rejected" {
            let resets = info["resetsAt"].as_i64().filter(|seconds| *seconds > 0).map(|seconds| seconds * 1000);
            step.events.push(self.limited_event(resets, info["rateLimitType"].as_str()));
        }
    }

    pub(super) fn codex_rate_limits(&mut self, params: &Value) {
        self.codex_limits = params["rateLimits"].clone();
        // Each window tells an account pool how near the account is to a limit.
        for name in ["primary", "secondary"] {
            let window = &self.codex_limits[name];
            if let Some(percent) = window["usedPercent"].as_f64() {
                crate::account_pool::note_usage(&self.config.session_id, "codex", name, percent, window["resetsAt"].as_i64().map(|s| s * 1000));
            }
        }
    }

    /// The event for a Codex usage-limit error, using the last snapshot for the reset time.
    pub(super) fn codex_limited(&self, params: &Value) -> Option<AgentEvent> {
        codex_usage_limit(&params["error"]).then(|| self.limited_event(codex_exhausted_reset(&self.codex_limits), None))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::config;
    use super::*;

    #[test]
    fn claude_rejection_carries_its_reset_and_allowed_checks_are_quiet() {
        let p = Protocol::new(config("claude"));
        let mut step = Step::default();
        p.claude_rate_limit(&json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791013800,"rateLimitType":"five_hour"}}), &mut step);
        assert!(step.events.is_empty());
        p.claude_rate_limit(&json!({"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791013800,"rateLimitType":"five_hour"}}), &mut step);
        assert_eq!(step.events[0].kind, "limited");
        assert_eq!(step.events[0].text, "5-hour usage limit reached");
        assert_eq!(step.events[0].data.as_ref().unwrap()["resetsAt"], 1_791_013_800_000_i64);
        let mut unknown = Step::default();
        p.claude_rate_limit(&json!({"rate_limit_info":{"status":"rejected"}}), &mut unknown);
        assert!(unknown.events[0].data.as_ref().unwrap()["resetsAt"].is_null(), "no reset time is invented");
    }

    #[test]
    fn codex_limit_errors_use_the_exhausted_window_reset_only() {
        let mut p = Protocol::new(config("codex"));
        assert!(p.codex_limited(&json!({"error":{"message":"boom","codexErrorInfo":"badRequest"}})).is_none());
        let event = p.codex_limited(&json!({"error":{"message":"limit","codexErrorInfo":"usageLimitExceeded"}})).unwrap();
        assert!(event.data.unwrap()["resetsAt"].is_null(), "unknown until a snapshot arrives");
        p.codex_rate_limits(&json!({"rateLimits":{"primary":{"usedPercent":40,"resetsAt":100},"secondary":{"usedPercent":100,"resetsAt":200}}}));
        let event = p.codex_limited(&json!({"error":{"codexErrorInfo":{"usageLimitExceeded":{}}}})).unwrap();
        assert_eq!(event.data.unwrap()["resetsAt"], 200_000);
        assert_eq!(codex_exhausted_reset(&json!({"primary":{"usedPercent":99,"resetsAt":5}})), None);
    }
}
