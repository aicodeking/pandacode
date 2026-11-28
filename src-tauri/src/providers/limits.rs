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

/// A Codex login another pooled account can take over from: its OAuth session could not be
/// refreshed (`unauthorized`) or the account is signed out (`authenticationRequired`). Both
/// variants arrive as a plain string or as a `{variant: {}}` object, as usage limits do.
pub(super) fn codex_auth_failure(error: &Value) -> bool {
    let info = &error["codexErrorInfo"];
    ["unauthorized", "authenticationRequired"]
        .iter()
        .any(|variant| info == *variant || info.get(*variant).is_some())
}

/// The same unrecoverable login in an error message. A Codex app-server auth error reaches the
/// pool as the run's `Err` (its handler returns `Err` rather than pushing the payload), so the
/// wording is what the pool sees: "Your access token could not be refreshed…", a failed token
/// refresh, `unauthorized`, or an OAuth `invalid_grant`. Quota and per-turn errors are not here.
pub(super) fn auth_failure_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "unauthorized",
        "unauthenticated",
        "authentication required",
        "authenticationrequired",
        "authentication failed",
        "not authenticated",
        "sign in again",
        "log in again",
        "log out and sign in",
        "could not be refreshed",
        "failed to refresh token",
        "could not refresh token",
        "token refresh failed",
        "refresh token was rejected",
        "invalid_grant",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Fatal warning banner emitted by Antigravity as assistant text on turn end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AntigravitySoftError {
    pub message: String,
    pub limited: bool,
    pub resets_at: Option<i64>,
}

pub(super) fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Parses a human reset duration such as `Resets in 2h 15m`, `Quota will reset after 45m`,
/// or `Resets in 1d 2h`.
pub(super) fn parse_antigravity_reset_duration(text: &str) -> Option<Duration> {
    let lower = text.to_ascii_lowercase();
    for marker in [
        "quota will reset after ",
        "quota resets in ",
        "resets after ",
        "reset after ",
        "resets in ",
        "reset in ",
        "try again in ",
    ] {
        let mut search = lower.as_str();
        while let Some(pos) = search.find(marker) {
            let tail = &search[pos + marker.len()..];
            if let Some(duration) = parse_duration_tokens(tail) {
                return Some(duration);
            }
            search = tail;
        }
    }
    None
}

fn parse_duration_tokens(input: &str) -> Option<Duration> {
    const MAX_RESET_SECS: u64 = 7 * 86_400;
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut total_secs: u64 = 0;
    let mut matched = false;
    while i < bytes.len() {
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b',') {
            i += 1;
        }
        if input[i..].starts_with("and ") {
            i += 4;
            continue;
        }
        let digit_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == digit_start {
            break;
        }
        let value: u64 = input[digit_start..i].parse().ok()?;
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        let unit_start = i;
        while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            i += 1;
        }
        if i == unit_start {
            break;
        }
        let multiplier: u64 = match &input[unit_start..i] {
            "d" | "day" | "days" => 86_400,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3_600,
            "m" | "min" | "mins" | "minute" | "minutes" => 60,
            "s" | "sec" | "secs" | "second" | "seconds" => 1,
            _ => break,
        };
        total_secs = total_secs.checked_add(value.checked_mul(multiplier)?)?;
        matched = true;
    }
    (matched && total_secs > 0 && total_secs <= MAX_RESET_SECS).then(|| Duration::from_secs(total_secs))
}

fn antigravity_reset_at(text: &str, now_ms: i64) -> Option<i64> {
    let duration = parse_antigravity_reset_duration(text)?;
    let millis = i64::try_from(duration.as_millis()).ok()?;
    now_ms.checked_add(millis)
}

fn is_http_429_phrase(lower: &str) -> bool {
    [
        "resource_exhausted",
        "code 429",
        "code: 429",
        "code=429",
        "status 429",
        "status: 429",
        "status=429",
        "http 429",
        "http/1.1 429",
        "http/2 429",
        "429 too many requests",
        "429: too many requests",
        "too many requests",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn strip_warning_prefix(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('⚠')?;
    let rest = rest.strip_prefix('\u{fe0f}').unwrap_or(rest);
    Some(rest.trim())
}

fn is_structured_warning_line(lower: &str, trimmed: &str) -> bool {
    lower.starts_with("http")
        || lower.starts_with("grpc")
        || trimmed.starts_with('{')
        || lower.starts_with("code:")
        || lower.starts_with("status:")
        || lower.starts_with("details:")
        || lower.starts_with("reason:")
        || lower.starts_with("message:")
}

fn is_antigravity_followup(lower: &str) -> bool {
    is_http_429_phrase(lower)
        || [
            "individual quota",
            "quota reached",
            "quota exceeded",
            "check quota",
            "quota will reset",
            "credits balance",
            "add credits",
            "upgrade your subscription",
            "exhausted your capacity",
            "resource_exhausted",
            "stream was interrupted",
            "model produced invalid output",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn is_warning_continuation(raw_line: &str) -> bool {
    let trimmed = raw_line.trim();
    if trimmed.is_empty() || trimmed.starts_with("```") {
        return false;
    }
    if parse_antigravity_reset_duration(trimmed).is_some() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    is_structured_warning_line(&lower, trimmed) || is_antigravity_followup(&lower)
}

/// The quota or credit phrase that limited the account, for a lowercased text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AntigravityPhraseLimit {
    Credits,
    Quota,
}

/// The one quota and credit phrase test behind both Antigravity classifiers, so
/// they cannot drift. A context window mention (`The context window quota will
/// reset after 2h`) is a per-conversation limit rather than an account limit, so
/// it is excluded; only an explicit `individual quota reached` and the 429-class
/// `RESOURCE_EXHAUSTED` stay a limit.
fn antigravity_phrase_limit(lower: &str) -> Option<AntigravityPhraseLimit> {
    let account = !lower.contains("context");
    if account && (lower.contains("ai credits balance") || lower.contains("credits balance is too low")) {
        return Some(AntigravityPhraseLimit::Credits);
    }
    if lower.contains("individual quota reached")
        || lower.contains("resource_exhausted")
        || (account
            && [
                "quota reached",
                "quota exceeded",
                "check quota",
                "quota will reset",
                // Phrases agy 1.5 prints itself.
                "exhausted your quota",
                "out of quota",
                "usage limit reached",
            ]
            .iter()
            .any(|needle| lower.contains(needle)))
    {
        return Some(AntigravityPhraseLimit::Quota);
    }
    None
}

fn classify_antigravity_banner(banner: &str, now_ms: i64) -> Option<AntigravitySoftError> {
    let lower = banner.to_ascii_lowercase();
    if let Some(limit) = antigravity_phrase_limit(&lower) {
        return Some(AntigravitySoftError {
            message: format!("Antigravity: {banner}"),
            limited: true,
            resets_at: match limit {
                // Credits do not reset on a schedule, so no reset time is read.
                AntigravityPhraseLimit::Credits => None,
                AntigravityPhraseLimit::Quota => antigravity_reset_at(banner, now_ms),
            },
        });
    }
    if is_http_429_phrase(&lower) || lower.contains("exhausted your capacity") {
        return Some(AntigravitySoftError {
            message: format!("Antigravity: {banner}"),
            limited: true,
            resets_at: antigravity_reset_at(banner, now_ms),
        });
    }
    if lower.contains("stream was interrupted")
        || lower.contains("model produced invalid output")
    {
        return Some(AntigravitySoftError {
            message: format!("Antigravity: {banner}"),
            limited: false,
            resets_at: None,
        });
    }
    None
}

/// The agent's own last line can carry a `⚠` too: a note quoting an error, or an
/// expected test result. agy's banner is its own sentence, so reported speech is
/// never a banner.
fn is_reported_speech(lower: &str) -> bool {
    ["note", "nb:", "expected"].iter().any(|prefix| lower.starts_with(prefix))
        || lower.contains('`')
        || ["mock server", "the test", "the tests", "test still", "tests still", "unit test"]
            .iter()
            .any(|needle| lower.contains(needle))
}

/// Whether unrecognised lines after a warning line are agy's explanation of it: only a
/// line that alone is already a limit by a strong phrase (RESOURCE_EXHAUSTED, a 429,
/// quota or credit phrase) and that is not a finished sentence. A whole banner the agent
/// quotes (`⚠ Individual quota reached. Resets in 2h.` followed by its own remark) is.
fn explains_following_prose(header: &str, now_ms: i64) -> bool {
    let header = header.trim_end();
    classify_antigravity_banner(header, now_ms).is_some_and(|error| error.limited)
        && !matches!(header.chars().last(), Some('.' | '!' | '?'))
}

/// Classifies trailing Antigravity `⚠` fatal warning banners at the end of a turn,
/// supporting multi-line wrapped banners, agy's explanation lines after a limit and
/// partial preceding prose, while ignoring casual mid-sentence `⚠` mentions, the agent's
/// own `⚠` notes and non-warning prose after a `⚠` line.
pub(super) fn antigravity_soft_error(
    text: &str,
    now_ms: i64,
) -> Option<AntigravitySoftError> {
    let lines: Vec<&str> = text.lines().collect();
    let mut end = lines.len();
    while end > 0 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let mut blocks: Vec<String> = Vec::new();
    let mut pending_cont: Vec<&str> = Vec::new();
    // Unrecognised lines right after a warning line: agy's explanation (at most two, no
    // blank line before the warning line), which that line may allow once it is reached.
    // They are never part of the banner text.
    let mut pending_prose: Vec<&str> = Vec::new();
    let mut i = end;
    while i > 0 {
        i -= 1;
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !pending_cont.is_empty() || !pending_prose.is_empty() {
                if blocks.is_empty() {
                    return None;
                }
                break;
            }
            continue;
        }
        if let Some(header) = strip_warning_prefix(line) {
            let mut block = String::from(header);
            for cont in pending_cont.drain(..).rev() {
                if !block.is_empty() {
                    block.push(' ');
                }
                block.push_str(cont);
            }
            // The agent's own `⚠` line is not agy's banner, and prose after a warning line
            // is agy's explanation only when the warning line alone is already a limit.
            let own_prose = is_reported_speech(&block.to_ascii_lowercase())
                || (!pending_prose.is_empty() && !explains_following_prose(header, now_ms));
            if own_prose {
                if blocks.is_empty() {
                    return None;
                }
                break;
            }
            pending_prose.clear();
            if !block.is_empty() {
                blocks.push(block);
            }
        } else if is_warning_continuation(line) {
            pending_cont.push(trimmed);
        } else if blocks.is_empty() && pending_prose.len() < 2 {
            pending_prose.push(trimmed);
        } else {
            // Prose before the banner ends the scan, as does a third unrecognised line.
            if blocks.is_empty() {
                return None;
            }
            break;
        }
    }
    if blocks.is_empty() {
        return None;
    }
    // Prioritize any `limited: true` banner (preserving `resets_at`) over a
    // trailing non-limited `stream was interrupted` / `invalid output` banner.
    let mut best_limited: Option<AntigravitySoftError> = None;
    let mut best_other: Option<AntigravitySoftError> = None;
    for banner in &blocks {
        let Some(classified) = classify_antigravity_banner(banner, now_ms) else {
            continue;
        };
        if classified.limited {
            match &mut best_limited {
                None => best_limited = Some(classified),
                Some(existing) if existing.resets_at.is_none() && classified.resets_at.is_some() => {
                    existing.resets_at = classified.resets_at;
                }
                _ => {}
            }
        } else if best_other.is_none() {
            best_other = Some(classified);
        }
    }
    best_limited.or(best_other)
}

/// Classifies Antigravity JSON-RPC error frames that represent quota, credit, or 429 rate limits.
/// Returns `Some(resets_at)` when rate-limited, or `None` for ordinary errors.
/// The quota and credit phrases are the banner's, so a context window limit is
/// per conversation here too and never rotates an account pool.
pub(super) fn antigravity_rpc_limited(frame: &Value, now_ms: i64) -> Option<Option<i64>> {
    let error = frame.get("error")?;
    let mut parts = Vec::new();
    for candidate in [
        error["message"].as_str(),
        error["data"].as_str(),
        error["data"]["message"].as_str(),
        error["data"]["details"].as_str(),
        error["data"]["error"].as_str(),
    ] {
        if let Some(part) = candidate.filter(|s| !s.is_empty()) {
            parts.push(part);
        }
    }
    let combined = parts.join(" ");
    let lower = combined.to_ascii_lowercase();
    // agy reports `data.code` as a number or as the string "429".
    let data_429 = error["data"]["status"].as_i64() == Some(429)
        || error["data"]["code"].as_i64() == Some(429)
        || error["data"]["code"] == "429";
    // Structured 429s and HTTP 429 phrases are limits whatever the wording, as in the banner.
    let limited = error["code"].as_i64() == Some(429)
        || data_429
        || is_http_429_phrase(&lower)
        || lower.contains("exhausted your capacity")
        || antigravity_phrase_limit(&lower).is_some();
    limited.then(|| antigravity_reset_at(&combined, now_ms))
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

    #[test]
    fn codex_auth_failures_are_login_errors_only() {
        for error in [
            json!({"message":"login","codexErrorInfo":"unauthorized"}),
            json!({"message":"login","codexErrorInfo":"authenticationRequired"}),
            json!({"codexErrorInfo":{"unauthorized":{}}}),
            json!({"codexErrorInfo":{"authenticationRequired":{}}}),
        ] {
            assert!(codex_auth_failure(&error), "{error}");
        }
        // A usage limit rotates through the limit path, and a bad request or a per-turn limit is
        // no reason to leave the account.
        for error in [
            json!({"codexErrorInfo":"usageLimitExceeded"}),
            json!({"codexErrorInfo":{"usageLimitExceeded":{}}}),
            json!({"codexErrorInfo":"badRequest"}),
            json!({"codexErrorInfo":"contextWindowExceeded"}),
            json!({"codexErrorInfo":"serverOverloaded"}),
            json!({"codexErrorInfo":{"badRequest":{}}}),
            json!({"message":"boom"}),
            json!({}),
        ] {
            assert!(!codex_auth_failure(&error), "{error}");
        }
    }

    #[test]
    fn auth_failure_messages_name_an_unrefreshable_login_only() {
        for message in [
            "unauthorized",
            "Unauthorized: 401",
            "authentication required",
            "AuthenticationRequired",
            "Not authenticated",
            "Your access token could not be refreshed. Please log out and sign in again.",
            "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
            "failed to refresh token while getting account: 403 Forbidden",
            "OAuth refresh token was rejected: invalid_grant",
        ] {
            assert!(auth_failure_message(message), "{message}");
        }
        for message in [
            "usageLimitExceeded",
            "You have reached your usage limit",
            "rate limit exceeded",
            "429 Too Many Requests",
            "badRequest: missing field `model`",
            "contextWindowExceeded",
            "context window exceeded",
            "serverOverloaded",
            // Ordinary harness failures and a user-cancelled run must reach the user untouched.
            "cargo test failed: expected 4, got 5",
            "TypeError: cannot read properties of undefined",
            "The run was cancelled by the user",
            "Provider exited before responding",
            "Syntax error in session-429 at line 429",
        ] {
            assert!(!auth_failure_message(message), "{message}");
        }
    }

    #[test]
    fn antigravity_reset_duration_parses_common_units() {
        assert_eq!(parse_antigravity_reset_duration("Resets in 2h 15m."), Some(Duration::from_secs(2 * 3600 + 15 * 60)));
        assert_eq!(parse_antigravity_reset_duration("Try again in 45m"), Some(Duration::from_secs(45 * 60)));
        assert_eq!(parse_antigravity_reset_duration("Quota will reset after 3h"), Some(Duration::from_secs(3 * 3600)));
        assert_eq!(parse_antigravity_reset_duration("Quota resets in 1d 2h"), Some(Duration::from_secs(86_400 + 2 * 3600)));
        assert_eq!(parse_antigravity_reset_duration("reset after 2h15m30s"), Some(Duration::from_secs(2 * 3600 + 15 * 60 + 30)));
        assert_eq!(parse_antigravity_reset_duration("resets after 10m"), Some(Duration::from_secs(10 * 60)));
        assert_eq!(parse_antigravity_reset_duration("reset in 30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_antigravity_reset_duration("No duration here"), None);
        assert_eq!(parse_antigravity_reset_duration("Resets in 0m"), None);
        // Bare "after <duration>" without a reset-specific marker must never false-positive.
        assert_eq!(parse_antigravity_reset_duration("Request timed out after 30s"), None);
        assert_eq!(parse_antigravity_reset_duration("Failed after 5m of retries"), None);
    }

    #[test]
    fn antigravity_soft_error_classifies_banners_and_ignores_normal_replies() {
        let now = 1_700_000_000_000_i64;
        let credits = antigravity_soft_error("⚠ Your AI credits balance is too low to continue.", now).unwrap();
        assert!(credits.limited);
        assert_eq!(credits.resets_at, None);
        assert!(credits.message.contains("AI credits balance"));

        let quota = antigravity_soft_error("⚠ Individual quota reached for Gemini 4 Neon. Resets in 2h 15m.", now).unwrap();
        assert!(quota.limited);
        assert_eq!(quota.resets_at, Some(now + (2 * 3600 + 15 * 60) * 1000));

        let api_429 = antigravity_soft_error(
            "⚠ API error (attempt 1/3): temporary\n⚠ API error (attempt 2/3): RESOURCE_EXHAUSTED: You have exhausted your capacity. Resets in 45m.",
            now,
        ).unwrap();
        assert!(api_429.limited);
        assert_eq!(api_429.resets_at, Some(now + 45 * 60 * 1000));

        let interrupted = antigravity_soft_error("⚠ The stream was interrupted.", now).unwrap();
        assert!(!interrupted.limited);
        assert_eq!(interrupted.resets_at, None);

        let invalid = antigravity_soft_error("⚠ Model produced invalid output.", now).unwrap();
        assert!(!invalid.limited);

        // Multi-line wrapped banner (both indented and unindented reset continuation).
        let wrapped_indented = antigravity_soft_error(
            "⚠ Individual quota reached for Gemini 4 Neon.\n  Resets in 2h 15m.",
            now,
        ).unwrap();
        assert!(wrapped_indented.limited);
        assert_eq!(wrapped_indented.resets_at, Some(now + (2 * 3600 + 15 * 60) * 1000));

        let wrapped_unindented = antigravity_soft_error(
            "⚠ Individual quota reached for Gemini 4 Neon.\nResets in 1h 30m.",
            now,
        ).unwrap();
        assert!(wrapped_unindented.limited);
        assert_eq!(wrapped_unindented.resets_at, Some(now + 90 * 60 * 1000));

        // Partial prose followed by a trailing fatal `⚠` banner is detected.
        let trailing_interrupted = antigravity_soft_error(
            "I'll start inspecting the repository structure now...\n⚠ The stream was interrupted.",
            now,
        ).unwrap();
        assert!(!trailing_interrupted.limited);
        assert!(trailing_interrupted.message.contains("stream was interrupted"));

        let trailing_credits = antigravity_soft_error(
            "Here is the first part of my analysis.\n\n⚠ Your AI credits balance is too low to continue.",
            now,
        ).unwrap();
        assert!(trailing_credits.limited);
        assert_eq!(trailing_credits.resets_at, None);

        // Mixed `⚠` blocks: prioritize `limited: true` (preserving `resets_at`) over `stream was interrupted`.
        let mixed = antigravity_soft_error(
            "Checking files...\n⚠ API error: RESOURCE_EXHAUSTED (code 429). Resets in 45m.\n⚠ The stream was interrupted.",
            now,
        ).unwrap();
        assert!(mixed.limited);
        assert_eq!(mixed.resets_at, Some(now + 45 * 60 * 1000));

        // Normal prose mentioning `⚠` mid-sentence or non-warning prose after `⚠` must never false-positive.
        assert!(antigravity_soft_error("When quota runs out, agy prints \"⚠ Individual quota reached. Resets in 2h.\" to stderr.", now).is_none());
        assert!(antigravity_soft_error("⚠ Individual quota reached. Resets in 2h.\nThat is the message agy prints when your quota is full.", now).is_none());
        assert!(antigravity_soft_error("⚠ Individual quota reached. Resets in 2h.\n  That is the message agy prints when it runs out.", now).is_none());
        assert!(antigravity_soft_error("⚠ Your AI credits balance is too low to continue.\n  Let me know if you want me to handle this.", now).is_none());
        assert!(antigravity_soft_error("⚠ Your AI credits balance is too low to continue.\n\n  Let me know if you want me to handle this error.", now).is_none());
        assert!(antigravity_soft_error("Example:\n```\n⚠ Individual quota reached. Resets in 2h.\n```", now).is_none());
        assert!(antigravity_soft_error("⚠ Note: remember to run tests before committing.", now).is_none());
        // Bare `429` without HTTP/code/status qualifier must not false-positive.
        assert!(antigravity_soft_error("⚠ Warning at line 429 of src/main.rs.", now).is_none());
    }

    #[test]
    fn antigravity_rpc_limited_detects_quota_credits_and_429() {
        let now = 1_700_000_000_000_i64;
        let r1 = antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"RESOURCE_EXHAUSTED: exhausted your capacity. Quota will reset after 3h"}}), now);
        assert_eq!(r1, Some(Some(now + 3 * 3600 * 1000)));
        let r2 = antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"API error","data":{"details":"HTTP 429 Too Many Requests"}}}), now);
        assert_eq!(r2, Some(None));
        let r3 = antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"Your AI credits balance is too low"}}), now);
        assert_eq!(r3, Some(None));
        let r4 = antigravity_rpc_limited(&json!({"error":{"code":429,"message":"Too many requests"}}), now);
        assert_eq!(r4, Some(None));
        let r5 = antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"Invalid working directory"}}), now);
        assert_eq!(r5, None);
        // A context window limit is per conversation, not an account limit: no `limited` event.
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"context window quota exceeded"}}), now),
            None
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"The context window quota will reset after 2h"}}), now),
            None
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"Your AI credits balance is too low for this context"}}), now),
            None
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"individual quota reached. quota will reset after 2h"}}), now),
            Some(Some(now + 2 * 3600 * 1000))
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32000,"data":{"status":429,"message":"slow down"}}}), now),
            Some(None)
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"AI credits balance is too low"}}), now),
            Some(None)
        );
        assert_eq!(antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"session not found"}}), now), None);
        // Phrases agy 1.5 prints itself are account limits; a path is not.
        for message in [
            "You have exhausted your quota on this model.",
            "Gemini 4 Neon is out of quota until 3:04 PM; pick another",
            "Usage limit reached",
            "RESOURCE_EXHAUSTED",
        ] {
            assert_eq!(
                antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":message}}), now),
                Some(None),
                "{message}"
            );
        }
        assert_eq!(antigravity_rpc_limited(&json!({"error":{"code":-32000,"message":"Failed to read /Users/x/quota/README"}}), now), None);
        // Bare "quota" in a file path or bare "429" in an identifier/line number must not false-positive.
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"Failed to read /Users/me/quota/config.json"}}), now),
            None
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"Syntax error in session-429 at line 429"}}), now),
            None
        );
    }

    #[test]
    fn banner_and_rpc_classifiers_agree_on_account_limits() {
        let now = 1_700_000_000_000_i64;
        for (message, limited) in [
            ("context window quota exceeded", false),
            ("The context window quota will reset after 2h", false),
            ("Your AI credits balance is too low for this context", false),
            ("Please check quota in the context settings", false),
            // The banner never excludes its explicit `individual quota reached` phrase.
            ("Context window: individual quota reached", true),
            ("individual quota reached. quota will reset after 2h", true),
            ("AI credits balance is too low", true),
            ("Please check quota before retrying", true),
            // 429 phrases are limits whatever the wording, context or not.
            ("HTTP/1.1 429 for the context request", true),
            ("RESOURCE_EXHAUSTED: You have exhausted your capacity. Resets in 45m", true),
            // Phrases agy 1.5 prints itself, in both classifiers.
            ("You have exhausted your quota on this model.", true),
            ("Gemini 4 Neon is out of quota until 3:04 PM; pick another", true),
            ("Usage limit reached", true),
            ("RESOURCE_EXHAUSTED", true),
            ("Context window usage limit reached", false),
            ("Failed to read /Users/x/quota/README", false),
            // agy's sign-in texts are not account limits; `acp.rs` tells them apart.
            ("Authentication required", false),
            ("Not authenticated: failed to read session", false),
            ("The stream was interrupted", false),
            ("session not found", false),
            ("Failed to read /Users/me/quota/config.json", false),
            ("Syntax error in session-429 at line 429", false),
        ] {
            let banner = classify_antigravity_banner(message, now).is_some_and(|error| error.limited);
            assert_eq!(banner, limited, "banner: {message}");
            let rpc = antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":message}}), now).is_some();
            assert_eq!(rpc, limited, "rpc: {message}");
        }
    }

    #[test]
    fn reset_durations_stop_at_seven_days() {
        assert_eq!(parse_antigravity_reset_duration("Resets in 7d"), Some(Duration::from_secs(7 * 86_400)));
        assert_eq!(parse_antigravity_reset_duration("Resets in 8d"), None);
        assert_eq!(parse_antigravity_reset_duration("Resets in 7d 1s"), None);
    }

    #[test]
    fn banners_match_check_quota_reset_and_credit_phrases() {
        let now = 1_700_000_000_000_i64;
        let check = antigravity_soft_error("⚠ Please check quota before retrying.", now).unwrap();
        assert!(check.limited);
        assert_eq!(check.resets_at, None);
        let reset = antigravity_soft_error("⚠ Quota will reset after 2h.", now).unwrap();
        assert!(reset.limited);
        assert_eq!(reset.resets_at, Some(now + 2 * 3600 * 1000));
        let credits = antigravity_soft_error("⚠ AI credits balance is empty.", now).unwrap();
        assert!(credits.limited);
        assert_eq!(credits.resets_at, None);
        assert!(antigravity_soft_error("⚠ The context window quota will reset after 2h.", now).is_none());
    }

    #[test]
    fn punctuated_429_phrases_and_numeric_data_are_limits() {
        let now = 1_700_000_000_000_i64;
        for message in [
            "HTTP/1.1 429",
            "HTTP/2 429",
            "status: 429",
            "status=429",
            "code: 429",
            "code=429",
            "429: Too Many Requests",
            "Too many requests",
        ] {
            assert_eq!(
                antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":message}}), now),
                Some(None),
                "{message}"
            );
        }
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"nope","data":{"status":429}}}), now),
            Some(None)
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"nope","data":{"code":429}}}), now),
            Some(None)
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"nope","data":{"code":"429"}}}), now),
            Some(None)
        );
        assert_eq!(
            antigravity_rpc_limited(&json!({"error":{"code":-32603,"message":"nope","data":{"status":500}}}), now),
            None
        );
    }

    #[test]
    fn warning_continuations_keep_antigravity_details_and_drop_prose() {
        let now = 1_700_000_000_000_i64;
        let coded = antigravity_soft_error(
            "⚠ Request failed.\n  code: 429\n  message: quota exceeded",
            now,
        )
        .unwrap();
        assert!(coded.limited);
        let unindented = antigravity_soft_error("⚠ Capacity\nquota exceeded", now).unwrap();
        assert!(unindented.limited);
        assert!(antigravity_soft_error(
            "⚠ Your AI credits balance is too low to continue.\n  Let me know if you want me to handle this error.",
            now,
        )
        .is_none());
        assert!(antigravity_soft_error("⚠ Note\n  The stream can continue after this error.", now).is_none());
    }

    #[test]
    fn banner_scanner_keeps_agy_explanations_and_ignores_the_agents_own_warnings() {
        let now = 1_700_000_000_000_i64;
        // agy's warning line followed by its explanation, which matches no continuation rule.
        let explained = antigravity_soft_error(
            "⚠ API error: RESOURCE_EXHAUSTED\nYou have exhausted your quota on this model. It will reset at 3:04 PM.",
            now,
        )
        .unwrap();
        assert!(explained.limited);
        assert_eq!(explained.message, "Antigravity: API error: RESOURCE_EXHAUSTED", "the explanation is not banner text");
        assert_eq!(explained.resets_at, None);
        // Up to two explanation lines with no blank line before the warning line; a third
        // line is the agent's prose, as is prose after a warning line that is no limit.
        assert!(antigravity_soft_error("⚠ API error: RESOURCE_EXHAUSTED\nline one\nline two", now).is_some());
        assert!(antigravity_soft_error("⚠ API error: RESOURCE_EXHAUSTED\n\nYou have exhausted your quota on this model.", now).is_none());
        assert!(antigravity_soft_error("⚠ API error: RESOURCE_EXHAUSTED\nline one\nline two\nline three", now).is_none());
        assert!(antigravity_soft_error("⚠ The stream was interrupted.\nI'll retry later.", now).is_none());
        // The agent's own last line: a note quoting an error, or an expected test result.
        assert!(antigravity_soft_error("⚠️ Note: the retry test still fails with `429 Too Many Requests`…", now).is_none());
        assert!(antigravity_soft_error("⚠ Quota reached in the mock server test; expected.", now).is_none());
        assert!(antigravity_soft_error("⚠ Expected: RESOURCE_EXHAUSTED from the unit test", now).is_none());
        assert!(antigravity_soft_error("⚠ NB: the tests still see HTTP 429", now).is_none());
        // agy 1.5's own sentences are banners.
        for banner in [
            "You have exhausted your quota on this model.",
            "Gemini 4 Neon is out of quota until 3:04 PM; pick another",
            "Usage limit reached",
            "RESOURCE_EXHAUSTED",
        ] {
            let soft = antigravity_soft_error(&format!("⚠ {banner}"), now).unwrap();
            assert!(soft.limited, "{banner}");
        }
    }
}
