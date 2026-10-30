//! Project-scoped file tools plus an explicitly approved, cancellable shell.
use super::*;

fn spec(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}
pub(super) fn host(config: &RunConfig, upstream: Option<ToolHost>) -> Result<ToolHost, String> {
    let root = config
        .cwd
        .canonicalize()
        .map_err(|_| "The task's project folder is unavailable.")?;
    let text = json!({"type":"string"});
    let mut tools = vec![
        spec("read_skill_file", "Read an enabled skill's instructions or supporting text file. Use the skill ID from the enabled skills list; path is relative to its folder, such as SKILL.md or references/guide.md.", json!({"skill":text,"path":text}), &["skill","path"]),
        spec("read_file", "Read a UTF-8 file in the project (up to 128 KiB). Paths are project-relative.", json!({"path":text}), &["path"]),
        spec("list_files", "List one directory in the project. Use '.' for the project root.", json!({"path":text}), &["path"]),
        spec("write_file", "Create or replace a project file. Read existing files before replacing them.", json!({"path":text,"content":text}), &["path","content"]),
        spec("edit_file", "Replace exactly one occurrence of old_text in a project file. Fails if it is missing or ambiguous.", json!({"path":text,"old_text":text,"new_text":text}), &["path","old_text","new_text"]),
        spec("run_command", "Run a shell command from the project folder, with a 60-second timeout and bounded output. Requires approval except in Full access. Not available in Plan mode.", json!({"command":text}), &["command"]),
    ];
    let mut approval_tools = HashSet::from([
        "write_file".into(),
        "edit_file".into(),
        "run_command".into(),
    ]);
    if config.mode == "auto" {
        approval_tools.remove("write_file");
        approval_tools.remove("edit_file");
    }
    if let Some(host) = &upstream {
        tools.extend(host.tools.clone());
        approval_tools.extend(host.approval_tools.clone());
    }
    Ok(ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let root = root.clone();
            let upstream = upstream.clone();
            Box::pin(async move {
                if name == "read_skill_file" {
                    let content = crate::skills::direct::library()?.direct_file(
                        &root,
                        string(&args, "skill", 200)?,
                        string(&args, "path", 4096)?,
                    )?;
                    return Ok(json!({"content":content}));
                }
                if name == "run_command" {
                    return shell(&root, string(&args, "command", 16 * 1024)?).await;
                }
                if matches!(
                    name.as_str(),
                    "read_file" | "list_files" | "write_file" | "edit_file"
                ) {
                    // File operations are bounded and synchronous: cancellation cannot leave a detached write job.
                    return file_tool(&root, &name, args);
                }
                match upstream {
                    Some(host) => (host.handler)(name, args).await,
                    None => Err("Unknown tool.".into()),
                }
            })
        }),
    })
}
fn string<'a>(args: &'a Value, key: &str, limit: usize) -> Result<&'a str, String> {
    args[key]
        .as_str()
        .filter(|value| value.len() <= limit && !value.contains('\0'))
        .ok_or_else(|| format!("Invalid or oversized {key}."))
}
fn file_tool(root: &Path, name: &str, args: Value) -> Result<Value, String> {
    let path = string(&args, "path", 4096)?;
    match name {
        "read_file" => Ok(json!({"content":crate::workspace::read_file(root, path.into())?})),
        "list_files" => Ok(json!(crate::workspace::list_files(
            root,
            Some(path.into())
        )?)),
        "write_file" | "edit_file" => {
            let target = crate::workspace::scoped_path(root, path)?;
            let content = if name == "edit_file" {
                let previous = crate::workspace::read_file(root, path.into())?;
                let old = string(&args, "old_text", 128 * 1024)?;
                if old.is_empty() || previous.matches(old).count() != 1 {
                    return Err(
                        "old_text must match exactly once. Read the file again before editing."
                            .into(),
                    );
                }
                previous.replacen(old, string(&args, "new_text", 128 * 1024)?, 1)
            } else {
                string(&args, "content", 128 * 1024)?.to_owned()
            };
            if content.len() > 128 * 1024 {
                return Err("File content exceeds 128 KiB.".into());
            }
            if let Ok(metadata) = std::fs::symlink_metadata(&target) {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("Write only to a regular project file.".into());
                }
            }
            let parent = target.parent().ok_or("Invalid file path")?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            crate::workspace::scoped_path(root, path)?;
            let temp = parent.join(format!(".pandacode-write-{}", uuid::Uuid::new_v4()));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let result = (|| -> std::io::Result<()> {
                let mut file = options.open(&temp)?;
                if let Ok(metadata) = std::fs::metadata(&target) {
                    file.set_permissions(metadata.permissions())?;
                }
                file.write_all(content.as_bytes())?;
                file.sync_all()?;
                std::fs::rename(&temp, &target)
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(temp);
            }
            result.map_err(|e| e.to_string())?;
            Ok(json!({"written":path,"bytes":content.len()}))
        }
        _ => Err("Unknown file tool.".into()),
    }
}
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
async fn drain(mut reader: impl tokio::io::AsyncRead + Unpin) -> Result<String, String> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        let take = count.min((32 * 1024usize).saturating_sub(kept.len()));
        kept.extend_from_slice(&chunk[..take]);
        truncated |= take < count;
    }
    let mut output = String::from_utf8_lossy(&kept).into_owned();
    if truncated {
        output.push_str("\n[Output truncated]");
    }
    Ok(output)
}
async fn shell(root: &Path, script: &str) -> Result<Value, String> {
    if script.trim().is_empty() {
        return Err("Enter a command.".into());
    }
    #[cfg(unix)]
    let mut command = {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        c.process_group(0);
        c
    };
    #[cfg(windows)]
    let mut command = {
        let mut c = Command::new("cmd.exe");
        c.args(["/D", "/S", "/C", script]);
        c
    };
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the command.")?;
    let _group = ProcessGroup(child.id().ok_or("Command did not start")?);
    #[cfg(windows)]
    let _job = windows_job::Job::attach(child.id().unwrap());
    let stdout = child.stdout.take().ok_or("No command stdout")?;
    let stderr = child.stderr.take().ok_or("No command stderr")?;
    let run = async {
        tokio::try_join!(
            async { child.wait().await.map_err(|e| e.to_string()) },
            drain(stdout),
            drain(stderr)
        )
    };
    let (status, stdout, stderr) = tokio::time::timeout(Duration::from_secs(60), run)
        .await
        .map_err(|_| "Command timed out after 60 seconds.")??;
    Ok(json!({"exitCode":status.code(),"stdout":stdout,"stderr":stderr}))
}
