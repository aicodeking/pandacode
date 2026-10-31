//! Projects, task metadata, worktrees, drafts and sidebar ordering.

use super::sql::{
    DISCARD_EMPTY_DRAFTS_SQL, REORDER_SQL, SESSIONS_SQL, SESSION_SQL, SETTLE_ARCHIVED_SQL,
};
use super::{
    id, now, resolve_workspace_root, valid_permission_mode, ContextUsage, PRIMARY_LINKS_REFUSAL, Project, RemoteDevice, Folder, RepoFolder, folder_labels,
    Result, Session, Store, MAX_MISSING_IDS, MAX_MISSING_ID_CHARS, SESSION_NOT_FOUND,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

pub(super) fn has_sidebar_ranking_columns(db: &Connection) -> Result<bool> {
    db.query_row(
        "SELECT COUNT(*) = 4 FROM pragma_table_info('sessions', 'main')
         WHERE name COLLATE NOCASE IN ('id', 'draft', 'pinned', 'sidebar_order')",
        [],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Once the sidebar has been arranged by hand, a New task published by its first prompt goes to
/// the top: every rank moves down one and it takes rank 0. Without this the next reorder would
/// rank it after every arranged task. Forks and imports stay unranked. A TEMP trigger lives on
/// this connection only, so it needs no schema change; it is added once ranks exist.
pub(super) fn rank_published_drafts(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TEMP TRIGGER IF NOT EXISTS rank_published_draft AFTER UPDATE OF draft ON main.sessions
        WHEN OLD.draft=1 AND NEW.draft=0 AND NEW.sidebar_order IS NULL AND NEW.pinned=0
          AND EXISTS(SELECT 1 FROM main.sessions WHERE sidebar_order IS NOT NULL)
        BEGIN
          UPDATE sessions SET sidebar_order=sidebar_order+1 WHERE sidebar_order IS NOT NULL;
          UPDATE sessions SET sidebar_order=0 WHERE id=NEW.id;
        END;").map_err(|e| e.to_string())
}


impl Store {
    /// Point one task's copy of a project folder at its own checkout; NULLs clear it.
    pub fn set_session_repo(&self, session_id: &str, folder_path: &Path, worktree_path: Option<&Path>, worktree_branch: Option<&str>) -> Result<()> {
        let folder = Self::canonical_folder(folder_path)?.to_string_lossy().to_string();
        let worktree = worktree_path
            .map(|path| {
                path.canonicalize()
                    .map(|p| p.to_string_lossy().to_string())
                    .map_err(|e| format!("Worktree folder is unavailable: {e}"))
            })
            .transpose()?;
        self.db
            .execute(
                "INSERT INTO session_repos(session_id,path,worktree_path,worktree_branch) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id,path) DO UPDATE SET worktree_path=excluded.worktree_path,worktree_branch=excluded.worktree_branch",
                params![session_id, folder, worktree, worktree_branch],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// The task's working folders: the primary first (its own checkout when it has
    /// one), then the project's folders with any per-task checkouts applied. Folders
    /// a task recorded but the project has since dropped stay listed for that task.
    pub fn workspace_folders(&self, project_id: &str, session_id: &str) -> Result<Vec<RepoFolder>> {
        let project = self.project(project_id)?;
        let session = self.session(session_id)?;
        let folders = self.project_folders(project_id)?;
        let primary = folders
            .iter()
            .find(|f| f.is_primary)
            .map(|f| f.path.clone())
            .unwrap_or_else(|| project.path.clone());
        let mut stmt = self
            .db
            .prepare("SELECT path,worktree_path,worktree_branch FROM session_repos WHERE session_id=?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let repos = stmt
            .query_map([session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        // A task created after multi-folder pinning records its primary: the
        // session_repos row whose checkout is the task's own names the folder
        // that was primary when the task was created, so a later primary change
        // cannot relabel this task's checkout. Legacy tasks keep today's behavior.
        let pinned: Option<String> = session.worktree_path.as_ref().and_then(|worktree| {
            repos
                .iter()
                .find(|(_, row_worktree, _)| row_worktree.as_deref() == Some(worktree.as_str()))
                .map(|(path, _, _)| path.clone())
        });
        let primary = pinned.clone().unwrap_or(primary);
        // Under the pin every other folder is secondary, the current primary
        // included: the pinned row took the primary slot.
        let secondary = |f: &Folder| {
            Some(f.path.as_str()) != pinned.as_deref() && (pinned.is_some() || !f.is_primary)
        };
        // Labels always come from the folder paths: the primary, the folders, then
        // the dropped folders a task still holds a checkout for.
        let mut label_paths = vec![PathBuf::from(&primary)];
        for folder in folders.iter().filter(|f| secondary(f)) {
            label_paths.push(PathBuf::from(&folder.path));
        }
        let folder_set: std::collections::HashSet<&str> =
            folders.iter().map(|f| f.path.as_str()).collect();
        let orphans: Vec<_> = repos
            .iter()
            .filter_map(|(path, worktree, branch)| {
                worktree
                    .as_ref()
                    .map(|wt| (path.clone(), wt.clone(), branch.clone()))
            })
            .filter(|(path, _, _)| {
                !folder_set.contains(path.as_str()) && Some(path.as_str()) != pinned.as_deref()
            })
            .collect();
        for (path, _, _) in &orphans {
            label_paths.push(PathBuf::from(path));
        }
        let labels = folder_labels(&label_paths);
        let mut entries = Vec::new();
        // The task's own worktree takes the primary entry's place, under its label.
        let worktree = session.worktree_path.clone().map(PathBuf::from);
        let branch = if worktree.is_some() { session.worktree_branch.clone() } else { None };
        entries.push(RepoFolder {
            path: worktree.clone().unwrap_or_else(|| PathBuf::from(&primary)),
            label: labels[0].clone(),
            is_primary: true,
            worktree,
            branch,
        });
        let mut label_index = 1;
        for folder in folders.iter().filter(|f| secondary(f)) {
            let entry = match repos.iter().find(|(path, _wt, _)| *path == folder.path) {
                Some((_, Some(wt), branch)) => RepoFolder {
                    path: PathBuf::from(wt),
                    label: labels[label_index].clone(),
                    is_primary: false,
                    worktree: Some(PathBuf::from(wt)),
                    branch: branch.clone(),
                },
                _ => RepoFolder {
                    path: PathBuf::from(&folder.path),
                    label: labels[label_index].clone(),
                    is_primary: false,
                    worktree: None,
                    branch: None,
                },
            };
            entries.push(entry);
            label_index += 1;
        }
        for (_path, worktree, branch) in &orphans {
            entries.push(RepoFolder {
                path: PathBuf::from(worktree),
                label: labels[label_index].clone(),
                is_primary: false,
                worktree: Some(PathBuf::from(worktree)),
                branch: branch.clone(),
            });
            label_index += 1;
        }
        Ok(entries)
    }

    pub(super) fn migrate_legacy_worktrees(db: &Connection) -> Result<()> {
        let projects = Self::read_projects(db)?;
        let registered: Vec<_> = projects
            .iter()
            .map(|project| PathBuf::from(&project.path))
            .collect();
        for legacy in &projects {
            let Some(parent) =
                crate::workspace::legacy_worktree_parent(Path::new(&legacy.path), &registered)
            else {
                continue;
            };
            let Some(project) = projects
                .iter()
                .find(|project| Path::new(&project.path) == parent)
            else {
                continue;
            };
            let moved = db.execute("UPDATE sessions SET project_id=?2,worktree_path=COALESCE(worktree_path,?3) WHERE project_id=?1",
                params![legacy.id,project.id,legacy.path]).map_err(|e| e.to_string())?;
            if moved == 0 {
                // An old worktree may have been created before its first task.
                let choice = db.query_row("SELECT provider,model FROM sessions WHERE project_id=?1 ORDER BY updated_at DESC LIMIT 1",
                    [&project.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .optional().map_err(|e| e.to_string())?.unwrap_or_else(|| ("claude".into(), "default".into()));
                db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,worktree_path)
                    VALUES (?1,?2,'New conversation',?3,?4,'ask','idle',?5,?5,?6)",
                    params![id(),project.id,choice.0,choice.1,now(),legacy.path]).map_err(|e| e.to_string())?;
            }
            db.execute("DELETE FROM projects WHERE id=?1", [&legacy.id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn projects(&self) -> Result<Vec<Project>> {
        Self::read_projects(&self.db)
    }
    fn read_projects(db: &Connection) -> Result<Vec<Project>> {
        let mut stmt = db
            .prepare_cached("SELECT id,name,path,rowid FROM projects ORDER BY name COLLATE NOCASE")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                    added_order: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn add_project(&self, path: &Path) -> Result<Project> {
        let path = path
            .canonicalize()
            .map_err(|e| format!("Cannot open folder: {e}"))?;
        if !path.is_dir() {
            return Err("Choose a folder.".into());
        }
        let path_str = path.to_string_lossy().to_string();
        // A folder already on another project's folder list cannot become its own project.
        let claimed: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_folders f JOIN projects p ON p.id=f.project_id WHERE f.path=?1 AND p.path<>?1)",
                [&path_str],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if claimed {
            return Err("Folder already belongs to another project.".into());
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        self.db
            .execute(
                "INSERT OR IGNORE INTO projects(id,name,path) VALUES (?1,?2,?3)",
                params![id(), name, path_str],
            )
            .map_err(|e| e.to_string())?;
        let project = self
            .db
            .query_row(
                "SELECT id,name,path,rowid FROM projects WHERE path=?1",
                [&path_str],
                |r| {
                    Ok(Project {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                        added_order: r.get(3)?,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        // Every project starts as its own single primary folder.
        self.db
            .execute(
                "INSERT OR IGNORE INTO project_folders(project_id,path,position,is_primary) VALUES(?1,?2,0,1)",
                params![project.id, path_str],
            )
            .map_err(|e| e.to_string())?;
        Ok(project)
    }
    pub fn project(&self, project_id: &str) -> Result<Project> {
        self.db
            .prepare_cached("SELECT id,name,path,rowid FROM projects WHERE id=?1")
            .and_then(|mut statement| {
                statement.query_row([project_id], |r| {
                    Ok(Project {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                        added_order: r.get(3)?,
                    })
                })
            })
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found.".into())
    }
    /// Point a project at its folder's new location after the folder was renamed or
    /// moved outside PandaCode. Chats, tasks and history keep their ids.
    pub fn relink_project(&self, project_id: &str, path: &Path) -> Result<Project> {
        let project = self.project(project_id)?;
        if !path.is_absolute() {
            return Err("Choose an absolute folder path.".into());
        }
        let path = path
            .canonicalize()
            .map_err(|e| format!("Cannot open folder: {e}"))?;
        if !path.is_dir() {
            return Err("Choose a folder.".into());
        }
        // Chat folders are PandaCode-managed: never relink one, nor point a project into the chats root.
        let chats = crate::chats::root();
        let chats = chats.canonicalize().unwrap_or(chats);
        if crate::chats::is_chat_folder(Path::new(&project.path)) || path.starts_with(&chats) {
            return Err("Chat folders cannot be relinked.".into());
        }
        let path_str = path.to_string_lossy().to_string();
        if path_str == project.path {
            return Ok(project);
        }
        let taken: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE path=?1 AND id<>?2)",
                params![path_str, project_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if taken {
            return Err("Another project already uses this folder.".into());
        }
        // The project's name follows its folder's, as it did when the folder was added.
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| project.name.clone());
        self.db
            .execute(
                "UPDATE projects SET name=?2,path=?3 WHERE id=?1",
                params![project_id, name, path_str],
            )
            .map_err(|e| e.to_string())?;
        self.project(project_id)
    }
    /// Worktree checkouts of a project's local tasks (they live beside the project folder,
    /// so a rename of the project leaves them in place but breaks their Git links).
    pub fn project_worktrees(&self, project_id: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .db
            .prepare_cached("SELECT DISTINCT worktree_path FROM sessions WHERE project_id=?1 AND worktree_path IS NOT NULL AND remote_device IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<String>, _>>()
            .map_err(|e| e.to_string());
        rows
    }
    pub fn remove_project(&self, project_id: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM projects WHERE id=?1", [project_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Canonicalize a folder argument the way add_project does: existing directories only.
    fn canonical_folder(path: &Path) -> Result<PathBuf> {
        let path = path
            .canonicalize()
            .map_err(|e| format!("Cannot open folder: {e}"))?;
        if !path.is_dir() {
            return Err("Choose a folder.".into());
        }
        Ok(path)
    }
    /// The project's folders in order; exactly one is primary and projects.path follows it.
    pub fn project_folders(&self, project_id: &str) -> Result<Vec<Folder>> {
        self.project(project_id)?;
        let mut stmt = self
            .db
            .prepare_cached("SELECT path,position,is_primary FROM project_folders WHERE project_id=?1 ORDER BY position")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(Folder {
                    path: r.get(0)?,
                    position: r.get(1)?,
                    is_primary: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    /// Add a folder: canonical, not already claimed by any project, appended by position.
    pub fn add_project_folder(&self, project_id: &str, path: &Path) -> Result<Folder> {
        self.project(project_id)?;
        let path_str = Self::canonical_folder(path)?.to_string_lossy().to_string();
        // A folder joins at most one project, a primary path included.
        let taken: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_folders WHERE path=?1)",
                [&path_str],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if taken {
            return Err("Folder already belongs to a project.".into());
        }
        let position: i64 = self
            .db
            .query_row(
                "SELECT COALESCE(MAX(position)+1,0) FROM project_folders WHERE project_id=?1",
                [project_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        self.db
            .execute(
                "INSERT INTO project_folders(project_id,path,position,is_primary) VALUES(?1,?2,?3,0)",
                params![project_id, path_str, position],
            )
            .map_err(|e| e.to_string())?;
        Ok(Folder {
            path: path_str,
            position,
            is_primary: false,
        })
    }
    /// Whether any task of the project still holds a GitHub link under the
    /// legacy primary key: those links belong to whichever folder is primary,
    /// so the primary must stay put until they are settled.
    fn project_has_unqualified_links(&self, project_id: &str) -> Result<bool> {
        let count: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM task_links l JOIN sessions s ON s.id=l.session_id WHERE s.project_id=?1 AND l.repo='' AND l.kind IN ('pull','issue')",
            [project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }
    /// Remove a folder; the last one stays, and removing the primary promotes the
    /// next folder by position, with projects.path following it in one transaction.
    pub fn remove_project_folder(&self, project_id: &str, path: &Path) -> Result<()> {
        let path_str = Self::canonical_folder(path)?.to_string_lossy().to_string();
        let folders = self.project_folders(project_id)?;
        if folders.len() <= 1 {
            return Err("A project keeps at least one folder.".into());
        }
        let removed = folders
            .iter()
            .find(|f| f.path == path_str)
            .ok_or_else(|| "Folder not found.".to_string())?;
        let was_primary = removed.is_primary;
        if was_primary && self.project_has_unqualified_links(project_id)? {
            return Err(PRIMARY_LINKS_REFUSAL.into());
        }
        let next = folders
            .iter()
            .filter(|f| f.path != path_str)
            .min_by_key(|f| f.position);
        let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        transaction
            .execute(
                "DELETE FROM project_folders WHERE project_id=?1 AND path=?2",
                params![project_id, path_str],
            )
            .map_err(|e| e.to_string())?;
        if was_primary {
            let next = next.expect("checked above that a folder remains");
            transaction
                .execute(
                    "UPDATE project_folders SET is_primary=1 WHERE project_id=?1 AND path=?2",
                    params![project_id, next.path],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "UPDATE projects SET path=?2 WHERE id=?1",
                    params![project_id, next.path],
                )
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Make one of the project's own folders primary; projects.path follows it.
    pub fn set_primary_folder(&self, project_id: &str, path: &Path) -> Result<()> {
        let path_str = Self::canonical_folder(path)?.to_string_lossy().to_string();
        let folders = self.project_folders(project_id)?;
        let folder = folders
            .iter()
            .find(|f| f.path == path_str)
            .ok_or_else(|| "Folder not found.".to_string())?;
        if !folder.is_primary {
            if self.project_has_unqualified_links(project_id)? {
                return Err(PRIMARY_LINKS_REFUSAL.into());
            }
            let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "UPDATE project_folders SET is_primary=0 WHERE project_id=?1 AND is_primary=1",
                    [project_id],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "UPDATE project_folders SET is_primary=1 WHERE project_id=?1 AND path=?2",
                    params![project_id, path_str],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "UPDATE projects SET path=?2 WHERE id=?1",
                    params![project_id, path_str],
                )
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn session_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
        let used_tokens: Option<i64> = r.get(14)?;
        let context_window: Option<i64> = r.get(15)?;
        let context_usage = used_tokens
            .and_then(|tokens| u64::try_from(tokens).ok())
            .and_then(|used_tokens| {
                let context_window = match context_window {
                    Some(window) => Some(u64::try_from(window).ok()?),
                    None => None,
                };
                let usage = ContextUsage {
                    used_tokens,
                    context_window,
                };
                usage.is_valid().then_some(usage)
            });
        Ok(Session {
            id: r.get(0)?,
            project_id: r.get(1)?,
            title: r.get(2)?,
            provider: r.get(3)?,
            model: r.get(4)?,
            mode: r.get(5)?,
            status: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
            archived: r.get(9)?,
            pinned: r.get(23)?,
            sidebar_order: r.get(24)?,
            draft: r.get(25)?,
            limited_at: r.get(26)?,
            limited_until: r.get(27)?,
            resume_at_reset: r.get(28)?,
            resume_id: r.get(10)?,
            last_response_at: r.get(11)?,
            last_prompt_at: r.get(22)?,
            worktree_path: r.get(12)?,
            reasoning_effort: r.get(13)?,
            context_usage,
            task_stage: r.get(16)?,
            task_description: r.get(17)?,
            completed_at: r.get(18)?,
            goal_state: crate::goal_state::GoalState::parse(r.get::<_, Option<String>>(19)?.as_deref()),
            codex_settings: r
                .get::<_, Option<String>>(20)?
                .and_then(|s| serde_json::from_str(&s).ok()),
            worktree_branch: r.get(21)?,
            remote_device: r.get::<_, Option<String>>(29)?.map(|id| RemoteDevice { name: crate::remote::device_label(&id), id }),
            cloud: r.get::<_, Option<String>>(30)?.as_deref().and_then(crate::cloud_agents::view),
            issue: None,
            pull_request: None,
        })
    }
    pub fn sessions(&self) -> Result<Vec<Session>> {
        // Lists only need a card preview. Full details remain in SQLite and are
        // fetched for the selected task or directly for an agent's Start prompt.
        let mut stmt = self.db.prepare_cached(SESSIONS_SQL).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::session_row)
            .map_err(|e| e.to_string())?;
        let mut sessions = rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        self.attach_links(&mut sessions)?;
        Ok(sessions)
    }
    pub fn session(&self, sid: &str) -> Result<Session> {
        let mut session = self
            .db
            .prepare_cached(SESSION_SQL)
            .and_then(|mut statement| statement.query_row([sid], Self::session_row))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| String::from(SESSION_NOT_FOUND))?;
        self.attach_links(std::slice::from_mut(&mut session))?;
        Ok(session)
    }

    /// Reads a few columns of one task through the statement cache, without the full row and
    /// its links that `session` loads. A missing task is `SESSION_NOT_FOUND`, as in `session`.
    pub(super) fn session_columns<T>(
        &self,
        sql: &str,
        sid: &str,
        map: impl FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> Result<T> {
        self.db
            .prepare_cached(sql)
            .and_then(|mut statement| statement.query_row([sid], map))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| String::from(SESSION_NOT_FOUND))
    }

    /// `Ok` when the task has a row; the same error as `session` otherwise.
    pub(crate) fn require_session(&self, sid: &str) -> Result<()> {
        let exists: bool = self
            .db
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)")
            .and_then(|mut statement| statement.query_row([sid], |r| r.get(0)))
            .map_err(|e| e.to_string())?;
        if exists { Ok(()) } else { Err(SESSION_NOT_FOUND.into()) }
    }

    /// The task's current harness.
    pub(super) fn session_provider(&self, sid: &str) -> Result<String> {
        self.session_columns("SELECT provider FROM sessions WHERE id=?1", sid, |r| r.get(0))
    }

    /// The project's folder and, for a task, its worktree folder (not yet resolved on disk; see
    /// `resolve_workspace_root`). Errors as `project` and `session` do, in that order, then
    /// when the task belongs to another project or runs on another computer.
    pub(crate) fn workspace_paths(
        &self,
        project_id: &str,
        session_id: Option<&str>,
    ) -> Result<(PathBuf, Option<PathBuf>)> {
        let path: String = self
            .db
            .prepare_cached("SELECT path FROM projects WHERE id=?1")
            .and_then(|mut statement| statement.query_row([project_id], |r| r.get(0)))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| String::from("Project not found."))?;
        let Some(sid) = session_id else {
            return Ok((PathBuf::from(path), None));
        };
        let (task_project, worktree, remote_device): (String, Option<String>, Option<String>) = self.session_columns(
            "SELECT project_id,worktree_path,remote_device FROM sessions WHERE id=?1",
            sid,
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if task_project != project_id {
            return Err("This task does not belong to the selected project.".into());
        }
        // A mirror's checkout is on the other computer, never this disk.
        if let Some(device) = remote_device {
            return Err(format!("This task runs on {}.", crate::remote::device_label(&device)));
        }
        Ok((PathBuf::from(path), worktree.map(PathBuf::from)))
    }

    /// Hides a task opened from New task until its first prompt is saved.
    pub fn mark_draft(&self, sid: &str) -> Result<Session> {
        self.db.prepare_cached("UPDATE sessions SET draft=1 WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=?1)").and_then(|mut statement| statement.execute([sid])).map_err(|e| e.to_string())?;
        self.session(sid)
    }

    /// Whether a task is still an unsent draft with no saved history.
    pub fn is_empty_draft(&self, sid: &str) -> Result<bool> {
        self.db.prepare_cached("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND draft=1 AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=?1))").and_then(|mut statement| statement.query_row([sid], |r| r.get(0))).map_err(|e| e.to_string())
    }

    /// The ids among `ids` with no session row at all (drafts, archived tasks and architect
    /// workers all have one), in the order given. One query: the ids go in as one JSON
    /// parameter. Err when there are more than `MAX_MISSING_IDS` or one is too long.
    pub fn missing_sessions(&self, ids: &[String]) -> Result<Vec<String>> {
        if ids.len() > MAX_MISSING_IDS {
            return Err(format!("At most {MAX_MISSING_IDS} task ids can be checked at once."));
        }
        if ids.iter().any(|id| id.chars().count() > MAX_MISSING_ID_CHARS) {
            return Err(format!("A task id is longer than {MAX_MISSING_ID_CHARS} characters."));
        }
        let json = serde_json::to_string(ids).map_err(|e| e.to_string())?;
        let mut stmt = self
            .db
            .prepare_cached("SELECT value FROM json_each(?1) WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE id=json_each.value) ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([json], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<String>>>().map_err(|e| e.to_string())
    }

    /// Removes drafts left from an earlier launch; none can be open yet.
    pub fn discard_empty_drafts(&self) -> Result<usize> {
        self.db.prepare_cached(DISCARD_EMPTY_DRAFTS_SQL).and_then(|mut statement| statement.execute([])).map_err(|e| e.to_string())
    }

    pub fn pin_session(&self, sid: &str, pinned: bool) -> Result<Session> {
        let changed = self.db.execute(
            "UPDATE sessions SET pinned=?2 WHERE id=?1 AND id NOT IN (SELECT session_id FROM architect_workers)",
            params![sid, pinned],
        ).map_err(|e| e.to_string())?;
        if changed == 0 { return Err("Conversation not found or is a team worker.".into()); }
        self.session(sid)
    }

    pub fn reorder_sessions(&self, session_ids: &[String]) -> Result<Vec<Session>> {
        if session_ids.is_empty() || session_ids.len() > 500 {
            return Err("Reorder between 1 and 500 conversations at a time.".into());
        }
        let selected: std::collections::HashSet<&str> = session_ids.iter().map(String::as_str).collect();
        if selected.len() != session_ids.len() {
            return Err("A conversation may appear only once in the order.".into());
        }
        let transaction = rusqlite::Transaction::new_unchecked(&self.db, rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        if !self.trackers_usable && !has_sidebar_ranking_columns(&transaction)? {
            return Err("This database schema does not support sidebar ordering.".into());
        }
        // Work from the entire order, not the currently displayed project/search
        // result or the 500-row listing window, so hidden tasks keep their slots.
        let current = {
            let mut query = transaction.prepare_cached(REORDER_SQL).map_err(|e| e.to_string())?;
            let rows = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<i64>>(2)?))).map_err(|e| e.to_string())?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let included = current.iter().filter(|(id, _, _)| selected.contains(id.as_str())).collect::<Vec<_>>();
        if included.len() != selected.len() {
            return Err("A conversation no longer exists or is a team worker.".into());
        }
        if included.iter().any(|(_, pinned, _)| *pinned != included[0].1) {
            return Err("Reorder pinned and unpinned conversations separately.".into());
        }
        // Each slot keeps its place in the whole order; the selected tasks trade slots.
        let mut next = session_ids.iter();
        let ordered: Vec<&str> = current
            .iter()
            .map(|(id, _, _)| if selected.contains(id.as_str()) { next.next().expect("validated selection count").as_str() } else { id.as_str() })
            .collect();
        let saved: std::collections::HashMap<&str, Option<i64>> = current.iter().map(|(id, _, order)| (id.as_str(), *order)).collect();
        {
            // Only ranks that change are written; the rest already hold their slot.
            let mut update = transaction.prepare_cached("UPDATE sessions SET sidebar_order=?2 WHERE id=?1").map_err(|e| e.to_string())?;
            for (rank, id) in ordered.iter().enumerate() {
                let rank = rank as i64;
                if saved.get(id).copied().flatten() != Some(rank) {
                    update.execute(params![id, rank]).map_err(|e| e.to_string())?;
                }
            }
        }
        rank_published_drafts(&transaction)?;
        transaction.commit().map_err(|e| e.to_string())?;
        self.sessions()
    }
    /// Give an unstarted task its own checkout, keeping the draft and settings.
    pub fn attach_worktree(&self, sid: &str, path: &Path, branch: &str) -> Result<Session> {
        let path = path
            .canonicalize()
            .map_err(|e| format!("Worktree folder is unavailable: {e}"))?;
        let changed = self.db.execute(
            "UPDATE sessions SET worktree_path=?2,worktree_branch=?3,updated_at=?4 WHERE id=?1 AND worktree_path IS NULL AND resume_id IS NULL AND status NOT IN ('running','waiting') AND NOT EXISTS (SELECT 1 FROM messages WHERE session_id=?1)",
            params![sid, path.to_string_lossy(), branch, now()],
        ).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("This conversation already started. Create a new task in a worktree instead.".into());
        }
        self.session(sid)
    }
    /// Whether a task can still be converted in place.
    pub fn worktree_attachable(&self, sid: &str) -> Result<bool> {
        let (has_worktree, has_resume, status, empty): (bool, bool, String, bool) = self.session_columns(
            "SELECT worktree_path IS NOT NULL,resume_id IS NOT NULL,status,NOT EXISTS(SELECT 1 FROM messages WHERE session_id=?1) FROM sessions WHERE id=?1",
            sid,
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        Ok(!has_worktree && !has_resume && !["running", "waiting"].contains(&status.as_str()) && empty)
    }
    pub fn create_session(
        &self,
        project_id: &str,
        provider: &str,
        model: &str,
        mode: &str,
    ) -> Result<Session> {
        self.project(project_id)?;
        if ![
            "claude",
            "codex",
            "kimi",
            "opencode",
            "glm",
            "antigravity",
            "grok",
            "mimo",
            "alibaba",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
            "devin",
            "zcode",
            "hermes",
            "cursor",
        ]
        .contains(&provider)
        {
            return Err("Unknown provider.".into());
        }
        if !valid_permission_mode(mode) {
            return Err("Unknown permission mode.".into());
        }
        if model.len() > 200 {
            return Err("Model name is too long.".into());
        }
        let sid = id();
        let t = now();
        self.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,title_origin) VALUES (?1,?2,'New conversation',?3,?4,?5,'idle',?6,?6,'auto')",params![sid,project_id,provider,model,mode,t]).map_err(|e|e.to_string())?;
        self.session(&sid)
    }

    pub fn create_board_task(
        &self,
        project_id: &str,
        provider: &str,
        model: &str,
        mode: &str,
        title: &str,
        description: &str,
    ) -> Result<Session> {
        Self::validate_task_details(title, description)?;
        // Validation happens before inserting, and rollback prevents orphaned
        // empty tasks if writing the description fails.
        let task = self.in_transaction(|| {
            let task = self.create_session(project_id, provider, model, mode)?;
            self.db
                .execute(
                    "UPDATE sessions SET title=?2,title_origin='manual',task_description=?3 WHERE id=?1",
                    params![task.id, title.trim(), description.trim()],
                )
                .map_err(|e| e.to_string())?;
            Ok(task)
        })?;
        self.session(&task.id)
    }

    fn validate_task_details(title: &str, description: &str) -> Result<()> {
        if title.trim().is_empty() || title.len() > 200 {
            return Err("Title must be 1–200 characters.".into());
        }
        if description.len() > crate::MESSAGE_LIMIT {
            return Err("Task details must be under 16 MiB.".into());
        }
        Ok(())
    }

    pub fn update_task_details(
        &self,
        sid: &str,
        title: &str,
        description: &str,
    ) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        Self::validate_task_details(title, description)?;
        self.session(sid)?;
        let changed = self
            .db
            .execute(
                "UPDATE sessions SET title=?2,title_origin='manual',task_description=?3,updated_at=?4
             WHERE id=?1 AND status NOT IN ('running','waiting') AND archived=0",
                params![sid, title.trim(), description.trim(), now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Restore this task and stop its agent before editing its details.".into());
        }
        self.session(sid)
    }

    pub fn set_task_stage(&self, sid: &str, stage: &str) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        let current = self.session(sid)?;
        // Work in progress comes from starting a task. The one way back by hand is undoing the
        // completion of a run that stopped or failed, which never left work in progress.
        let undoing = current.task_stage == "completed" && matches!(current.status.as_str(), "error" | "interrupted");
        if stage == "in_progress" && !undoing {
            return Err("Start the task to move it to work in progress.".into());
        }
        if !matches!(stage, "pending" | "review" | "completed" | "in_progress") {
            return Err("Unknown task stage.".into());
        }
        let changed = self
            .db
            .execute(
                "UPDATE sessions SET task_stage=?2,
               completed_at=CASE WHEN ?2='completed' THEN COALESCE(completed_at,?3) ELSE NULL END,
               updated_at=?3 WHERE id=?1 AND status NOT IN ('running','waiting') AND archived=0",
                params![sid, stage, now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Restore this task and stop its agent before changing its stage.".into());
        }
        self.session(sid)
    }

    /// Archiving is retired: archived tasks become ordinary completed ones.
    pub fn settle_archived(&self) -> Result<usize> {
        // `sessions_archived` holds only archived rows, so this reads nothing once they are settled.
        self.db
            .prepare_cached(SETTLE_ARCHIVED_SQL)
            .and_then(|mut statement| statement.execute([]))
            .map_err(|e| e.to_string())
    }
    /// Resolve the selected task's checkout without silently falling back to the main folder.
    pub fn workspace_root(&self, project_id: &str, session_id: Option<&str>) -> Result<PathBuf> {
        let (project_path, worktree) = self.workspace_paths(project_id, session_id)?;
        resolve_workspace_root(project_path, worktree)
    }

    pub fn create_worktree_session_on(&self, source: &Session, path: &Path, branch: Option<&str>) -> Result<Session> {
        self.project(&source.project_id)?;
        let path = path
            .canonicalize()
            .map_err(|e| format!("Worktree folder is unavailable: {e}"))?;
        if !path.is_dir() {
            return Err("Worktree folder is unavailable.".into());
        }
        let sid = id();
        let t = now();
        self.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,worktree_path,reasoning_effort,worktree_branch,title_origin)
            VALUES (?1,?2,'New conversation',?3,?4,?8,'idle',?5,?5,?6,?7,?9,'auto')",
            params![sid,source.project_id,source.provider,source.model,t,path.to_string_lossy(),source.reasoning_effort,source.mode,branch])
            .map_err(|e| e.to_string())?;
        self.session(&sid)
    }

    pub fn configure(
        &self,
        sid: &str,
        provider: &str,
        model: &str,
        project_id: Option<&str>,
    ) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        if ![
            "claude",
            "codex",
            "kimi",
            "opencode",
            "glm",
            "antigravity",
            "grok",
            "mimo",
            "alibaba",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
            "devin",
            "zcode",
            "hermes",
            "cursor",
        ]
        .contains(&provider)
        {
            return Err("Unknown provider.".into());
        }
        if model.len() > 200 {
            return Err("Model name is too long.".into());
        }
        if let Some(project_id) = project_id {
            self.project(project_id)?;
        }
        let current = self.session(sid)?;
        // Queue the handoff and replace the native context atomically. Keep the
        // project fixed once a conversation exists, but let another harness continue it.
        let switching = current.provider != provider;
        let needs_handoff = switching && (current.resume_id.is_some() || self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND role IN ('user','assistant','coordination'))", [sid], |r| r.get::<_, bool>(0)
        ).map_err(|e| e.to_string())?);
        // New-task creation can already have a transaction. Without history,
        // configuration is still one atomic UPDATE, even if team defaults chose another harness.
        let transaction = needs_handoff.then(|| self.db.unchecked_transaction()).transpose().map_err(|e| e.to_string())?;
        if needs_handoff { crate::context_recovery::queue(self, sid)?; }
        let changed = self
            .db
            .execute(
                "UPDATE sessions SET provider=?2,model=?3,project_id=COALESCE(?5,project_id),
               resume_id=CASE WHEN provider<>?2 THEN NULL ELSE resume_id END,
               goal_state=CASE WHEN provider<>?2 THEN NULL ELSE goal_state END,
               codex_settings=CASE WHEN provider<>?2 THEN NULL ELSE codex_settings END,
               reasoning_effort=CASE WHEN provider<>?2 OR model<>?3 THEN NULL ELSE reasoning_effort END,
               context_used_tokens=CASE WHEN provider<>?2 OR model<>?3 THEN NULL ELSE context_used_tokens END,
               context_window=CASE WHEN provider<>?2 OR model<>?3 THEN NULL ELSE context_window END,
               updated_at=?4
             WHERE id=?1 AND status NOT IN ('running','waiting')
               AND (worktree_path IS NULL OR project_id=COALESCE(?5,project_id))
               AND (project_id=COALESCE(?5,project_id) OR (resume_id IS NULL AND NOT EXISTS
               (SELECT 1 FROM messages WHERE session_id=?1)))",
                params![sid, provider, model, now(), project_id],
            )
            .map_err(|e| e.to_string())?;
        let session = self.session(sid)?;
        if changed == 0 {
            if ["running", "waiting"].contains(&session.status.as_str()) {
                return Err(
                    "Stop the agent before changing its project, provider, or model.".into(),
                );
            }
            if session.worktree_path.is_some()
                && project_id.is_some_and(|id| id != session.project_id)
            {
                return Err("A worktree task stays in its original project. Create a new task to use another project.".into());
            }
            if project_id.is_some_and(|id| id != session.project_id) {
                return Err("Create a new task to use a different project after a conversation has started.".into());
            }
            return Err(
                "Create a new task to use a different provider after a conversation has started."
                    .into(),
            );
        }
        if needs_handoff {
            let notice = serde_json::json!({
                "fromProvider": current.provider, "toProvider": provider,
                "summary": "Switched harness. The next message includes up to 200 recent conversation entries (64 KiB). Files and project stay in place. Older text may be shortened; private reasoning, native tool state, and image contents are not transferred. Reattach images if needed."
            });
            self.message(sid, "handoff", &notice.to_string())?;
        }
        if let Some(transaction) = transaction { transaction.commit().map_err(|e| e.to_string())?; }
        Ok(session)
    }
    pub fn set_reasoning_effort(&self, sid: &str, effort: Option<&str>) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        let session = self.session(sid)?;
        let effort = effort.map(str::trim).filter(|effort| !effort.is_empty());
        crate::providers::validate_reasoning_effort(&session.provider, effort)?;
        let changed = self.db.execute(
            "UPDATE sessions SET reasoning_effort=?2,updated_at=?3 WHERE id=?1 AND status NOT IN ('running','waiting')",
            params![sid, effort, now()],
        ).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Stop the agent before changing its reasoning effort.".into());
        }
        self.session(sid)
    }

    pub fn update(
        &self,
        sid: &str,
        title: Option<String>,
        archived: Option<bool>,
        model: Option<String>,
        mode: Option<String>,
    ) -> Result<()> {
        crate::architect::check_manual(self, sid)?;
        let status: String = self.session_columns("SELECT status FROM sessions WHERE id=?1", sid, |r| r.get(0))?;
        if title
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.len() > 200)
        {
            return Err("Title must be 1–200 characters.".into());
        }
        if model.as_ref().is_some_and(|s| s.len() > 200) {
            return Err("Model name is too long.".into());
        }
        if mode.as_ref().is_some_and(|s| !valid_permission_mode(s)) {
            return Err("Unknown permission mode.".into());
        }
        if (model.is_some() || mode.is_some())
            && matches!(status.as_str(), "running" | "waiting")
        {
            return Err("Stop the agent before changing its model or approval behavior.".into());
        }
        let changed = self.db.execute("UPDATE sessions SET title=COALESCE(?2,title),title_origin=CASE WHEN ?2 IS NOT NULL THEN 'manual' ELSE title_origin END,archived=COALESCE(?3,archived),model=COALESCE(?4,model),mode=COALESCE(?5,mode),
            completed_at=CASE WHEN archived=1 AND ?3=0 AND task_stage='completed' THEN ?6 ELSE completed_at END,
            reasoning_effort=CASE WHEN model<>COALESCE(?4,model) THEN NULL ELSE reasoning_effort END,
            context_used_tokens=CASE WHEN model<>COALESCE(?4,model) THEN NULL ELSE context_used_tokens END,
            context_window=CASE WHEN model<>COALESCE(?4,model) THEN NULL ELSE context_window END,
            updated_at=?6 WHERE id=?1 AND ((?4 IS NULL AND ?5 IS NULL) OR status NOT IN ('running','waiting'))",params![sid,title,archived,model,mode,now()]).map_err(|e|e.to_string())?;
        if changed == 0 {
            return Err("Stop the agent before changing its model or approval behavior.".into());
        }
        Ok(())
    }
}
