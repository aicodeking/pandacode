//! One-off inputs the user adds to a message: images normalized into the PNG
//! attachment pipeline every harness accepts, documents reduced to bounded text,
//! and folders summarized as a listing. Paths arrive from native pickers, drops
//! and pastes in the trusted main webview; agents never address them directly.
use crate::workspace;
#[cfg(target_os = "macos")]
use crate::workspace::run_process;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::{
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
#[cfg(target_os = "macos")]
use std::process::Command;

const MAX_IMAGE_SOURCE: usize = 24 * 1024 * 1024;
/// What `providers::attachments::load` accepts per image.
const MAX_IMAGE_PNG: usize = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 2048;
/// Shared with project-file context blocks, so one message stays bounded.
pub const MAX_TEXT: usize = 32 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(target_os = "macos")]
const EXTRACTOR_OUTPUT: usize = 12 * 1024 * 1024;
#[cfg(target_os = "macos")]
const EXTRACTOR_TIMEOUT: Duration = Duration::from_secs(30);
const LISTING_LINES: usize = 240;
const LISTING_DEPTH: usize = 3;
const LISTING_ENTRIES: usize = 20_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Small JPEG data URL for the composer chip; never sent to a model.
    pub thumbnail: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub text: String,
    pub truncated: bool,
    pub method: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSummary {
    pub name: String,
    pub path: String,
    pub files: usize,
    pub folders: usize,
    pub listing: String,
    pub truncated: bool,
}

pub enum ImageSource {
    Path(PathBuf),
    Data { name: String, data_url: String },
}

fn file_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn checked_file(path: &Path, max: u64, what: &str) -> Result<(File, u64), String> {
    if !path.is_absolute() {
        return Err(format!("Choose the {what} with the picker or drop it onto the message."));
    }
    let file = File::open(path).map_err(|_| format!("Could not open this {what}."))?;
    let metadata = file
        .metadata()
        .map_err(|_| format!("Could not read this {what}."))?;
    if !metadata.is_file() {
        return Err(format!("This is not a {what} file."));
    }
    if metadata.len() > max {
        return Err(format!("This {what} is larger than {} MB.", max / 1024 / 1024));
    }
    Ok((file, metadata.len()))
}

fn read_bounded(file: File, max: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err(format!("The file is larger than {} MB.", max / 1024 / 1024));
    }
    Ok(bytes)
}

fn decode(bytes: &[u8]) -> Result<(DynamicImage, ImageFormat), String> {
    let format = image::guess_format(bytes)
        .map_err(|_| "Choose a PNG, JPEG or WebP image. Screenshots and exports work well.")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("Choose a PNG, JPEG or WebP image. HEIC, GIF and SVG are not supported yet.".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "This image is damaged or too large to decode.".to_string())?;
    Ok((image, format))
}

fn encode_png(image: &DynamicImage, edge: u32) -> Result<Vec<u8>, String> {
    let scaled = if image.width() > edge || image.height() > edge {
        image.thumbnail(edge, edge)
    } else {
        image.clone()
    };
    let mut bytes = Vec::new();
    scaled
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|_| "Could not prepare this image.".to_string())?;
    Ok(bytes)
}

fn thumbnail(image: &DynamicImage) -> Result<String, String> {
    let small = image.thumbnail(320, 320).to_rgba8();
    // Composite onto white so transparent sketches stay readable in the chip.
    let rgb = image::RgbImage::from_fn(small.width(), small.height(), |x, y| {
        let p = small.get_pixel(x, y).0;
        let a = p[3] as u32;
        image::Rgb([
            ((p[0] as u32 * a + 255 * (255 - a)) / 255) as u8,
            ((p[1] as u32 * a + 255 * (255 - a)) / 255) as u8,
            ((p[2] as u32 * a + 255 * (255 - a)) / 255) as u8,
        ])
    });
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 72)
        .encode_image(&rgb)
        .map_err(|_| "Could not prepare this image.".to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}

/// Normalize any supported image into a PNG the attachment pipeline accepts and
/// store it beside browser screenshots, which share their IDs, limits and cleanup.
pub fn import_image(dir: &Path, source: ImageSource) -> Result<ImportedImage, String> {
    let (name, bytes) = match source {
        ImageSource::Path(path) => {
            let (file, _) = checked_file(&path, MAX_IMAGE_SOURCE as u64, "image")?;
            (file_name(&path, "Image.png"), read_bounded(file, MAX_IMAGE_SOURCE)?)
        }
        ImageSource::Data { name, data_url } => {
            if data_url.len() > MAX_IMAGE_SOURCE * 4 / 3 + 128 {
                return Err("Each image must be 24 MB or smaller.".into());
            }
            let (prefix, data) = data_url.split_once(',').ok_or("Invalid image data.")?;
            if !matches!(
                prefix,
                "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
            ) {
                return Err("Choose a PNG, JPEG or WebP image.".into());
            }
            let bytes = STANDARD.decode(data).map_err(|_| "Invalid image data.")?;
            let name = name.trim();
            let name = if name.is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
                "Image.png".to_owned()
            } else {
                name.to_owned()
            };
            (name, bytes)
        }
    };
    let (image, format) = decode(&bytes)?;
    let (width, height) = (image.width(), image.height());
    let png = if format == ImageFormat::Png
        && bytes.len() <= MAX_IMAGE_PNG
        && width.max(height) <= MAX_IMAGE_EDGE
    {
        bytes
    } else {
        let mut png = encode_png(&image, MAX_IMAGE_EDGE)?;
        for edge in [1600, 1200] {
            if png.len() <= MAX_IMAGE_PNG {
                break;
            }
            png = encode_png(&image, edge)?;
        }
        if png.len() > MAX_IMAGE_PNG {
            return Err("This image is too detailed to attach. Export it smaller and try again.".into());
        }
        png
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = dir.join(format!("{id}.png"));
    std::fs::write(&path, &png).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(ImportedImage {
        id,
        name,
        width,
        height,
        thumbnail: thumbnail(&image)?,
    })
}

/// A sent image or screenshot as a `data:` URL, so the transcript can show it again.
/// Only registry IDs are accepted; None when the capture was pruned or never existed.
pub fn image_data_url(dir: &Path, id: &str) -> Result<Option<String>, String> {
    if uuid::Uuid::parse_str(id).map(|parsed| parsed.to_string()) != Ok(id.to_owned()) {
        return Err("Invalid image.".into());
    }
    let path = dir.join(format!("{id}.png"));
    let Ok(metadata) = std::fs::symlink_metadata(&path) else { return Ok(None) };
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_PNG as u64 {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes))))
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Decode the string literal that `mdimport -d3` prints for `kMDItemTextContent`:
/// C-style escapes plus `\Uxxxx` code units (surrogate pairs for astral characters).
pub(crate) fn spotlight_text(dump: &str) -> Option<String> {
    let marker = "kMDItemTextContent = \"";
    let start = dump.find(marker)? + marker.len();
    let mut chars = dump[start..].chars();
    let mut text = String::new();
    let mut high: Option<u16> = None;
    loop {
        // Running out of input before the closing quote means the dump was cut short.
        let (unit, ch) = match chars.next()? {
            '"' => break,
            '\\' => match chars.next()? {
                'n' => (None, Some('\n')),
                't' => (None, Some('\t')),
                'r' => (None, Some('\r')),
                'U' | 'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    match u16::from_str_radix(&hex, 16) {
                        Ok(unit) => (Some(unit), None),
                        Err(_) => (None, Some('\u{FFFD}')),
                    }
                }
                other => (None, Some(other)),
            },
            other => (None, Some(other)),
        };
        // UTF-16 units pair up; anything else flushes a dangling high surrogate.
        match (unit, ch) {
            (Some(unit @ 0xDC00..=0xDFFF), _) if high.is_some() => {
                let lead = high.take().unwrap() as u32;
                let code = 0x10000 + ((lead - 0xD800) << 10) + (unit as u32 - 0xDC00);
                text.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
            }
            (Some(unit), _) => {
                if high.take().is_some() {
                    text.push('\u{FFFD}');
                }
                if (0xD800..=0xDBFF).contains(&unit) {
                    high = Some(unit);
                } else {
                    text.push(char::from_u32(unit as u32).unwrap_or('\u{FFFD}'));
                }
            }
            (None, Some(ch)) => {
                if high.take().is_some() {
                    text.push('\u{FFFD}');
                }
                text.push(ch);
            }
            (None, None) => {}
        }
    }
    Some(text)
}

fn truncate_text(mut text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

fn looks_like_text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        // A read that stopped mid-character is still text; anything else is binary.
        Err(error) if error.error_len().is_none() => {
            String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned()
        }
        Err(_) => return None,
    };
    let control = text
        .chars()
        .filter(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{0C}'))
        .count();
    (control * 100 <= text.chars().count().max(1)).then_some(text)
}

#[cfg(target_os = "macos")]
fn extract_with(tool: &str, args: &[&str], path: &Path) -> Result<String, String> {
    let mut command = Command::new(tool);
    command.args(args).arg(path);
    let output = run_process(command, tool, EXTRACTOR_OUTPUT, EXTRACTOR_TIMEOUT)?;
    if !output.status.success() && output.stdout.bytes.is_empty() {
        return Err(format!(
            "Could not read this document with {tool}: {}",
            String::from_utf8_lossy(&output.stderr.bytes).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout.bytes).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn extract_with(_tool: &str, _args: &[&str], _path: &Path) -> Result<String, String> {
    Err("Reading PDF and Office documents is available on macOS. Attach a text export instead.".into())
}

/// Reduce a document to bounded text. Plain text is read directly; Office and
/// rich-text formats go through `textutil`, everything else through Spotlight's
/// importers (`mdimport`), which cover PDF, iWork, EPUB and many more.
pub fn read_document(path: &Path) -> Result<DocumentText, String> {
    let (mut file, size) = checked_file(path, MAX_DOCUMENT_BYTES, "document")?;
    let name = file_name(path, "Document");
    let ext = extension(path);
    let mut cut = false;
    let (text, method) = match ext.as_str() {
        "doc" | "docx" | "rtf" | "rtfd" | "odt" | "wordml" | "webarchive" => (
            extract_with("/usr/bin/textutil", &["-convert", "txt", "-stdout"], path)?,
            "textutil",
        ),
        "pdf" | "pages" | "key" | "numbers" | "pptx" | "ppt" | "xlsx" | "xls" | "epub" => {
            (spotlight(path)?, "spotlight")
        }
        _ => {
            // Only the head is read: a text file beyond the budget is cut, not rejected.
            let mut head = Vec::new();
            (&mut file)
                .take(MAX_TEXT as u64 + 1)
                .read_to_end(&mut head)
                .map_err(|_| "Could not read this document.".to_string())?;
            cut = head.len() > MAX_TEXT;
            head.truncate(MAX_TEXT);
            match looks_like_text(&head) {
                Some(text) => (text, "text"),
                None => (spotlight(path)?, "spotlight"),
            }
        }
    };
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err("No readable text was found in this document. It may be scanned images only.".into());
    }
    let (text, truncated) = truncate_text(text, MAX_TEXT);
    Ok(DocumentText {
        name,
        path: path.to_string_lossy().into_owned(),
        size,
        text,
        truncated: truncated || cut,
        method,
    })
}

fn spotlight(path: &Path) -> Result<String, String> {
    let dump = extract_with("/usr/bin/mdimport", &["-t", "-d3"], path)?;
    spotlight_text(&dump).ok_or_else(|| {
        "No readable text was found in this document. It may be scanned images only.".into()
    })
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// A shallow, sorted tree of a folder: enough structure for a model to orient
/// itself, never a full walk. Build folders and version control are skipped.
pub fn describe_folder(path: &Path) -> Result<FolderSummary, String> {
    if !path.is_absolute() {
        return Err("Choose the folder with the picker or drop it onto the message.".into());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Could not open this folder.")?;
    if !metadata.is_dir() {
        return Err("This is not a folder.".into());
    }
    let name = file_name(path, &path.to_string_lossy());
    let mut listing = Listing {
        lines: Vec::new(),
        files: 0,
        folders: 0,
        budget: LISTING_ENTRIES,
        truncated: false,
        deadline: Instant::now() + Duration::from_secs(2),
    };
    listing.walk(path, 0);
    Ok(FolderSummary {
        name,
        path: path.to_string_lossy().into_owned(),
        files: listing.files,
        folders: listing.folders,
        listing: listing.lines.join("\n"),
        truncated: listing.truncated,
    })
}

struct Listing {
    lines: Vec<String>,
    files: usize,
    folders: usize,
    budget: usize,
    truncated: bool,
    deadline: Instant,
}

impl Listing {
    fn walk(&mut self, dir: &Path, depth: usize) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<(String, bool)> = entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let kind = entry.file_type().ok()?;
                let name = entry.file_name().to_str()?.to_owned();
                if kind.is_symlink()
                    || hidden(&name)
                    || workspace::excluded_entry(&name, kind.is_dir())
                {
                    return None;
                }
                (kind.is_dir() || kind.is_file()).then_some((name, kind.is_dir()))
            })
            .collect();
        entries.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
        });
        let indent = "  ".repeat(depth);
        for (index, (name, is_dir)) in entries.iter().enumerate() {
            if self.budget == 0 || Instant::now() >= self.deadline {
                self.truncated = true;
                return;
            }
            self.budget -= 1;
            if *is_dir {
                self.folders += 1;
            } else {
                self.files += 1;
            }
            if self.lines.len() >= LISTING_LINES {
                self.truncated = true;
                continue;
            }
            let remaining = entries.len() - index;
            if self.lines.len() + 1 == LISTING_LINES && remaining > 1 {
                self.lines.push(format!("{indent}… {remaining} more"));
                self.truncated = true;
                continue;
            }
            self.lines
                .push(format!("{indent}{name}{}", if *is_dir { "/" } else { "" }));
            if *is_dir && depth + 1 < LISTING_DEPTH {
                self.walk(&dir.join(name), depth + 1);
            } else if *is_dir {
                self.truncated = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

    #[test]
    fn sent_images_are_read_back_by_registry_id_only() {
        let dir = temp_dir("sent-image");
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::write(dir.join(format!("{id}.png")), [1, 2, 3]).unwrap();
        assert_eq!(image_data_url(&dir, &id).unwrap().as_deref(), Some("data:image/png;base64,AQID"));
        assert_eq!(image_data_url(&dir, &uuid::Uuid::new_v4().to_string()).unwrap(), None);
        assert!(image_data_url(&dir, "../secret").is_err());
        assert!(image_data_url(&dir, &id.to_uppercase()).is_err());
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn imports_png_data_and_files_as_png_attachments_with_thumbnails() {
        let dir = temp_dir("images");
        let imported = import_image(
            &dir.join("captures"),
            ImageSource::Data { name: "Mockup.png".into(), data_url: format!("data:image/png;base64,{PNG}") },
        )
        .unwrap();
        assert_eq!((imported.width, imported.height, imported.name.as_str()), (1, 1, "Mockup.png"));
        assert!(imported.thumbnail.starts_with("data:image/jpeg;base64,"));
        let stored = dir.join("captures").join(format!("{}.png", imported.id));
        assert!(std::fs::read(&stored).unwrap().starts_with(b"\x89PNG"));
        uuid::Uuid::parse_str(&imported.id).unwrap();

        // A JPEG on disk is re-encoded as PNG so every harness receives the same format.
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 80)
            .encode_image(&image::RgbImage::from_pixel(3000, 40, image::Rgb([200, 30, 30])))
            .unwrap();
        let photo = dir.join("photo.jpg");
        std::fs::write(&photo, jpeg).unwrap();
        let imported = import_image(&dir.join("captures"), ImageSource::Path(photo)).unwrap();
        assert_eq!((imported.width, imported.height), (3000, 40));
        let bytes = std::fs::read(dir.join("captures").join(format!("{}.png", imported.id))).unwrap();
        let (decoded, format) = decode(&bytes).unwrap();
        assert_eq!(format, ImageFormat::Png);
        assert!(decoded.width() <= MAX_IMAGE_EDGE, "large sources are scaled to the pipeline's edge");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_images_relative_paths_and_foreign_data_urls() {
        let dir = temp_dir("bad-images");
        assert!(import_image(&dir, ImageSource::Path(PathBuf::from("relative.png"))).is_err());
        let text = dir.join("notes.png");
        std::fs::write(&text, b"not an image").unwrap();
        assert!(import_image(&dir, ImageSource::Path(text)).unwrap_err().contains("PNG, JPEG or WebP"));
        assert!(import_image(&dir, ImageSource::Data { name: "x".into(), data_url: "data:image/svg+xml;base64,PHN2Zy8+".into() }).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn decodes_spotlight_string_literals() {
        let dump = "{\n    kMDItemContentType = \"com.adobe.pdf\";\n    kMDItemTextContent = \"Hello \\\"quoted\\\" caf\\U00e9 \\U2014 \\U2713\\nTab\\there \\\\ done \\Ud83d\\Ude00!\";\n    kMDItemTitle = \"x\";\n}";
        assert_eq!(spotlight_text(dump).unwrap(), "Hello \"quoted\" café — ✓\nTab\there \\ done 😀!");
        assert_eq!(spotlight_text("{ kMDItemTitle = \"x\"; }"), None);
        assert_eq!(spotlight_text("kMDItemTextContent = \"unterminated"), None);
    }

    #[test]
    fn reads_plain_text_documents_bounded_and_refuses_binary_without_an_extractor() {
        let dir = temp_dir("docs");
        let notes = dir.join("notes.md");
        std::fs::write(&notes, "# Plan\n\nShip it — with unicode ✓\n").unwrap();
        let document = read_document(&notes).unwrap();
        assert_eq!((document.method, document.truncated), ("text", false));
        assert_eq!(document.text, "# Plan\n\nShip it — with unicode ✓");
        assert_eq!(document.name, "notes.md");

        let big = dir.join("big.log");
        std::fs::write(&big, "x".repeat(MAX_TEXT + 500)).unwrap();
        let document = read_document(&big).unwrap();
        assert!(document.truncated);
        assert_eq!(document.text.len(), MAX_TEXT);

        assert!(read_document(Path::new("relative.txt")).is_err());
        assert!(read_document(&dir).is_err(), "folders are not documents");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn extracts_text_from_rich_text_and_spotlight_indexed_documents() {
        let dir = temp_dir("rich");
        let rtf = dir.join("brief.rtf");
        std::fs::write(&rtf, "{\\rtf1\\ansi Bold {\\b brief} text.}").unwrap();
        let document = read_document(&rtf).unwrap();
        assert_eq!(document.method, "textutil");
        assert!(document.text.contains("Bold brief text."), "{}", document.text);

        // A minimal PDF goes through Spotlight's PDF importer.
        let pdf = dir.join("brief.pdf");
        std::fs::write(&pdf, b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n4 0 obj << /Length 44 >> stream\nBT /F1 24 Tf 20 60 Td (Hello PandaCode) Tj ET\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n").unwrap();
        let document = read_document(&pdf).unwrap();
        assert_eq!(document.method, "spotlight");
        assert!(document.text.contains("Hello PandaCode"), "{}", document.text);

        // Binary data with no importer is refused rather than pasted as garbage.
        let blob = dir.join("page.unknownext");
        std::fs::write(&blob, b"\x00\x01binary prefix").unwrap();
        let error = read_document(&blob).unwrap_err();
        assert!(error.contains("No readable text") || error.contains("Could not read"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn describes_folders_as_a_shallow_sorted_tree_skipping_build_output() {
        let dir = temp_dir("folder");
        std::fs::create_dir_all(dir.join("src/components/deep/deeper")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("README.md"), "").unwrap();
        std::fs::write(dir.join("src/main.ts"), "").unwrap();
        std::fs::write(dir.join("src/components/Button.tsx"), "").unwrap();
        std::fs::write(dir.join("src/components/deep/x.ts"), "").unwrap();
        std::fs::write(dir.join(".hidden"), "").unwrap();
        let summary = describe_folder(&dir).unwrap();
        assert_eq!(
            summary.listing,
            "src/\n  components/\n    deep/\n    Button.tsx\n  main.ts\nREADME.md"
        );
        assert_eq!((summary.files, summary.folders), (3, 3));
        assert!(summary.truncated, "a folder below the depth limit marks the listing partial");
        assert!(!summary.listing.contains("node_modules") && !summary.listing.contains(".git"));
        assert!(describe_folder(&dir.join("README.md")).is_err());
        assert!(describe_folder(Path::new("relative")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn listing_stops_at_the_line_budget_with_a_remainder_note() {
        let dir = temp_dir("wide");
        for index in 0..(LISTING_LINES + 20) {
            std::fs::write(dir.join(format!("file-{index:04}.txt")), "").unwrap();
        }
        let summary = describe_folder(&dir).unwrap();
        assert!(summary.truncated);
        assert_eq!(summary.listing.lines().count(), LISTING_LINES);
        assert!(summary.listing.lines().last().unwrap().starts_with("… 21 more"));
        assert_eq!(summary.files, LISTING_LINES + 20, "counts continue past the printed lines");
        let _ = std::fs::remove_dir_all(dir);
    }
}
