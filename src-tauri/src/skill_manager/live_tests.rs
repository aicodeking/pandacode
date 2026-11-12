//! Live smoke tests against the installed Codex and OpenCode CLIs, in isolated homes. Ignored by
//! default; run with `cargo test --lib skill_manager_live -- --ignored --nocapture`. Each test
//! skips (passes with a note) when its CLI is not on PATH. Neither runs a model: Codex renders its
//! prompt input and OpenCode runs its skill tool directly.
use super::*;
use crate::skill_manager::tests::Fixture;
use std::process::{Command, Output};

const ALPHA: &str = "---\nname: smoke-alpha\ndescription: Alpha smoke skill.\n---\nAlpha body.\n";
const BETA: &str = "---\nname: smoke-beta\ndescription: Beta smoke skill.\n---\nBeta body.\n";

/// The CLI's version line, or `None` (logged) when it isn't installed.
fn installed(cli: &str) -> Option<String> {
    match Command::new(cli).arg("--version").output() {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        }
        _ => {
            eprintln!("skipped: {cli} is not installed");
            None
        }
    }
}

/// A command confined to the fixture: its own HOME and XDG folders, so no real skill, config
/// or account of the user's is read.
fn isolated(cli: &str, f: &Fixture, cwd: &Path) -> Command {
    let mut command = Command::new(cli);
    command.current_dir(cwd).env("HOME", f.0.join("home"));
    for (name, dir) in [
        ("XDG_CONFIG_HOME", "xdg/config"),
        ("XDG_DATA_HOME", "xdg/data"),
        ("XDG_CACHE_HOME", "xdg/cache"),
        ("XDG_STATE_HOME", "xdg/state"),
    ] {
        command.env(name, f.0.join(dir));
    }
    command
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
#[ignore = "Runs the installed Codex CLI (no model call) against an isolated CODEX_HOME"]
fn skill_manager_live_codex_skills_config_hides_a_switched_off_skill() {
    let Some(version) = installed("codex") else {
        return;
    };
    let f = Fixture::new();
    f.skill("codex/skills/smoke-alpha", ALPHA);
    f.skill("codex/skills/smoke-beta", BETA);
    fs::create_dir_all(f.0.join("home")).unwrap();
    fs::create_dir_all(f.0.join("work")).unwrap();
    let render = |args: &[String]| {
        let output = isolated("codex", &f, &f.0.join("work"))
            .env("CODEX_HOME", f.0.join("codex"))
            .args(["debug", "prompt-input"])
            .args(args)
            .arg("hello")
            .output()
            .expect("run codex");
        assert!(output.status.success(), "{version}: {}", text(&output));
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    // Control: both fixture skills are listed without the switches.
    let listed = render(&[]);
    assert!(
        listed.contains("smoke-alpha") && listed.contains("smoke-beta"),
        "{version}: the fixture skills should be listed: {listed}"
    );
    // The exact arguments a launch adds for a skill switched off.
    let args = codex_arguments(&BTreeSet::from(["smoke-alpha".into()]));
    assert_eq!(
        args[1],
        r#"skills.config=[{name="smoke-alpha",enabled=false}]"#
    );
    let listed = render(&args);
    assert!(!listed.contains("smoke-alpha"), "{version}: {listed}");
    assert!(listed.contains("smoke-beta"), "{version}: {listed}");
}

#[test]
#[ignore = "Runs the installed OpenCode CLI's skill tool (no model call) in an isolated project"]
fn skill_manager_live_opencode_injected_config_refuses_a_switched_off_skill_over_project_allows() {
    let Some(version) = installed("opencode") else {
        return;
    };
    let f = Fixture::new();
    let project = f.0.join("project");
    f.skill("project/.opencode/skills/smoke-alpha", ALPHA);
    f.skill("project/.opencode/skills/smoke-beta", BETA);
    fs::create_dir_all(f.0.join("home")).unwrap();
    // A project that allows every skill, the alpha one by name, at both levels.
    fs::write(
        project.join("opencode.json"),
        r#"{"permission":{"skill":{"smoke-alpha":"allow","*":"allow"}},"agent":{"build":{"permission":{"skill":{"smoke-alpha":"allow","*":"allow"}}}}}"#,
    )
    .unwrap();
    let agents = OpenCodeAgents {
        names: ["build", "plan", "general", "explore"]
            .into_iter()
            .map(String::from)
            .collect(),
        complete: true,
    };
    let disabled = BTreeSet::from(["smoke-alpha".into()]);
    let launch = opencode_launch_with(
        &crate::providers::opencode_configuration("default"),
        None,
        &disabled,
        &agents,
    );
    assert!(launch.enforced);
    let load = |name: &str| {
        let mut command = isolated("opencode", &f, &project);
        command
            .env("OPENCODE_CONFIG_CONTENT", &launch.content)
            .args([
                "debug", "agent", "build", "--pure", "--tool", "skill", "--params",
            ])
            .arg(format!(r#"{{"name":"{name}"}}"#));
        if let Some(permission) = &launch.permission {
            command.env("OPENCODE_PERMISSION", permission);
        }
        text(&command.output().expect("run opencode"))
    };
    let beta = load("smoke-beta");
    assert!(
        beta.contains("Loaded skill: smoke-beta"),
        "{version}: {beta}"
    );
    let alpha = load("smoke-alpha");
    assert!(
        !alpha.contains("Loaded skill: smoke-alpha") && !alpha.contains("Alpha body."),
        "{version}: a switched-off skill must not load: {alpha}"
    );
}
