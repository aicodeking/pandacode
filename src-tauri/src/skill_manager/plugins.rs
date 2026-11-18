//! Read enabled Codex plugin installations without running Codex or changing its config.
//! Cache selection follows codex-rs/core-plugin-common/src/installed.rs; manifests supply namespaces.
use super::*;
use std::cmp::Ordering;

pub(super) fn codex_roots(
    config: &Path,
    home: &Path,
    label: &str,
) -> Vec<(PathBuf, String, String)> {
    let Some(configured) =
        read_text(&config.join("config.toml")).and_then(|text| text.parse::<toml::Table>().ok())
    else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for (id, settings) in configured
        .get("plugins")
        .and_then(toml::Value::as_table)
        .into_iter()
        .flatten()
    {
        if !settings.is_table()
            || settings.get("enabled").and_then(toml::Value::as_bool) == Some(false)
        {
            continue;
        }
        let Some((plugin, marketplace)) = id.split_once('@') else {
            continue;
        };
        if !segment(plugin) || !segment(marketplace) {
            continue;
        }
        let base = config.join("plugins/cache").join(marketplace).join(plugin);
        let versions = fs::read_dir(&base)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|version| segment(version));
        // Codex selects `local` first, otherwise the greatest semver (lexical for opaque IDs).
        let Some(version) = versions.max_by(|a, b| match (a.as_str(), b.as_str()) {
            ("local", "local") => Ordering::Equal,
            ("local", _) => Ordering::Greater,
            (_, "local") => Ordering::Less,
            _ => compare_versions(a, b),
        }) else {
            continue;
        };
        let root = base.join(version);
        let Some(manifest) = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]
            .iter()
            .find_map(|path| {
                read_text(&root.join(path))
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            })
        else {
            continue;
        };
        let name = manifest["name"]
            .as_str()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(plugin);
        let mut paths = vec!["./skills"];
        if let Some(path) = manifest["skills"].as_str() {
            paths.push(path);
        }
        paths.extend(
            manifest["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str),
        );
        let mut seen = BTreeSet::new();
        for path in paths {
            let Some(relative) = path.strip_prefix("./") else {
                continue;
            };
            if Path::new(relative).components().any(|c| {
                !matches!(
                    c,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            }) {
                continue;
            }
            let path = root.join(relative);
            if !path.is_dir()
                || !fs::canonicalize(&path)
                    .is_ok_and(|p| fs::canonicalize(&root).is_ok_and(|root| p.starts_with(root)))
                || !seen.insert(checkout_key(&path))
            {
                continue;
            }
            roots.push((
                path.clone(),
                roots::display_path(
                    &path,
                    home,
                    &format!("{label} · plugin {plugin} · {relative}"),
                ),
                name.to_owned(),
            ));
        }
    }
    roots
}
fn segment(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b))
}
fn semantic(version: &str) -> Option<([u64; 3], Option<&str>)> {
    let (version, build) = version
        .split_once('+')
        .map_or((version, None), |(a, b)| (a, Some(b)));
    let valid =
        |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if build.is_some_and(|s| !s.split('.').all(valid)) {
        return None;
    }
    let (core, pre) = version
        .split_once('-')
        .map_or((version, None), |(a, b)| (a, Some(b)));
    if pre.is_some_and(|s| {
        !s.split('.').all(|id| {
            valid(id)
                && !(id.len() > 1 && id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit()))
        })
    }) {
        return None;
    }
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|s| {
            s.is_empty()
                || s.len() > 1 && s.starts_with('0')
                || !s.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return None;
    }
    Some((
        [
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ],
        pre,
    ))
}
fn compare_versions(a: &str, b: &str) -> Ordering {
    let (Some((a_core, a_pre)), Some((b_core, b_pre))) = (semantic(a), semantic(b)) else {
        return a.cmp(b);
    };
    a_core.cmp(&b_core).then_with(|| match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, _) => Ordering::Greater,
        (_, None) => Ordering::Less,
        (Some(a), Some(b)) => {
            for (a, b) in a.split('.').zip(b.split('.')) {
                let numeric = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
                let order = match (numeric(a), numeric(b)) {
                    (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => a.cmp(b),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
            a.split('.').count().cmp(&b.split('.').count())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skill_manager_codex_plugin_versions_match_semver_and_opaque_cache_order() {
        for (old, new) in [
            ("1.9.0", "1.10.0"),
            ("1.0.0-alpha.9", "1.0.0-alpha.10"),
            ("1.0.0-rc.1", "1.0.0"),
            ("1.0.0-9", "1.0.0-beta"),
            ("1.0.0-alpha", "1.0.0-alpha.1"),
            ("26.9.9", "26.10.1"),
            ("abc1", "abc2"),
        ] {
            assert_eq!(compare_versions(old, new), Ordering::Less, "{old} {new}");
        }
        assert_eq!(
            compare_versions("1.0.0+build1", "1.0.0+build2"),
            Ordering::Equal
        );
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_codex_plugins_prefer_local_and_validate_manifest_skill_roots() {
        let f = Fixture::new();
        for account in ["one", "two"] {
            let config = f.0.join(account);
            fs::create_dir_all(&config).unwrap();
            fs::write(config.join("config.toml"), "[plugins.\"sample@market\"]\n").unwrap();
            for version in ["local", "99.0.0"] {
                let root = format!("{account}/plugins/cache/market/sample/{version}");
                f.skill(&format!("{root}/custom/review"), "---\nname: review\n---\n");
                let manifest = f.0.join(&root).join(".codex-plugin");
                fs::create_dir_all(&manifest).unwrap();
                fs::write(manifest.join("plugin.json"), serde_json::json!({"name":"namespace","skills":["./custom", "./custom", "../escape", "/absolute"]}).to_string()).unwrap();
            }
        }
        let mut homes = Homes {
            codex: Some(f.0.join("one")),
            ..Homes::default()
        };
        homes.add_home("codex", f.0.join("two"));
        let plugins = roots::codex_plugins(&f.0.join("home"), &homes);
        assert_eq!(plugins.len(), 2);
        assert!(plugins.iter().all(|(path, _, namespace)| path
            .to_string_lossy()
            .contains("/local/")
            && namespace == "namespace"));
        assert_ne!(plugins[0].1, plugins[1].1);
        let skills = inventory(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        assert_eq!(skills[0].name, "namespace:review");
        assert_eq!(skills[0].agents.len(), 2);
        assert!(!serde_json::to_string(&skills)
            .unwrap()
            .contains(f.0.to_str().unwrap()));
    }
}
