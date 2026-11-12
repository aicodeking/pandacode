//! Computer use on a VM screen: screenshots scaled to a model-friendly size, and clicks,
//! drags, scrolls, typing and key combinations sent over RFB. Coordinates the agent sends
//! are pixels of the last screenshot it was given.
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage};
use std::{thread, time::Duration};

use super::rfb::Rfb;

/// Screenshots wider than this are scaled down; agents work best near this size.
pub const MAX_WIDTH: u32 = 1280;
const STEP: Duration = Duration::from_millis(12);

/// Image size and the factor that maps image pixels back to screen pixels.
pub fn scaled(width: u32, height: u32) -> (u32, u32, f64) {
    if width <= MAX_WIDTH {
        return (width, height, 1.0);
    }
    let factor = width as f64 / MAX_WIDTH as f64;
    (MAX_WIDTH, (height as f64 / factor).round() as u32, factor)
}

pub struct Shot {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub screen_width: u32,
    pub screen_height: u32,
}
pub fn screenshot(rfb: &mut Rfb, quality: u8) -> Result<Shot, String> {
    let frame = rfb.capture()?;
    let (screen_width, screen_height) = (frame.width(), frame.height());
    let (width, height, _) = scaled(screen_width, screen_height);
    let image = DynamicImage::ImageRgba8(frame);
    let image = if width == screen_width { image } else { image.resize_exact(width, height, FilterType::Triangle) };
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, quality).encode_image(&image.to_rgb8()).map_err(|e| e.to_string())?;
    Ok(Shot { jpeg, width, height, screen_width, screen_height })
}

/// The X11 keysym for a typed character.
pub fn keysym(ch: char) -> u32 {
    match ch {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        '\u{8}' => 0xff08,
        c if (c as u32) < 0x100 => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}
/// Characters a US keyboard types with Shift held.
fn shifted(ch: char) -> bool {
    ch.is_ascii_uppercase() || "~!@#$%^&*()_+{}|:\"<>?".contains(ch)
}
const SHIFT: u32 = 0xffe1;

fn named(key: &str) -> Option<u32> {
    Some(match key {
        "return" | "enter" => 0xff0d,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        "tab" => 0xff09,
        "space" => 0x20,
        "delete" | "del" => 0xffff,
        "insert" => 0xff63,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" | "page_up" => 0xff55,
        "pagedown" | "page_down" => 0xff56,
        "left" => 0xff51,
        "up" => 0xff52,
        "right" => 0xff53,
        "down" => 0xff54,
        "shift" => SHIFT,
        "ctrl" | "control" => 0xffe3,
        "alt" | "option" | "opt" => 0xffe9,
        "cmd" | "command" | "super" | "win" | "meta" => 0xffeb,
        _ => {
            let number = key.strip_prefix('f')?.parse::<u32>().ok().filter(|n| (1..=12).contains(n))?;
            0xffbe + number - 1
        }
    })
}
/// `ctrl+shift+t`, `cmd+space`, `Return` or a single character, as keysyms in press order.
pub fn combo(text: &str) -> Result<Vec<u32>, String> {
    let parts: Vec<String> = text.split('+').map(|p| p.trim().to_lowercase()).collect();
    if parts.iter().any(String::is_empty) || parts.len() > 5 {
        return Err(format!("Unknown key combination {text:?}."));
    }
    parts
        .iter()
        .zip(text.split('+'))
        .map(|(part, original)| {
            named(part).or_else(|| {
                let mut chars = original.trim().chars();
                let ch = chars.next()?;
                chars.next().is_none().then(|| keysym(ch.to_ascii_lowercase()))
            }).ok_or_else(|| format!("Unknown key {original:?}."))
        })
        .collect()
}

#[derive(Debug)]
pub enum Action {
    Click { x: f64, y: f64, button: u8, count: u8 },
    Move { x: f64, y: f64 },
    Drag { x: f64, y: f64, end_x: f64, end_y: f64 },
    Scroll { x: f64, y: f64, direction: String, amount: u32 },
    Type { text: String },
    Key { keys: String },
}

fn point(x: f64, y: f64, factor: f64) -> (u16, u16) {
    ((x * factor).round().clamp(0.0, u16::MAX as f64) as u16, (y * factor).round().clamp(0.0, u16::MAX as f64) as u16)
}

/// Perform one action at screenshot coordinates (see `scaled`).
pub fn act(rfb: &mut Rfb, action: &Action) -> Result<String, String> {
    let (width, height) = rfb.size();
    let factor = scaled(width as u32, height as u32).2;
    match action {
        Action::Click { x, y, button, count } => {
            let (px, py) = point(*x, *y, factor);
            let mask = match button { 2 => 2, 3 => 4, _ => 1 };
            rfb.pointer(px, py, 0)?;
            for _ in 0..*count {
                rfb.pointer(px, py, mask)?;
                thread::sleep(STEP);
                rfb.pointer(px, py, 0)?;
                thread::sleep(STEP * 4);
            }
            Ok(format!("Clicked at ({x}, {y})."))
        }
        Action::Move { x, y } => {
            let (px, py) = point(*x, *y, factor);
            rfb.pointer(px, py, 0)?;
            Ok(format!("Moved the pointer to ({x}, {y})."))
        }
        Action::Drag { x, y, end_x, end_y } => {
            let (start, end) = (point(*x, *y, factor), point(*end_x, *end_y, factor));
            rfb.pointer(start.0, start.1, 0)?;
            rfb.pointer(start.0, start.1, 1)?;
            for step in 1..=16 {
                let t = step as f64 / 16.0;
                let lerp = |a: u16, b: u16| (a as f64 + (b as f64 - a as f64) * t).round() as u16;
                rfb.pointer(lerp(start.0, end.0), lerp(start.1, end.1), 1)?;
                thread::sleep(STEP);
            }
            rfb.pointer(end.0, end.1, 0)?;
            Ok(format!("Dragged from ({x}, {y}) to ({end_x}, {end_y})."))
        }
        Action::Scroll { x, y, direction, amount } => {
            let (px, py) = point(*x, *y, factor);
            let mask = match direction.as_str() { "up" => 8, "down" => 16, "left" => 32, "right" => 64, _ => return Err("Scroll direction is up, down, left or right.".into()) };
            rfb.pointer(px, py, 0)?;
            for _ in 0..(*amount).clamp(1, 30) {
                rfb.pointer(px, py, mask)?;
                rfb.pointer(px, py, 0)?;
                thread::sleep(STEP);
            }
            Ok(format!("Scrolled {direction} {amount} at ({x}, {y})."))
        }
        Action::Type { text } => {
            if text.chars().count() > 4000 {
                return Err("Type at most 4000 characters at a time.".into());
            }
            for ch in text.chars() {
                let shift = shifted(ch);
                if shift { rfb.key(SHIFT, true)?; }
                rfb.key(keysym(ch), true)?;
                rfb.key(keysym(ch), false)?;
                if shift { rfb.key(SHIFT, false)?; }
                thread::sleep(Duration::from_millis(4));
            }
            Ok(format!("Typed {} characters.", text.chars().count()))
        }
        Action::Key { keys } => {
            let syms = combo(keys)?;
            for sym in &syms {
                rfb.key(*sym, true)?;
            }
            thread::sleep(STEP);
            for sym in syms.iter().rev() {
                rfb.key(*sym, false)?;
            }
            Ok(format!("Pressed {keys}."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_wide_screens_to_a_model_friendly_width() {
        assert_eq!(scaled(1024, 768), (1024, 768, 1.0));
        let (w, h, f) = scaled(2560, 1600);
        assert_eq!((w, h), (1280, 800));
        assert!((f - 2.0).abs() < 1e-9);
    }
    #[test]
    fn maps_characters_and_combinations_to_keysyms() {
        assert_eq!(keysym('a'), 0x61);
        assert_eq!(keysym('\n'), 0xff0d);
        assert_eq!(keysym('é'), 0xe9);
        assert_eq!(keysym('€'), 0x0100_20ac);
        assert_eq!(combo("ctrl+shift+t").unwrap(), vec![0xffe3, 0xffe1, 0x74]);
        assert_eq!(combo("cmd+space").unwrap(), vec![0xffeb, 0x20]);
        assert_eq!(combo("Return").unwrap(), vec![0xff0d]);
        assert_eq!(combo("F5").unwrap(), vec![0xffc2]);
        assert!(combo("ctrl+").is_err());
        assert!(combo("hyper").is_err());
        assert!(shifted('A') && shifted('?') && !shifted('a') && !shifted('/'));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Computer use end to end on a Linux VM with the PandaCode desktop:
    /// `PANDACODE_VM=name PANDACODE_VNC=vnc://… cargo test --lib -- --ignored vm::screen::live`
    #[test]
    #[ignore]
    fn opens_a_terminal_and_types_a_command() {
        let (password, address) = crate::vm::parse_vnc_url(&std::env::var("PANDACODE_VNC").unwrap()).unwrap();
        let name = std::env::var("PANDACODE_VM").unwrap();
        let mut rfb = Rfb::connect(address, password.as_deref(), Duration::from_secs(5)).unwrap();
        crate::vm::backend().exec(&name, false, "rm -f /tmp/pandacode-cu", Duration::from_secs(20)).unwrap();
        // Xfce's dock, centred along the bottom: the terminal launcher.
        let (width, height) = rfb.size();
        act(&mut rfb, &Action::Click { x: width as f64 / 2.0 - 72.0, y: height as f64 - 25.0, button: 1, count: 1 }).unwrap();
        thread::sleep(Duration::from_secs(2));
        act(&mut rfb, &Action::Type { text: "echo \"Hi PandaCode: 6*7=$((6*7))!\" > /tmp/pandacode-cu".into() }).unwrap();
        act(&mut rfb, &Action::Key { keys: "Return".into() }).unwrap();
        thread::sleep(Duration::from_millis(800));
        screenshot(&mut rfb, 80).map(|s| std::fs::write(std::env::temp_dir().join("pandacode-vm-cu.jpg"), s.jpeg)).unwrap().unwrap();
        let out = crate::vm::backend().exec(&name, false, "cat /tmp/pandacode-cu", Duration::from_secs(20)).unwrap();
        assert_eq!(out.stdout, "Hi PandaCode: 6*7=42!\n");
        act(&mut rfb, &Action::Key { keys: "ctrl+d".into() }).unwrap();
    }
}
