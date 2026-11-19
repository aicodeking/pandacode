//! The call's `glob` filter, written the many ways an agent writes a path.
use super::{index::Snapshot, named, Ctx};
use ignore::{
    gitignore::{Gitignore, GitignoreBuilder, Glob as GitignoreGlob},
    overrides::{Override, OverrideBuilder},
    Match,
};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

const WILDCARDS: &[char] = &['*', '?', '[', '{'];

pub(super) struct Globs {
    root: PathBuf,
    /// The globs as an override matcher's lines: `decide` reads them as `Override` does.
    filter: Option<Gitignore>,
    /// Each glob that is not a `!` exclusion, as given and as normalized.
    positive: Vec<(String, String)>,
    pub(super) errors: Vec<String>,
    pub(super) named_large: Vec<Arc<str>>,
}

/// `./x`, an absolute path under the root (as given or canonical), `x/` and a bare folder all
/// mean what they say.
fn normalize(ctx: &Ctx, raw: &str) -> Result<String, String> {
    let (negated, body) = raw.strip_prefix('!').map_or((false, raw), |body| (true, body));
    let body = if Path::new(body).is_absolute() { ctx.relative(body).ok_or_else(|| format!("{raw}: outside the project"))? } else { body };
    let body = &without_dot_dot(raw, body.strip_prefix("./").unwrap_or(body))?;
    let mark = if negated { "!" } else { "" };
    if let Some(folder) = body.strip_suffix('/') {
        return Ok(if negated && !ctx.root.join(folder).is_dir() { format!("!{body}") } else { format!("{mark}{folder}/**") });
    }
    if !body.contains(WILDCARDS) && ctx.root.join(body).is_dir() {
        return Ok(format!("{mark}{body}/**"));
    }
    Ok(format!("{mark}{body}"))
}

/// `src/../web/**` and `src//../web/**` are `web/**`, `src/.` is `src` and `.` is `**`; a `..`
/// that would leave the project, or step back over a wildcard, is refused.
fn without_dot_dot(raw: &str, body: &str) -> Result<String, String> {
    let inner = body.strip_suffix(['/', '\\']).unwrap_or(body);
    if !inner.is_empty() && !inner.split(['/', '\\']).any(|part| matches!(part, "" | "." | "..")) {
        return Ok(body.to_owned());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in body.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => match parts.pop() {
                Some(folder) if !folder.contains(WILDCARDS) => {}
                _ => return Err(format!("{raw}: `..` may not leave the project or follow a wildcard")),
            },
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Ok("**".to_owned());
    }
    // A trailing `/` still says the glob is a folder.
    let folder = if body.ends_with(['/', '\\']) && !parts.is_empty() { "/" } else { "" };
    Ok(parts.join("/") + folder)
}

/// Globs one call may give once its lists are split: more is an argument error.
pub(super) const MAX_GLOBS: usize = 40;

/// `"a.ts,src/**,!x/**"` is three globs: agents write lists that way (batch E: 9 of 10 such
/// calls found no file, and 4 runs fell back to shell search). Commas inside `{a,b}` or `[,]`,
/// or escaped as `\,`, stay, and so does an item `names_path` says is a real path.
pub(super) fn split_list(raw: &str, names_path: impl Fn(&str) -> bool) -> Vec<&str> {
    if raw.contains(',') && names_path(raw.trim()) {
        return vec![raw.trim()];
    }
    let (mut parts, mut from, mut braces, mut class, mut escaped) = (Vec::new(), 0, 0usize, false, false);
    for (at, c) in raw.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '[' => class = true,
            ']' => class = false,
            '{' if !class => braces += 1,
            '}' if !class => braces = braces.saturating_sub(1),
            ',' if braces == 0 && !class => {
                parts.push(&raw[from..at]);
                from = at + 1;
            }
            _ => {}
        }
    }
    parts.push(&raw[from..]);
    parts.into_iter().map(str::trim).filter(|part| !part.is_empty()).collect()
}

/// Whether `item` (with a comma in it) names a file or folder in the project, so it is one glob.
/// Only a path `resolve_named` keeps in the project (no `..`, no symlink out, no root or drive)
/// counts: whether a path outside exists is none of the reply's business. A colon never does,
/// since on Windows `C:x,y` names a drive.
fn names_path(ctx: &Ctx, item: &str) -> bool {
    !item.contains(':') && named::resolve_named(ctx, item).is_ok_and(|(_, real)| real.starts_with(ctx.root) && real.symlink_metadata().is_ok())
}

fn one_glob(root: &Path, glob: &str) -> Result<Override, String> {
    let mut builder = OverrideBuilder::new(root);
    builder.add(glob).map_err(|error| format!("{glob}: {error}"))?;
    builder.build().map_err(|error| format!("{glob}: {error}"))
}

/// A file a glob names exactly, past the size a walk reads.
fn named_large(ctx: &Ctx, glob: &str, errors: &mut Vec<String>) -> Option<Arc<str>> {
    if glob.starts_with('!') || glob.contains(WILDCARDS) {
        return None;
    }
    // In scope first, so nothing is said about a file outside the project.
    let (_, target) = named::resolve_named(ctx, glob).ok()?;
    let metadata = std::fs::symlink_metadata(target).ok().filter(|metadata| metadata.is_file() && metadata.len() > crate::workspace::MAX_READ_BYTES)?;
    if metadata.len() > named::MAX_NAMED_BYTES {
        errors.push(format!("{glob}: larger than {} MiB, so not searched", named::MAX_NAMED_BYTES / (1024 * 1024)));
        return None;
    }
    Some(glob.into())
}

impl Globs {
    /// Each glob is compiled once, into one matcher; it is compiled alone again only to check a
    /// warning that it matches nothing.
    pub(super) fn new(ctx: &Ctx, raw: &[String]) -> Self {
        let (mut errors, mut positive, mut named) = (Vec::new(), Vec::new(), Vec::new());
        let mut builder = GitignoreBuilder::new(ctx.root);
        builder.allow_unclosed_class(false);
        let mut valid = 0;
        for glob in raw.iter().flat_map(|item| split_list(item, |item| names_path(ctx, item))) {
            let clean = match normalize(ctx, glob) {
                Ok(clean) => clean,
                Err(error) => {
                    errors.push(error);
                    continue;
                }
            };
            // A line that does not compile is not added.
            if let Err(error) = builder.add_line(None, &clean) {
                errors.push(format!("{glob}: {error}"));
                continue;
            }
            valid += 1;
            named.extend(named_large(ctx, &clean, &mut errors));
            if !clean.starts_with('!') {
                positive.push((glob.to_owned(), clean));
            }
        }
        // A filter that fails to build would search everywhere; with none, `all_failed` stops
        // the search.
        let filter = (valid > 0).then(|| builder.build()).and_then(|built| built.map_err(|error| errors.push(format!("glob: {error}"))).ok());
        Self { root: ctx.root.to_owned(), filter, positive, errors, named_large: named }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.filter.is_none()
    }

    /// Globs were given and none of them works: a search must not quietly run everywhere.
    pub(super) fn all_failed(&self) -> bool {
        self.filter.is_none() && !self.errors.is_empty()
    }

    /// Exactly `Override::matched` (the globs are its lines; a later one wins), keeping which
    /// glob decided.
    fn decide<'a>(filter: &'a Gitignore, path: &Path, is_dir: bool) -> Match<Option<&'a GitignoreGlob>> {
        match filter.matched(path, is_dir).invert() {
            Match::None if filter.num_ignores() > 0 && !is_dir => Match::Ignore(None),
            other => other.map(Some),
        }
    }

    /// Like rg -g: `!dir/` needs its directory tested, and a plain glob decides the file.
    pub(super) fn allows(&self, path: &str) -> bool {
        let Some(filter) = &self.filter else { return true };
        let path = Path::new(path);
        let excluded_dir = path.ancestors().skip(1).filter(|dir| !dir.as_os_str().is_empty()).any(|dir| Self::decide(filter, dir, true).is_ignore());
        !excluded_dir && !Self::decide(filter, path, false).is_ignore()
    }

    pub(super) fn files_in_scope(&self, snapshot: &Snapshot) -> usize {
        snapshot.walk.files.iter().filter(|file| self.allows(&file.path)).count() + self.named_large.len()
    }

    pub(super) fn warnings(&self, snapshot: &Snapshot) -> Vec<String> {
        let Some(filter) = &self.filter else { return Vec::new() };
        let paths = || snapshot.walk.files.iter().map(|file| &*file.path).chain(self.named_large.iter().map(|path| &**path));
        // A glob that decided some file matches one; one a later glob always overrode is
        // checked alone.
        let decided: HashSet<&str> = paths().filter_map(|path| match Self::decide(filter, Path::new(path), false) {
            Match::Whitelist(Some(glob)) => Some(glob.original()),
            _ => None,
        }).collect();
        let matches_alone = |clean: &str| one_glob(&self.root, clean).is_ok_and(|alone| paths().any(|path| alone.matched(path, false).is_whitelist()));
        self.positive.iter().filter(|(_, clean)| !decided.contains(clean.as_str()) && !matches_alone(clean)).map(|(glob, _)| format!("{glob} matches no searchable file")).collect()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_comma_list_is_split_outside_braces() {
        let split = |raw| super::split_list(raw, |_| false);
        assert_eq!(split("a.ts, src/**,!x/**"), ["a.ts", "src/**", "!x/**"]);
        assert_eq!(split("src/*.{ts,tsx},docs/**"), ["src/*.{ts,tsx}", "docs/**"]);
        assert_eq!(split("a{b,c"), ["a{b,c"]);
        assert_eq!(split(",,"), Vec::<&str>::new());
        assert_eq!(split(" , "), Vec::<&str>::new());
        // A class or an escaped comma is one glob; braces inside a class are plain characters.
        assert_eq!(split("data[,_]*.csv,b"), ["data[,_]*.csv", "b"]);
        assert_eq!(split("a\\,b.txt,c"), ["a\\,b.txt", "c"]);
        assert_eq!(split("[{]x,y"), ["[{]x", "y"]);
        // A real path is never split, whatever it holds.
        assert_eq!(super::split_list(" a,b.txt ", |item| item == "a,b.txt"), ["a,b.txt"]);
        assert_eq!(super::split_list("a,b.txt", |_| true), ["a,b.txt"]);
        assert_eq!(super::split_list("ab.txt", |_| panic!("only items with commas are looked up")), ["ab.txt"]);
    }

    #[test]
    fn empty_parts_are_skipped_before_stepping_back() {
        assert_eq!(super::without_dot_dot("x", "src//../f6/**").unwrap(), "f6/**");
        assert_eq!(super::without_dot_dot("x", "src/./a/../f6/**").unwrap(), "src/f6/**");
        assert!(super::without_dot_dot("x", "src//../../f6").is_err());
        assert_eq!(super::without_dot_dot("x", "src/../web/").unwrap(), "web/");
        assert_eq!(super::without_dot_dot("x", "src/../").unwrap(), "**");
        // `.` parts go; nothing left is the whole project.
        for (body, clean) in [(".", "**"), ("./.", "**"), ("src/.", "src"), ("src/./", "src/"), ("src/./*.rs", "src/*.rs"), ("src", "src"), ("src/", "src/")] {
            assert_eq!(super::without_dot_dot("x", body).unwrap(), clean, "{body}");
        }
    }
}
