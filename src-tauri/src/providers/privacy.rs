//! Settings → Agents → "Turn off agent telemetry". While on, every harness process PandaCode
//! starts (runs, warm spares, consoles, model and command discovery, cloud agents) carries each
//! vendor's own per-process opt-out. Nothing is written to the harnesses' config files, so
//! turning the switch off restores their own settings on the next launch.
//!
//! Switch names were read from the installed CLIs (Claude Code 2.1.311, Codex 0.162.1, Kimi
//! Code, Grok 1.0.62, dsh, Command Code 1.88, OpenCode, Cline 3.0.52, Muse 1.4.14, Pi 0.84), not guessed.
use serde::Serialize;

/// Every value only opts out, so the whole list is safe on every harness. Agents' own
/// subprocesses inherit it, and `DO_NOT_TRACK` (consoledonottrack.com) reaches tools that honor it.
const ENVIRONMENT: &[(&str, &str)] = &[
    // Command Code's only switch. Claude Code also reads it as DISABLE_TELEMETRY.
    ("DO_NOT_TRACK", "1"),
    // Claude Code and its GLM/MiMo relays: usage telemetry, Sentry reports, the rating survey.
    // Grok reads the first two as well. In Claude Code they also stop GrowthBook feature flags.
    ("DISABLE_TELEMETRY", "1"),
    ("DISABLE_ERROR_REPORTING", "1"),
    ("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1"),
    ("KIMI_DISABLE_TELEMETRY", "true"),
    ("GROK_TELEMETRY_ENABLED", "false"),
    ("GROK_TELEMETRY_TRACE_UPLOAD", "false"),
    ("DSH_TELEMETRY_DISABLED", "1"),
    ("OPENCODE_DISABLE_SHARE", "1"),
    // Pi's install report: set means "use this value", and only 1/true/yes enable it.
    ("PI_TELEMETRY", "0"),
];

/// Codex and Muse read these from config; `-c` overrides only this process. Both type-check
/// the keys (`codex -c analytics.enabled=1` fails "expected a boolean in `analytics.enabled`";
/// `muse serve -c telemetry.bogus=false` refuses to run: "unknown key: no such setting"), so a
/// renamed key would fail loudly rather than be ignored.
const CODEX_ARGUMENTS: &[&str] = &["-c", "analytics.enabled=false", "-c", "feedback.enabled=false"];
const MUSE_ARGUMENTS: &[&str] = &["-c", "telemetry.enabled=false"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    provider: &'static str,
    name: &'static str,
    /// `off`: PandaCode turns it off. `manual`: only the harness's own settings can.
    /// `unknown`: no switch could be verified.
    status: &'static str,
    detail: &'static str,
}

const COVERAGE: &[Coverage] = &[
    Coverage { provider: "claude", name: "Claude Code", status: "off", detail: "Usage telemetry, error reports and surveys. Remote feature flags and remotely started sessions stop." },
    Coverage { provider: "glm", name: "GLM Coding Plan", status: "off", detail: "Same switches as Claude Code." },
    Coverage { provider: "mimo", name: "MiMo Token Plan", status: "off", detail: "Same switches as Claude Code." },
    Coverage { provider: "codex", name: "Codex", status: "off", detail: "Analytics and feedback uploads." },
    Coverage { provider: "kimi", name: "Kimi Code", status: "off", detail: "Usage telemetry and crash events." },
    Coverage { provider: "grok", name: "Grok Build", status: "off", detail: "Usage telemetry, crash reports and trace uploads." },
    Coverage { provider: "deepseek", name: "DeepSeek", status: "off", detail: "Session telemetry." },
    Coverage { provider: "commandcode", name: "Command Code", status: "off", detail: "Telemetry and machine fingerprinting." },
    Coverage { provider: "opencode", name: "OpenCode", status: "off", detail: "Session sharing, including /share." },
    Coverage { provider: "pi", name: "Pi", status: "off", detail: "The install report and provider attribution headers." },
    Coverage { provider: "muse", name: "Muse Code", status: "off", detail: "Telemetry, through its telemetry.enabled setting." },
    Coverage { provider: "cline", name: "Cline", status: "manual", detail: "No per-launch switch. Opt out in Cline’s settings." },
    Coverage { provider: "omp", name: "Oh My Pi", status: "unknown", detail: "No verified switch." },
    Coverage { provider: "github-copilot", name: "GitHub Copilot CLI", status: "unknown", detail: "No verified switch." },
    Coverage { provider: "antigravity", name: "Antigravity", status: "unknown", detail: "No verified switch." },
];

#[cfg(test)]
thread_local! {
    /// Lets a test turn the switch on for its own thread without the saved settings.
    pub(crate) static FORCE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Whether the switch is on; launches compare it (the warm-spare key) through here.
pub(crate) fn telemetry_off() -> bool {
    off()
}

fn off() -> bool {
    #[cfg(test)]
    if let Some(off) = FORCE.with(|force| force.get()) {
        return off;
    }
    crate::provider_settings::telemetry_off()
}

/// Opt-out variables for a harness process; empty while the switch is off.
pub(crate) fn environment() -> &'static [(&'static str, &'static str)] {
    environment_when(off())
}

fn environment_when(off: bool) -> &'static [(&'static str, &'static str)] {
    if off { ENVIRONMENT } else { &[] }
}

/// Leading arguments for `program` (an executable stem or provider ID); only Codex takes any.
pub(crate) fn arguments(program: &str) -> &'static [&'static str] {
    arguments_when(off(), program)
}

fn arguments_when(off: bool, program: &str) -> &'static [&'static str] {
    if off && program == "codex" { CODEX_ARGUMENTS } else { &[] }
}

/// Muse refuses root options before a subcommand, so its callers add these after `serve`
/// (or after the console's `resume <id>`), never at launch.
pub(crate) fn muse_arguments() -> &'static [&'static str] {
    muse_arguments_when(off())
}

fn muse_arguments_when(off: bool) -> &'static [&'static str] {
    if off { MUSE_ARGUMENTS } else { &[] }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Privacy {
    off: bool,
    harnesses: &'static [Coverage],
}

#[tauri::command]
pub async fn harness_privacy() -> crate::Result<Privacy> {
    Ok(Privacy { off: off(), harnesses: COVERAGE })
}

/// Applies from the next launch: warm spares started under the old value no longer match.
#[tauri::command]
pub async fn harness_privacy_set(off: bool) -> crate::Result<Privacy> {
    crate::blocking(move || crate::provider_settings::set_telemetry_off(off)).await?;
    Ok(Privacy { off, harnesses: COVERAGE })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_harness_is_described_once() {
        let mut seen: Vec<_> = COVERAGE.iter().map(|c| c.provider).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), COVERAGE.len());
        for id in ["claude", "codex", "kimi", "opencode", "glm", "antigravity", "grok", "mimo", "pi", "deepseek", "commandcode", "cline", "omp", "github-copilot", "muse"] {
            assert!(seen.contains(&id), "{id} has no privacy entry");
        }
        assert!(COVERAGE.iter().all(|c| ["off", "manual", "unknown"].contains(&c.status)));
    }

    #[test]
    fn opt_outs_disable_and_never_enable() {
        // A "no" value only opts out on switches that name what they enable.
        assert!(ENVIRONMENT.iter().all(|(name, value)| !name.is_empty() && ["1", "true", "false", "0"].contains(value)));
        assert!(ENVIRONMENT.iter().filter(|(_, v)| ["false", "0"].contains(v)).all(|(name, _)| name.ends_with("_ENABLED") || name.ends_with("_UPLOAD") || *name == "PI_TELEMETRY"));
        assert!(ENVIRONMENT.iter().filter(|(_, v)| ["1", "true"].contains(v)).all(|(name, _)| name.contains("DISABLE") || *name == "DO_NOT_TRACK"));
        for arguments in [CODEX_ARGUMENTS, MUSE_ARGUMENTS] {
            assert!(arguments.chunks(2).all(|pair| pair[0] == "-c" && pair[1].ends_with(".enabled=false")));
        }
    }

    #[test]
    fn nothing_is_added_until_the_switch_is_on() {
        assert!(environment_when(false).is_empty());
        assert!(arguments_when(false, "codex").is_empty());
        assert!(environment_when(true).contains(&("DO_NOT_TRACK", "1")));
        assert_eq!(arguments_when(true, "codex"), CODEX_ARGUMENTS);
        // Only Codex takes `-c` at launch; others would reject it (Muse takes it after `serve`).
        assert_eq!(muse_arguments_when(true), MUSE_ARGUMENTS);
        assert!(muse_arguments_when(false).is_empty());
        for program in ["claude", "kimi", "muse", "opencode", "grok", "pi", "dsh", "codex-code-mode-host"] {
            assert!(arguments_when(true, program).is_empty(), "{program}");
        }
    }
}
