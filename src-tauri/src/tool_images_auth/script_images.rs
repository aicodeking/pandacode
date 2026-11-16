//! Images an inline script writes: `node -e`, `node <<EOF`, `python3 -c`,
//! `python3 - <<EOF`, `deno`, `bun`, `tsx`, `ts-node` scripts whose code saves a
//! literal image path with Playwright/Puppeteer `.screenshot({ path: 'x.png' })`
//! or `.screenshot(path="x.png")`, PIL `.save('x.png')` or matplotlib
//! `savefig('x.png')`. Mirrors `scriptImage` in `src/shell-intent-scripts.ts`
//! (the same pattern, the same script text) so `tool_image` authorizes the path
//! a row shows; `tests/fixtures/produced-images.json` holds the shared cases.
//! A path built from a variable or an expression (`dir + '/x.png'`, `save(f)`,
//! `f'{name}.png'`, a `$D` the shell does not expand) never counts.

use std::sync::LazyLock;

use regex::Regex;

use super::{is_served_image, program_name};

/// Script text past this many characters is not scanned (as `MAX_SCRIPT`).
const MAX_SCRIPT: usize = 20_000;
/// `npx tsx -e …` inside `uv run …` is unwrapped at most this many times.
const WRAPPER_NESTING: usize = 4;
/// Options of a script program that take a value, so it is not the script file.
const SCRIPT_VALUED: [&str; 7] = ["-m", "-W", "-X", "-r", "--require", "--import", "--loader"];
/// Package-manager options that take a value, before the subcommand.
const MANAGER_VALUED: [&str; 8] = ["--prefix", "-C", "--dir", "--filter", "-F", "-w", "--workspace", "--cwd"];
/// Package-manager subcommands that run a CLI (`pnpm exec tsx -e …`).
const MANAGER_RUNS: [&str; 3] = ["exec", "dlx", "x"];
/// `uv run` options that take a value.
const UV_VALUED: [&str; 10] = ["--with", "--python", "-p", "--project", "--directory", "--from", "--package", "--env-file", "--extra", "--group"];
/// Extensions of a script file `bun` runs directly (`bun shot.ts -e …`).
const SCRIPT_EXTENSIONS: [&str; 12] = [".js", ".jsx", ".ts", ".tsx", ".cjs", ".cjsx", ".cts", ".ctsx", ".mjs", ".mjsx", ".mts", ".mtsx"];

/// `IMAGE_SAVES` in shell-intent-scripts.ts, with the quote backreference spelled
/// out per quote (the path excludes every quote, so it is the same language).
/// Groups 1–3 are a screenshot path, 4–5 a `save`/`savefig` path.
static IMAGE_SAVES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"\.screenshot\(\s*\{?[^()\n]{0,200}?(?-u:\b)path\s*[:=]\s*"#,
        r#"(?:'([^'"`\n$]{1,300})'|"([^'"`\n$]{1,300})"|`([^'"`\n$]{1,300})`)"#,
        r#"|(?:\.save|(?-u:\b)savefig)\(\s*(?:'([^'"\n]{1,300})'|"([^'"\n]{1,300})")"#,
    ))
    .expect("IMAGE_SAVES compiles")
});

/// The heredoc bodies (`<<` and its body word, as the lexer leaves them) and
/// here-strings (`<<<` and its word) of one simple command.
#[derive(Default)]
pub(super) struct Bodies<'a> {
    heredocs: Vec<&'a str>,
    herestrings: Vec<&'a str>,
}

impl<'a> Bodies<'a> {
    pub(super) fn of(argv: &'a [String]) -> Self {
        let mut bodies = Self::default();
        for pair in argv.windows(2) {
            match pair[0].as_str() {
                "<<" => bodies.heredocs.push(&pair[1]),
                "<<<" => bodies.herestrings.push(&pair[1]),
                _ => {}
            }
        }
        bodies
    }
}

/// The literal image paths the inline script of `program args` saves, before
/// any directory is applied.
pub(super) fn written(program: &str, args: &[&str], bodies: &Bodies) -> Vec<String> {
    let Some(text) = script_text(program, args, bodies, WRAPPER_NESTING) else { return Vec::new() };
    let bounded = text.char_indices().nth(MAX_SCRIPT).map_or(text.as_str(), |(at, _)| &text[..at]);
    let mut found: Vec<String> = Vec::new();
    for captures in IMAGE_SAVES.captures_iter(bounded) {
        let Some(path) = (1..=5).find_map(|group| captures.get(group)).map(|path| path.as_str()) else { continue };
        if is_served_image(path) && !found.iter().any(|seen| seen == path) {
            found.push(path.to_owned());
        }
    }
    found
}

/// The script text a program runs inline, through the wrappers `shell-intent-dev.ts`
/// follows; `None` for a program that is not a script runner (or a test run, a
/// `-m` module, a script file).
fn script_text(program: &str, args: &[&str], bodies: &Bodies, depth: usize) -> Option<String> {
    let rerun = |words: &[&str]| -> Option<String> {
        let (cli, rest) = words.split_first()?;
        script_text(program_name(cli), rest, bodies, depth.checked_sub(1)?)
    };
    match program {
        "node" if args.contains(&"--test") => None,
        "node" | "tsx" | "ts-node" => inline(args, bodies),
        "deno" => match args.first() {
            Some(&"test") => None,
            Some(&"run") => inline(&args[1..], bodies),
            _ => inline(args, bodies),
        },
        _ if is_python(program) => if flag_value(args, "-m").is_some() { None } else { inline(args, bodies) },
        "npx" | "bunx" | "pnpx" => {
            let dropped = |at: usize, arg: &str| matches!(arg, "-y" | "--yes") || (at == 0 && is_flag(arg));
            let words: Vec<&str> = args.iter().enumerate().filter(|(at, arg)| !dropped(*at, arg)).map(|(_, arg)| *arg).collect();
            rerun(&words)
        }
        "npm" | "pnpm" | "yarn" | "bun" => {
            let sub = *positionals(args, &MANAGER_VALUED).first()?;
            let after = &args[args.iter().position(|arg| *arg == sub)? + 1..];
            if MANAGER_RUNS.contains(&sub) {
                rerun(after)
            } else if program == "bun" && (sub.contains('/') || SCRIPT_EXTENSIONS.iter().any(|ext| sub.ends_with(ext))) {
                inline(args, bodies)
            } else {
                None
            }
        }
        "uvx" => rerun(from_command(args)?),
        "uv" => {
            let found = positionals(args, &UV_VALUED);
            let after = &args[args.iter().position(|arg| Some(arg) == found.first())? + 1..];
            let run_args = match (found.first(), found.get(1)) {
                (Some(&"run"), _) => after,
                (Some(&"tool"), Some(&"run")) => &after[after.iter().position(|arg| *arg == "run")? + 1..],
                _ => return None,
            };
            rerun(from_command(run_args)?)
        }
        _ => None,
    }
}

/// `args` from their first positional (the command `uv run` starts).
fn from_command<'a, 'b>(args: &'b [&'a str]) -> Option<&'b [&'a str]> {
    let command = *positionals(args, &UV_VALUED).first()?;
    Some(&args[args.iter().position(|arg| *arg == command)?..])
}

/// `script()` in shell-intent-dev.ts: inline when a code flag, `-` or a heredoc is
/// given; a script file run without one has no inline text. The text is the
/// heredoc and here-string bodies, then every code flag's value.
fn inline(args: &[&str], bodies: &Bodies) -> Option<String> {
    let inline = args.iter().any(|arg| is_inline_flag(arg)) || args.contains(&"-") || !bodies.heredocs.is_empty();
    if !inline && !positionals(args, &SCRIPT_VALUED).is_empty() {
        return None;
    }
    let values = args.iter().enumerate().filter(|(_, arg)| is_code_flag(arg)).filter_map(|(at, _)| args.get(at + 1).copied());
    let parts: Vec<&str> = bodies.heredocs.iter().chain(&bodies.herestrings).copied().chain(values).filter(|part| !part.is_empty()).collect();
    Some(parts.join("\n"))
}

/// `-c`, `--eval`, `--print`, or a bundle ending in `e`/`p` (`-pe`, `-ne`): the script is inline.
fn is_inline_flag(arg: &str) -> bool {
    matches!(arg, "-c" | "--eval" | "--print")
        || arg.strip_prefix('-').is_some_and(|rest| rest.ends_with(['e', 'p']) && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// A flag whose value is script code: `-c`, `-e`, `-p`, `--eval`, `--print`, `-pe`.
fn is_code_flag(arg: &str) -> bool {
    matches!(arg, "-c" | "-p" | "--eval" | "--print")
        || arg.strip_prefix('-').is_some_and(|rest| rest.ends_with('e') && rest.chars().all(|c| c.is_ascii_lowercase()))
}

/// `python`, `python3`, `python3.12`.
fn is_python(program: &str) -> bool {
    program.strip_prefix("python").is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

fn is_flag(arg: &str) -> bool {
    arg.len() > 1 && arg.starts_with('-')
}

/// The word after `name`, before any `--`.
fn flag_value<'a>(args: &[&'a str], name: &str) -> Option<&'a str> {
    let end = args.iter().position(|arg| *arg == "--").unwrap_or(args.len());
    args[..end].iter().position(|arg| *arg == name).and_then(|at| args.get(at + 1).copied())
}

/// Words that are not flags (nor the values of `valued` flags); everything after `--`.
fn positionals<'a>(args: &[&'a str], valued: &[&str]) -> Vec<&'a str> {
    let (mut out, mut at) = (Vec::new(), 0);
    while let Some(arg) = args.get(at) {
        if *arg == "--" {
            out.extend_from_slice(&args[at + 1..]);
            break;
        }
        if is_flag(arg) {
            at += usize::from(valued.contains(arg));
        } else {
            out.push(*arg);
        }
        at += 1;
    }
    out
}
