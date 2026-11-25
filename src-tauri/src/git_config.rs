//! The slice of Git's config format PandaCode reads: unsubsectioned `[core]` `bare` and
//! `worktree` in a repository's common `config`, following `[include] path`s in place. Anything
//! it cannot interpret safely fails closed. Used by `claude_roots` to find a linked worktree's
//! main checkout.
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
    let (mut core, mut include, mut section) = (false, false, false);
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
            let (name, subsectioned) = git_config_section(header)?;
            include = name.eq_ignore_ascii_case("include");
            if name.eq_ignore_ascii_case("includeif")
                || (include && (subsectioned || includes.is_none()))
            {
                return Err("unsupported git config include");
            }
            core = name.eq_ignore_ascii_case("core") && !subsectioned;
            section = true;
            continue;
        }
        let key_end = line.find(|c: char| c == '=' || c.is_whitespace() || matches!(c, '#' | ';'))
            .unwrap_or(line.len());
        let (key, tail) = line.split_at(key_end);
        if !section || !key.starts_with(|c: char| c.is_ascii_alphabetic())
            || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("invalid git config key");
        }
        let tail = tail.trim_start();
        let value = if let Some(value) = tail.strip_prefix('=') {
            let mut raw = value.to_owned();
            while git_config_continues(&raw) {
                raw.pop();
                let next = lines.next().ok_or("unterminated git config continuation")?;
                if next.contains('\0') {
                    return Err("invalid git config character");
                }
                raw.push_str(next);
            }
            Some(git_config_value(&raw)?)
        } else if tail.is_empty() || tail.starts_with(['#', ';']) {
            None // A key without '=' is Git's implicit boolean true.
        } else {
            return Err("invalid git config assignment");
        };
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
    }
    Ok(())
}

/// A section header (the text after `[`): its name and whether it has a quoted subsection.
fn git_config_section(header: &str) -> std::result::Result<(&str, bool), &'static str> {
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
    if !subsection.is_empty() {
        let inner = subsection.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
            .ok_or("invalid git config subsection")?;
        let mut escaped = false;
        for c in inner.chars() {
            if escaped {
                if !matches!(c, '\\' | '"') {
                    return Err("invalid git config subsection escape");
                }
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                return Err("invalid git config subsection quote");
            }
        }
        if escaped {
            return Err("unterminated git config subsection escape");
        }
    }
    Ok((name, !subsection.is_empty()))
}

/// Whether a raw value line ends in a continuation (`git-config(1)`): a final `\` that is not
/// itself escaped and not inside a comment. Quotes do not stop a continuation.
fn git_config_continues(value: &str) -> bool {
    let mut quoted = false;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return false,
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

/// A regular UTF-8 file of at most `limit` bytes, checked at stat and again while reading.
pub(crate) fn read_git_file(path: &Path, limit: u64) -> std::result::Result<String, &'static str> {
    use std::io::Read;
    let metadata = std::fs::metadata(path).map_err(|_| "unreadable worktree metadata")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("invalid worktree metadata file");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
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
