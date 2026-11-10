//! Links (copies on Windows) of canonical installs into Codex, OpenCode, Pi and Kilo account
//! homes. skills 1.7.6 uses CODEX_HOME for detection, but installs Codex and Pi skills in
//! ~/.agents/skills and Kilo skills in ~/.kilo/skills, never in PI_CODING_AGENT_DIR or a saved
//! Kilo config home, all of which the inventory lists.
//! Every target this manager creates is recorded before it is written, so a later install can
//! refresh it (or retry a failed copy) while folders the user made are never overwritten.
use super::*;
use install::Failure;

fn owned_path(prefs: &Path) -> PathBuf {
    prefs.with_file_name("skill-manager-links.json")
}

/// One target PandaCode wrote: the canonical folder it links to and, for a copy (Windows), the
/// content hash of what was written. A target is only ever replaced while it is still exactly
/// that (`still_ours`); anything else at the path is the user's.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct Owned {
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
}

/// Keys are target paths. Older builds saved the source alone; those read with no hash, so an
/// old copy is never treated as ours (only a symbolic link to that source is).
/// `None`: the file exists but can't be read or parsed (it is never treated as empty there).
fn load_owned(prefs: &Path) -> Option<BTreeMap<String, Owned>> {
    let path = owned_path(prefs);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(BTreeMap::new()),
        Err(_) => return None,
        Ok(_) => {}
    }
    let raw: BTreeMap<String, serde_json::Value> = serde_json::from_str(&read_text(&path)?).ok()?;
    Some(
        raw.into_iter()
            .filter_map(|(key, value)| match value {
                serde_json::Value::String(source) => Some((key, Owned { source, hash: None })),
                other => serde_json::from_value(other).ok().map(|owned| (key, owned)),
            })
            .collect(),
    )
}
/// The saved ownership map. An unreadable file reads as empty, which only ever fails safe: every
/// account copy then counts as the user's (Uninstall keeps it, an add never replaces it).
fn read_owned(prefs: &Path) -> BTreeMap<String, Owned> {
    load_owned(prefs).unwrap_or_default()
}
/// Unreadable link records this process set aside, by records path → the backup's file name.
static SET_ASIDE: std::sync::LazyLock<Mutex<BTreeMap<PathBuf, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(BTreeMap::new()));
fn save_owned(prefs: &Path, owned: &BTreeMap<String, Owned>) -> Result<(), String> {
    let path = owned_path(prefs);
    if load_owned(prefs).is_none() {
        set_aside(&path)?;
    }
    let bytes = serde_json::to_vec_pretty(owned).map_err(|e| e.to_string())?;
    prefs::write_prefs_file(&path, &bytes)
}
/// Moves an unreadable records file to a timestamped backup beside it before a new one is
/// written; when that fails, nothing is written over it.
fn set_aside(path: &Path) -> Result<(), String> {
    let stamp = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        uuid::Uuid::new_v4()
    );
    let backup = path.with_extension(format!("json.{stamp}.backup"));
    fs::rename(path, &backup)
        .map_err(|e| format!("Could not keep a copy of the unreadable skill link records: {e}"))?;
    let name = backup
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    eprintln!("Warning: skill link records were unreadable; kept them as {name}.");
    recover(&SET_ASIDE).insert(path.to_owned(), name);
    Ok(())
}
/// The inventory's `linksWarning`: the record of links PandaCode made in account homes is
/// unreadable now, or was set aside by this run, so earlier links count as the user's.
pub(super) fn links_warning(prefs: &Path) -> Option<String> {
    let path = owned_path(prefs);
    let unreadable = {
        let _guard = recover(&LOCK);
        load_owned(prefs).is_none()
    };
    if unreadable {
        return Some(format!("{UNREADABLE} It stays as it is until the next add, which keeps a copy beside it."));
    }
    recover(&SET_ASIDE).get(&path).map(|name| {
        format!("{UNREADABLE} A copy was kept as {name} and a new record started.")
    })
}
const UNREADABLE: &str = "PandaCode couldn't read skill-manager-links.json, its record of the skill links it made in agent account homes, so it treats those links as yours: Uninstall leaves them and adds don't replace them.";

/// Whether `target` is still what PandaCode wrote there: the symbolic link it made to the same
/// source, or a copy whose content still hashes to what was written.
fn still_ours(target: &Path, owned: &Owned) -> bool {
    let Ok(meta) = fs::symlink_metadata(target) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return fs::read_link(target).is_ok_and(|link| link == Path::new(&owned.source));
    }
    meta.is_dir()
        && owned
            .hash
            .as_deref()
            .is_some_and(|hash| folder_hash(target).as_deref() == Some(hash))
}

/// Entries whose target is gone or no longer what PandaCode wrote are forgotten, so a folder the
/// user later puts at a once-owned path is theirs.
fn prune(owned: &mut BTreeMap<String, Owned>) -> bool {
    let before = owned.len();
    owned.retain(|key, entry| still_ours(Path::new(key), entry));
    owned.len() != before
}

/// Most entries hashed in one copy; a larger folder is never treated as an owned copy.
const HASH_LIMIT: usize = 4096;

/// A content hash of a folder: relative paths, kinds and file bytes in name order.
fn folder_hash(root: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    fn walk(dir: &Path, rel: &str, hasher: &mut Sha256, budget: &mut usize) -> Option<()> {
        let mut entries: Vec<_> = fs::read_dir(dir).ok()?.collect::<Result<_, _>>().ok()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            *budget = budget.checked_sub(1)?;
            let name = format!("{rel}/{}", entry.file_name().to_string_lossy());
            let kind = entry.file_type().ok()?;
            if kind.is_dir() {
                hasher.update(format!("d{}:{name}\0", name.len()));
                walk(&entry.path(), &name, hasher, budget)?;
            } else if kind.is_file() {
                let bytes = fs::read(entry.path()).ok()?;
                hasher.update(format!("f{}:{name}:{}\0", name.len(), bytes.len()));
                hasher.update(&bytes);
            } else {
                hasher.update(format!("o{}:{name}\0", name.len()));
            }
        }
        Some(())
    }
    let mut hasher = Sha256::new();
    let mut budget = HASH_LIMIT;
    walk(root, "", &mut hasher, &mut budget)?;
    Some(format!("{:x}", hasher.finalize()))
}

fn account_dirs(home: &Path, homes: &Homes, harness: &str) -> Vec<PathBuf> {
    let mut dirs = homes.configured.get(harness).cloned().unwrap_or_default();
    match harness {
        "codex" => dirs.extend(homes.codex.iter().filter(|p| p.is_absolute()).cloned()),
        "pi" => dirs.extend(homes.pi.iter().filter(|p| p.is_absolute()).cloned()),
        "opencode" => dirs.push(
            homes
                .xdg_config
                .as_ref()
                .filter(|p| p.is_absolute())
                .cloned()
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode"),
        ),
        _ => {}
    }
    let mut seen = BTreeSet::new();
    dirs.retain(|dir| seen.insert(checkout_key(dir)));
    dirs
}

/// A folder in a Codex, OpenCode, Pi or Kilo account home's `skills` that PandaCode did not
/// put there (or that changed since): the user's own, which an uninstall leaves in place.
pub(super) fn foreign_account_copy(
    home: &Path,
    homes: &Homes,
    prefs: &Path,
    folder: &Path,
) -> bool {
    let (Some(parent), Some(name)) = (folder.parent(), folder.file_name()) else {
        return false;
    };
    let parent = checkout_key(parent);
    let in_account = LINKED.iter().any(|harness| {
        account_dirs(home, homes, harness)
            .iter()
            .any(|dir| checkout_key(&dir.join("skills")) == parent)
    });
    if !in_account {
        return false;
    }
    let key = parent + std::path::MAIN_SEPARATOR_STR + &name.to_string_lossy();
    let owned = {
        let _guard = recover(&LOCK);
        read_owned(prefs)
    };
    !owned
        .get(&key)
        .is_some_and(|entry| still_ours(folder, entry))
}

/// Returns failures and the targets this run created or replaced.
/// Harnesses whose account homes receive links after a global install.
pub(super) const LINKED: [&str; 4] = ["codex", "opencode", "pi", "kilo"];

const OUTSIDE_ROOTS: &str = "The skills CLI reported a folder outside the known skill roots";

pub(super) fn link(
    home: &Path,
    homes: &Homes,
    harness: &str,
    records: &[serde_json::Value],
    prefs: &Path,
) -> (Vec<Failure>, Vec<PathBuf>) {
    let mut failures = Vec::new();
    let mut written = Vec::new();
    let mut owned = {
        let _guard = recover(&LOCK);
        let mut owned = read_owned(prefs);
        if prune(&mut owned) {
            if let Err(error) = save_owned(prefs, &owned) {
                eprintln!("Warning: could not save skill link ownership: {error}");
            }
        }
        owned
    };
    // Account links are made after global adds only: the user-level roots.
    let roots = safety::known_roots(home, None, homes);
    for dir in account_dirs(home, homes, harness) {
        for record in records.iter().filter(|r| r["status"] == "installed") {
            let Some(name) = record["name"].as_str() else {
                continue;
            };
            let source = record["path"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".agents/skills").join(name));
            let Some(folder) = source.file_name() else {
                continue;
            };
            let target = dir.join("skills").join(folder);
            match link_one(&source, &target, &roots, &mut owned, prefs) {
                Ok(true) => written.push(target),
                Ok(false) => {}
                Err(error) => failures.push(Failure::new(
                    name,
                    format!("Could not install into a {harness} account: {error}"),
                )),
            }
        }
    }
    (failures, written)
}

/// The CLI's reported `path` is untrusted: only a folder inside a known skill root (after
/// resolving links) is linked into account homes.
fn link_one(
    source: &Path,
    target: &Path,
    roots: &BTreeSet<PathBuf>,
    owned: &mut BTreeMap<String, Owned>,
    prefs: &Path,
) -> Result<bool, String> {
    let source = fs::canonicalize(source).map_err(|e| e.kind().to_string())?;
    if !roots
        .iter()
        .any(|root| source != *root && source.starts_with(root))
    {
        return Err(OUTSIDE_ROOTS.into());
    }
    if !source.join("SKILL.md").is_file() {
        return Err("Installed skill has no SKILL.md".into());
    }
    let parent = target.parent().expect("skills folder");
    // Created first so the ownership key always uses the canonical folder.
    fs::create_dir_all(parent).map_err(|e| e.kind().to_string())?;
    let key = checkout_key(parent)
        + std::path::MAIN_SEPARATOR_STR
        + &target.file_name().unwrap_or_default().to_string_lossy();
    let pending = Owned {
        source: source.to_string_lossy().into_owned(),
        hash: None,
    };
    match fs::symlink_metadata(target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Record ownership first: an interrupted write is never left looking like the user's.
            update_owned(prefs, owned, &key, Some(pending.clone()))?;
            write_link(&source, target)?;
            seal(prefs, owned, &key, pending, target)?;
            Ok(true)
        }
        Err(e) => Err(e.kind().to_string()),
        Ok(meta) => {
            let same = meta.file_type().is_symlink()
                && fs::canonicalize(target).is_ok_and(|real| real == source);
            if same {
                return Ok(false);
            }
            if !owned
                .get(&key)
                .is_some_and(|entry| still_ours(target, entry))
            {
                // The user's own folder (or another tool's), even at a path PandaCode once
                // wrote: never replaced, and the old claim on it is dropped.
                if owned.contains_key(&key) {
                    update_owned(prefs, owned, &key, None)?;
                }
                return Ok(false);
            }
            update_owned(prefs, owned, &key, Some(pending.clone()))?;
            replace(&source, target)?;
            seal(prefs, owned, &key, pending, target)?;
            Ok(true)
        }
    }
}

/// After a write: a copy records the hash of what is now at the target, so only that exact copy
/// is ever replaced later. A link is recognised by where it points and needs no hash.
fn seal(
    prefs: &Path,
    owned: &mut BTreeMap<String, Owned>,
    key: &str,
    pending: Owned,
    target: &Path,
) -> Result<(), String> {
    let is_link = fs::symlink_metadata(target).is_ok_and(|meta| meta.file_type().is_symlink());
    let hash = if is_link { None } else { folder_hash(target) };
    update_owned(prefs, owned, key, Some(Owned { hash, ..pending }))
}

/// Sets or removes one entry of the saved ownership map, re-read under the lock so an entry
/// another add saved since this one read the map is kept. `owned` becomes the saved map.
fn update_owned(
    prefs: &Path,
    owned: &mut BTreeMap<String, Owned>,
    key: &str,
    entry: Option<Owned>,
) -> Result<(), String> {
    let _guard = recover(&LOCK);
    let mut latest = read_owned(prefs);
    match entry {
        Some(entry) => latest.insert(key.to_owned(), entry),
        None => latest.remove(key),
    };
    save_owned(prefs, &latest)?;
    *owned = latest;
    Ok(())
}

#[cfg(unix)]
fn write_link(source: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, target).map_err(|e| e.kind().to_string())
}
#[cfg(windows)]
fn write_link(source: &Path, target: &Path) -> Result<(), String> {
    // Copy beside the target, then rename: a failed copy never sits at the target.
    let temp = sibling(target, "new");
    let result = copy_folder(source, &temp).and_then(|_| fs::rename(&temp, target));
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result.map_err(|e| e.kind().to_string())
}

fn sibling(target: &Path, kind: &str) -> PathBuf {
    target.with_file_name(format!(
        ".{}.pandacode-{kind}-{}",
        target.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ))
}

/// Swap in a fresh link or copy; the old one is restored if the swap fails.
fn replace(source: &Path, target: &Path) -> Result<(), String> {
    let fresh = sibling(target, "new");
    write_link(source, &fresh)?;
    let old = sibling(target, "old");
    if let Err(error) = fs::rename(target, &old) {
        let _ = links::remove_any(&fresh);
        return Err(error.kind().to_string());
    }
    if let Err(error) = fs::rename(&fresh, target) {
        let _ = fs::rename(&old, target);
        let _ = links::remove_any(&fresh);
        return Err(error.kind().to_string());
    }
    links::remove_any(&old).map_err(|e| e.kind().to_string())
}

#[cfg(windows)]
fn copy_folder(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_folder(&entry.path(), &target.join(entry.file_name()))?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    fn record(path: &Path) -> Vec<serde_json::Value> {
        vec![serde_json::json!({"name":"new","status":"installed","path":path})]
    }
    #[test]
    fn skill_manager_account_reinstall_refreshes_owned_links_and_keeps_user_folders() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        f.skill("home/.agents/skills/new", "---\nname: new\n---\nv1");
        f.skill("home/.claude/skills/new", "---\nname: new\n---\nv2");
        let homes = Homes {
            codex: Some(f.0.join("codex")),
            ..Homes::default()
        };
        let user = Homes {
            codex: Some(f.0.join("user-codex")),
            ..Homes::default()
        };
        f.skill("user-codex/skills/new", "---\nname: new\n---\nmine");
        // First install links; a reinstall from a new canonical path refreshes the owned link.
        let (failures, written) = link(
            &home,
            &homes,
            "codex",
            &record(&home.join(".agents/skills/new")),
            &prefs,
        );
        assert!(failures.is_empty() && written.len() == 1, "{failures:?}");
        let (_, written) = link(
            &home,
            &homes,
            "codex",
            &record(&home.join(".claude/skills/new")),
            &prefs,
        );
        assert_eq!(written.len(), 1);
        let target = f.0.join("codex/skills/new");
        assert_eq!(
            fs::canonicalize(&target).unwrap(),
            fs::canonicalize(home.join(".claude/skills/new")).unwrap()
        );
        // A same-named folder the user made is never replaced.
        let (failures, written) = link(
            &home,
            &user,
            "codex",
            &record(&home.join(".claude/skills/new")),
            &prefs,
        );
        assert!(failures.is_empty() && written.is_empty());
        assert!(
            fs::read_to_string(f.0.join("user-codex/skills/new/SKILL.md"))
                .unwrap()
                .contains("mine")
        );
    }
    fn owned(source: &str) -> Owned {
        Owned {
            source: source.into(),
            hash: None,
        }
    }
    #[test]
    fn skill_manager_account_ownership_save_keeps_entries_saved_since_it_was_read() {
        let f = Fixture::new();
        let prefs = f.0.join("prefs.json");
        save_owned(&prefs, &BTreeMap::from([("a".into(), owned("1"))])).unwrap();
        let mut map = read_owned(&prefs);
        // Another add saves its link after this one read the map.
        save_owned(
            &prefs,
            &BTreeMap::from([("a".into(), owned("1")), ("b".into(), owned("2"))]),
        )
        .unwrap();
        update_owned(&prefs, &mut map, "c", Some(owned("3"))).unwrap();
        let saved = read_owned(&prefs);
        assert_eq!(saved.keys().collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(map, saved);
        // Older builds saved the source alone: it still reads, with no hash.
        fs::write(owned_path(&prefs), r#"{"old":"/src"}"#).unwrap();
        assert_eq!(read_owned(&prefs)["old"], owned("/src"));
    }
    #[test]
    fn skill_manager_account_interrupted_write_recorded_as_owned_is_retried_and_leaves_no_siblings()
    {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        f.skill("home/.agents/skills/new", "---\nname: new\n---\nfull");
        let target = f.0.join("codex/skills/new");
        // Ownership was recorded, then the write never happened.
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let key = checkout_key(target.parent().unwrap()) + std::path::MAIN_SEPARATOR_STR + "new";
        save_owned(&prefs, &BTreeMap::from([(key.clone(), owned("old"))])).unwrap();
        let homes = Homes {
            codex: Some(f.0.join("codex")),
            ..Homes::default()
        };
        let (failures, written) = link(
            &home,
            &homes,
            "codex",
            &record(&home.join(".agents/skills/new")),
            &prefs,
        );
        assert!(failures.is_empty() && written.len() == 1, "{failures:?}");
        assert!(target.join("SKILL.md").is_file());
        let leftovers = fs::read_dir(f.0.join("codex/skills")).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary siblings remain");
        assert!(read_owned(&prefs).contains_key(&key));
    }
    #[test]
    fn skill_manager_account_folder_put_at_a_once_owned_path_survives_a_later_add() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        f.skill("home/.agents/skills/new", "---\nname: new\n---\nv1");
        f.skill("home/.claude/skills/new", "---\nname: new\n---\nv2");
        let homes = Homes {
            codex: Some(f.0.join("codex")),
            ..Homes::default()
        };
        let target = f.0.join("codex/skills/new");
        // 1. A global add links the skill into the Codex account.
        let (failures, written) = link(
            &home,
            &homes,
            "codex",
            &record(&home.join(".agents/skills/new")),
            &prefs,
        );
        assert!(
            failures.is_empty() && written == [target.clone()],
            "{failures:?}"
        );
        // 2. The user removes the link, 3. and puts a folder of their own there.
        fs::remove_file(&target).unwrap();
        f.skill("codex/skills/new", "---\nname: new\n---\nmine");
        fs::write(target.join("notes.md"), "keep").unwrap();
        // 4. A later add of a same-named skill from elsewhere leaves it alone.
        let (failures, written) = link(
            &home,
            &homes,
            "codex",
            &record(&home.join(".claude/skills/new")),
            &prefs,
        );
        assert!(failures.is_empty() && written.is_empty(), "{failures:?}");
        assert!(!fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::read_to_string(target.join("SKILL.md"))
            .unwrap()
            .contains("mine"));
        assert_eq!(fs::read_to_string(target.join("notes.md")).unwrap(), "keep");
        // The stale claim is gone, so no later add can take the folder either.
        assert!(read_owned(&prefs).is_empty(), "{:?}", read_owned(&prefs));
        let leftovers = fs::read_dir(f.0.join("codex/skills")).unwrap().count();
        assert_eq!(leftovers, 1);
    }
    #[test]
    fn skill_manager_account_link_refuses_a_cli_path_outside_the_known_skill_roots() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        f.skill("elsewhere/evil", "---\nname: evil\n---\nx");
        fs::create_dir_all(home.join(".agents/skills")).unwrap();
        // A link inside a root that leads outside is judged by where it really is.
        std::os::unix::fs::symlink(f.0.join("elsewhere/evil"), home.join(".agents/skills/sly"))
            .unwrap();
        let homes = Homes {
            codex: Some(f.0.join("codex")),
            ..Homes::default()
        };
        for path in [
            f.0.join("elsewhere/evil"),
            home.join(".agents/skills/sly"),
            home.join(".agents/skills"),
        ] {
            let (failures, written) = link(&home, &homes, "codex", &record(&path), &prefs);
            assert!(written.is_empty(), "{path:?}");
            assert_eq!(failures.len(), 1, "{path:?}");
            assert!(failures[0].reason.contains(OUTSIDE_ROOTS), "{path:?}");
        }
        let linked = fs::read_dir(f.0.join("codex/skills")).map_or(0, |d| d.count());
        assert_eq!(linked, 0, "nothing is linked into the account");
        assert!(read_owned(&prefs).is_empty());
    }
    #[test]
    fn skill_manager_account_ownership_drops_targets_that_are_missing_or_changed() {
        let f = Fixture::new();
        f.skill("src/a", "---\nname: a\n---\n");
        f.skill("copy", "---\nname: a\n---\nwritten");
        let source = fs::canonicalize(f.0.join("src/a")).unwrap();
        let link = f.0.join("link");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        let elsewhere = f.0.join("elsewhere");
        std::os::unix::fs::symlink(f.0.join("copy"), &elsewhere).unwrap();
        let copy = f.0.join("copy");
        let source_text = source.to_string_lossy().into_owned();
        let hash = folder_hash(&copy);
        let mut map = BTreeMap::from([
            (link.to_string_lossy().into_owned(), owned(&source_text)),
            (
                elsewhere.to_string_lossy().into_owned(),
                owned(&source_text),
            ),
            (
                f.0.join("gone").to_string_lossy().into_owned(),
                owned(&source_text),
            ),
            (
                copy.to_string_lossy().into_owned(),
                Owned {
                    source: source_text.clone(),
                    hash: hash.clone(),
                },
            ),
        ]);
        assert!(prune(&mut map));
        let kept: Vec<_> = map.keys().cloned().collect();
        assert_eq!(
            kept,
            [
                copy.to_string_lossy().into_owned(),
                link.to_string_lossy().into_owned()
            ]
        );
        // An owned copy the user edited is no longer ours.
        fs::write(copy.join("SKILL.md"), "---\nname: a\n---\nedited").unwrap();
        assert!(prune(&mut map));
        assert_eq!(map.len(), 1);
        // A legacy copy without a hash is never ours.
        let mut legacy =
            BTreeMap::from([(copy.to_string_lossy().into_owned(), owned(&source_text))]);
        assert!(prune(&mut legacy) && legacy.is_empty());
    }
}
