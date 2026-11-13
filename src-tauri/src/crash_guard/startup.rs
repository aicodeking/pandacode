//! A desktop app whose setup fails (a corrupt database, an unwritable data folder) says why
//! and exits with status 1. Tauri would turn the setup error into a panic: the guard would take
//! it for a crash and relaunch into the same failure, and a macOS release build would end
//! without even the system's crash dialog. This is a deliberate exit: no report, no relaunch,
//! no crash history. `serve` does the same in `headless::startup_failed`, without a dialog.

/// The dialog's title, and the start of the line on stderr.
const TITLE: &str = "PandaCode could not start";
/// The first line of the Linux helpers' text, whose title some of them never show.
const LEAD: &str = "PandaCode could not start.";
/// The advice under the reason, followed by the data folder. Setup errors are plain text with
/// no kind to tell causes apart, so the advice is one that holds for every cause.
const ADVICE: &str = "If this keeps happening, check PandaCode's data folder:";

/// The raw error as a sentence: first letter capitalised, ending punctuation added if missing.
fn sentence(error: &str) -> String {
    let error = error.trim();
    let mut chars = error.chars();
    let Some(first) = chars.next() else { return String::new() };
    let end = if error.ends_with(['.', '!', '?']) { "" } else { "." };
    format!("{}{}{end}", first.to_uppercase(), chars.as_str())
}

/// The dialog's body under its title: the reason, then the advice with the data folder (the
/// user's own path, shown only to them). No advice when the folder is unknown.
fn body(error: &str, data_dir: Option<&std::path::Path>) -> String {
    let reason = sentence(error);
    match data_dir {
        Some(dir) => format!("{reason}\n\n{ADVICE}\n{}", dir.display()),
        None => reason,
    }
}

/// What a separate Linux program gets: the lead sentence and the reason, never the data folder
/// (its arguments are visible in `ps` to other local users and kept in notification history).
fn note(error: &str) -> String {
    format!("{LEAD}\n{}", sentence(error))
}

/// Prints the reason, announces the exit (the guard then relaunches nothing; a held crash
/// notice is kept for the next launch), then shows the body and the short note with `show`.
/// Returns the exit status.
fn fail(error: &str, data_dir: Option<&std::path::Path>, show: impl FnOnce(&str, &str), announce: impl FnOnce()) -> i32 {
    eprintln!("{TITLE}: {error}");
    // Before the dialog, which waits for the user: a logout or Force Quit meanwhile is not a crash.
    announce();
    show(&body(error, data_dir), &note(error));
    1
}

/// Never returns: the process exits with status 1 once the user closed the dialog.
pub fn desktop_startup_failed(error: &dyn std::fmt::Display) -> ! {
    std::process::exit(fail(&error.to_string(), super::app_data_dir().as_deref(), show_error, super::notify_exit))
}

/// A blocking native alert. Setup runs on the main thread, where the dialog plugin's
/// `blocking_show` must not be used (it waits for a dialog the main thread has to present);
/// rfd's synchronous dialog runs it right here instead.
#[cfg(not(target_os = "linux"))]
fn show_error(body: &str, _note: &str) {
    rfd::MessageDialog::new().set_level(rfd::MessageLevel::Error).set_title(TITLE).set_description(body).set_buttons(rfd::MessageButtons::Ok).show();
}

/// Linux: the body on stderr, plus a best-effort `note` (no data folder) from a separate
/// program, so someone who started PandaCode from the app menu sees why it closed. rfd's synchronous dialog there runs a nested
/// GTK loop from inside tao's own GTK event loop on the main thread, a known way to deadlock
/// (the process would then never exit), so no dialog of our own is shown. The program is
/// started detached and never waited for; a failure is ignored.
#[cfg(target_os = "linux")]
fn show_error(body: &str, note: &str) {
    eprintln!("{body}");
    let Some((program, args)) = notifier(note, |name| super::wrapper::system_program(name, is_executable)) else { return };
    let mut command = std::process::Command::new(program);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    super::spawn::detach(&mut command);
    let _ = command.spawn();
}

/// The first of `zenity`, `kdialog`, `notify-send` that `find` locates (an absolute path),
/// with its arguments. `body` is always one argument of its own, never passed through a shell.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn notifier(body: &str, find: impl Fn(&str) -> Option<std::path::PathBuf>) -> Option<(std::path::PathBuf, Vec<String>)> {
    let args = |name: &str| -> Vec<String> {
        match name {
            // Plain text: an error naming a path with `<` or `&` must not read as markup.
            "zenity" => vec!["--error".into(), "--no-markup".into(), format!("--title={TITLE}"), format!("--text={body}")],
            "kdialog" => vec!["--title".into(), TITLE.into(), "--error".into(), body.into()],
            _ => vec![TITLE.into(), body.into()],
        }
    };
    ["zenity", "kdialog", "notify-send"].into_iter().find_map(|name| Some((find(name).filter(|path| path.is_absolute())?, args(name))))
}

/// An executable file. The helpers are taken only from /usr/bin or /bin, as `xvfb-run` is
/// (`wrapper::system_program`): never from PATH, which whoever started PandaCode set.
#[cfg(target_os = "linux")]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn a_failed_setup_says_why_announces_the_exit_first_and_exits_with_1() {
        let steps = RefCell::new(Vec::new());
        let dir = std::path::Path::new("/data/ai.pandacode.desktop");
        let code = fail("the database is corrupt", Some(dir), |shown, note| steps.borrow_mut().extend([format!("show {shown}"), format!("note {note}")]), || steps.borrow_mut().push("exit".into()));
        assert_eq!(code, 1);
        assert_eq!(*steps.borrow(), [
            "exit",
            "show The database is corrupt.\n\nIf this keeps happening, check PandaCode's data folder:\n/data/ai.pandacode.desktop",
            // The Linux helpers' text: no data folder in another program's arguments.
            "note PandaCode could not start.\nThe database is corrupt.",
        ]);
    }

    #[test]
    fn the_body_never_repeats_the_title() {
        assert_eq!(body("a corrupt database", Some(std::path::Path::new("/data"))), "A corrupt database.\n\nIf this keeps happening, check PandaCode's data folder:\n/data");
        assert_eq!(body("a corrupt database", None), "A corrupt database.");
        for dir in [Some(std::path::Path::new("/data")), None] {
            let text = body("a corrupt database", dir);
            assert!(!text.contains(TITLE) && !text.contains(LEAD) && !text.contains("Update"), "{text}");
        }
    }

    #[test]
    fn the_reason_reads_as_a_sentence() {
        assert_eq!(sentence(" disk full "), "Disk full.");
        assert_eq!(sentence("Already done!"), "Already done!");
        assert_eq!(sentence("é: bad"), "É: bad.");
        assert_eq!(sentence(""), "");
    }

    #[test]
    fn the_linux_note_uses_the_first_program_found_with_the_text_as_one_argument() {
        use std::path::PathBuf;
        let body = "PandaCode could not start.\n<bad> & 'quoted' $(x)";
        let found = |names: &'static [&'static str]| move |name: &str| names.contains(&name).then(|| PathBuf::from(format!("/usr/bin/{name}")));
        let (program, args) = notifier(body, found(&["zenity", "kdialog", "notify-send"])).unwrap();
        assert_eq!(program, PathBuf::from("/usr/bin/zenity"));
        assert_eq!(args, ["--error".to_string(), "--no-markup".into(), format!("--title={TITLE}"), format!("--text={body}")]);
        let (program, args) = notifier(body, found(&["kdialog", "notify-send"])).unwrap();
        assert_eq!((program, args), (PathBuf::from("/usr/bin/kdialog"), vec!["--title".to_string(), TITLE.into(), "--error".into(), body.into()]));
        let (program, args) = notifier(body, found(&["notify-send"])).unwrap();
        assert_eq!((program, args), (PathBuf::from("/usr/bin/notify-send"), vec![TITLE.to_string(), body.into()]));
        assert_eq!(notifier(body, found(&[])), None);
        // Never a relative path.
        assert_eq!(notifier(body, |_| Some(PathBuf::from("zenity"))), None);
    }

    #[test]
    fn the_linux_note_programs_come_only_from_usr_bin_or_bin() {
        use std::path::{Path, PathBuf};
        let installed = |paths: &'static [&'static str]| move |name: &str| super::super::wrapper::system_program(name, |path| paths.iter().any(|p| Path::new(p) == path));
        // A zenity only in /usr/local/bin or ~/bin (anywhere on PATH) is never run.
        let (program, _) = notifier("x", installed(&["/usr/local/bin/zenity", "/home/u/bin/zenity", "/bin/kdialog"])).unwrap();
        assert_eq!(program, PathBuf::from("/bin/kdialog"));
        assert_eq!(notifier("x", installed(&["/usr/local/bin/zenity", "/opt/bin/notify-send"])), None);
    }
}
