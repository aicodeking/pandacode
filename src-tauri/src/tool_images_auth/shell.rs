//! Images a shell command created: a completed `Bash`/`Command`/`shell` record
//! whose command names a path as the *output* of an image-producing program
//! (`screencapture <path>`, `ffmpeg … <out>`, `sips … --out <path>`,
//! `magick`/`convert … <out>`, `rsvg-convert -o <path>`, `--screenshot[=]<path>`).
//! A stdout redirect to an image (`curl … > a.png`) counts too. Literal
//! variables (`D=/tmp/x; … $D/a.png`), a `for` loop's first item and `cd` are
//! followed as `shell-intent.ts` follows them (a relative output needs a known
//! absolute directory, see `resolve`), and every image a command writes
//! is listed, so the one a row shows (`ShellIntent.producedImage`) is among them;
//! `tests/fixtures/produced-images.json` holds the cases both sides must agree on.
//! A path only mentioned (an argument to `cat`, `ls`, `open`, an input file, a
//! line in a heredoc body) never counts, and neither does anything the command printed;
//! only a Python/Node script's own literal save (`script_images`) does.

use std::collections::HashMap;

use serde_json::Value;

use script_images::Bodies;

#[path = "script_images.rs"]
mod script_images;

/// Tool names (lowercase, after any `mcp__server__` prefix) of shell runners:
/// Claude/muse `Bash`/`bash`, Codex `Command`, Cursor `run_terminal_cmd`, Codex
/// app-server `exec_command`/`local_shell`.
const SHELL_TOOL_NAMES: [&str; 6] = ["bash", "command", "shell", "run_terminal_cmd", "exec_command", "local_shell"];
/// Title-named shell records (lowercase): Devin's `Ran ffmpeg, python3`, whose
/// plain-text input is the command's output, and Kimi's `Running: <command>…`.
const RAN_TITLE: &str = "ran ";
const RUNNING_TITLE: &str = "running:";
/// Input fields naming the directory a command ran in (Devin `workdir`).
const WORKDIR_FIELDS: [&str; 2] = ["workdir", "cwd"];
/// Codex's plain-text input ends with this line.
const WORKING_DIRECTORY: &str = "Working directory: ";
/// Commands longer than this are not parsed.
const COMMAND_LIMIT: usize = 16 * 1024;
/// A variable's value longer than this (after expansion) is treated as unknown,
/// so `A=$A$A` repeated cannot grow without bound.
const VALUE_LIMIT: usize = 4 * 1024;
/// Variables expand to at most this much text per command; past it, words keep
/// their `$NAME` and so name no image.
const EXPANDED_LIMIT: usize = 64 * 1024;
/// `bash -c '…'` inside `bash -c '…'` is unwrapped at most this many times.
const SHELL_NESTING: usize = 2;
/// Marker commands `split_commands` emits where a `( … )` subshell opens and closes.
const SUBSHELL_OPEN: &str = "(";
const SUBSHELL_CLOSE: &str = ")";
/// Marker commands `split_commands` emits for `&&` and `||`: a command after
/// `false &&` or `true ||` never runs.
const AND_LIST: &str = "&&";
const OR_LIST: &str = "||";
/// Commands that always succeed or always fail.
const ALWAYS_TRUE: [&str; 2] = ["true", ":"];
const ALWAYS_FALSE: &str = "false";
/// Prefix commands that run a later word as the program: (name, options that
/// take a value, positional words before the program).
const WRAPPERS: [(&str, &[&str], usize); 9] = [
    ("sudo", &["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"], 0),
    ("env", &["-u", "-C", "-S", "-P"], 0),
    ("timeout", &["-s", "-k", "--signal", "--kill-after"], 1),
    ("nice", &["-n", "--adjustment"], 0),
    ("caffeinate", &["-t", "-w"], 0),
    ("command", &[], 0),
    ("exec", &["-a"], 0),
    ("time", &[], 0),
    ("nohup", &[], 0),
];
/// ImageMagick subcommands whose last argument is an input, not an output.
const MAGICK_READERS: [&str; 2] = ["identify", "display"];
/// ffmpeg options that take a value, by name before any `:stream` specifier
/// (`-c:v`, `-q:v`). An option in neither list takes a value only when the next
/// word is plainly not a path or an option (`-update 1`, never `-x -i in.png`).
const FFMPEG_VALUED: [&str; 50] = [
    "-i", "-c", "-codec", "-vcodec", "-acodec", "-scodec", "-vf", "-af", "-filter", "-filter_complex", "-lavfi", "-ss", "-sseof", "-t",
    "-to", "-r", "-s", "-b", "-crf", "-preset", "-tune", "-profile", "-level", "-f", "-map", "-map_metadata", "-metadata", "-frames",
    "-vframes", "-aframes", "-pix_fmt", "-q", "-qscale", "-threads", "-loglevel", "-v", "-update", "-safe", "-aspect", "-ac", "-ar",
    "-g", "-movflags", "-vsync", "-fps_mode", "-itsoffset", "-framerate", "-video_size", "-start_number", "-stream_loop",
];
/// ffmpeg options known to take no value.
const FFMPEG_FLAGS: [&str; 14] = [
    "-y", "-n", "-hide_banner", "-nostdin", "-stats", "-nostats", "-an", "-vn", "-sn", "-dn", "-shortest", "-re", "-benchmark", "-copyts",
];
/// `sips` options that modify the image; without `--out` the input is rewritten.
const SIPS_MODIFIERS: [&str; 22] = [
    "-s", "--setProperty", "-d", "--deleteProperty", "-z", "--resampleHeightWidth", "-Z", "--resampleHeightWidthMax", "--resampleWidth",
    "--resampleHeight", "-r", "--rotate", "-f", "--flip", "-c", "--cropToHeightWidth", "-p", "--padToHeightWidth", "-e", "--embedProfile",
    "-m", "--matchTo",
];
/// Package runners that start a CLI (`npx playwright …`).
const RUNNERS: [&str; 3] = ["npx", "bunx", "pnpx"];
/// Extensions of images `tool_images` serves (anything else is never produced).
const SERVED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// Characters that make a path a pattern or an expansion rather than one file.
const NOT_LITERAL: [char; 6] = ['$', '`', '*', '?', '%', '{'];
/// Stands in for a `$` the shell does not expand (single-quoted or escaped)
/// until variables are replaced; it is a `$` again afterwards.
const QUOTED_DOLLAR: char = '\u{1}';
/// Characters that keep an assigned value from being known (`D=$(mktemp -d)`).
const UNKNOWN_VALUE: [char; 10] = ['$', '`', '*', '?', '(', ')', '{', '}', '[', ']'];
/// Words that start a compound command before its first simple command (`do ffmpeg …`).
const OPENERS: [&str; 9] = ["if", "then", "do", "else", "elif", "while", "until", "!", "{"];
/// Words that end a compound command or start one whose words are not a command.
const CLOSERS: [&str; 8] = ["done", "fi", "esac", "}", "for", "case", "select", "function"];
/// Builtins whose `NAME=value` words set variables (`export D=/tmp/x`).
const DECLARERS: [&str; 5] = ["export", "local", "declare", "typeset", "readonly"];

/// How a shell record's input names its command.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShellInput {
    /// JSON `command`/`cmd`, or the plain text itself (Codex `Command`).
    Any,
    /// JSON `command`/`cmd` only: plain text is the command's output (Devin `Ran …`).
    JsonOnly,
}

/// `lower` is a lowercase tool name; `Some` for a shell runner.
pub fn shell_tool(lower: &str) -> Option<ShellInput> {
    let lower = lower.trim();
    if lower.strip_prefix(RAN_TITLE).is_some_and(|rest| !rest.trim().is_empty()) {
        return Some(ShellInput::JsonOnly);
    }
    if lower.starts_with(RUNNING_TITLE) {
        return Some(ShellInput::Any);
    }
    let base = lower.rsplit("__").next().unwrap_or(lower).trim();
    SHELL_TOOL_NAMES.contains(&base).then_some(ShellInput::Any)
}

/// The image files a completed shell record's command wrote. A relative output
/// counts only under a known absolute directory: the record's working directory
/// (Codex `Working directory:`, input `workdir`/`cwd`) or a literal `cd /abs`.
pub fn image_outputs(input: &Value, kind: ShellInput, out: &mut Vec<String>) {
    let parsed;
    let input = match input.as_str().and_then(super::parse_nested) {
        Some(value) => {
            parsed = value;
            &parsed
        }
        None => input,
    };
    let (command, cwd) = match input {
        Value::Object(map) => {
            let cwd = WORKDIR_FIELDS.iter().find_map(|key| map.get(*key)?.as_str()).map(str::trim).filter(|dir| dir.starts_with('/'));
            (map.get("command").or_else(|| map.get("cmd")).cloned(), cwd.map(|dir| dir.trim_end_matches('/').to_owned()))
        }
        Value::String(text) if kind == ShellInput::Any => {
            let (script, cwd) = working_directory(text);
            (Some(Value::String(script.to_owned())), cwd)
        }
        _ => (None, None),
    };
    let shell = Shell { cwd: cwd.map(|dir| if dir.is_empty() { "/".to_owned() } else { dir }), ..Shell::default() };
    match command {
        Some(Value::String(script)) => script_outputs(&script, SHELL_NESTING, shell, out),
        Some(Value::Array(items)) => {
            let argv: Vec<String> = items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect();
            if argv.len() == items.len() {
                argv_outputs(&argv, SHELL_NESTING, &shell, out);
            }
        }
        _ => {}
    }
}

/// Codex's `/bin/zsh -lc "…"\nWorking directory: /repo`: the command and its
/// (absolute) directory.
fn working_directory(text: &str) -> (&str, Option<String>) {
    let trimmed = text.trim_end();
    let Some((script, last)) = trimmed.rsplit_once('\n') else { return (text, None) };
    match last.trim().strip_prefix(WORKING_DIRECTORY).map(str::trim) {
        Some(dir) if dir.starts_with('/') => (script.trim_end(), Some(dir.trim_end_matches('/').to_owned())),
        Some(_) => (script.trim_end(), None),
        None => (text, None),
    }
}

/// What the script knows while it runs: the directory, literal variables and
/// each `for` loop's first item, as `shell-intent.ts` tracks them.
#[derive(Clone, Default)]
struct Shell {
    cwd: Option<String>,
    vars: HashMap<String, String>,
    loops: HashMap<String, String>,
}

/// Walks a script's commands in order, following `cd`/`pushd`/`popd`, variables
/// and loops, and giving the directory back when a `( … )` subshell closes.
fn script_outputs(script: &str, depth: usize, shell: Shell, out: &mut Vec<String>) {
    if script.len() > COMMAND_LIMIT {
        return;
    }
    let (mut shell, mut saved) = (shell, Vec::new());
    // The last command's status when it is known (`true`, `false`), and whether
    // the next command is skipped by `false &&` / `true ||`.
    let (mut status, mut skip) = (None::<bool>, false);
    for argv in split_commands(script) {
        let marker = (argv.len() == 1).then(|| argv[0].as_str());
        if let Some(list @ (AND_LIST | OR_LIST)) = marker {
            skip = status == Some(list == OR_LIST);
            continue;
        }
        if std::mem::take(&mut skip) && !matches!(marker, Some(SUBSHELL_OPEN | SUBSHELL_CLOSE)) {
            continue;
        }
        status = known_status(&argv);
        match argv.first().map(String::as_str) {
            Some(SUBSHELL_OPEN) if argv.len() == 1 => saved.push(shell.cwd.clone()),
            Some(SUBSHELL_CLOSE) if argv.len() == 1 => shell.cwd = saved.pop().unwrap_or(shell.cwd),
            Some("done") => shell.loops.clear(),
            Some("for") => record_loop(&argv, &mut shell),
            _ => {
                let argv = expand_all(body_words(&argv), &shell);
                if record_assignments(&argv, &mut shell) {
                    continue;
                }
                match argv.first().map(String::as_str) {
                    Some("cd" | "pushd" | "popd") => shell.cwd = changed_directory(&argv, shell.cwd.take()),
                    Some(_) => argv_outputs(&argv, depth, &shell, out),
                    None => {}
                }
            }
        }
    }
}

/// `Some(true)` for `true`/`:`, `Some(false)` for `false`, else unknown.
fn known_status(argv: &[String]) -> Option<bool> {
    match argv {
        [only] if ALWAYS_TRUE.contains(&only.as_str()) => Some(true),
        [only] if only == ALWAYS_FALSE => Some(false),
        _ => None,
    }
}

/// `do ffmpeg …` → `ffmpeg …`; `fi`, `case …` → nothing.
fn body_words(argv: &[String]) -> &[String] {
    let start = argv.iter().position(|word| !OPENERS.contains(&word.as_str())).unwrap_or(argv.len());
    let words = &argv[start..];
    if words.first().is_some_and(|word| CLOSERS.contains(&word.as_str())) {
        return &[];
    }
    let end = words.iter().rposition(|word| word != "}").map_or(0, |at| at + 1);
    &words[..end]
}

/// `for t in 1 2 3`: `$t` reads as its first item; `for f in $(ls)` leaves it unknown.
fn record_loop(argv: &[String], shell: &mut Shell) {
    let Some(name) = argv.get(1).filter(|name| is_name(name)) else { return };
    let items: Vec<&String> = argv.iter().skip(3).filter(|item| *item != "do").collect();
    let first = items.first().filter(|_| argv.get(2).is_some_and(|word| word == "in"));
    match first {
        Some(first) if items.iter().all(|item| !item.contains(['$', '`', '(', QUOTED_DOLLAR])) => {
            shell.loops.insert(name.clone(), (*first).clone());
        }
        _ => {
            shell.loops.remove(name);
        }
    }
}

/// A command that only assigns (`D=/tmp/x`, `export A=1 B=2`) teaches the shell
/// its variables; true when the command was one.
fn record_assignments(argv: &[String], shell: &mut Shell) -> bool {
    let words = match argv.first() {
        Some(first) if DECLARERS.contains(&first.as_str()) => &argv[1..],
        _ => argv,
    };
    let pairs: Vec<(&str, &str)> = words.iter().filter(|word| !word.starts_with('-')).filter_map(|word| assignment(word)).collect();
    if words.is_empty() || pairs.len() != words.iter().filter(|word| !word.starts_with('-')).count() {
        return false;
    }
    for (name, value) in pairs {
        if value.is_empty() || value.len() > VALUE_LIMIT || value.contains(UNKNOWN_VALUE) {
            shell.vars.remove(name);
        } else {
            shell.vars.insert(name.to_owned(), value.to_owned());
        }
    }
    true
}

/// Every word expanded, within `EXPANDED_LIMIT` for the whole command.
fn expand_all(words: &[String], shell: &Shell) -> Vec<String> {
    let mut budget = EXPANDED_LIMIT;
    words
        .iter()
        .map(|word| {
            let expanded = expand_within(word, shell, budget.min(VALUE_LIMIT));
            budget = budget.saturating_sub(expanded.len());
            expanded
        })
        .collect()
}

/// `$NAME` and `${NAME}` replaced by known values (a loop's first item over a
/// variable); unknown ones stay, so the word is not a literal path. A word whose
/// substituted values would take it past `limit` keeps every `$NAME` (as if the
/// variables were unknown).
fn expand_within(word: &str, shell: &Shell, limit: usize) -> String {
    let mut expanded = String::with_capacity(word.len());
    let mut rest = word;
    while let Some(at) = rest.find('$') {
        expanded.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let (name, len) = match after.strip_prefix('{') {
            Some(braced) => match braced.find('}') {
                Some(end) if is_name(&braced[..end]) => (&braced[..end], end + 2),
                _ => ("", 0),
            },
            None => {
                let end = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
                let followed = after[end..].starts_with(['{', '[']);
                (if followed { "" } else { &after[..end] }, end)
            }
        };
        match shell.loops.get(name).or_else(|| shell.vars.get(name)).filter(|_| is_name(name)) {
            Some(value) if expanded.len() + value.len() > limit => return word.replace(QUOTED_DOLLAR, "$"),
            Some(value) => {
                expanded.push_str(value);
                rest = &after[len..];
            }
            None => {
                expanded.push('$');
                rest = after;
            }
        }
    }
    expanded.push_str(rest);
    expanded.replace(QUOTED_DOLLAR, "$")
}

fn is_name(word: &str) -> bool {
    !word.is_empty() && !word.starts_with(|c: char| c.is_ascii_digit()) && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The directory after `cd <target>` (`None` when it cannot be known), as
/// `shell-intent.ts` tracks it.
fn changed_directory(argv: &[String], cwd: Option<String>) -> Option<String> {
    let target = argv[1..].iter().find(|word| !word.starts_with('-') || *word == "-").map(String::as_str);
    match target {
        _ if argv[0] == "popd" => None,
        Some(target) if target == "-" || target.contains(NOT_LITERAL) => None,
        None | Some("~") => Some("~".to_owned()),
        Some(target) => {
            let joined = match cwd {
                Some(cwd) if !target.starts_with(['/', '~']) => format!("{cwd}/{target}"),
                _ => target.to_owned(),
            };
            let trimmed = joined.trim_end_matches('/');
            Some(if trimmed.is_empty() { "/".to_owned() } else { trimmed.to_owned() })
        }
    }
}

/// `path` as seen from `cwd`. A rooted path stays as given; a relative one is
/// joined to a known absolute directory (the record's own, or a literal `cd /abs`
/// before it) and is `None` otherwise: a Claude `Bash` record carries no
/// directory and the agent's cwd persists between calls, so `intro.jpg` may be
/// anywhere.
fn resolve(path: &str, cwd: Option<&str>) -> Option<String> {
    if path.starts_with(['/', '~']) {
        return Some(path.to_owned());
    }
    let cwd = cwd.filter(|dir| dir.starts_with('/'))?;
    let mut rest = path;
    while let Some(next) = rest.strip_prefix("./") {
        rest = next.trim_start_matches('/');
    }
    Some(match rest {
        "" | "." => cwd.to_owned(),
        _ => format!("{}/{rest}", cwd.trim_end_matches('/')),
    })
}

/// A literal path to an image type `tool_images` serves.
fn is_served_image(path: &str) -> bool {
    !path.contains(NOT_LITERAL)
        && path.rsplit_once('.').is_some_and(|(stem, ext)| {
            !stem.is_empty() && !stem.ends_with('/') && !ext.contains('/') && SERVED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
        })
}

/// A redirection word (`>`, `2>>`, `&>`, `>|`, `<`, `>&2`, `<<`) as (whether it
/// writes stdout to a file, the target glued to it); `None` for an ordinary word.
fn redirection(word: &str) -> Option<(bool, &str)> {
    if word.starts_with("<(") || word.starts_with(">(") {
        return None;
    }
    let rest = word.trim_start_matches(|c: char| c.is_ascii_digit());
    let fd = &word[..word.len() - rest.len()];
    let (both, rest) = match rest.strip_prefix('&') {
        Some(after) if after.starts_with('>') => (true, after),
        _ => (false, rest),
    };
    if let Some(input) = rest.strip_prefix('<') {
        return Some((false, input.trim_start_matches(['<', '&', '>'])));
    }
    let target = rest.strip_prefix('>')?;
    let target = target.strip_prefix(['>', '|']).unwrap_or(target);
    match target.strip_prefix('&') {
        // `>&2`, `2>&1`: a descriptor, not a file.
        Some(descriptor) => Some((false, if descriptor.is_empty() { "-" } else { descriptor })),
        None => Some((both || fd.is_empty() || fd == "1", target)),
    }
}

/// The words of one simple command without redirections (an operator standing
/// alone takes its target with it), and the files its stdout is redirected to.
fn without_redirections(argv: &[String]) -> (Vec<&str>, Vec<&str>) {
    let (mut words, mut written) = (Vec::new(), Vec::new());
    let mut iter = argv.iter().map(String::as_str);
    while let Some(word) = iter.next() {
        match redirection(word) {
            None => words.push(word),
            Some((stdout, glued)) => {
                let target = if glued.is_empty() { iter.next() } else { Some(glued) };
                if let Some(target) = target.filter(|target| stdout && !target.starts_with("/dev/")) {
                    written.push(target);
                }
            }
        }
    }
    (words, written)
}

fn program_name(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn is_assignment(word: &str) -> bool {
    assignment(word).is_some()
}

/// `NAME=value` as (name, value).
fn assignment(word: &str) -> Option<(&str, &str)> {
    word.split_once('=').filter(|(name, _)| is_name(name))
}

/// Skips options (with their values, per `value_options`) from `at`.
fn skip_options(words: &[&str], mut at: usize, value_options: &[&str]) -> usize {
    while let Some(word) = words.get(at).filter(|word| word.len() > 1 && word.starts_with('-')) {
        at += if *word == "--" {
            return at + 1;
        } else if value_options.contains(word) {
            2
        } else {
            1
        };
    }
    at
}

/// Index of the program after assignments and wrappers (`sudo -u me`, `timeout 5`).
fn program_start(words: &[&str]) -> usize {
    let mut at = 0;
    while let Some(word) = words.get(at) {
        if is_assignment(word) {
            at += 1;
        } else if let Some((_, values, positionals)) = WRAPPERS.iter().find(|(name, ..)| *name == program_name(word)) {
            at = skip_options(words, at + 1, values) + positionals;
        } else {
            break;
        }
    }
    at
}

fn argv_outputs(argv: &[String], depth: usize, shell: &Shell, out: &mut Vec<String>) {
    let (words, written) = without_redirections(argv);
    let scripted;
    let mut found = Vec::new();
    if let Some((program, args)) = words[program_start(&words).min(words.len())..].split_first() {
        let program = program_name(program);
        if matches!(program, "sh" | "bash" | "zsh") {
            let flag = args.iter().position(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg.contains('c'));
            if let Some(script) = flag.and_then(|at| args.get(at + 1)).filter(|_| depth > 0) {
                script_outputs(script, depth - 1, shell.clone(), out);
            }
            return;
        }
        for (at, arg) in args.iter().enumerate() {
            if let Some(path) = arg.strip_prefix("--screenshot=") {
                found.push(path);
            } else if *arg == "--screenshot" {
                found.extend(args.get(at + 1));
            }
        }
        scripted = script_images::written(program, args, &Bodies::of(argv));
        found.extend(scripted.iter().map(String::as_str));
        found.extend(program_outputs(program, args));
    }
    found.extend(written);
    for path in found.into_iter().filter(|path| is_served_image(path)).filter_map(|path| resolve(path, shell.cwd.as_deref())) {
        if !out.contains(&path) {
            out.push(path);
        }
    }
}

/// The files one image-producing program writes, before any `cd` is applied.
fn program_outputs<'a>(program: &str, args: &[&'a str]) -> Vec<&'a str> {
    let last = || args.last().copied().filter(|arg| !arg.starts_with('-')).into_iter().collect();
    match program {
        "screencapture" => last(),
        "xcrun" if args.first() == Some(&"simctl") => program_outputs("simctl", &args[1..]),
        "simctl" if args.contains(&"io") && args.contains(&"screenshot") => last(),
        "ffmpeg" => ffmpeg_outputs(args),
        "magick" if args.first() == Some(&"mogrify") => program_outputs("mogrify", &args[1..]),
        // `mogrify` rewrites every file it is given.
        "mogrify" => args.iter().copied().filter(|arg| !arg.starts_with('-')).collect(),
        "curl" => option_value(args, &["-o", "--output"]).into_iter().collect(),
        "magick" | "convert" if args.len() >= 2 && !MAGICK_READERS.contains(&args[0]) => last(),
        "sips" => match option_value(args, &["--out", "-o"]) {
            Some(out) => vec![out],
            None => sips_in_place(args),
        },
        "rsvg-convert" => option_value(args, &["--output", "-o"]).into_iter().collect(),
        "playwright" if args.first() == Some(&"screenshot") => last(),
        _ if RUNNERS.contains(&program) => {
            let at = skip_options(args, 0, &["-p", "--package"]);
            args.get(at).map(|cli| program_outputs(program_name(cli), &args[at + 1..])).unwrap_or_default()
        }
        "pnpm" | "yarn" => {
            let at = usize::from(matches!(args.first(), Some(&"exec" | &"dlx")));
            args.get(at).map(|cli| program_outputs(program_name(cli), &args[at + 1..])).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// ffmpeg's output files: words that are neither an option, an option's value
/// nor an `-i` input.
fn ffmpeg_outputs<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let (mut at, mut outputs) = (0, Vec::new());
    while let Some(arg) = args.get(at) {
        if arg.len() > 1 && arg.starts_with('-') {
            at += 1 + usize::from(ffmpeg_takes_value(arg, args.get(at + 1).copied()));
        } else {
            outputs.push(*arg);
            at += 1;
        }
    }
    outputs
}

/// Whether ffmpeg option `option` consumes `next` as its value.
fn ffmpeg_takes_value(option: &str, next: Option<&str>) -> bool {
    let name = option.split_once(':').map_or(option, |(name, _)| name);
    if FFMPEG_VALUED.contains(&name) {
        return true;
    }
    !FFMPEG_FLAGS.contains(&name) && next.is_some_and(|next| !next.starts_with('-') && !next.contains(['/', '.']))
}

/// `sips -Z 100 a.png b.png` rewrites both files; `sips -g pixelWidth a.png` only
/// reads it. Every image-named word counts (options take one or two values).
fn sips_in_place<'a>(args: &[&'a str]) -> Vec<&'a str> {
    if !args.iter().any(|arg| SIPS_MODIFIERS.contains(arg)) {
        return Vec::new();
    }
    args.iter().copied().filter(|arg| !arg.starts_with('-')).collect()
}

/// The value of the first `names` option, spelled `-o path`, `--out path` or `--out=path`.
fn option_value<'a>(args: &[&'a str], names: &[&str]) -> Option<&'a str> {
    args.iter().enumerate().find_map(|(at, arg)| {
        if names.contains(arg) {
            return args.get(at + 1).copied();
        }
        names.iter().filter(|name| name.starts_with("--")).find_map(|name| arg.strip_prefix(*name).and_then(|rest| rest.strip_prefix('=')))
    })
}

/// Splits a script into simple commands of unquoted words. `;`, `&`, `|`,
/// newlines and parentheses end a command (a parenthesis also stands alone as
/// a `SUBSHELL_OPEN`/`SUBSHELL_CLOSE` marker, `&&` and `||` as `AND_LIST`/`OR_LIST`); quotes and backslashes are honoured,
/// `$( … )` and backticks stay inside their word, a heredoc body replaces its tag
/// word after `<<` (unexpanded, for `script_images`) and
/// `#` starts a comment. A `$` the shell would not expand becomes `QUOTED_DOLLAR`.
/// Not a full shell parser: anything unusual simply yields words that no rule
/// above accepts.
fn split_commands(script: &str) -> Vec<Vec<String>> {
    let mut lexer = Lexer {
        chars: script.chars().peekable(),
        commands: Vec::new(),
        words: Vec::new(),
        word: String::new(),
        in_word: false,
        heredocs: Vec::new(),
    };
    while let Some(c) = lexer.chars.next() {
        lexer.step(c);
    }
    lexer.end_command();
    lexer.commands.retain(|words| !words.is_empty());
    lexer.commands
}

struct Lexer<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
    commands: Vec<Vec<String>>,
    words: Vec<String>,
    word: String,
    in_word: bool,
    /// Heredocs whose bodies start after the current line: the delimiter and
    /// where its tag word sits (command index, word index).
    heredocs: Vec<(String, usize, usize)>,
}

impl Lexer<'_> {
    fn step(&mut self, c: char) {
        match c {
            '\'' => {
                self.in_word = true;
                let quoted: String = self.chars.by_ref().take_while(|&c| c != '\'').collect();
                self.word.push_str(&quoted.replace('$', &QUOTED_DOLLAR.to_string()));
            }
            '"' => self.double_quoted(),
            '\\' => match self.chars.next() {
                Some('\n') | None => {}
                Some(next) => {
                    self.in_word = true;
                    self.word.push(if next == '$' { QUOTED_DOLLAR } else { next });
                }
            },
            '$' if self.chars.peek() == Some(&'(') => {
                self.in_word = true;
                self.word.push('$');
                self.balanced();
            }
            '`' => {
                self.in_word = true;
                self.word.push('`');
                self.word.extend(self.chars.by_ref().take_while(|&c| c != '`'));
                self.word.push('`');
            }
            '<' if self.chars.peek() == Some(&'<') => self.heredoc(),
            // Process substitution, `<( … )` or `>( … )`: one word.
            '<' | '>' if self.chars.peek() == Some(&'(') && !self.in_word => {
                self.in_word = true;
                self.word.push(c);
                self.balanced();
            }
            '#' if !self.in_word => {
                self.chars.by_ref().find(|&c| c == '\n');
                self.end_line();
            }
            // `2>&1` keeps its `&`, `&>` and `>|` are redirections.
            '&' | '|' if self.word.ends_with('>') => self.word.push(c),
            '&' if self.chars.peek() == Some(&'>') => {
                self.in_word = true;
                self.word.push(c);
            }
            '&' | '|' if self.chars.peek() == Some(&c) => {
                self.chars.next();
                self.end_command();
                self.commands.push(vec![if c == '&' { AND_LIST } else { OR_LIST }.to_owned()]);
            }
            '\n' => self.end_line(),
            ';' | '&' | '|' => self.end_command(),
            '(' | ')' => {
                self.end_command();
                self.commands.push(vec![c.to_string()]);
            }
            c if c.is_whitespace() => self.end_word(),
            _ => {
                self.in_word = true;
                self.word.push(c);
            }
        }
    }

    fn double_quoted(&mut self) {
        self.in_word = true;
        while let Some(c) = self.chars.next() {
            match c {
                '"' => break,
                '$' if self.chars.peek() == Some(&'(') => {
                    self.word.push('$');
                    self.balanced();
                }
                '\\' if self.chars.peek() == Some(&'$') => {
                    self.chars.next();
                    self.word.push(QUOTED_DOLLAR);
                }
                '\\' if matches!(self.chars.peek(), Some('"' | '\\' | '`')) => self.word.extend(self.chars.next()),
                '\\' if self.chars.peek() == Some(&'\n') => {
                    self.chars.next();
                }
                _ => self.word.push(c),
            }
        }
    }

    /// The rest of a `$( … )` (the next character is its `(`), kept in the word;
    /// quotes inside it do not end it or the string around it.
    fn balanced(&mut self) {
        let mut depth = 0usize;
        while let Some(c) = self.chars.next() {
            self.word.push(c);
            match c {
                '\'' | '"' => {
                    while let Some(inner) = self.chars.next() {
                        self.word.push(inner);
                        if inner == '\\' && c == '"' {
                            self.word.extend(self.chars.next());
                        } else if inner == c {
                            break;
                        }
                    }
                }
                '\\' => self.word.extend(self.chars.next()),
                '(' => depth += 1,
                ')' if depth <= 1 => return,
                ')' => depth -= 1,
                _ => {}
            }
        }
    }

    /// `<<TAG`, `<<-'TAG'` (the first `<` is consumed): the body after this line
    /// is read in place of the tag. `<<<` is a here-string, a redirection like `<`.
    fn heredoc(&mut self) {
        self.chars.next();
        self.end_word();
        if self.chars.next_if_eq(&'<').is_some() {
            self.words.push("<<<".to_owned());
            return;
        }
        self.chars.next_if_eq(&'-');
        while self.chars.next_if(|c| *c == ' ' || *c == '\t').is_some() {}
        let mut tag = String::new();
        while let Some(c) = self.chars.next_if(|c| !c.is_whitespace() && !matches!(c, ';' | '&' | '|' | '<' | '>' | '(' | ')')) {
            if !matches!(c, '\'' | '"' | '\\') {
                tag.push(c);
            }
        }
        self.words.push("<<".to_owned());
        self.words.push(tag.clone());
        self.heredocs.push((tag, self.commands.len(), self.words.len() - 1));
    }

    fn end_word(&mut self) {
        if std::mem::take(&mut self.in_word) {
            self.words.push(std::mem::take(&mut self.word));
        }
    }

    fn end_command(&mut self) {
        self.end_word();
        self.commands.push(std::mem::take(&mut self.words));
    }

    /// The end of a line: the command ends and any heredoc bodies are read. A
    /// body stands in for its tag word, its `$` unexpanded (a redirection target,
    /// so no rule but `script_images` reads it).
    fn end_line(&mut self) {
        self.end_command();
        for (tag, command, word) in std::mem::take(&mut self.heredocs) {
            let mut body = Vec::new();
            loop {
                let line: String = self.chars.by_ref().take_while(|&c| c != '\n').collect();
                if line.trim() == tag {
                    break;
                }
                body.push(line);
                if self.chars.peek().is_none() {
                    break;
                }
            }
            if let Some(slot) = self.commands.get_mut(command).and_then(|words| words.get_mut(word)) {
                *slot = body.join("\n").replace('$', &QUOTED_DOLLAR.to_string());
            }
        }
    }
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;
