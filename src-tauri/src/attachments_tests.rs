use super::*;
use image::{ImageFormat, Rgba, RgbaImage};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pandacode-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let image = RgbaImage::from_pixel(width, height, Rgba([255, 10, 20, 255]));
    let mut bytes = Vec::new();
    DynamicImage::ImageRgba8(image)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .unwrap();
    bytes
}

fn task(store: &Store, root: &Path) -> String {
    let project_dir = root.join(format!("project-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&project_dir).unwrap();
    let project = store.add_project(&project_dir).unwrap();
    store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap()
        .id
}

#[test]
fn linking_copies_capture_and_persists_metadata_in_a_temp_directory() {
    let root = temp_dir("attachment-link");
    let store = Store::open(&root.join("db.sqlite3")).unwrap();
    let session = task(&store, &root);
    let message = store
        .start_turn_message(&session, "Attached image: cabin.png (8 × 4)")
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let captures = root.join("cache/browser-captures");
    fs::create_dir_all(&captures).unwrap();
    fs::write(captures.join(format!("{id}.png")), png(8, 4)).unwrap();
    let linked = link_message_attachments(
        &store,
        &session,
        message,
        "Attached image: cabin.png (8 × 4)",
        std::slice::from_ref(&id),
        &captures,
        &root.join("data"),
    )
    .unwrap();
    assert_eq!(linked, 1);
    let item = message_attachment_rows(&store.db, &session, message).unwrap();
    assert_eq!(item[0]["id"], id);
    assert_eq!(item[0]["name"], "cabin.png");
    assert_eq!(item[0]["width"].as_u64(), Some(8));
    assert_eq!(item[0]["height"].as_u64(), Some(4));
    assert!(root
        .join(format!("data/attachments/{session}/{id}.png"))
        .is_file());
    let loaded = load_attachment(&store.db, &root.join("data"), &session, &id).unwrap();
    assert_eq!(loaded.bytes, png(8, 4));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn refuses_foreign_ids_and_foreign_sessions() {
    let root = temp_dir("attachment-owner");
    let store = Store::open(&root.join("db.sqlite3")).unwrap();
    let session = task(&store, &root);
    let foreign = task(&store, &root);
    let message = store
        .start_turn_message(&session, "Attached image: shot.png")
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let captures = root.join("cache");
    fs::create_dir_all(&captures).unwrap();
    fs::write(captures.join(format!("{id}.png")), png(2, 2)).unwrap();
    link_message_attachments(
        &store,
        &session,
        message,
        "Attached image: shot.png",
        std::slice::from_ref(&id),
        &captures,
        &root.join("data"),
    )
    .unwrap();
    assert!(load_attachment(
        &store.db,
        &root.join("data"),
        &session,
        &uuid::Uuid::new_v4().to_string()
    )
    .is_err());
    assert!(load_attachment(&store.db, &root.join("data"), &foreign, &id).is_err());
    assert!(
        load_attachment(&store.db, &root.join("data"), &session, "../../etc/passwd").is_err()
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn thumbnail_is_jpeg_with_a_long_edge_no_larger_than_480() {
    let (mime, bytes) = variant_bytes(&png(128, 64), "image/png", Variant::Thumb).unwrap();
    assert_eq!(mime, "image/jpeg");
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (128, 64));
    assert!(decoded.width().max(decoded.height()) <= 480);
    assert!(bytes.len() <= MAX_RAW_CHUNK);
}

#[test]
fn chunks_are_limited_and_fit_the_encrypted_reply_budget() {
    let bytes = vec![7u8; MAX_RAW_CHUNK + 100];
    let first = chunk_reply(&bytes, "image/png", 0).unwrap();
    let second = chunk_reply(&bytes, "image/png", MAX_RAW_CHUNK as u64).unwrap();
    assert_eq!(
        STANDARD
            .decode(first["data"].as_str().unwrap())
            .unwrap()
            .len(),
        MAX_RAW_CHUNK
    );
    assert_eq!(
        STANDARD
            .decode(second["data"].as_str().unwrap())
            .unwrap()
            .len(),
        100
    );
    assert!(first.to_string().len() <= MESSAGE_PAGE_BUDGET);
    assert_eq!(first["done"], false);
    assert_eq!(second["done"], true);
    assert!(chunk_reply(&bytes, "image/png", bytes.len() as u64 + 1).is_err());
}

#[test]
fn moodboard_blobs_are_linked_without_copying_the_original() {
    let root = temp_dir("attachment-moodboard");
    let store = Store::open(&root.join("db.sqlite3")).unwrap();
    let session = task(&store, &root);
    let message = store.start_turn_message(&session, "The user attached these project moodboards:\n- Board (moodboard ID: board-id, 1 images)").unwrap();
    let project: String = store
        .db
        .query_row(
            "SELECT project_id FROM sessions WHERE id=?1",
            [&session],
            |row| row.get(0),
        )
        .unwrap();
    let board = uuid::Uuid::new_v4().to_string();
    let image_id = uuid::Uuid::new_v4().to_string();
    store.db.execute("INSERT INTO moodboards(id,project_id,name,created_at,updated_at) VALUES(?1,?2,'Board',1,1)", params![board,project]).unwrap();
    store.db.execute("INSERT INTO moodboard_images(id,board_id,name,caption,mime_type,width,height,original,thumbnail,agent_image,created_at) VALUES(?1,?2,'board.png','', 'image/png',2,2,?3,?3,?3,1)", params![image_id,board,png(2,2)]).unwrap();
    let content = format!("(moodboard ID: {board})");
    assert_eq!(
        link_message_attachments(
            &store,
            &session,
            message,
            &content,
            &[],
            &root,
            &root.join("data")
        )
        .unwrap(),
        1
    );
    let stored_board: String = store
        .db
        .query_row(
            "SELECT moodboard_id FROM message_attachments WHERE session_id=?1 AND id=?2",
            params![session, image_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_board, board);
    let loaded = load_attachment(&store.db, &root.join("data"), &session, &image_id).unwrap();
    assert_eq!(loaded.bytes, png(2, 2));
    assert!(!root
        .join(format!("data/attachments/{session}/{image_id}.png"))
        .exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn image_id_and_variant_validation_are_strict() {
    assert!(!canonical_uuid("../file.png"));
    assert_eq!(Variant::parse("thumb"), Ok(Variant::Thumb));
    assert_eq!(Variant::parse("full"), Ok(Variant::Full));
    assert!(Variant::parse("path").is_err());
}
#[test]
fn a_sqlite_rollback_stops_linking_instead_of_writing_later_rows_alone() {
    let root = temp_dir("attachment-rollback");
    let store = Store::open(&root.join("db.sqlite3")).unwrap();
    let session = task(&store, &root);
    let message = store.start_turn_message(&session, "Three images").unwrap();
    let captures = root.join("cache");
    fs::create_dir_all(&captures).unwrap();
    let ids: Vec<String> = (0..3).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    for id in &ids {
        fs::write(captures.join(format!("{id}.png")), png(2, 2)).unwrap();
    }
    store
        .db
        .execute_batch(&format!(
            "CREATE TRIGGER roll_back_second BEFORE INSERT ON message_attachments
             WHEN NEW.id='{}' BEGIN SELECT RAISE(ROLLBACK, 'simulated rollback'); END;",
            ids[1]
        ))
        .unwrap();
    let result = link_message_attachments(&store, &session, message, "Three images", &ids, &captures, &root.join("data"));
    let error = result.unwrap_err();
    assert!(error.contains("simulated rollback"), "{error}");
    assert!(store.db.is_autocommit());
    // The first row went with the rollback and the third was never written on its own.
    let rows: i64 = store
        .db
        .query_row("SELECT COUNT(*) FROM message_attachments WHERE message_id=?1", [message], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
    let _ = fs::remove_dir_all(root);
}

static FAIL_FIRST_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Gives up on the first busy episode (so `BEGIN IMMEDIATE` fails before the transaction
/// starts), then waits normally so the row-by-row fallback gets the lock once it is free.
fn fail_first_busy(attempt: i32) -> bool {
    if FAIL_FIRST_BUSY.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    std::thread::sleep(std::time::Duration::from_millis(10));
    attempt < 1000
}

#[test]
fn a_busy_write_lock_falls_back_to_linking_row_by_row() {
    let root = temp_dir("attachment-busy");
    let db_path = root.join("db.sqlite3");
    let store = Store::open(&db_path).unwrap();
    let session = task(&store, &root);
    let message = store.start_turn_message(&session, "Two images").unwrap();
    let captures = root.join("cache");
    fs::create_dir_all(&captures).unwrap();
    let ids: Vec<String> = (0..2).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    for id in &ids {
        fs::write(captures.join(format!("{id}.png")), png(2, 2)).unwrap();
    }
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let other = rusqlite::Connection::open(&db_path).unwrap();
        other.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked_tx.send(()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        other.execute_batch("COMMIT").unwrap();
    });
    locked_rx.recv().unwrap();
    store.db.busy_handler(Some(fail_first_busy)).unwrap();
    let linked = link_message_attachments(&store, &session, message, "Two images", &ids, &captures, &root.join("data"));
    holder.join().unwrap();
    assert_eq!(linked, Ok(2));
    assert!(!FAIL_FIRST_BUSY.load(std::sync::atomic::Ordering::SeqCst), "the transaction never hit the lock");
    assert!(store.db.is_autocommit());
    assert_eq!(message_attachment_rows(&store.db, &session, message).unwrap().len(), 2);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_lock_message_raised_inside_the_transaction_is_not_retried_row_by_row() {
    let root = temp_dir("attachment-in-tx-lock");
    let store = Store::open(&root.join("db.sqlite3")).unwrap();
    let session = task(&store, &root);
    let message = store.start_turn_message(&session, "Two images").unwrap();
    let captures = root.join("cache");
    fs::create_dir_all(&captures).unwrap();
    let ids: Vec<String> = (0..2).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    for id in &ids {
        fs::write(captures.join(format!("{id}.png")), png(2, 2)).unwrap();
    }
    // The error text looks like a lock error, but it comes after `BEGIN IMMEDIATE` succeeded.
    store
        .db
        .execute_batch(&format!(
            "CREATE TRIGGER fail_second BEFORE INSERT ON message_attachments
             WHEN NEW.id='{}' BEGIN SELECT RAISE(ROLLBACK, 'database is locked'); END;",
            ids[1]
        ))
        .unwrap();
    let result = link_message_attachments(&store, &session, message, "Two images", &ids, &captures, &root.join("data"));
    let error = result.unwrap_err();
    assert!(error.contains("database is locked"), "{error}");
    assert!(store.db.is_autocommit());
    // A row-by-row retry would have committed the first row on its own.
    let rows: i64 = store
        .db
        .query_row("SELECT COUNT(*) FROM message_attachments WHERE message_id=?1", [message], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
    let _ = fs::remove_dir_all(root);
}
