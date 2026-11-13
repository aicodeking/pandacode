use std::sync::Mutex;

use serde_json::Value;

use super::*;
use crate::storage::Store;
use crate::tool_images_auth::{cached_viewed, session_viewed};

/// A whole 1 × 1 PNG: full-size requests read its header before serving it.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x02\0\0\0\x90\x77\x53\xde\0\0\0\x0cIDAT\x78\xda\x63\x60\x60\x60\0\0\0\x04\0\x01\xc8\xea\xeb\xf9\0\0\0\0IEND\xae\x42\x60\x82";
/// A PNG signature and the start of a header, nothing more.
const TRUNCATED_PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tool-image-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn abs(path: &str) -> Requested {
    Requested::Absolute(PathBuf::from(path))
}

fn rel(path: &str) -> Requested {
    Requested::Relative(PathBuf::from(path))
}

#[test]
fn tool_image_requested_path_rules() {
    assert_eq!(requested_path("/tmp/shot.png").unwrap(), abs("/tmp/shot.png"));
    assert_eq!(requested_path("file:///tmp/Shot.PNG").unwrap(), abs("/tmp/Shot.PNG"));
    assert!(requested_path(" /a/b.JPEG ").is_ok());
    assert!(requested_path("/a/b.webp").is_ok());
    assert!(requested_path("/a/b.gif").is_ok());
    assert_eq!(requested_path("shot.png").unwrap(), rel("shot.png"));
    assert_eq!(requested_path(".pandacode/progress-shots/x.png").unwrap(), rel(".pandacode/progress-shots/x.png"));
    assert_eq!(requested_path("./test-results/a b.png").unwrap(), rel("./test-results/a b.png"));
    assert_eq!(requested_path("~/shot.png").unwrap_err(), ERR_BAD_PATH);
    assert_eq!(requested_path("/tmp/../etc/x.png").unwrap_err(), ERR_BAD_PATH);
    assert_eq!(requested_path("a/../../x.png").unwrap_err(), ERR_BAD_PATH);
    assert_eq!(requested_path("").unwrap_err(), ERR_BAD_PATH);
    assert_eq!(requested_path("/tmp/x.svg").unwrap_err(), ERR_EXTENSION);
    assert_eq!(requested_path("/etc/passwd").unwrap_err(), ERR_EXTENSION);
}

#[test]
fn tool_image_refuses_network_paths() {
    for raw in [
        "\\\\host\\share\\x.png",
        "//host/share/x.png",
        "\\/host/x.png",
        "/\\host/x.png",
        "file:////host/share/x.png",
        "file://host/share/x.png",
        " //x.png",
    ] {
        assert_eq!(requested_path(raw).unwrap_err(), ERR_NETWORK, "{raw}");
    }
    assert!(is_network_path("//a") && is_network_path("\\\\a"));
    assert!(!is_network_path("/a/b.png") && !is_network_path("a//b.png"));
    // Never reaches the record lookup or the disk.
    let asked = std::cell::Cell::new(false);
    let err = load("//host/share/x.png", || { asked.set(true); Ok(PathBuf::from("/")) }, |_| { asked.set(true); Ok(true) }, TOOL_IMAGE_LIMIT);
    assert_eq!(err.unwrap_err(), ERR_NETWORK);
    assert!(!asked.get());
}

#[test]
fn tool_image_private_tmp_spellings() {
    assert_eq!(path_spellings("/tmp/a.png"), vec!["/tmp/a.png", "/private/tmp/a.png"]);
    assert_eq!(path_spellings("/private/tmp/a.png"), vec!["/private/tmp/a.png", "/tmp/a.png"]);
    assert_eq!(path_spellings("/var/folders/a.png"), vec!["/var/folders/a.png", "/private/var/folders/a.png"]);
    assert_eq!(path_spellings("/tmpx/a.png"), vec!["/tmpx/a.png"]);
    assert_eq!(path_spellings("/Users/a.png"), vec!["/Users/a.png"]);
}

#[test]
fn tool_image_magic_bytes() {
    assert_eq!(sniff_image(PNG), Some("image/png"));
    assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
    assert_eq!(sniff_image(b"GIF89a...."), Some("image/gif"));
    assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
    assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVE"), None);
    assert_eq!(sniff_image(b"<svg/>"), None);
    assert_eq!(sniff_image(b""), None);
}

#[test]
fn tool_image_encode_checks_file_bytes_and_size() {
    let dir = temp_dir("encode");
    let png = dir.join("shot.png");
    std::fs::write(&png, PNG).unwrap();
    let url = encode(&png, TOOL_IMAGE_LIMIT).unwrap();
    assert!(url.starts_with("data:image/png;base64,"), "{url}");
    // Content decides the type, whatever the extension says.
    let mislabeled = dir.join("really-png.jpg");
    std::fs::write(&mislabeled, PNG).unwrap();
    assert!(encode(&mislabeled, TOOL_IMAGE_LIMIT).unwrap().starts_with("data:image/png;"));
    let fake = dir.join("fake.png");
    std::fs::write(&fake, b"not an image").unwrap();
    assert_eq!(encode(&fake, TOOL_IMAGE_LIMIT).unwrap_err(), ERR_NOT_IMAGE);
    assert_eq!(encode(&png, 4).unwrap_err(), ERR_TOO_LARGE);
    assert_eq!(encode(&dir.join("gone.png"), TOOL_IMAGE_LIMIT).unwrap_err(), ERR_MISSING);
    let folder = dir.join("folder.png");
    std::fs::create_dir(&folder).unwrap();
    assert_eq!(encode(&folder, TOOL_IMAGE_LIMIT).unwrap_err(), ERR_MISSING);
    #[cfg(unix)]
    {
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, PNG).unwrap();
        let link = dir.join("link.png");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert_eq!(encode(&link, TOOL_IMAGE_LIMIT).unwrap_err(), ERR_EXTENSION);
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

fn named(name: &str, input: Value, output: &str) -> String {
    serde_json::json!({"type": "tool_activity", "version": 1, "name": name, "status": "completed", "input": input, "output": output}).to_string()
}

fn record(input: Value, output: &str) -> String {
    named("Read", input, output)
}

fn absolute_lookup<'a>(store: &'a Mutex<Store>, sid: &'a str, raw: &'a str) -> impl FnOnce(&[String]) -> Result<bool, String> + 'a {
    move |spellings| session_viewed(store, sid, raw, spellings)
}

fn no_root() -> Result<PathBuf, String> {
    Err("no root".into())
}

#[test]
fn tool_image_serves_only_paths_in_the_sessions_tool_records() {
    let dir = temp_dir("records");
    let seen = dir.join("seen.png");
    let unseen = dir.join("unseen.png");
    std::fs::write(&seen, PNG).unwrap();
    std::fs::write(&unseen, PNG).unwrap();
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let session = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    let other = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    let seen_raw = seen.to_string_lossy().into_owned();
    // A JSON string holding JSON, as some harnesses save their input.
    let input = serde_json::json!({"file_path": seen_raw}).to_string();
    store.message(&session.id, "tool", &record(Value::String(input), "")).unwrap();
    let store = Mutex::new(store);
    assert!(load(&seen_raw, no_root, absolute_lookup(&store, &session.id, &seen_raw), TOOL_IMAGE_LIMIT)
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert!(cached_viewed(&session.id, &seen_raw));
    assert!(!cached_viewed(&other.id, &seen_raw));
    assert_eq!(load(&seen_raw, no_root, absolute_lookup(&store, &other.id, &seen_raw), TOOL_IMAGE_LIMIT).unwrap_err(), ERR_NOT_VIEWED);
    let unseen_raw = unseen.to_string_lossy().into_owned();
    assert_eq!(load(&unseen_raw, no_root, absolute_lookup(&store, &session.id, &unseen_raw), TOOL_IMAGE_LIMIT).unwrap_err(), ERR_NOT_VIEWED);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_relative_paths_resolve_inside_the_checkout() {
    let dir = temp_dir("relative");
    let root = dir.join("repo");
    std::fs::create_dir_all(root.join(".pandacode/progress-shots")).unwrap();
    std::fs::create_dir_all(root.join("test-results")).unwrap();
    std::fs::write(root.join(".pandacode/progress-shots/x.png"), PNG).unwrap();
    std::fs::write(root.join("test-results/shot.png"), PNG).unwrap();
    std::fs::write(root.join("unseen.png"), PNG).unwrap();
    std::fs::write(dir.join("outside.png"), PNG).unwrap();
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&root).unwrap();
    let session = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    let sid = session.id.clone();
    for path in [".pandacode/progress-shots/x.png", "./test-results/shot.png", "escape.png"] {
        store.message(&sid, "tool", &record(serde_json::json!({"path": path}), "")).unwrap();
    }
    let store = Mutex::new(store);
    let root_of = || {
        let store = store.lock().unwrap();
        store.workspace_root(&project.id, Some(&sid))
    };
    let get = |raw: &str| load(raw, root_of, |spellings| session_viewed(&store, &sid, raw, spellings), TOOL_IMAGE_LIMIT);
    assert!(get(".pandacode/progress-shots/x.png").unwrap().starts_with("data:image/png;"));
    // `./` or not, the recorded spelling is the same file.
    assert!(get("test-results/shot.png").unwrap().starts_with("data:image/png;"));
    assert_eq!(get("unseen.png").unwrap_err(), ERR_NOT_VIEWED);
    assert_eq!(get("../outside.png").unwrap_err(), ERR_BAD_PATH);
    #[cfg(unix)]
    {
        // A recorded name that is a link out of the checkout is refused.
        std::os::unix::fs::symlink(dir.join("outside.png"), root.join("escape.png")).unwrap();
        assert_eq!(get("escape.png").unwrap_err(), ERR_OUTSIDE);
    }
    assert_eq!(resolve_relative(&root, Path::new("gone.png")).unwrap_err(), ERR_MISSING);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_cached_grant_is_tied_to_the_checkout_root() {
    let dir = temp_dir("cache-root");
    let (first, second) = (dir.join("first"), dir.join("second"));
    for root in [&first, &second] {
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(root.join("cached.png"), PNG).unwrap();
    }
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&first).unwrap();
    let sid = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap().id;
    // Only the first checkout's file is named, as an absolute path.
    store.message(&sid, "tool", &record(serde_json::json!({"file_path": first.join("cached.png")}), "")).unwrap();
    let store = Mutex::new(store);
    let get = |root: &Path| {
        let root = root.to_path_buf();
        load("cached.png", move || Ok(root), |spellings| session_viewed(&store, &sid, "cached.png", spellings), TOOL_IMAGE_LIMIT)
    };
    assert!(get(&first).unwrap().starts_with("data:image/png;"));
    assert!(get(&first).is_ok(), "the cached grant still serves the same file");
    // The same relative request under another root must not reuse the grant.
    assert_eq!(get(&second).unwrap_err(), ERR_NOT_VIEWED);
    assert!(!cached_viewed(&sid, "cached.png"));
    assert!(cached_viewed(&sid, &first.join("cached.png").to_string_lossy()));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_misses_are_cached_until_the_session_gains_a_message() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let sid = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap().id;
    store.message(&sid, "tool", &record(serde_json::json!({"file_path": "/tmp/other.png"}), "")).unwrap();
    let store = Mutex::new(store);
    let path = "/tmp/pandacode-miss-cache.png";
    let spellings = [path.to_owned()];
    assert!(!session_viewed(&store, &sid, path, &spellings).unwrap());
    // Rewriting a record in place adds no message, so the cached miss still answers.
    let named = record(serde_json::json!({"file_path": path}), "");
    store.lock().unwrap().db.execute("UPDATE messages SET content=?1 WHERE session_id=?2", [&named, &sid]).unwrap();
    assert!(!session_viewed(&store, &sid, path, &spellings).unwrap());
    // A new message bypasses the cached miss and the record is found.
    store.lock().unwrap().message(&sid, "assistant", "done").unwrap();
    assert!(session_viewed(&store, &sid, path, &spellings).unwrap());
}

#[test]
fn tool_image_refuses_autofs_network_mounts() {
    for raw in ["/net/host/share/x.png", "/Network/Servers/host/x.png", "/NET/host/x.png", "file:///network/x.png", "/net/x.png"] {
        assert_eq!(requested_path(raw).unwrap_err(), ERR_NETWORK, "{raw}");
    }
    for raw in ["/netx/a.png", "/Users/me/net/a.png", "net/a.png", "/Networks/a.png"] {
        assert!(requested_path(raw).is_ok(), "{raw}");
    }
    assert!(is_autofs_path(Path::new("/net")) && is_autofs_path(Path::new("/Network")));
    assert!(!is_autofs_path(Path::new("/tmp/net/a.png")));
}

#[test]
fn tool_image_full_size_checks_dimensions_before_serving() {
    let dir = temp_dir("full-size");
    // A valid PNG header claiming 100000 × 100000 pixels: a full-size request is refused too.
    let mut bomb = png_of(1, 1, false);
    let ihdr = 12;
    bomb[ihdr + 4..ihdr + 8].copy_from_slice(&100_000u32.to_be_bytes());
    bomb[ihdr + 8..ihdr + 12].copy_from_slice(&100_000u32.to_be_bytes());
    let crc = crc32(&bomb[ihdr..ihdr + 17]);
    bomb[ihdr + 17..ihdr + 21].copy_from_slice(&crc.to_be_bytes());
    let path = dir.join("bomb.png");
    std::fs::write(&path, &bomb).unwrap();
    let raw = path.to_string_lossy().into_owned();
    assert_eq!(load_sized(&raw, no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, None).unwrap_err(), ERR_DIMENSIONS);
    // Within each side but too many pixels in all.
    assert_eq!(checked_dimensions(MAX_DECODE_SIDE, MAX_DECODE_SIDE), Err(ERR_DIMENSIONS.to_owned()));
    assert_eq!(checked_dimensions(MAX_DECODE_SIDE + 1, 1), Err(ERR_DIMENSIONS.to_owned()));
    assert_eq!(checked_dimensions(4000, 3000), Ok(()));
    // A header that does not parse is refused rather than handed to the webview.
    let truncated = dir.join("truncated.png");
    std::fs::write(&truncated, TRUNCATED_PNG).unwrap();
    assert_eq!(load_sized(&truncated.to_string_lossy(), no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, None).unwrap_err(), ERR_UNDECODABLE);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_relative_spellings() {
    let spellings = relative_spellings(Path::new("./a/b.png"), Path::new("/w"));
    assert_eq!(spellings, vec!["./a/b.png", "a/b.png", "/w/a/b.png"]);
    let spellings = relative_spellings(Path::new("b.png"), Path::new("/tmp/w"));
    assert_eq!(spellings, vec!["b.png", "./b.png", "/tmp/w/b.png", "/private/tmp/w/b.png"]);
}

fn png_of(width: u32, height: u32, alpha: bool) -> Vec<u8> {
    let image = if alpha { image::DynamicImage::new_rgba8(width, height) } else { image::DynamicImage::new_rgb8(width, height) };
    let mut out = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
    out
}

fn decoded(url: &str) -> image::DynamicImage {
    use base64::Engine;
    let (_, data) = url.split_once(";base64,").unwrap();
    image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap()
}

/// CRC-32 (PNG chunk checksum), for hand-built headers.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

#[test]
fn tool_image_downscales_to_the_longest_edge() {
    let wide = downscaled(&png_of(800, 400, false), "image/png", 160).unwrap();
    assert!(wide.starts_with("data:image/jpeg;base64,"), "{wide}");
    let small = decoded(&wide);
    assert_eq!((small.width(), small.height()), (160, 80));
    let tall = decoded(&downscaled(&png_of(300, 900, true), "image/png", 640).unwrap());
    assert_eq!((tall.width(), tall.height()), (213, 640));
    // Transparency survives as PNG.
    assert!(downscaled(&png_of(300, 900, true), "image/png", 160).unwrap().starts_with("data:image/png;"));
    // Already small enough: the original bytes, untouched.
    let tiny = png_of(40, 20, false);
    assert_eq!(downscaled(&tiny, "image/png", 160).unwrap(), data_url("image/png", &tiny));
    // A silly edge is clamped rather than trusted.
    let clamped = decoded(&downscaled(&png_of(4000, 100, false), "image/png", u32::MAX).unwrap());
    assert_eq!(clamped.width(), MAX_EDGE);
    assert_eq!(downscaled(TRUNCATED_PNG, "image/png", 160).unwrap_err(), ERR_UNDECODABLE);
}

/// A JPEG of `width` × `height` stored pixels carrying EXIF `orientation`.
fn jpeg_with_orientation(width: u32, height: u32, orientation: u8) -> Vec<u8> {
    let mut plain = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut plain).encode_image(&image::DynamicImage::new_rgb8(width, height)).unwrap();
    // APP1 "Exif": a big-endian TIFF header and one IFD entry, 0x0112 SHORT.
    let tiff = [b"MM\0\x2A\0\0\0\x08".as_slice(), &[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0], &[0; 4]].concat();
    let length = u16::try_from(2 + 6 + tiff.len()).unwrap().to_be_bytes();
    [&plain[..2], &[0xFF, 0xE1], &length, b"Exif\0\0", &tiff, &plain[2..]].concat()
}

#[test]
fn tool_image_downscaled_jpegs_are_upright() {
    // Orientation 6: stored 800 × 400, shown rotated a quarter turn, 400 × 800.
    let turned = decoded(&downscaled(&jpeg_with_orientation(800, 400, 6), "image/jpeg", 160).unwrap());
    assert_eq!((turned.width(), turned.height()), (80, 160));
    let upright = decoded(&downscaled(&jpeg_with_orientation(800, 400, 1), "image/jpeg", 160).unwrap());
    assert_eq!((upright.width(), upright.height()), (160, 80));
}

#[test]
fn tool_image_refuses_decompression_bombs() {
    // A valid PNG header claiming 100000 × 100000 pixels: never decoded.
    let mut bomb = png_of(1, 1, false);
    let ihdr = 12; // signature (8) + length (4)
    bomb[ihdr + 4..ihdr + 8].copy_from_slice(&100_000u32.to_be_bytes());
    bomb[ihdr + 8..ihdr + 12].copy_from_slice(&100_000u32.to_be_bytes());
    let crc = crc32(&bomb[ihdr..ihdr + 17]);
    bomb[ihdr + 17..ihdr + 21].copy_from_slice(&crc.to_be_bytes());
    assert_eq!(downscaled(&bomb, "image/png", 160).unwrap_err(), ERR_UNDECODABLE);
}

#[test]
fn tool_image_sized_requests_apply_the_pixel_cap_before_decoding() {
    // 9000 × 9000 is within each side but 81 MP: refused from the header, never decoded.
    let mut bomb = png_of(1, 1, false);
    let ihdr = 12;
    bomb[ihdr + 4..ihdr + 8].copy_from_slice(&9_000u32.to_be_bytes());
    bomb[ihdr + 8..ihdr + 12].copy_from_slice(&9_000u32.to_be_bytes());
    let crc = crc32(&bomb[ihdr..ihdr + 17]);
    bomb[ihdr + 17..ihdr + 21].copy_from_slice(&crc.to_be_bytes());
    assert_eq!(downscaled(&bomb, "image/png", 160).unwrap_err(), ERR_DIMENSIONS);
    // A very large source is resized to a smaller edge so resize buffers stay bounded.
    assert_eq!(decode_edge(8000, 6000, MAX_EDGE), LARGE_SOURCE_EDGE);
    assert_eq!(decode_edge(8000, 6000, 320), 320);
    assert_eq!(decode_edge(4000, 3000, MAX_EDGE), MAX_EDGE);
}

/// Noise pixels, which no codec squeezes much.
fn noisy_png(width: u32, height: u32) -> Vec<u8> {
    let mut seed = 0x2545_F491_u32;
    let image = image::RgbImage::from_fn(width, height, |_, _| {
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed.to_le_bytes()[0]
        };
        image::Rgb([next(), next(), next()])
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
    out
}

#[test]
fn tool_image_heavy_images_that_fit_are_reencoded() {
    let heavy = noisy_png(500, 500);
    assert!(heavy.len() > REENCODE_ABOVE, "{}", heavy.len());
    let url = downscaled(&heavy, "image/png", 640).unwrap();
    assert!(url.starts_with("data:image/jpeg;base64,"), "{}", &url[..32]);
    assert!(url.len() < data_url("image/png", &heavy).len());
    let same = decoded(&url);
    assert_eq!((same.width(), same.height()), (500, 500));
    // A light image that fits is still returned untouched.
    let light = png_of(500, 500, false);
    assert!(light.len() <= REENCODE_ABOVE);
    assert_eq!(downscaled(&light, "image/png", 640).unwrap(), data_url("image/png", &light));
}

#[cfg(unix)]
#[test]
fn tool_image_fifo_is_refused_without_blocking() {
    let dir = temp_dir("fifo");
    let fifo = dir.join("pipe.png");
    let c_path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    // SAFETY: a valid NUL-terminated path and a plain mode.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let (done, wait) = std::sync::mpsc::channel();
    let path = fifo.clone();
    std::thread::spawn(move || {
        let _ = done.send(encode(&path, TOOL_IMAGE_LIMIT));
    });
    let result = wait.recv_timeout(std::time::Duration::from_secs(5)).expect("opening a FIFO must not block");
    assert_eq!(result.unwrap_err(), ERR_MISSING);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_refuses_sessions_on_another_machine() {
    use crate::tool_images_auth::ensure_on_this_machine;
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let local = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    let mirrored = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    let cloud = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    store.db.execute("UPDATE sessions SET remote_device='host',remote_session='h1' WHERE id=?1", [&mirrored.id]).unwrap();
    store.db.execute("UPDATE sessions SET cloud='{}' WHERE id=?1", [&cloud.id]).unwrap();
    let store = Mutex::new(store);
    assert_eq!(ensure_on_this_machine(&store, &local.id), Ok(()));
    assert_eq!(ensure_on_this_machine(&store, &mirrored.id).unwrap_err(), ERR_ELSEWHERE);
    assert_eq!(ensure_on_this_machine(&store, &cloud.id).unwrap_err(), ERR_ELSEWHERE);
    assert!(ensure_on_this_machine(&store, "missing").is_err());
}

#[test]
fn tool_image_sized_loads_authorize_before_decoding() {
    let dir = temp_dir("sized");
    let shot = dir.join("big.png");
    std::fs::write(&shot, png_of(1200, 600, false)).unwrap();
    let raw = shot.to_string_lossy().into_owned();
    let thumb = load_sized(&raw, no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, Some(160)).unwrap();
    assert_eq!(decoded(&thumb).width(), 160);
    let full = load_sized(&raw, no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, None).unwrap();
    assert_eq!(decoded(&full).width(), 1200);
    assert_eq!(load_sized(&raw, no_root, |_| Ok(false), TOOL_IMAGE_LIMIT, Some(160)).unwrap_err(), ERR_NOT_VIEWED);
    // The size limit still applies before any decoding.
    assert_eq!(load_sized(&raw, no_root, |_| Ok(true), 16, Some(160)).unwrap_err(), ERR_TOO_LARGE);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[test]
fn tool_image_links_into_network_mounts_are_refused_before_resolution() {
    use std::os::unix::fs::symlink;
    let dir = temp_dir("autofs-links");
    // Never created or mounted: refusal must come from the link text alone.
    symlink("/net/pandacode-test.invalid/share/x.png", dir.join("net.png")).unwrap();
    symlink("/NETWORK/Servers/h/x.png", dir.join("network.png")).unwrap();
    symlink("//pandacode-test.invalid/share/x.png", dir.join("unc.png")).unwrap();
    symlink("\\\\pandacode-test.invalid\\x.png", dir.join("backslash.png")).unwrap();
    // A chain: a relative hop to a link that points into /net.
    symlink("net.png", dir.join("chain.png")).unwrap();
    // A folder link into an automount, then a file under it.
    symlink("/Network/Servers", dir.join("mnt")).unwrap();
    // A relative target that climbs to the root and into /net.
    let climbs = format!("{}net/h/x.png", "../".repeat(dir.components().count() + 1));
    symlink(&climbs, dir.join("climb.png")).unwrap();
    for name in ["net.png", "network.png", "unc.png", "backslash.png", "chain.png", "mnt/h/x.png", "climb.png"] {
        let path = dir.join(name);
        assert_eq!(refuse_network_hops(&path).unwrap_err(), ERR_NETWORK, "{name}");
        assert_eq!(encode(&path, TOOL_IMAGE_LIMIT).unwrap_err(), ERR_NETWORK, "{name}");
    }
    // A relative request whose recorded name links into /net is refused too.
    assert_eq!(resolve_relative(&dir, Path::new("chain.png")).unwrap_err(), ERR_NETWORK);
    assert_eq!(load("net.png", || Ok(dir.clone()), |_| Ok(true), TOOL_IMAGE_LIMIT).unwrap_err(), ERR_NETWORK);
    // Ordinary links still resolve.
    std::fs::write(dir.join("real.png"), PNG).unwrap();
    symlink("real.png", dir.join("plain.png")).unwrap();
    assert!(refuse_network_hops(&dir.join("plain.png")).is_ok());
    assert!(encode(&dir.join("plain.png"), TOOL_IMAGE_LIMIT).unwrap().starts_with("data:image/png;"));
    // A missing file is not a network path; a link loop ends.
    assert!(refuse_network_hops(&dir.join("gone.png")).is_ok());
    symlink("loop-b.png", dir.join("loop-a.png")).unwrap();
    symlink("loop-a.png", dir.join("loop-b.png")).unwrap();
    assert_eq!(refuse_network_hops(&dir.join("loop-a.png")).unwrap_err(), ERR_MISSING);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[test]
fn tool_image_opens_without_following_a_final_link() {
    let dir = temp_dir("no-follow");
    let real = dir.join("real.png");
    std::fs::write(&real, PNG).unwrap();
    let link = dir.join("link.png");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // A link swapped in for the canonical name is never followed by the open.
    assert!(open_no_follow(&link).is_err());
    let file = open_no_follow(&real).unwrap();
    assert_eq!(opened_path(&file).unwrap(), real);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_opened_file_must_stay_in_the_checkout() {
    let dir = temp_dir("opened-within");
    let (root, elsewhere) = (dir.join("repo"), dir.join("elsewhere"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("x.png"), PNG).unwrap();
    std::fs::write(root.join("x.png"), PNG).unwrap();
    let file = open_no_follow(&elsewhere.join("x.png")).unwrap();
    assert_eq!(check_opened(&file, Some(&root)).unwrap_err(), ERR_OUTSIDE);
    assert!(check_opened(&file, None).is_ok());
    let inside = open_no_follow(&root.join("x.png")).unwrap();
    assert!(check_opened(&inside, Some(&root)).is_ok());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A GIF with a `width` × `height` canvas and `frames` 1 × 1 frames (each a
/// graphic control extension and an image descriptor with valid LZW data).
fn gif_frames(width: u16, height: u16, frames: usize) -> Vec<u8> {
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&width.to_le_bytes());
    gif.extend_from_slice(&height.to_le_bytes());
    // A two-entry global color table.
    gif.extend_from_slice(&[0x80, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF]);
    // NETSCAPE2.0 looping extension.
    gif.extend_from_slice(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\0\0\0");
    for _ in 0..frames {
        gif.extend_from_slice(&[0x21, 0xF9, 4, 0, 1, 0, 0, 0]);
        gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
        gif.extend_from_slice(&[2, 2, 0x44, 0x01, 0]);
    }
    gif.push(0x3B);
    gif
}

/// A WebP RIFF with a VP8X canvas and `frames` (empty) ANMF chunks.
fn webp_frames(width: u32, height: u32, frames: usize) -> Vec<u8> {
    let mut body = b"WEBP".to_vec();
    body.extend_from_slice(b"VP8X");
    body.extend_from_slice(&10u32.to_le_bytes());
    body.extend_from_slice(&[0x02, 0, 0, 0]);
    body.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    body.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    body.extend_from_slice(b"ANIM\x06\0\0\0\0\0\0\0\0\0");
    for _ in 0..frames {
        // An odd-sized chunk is padded to an even length.
        body.extend_from_slice(b"ANMF\x11\0\0\0");
        body.extend_from_slice(&[0; 18]);
    }
    let mut webp = b"RIFF".to_vec();
    webp.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
    webp.extend_from_slice(&body);
    webp
}

/// `PNG` with an `acTL` declaring `declared` frames and `controls` `fcTL` chunks
/// (CRCs are not checked when counting).
fn apng(declared: u32, controls: usize) -> Vec<u8> {
    let mut apng = PNG[..33].to_vec();
    apng.extend_from_slice(b"\0\0\0\x08acTL");
    apng.extend_from_slice(&declared.to_be_bytes());
    apng.extend_from_slice(&[0; 8]);
    let (before, after) = PNG[33..].split_at(PNG.len() - 33 - 12);
    apng.extend_from_slice(before);
    for _ in 0..controls {
        apng.extend_from_slice(b"\0\0\0\x1AfcTL");
        apng.extend_from_slice(&[0; 30]);
    }
    apng.extend_from_slice(after);
    apng
}

#[test]
fn tool_image_counts_animation_frames_from_the_container() {
    assert_eq!(animation_frames(&gif_frames(4, 4, 1), "image/gif"), 1);
    assert_eq!(animation_frames(&gif_frames(4, 4, 37), "image/gif"), 37);
    // A truncated GIF counts the frames it has.
    let gif = gif_frames(4, 4, 5);
    assert_eq!(animation_frames(&gif[..gif.len() - 12], "image/gif"), 4);
    assert_eq!(animation_frames(&webp_frames(8, 8, 1), "image/webp"), 1);
    assert_eq!(animation_frames(&webp_frames(8, 8, 300), "image/webp"), 300);
    assert_eq!(animation_frames(PNG, "image/png"), 1);
    assert_eq!(animation_frames(b"\xFF\xD8\xFF", "image/jpeg"), 1);
    // An APNG's frames are its `fcTL` chunks, whatever its `acTL` declares.
    assert_eq!(animation_frames(&apng(500, 0), "image/png"), 1);
    assert_eq!(animation_frames(&apng(1, 300), "image/png"), 300);
    assert_eq!(animation_frames(&apng(2, 2), "image/png"), 2);
    assert_eq!(checked_animation(1024, 1024, 256), Ok(()));
    assert_eq!(checked_animation(1024, 1024, 257), Err(ERR_ANIMATION.to_owned()));
}

#[test]
fn tool_image_full_size_refuses_animations_with_too_many_frames() {
    let dir = temp_dir("frames");
    // A 2048 × 2048 canvas is 4 megapixels; 65 frames are over 256 megapixel-frames.
    let many = dir.join("many.gif");
    std::fs::write(&many, gif_frames(2048, 2048, 65)).unwrap();
    assert_eq!(load_sized(&many.to_string_lossy(), no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, None).unwrap_err(), ERR_ANIMATION);
    let few = dir.join("few.gif");
    std::fs::write(&few, gif_frames(2048, 2048, 64)).unwrap();
    assert!(load_sized(&few.to_string_lossy(), no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, None).unwrap().starts_with("data:image/gif;base64,"));
    // A thumbnail decodes only the first frame, so it is still served.
    assert!(load_sized(&many.to_string_lossy(), no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, Some(64)).is_ok());
    // A sized request the animation fits and whose file is small never gets the
    // original bytes back when they are over the animation budget: only its first frame.
    let card = load_sized(&many.to_string_lossy(), no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, Some(2048)).unwrap();
    assert!(!card.starts_with("data:image/gif"), "{}", &card[..32]);
    assert_eq!(decoded(&card).width(), 2048);
    let fine = load_sized(&few.to_string_lossy(), no_root, |_| Ok(true), TOOL_IMAGE_LIMIT, Some(2048)).unwrap();
    assert!(fine.starts_with("data:image/gif;base64,"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_refuses_files_on_mounted_network_filesystems() {
    assert!(is_local_mount(MNT_LOCAL));
    assert!(is_local_mount(MNT_LOCAL | 0x1));
    assert!(!is_local_mount(0));
    assert!(!is_local_mount(0x1 | 0x0010_0000));
    for magic in [0x6969, 0x517B, 0xFF53_4D42, 0xFE53_4D42] {
        assert!(is_network_magic(magic), "{magic:#x}");
    }
    // ext4, btrfs, tmpfs, FUSE are not network filesystems.
    for magic in [0xEF53, 0x9123_683E, 0x0102_1994, 0x6573_5546] {
        assert!(!is_network_magic(magic), "{magic:#x}");
    }
    assert_eq!(stat_magic(0xFF53_4D42), 0xFF53_4D42);
    assert_eq!(stat_magic(i64::from(0xFF53_4D42u32 as i32)), 0xFF53_4D42);
    // A file on the local temporary folder is local.
    let dir = temp_dir("local-fs");
    let file = dir.join("a.png");
    std::fs::write(&file, PNG).unwrap();
    assert!(!on_network_filesystem(&File::open(&file).unwrap()));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tool_image_decode_slots_bound_concurrency() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let slots = Arc::new(DecodeSlots::new(2));
    let (inside, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let (slots, inside, peak) = (slots.clone(), inside.clone(), peak.clone());
            std::thread::spawn(move || {
                let _slot = slots.acquire();
                let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(20));
                inside.fetch_sub(1, Ordering::SeqCst);
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(peak.load(Ordering::SeqCst), 2);
    // Every slot comes back: a fresh pair can still be taken at once.
    let (_a, _b) = (slots.acquire(), slots.acquire());
    assert!(DECODE_SLOTS.capacity <= 3);
}

fn with_status(name: &str, status: &str, input: Value, output: &str) -> String {
    serde_json::json!({"type": "tool_activity", "version": 1, "name": name, "status": status, "input": input, "output": output}).to_string()
}

#[test]
fn tool_image_only_completed_unrefused_records_authorize() {
    let spellings = [String::from("/tmp/shot.png")];
    let input = serde_json::json!({"file_path": "/tmp/shot.png"});
    let names = |record: String| crate::tool_images_auth::records_name_path(&[record], &spellings, false);
    assert!(names(with_status("Read", "completed", input.clone(), "ok")));
    let denied = "Permission to use Read with file_path /tmp/shot.png has been denied.";
    assert!(!names(with_status("Read", "failed", input.clone(), denied)));
    assert!(!names(with_status("Read", "denied", input.clone(), denied)));
    assert!(!names(with_status("Read", "failed", input.clone(), "boom")));
    assert!(!names(with_status("Read", "running", input.clone(), "")));
    for refusal in [
        denied,
        "<tool_use_error>Blocked by hook</tool_use_error>",
        "The user doesn't want to proceed with this tool use.",
        "[Request interrupted by user]",
        "[PandaCode was interrupted before this finished]",
    ] {
        assert!(!names(with_status("Read", "completed", input.clone(), refusal)), "{refusal}");
    }
    assert!(!names(with_status("screenshot", "failed", Value::Null, "Saved to /tmp/shot.png")));
    assert!(!names(with_status("Read", "failed", Value::String("/tmp/shot.png".into()), "")));
}
