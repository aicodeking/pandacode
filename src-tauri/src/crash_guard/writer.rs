//! The app's write end of the guard pipe. Sends never block the caller: on Unix the fd is
//! non-blocking (lines are under PIPE_BUF, so a write is whole or EAGAIN); on Windows, where
//! anonymous pipes are blocking, a writer thread drains a bounded queue. A full pipe or queue
//! (a stuck guard) drops the line; a closed one reports the guard gone.

use std::io::Write;
use std::process::ChildStdin;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    /// The guard is not reading fast enough: the line was dropped.
    Full,
    /// The guard is gone.
    Broken,
}

#[cfg(unix)]
pub struct Writer {
    stdin: ChildStdin,
}

#[cfg(unix)]
impl Writer {
    pub fn new(stdin: ChildStdin) -> Self {
        use std::os::fd::AsRawFd;
        let fd = stdin.as_raw_fd();
        // SAFETY: fcntl on an fd this process owns.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                eprintln!("Crash guard pipe stays blocking: {}", std::io::Error::last_os_error());
            }
        }
        Self { stdin }
    }

    pub fn fd(&self) -> i32 {
        use std::os::fd::AsRawFd;
        self.stdin.as_raw_fd()
    }

    pub fn send(&mut self, line: &[u8]) -> Result<(), SendError> {
        match self.stdin.write(line) {
            Ok(n) if n == line.len() => Ok(()),
            // Under PIPE_BUF a short write cannot happen; treat one as a lost line.
            Ok(_) => Err(SendError::Full),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Err(SendError::Full),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => self.send(line),
            Err(_) => Err(SendError::Broken),
        }
    }
}

/// Lines queued for the Windows writer thread; beyond this a stuck guard loses lines.
#[cfg(windows)]
const QUEUE: usize = 256;

#[cfg(windows)]
pub struct Writer {
    queue: std::sync::mpsc::SyncSender<Vec<u8>>,
}

#[cfg(windows)]
impl Writer {
    pub fn new(mut stdin: ChildStdin) -> Self {
        let (queue, lines) = std::sync::mpsc::sync_channel::<Vec<u8>>(QUEUE);
        let spawned = std::thread::Builder::new().name("crash-guard-pipe".into()).spawn(move || {
            // Ends (dropping the receiver, so sends report Broken) when the guard is gone.
            while let Ok(line) = lines.recv() {
                if stdin.write_all(&line).is_err() {
                    break;
                }
            }
        });
        if let Err(error) = spawned {
            eprintln!("Crash guard pipe thread did not start: {error}");
        }
        Self { queue }
    }

    pub fn send(&mut self, line: &[u8]) -> Result<(), SendError> {
        match self.queue.try_send(line.to_vec()) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::TrySendError::Full(_)) => Err(SendError::Full),
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => Err(SendError::Broken),
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub struct Writer {
    stdin: ChildStdin,
}

#[cfg(not(any(unix, windows)))]
impl Writer {
    pub fn new(stdin: ChildStdin) -> Self {
        Self { stdin }
    }

    pub fn send(&mut self, line: &[u8]) -> Result<(), SendError> {
        self.stdin.write_all(line).map_err(|_| SendError::Broken)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::process::{Command, Stdio};

    const NAME: &str = "crash_guard::writer::tests::a_stuck_reader_drops_lines_and_a_dead_one_reports_broken";
    const ALONE_ENV: &str = "PANDACODE_CRASH_GUARD_TEST_WRITER_ALONE";

    /// The reader is a pipe end this test closes itself, in a re-run of this binary that runs
    /// nothing else, so no other process can hold it when the last send expects `Broken`. A
    /// killed child's fds can close a few ms after `wait` returns, and a child spawned by
    /// another test thread holds every fd of this process until its exec finishes; either
    /// one keeps the read end open, and the send sees a full pipe instead of a broken one.
    #[test]
    fn a_stuck_reader_drops_lines_and_a_dead_one_reports_broken() {
        if std::env::var_os(ALONE_ENV).is_none() {
            let run = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", NAME, "--test-threads=1", "-q"])
                .env(ALONE_ENV, "1")
                .stdin(Stdio::null())
                .output()
                .unwrap();
            assert!(run.status.success(), "the lone run failed:\n{}", String::from_utf8_lossy(&run.stdout));
            return;
        }
        let mut fds = [0; 2];
        // SAFETY: pipe(2) into a two-int array; both fds are owned right below.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0, "pipe: {}", std::io::Error::last_os_error());
        // SAFETY: fresh fds that nothing else owns.
        let (reader, write_end) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        let mut writer = Writer::new(ChildStdin::from(write_end));
        // Nobody reads: the pipe fills, then sends drop instead of blocking.
        let line = [b'x'; 256];
        let results: Vec<_> = (0..2_000).map(|_| writer.send(&line)).collect();
        assert!(results.contains(&Err(SendError::Full)));
        drop(reader);
        assert_eq!(writer.send(b"ping\n"), Err(SendError::Broken));
    }
}
