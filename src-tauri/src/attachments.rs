//! Durable, task-scoped links to prompt images for Connect.
use crate::storage::Store;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageFormat, ImageReader, Limits,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Cursor,
    path::{Component, Path, PathBuf},
};

pub const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RAW_CHUNK: usize = 120 * 1024;
const MAX_PROMPT_IMAGE: u64 = 5 * 1024 * 1024;
const MAX_MOODBOARD_IMAGE: u64 = 12 * 1024 * 1024;
const MESSAGE_PAGE_BUDGET: usize = 180 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Thumb,
    Full,
}

impl Variant {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "thumb" => Ok(Self::Thumb),
            "full" => Ok(Self::Full),
            _ => Err("Invalid variant.".into()),
        }
    }
}

/// Called after the user message row exists. Each failed attachment is logged and skipped so it
/// cannot turn a successfully saved prompt into a failed send, unless SQLite rolled the whole
/// transaction back: then later rows would commit one by one, so linking stops with `Err`.
/// Capture files are copied under `<app data>/attachments/` before the transaction opens, so
/// when it later fails or rolls back those copies stay on disk unreferenced (as a failed row's
/// copy always has). When the write lock cannot be taken at all (another connection holds it
/// past the busy timeout), rows are linked one by one outside a transaction instead.
pub fn link_message_attachments(
    store: &Store,
    session_id: &str,
    message_id: i64,
    content: &str,
    image_ids: &[String],
    capture_dir: &Path,
    app_data_dir: &Path,
) -> Result<usize, String> {
    let project_id: String = store
        .db
        .prepare_cached("SELECT project_id FROM sessions WHERE id=?1")
        .and_then(|mut query| query.query_row([session_id], |row| row.get(0)).optional())
        .map_err(|error| error.to_string())?
        .ok_or(crate::storage::SESSION_NOT_FOUND)?;
    let names = prompt_image_names(content);
    // Files are copied first; every row is then written in one transaction, so no
    // filesystem work happens while the write transaction is open.
    let captures = image_ids
        .iter()
        .enumerate()
        .filter_map(|(index, id)| {
            match persist_capture(
                session_id,
                id,
                names.get(index).map(String::as_str),
                capture_dir,
                app_data_dir,
            ) {
                Ok(capture) => Some(capture),
                Err(error) => {
                    eprintln!("PandaCode: could not persist prompt image {id}: {error}");
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    let link_all = || {
        let batch = Batch { store, guard: crate::storage::RollbackGuard::new(&store.db) };
        let linked = link_captures(&batch, session_id, message_id, &captures)?;
        Ok(linked + link_moodboards(&batch, session_id, message_id, &project_id, content)?)
    };
    match store.try_in_transaction_immediate(link_all) {
        Ok(count) => Ok(count),
        // `Busy` means `BEGIN IMMEDIATE` itself failed, so no row was written and linking row
        // by row cannot repeat a rolled-back row.
        Err(crate::storage::ImmediateTxError::Busy(error)) => {
            eprintln!("PandaCode: linking attachments row by row, the write lock was busy: {error}");
            link_all()
        }
        Err(crate::storage::ImmediateTxError::Other(error)) => Err(error),
    }
}

/// The store inside `link_message_attachments`'s transaction. A failed row is skipped, but once
/// SQLite has rolled that transaction back (`RAISE(ROLLBACK)`, a full disk) the connection is
/// in autocommit mode and every later write would commit alone, so the batch stops instead.
struct Batch<'a> {
    store: &'a Store,
    guard: crate::storage::RollbackGuard<'a>,
}

impl Batch<'_> {
    /// `Err` when SQLite rolled the batch's transaction back after `error`.
    fn check(&self, error: &rusqlite::Error) -> Result<(), String> {
        if self.guard.rolled_back() {
            return Err(format!("the attachment transaction was rolled back: {error}"));
        }
        Ok(())
    }
}

/// A prompt image copied into app data, ready for its `message_attachments` row.
struct Capture {
    id: String,
    name: String,
    width: u32,
    height: u32,
    bytes: i64,
    file: String,
}

fn link_captures(batch: &Batch, session_id: &str, message_id: i64, captures: &[Capture]) -> Result<usize, String> {
    if captures.is_empty() {
        return Ok(0);
    }
    let mut insert = match batch.store.db.prepare_cached(
        "INSERT OR IGNORE INTO message_attachments
         (message_id,session_id,id,kind,name,mime,width,height,bytes,file,source,moodboard_id,moodboard_image_id)
         VALUES(?1,?2,?3,'image',?4,'image/png',?5,?6,?7,?8,'file',NULL,NULL)",
    ) {
        Ok(insert) => insert,
        Err(error) => {
            for capture in captures {
                eprintln!("PandaCode: could not persist prompt image {}: {error}", capture.id);
            }
            batch.check(&error)?;
            return Ok(0);
        }
    };
    let mut linked = 0;
    for capture in captures {
        match insert.execute(params![
            message_id,
            session_id,
            capture.id,
            capture.name,
            capture.width,
            capture.height,
            capture.bytes,
            capture.file
        ]) {
            Ok(_) => linked += 1,
            Err(error) => {
                eprintln!("PandaCode: could not persist prompt image {}: {error}", capture.id);
                batch.check(&error)?;
            }
        }
    }
    Ok(linked)
}

fn link_moodboards(
    batch: &Batch,
    session_id: &str,
    message_id: i64,
    project_id: &str,
    content: &str,
) -> Result<usize, String> {
    let store = batch.store;
    let mut linked = 0;
    for board_id in moodboard_ids(content) {
        let rows = store.db.prepare_cached(
            "SELECT i.id,i.name,i.mime_type,i.width,i.height,length(i.original)
             FROM moodboard_images i JOIN moodboards b ON b.id=i.board_id
             WHERE b.id=?1 AND b.project_id=?2 ORDER BY i.created_at,i.id",
        );
        let rows = match rows {
            Ok(mut query) => match query.query_map(params![board_id, project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, u32>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            }) {
                Ok(rows) => rows.collect::<rusqlite::Result<Vec<_>>>(),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        let rows = match rows {
            Ok(rows) => rows,
            Err(error) => {
                eprintln!(
                    "PandaCode: could not list moodboard attachments for {board_id}: {error}"
                );
                batch.check(&error)?;
                continue;
            }
        };
        for (id, name, mime, width, height, bytes) in rows {
            if bytes < 0 || bytes as u64 > MAX_MOODBOARD_IMAGE {
                eprintln!("PandaCode: moodboard image {id} exceeds the stored attachment limit");
                continue;
            }
            let result = store
                .db
                .prepare_cached(
                    "INSERT OR IGNORE INTO message_attachments
                 (message_id,session_id,id,kind,name,mime,width,height,bytes,file,source,moodboard_id,moodboard_image_id)
                 VALUES(?1,?2,?3,'image',?4,?5,?6,?7,?8,NULL,'moodboard',?9,?3)",
                )
                .and_then(|mut insert| {
                    insert.execute(params![message_id, session_id, id, name, mime, width, height, bytes, board_id])
                });
            match result {
                Ok(count) => linked += count,
                Err(error) => {
                    eprintln!("PandaCode: could not link moodboard image {id}: {error}");
                    batch.check(&error)?;
                }
            }
        }
    }
    Ok(linked)
}

fn prompt_image_names(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let rest = line
                .strip_prefix("Attached browser screenshot: ")
                .or_else(|| line.strip_prefix("Attached image: "))
                .or_else(|| line.strip_prefix("Attached mockup: "))?;
            let name = rest.split(" (").next().unwrap_or(rest).trim();
            (!name.is_empty()).then(|| name.chars().take(200).collect())
        })
        .collect()
}

fn moodboard_ids(content: &str) -> Vec<String> {
    let mut result = Vec::new();
    for part in content.split("(moodboard ID: ").skip(1) {
        let Some(id) = part.split(')').next() else {
            continue;
        };
        if canonical_uuid(id) && !result.iter().any(|seen| seen == id) {
            result.push(id.to_owned());
        }
    }
    result
}

fn canonical_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
}

fn persist_capture(
    session_id: &str,
    id: &str,
    name: Option<&str>,
    capture_dir: &Path,
    app_data_dir: &Path,
) -> Result<Capture, String> {
    if !canonical_uuid(id) || !canonical_uuid(session_id) {
        return Err("invalid attachment id".into());
    }
    let source = capture_dir.join(format!("{id}.png"));
    let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > MAX_PROMPT_IMAGE {
        return Err("source is not a bounded regular image file".into());
    }
    let bytes = fs::read(&source).map_err(|error| error.to_string())?;
    let (width, height) = image_dimensions(&bytes)?;
    let name = name
        .filter(|name| !name.is_empty())
        .unwrap_or("Image attachment");
    let attachment_root = app_data_dir.join("attachments");
    let session_dir = attachment_root.join(session_id);
    fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;
    for directory in [&attachment_root, &session_dir] {
        let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("attachment directory is not a regular directory".into());
        }
    }
    set_private_dir(&attachment_root);
    set_private_dir(&session_dir);
    let destination = session_dir.join(format!("{id}.png"));
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() != bytes.len() as u64
        {
            return Err("destination attachment already exists".into());
        }
        if fs::read(&destination).map_err(|error| error.to_string())? != bytes {
            return Err("destination attachment id collision".into());
        }
    } else {
        fs::write(&destination, &bytes).map_err(|error| error.to_string())?;
        set_private_file(&destination);
    }
    Ok(Capture {
        id: id.to_owned(),
        name: name.to_owned(),
        width,
        height,
        bytes: bytes.len() as i64,
        file: format!("{session_id}/{id}.png"),
    })
}

fn image_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let format = image::guess_format(bytes).map_err(|error| error.to_string())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("unsupported image format".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    reader.limits(limits);
    reader.into_dimensions().map_err(|error| error.to_string())
}

#[cfg(unix)]
fn set_private_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn set_private_dir(_: &Path) {}
#[cfg(unix)]
fn set_private_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn set_private_file(_: &Path) {}

#[derive(Debug)]
pub struct ImageBytes {
    pub metadata: Metadata,
    pub bytes: Vec<u8>,
}

/// Resolves a UUID only through a session-owned row; callers must already have refused mirrors.
pub fn load_attachment(
    db: &rusqlite::Connection,
    app_data_dir: &Path,
    session_id: &str,
    id: &str,
) -> Result<ImageBytes, String> {
    if !canonical_uuid(id) || !canonical_uuid(session_id) {
        return Err("Attachment is unavailable.".into());
    }
    let row = db
        .query_row(
            "SELECT id,kind,name,mime,bytes,width,height,file,source,moodboard_id,moodboard_image_id
         FROM message_attachments WHERE session_id=?1 AND id=?2
           AND EXISTS(SELECT 1 FROM messages m WHERE m.id=message_id AND m.session_id=session_id)",
            params![session_id, id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<u32>>(5)?,
                    row.get::<_, Option<u32>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("Attachment is unavailable.")?;
    let (
        id,
        kind,
        name,
        mime,
        stored_bytes,
        width,
        height,
        file,
        source,
        moodboard_id,
        moodboard_image_id,
    ) = row;
    let bytes = u64::try_from(stored_bytes).map_err(|_| "Attachment is unavailable.")?;
    if kind != "image" || !mime.starts_with("image/") {
        return Err("Attachment is unavailable.".into());
    }
    let data = match source.as_str() {
        "file" => {
            let relative = file.ok_or("Attachment is unavailable.")?;
            let expected = PathBuf::from(session_id).join(format!("{id}.png"));
            let relative_path = PathBuf::from(&relative);
            if relative_path != expected
                || !relative_path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err("Attachment is unavailable.".into());
            }
            let attachment_root = app_data_dir.join("attachments");
            let session_dir = attachment_root.join(session_id);
            for directory in [&attachment_root, &session_dir] {
                let metadata =
                    fs::symlink_metadata(directory).map_err(|_| "Attachment is unavailable.")?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("Attachment is unavailable.".into());
                }
            }
            let path = session_dir.join(
                relative_path
                    .file_name()
                    .ok_or("Attachment is unavailable.")?,
            );
            let metadata = fs::symlink_metadata(&path).map_err(|_| "Attachment is unavailable.")?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > MAX_PROMPT_IMAGE
            {
                return Err("Attachment is unavailable.".into());
            }
            let data = fs::read(path).map_err(|_| "Attachment is unavailable.")?;
            if data.len() as u64 != bytes {
                return Err("Attachment is unavailable.".into());
            }
            data
        }
        "moodboard" => {
            let moodboard_id = moodboard_id.ok_or("Attachment is unavailable.")?;
            let moodboard_image_id = moodboard_image_id.ok_or("Attachment is unavailable.")?;
            let data: Vec<u8> = db.query_row(
                "SELECT i.original FROM moodboard_images i JOIN moodboards b ON b.id=i.board_id
                 WHERE i.id=?1 AND b.id=?2 AND EXISTS(
                   SELECT 1 FROM message_attachments a WHERE a.session_id=?3 AND a.id=?4 AND a.source='moodboard'
                     AND a.moodboard_id=b.id AND a.moodboard_image_id=i.id
                     AND EXISTS(SELECT 1 FROM messages m WHERE m.id=a.message_id AND m.session_id=a.session_id)
                 )",
                params![moodboard_image_id, moodboard_id, session_id, id], |row| row.get(0),
            ).optional().map_err(|error| error.to_string())?.ok_or("Attachment is unavailable.")?;
            if data.len() as u64 != bytes || data.len() as u64 > MAX_MOODBOARD_IMAGE {
                return Err("Attachment is unavailable.".into());
            }
            data
        }
        _ => return Err("Attachment is unavailable.".into()),
    };
    Ok(ImageBytes {
        metadata: Metadata {
            id,
            kind,
            name,
            mime,
            bytes,
            width,
            height,
        },
        bytes: data,
    })
}

pub fn variant_bytes(
    bytes: &[u8],
    mime: &str,
    variant: Variant,
) -> Result<(String, Vec<u8>), String> {
    if variant == Variant::Full && bytes.len() <= MAX_SOURCE_BYTES {
        return Ok((mime.to_owned(), bytes.to_vec()));
    }
    let image = decode(bytes)?;
    match variant {
        Variant::Thumb => Ok(("image/jpeg".into(), encode_jpeg_bounded(&image)?)),
        Variant::Full => Ok(("image/jpeg".into(), encode_jpeg(&image, 2048, 84)?)),
    }
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    let format = image::guess_format(bytes)
        .map_err(|_| "This image cannot be decoded for a preview.".to_string())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("This image format cannot be converted to a JPEG preview.".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "This image cannot be decoded for a preview.".into())
}

fn encode_jpeg(image: &DynamicImage, edge: u32, quality: u8) -> Result<Vec<u8>, String> {
    let scaled = if image.width() > edge || image.height() > edge {
        image.resize(edge, edge, FilterType::Lanczos3)
    } else {
        image.clone()
    };
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(&scaled.to_rgb8())
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn encode_jpeg_bounded(image: &DynamicImage) -> Result<Vec<u8>, String> {
    for edge in [480, 400, 320, 240] {
        for quality in [82, 70, 58, 46, 36] {
            let bytes = encode_jpeg(image, edge, quality)?;
            if bytes.len() <= MAX_RAW_CHUNK {
                return Ok(bytes);
            }
        }
    }
    Err("Could not fit the image preview into one Connect chunk.".into())
}

pub fn chunk_reply(bytes: &[u8], mime: &str, offset: u64) -> Result<Value, String> {
    let start = usize::try_from(offset).map_err(|_| "Invalid offset.")?;
    if start > bytes.len() {
        return Err("Invalid offset.".into());
    }
    let end = start.saturating_add(MAX_RAW_CHUNK).min(bytes.len());
    let data = STANDARD.encode(&bytes[start..end]);
    let response = json!({ "mime": mime, "total": bytes.len(), "offset": start, "data": data, "done": end == bytes.len() });
    if response.to_string().len() > MESSAGE_PAGE_BUDGET {
        return Err("Attachment chunk exceeds the Connect reply budget.".into());
    }
    Ok(response)
}

/// Metadata rows for one Connect message, in their original attachment order.
#[cfg(test)]
pub fn message_attachment_rows(
    db: &rusqlite::Connection,
    session_id: &str,
    message_id: i64,
) -> Result<Vec<Value>, String> {
    let mut statement = db
        .prepare(
            "SELECT id,kind,name,mime,bytes,width,height FROM message_attachments
         WHERE session_id=?1 AND message_id=?2 ORDER BY rowid",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![session_id, message_id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?, "kind": row.get::<_, String>(1)?, "name": row.get::<_, String>(2)?,
            "mime": row.get::<_, String>(3)?, "bytes": row.get::<_, i64>(4)?,
            "width": row.get::<_, Option<u32>>(5)?, "height": row.get::<_, Option<u32>>(6)?
        }))
    }).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;
