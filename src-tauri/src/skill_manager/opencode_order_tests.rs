//! OpenCode merges config layers keeping the first layer's key order and applies the last
//! matching permission rule; these tests replay that merge on what a launch sends.
use super::*;

/// OpenCode 1.19's config merge (`mergeDeep`): values from the later layer, key order from
/// the earlier one, new keys appended.
fn merge(target: &mut Object, source: Object) {
    for (key, value) in source.0 {
        match (target.0.iter_mut().find(|(k, _)| *k == key), value) {
            (Some((_, Json::Object(old))), Json::Object(new)) => merge(old, new),
            (Some((_, slot)), value) => *slot = value,
            (None, value) => target.0.push((key, value)),
        }
    }
}
fn object(text: &str) -> Object {
    serde_json::from_str(text).unwrap()
}
fn get<'a>(object: &'a Object, key: &str) -> Option<&'a Json> {
    object.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}
/// OpenCode's wildcard match: `*` is any text, `?` one character, and a trailing ` *` also
/// matches the bare word.
fn matches(pattern: &str, text: &str) -> bool {
    fn glob(p: &[u8], t: &[u8]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some((b'*', rest)) => (0..=t.len()).any(|i| glob(rest, &t[i..])),
            Some((b'?', rest)) => !t.is_empty() && glob(rest, &t[1..]),
            Some((c, rest)) => t.first() == Some(c) && glob(rest, &t[1..]),
        }
    }
    glob(pattern.as_bytes(), text.as_bytes())
        || pattern
            .strip_suffix(" *")
            .is_some_and(|base| glob(base.as_bytes(), text.as_bytes()))
}
/// The rules of one permission object that apply to the skill tool, in OpenCode's order: every
/// key whose name matches `skill` (`*`, `skill`, `skill *`), a string as a `*` pattern.
fn skill_rules(permission: Option<&Json>) -> Vec<(String, String)> {
    let Some(Json::Object(permission)) = permission else {
        return Vec::new();
    };
    let action = |value: &Json| match value {
        Json::Other(action) => action.as_str().unwrap().to_owned(),
        Json::Object(_) => panic!("nested rule"),
    };
    permission
        .0
        .iter()
        .filter(|(key, _)| matches(key, "skill"))
        .flat_map(|(_, value)| match value {
            Json::Object(rules) => rules
                .0
                .iter()
                .map(|(pattern, value)| (pattern.clone(), action(value)))
                .collect::<Vec<_>>(),
            other => vec![("*".into(), action(other))],
        })
        .collect()
}
/// The action OpenCode takes for `skill` in `agent`: top-level rules, then the agent's, last
/// match wins.
fn action(config: &Object, agent: &str, skill: &str) -> String {
    let agent_permission = match get(config, "agent") {
        Some(Json::Object(agents)) => match get(agents, agent) {
            Some(Json::Object(agent)) => get(agent, "permission"),
            _ => None,
        },
        _ => None,
    };
    skill_rules(get(config, "permission"))
        .into_iter()
        .chain(skill_rules(agent_permission))
        .rfind(|(pattern, _)| matches(pattern, skill))
        .map(|(_, action)| action)
        .unwrap_or_else(|| "allow".into())
}

#[test]
fn skill_manager_opencode_denies_stay_last_after_opencode_merges_project_allows() {
    let disabled = BTreeSet::from(["review".into()]);
    let agents = OpenCodeAgents {
        names: BTreeSet::from(["build".into()]),
        complete: true,
    };
    // A project's opencode.json, loaded before the inline layer.
    let project = r#"{"permission":{"skill":{"review":"allow","*":"allow"}},"agent":{"build":{"permission":{"skill":{"review":"allow","*":"allow"}}}}}"#;
    let existing = r#"{"bash":"ask","skill":{"review":"allow","*":"allow"}}"#;
    let launch = opencode_launch_with("{}", Some(existing), &disabled, &agents);
    assert!(launch.enforced);
    // The existing OPENCODE_PERMISSION keeps its rules; the denies end the skill map.
    let permission = launch.permission.unwrap();
    assert_eq!(
        permission,
        r#"{"bash":"ask","skill":{"*":"allow","review":"deny","review *":"deny"},"skill *":{"review":"deny","review *":"deny"}}"#
    );
    // OpenCode: project, then OPENCODE_CONFIG_CONTENT, then OPENCODE_PERMISSION (top level).
    let mut config = object(project);
    merge(&mut config, object(&launch.content));
    merge(
        &mut config,
        Object(vec![(
            "permission".into(),
            Json::Object(object(&permission)),
        )]),
    );
    let merged = serde_json::to_string(&config).unwrap();
    assert!(
        merged.contains(r#""permission":{"skill":{"review":"deny","*":"allow","review *":"deny"}"#),
        "the same-key deny stays before the wildcard; the trailing key comes last: {merged}"
    );
    for agent in ["build", "plan"] {
        assert_eq!(
            action(&config, agent, "review"),
            "deny",
            "{agent}: {merged}"
        );
        assert_eq!(action(&config, agent, "other"), "allow", "{agent}");
        assert_eq!(
            action(&config, agent, "reviewer"),
            "allow",
            "{agent}: exact name only"
        );
    }
    // Without the trailing key the project's wildcard allow would win.
    let mut naive = object(project);
    merge(
        &mut naive,
        object(
            r#"{"permission":{"skill":{"review":"deny"}},"agent":{"build":{"permission":{"skill":{"review":"deny"}}}}}"#,
        ),
    );
    assert_eq!(action(&naive, "build", "review"), "allow");
    // PandaCode's own launch configuration sets a wildcard `"*"` permission; merged after a
    // project that names `skill`, that rule lands after the skill rules. The denies still win.
    let launch = opencode_launch_with(
        &crate::providers::opencode_configuration("default"),
        None,
        &disabled,
        &agents,
    );
    let mut config = object(project);
    merge(&mut config, object(&launch.content));
    let merged = serde_json::to_string(&config).unwrap();
    assert!(
        merged.contains(r#""skill":{"review":"deny","*":"allow","review *":"deny"},"*":"ask""#),
        "{merged}"
    );
    for agent in ["build", "plan"] {
        assert_eq!(
            action(&config, agent, "review"),
            "deny",
            "{agent}: {merged}"
        );
        assert_eq!(action(&config, agent, "other"), "ask", "{agent}: {merged}");
    }
    // Every skill off: the wildcard deny ends the map as well.
    let all = BTreeSet::from(["*".into()]);
    let launch = opencode_launch_with("{}", None, &all, &agents);
    let mut config = object(project);
    merge(&mut config, object(&launch.content));
    assert_eq!(action(&config, "build", "review"), "deny");
    assert_eq!(action(&config, "build", "anything"), "deny");
}

#[test]
fn skill_manager_opencode_permission_keeps_a_bare_action_as_a_wildcard_before_the_denies() {
    let disabled = BTreeSet::from(["review".into()]);
    let denies = r#""skill":{"review":"deny","review *":"deny"},"skill *":{"review":"deny","review *":"deny"}"#;
    // `OPENCODE_PERMISSION='"allow"'`: OpenCode's shorthand for allowing every permission.
    assert_eq!(
        opencode_permission(Some(r#""allow""#), &disabled).unwrap(),
        format!(r#"{{"*":"allow",{denies}}}"#),
        "the user's allow still applies, and the denies come after it"
    );
    assert_eq!(
        opencode_permission(Some(r#""ask""#), &disabled).unwrap(),
        format!(r#"{{"*":"ask",{denies}}}"#)
    );
    // Values OpenCode itself skips (invalid JSON) or rejects (not an action) give denies only.
    for unusable in ["allow", r#""sometimes""#, "42", r#"["allow"]"#, "null"] {
        assert_eq!(
            opencode_permission(Some(unusable), &disabled).unwrap(),
            format!("{{{denies}}}"),
            "{unusable}"
        );
    }
}
