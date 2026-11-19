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
/// Matching permission keys in OpenCode's order; a string action is a `*` resource pattern.
fn permission_rules(permission: Option<&Json>, tool: &str) -> Vec<(String, String)> {
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
        .filter(|(key, _)| matches(key, tool))
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
/// The action OpenCode takes in `agent`: top-level rules, then the agent's, last
/// match wins.
fn permission_action(config: &Object, agent: &str, tool: &str, resource: &str) -> String {
    let agent_permission = match get(config, "agent") {
        Some(Json::Object(agents)) => match get(agents, agent) {
            Some(Json::Object(agent)) => get(agent, "permission"),
            _ => None,
        },
        _ => None,
    };
    permission_rules(get(config, "permission"), tool)
        .into_iter()
        .chain(permission_rules(agent_permission, tool))
        .rfind(|(pattern, _)| matches(pattern, resource))
        .map(|(_, action)| action)
        .unwrap_or_else(|| "allow".into())
}
fn action(config: &Object, agent: &str, skill: &str) -> String {
    permission_action(config, agent, "skill", skill)
}

#[test]
fn skill_manager_opencode_bound_tool_grants_stay_last_after_layered_merges() {
    let tool = "pandacode_architect_pandacode_explore";
    let disabled = BTreeSet::from(["review".into()]);
    let agents = OpenCodeAgents {
        names: BTreeSet::from(["build".into(), "plan".into()]),
        complete: true,
    };
    for (pattern, wildcard) in [
        ("*", "ask"),
        ("*", "deny"),
        ("pandacode_architect_*", "ask"),
        ("pandacode_architect_*", "deny"),
    ] {
        // An earlier config has the exact name before its wildcard; mergeDeep keeps that order.
        let rules = format!(
            r#"{{"{tool}":"deny","{pattern}":"{wildcard}","other_server_*":"ask","bash":{{"*":"ask","deploy *":"deny"}},"skill":{{"review":"allow","*":"allow"}}}}"#
        );
        let project = r#"{"permission":RULES,"agent":{"build":{"permission":RULES},"plan":{"permission":RULES}}}"#
            .replace("RULES", &rules);
        for existing in [None, Some(rules.as_str())] {
            let launch = opencode_launch_with("{}", existing, &disabled, &agents);
            let (inline, permission) = opencode_tool_grants(
                &launch.content,
                launch.permission.as_deref(),
                &["pandacode_explore"],
            )
            .unwrap();
            let permission_layer = format!(r#"{{"permission":{}}}"#, permission.unwrap());
            // Check the env rules independently, so inline grants cannot hide a missing env grant.
            let mut env_config = object(&format!(r#"{{"permission":{rules}}}"#));
            merge(&mut env_config, object(&permission_layer));
            assert_eq!(
                permission_action(&env_config, "unconfigured", tool, "*"),
                "allow"
            );
            let mut config = object(&project);
            merge(&mut config, object(&inline));
            merge(&mut config, object(&permission_layer));
            let merged = serde_json::to_string(&config).unwrap();
            // Existing rule order and nested command limits remain intact.
            assert!(merged.contains(&format!(
                r#""{tool}":"allow","{pattern}":"{wildcard}","other_server_*":"ask","bash":{{"*":"ask","deploy *":"deny"}}"#
            )), "{merged}");
            for agent in ["build", "plan", "unconfigured"] {
                for name in [tool.to_owned(), format!("{tool} arguments")] {
                    assert_eq!(
                        permission_action(&config, agent, &name, "*"),
                        "allow",
                        "{agent}: {merged}"
                    );
                }
                for name in [
                    format!("{tool}2"),
                    format!("{tool}_other"),
                    "pandacode_architect_pandacode_tool_run".into(),
                ] {
                    assert_eq!(
                        permission_action(&config, agent, &name, "*"),
                        wildcard,
                        "{agent}: {name}"
                    );
                }
                assert_eq!(
                    permission_action(&config, agent, "other_server_tool", "*"),
                    "ask"
                );
                assert_eq!(
                    permission_action(&config, agent, "bash", "deploy production"),
                    "deny"
                );
                assert_eq!(permission_action(&config, agent, "bash", "pwd"), "ask");
                assert_eq!(
                    action(&config, agent, "review"),
                    "deny",
                    "{agent}: {merged}"
                );
                assert_eq!(action(&config, agent, "other"), "allow");
            }
        }
    }
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

#[test]
fn skill_manager_opencode_1x_both_alias_collision_inline_vs_cross_layer() {
    let tool = "pandacode_architect_pandacode_explore";
    let trailing = trailing_key(tool);
    for (pattern, wildcard) in [
        ("*", "ask"),
        ("*", "deny"),
        ("pandacode_architect_*", "ask"),
        ("pandacode_architect_*", "deny"),
    ] {
        let rules = format!(r#"{{"{tool}":"deny","{trailing}":"deny","{pattern}":"{wildcard}"}}"#);
        let inline_in = format!(
            r#"{{"permission":{rules},"agent":{{"build":{{"permission":{rules}}},"plan":{{"permission":{rules}}}}}}}"#
        );

        // 1. Inline collision (`OPENCODE_CONFIG_CONTENT` and `OPENCODE_PERMISSION`):
        // `opencode_tool_grants` removes and re-appends both keys after the wildcard, so `allow` wins.
        let (inline_out, permission_out) =
            opencode_tool_grants(&inline_in, Some(&rules), &["pandacode_explore"]).unwrap();
        let permission_layer = format!(r#"{{"permission":{}}}"#, permission_out.unwrap());
        let mut inline_only = object(&inline_out);
        merge(&mut inline_only, object(&permission_layer));
        for agent in ["build", "plan", "unconfigured"] {
            assert_eq!(
                permission_action(&inline_only, agent, tool, "*"),
                "allow",
                "inline collision should reinsert after {pattern}: {inline_out}"
            );
            assert_eq!(
                permission_action(&inline_only, agent, &format!("{tool}2"), "*"),
                wildcard,
                "grants must stay exact on {agent}"
            );
        }

        // 2. Cross-layer project `opencode.json` collision in OpenCode 1.x:
        // When an untouched earlier project file ALREADY declares BOTH exact `<tool>` AND
        // `<tool> *` before a matching wildcard, OpenCode 1.x `mergeDeep` updates both keys in
        // place while preserving the project file's key order, so the trailing wildcard still
        // wins (failing closed to `wildcard` rather than emitting an over-broad `<tool>*` glob
        // that would also allow unrelated tools like `<tool>2` or `<tool>_other`).
        // (In OpenCode 2.x, each layer is normalized to a `permissions` array and concatenated in
        // precedence order, so the inline grants land after the project layer's wildcard.)
        let (fresh_inline, fresh_perm) =
            opencode_tool_grants("{}", Some(&rules), &["pandacode_explore"]).unwrap();
        let mut cross_layer = object(&inline_in);
        merge(&mut cross_layer, object(&fresh_inline));
        merge(
            &mut cross_layer,
            object(&format!(r#"{{"permission":{}}}"#, fresh_perm.unwrap())),
        );
        let merged = serde_json::to_string(&cross_layer).unwrap();
        assert!(
            merged.contains(&format!(
                r#""{tool}":"allow","{trailing}":"allow","{pattern}":"{wildcard}""#
            )),
            "1.x mergeDeep preserves earlier project key order: {merged}"
        );
        for agent in ["build", "plan", "unconfigured"] {
            assert_eq!(
                permission_action(&cross_layer, agent, tool, "*"),
                wildcard,
                "1.x cross-layer dual-alias collision fails closed to {wildcard}: {merged}"
            );
            assert_eq!(
                permission_action(&cross_layer, agent, &format!("{tool}2"), "*"),
                wildcard
            );
            assert_eq!(
                permission_action(&cross_layer, agent, &format!("{tool}_other"), "*"),
                wildcard
            );
        }
    }
}

#[test]
fn skill_manager_opencode_tool_grants_cover_builtins_and_project_agents_after_wildcards() {
    let tool = "pandacode_architect_pandacode_explore";
    let f = crate::skill_manager::tests::Fixture::new();
    let home = f.0.join("home");
    let repo = f.0.join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(
        repo.join("opencode.json"),
        r#"{
            "agent": {"reviewer-v1": {"permission": {"*": "deny"}}},
            "agents": {"auditor-v2": {"permissions": [{"action": "*", "resource": "*", "effect": "deny"}]}}
        }"#,
    )
    .unwrap();
    let discovered = super::opencode_agents::agents(&repo, &home, &Homes::default());
    let agents = OpenCodeAgents {
        names: discovered.names,
        complete: discovered.complete,
    };
    assert!(agents.names.contains("reviewer-v1"));
    assert!(agents.names.contains("auditor-v2"));

    for (pattern, wildcard) in [
        ("*", "ask"),
        ("*", "deny"),
        ("pandacode_architect_*", "ask"),
        ("pandacode_architect_*", "deny"),
    ] {
        let rules = format!(r#"{{"{tool}":"deny","{pattern}":"{wildcard}"}}"#);
        let project = r#"{
            "permission": RULES,
            "agent": {
                "build": {"permission": RULES},
                "plan": {"permission": RULES},
                "general": {"permission": RULES},
                "explore": {"permission": RULES},
                "reviewer-v1": {"permission": RULES},
                "auditor-v2": {"permission": RULES}
            }
        }"#
        .replace("RULES", &rules);

        let (inline, perm) = opencode_tool_grants_with(
            "{}",
            Some(&rules),
            &["pandacode_explore"],
            &agents,
        )
        .unwrap();
        let mut config = object(&project);
        merge(&mut config, object(&inline));
        merge(
            &mut config,
            object(&format!(r#"{{"permission":{}}}"#, perm.unwrap())),
        );
        let merged = serde_json::to_string(&config).unwrap();

        for agent in [
            "build",
            "plan",
            "general",
            "explore",
            "reviewer-v1",
            "auditor-v2",
        ] {
            assert_eq!(
                permission_action(&config, agent, tool, "*"),
                "allow",
                "{agent}: {merged}"
            );
            for other in [
                format!("{tool}2"),
                format!("{tool}_other"),
                "pandacode_architect_pandacode_tool_run".into(),
            ] {
                assert_eq!(
                    permission_action(&config, agent, &other, "*"),
                    wildcard,
                    "{agent}/{other}: {merged}"
                );
            }
        }
    }
}

#[test]
fn skill_manager_opencode_opaque_inline_grants_win_through_permission_env() {
    let tool = "pandacode_architect_pandacode_explore";
    let opaque = r#"{"provider":{"work":{"options":{"timeout":{env:TIMEOUT}}}}}"#;
    let project_rules = format!(
        r#"{{"{tool}":"deny","*":"deny","pandacode_architect_*":"ask","skill":{{"review":"deny"}}}}"#
    );
    for existing in [None, Some(project_rules.as_str())] {
        let (inline, permission) =
            opencode_tool_grants(opaque, existing, &["pandacode_explore"]).unwrap();
        assert_eq!(inline, opaque);
        let permission_layer = format!(r#"{{"permission":{}}}"#, permission.unwrap());
        let mut config = object(&format!(r#"{{"permission":{project_rules}}}"#));
        merge(&mut config, object(&permission_layer));
        assert_eq!(permission_action(&config, "unconfigured", tool, "*"), "allow");
        assert_eq!(
            permission_action(&config, "unconfigured", &format!("{tool}2"), "*"),
            "ask"
        );
        assert_eq!(action(&config, "unconfigured", "review"), "deny");
    }
}
