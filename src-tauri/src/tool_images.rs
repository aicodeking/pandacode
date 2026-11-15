//! Images an agent looked at during a task (a Read of `/tmp/shot.png`, Codex
//! `imageView`, Kimi `Reading media: <path>`, a progress snapshot under
//! `.pandacode/progress-shots/`), shown inline on the tool row.
//!
//! Absolute paths usually live outside the task checkout, so `workspace_image`
//! cannot serve them; relative paths are resolved against the task's checkout and
//! must stay inside it. Either way a path is served only when one of the session's
//! own tool records names it in an image-bearing place (`tool_images_auth`), it is a
//! PNG/JPEG/GIF/WebP whose bytes really are that image, and it is at most 25 MB.
//! Network paths (`\\host\share`, `//host/share`, the `/net` and `/Network`
//! automounts) are never opened.
//!
//! Thumbnails ask with a longest edge (`load_sized`): once the path is authorized
//! the image is decoded under `image::Limits` and returned downscaled, so rows and
//! cards never hold the full bytes; only the viewer asks for the whole image, whose
//! header is read first so an image too large to decode is refused there too, and
//! whose frames (GIF, animated WebP, APNG) are counted from the container so an
//! animation with too many canvas pixels in all is refused as well.

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Largest viewed image returned to the webview.
pub const TOOL_IMAGE_LIMIT: u64 = 25 * 1024 * 1024;

pub const ERR_BAD_PATH: &str = "This image path cannot be shown";
pub const ERR_NETWORK: &str = "Network image paths are not shown";
pub const ERR_OUTSIDE: &str = "The image is outside this task's folder";
pub const ERR_EXTENSION: &str = "Only PNG, JPEG, GIF and WebP images can be shown";
pub const ERR_NOT_VIEWED: &str = "This image was not viewed in this task";
pub const ERR_MISSING: &str = "The image is missing or not a regular file";
pub const ERR_TOO_LARGE: &str = "The image is larger than 25 MB";
pub const ERR_NOT_IMAGE: &str = "The file is not a PNG, JPEG, GIF or WebP image";
pub const ERR_UNDECODABLE: &str = "The image could not be read";
pub const ERR_ELSEWHERE: &str = "This image is on another machine";
pub const ERR_DIMENSIONS: &str = "The image is too large to show (over 16384 pixels on a side or 64 megapixels)";
pub const ERR_ANIMATION: &str = "The animation is too large to show (over 256 megapixels across its frames)";

/// The longest edge a downscaled request may ask for, clamped to this range.
pub const MIN_EDGE: u32 = 16;
pub const MAX_EDGE: u32 = 2048;
/// Decompression-bomb guard: images wider or taller than this, or needing more
/// memory than `MAX_DECODE_ALLOC` to decode, are never decoded.
const MAX_DECODE_SIDE: u32 = 16_384;
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;
/// The most pixels an image the viewer shows whole may have (4 bytes each fills
/// `MAX_DECODE_ALLOC`), so the webview never decodes a bomb either.
const MAX_DECODE_PIXELS: u64 = MAX_DECODE_ALLOC / 4;
/// The most canvas pixels summed over an animation's frames (GIF, animated WebP,
/// APNG) the viewer shows whole: the webview keeps decoded frames around.
const MAX_ANIMATION_PIXELS: u64 = 4 * MAX_DECODE_PIXELS;
/// Sources over this many pixels are thumbnailed at no more than `LARGE_SOURCE_EDGE`.
const LARGE_SOURCE_PIXELS: u64 = 40_000_000;
const LARGE_SOURCE_EDGE: u32 = 1024;
/// macOS `MNT_LOCAL` (`sys/mount.h`): set on every mount that is not remote.
#[cfg(any(test, target_os = "macos"))]
const MNT_LOCAL: u32 = 0x0000_1000;
/// Linux network filesystem magics (`linux/magic.h`, `fs/ceph`, `fs/coda`).
#[cfg(any(test, target_os = "linux"))]
const NETWORK_MAGICS: [u32; 7] = [0x6969, 0x517B, 0xFF53_4D42, 0xFE53_4D42, 0x5346_414F, 0x00C3_6400, 0x7375_7245];
/// macOS automount roots for network shares (`/net/host/share`, `/Network/Servers/…`).
const AUTOFS_ROOTS: [&str; 2] = ["net", "Network"];
/// Symlinks followed while checking a path before it counts as a loop (as `SYMLOOP_MAX`).
#[cfg(unix)]
const MAX_LINK_HOPS: usize = 40;
/// JPEG quality of downscaled images without transparency.
const THUMB_JPEG_QUALITY: u8 = 82;
/// A sized request for an image that already fits but whose file is larger than
/// this is re-encoded at its own size (JPEG at `REENCODE_JPEG_QUALITY`, PNG with
/// transparency), so a heavy small image never reaches a thumbnail whole.
pub const REENCODE_ABOVE: usize = 512 * 1024;
const REENCODE_JPEG_QUALITY: u8 = 85;

/// A validated image request: absolute, or relative to the task's checkout.
#[derive(Debug, PartialEq, Eq)]
pub enum Requested {
    Absolute(PathBuf),
    Relative(PathBuf),
}

/// True for UNC and other network spellings: two leading separators of either kind.
pub fn is_network_path(path: &str) -> bool {
    let mut chars = path.chars();
    matches!((chars.next(), chars.next()), (Some('/' | '\\'), Some('/' | '\\')))
}

/// True for paths under a macOS network automount (`/net/…`, `/Network/…`, any
/// case, as the default volume is case-insensitive): touching them mounts a share.
pub fn is_autofs_path(path: &Path) -> bool {
    let mut components = path.components();
    matches!(components.next(), Some(Component::RootDir))
        && components.next().is_some_and(|first| AUTOFS_ROOTS.iter().any(|root| first.as_os_str().eq_ignore_ascii_case(root)))
}

/// Normalizes the requested path: strips `file://` (local files only), refuses
/// network paths and `..`, and requires an image extension. A relative path may
/// hold only plain components (no `~`, drive or root prefix).
pub fn requested_path(raw: &str) -> Result<Requested, String> {
    let trimmed = raw.trim();
    let stripped = match trimmed.strip_prefix("file://") {
        // `file://host/share/x.png` names another computer.
        Some(rest) if !rest.starts_with('/') => return Err(ERR_NETWORK.into()),
        Some(rest) => rest,
        None => trimmed,
    };
    if stripped.is_empty() || stripped.contains('\0') {
        return Err(ERR_BAD_PATH.into());
    }
    let path = Path::new(stripped);
    if is_network_path(stripped) || is_autofs_path(path) {
        return Err(ERR_NETWORK.into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(ERR_BAD_PATH.into());
    }
    if image_extension(path).is_none() {
        return Err(ERR_EXTENSION.into());
    }
    if path.is_absolute() {
        return Ok(Requested::Absolute(path.to_path_buf()));
    }
    let plain = path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !plain || stripped.starts_with('~') {
        return Err(ERR_BAD_PATH.into());
    }
    Ok(Requested::Relative(path.to_path_buf()))
}

/// The spellings a tool record may use for a relative path: as given, with and
/// without a leading `./`, and joined to the checkout root (with its macOS
/// `/private` twin).
pub fn relative_spellings(relative: &Path, root: &Path) -> Vec<String> {
    let given = relative.to_string_lossy();
    let bare = given.trim_start_matches("./").to_owned();
    let mut spellings = vec![given.clone().into_owned()];
    for spelling in [bare.clone(), format!("./{bare}")] {
        if !spellings.contains(&spelling) {
            spellings.push(spelling);
        }
    }
    spellings.extend(path_spellings(&root.join(&bare).to_string_lossy()));
    spellings
}

/// The canonical file a relative request names, refused when it (or a symlink
/// along the way) leads outside the checkout or into a network mount.
pub fn resolve_relative(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|_| ERR_MISSING.to_string())?;
    // A recorded name that links into a network mount is refused before resolving.
    refuse_network_hops(&root.join(relative))?;
    let target = root.join(relative).canonicalize().map_err(|_| ERR_MISSING.to_string())?;
    if target.starts_with(&root) {
        Ok(target)
    } else {
        Err(ERR_OUTSIDE.into())
    }
}

/// The spellings a tool record may use for the same file: macOS links `/tmp`
/// and `/var` into `/private`, and agents print either form.
pub fn path_spellings(path: &str) -> Vec<String> {
    let mut spellings = vec![path.to_owned()];
    for root in ["/tmp", "/var"] {
        if let Some(rest) = path.strip_prefix("/private").filter(|rest| starts_under(rest, root)) {
            spellings.push(rest.to_owned());
        } else if starts_under(path, root) {
            spellings.push(format!("/private{path}"));
        }
    }
    spellings
}

fn starts_under(path: &str, root: &str) -> bool {
    path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

fn image_extension(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// The image type the leading bytes declare.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Reads an already-authorized path and encodes it as a `data:` URL. The
/// canonical target must still carry an image extension (a symlink to a text
/// file is refused) and its bytes must be an image.
#[cfg(test)]
pub fn encode(path: &Path, limit: u64) -> Result<String, String> {
    encode_within(path, None, limit, None)
}

/// As `encode`; with `within`, the canonical target must also still lie under
/// that (canonical) folder, so a link swapped in after `resolve_relative` is refused.
/// With `max_edge`, the image comes back no larger than that on its longest side.
fn encode_within(path: &Path, within: Option<&Path>, limit: u64, max_edge: Option<u32>) -> Result<String, String> {
    let file = open_checked(path, within, limit)?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| ERR_MISSING.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(ERR_TOO_LARGE.into());
    }
    let mime = sniff_image(&bytes).ok_or_else(|| ERR_NOT_IMAGE.to_string())?;
    match max_edge {
        Some(edge) => downscaled(&bytes, mime, edge),
        None => {
            // The viewer decodes the whole image, so its size is checked from the header first.
            let (width, height) = header_dimensions(&bytes, mime)?;
            checked_dimensions(width, height)?;
            checked_animation(width, height, animation_frames(&bytes, mime))?;
            Ok(data_url(mime, &bytes))
        }
    }
}

/// Resolves and opens an authorized path: no hop may lead into a network mount
/// (checked before anything is resolved), the canonical target must be an image
/// file (under `within`, when given) and is opened without following a link
/// swapped in for it; the open handle is checked again for kind, size and place.
fn open_checked(path: &Path, within: Option<&Path>, limit: u64) -> Result<File, String> {
    refuse_network_hops(path)?;
    let target = path.canonicalize().map_err(|_| ERR_MISSING.to_string())?;
    // A link into an automounted share is refused before the file is opened.
    if is_autofs_path(&target) {
        return Err(ERR_NETWORK.into());
    }
    if within.is_some_and(|root| !target.starts_with(root)) {
        return Err(ERR_OUTSIDE.into());
    }
    if image_extension(&target).is_none() {
        return Err(ERR_EXTENSION.into());
    }
    // Checked before opening: opening a FIFO named `x.png` blocks until a writer
    // appears. `target` is canonical, so this is the file itself, not a link.
    if !std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_file()) {
        return Err(ERR_MISSING.into());
    }
    let file = open_no_follow(&target).map_err(|_| ERR_MISSING.to_string())?;
    // Checked again on the open handle, in case the path was swapped in between.
    let metadata = file.metadata().map_err(|_| ERR_MISSING.to_string())?;
    if !metadata.is_file() {
        return Err(ERR_MISSING.into());
    }
    if metadata.len() > limit {
        return Err(ERR_TOO_LARGE.into());
    }
    check_opened(&file, within)?;
    Ok(file)
}

/// Opens for reading without following a final symlink (`O_NOFOLLOW`) or
/// waiting on a FIFO or device swapped in after the metadata check
/// (`O_NONBLOCK`; harmless for a regular file).
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// Where the open handle really is, from the descriptor itself.
#[cfg(target_os = "macos")]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes, NUL-terminated, into the buffer.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return None;
    }
    let len = buffer.iter().position(|byte| *byte == 0)?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..len])))
}

#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn opened_path(_file: &File) -> Option<PathBuf> {
    None
}

/// The opened file must lie under `within` (as given, or as its own descriptor
/// spells it, so firmlinks and case agree) and never in a network mount.
/// Platforms without descriptor paths rely on the checks before the open.
fn check_opened(file: &File, within: Option<&Path>) -> Result<(), String> {
    let Some(opened) = opened_path(file) else {
        if on_network_filesystem(file) {
            return Err(ERR_NETWORK.into());
        }
        let known = cfg!(any(target_os = "macos", target_os = "linux"));
        return if known && within.is_some() { Err(ERR_MISSING.into()) } else { Ok(()) };
    };
    if is_autofs_path(&opened) || on_network_filesystem(file) {
        return Err(ERR_NETWORK.into());
    }
    let Some(root) = within else { return Ok(()) };
    let root_opened = File::open(root).ok().and_then(|dir| opened_path(&dir));
    if opened.starts_with(root) || root_opened.is_some_and(|spelled| opened.starts_with(spelled)) {
        Ok(())
    } else {
        Err(ERR_OUTSIDE.into())
    }
}

/// True when the open file lives on a network filesystem already mounted
/// somewhere ordinary (an SMB share under `/Volumes`): macOS reads the mount's
/// `MNT_LOCAL` flag, Linux its filesystem magic. Unknown elsewhere (false).
#[cfg(target_os = "macos")]
fn on_network_filesystem(file: &File) -> bool {
    use std::os::unix::io::AsRawFd;
    // SAFETY: fstatfs fills the zeroed struct for a valid descriptor.
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    let filled = unsafe { libc::fstatfs(file.as_raw_fd(), &mut stat) } == 0;
    filled && !is_local_mount(stat.f_flags)
}

#[cfg(target_os = "linux")]
fn on_network_filesystem(file: &File) -> bool {
    use std::os::unix::io::AsRawFd;
    // SAFETY: fstatfs fills the zeroed struct for a valid descriptor.
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(file.as_raw_fd(), &mut stat) } != 0 {
        return false;
    }
    // `f_type` is `c_long` or `c_uint` by target; every magic fits in 32 bits.
    #[allow(clippy::unnecessary_cast)]
    is_network_magic(stat_magic(stat.f_type as i64))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn on_network_filesystem(_file: &File) -> bool {
    false
}

/// macOS `statfs.f_flags`: a mount without `MNT_LOCAL` is remote.
#[cfg(any(test, target_os = "macos"))]
fn is_local_mount(flags: u32) -> bool {
    flags & MNT_LOCAL != 0
}

/// Linux `statfs.f_type` magics of network filesystems: NFS, SMB, CIFS, SMB2,
/// AFS, Ceph and Coda. FUSE is left alone (sshfs and local FUSE share a magic).
#[cfg(any(test, target_os = "linux"))]
fn is_network_magic(magic: u32) -> bool {
    NETWORK_MAGICS.contains(&magic)
}

#[cfg(any(test, target_os = "linux"))]
fn stat_magic(f_type: i64) -> u32 {
    (f_type as u64 & u64::from(u32::MAX)) as u32
}

/// Walks `path` one component at a time, following symlinks by reading them
/// (never resolving through them), and refuses any hop into a network path: a
/// link text spelled `//host` or `\\host`, or a lexically resolved prefix under
/// `/net` or `/Network`. Nothing under an automount root is ever looked up, so
/// no share is mounted. A missing component ends the walk (the later
/// `canonicalize` reports it); a link loop is refused as missing.
#[cfg(unix)]
pub fn refuse_network_hops(path: &Path) -> Result<(), String> {
    use std::ffi::OsString;
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().map_err(|_| ERR_MISSING.to_string())?.join(path) };
    let mut pending: Vec<OsString> = Vec::new();
    push_components(&absolute, &mut pending);
    let (mut resolved, mut hops) = (PathBuf::from("/"), 0usize);
    while let Some(part) = pending.pop() {
        if part == ".." {
            resolved.pop();
            continue;
        }
        let next = resolved.join(&part);
        if is_autofs_path(&next) {
            return Err(ERR_NETWORK.into());
        }
        match std::fs::symlink_metadata(&next) {
            Ok(meta) if meta.file_type().is_symlink() => {
                hops += 1;
                let target = std::fs::read_link(&next).map_err(|_| ERR_MISSING.to_string())?;
                if hops > MAX_LINK_HOPS {
                    return Err(ERR_MISSING.into());
                }
                if is_network_path(&target.to_string_lossy()) {
                    return Err(ERR_NETWORK.into());
                }
                if target.is_absolute() {
                    resolved = PathBuf::from("/");
                }
                push_components(&target, &mut pending);
            }
            Ok(_) => resolved = next,
            Err(_) => return Ok(()),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn refuse_network_hops(path: &Path) -> Result<(), String> {
    if is_network_path(&path.to_string_lossy()) {
        Err(ERR_NETWORK.into())
    } else {
        Ok(())
    }
}

/// Pushes `path`'s components onto a stack (last first, so they pop in order);
/// `..` stays as `..`, roots and `.` are dropped.
#[cfg(unix)]
fn push_components(path: &Path, pending: &mut Vec<std::ffi::OsString>) {
    let parts: Vec<std::ffi::OsString> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_os_string()),
            Component::ParentDir => Some("..".into()),
            _ => None,
        })
        .collect();
    pending.extend(parts.into_iter().rev());
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn image_format(mime: &str) -> Result<image::ImageFormat, String> {
    use image::ImageFormat;
    match mime {
        "image/png" => Ok(ImageFormat::Png),
        "image/jpeg" => Ok(ImageFormat::Jpeg),
        "image/gif" => Ok(ImageFormat::Gif),
        "image/webp" => Ok(ImageFormat::WebP),
        _ => Err(ERR_NOT_IMAGE.into()),
    }
}

/// The image's size from its header alone (nothing is decoded).
fn header_dimensions(bytes: &[u8], mime: &str) -> Result<(u32, u32), String> {
    image::ImageReader::with_format(std::io::Cursor::new(bytes), image_format(mime)?)
        .into_dimensions()
        .map_err(|_| ERR_UNDECODABLE.to_string())
}

/// Refuses images wider or taller than `MAX_DECODE_SIDE` or with more than `MAX_DECODE_PIXELS`.
fn checked_dimensions(width: u32, height: u32) -> Result<(), String> {
    let too_big = width > MAX_DECODE_SIDE || height > MAX_DECODE_SIDE || u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS;
    if too_big {
        Err(ERR_DIMENSIONS.into())
    } else {
        Ok(())
    }
}

/// Refuses an animation whose frames hold more than `MAX_ANIMATION_PIXELS` canvas pixels in all.
fn checked_animation(width: u32, height: u32, frames: u64) -> Result<(), String> {
    let total = (u64::from(width) * u64::from(height)).saturating_mul(frames);
    if total > MAX_ANIMATION_PIXELS {
        Err(ERR_ANIMATION.into())
    } else {
        Ok(())
    }
}

/// How many frames the image holds, read from its container without decoding
/// anything (a truncated file counts the frames it has; a still image is 1).
fn animation_frames(bytes: &[u8], mime: &str) -> u64 {
    let frames = match mime {
        "image/gif" => {
            let mut frames = 0;
            let _ = gif_frames(bytes, &mut frames);
            frames
        }
        "image/webp" => webp_frames(bytes),
        "image/png" => apng_frames(bytes),
        _ => 1,
    };
    frames.max(1)
}

/// The size of a GIF color table whose flags byte is `flags` (none without its high bit).
fn gif_color_table(flags: u8) -> usize {
    if flags & 0x80 == 0 {
        0
    } else {
        3 << ((flags & 7) + 1)
    }
}

/// Counts GIF image descriptors into `frames`, walking the blocks after the
/// header; `None` where the data ends early.
fn gif_frames(bytes: &[u8], frames: &mut u64) -> Option<()> {
    let mut at = 13 + gif_color_table(*bytes.get(10)?);
    loop {
        match *bytes.get(at)? {
            // Image descriptor: 9 bytes, a local color table, the LZW code size, data.
            0x2C => {
                let flags = *bytes.get(at + 9)?;
                *frames += 1;
                at = gif_sub_blocks(bytes, at + 10 + gif_color_table(flags) + 1)?;
            }
            // Extension: a label, then data sub-blocks.
            0x21 => at = gif_sub_blocks(bytes, at + 2)?,
            _ => return Some(()),
        }
    }
}

/// The offset after a run of GIF data sub-blocks starting at `at`.
fn gif_sub_blocks(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let len = usize::from(*bytes.get(at)?);
        at += 1;
        if len == 0 {
            return Some(at);
        }
        at = at.checked_add(len)?;
    }
}

/// The `ANMF` chunks of a WebP RIFF.
fn webp_frames(bytes: &[u8]) -> u64 {
    let (mut at, mut frames) = (12usize, 0);
    while let Some(header) = bytes.get(at..at.saturating_add(8)) {
        if &header[..4] == b"ANMF" {
            frames += 1;
        }
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        at = at.saturating_add(8).saturating_add(size).saturating_add(size & 1);
    }
    frames
}

/// The frames of an APNG: its `fcTL` chunks, counted by walking every chunk to
/// `IEND` (each takes at least 12 bytes, so the walk is bounded by the file),
/// never the count its `acTL` declares. A PNG without `acTL` is one still frame.
fn apng_frames(bytes: &[u8]) -> u64 {
    let (mut at, mut animated, mut controls) = (8usize, false, 0u64);
    while let Some(header) = bytes.get(at..at.saturating_add(8)) {
        let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        match &header[4..8] {
            b"acTL" => animated = true,
            b"fcTL" => controls += 1,
            b"IEND" => break,
            _ => {}
        }
        at = at.saturating_add(12).saturating_add(size);
    }
    if animated {
        controls
    } else {
        1
    }
}

/// At most this many images are decoded and re-encoded at once: each decode may
/// take up to `MAX_DECODE_ALLOC`, and a transcript full of thumbnails asks for many.
const MAX_CONCURRENT_DECODES: usize = 2;
static DECODE_SLOTS: DecodeSlots = DecodeSlots::new(MAX_CONCURRENT_DECODES);

/// A counting semaphore (std has none): `acquire` blocks until a slot is free.
struct DecodeSlots {
    capacity: usize,
    used: std::sync::Mutex<usize>,
    freed: std::sync::Condvar,
}

struct DecodeSlot<'a>(&'a DecodeSlots);

impl DecodeSlots {
    const fn new(capacity: usize) -> Self {
        Self { capacity, used: std::sync::Mutex::new(0), freed: std::sync::Condvar::new() }
    }

    fn acquire(&self) -> DecodeSlot<'_> {
        // A poisoned count is still a count: decoding never panics while holding the lock.
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        while *used >= self.capacity {
            used = self.freed.wait(used).unwrap_or_else(|e| e.into_inner());
        }
        *used += 1;
        DecodeSlot(self)
    }
}

impl Drop for DecodeSlot<'_> {
    fn drop(&mut self) {
        *self.0.used.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        self.0.freed.notify_one();
    }
}

/// The thumbnail edge for a `width` × `height` source: a source over
/// `LARGE_SOURCE_PIXELS` is resized to at most `LARGE_SOURCE_EDGE`, so the
/// resize's intermediate buffers stay small next to the decoded image.
fn decode_edge(width: u32, height: u32, edge: u32) -> u32 {
    if u64::from(width) * u64::from(height) > LARGE_SOURCE_PIXELS {
        edge.min(LARGE_SOURCE_EDGE)
    } else {
        edge
    }
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    limits
}

/// The image (already sniffed as `mime`) at most `edge` pixels on its longest
/// side: unchanged when it already fits and its file is at most `REENCODE_ABOVE`
/// bytes and is not an animation over `MAX_ANIMATION_PIXELS`, else decoded under
/// `decode_limits` and re-encoded upright (EXIF orientation applied; PNG when it
/// has transparency, JPEG otherwise; an animation's first frame). A heavy image
/// that fits keeps its size and is re-encoded only.
pub fn downscaled(bytes: &[u8], mime: &str, edge: u32) -> Result<String, String> {
    use image::{
        codecs::jpeg::JpegEncoder, imageops::FilterType, metadata::Orientation, DynamicImage, ImageDecoder, ImageFormat, ImageReader,
    };
    let edge = edge.clamp(MIN_EDGE, MAX_EDGE);
    let format = image_format(mime)?;
    let reader = || {
        let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
        reader.limits(decode_limits());
        reader
    };
    let (width, height) = reader().into_dimensions().map_err(|_| ERR_UNDECODABLE.to_string())?;
    let fits = width <= edge && height <= edge;
    // The original bytes go back only when the webview may decode them whole:
    // an animation over the frame budget is re-encoded as its first frame.
    let whole_ok = checked_animation(width, height, animation_frames(bytes, mime)).is_ok();
    if fits && whole_ok && bytes.len() <= REENCODE_ABOVE {
        return Ok(data_url(mime, bytes));
    }
    checked_dimensions(width, height)?;
    let edge = decode_edge(width, height, edge);
    // Held through the decode and re-encode only; header reads above never wait.
    let _slot = DECODE_SLOTS.acquire();
    let mut decoder = reader().into_decoder().map_err(|_| ERR_UNDECODABLE.to_string())?;
    // A camera JPEG stores its pixels sideways plus an EXIF orientation; the
    // re-encoded thumbnail carries no EXIF, so the rotation is applied here.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| ERR_UNDECODABLE.to_string())?;
    image.apply_orientation(orientation);
    let (small, quality) = if fits { (image, REENCODE_JPEG_QUALITY) } else { (image.resize(edge, edge, FilterType::Triangle), THUMB_JPEG_QUALITY) };
    let mut out = Vec::new();
    let mime_out = if small.color().has_alpha() {
        small.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png).map_err(|_| ERR_UNDECODABLE.to_string())?;
        "image/png"
    } else {
        JpegEncoder::new_with_quality(&mut out, quality).encode_image(&small.to_rgb8()).map_err(|_| ERR_UNDECODABLE.to_string())?;
        "image/jpeg"
    };
    // A re-encode that saved nothing (an already tight PNG) keeps the original.
    if fits && whole_ok && out.len() >= bytes.len() {
        return Ok(data_url(mime, bytes));
    }
    Ok(data_url(mime_out, &out))
}

/// Validates the request, asks `viewed` whether the session's tool records name
/// any spelling of the path, and returns the image as a `data:` URL. `root` (the
/// task's checkout) is asked for only when the path is relative.
#[cfg(test)]
pub fn load(
    raw: &str,
    root: impl FnOnce() -> Result<PathBuf, String>,
    viewed: impl FnOnce(&[String]) -> Result<bool, String>,
    limit: u64,
) -> Result<String, String> {
    load_sized(raw, root, viewed, limit, None)
}

/// As `load`; with `max_edge` (row thumbnails, cards) the image is decoded only
/// after every check has passed and comes back at most that many pixels on its
/// longest side (see `downscaled`).
pub fn load_sized(
    raw: &str,
    root: impl FnOnce() -> Result<PathBuf, String>,
    viewed: impl FnOnce(&[String]) -> Result<bool, String>,
    limit: u64,
    max_edge: Option<u32>,
) -> Result<String, String> {
    match requested_path(raw)? {
        Requested::Absolute(path) => {
            if !viewed(&path_spellings(&path.to_string_lossy()))? {
                return Err(ERR_NOT_VIEWED.into());
            }
            encode_within(&path, None, limit, max_edge)
        }
        Requested::Relative(relative) => {
            let root = root()?.canonicalize().map_err(|_| ERR_MISSING.to_string())?;
            if !viewed(&relative_spellings(&relative, &root))? {
                return Err(ERR_NOT_VIEWED.into());
            }
            encode_within(&resolve_relative(&root, &relative)?, Some(&root), limit, max_edge)
        }
    }
}

#[cfg(test)]
#[path = "tool_images_tests.rs"]
mod tests;
