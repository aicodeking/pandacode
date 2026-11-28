use super::*;
use crate::account_pool::DEFAULT;
use crate::connections::{self, Connection, Launch};

fn account(id: &str) -> Connection {
    Connection {
        id: id.into(),
        provider: "claude".into(),
        ..Connection::default()
    }
}

fn pooled_reads_restricted(
    settings: &Settings,
    current: Option<Connection>,
    pool: Option<&[&str]>,
    saved: &[Connection],
    launch: impl FnMut(&Connection) -> crate::Result<Launch>,
) -> bool {
    let cwd = settings.base.join("project");
    let provider_env = vec![("CLAUDE_CONFIG_DIR".into(), "../config".into())];
    claude_restricts_reads_with(
        "claude",
        &cwd,
        || {
            let ids = pool.map(|ids| ids.iter().map(|id| (*id).to_owned()).collect());
            let get = |id: &str| saved.iter().find(|account| account.id == id).cloned();
            read_account_launches(current, ids, get, launch)
        },
        || false,
        |env| launch_config_dir_with(provider_env.clone(), env, None, &cwd),
    )
}

#[test]
fn pooled_claude_read_denial_withholds_explore() {
    let settings = Settings::new();
    settings.user("settings.json", "{}");
    let cwd = settings.base.join("project");
    let restricted = cwd.join("pooled");
    std::fs::create_dir(&restricted).unwrap();
    std::fs::write(
        restricted.join("settings.json"),
        r#"{"permissions":{"deny":["Read"]}}"#,
    )
    .unwrap();
    let named = Connection {
        config_dir: Some("pooled".into()),
        ..account("named")
    };

    let saved = [account("clean"), named.clone()];
    assert!(pooled_reads_restricted(
        &settings,
        None,
        Some(&["clean", "named"]),
        &saved,
        connections::launch,
    ));
    assert!(!pooled_reads_restricted(
        &settings,
        None,
        Some(&[DEFAULT, "clean"]),
        &saved,
        connections::launch,
    ));
    assert!(!pooled_reads_restricted(&settings, None, None, &saved, |_| {
        panic!("pool disabled")
    }));
    assert!(pooled_reads_restricted(
        &settings,
        Some(named),
        Some(&["clean"]),
        &saved,
        connections::launch,
    ));
}

#[test]
fn pooled_claude_policy_flags_withhold_explore() {
    let settings = Settings::new();
    settings.user("settings.json", "{}");
    for flag in [
        "--settings",
        "--setting-sources",
        "--disallowedTools",
        "--disallowed-tools",
    ] {
        for arg in [flag.to_owned(), format!("{flag}=value")] {
            let named = Connection {
                args: vec![arg.clone()],
                ..account("named")
            };
            assert!(
                pooled_reads_restricted(&settings, None, Some(&["named"]), &[named], connections::launch),
                "{arg}"
            );
        }
    }
}

#[test]
fn pooled_claude_empty_config_dir_withholds_explore() {
    let settings = Settings::new();
    settings.user("settings.json", "{}");
    let named = Connection {
        env: [("CLAUDE_CONFIG_DIR".into(), String::new())].into(),
        ..account("named")
    };
    assert!(pooled_reads_restricted(
        &settings,
        None,
        Some(&["named"]),
        &[named],
        connections::launch,
    ));
}

#[test]
fn pooled_claude_unresolvable_home_withholds_explore() {
    let settings = Settings::new();
    let cwd = settings.base.join("project");
    let homes = ["HOME", "USERPROFILE"];
    let provider_env: Vec<_> = homes
        .into_iter()
        .map(|key| (key.into(), settings.base.display().to_string()))
        .collect();
    let named = Connection {
        env: homes.map(|key| (key.into(), String::new())).into(),
        ..account("named")
    };
    let restricted = |pool| {
        claude_restricts_reads_with(
            "claude",
            &cwd,
            || read_account_launches(None, pool, |id| (id == named.id).then(|| named.clone()), connections::launch),
            || false,
            |env| launch_config_dir_with(provider_env.clone(), env, None, &cwd),
        )
    };
    assert!(!restricted(None));
    assert!(restricted(Some(vec![named.id.clone()])));
}

#[test]
fn pooled_claude_launch_failure_withholds_explore() {
    let settings = Settings::new();
    settings.user("settings.json", "{}");
    assert!(pooled_reads_restricted(
        &settings,
        None,
        Some(&["named"]),
        &[account("named")],
        |_| Err("missing saved key".into()),
    ));
}

#[test]
fn pooled_claude_missing_eligible_account_withholds_explore() {
    let settings = Settings::new();
    settings.user("settings.json", "{}");
    assert!(pooled_reads_restricted(
        &settings,
        None,
        Some(&["removed"]),
        &[],
        |_| panic!("a missing account cannot launch"),
    ));
}

#[test]
fn pooled_claude_clean_accounts_allow_explore_and_launch_each_id_once() {
    let settings = Settings::new();
    settings.user("settings.json", "{}");
    let clean = settings.base.join("project/pooled");
    std::fs::create_dir(&clean).unwrap();
    std::fs::write(clean.join("settings.json"), "{}").unwrap();
    let named = Connection {
        config_dir: Some("pooled".into()),
        ..account("named")
    };
    let other = account("other");
    let mut launched = Vec::new();
    assert!(!pooled_reads_restricted(
        &settings,
        Some(named.clone()),
        Some(&["named", "other", "other"]),
        &[other],
        |connection| {
            launched.push(connection.id.clone());
            connections::launch(connection)
        },
    ));
    assert_eq!(launched, ["named", "other"]);

    settings.user("settings.json", r#"{"permissions":{"deny":["Read"]}}"#);
    assert!(
        pooled_reads_restricted(
            &settings,
            Some(named.clone()),
            Some(&[DEFAULT, DEFAULT, "named"]),
            &[],
            connections::launch,
        ),
        "an eligible default account applies alongside a named assignment"
    );
    assert!(
        !pooled_reads_restricted(&settings, Some(named.clone()), Some(&["named"]), &[], connections::launch),
        "an excluded default account does not apply to a named assignment"
    );
    assert!(
        !pooled_reads_restricted(&settings, Some(named), None, &[], connections::launch),
        "with pooling disabled only the named assignment applies"
    );
}

#[test]
fn pooled_claude_named_account_requires_the_edit_tracking_handshake() {
    let settings = Settings::new();
    settings.user("settings.json", "{}");
    let config = crate::providers::RunConfig {
        mode: "ask".into(),
        cwd: settings.base.join("project"),
        ..crate::providers::tests::config("claude")
    };
    for (pool, expect_handshake) in [
        (None, false),
        (Some(vec![]), false),
        (Some(vec![DEFAULT.to_owned()]), false),
        (Some(vec!["named".to_owned()]), true),
    ] {
        let allows_edits = |config: &crate::providers::RunConfig| {
            claude_allows_edits_with(
                config,
                || false,
                || pool.clone(),
                || false,
                || Some(settings.base.join("config")),
            )
        };
        assert_eq!(allows_edits(&config), expect_handshake);
        assert_eq!(
            edits_wait_for_run_using(&config, allows_edits),
            !expect_handshake
        );
    }
}

#[cfg(unix)]
#[test]
fn read_settings_rejects_fifo_without_waiting_for_a_writer() {
    let settings = Settings::new();
    let fifo = settings.base.join("config/settings.json");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || sender.send(read_settings(&fifo)));
    assert_eq!(
        receiver.recv_timeout(std::time::Duration::from_secs(5)),
        Ok(Err("not a file"))
    );
    reader.join().unwrap().unwrap();
}

#[test]
fn edit_rules_recognize_tool_wildcards() {
    for rule in ["Edit*", "*Write", "Notebook*", "*", "Edit(src/**)"] {
        assert!(edit_rule(rule), "{rule}");
    }
    for rule in ["Read*", "Bash*"] {
        assert!(!edit_rule(rule), "{rule}");
    }
}
