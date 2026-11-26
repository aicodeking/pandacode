//! Bounded reads of Git's config format to find a linked worktree's main checkout and inspect
//! checkout-local settings before stamping a warm spare's working tree.
use std::path::{Path, PathBuf};

/// Only an unsubsectioned [core] defines bare/worktree. Reject syntax we cannot safely
/// interpret rather than treating an ambiguous common directory as having no checkout. A config
/// held as text has no folder to resolve `[include] path` against, so any include fails closed
/// here; [`read_git_core_checkout`] follows them.
#[cfg(test)]
pub(crate) fn git_core_checkout(config: &str) -> std::result::Result<(bool, Option<String>), &'static str> {
    let mut checkout = (false, None);
    parse_git_config(config, None, &mut checkout)?;
    Ok(checkout)
}

/// Parses unsubsectioned `[core]` (`bare`, `worktree`) for the file at `config_path`, following
/// `[include] path`s as Git does: in place, relative to the including file's folder (`~/` from
/// home), at most `MAX_INCLUDE_DEPTH` deep in one shared `MAX_GIT_CONFIG_BYTES` budget. A missing
/// include is skipped like Git; an unreadable, oversize, cyclic or too-deep one fails closed, as
/// does any `[includeIf]`.
pub(crate) fn read_git_core_checkout(config_path: &Path) -> std::result::Result<(bool, Option<String>), &'static str> {
    let mut budget = IncludeBudget { remaining: MAX_GIT_CONFIG_BYTES, chain: Vec::new() };
    let mut checkout = (false, None);
    budget.parse_file(config_path, &mut checkout)?;
    Ok(checkout)
}

/// Inspect checkout-local config and attributes under one byte budget before running
/// isolated status. Filters can execute programs or hide changes if switched off.
pub(crate) fn check_status_config_safe(
    git_dir: &Path,
    common_dir: &Path,
    worktree_root: Option<&Path>,
) -> std::result::Result<(), &'static str> {
    let mut remaining = MAX_GIT_CONFIG_BYTES;
    for path in [common_dir.join("config"), git_dir.join("config.worktree")] {
        if crate::claude_roots::settings_path_absent(&path) {
            continue;
        }
        let config = read_git_file(&path, remaining)?;
        remaining -= config.len() as u64;
        check_status_config(&config)?;
    }
    let attributes = [
        worktree_root.map(|root| root.join(".gitattributes")),
        Some(common_dir.join("info").join("attributes")),
        (git_dir != common_dir).then(|| git_dir.join("info").join("attributes")),
    ];
    for path in attributes.into_iter().flatten() {
        if crate::claude_roots::settings_path_absent(&path) {
            continue;
        }
        let attributes = read_git_file(&path, remaining)?;
        remaining -= attributes.len() as u64;
        check_status_attributes(&attributes)?;
    }
    Ok(())
}

fn check_status_attributes(attributes: &str) -> std::result::Result<(), &'static str> {
    let attributes = attributes.strip_prefix('\u{feff}').unwrap_or(attributes);
    for line in attributes.lines().map(str::trim_start) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut tokens = line.split_ascii_whitespace();
        if let Some(quoted) = line.strip_prefix('"') {
            // Git allows attributes immediately after a quoted pattern.
            let mut chars = quoted.char_indices();
            let end = loop {
                match chars.next() {
                    Some((index, '"')) => break index + 1,
                    Some((_, '\\')) => { let _ = chars.next(); }
                    Some(_) => (),
                    None => return Err("invalid git attributes pattern"),
                }
            };
            tokens = quoted[end..].split_ascii_whitespace();
        } else {
            let _ = tokens.next();
        }
        if tokens.any(|token| token.starts_with("filter=")) {
            return Err("unsupported git attributes filter");
        }
    }
    Ok(())
}

fn check_status_config(config: &str) -> std::result::Result<(), &'static str> {
    visit_git_config(config, |name, subsection, item| {
        let GitConfigItem::Entry { key, value } = item else {
            // Git flattens a mixed dotted/quoted header into one subsection. Refuse this form
            // so it cannot hide a filter or other key behind an apparent section name.
            if name.contains('.') {
                return Err("unsupported git config section");
            }
            if name.eq_ignore_ascii_case("include") || name.eq_ignore_ascii_case("includeif") {
                return Err("unsupported git config include");
            }
            if name.eq_ignore_ascii_case("filter") {
                return Err("unsupported git filter section");
            }
            if name.eq_ignore_ascii_case("credential") {
                return Err("unsupported git credential key");
            }
            return Ok(());
        };
        if name.eq_ignore_ascii_case("core") && subsection.is_none() {
            if key.eq_ignore_ascii_case("worktree") {
                return Err("unsupported git core.worktree");
            }
            if key.eq_ignore_ascii_case("sshcommand") || key.eq_ignore_ascii_case("askpass") {
                return Err("unsupported git program key");
            }
            if key.eq_ignore_ascii_case("attributesfile") {
                return Err("unsupported git core.attributesFile");
            }
        } else if name.eq_ignore_ascii_case("extensions") && subsection.is_none() && key.eq_ignore_ascii_case("partialclone") {
            if value.as_deref().is_none_or(|value| !value.trim().is_empty()) {
                return Err("unsupported git partial clone");
            }
        } else if name.eq_ignore_ascii_case("remote") && subsection.is_some() && key.eq_ignore_ascii_case("promisor") {
            let falsy = value.as_deref().is_some_and(|value| {
                matches!(value.trim().to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0")
            });
            if !falsy {
                return Err("unsupported git promisor remote");
            }
        }
        Ok(())
    })
}

/// How deep `[include]` may nest below the common config.
const MAX_INCLUDE_DEPTH: usize = 4;

/// Bytes left to read across a config and its includes, and the canonical include chain being
/// parsed (a file already on it is a cycle; one included twice side by side is not).
struct IncludeBudget { remaining: u64, chain: Vec<PathBuf> }

impl IncludeBudget {
    fn parse_file(&mut self, path: &Path, checkout: &mut (bool, Option<String>)) -> std::result::Result<(), &'static str> {
        if self.chain.len() > MAX_INCLUDE_DEPTH {
            return Err("git config include too deep");
        }
        let canonical = path.canonicalize().map_err(|_| "unreadable worktree metadata")?;
        if self.chain.contains(&canonical) {
            return Err("cyclic git config include");
        }
        let config = read_git_file(path, self.remaining)?;
        self.remaining -= config.len() as u64;
        self.chain.push(canonical);
        let parsed = parse_git_config(&config, Some((path, &mut *self)), checkout);
        self.chain.pop();
        parsed
    }

    fn include(&mut self, base: &Path, value: &str, checkout: &mut (bool, Option<String>)) -> std::result::Result<(), &'static str> {
        let path = if let Some(rest) = value.strip_prefix("~/") {
            crate::account_config::home(&[]).ok_or("unknown home for git config include")?.join(rest)
        } else if value.starts_with('~') || value.starts_with("%(") {
            return Err("unsupported git config include path");
        } else {
            base.parent().ok_or("invalid git config include path")?.join(value)
        };
        if crate::claude_roots::settings_path_absent(&path) {
            return Ok(()); // Git ignores an include whose file does not exist.
        }
        self.parse_file(&path, checkout)
    }
}

/// One config's lines in order, updating `checkout` and handing `[include] path` to `includes`
/// at the point it appears, so later assignments override included ones as in Git.
fn parse_git_config(config: &str, mut includes: Option<(&Path, &mut IncludeBudget)>, checkout: &mut (bool, Option<String>))
    -> std::result::Result<(), &'static str> {
    visit_git_config(config, |name, subsection, item| {
        let include = name.eq_ignore_ascii_case("include") && subsection.is_none();
        let GitConfigItem::Entry { key, value } = item else {
            if name.eq_ignore_ascii_case("includeif")
                || (name.eq_ignore_ascii_case("include") && (!include || includes.is_none()))
            {
                return Err("unsupported git config include");
            }
            return Ok(());
        };
        let core = name.eq_ignore_ascii_case("core") && subsection.is_none();
        if core && key.eq_ignore_ascii_case("bare") {
            checkout.0 = match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None | Some("true" | "yes" | "on" | "1") => true,
                Some("" | "false" | "no" | "off" | "0") => false,
                _ => return Err("invalid git core.bare"),
            };
        } else if core && key.eq_ignore_ascii_case("worktree") {
            let value = value.filter(|value| !value.is_empty()).ok_or("empty git core.worktree")?;
            checkout.1 = Some(value);
        } else if include && key.eq_ignore_ascii_case("path") {
            let path = value.filter(|value| !value.is_empty()).ok_or("invalid git config include path")?;
            match &mut includes {
                None => return Err("unsupported git config include"),
                Some((base, budget)) => budget.include(base, &path, checkout)?,
            }
        }
        Ok(())
    })
}

enum GitConfigItem<'a> {
    Section,
    Entry { key: &'a str, value: Option<String> },
}

/// Visit headers (including empty sections) and decoded entries in file order.
fn visit_git_config(
    config: &str,
    mut visit: impl FnMut(&str, Option<&str>, GitConfigItem<'_>) -> std::result::Result<(), &'static str>,
) -> std::result::Result<(), &'static str> {
    let mut section = None;
    let mut lines = config.lines();
    while let Some(line) = lines.next() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        if line.contains('\0') {
            return Err("invalid git config character");
        }
        if let Some(header) = line.strip_prefix('[') {
            let (name, subsection) = git_config_section(header)?;
            visit(name, subsection.as_deref(), GitConfigItem::Section)?;
            section = Some((name, subsection));
            continue;
        }
        let Some((name, ref subsection)) = section else {
            return Err("invalid git config key");
        };
        let key_end = line.find(|c: char| c == '=' || c.is_whitespace() || matches!(c, '#' | ';'))
            .unwrap_or(line.len());
        let (key, tail) = line.split_at(key_end);
        if !key.starts_with(|c: char| c.is_ascii_alphabetic())
            || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("invalid git config key");
        }
        let tail = tail.trim_start();
        let value = if let Some(mut fragment) = tail.strip_prefix('=') {
            let mut raw = fragment.to_owned();
            let mut quoted = false;
            while git_config_continues(fragment, &mut quoted) {
                raw.pop();
                fragment = lines.next().ok_or("unterminated git config continuation")?;
                if fragment.contains('\0') {
                    return Err("invalid git config character");
                }
                raw.push_str(fragment);
            }
            Some(git_config_value(&raw)?)
        } else if tail.is_empty() || tail.starts_with(['#', ';']) {
            None // A key without '=' is Git's implicit boolean true.
        } else {
            return Err("invalid git config assignment");
        };
        visit(name, subsection.as_deref(), GitConfigItem::Entry { key, value })?;
    }
    Ok(())
}

/// A section header (the text after `[`): its name and optional, decoded subsection.
fn git_config_section(header: &str) -> std::result::Result<(&str, Option<String>), &'static str> {
    let (header, tail) = header.split_once(']').ok_or("invalid git config section")?;
    let tail = tail.trim();
    if !tail.is_empty() && !tail.starts_with(['#', ';']) {
        return Err("invalid git config section suffix");
    }
    let header = header.trim();
    let name_end = header.find(char::is_whitespace).unwrap_or(header.len());
    let (name, subsection) = header.split_at(name_end);
    if name.is_empty() || !name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.')) {
        return Err("invalid git config section name");
    }
    let subsection = subsection.trim();
    if subsection.is_empty() {
        if let Some((name, subsection)) = name.split_once('.') {
            if name.is_empty() || subsection.is_empty() {
                return Err("invalid git config subsection");
            }
            return Ok((name, Some(subsection.to_ascii_lowercase())));
        }
        return Ok((name, None));
    }
    let inner = subsection.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
        .ok_or("invalid git config subsection")?;
    let mut decoded = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        decoded.push(match c {
            '\\' => match chars.next() {
                Some(c @ ('\\' | '"')) => c,
                Some(_) => return Err("invalid git config subsection escape"),
                None => return Err("unterminated git config subsection escape"),
            },
            '"' => return Err("invalid git config subsection quote"),
            _ => c,
        });
    }
    Ok((name, Some(decoded)))
}

/// Whether this fragment ends with an unescaped `\` outside a comment. Carry the quote state
/// into the next fragment so long continuations only need one scan.
fn git_config_continues(value: &str, quoted: &mut bool) -> bool {
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => *quoted = !*quoted,
            '#' | ';' if !*quoted => return false,
            '\\' if chars.next().is_none() => return true, // An escape also consumes the next character.
            _ => (),
        }
    }
    false
}

/// Decode Git's quoted values and escapes, preserving quoted whitespace and comment bytes.
/// Leading unquoted whitespace is dropped and trailing unquoted whitespace trimmed, as in Git.
/// Unsupported escapes fail closed (continuations are joined by the caller); the entire config
/// is already bounded.
fn git_config_value(value: &str) -> std::result::Result<String, &'static str> {
    let mut decoded = String::new();
    let mut quoted = false;
    let mut significant = 0;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => break,
            '\\' => {
                decoded.push(match chars.next() {
                    Some('\\') => '\\',
                    Some('"') => '"',
                    Some('n') => '\n',
                    Some('t') => '\t',
                    Some('b') => '\u{8}',
                    _ => return Err("invalid git config escape"),
                });
                significant = decoded.len();
            }
            c if c.is_whitespace() && !quoted && decoded.is_empty() => (),
            _ => {
                decoded.push(c);
                if quoted || !c.is_whitespace() {
                    significant = decoded.len();
                }
            }
        }
    }
    if quoted {
        return Err("unterminated git config quote");
    }
    decoded.truncate(significant);
    Ok(decoded)
}

/// Bound for a common `config` with its includes: a `[branch]` section per branch grows it far past
/// the pointer files (16 KiB is only ~180 branches), and an oversize one disables explore.
pub(crate) const MAX_GIT_CONFIG_BYTES: u64 = 1024 * 1024;

/// A regular UTF-8 file of at most `limit` bytes, checked on the open handle and again while reading.
pub(crate) fn read_git_file(path: &Path, limit: u64) -> std::result::Result<String, &'static str> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "unreadable worktree metadata")?;
    let metadata = file.metadata().map_err(|_| "unreadable worktree metadata")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("invalid worktree metadata file");
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)
        .map_err(|_| "unreadable worktree metadata")?;
    if bytes.len() as u64 > limit {
        return Err("oversized worktree metadata");
    }
    String::from_utf8(bytes).map_err(|_| "invalid worktree metadata encoding")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("pandacode-git-config-{name}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn read_git_file_rejects_fifo_without_waiting_for_a_writer() {
        let scratch = Scratch::new("fifo");
        let fifo = scratch.0.join("pipe");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || sender.send(read_git_file(&fifo, 1024)));
        assert_eq!(receiver.recv_timeout(std::time::Duration::from_secs(5)), Ok(Err("invalid worktree metadata file")));
        reader.join().unwrap().unwrap();
    }

    #[test]
    fn status_config_checks_common_and_linked_worktree_config() {
        let common = Scratch::new("status-common");
        let worktree = Scratch::new("status-worktree");
        let config = common.0.join("config");
        let worktree_config = worktree.0.join("config.worktree");
        let check = || check_status_config_safe(&worktree.0, &common.0, None);
        std::fs::write(&config, "[core]\n repositoryformatversion = 0\n filemode = true\n bare = false\n logallrefupdates = true\n").unwrap();
        assert_eq!(check(), Ok(()));

        std::fs::write(&worktree_config, "[filter \"worktree\"]\n").unwrap();
        assert_eq!(check(), Err("unsupported git filter section"));
        std::fs::write(&worktree_config, "[core]\n worktree = ../other\n").unwrap();
        assert_eq!(check(), Err("unsupported git core.worktree"));
    }

    #[test]
    fn status_config_checks_shared_attributes_in_linked_worktrees() {
        let common = Scratch::new("status-common-attributes");
        let worktree = Scratch::new("status-linked-attributes");
        let info = common.0.join("info");
        std::fs::create_dir(&info).unwrap();
        let attributes = info.join("attributes");
        let check = || check_status_config_safe(&worktree.0, &common.0, None);
        std::fs::write(&attributes, "*.pdf binary\n").unwrap();
        assert_eq!(check(), Ok(()));
        std::fs::write(&attributes, "*.txt filter=norm\n").unwrap();
        assert_eq!(check(), Err("unsupported git attributes filter"));
    }

    #[test]
    fn status_config_refuses_active_filter_attributes() {
        let git = Scratch::new("status-git");
        let root = Scratch::new("status-root");
        let info = git.0.join("info");
        std::fs::create_dir(&info).unwrap();
        std::fs::write(git.0.join("config"), "[core]\n bare = false\n").unwrap();
        let check = || check_status_config_safe(&git.0, &git.0, Some(&root.0));
        for path in [root.0.join(".gitattributes"), info.join("attributes")] {
            std::fs::write(&path, "tests/fixtures/*.pdf binary\n* text=auto\n*.txt -filter\n*.txt !filter\n  # *.txt filter=x\n").unwrap();
            assert_eq!(check(), Ok(()));
            for rule in [
                "*.txt filter=norm\n",
                "\"file name.txt\" text=auto filter=norm\n",
                "\u{feff}\"file name.txt\"filter=norm\n",
            ] {
                std::fs::write(&path, rule).unwrap();
                assert_eq!(check(), Err("unsupported git attributes filter"));
            }
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn status_config_refuses_risky_or_malformed_config() {
        let scratch = Scratch::new("status-refusals");
        let path = scratch.0.join("config");
        for (config, error) in [
            ("[filter \"x\"]\n", "unsupported git filter section"),
            ("[filter.legacy]\n", "unsupported git filter section"),
            ("[core]\n attributesFile = /elsewhere\n", "unsupported git core.attributesFile"),
            ("[credential]\n", "unsupported git credential key"),
            ("[filter \"a=b\"]\n", "unsupported git filter section"),
            ("[filter \"a\\nb\"]\n", "invalid git config subsection escape"),
            ("[filter \"a\nb\"]\n", "invalid git config section"),
            ("[filter \"\"]\n", "unsupported git filter section"),
            ("[filter]\n", "unsupported git filter section"),
            ("[filter.]\n", "invalid git config subsection"),
            ("[filter.a \"b\"]\n clean = cat\n", "unsupported git config section"),
            ("[include]\n", "unsupported git config include"),
            ("[include.legacy]\n", "unsupported git config include"),
            ("[includeIf \"gitdir:/x/\"]\n path = missing\n", "unsupported git config include"),
            ("[CoRe]\n WorkTree = ../other\n", "unsupported git core.worktree"),
            ("[core]\n sshCommand = ssh\n", "unsupported git program key"),
            ("[core]\n askPass = ask\n", "unsupported git program key"),
            ("[credential]\n helper = x\n", "unsupported git credential key"),
            ("[credential \"https://x\"]\n helper = x\n", "unsupported git credential key"),
            ("[extensions]\n partialClone = true\n", "unsupported git partial clone"),
            ("[extensions]\n partialClone\n", "unsupported git partial clone"),
            ("[remote \"origin\"]\n promisor\n", "unsupported git promisor remote"),
            ("[remote \"origin\"]\n promisor = \"true\"\n", "unsupported git promisor remote"),
            ("[remote.origin]\n promisor = \"\"\n", "unsupported git promisor remote"),
            ("[remote \"origin\"]\n promisor = fal\\\nse\n promisor = maybe\n", "unsupported git promisor remote"),
            ("[user]\n name = \"unterminated\n", "unterminated git config quote"),
            ("[user]\n name = a\\", "unterminated git config continuation"),
        ] {
            std::fs::write(&path, config).unwrap();
            assert_eq!(check_status_config_safe(&scratch.0, &scratch.0, Some(&scratch.0)), Err(error), "{config:?}");
        }
        let inert = "[extensions]\n partialClone = \"\"\n[remote.origin]\n promisor = fal\\\nse\n promisor = \" Off \"\n";
        std::fs::write(&path, inert).unwrap();
        assert_eq!(check_status_config_safe(&scratch.0, &scratch.0, Some(&scratch.0)), Ok(()));
    }

    #[test]
    fn status_config_shares_one_byte_budget_and_refuse_nonfiles() {
        let scratch = Scratch::new("status-budget");
        let config = scratch.0.join("config");
        let worktree_config = scratch.0.join("config.worktree");
        let limit = MAX_GIT_CONFIG_BYTES as usize;
        std::fs::write(&config, " ".repeat(limit)).unwrap();
        std::fs::write(&worktree_config, "").unwrap();
        assert_eq!(check_status_config_safe(&scratch.0, &scratch.0, Some(&scratch.0)), Ok(()));
        let attributes = scratch.0.join(".gitattributes");
        std::fs::write(&attributes, "\n").unwrap();
        assert_eq!(check_status_config_safe(&scratch.0, &scratch.0, Some(&scratch.0)), Err("invalid worktree metadata file"));
        std::fs::remove_file(attributes).unwrap();
        std::fs::write(&worktree_config, "\n").unwrap();
        assert_eq!(check_status_config_safe(&scratch.0, &scratch.0, Some(&scratch.0)), Err("invalid worktree metadata file"));

        std::fs::remove_file(&config).unwrap();
        std::fs::remove_file(&worktree_config).unwrap();
        std::fs::create_dir(&worktree_config).unwrap();
        // Windows refuses opening a directory handle without backup semantics before `file.metadata()`.
        #[cfg(windows)]
        let expected = Err("unreadable worktree metadata");
        #[cfg(not(windows))]
        let expected = Err("invalid worktree metadata file");
        assert_eq!(check_status_config_safe(&scratch.0, &scratch.0, Some(&scratch.0)), expected);
    }

    #[test]
    fn git_config_values_continue_after_an_unescaped_trailing_backslash() {
        let main = Ok((false, Some("../main".to_owned())));
        for config in ["[core]\n worktree = ../ma\\\nin\n", "[core]\r\n worktree = \"../ma\\\r\nin\" # c\r\n", "[core]\n worktree = \\\n  ../main\n"] {
            assert_eq!(git_core_checkout(config), main, "{config:?}");
        }
        // A continued value in another section swallows what would otherwise be a `[core]` header.
        assert_eq!(git_core_checkout("[remote \"origin\"]\n url = a\\\n[core]\n worktree = ../main\n"), Ok((false, None)));
        // Neither a backslash in a comment nor an escaped one continues; a dangling one at the end fails closed.
        assert_eq!(git_core_checkout("[core]\n bare = true # note \\\n worktree = ../main\n"), Ok((true, Some("../main".to_owned()))));
        assert_eq!(git_core_checkout("[core]\n worktree = C:\\\\\n bare\n"), Ok((true, Some("C:\\".to_owned()))));
        assert_eq!(git_core_checkout("[core]\n worktree = a\\"), Err("unterminated git config continuation"));
    }

    #[test]
    fn git_config_includes_apply_in_place_skip_missing_files_and_refuse_cycles() {
        let scratch = Scratch::new("include");
        let (config, extra) = (scratch.0.join("config"), scratch.0.join("extra").join("checkout.config"));
        std::fs::create_dir_all(scratch.0.join("extra")).unwrap();
        std::fs::write(&extra, "[core]\n\tworktree = ../main\n").unwrap();
        let text = "[core]\n bare = true\n[InClUdE]\n PaTh = extra/checkout.config\n path = missing.config\n";
        std::fs::write(&config, text).unwrap();
        assert_eq!(read_git_core_checkout(&config), Ok((true, Some("../main".to_owned()))));
        assert_eq!(git_core_checkout(text), Err("unsupported git config include"), "text alone has no folder to resolve against");
        // Later lines override included ones, as if the file were pasted in place.
        std::fs::write(&config, "[include]\n path = extra/checkout.config\n[core]\n worktree = ../other\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Ok((false, Some("../other".to_owned()))));
        std::fs::write(&extra, "[include]\n path = ../config\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Err("cyclic git config include"));
        std::fs::write(&config, "[includeIf \"gitdir:/x/\"]\n path = missing.config\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Err("unsupported git config include"));
        // d2 through d5 nest four deep (d6 is missing); starting at d1 is one too many.
        (1..=5).for_each(|n| std::fs::write(scratch.0.join(format!("d{n}")), format!("[include]\n path = d{}\n", n + 1)).unwrap());
        std::fs::write(&config, "[include]\n path = d2\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Ok((false, None)));
        std::fs::write(&config, "[include]\n path = d1\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Err("git config include too deep"));
    }
}
