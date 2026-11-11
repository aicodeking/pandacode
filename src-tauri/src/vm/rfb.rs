//! A small RFB (VNC) client for VM screens: full-frame captures in Raw encoding, pointer
//! and key events. Virtualization.framework's VNC server speaks RFB 3.8, so a VM needs no
//! guest software for computer use. Blocking I/O with timeouts; callers use a worker thread.
use image::RgbaImage;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::{Duration, Instant},
};

const RAW: i32 = 0;
const DESKTOP_SIZE: i32 = -223;
/// Larger frames than this are refused rather than allocated.
const MAX_SIDE: u16 = 8192;
/// Virtualization.framework and QEMU answer a frame request only when the screen changed, so
/// after the first full frame a quiet period this long means "unchanged". The request stays
/// open, and its late answer reaches a later capture, which reads it before asking again.
const QUIET: Duration = Duration::from_millis(250);
/// Once this capture's request has an answer, wait this long for more before returning the frame.
const DRAIN: Duration = Duration::from_millis(25);
/// How long a capture looks for answers that arrived before it asks: they are already buffered.
const BUFFERED: Duration = Duration::from_millis(1);

pub struct Rfb {
    stream: TcpStream,
    /// Each read and write, and each capture as a whole.
    timeout: Duration,
    width: u16,
    height: u16,
    pixels: Vec<u8>,
    /// A complete frame has arrived at the current size; later requests are incremental.
    complete: bool,
    /// A call failed, perhaps partway through a message, so the stream can no longer be trusted.
    broken: bool,
}

fn io(error: std::io::Error) -> String {
    format!("VNC connection failed: {error}")
}

impl Rfb {
    pub fn connect(address: SocketAddr, password: Option<&str>, timeout: Duration) -> Result<Self, String> {
        let stream = TcpStream::connect_timeout(&address, timeout).map_err(io)?;
        stream.set_read_timeout(Some(timeout)).map_err(io)?;
        stream.set_write_timeout(Some(timeout)).map_err(io)?;
        stream.set_nodelay(true).map_err(io)?;
        let mut rfb = Rfb { stream, timeout, width: 0, height: 0, pixels: Vec::new(), complete: false, broken: false };
        rfb.handshake(password)?;
        Ok(rfb)
    }

    pub fn size(&self) -> (u16, u16) {
        (self.width, self.height)
    }
    /// Whether a call failed; the caller should connect again.
    pub fn broken(&self) -> bool {
        self.broken
    }
    fn mark<T>(&mut self, result: Result<T, String>) -> Result<T, String> {
        self.broken |= result.is_err();
        result
    }

    fn read<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let mut buffer = [0; N];
        self.stream.read_exact(&mut buffer).map_err(io)?;
        Ok(buffer)
    }
    fn read_vec(&mut self, length: usize) -> Result<Vec<u8>, String> {
        let mut buffer = vec![0; length];
        self.stream.read_exact(&mut buffer).map_err(io)?;
        Ok(buffer)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.read::<4>()?))
    }
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.stream.write_all(bytes).map_err(io)
    }

    fn handshake(&mut self, password: Option<&str>) -> Result<(), String> {
        let version = self.read::<12>()?;
        if !version.starts_with(b"RFB 003.") {
            return Err("The VM's screen server is not a VNC server.".into());
        }
        self.send(b"RFB 003.008\n")?;
        let count = self.read::<1>()?[0] as usize;
        if count == 0 {
            let length = self.u32()? as usize;
            let reason = self.read_vec(length.min(4096))?;
            return Err(format!("VNC refused the connection: {}", String::from_utf8_lossy(&reason)));
        }
        let types = self.read_vec(count)?;
        if types.contains(&1) {
            self.send(&[1])?;
        } else if types.contains(&2) {
            self.send(&[2])?;
            let challenge = self.read::<16>()?;
            let password = password.ok_or("The VM's screen needs a VNC password.")?;
            self.send(&super::vnc_auth::response(password, &challenge))?;
        } else {
            return Err("The VM's screen uses an unsupported VNC security type.".into());
        }
        if self.u32()? != 0 {
            return Err("VNC rejected the password.".into());
        }
        // Shared session, so PandaCode's panel and the agent can look at once.
        self.send(&[1])?;
        let init = self.read::<24>()?;
        let name_length = u32::from_be_bytes([init[20], init[21], init[22], init[23]]) as usize;
        self.read_vec(name_length.min(1 << 16))?;
        self.resize(u16::from_be_bytes([init[0], init[1]]), u16::from_be_bytes([init[2], init[3]]))?;
        // 32 bits per pixel, depth 24, little endian, true colour: bytes arrive as B, G, R, X.
        let mut format = vec![0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0];
        self.send(&format)?;
        format.clear();
        format.extend_from_slice(&[2, 0, 0, 2]);
        for encoding in [RAW, DESKTOP_SIZE] {
            format.extend_from_slice(&encoding.to_be_bytes());
        }
        self.send(&format)
    }

    /// Size the frame; true if the size changed (some servers repeat it unchanged, which keeps the frame).
    fn resize(&mut self, width: u16, height: u16) -> Result<bool, String> {
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return Err(format!("The VM's screen reported an invalid size {width}×{height}."));
        }
        if (width, height) == (self.width, self.height) {
            return Ok(false);
        }
        self.width = width;
        self.height = height;
        self.pixels = vec![0; width as usize * height as usize * 4];
        Ok(true)
    }

    /// The next message type, or None if the server stays quiet for `wait`.
    fn next_message(&mut self, wait: Duration) -> Result<Option<u8>, String> {
        self.stream.set_read_timeout(Some(wait)).map_err(io)?;
        let mut kind = [0u8; 1];
        let read = self.stream.read_exact(&mut kind);
        self.stream.set_read_timeout(Some(self.timeout)).map_err(io)?;
        match read {
            Ok(()) => Ok(Some(kind[0])),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(None),
            Err(error) => Err(io(error)),
        }
    }

    /// The whole screen as it is now. The first call waits for a full frame; later calls
    /// ask for changes only and keep the frame they already have when nothing changed.
    /// Updates already waiting answer older, unanswered requests (QEMU merges all of those
    /// into one), so they are read before asking; only an update after the request ends the
    /// wait early, and the late answers of still captures never cost a wait. A resize asks for
    /// a full frame at the new size (its pixels start black). A capture never takes longer than
    /// `timeout`: past it, a server that keeps streaming updates gets the frame read so far.
    pub fn capture(&mut self) -> Result<RgbaImage, String> {
        let result = self.capture_by(Instant::now() + self.timeout);
        self.mark(result)
    }
    fn capture_by(&mut self, deadline: Instant) -> Result<RgbaImage, String> {
        let left = || deadline.saturating_duration_since(Instant::now());
        if self.complete {
            loop {
                let left = left();
                if left.is_zero() {
                    break;
                }
                let Some(kind) = self.next_message(BUFFERED.min(left))? else { break };
                self.message(kind)?;
            }
        }
        let mut wait = self.request()?;
        loop {
            let left = left();
            if left.is_zero() {
                break;
            }
            let Some(kind) = self.next_message(wait.min(left))? else { break };
            if self.message(kind)? {
                wait = if self.complete { DRAIN } else { self.request()? };
            }
        }
        if !self.complete {
            return Err("The VM's screen did not send a frame.".into());
        }
        let rgba = self.pixels.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], 255]).collect();
        RgbaImage::from_raw(self.width as u32, self.height as u32, rgba).ok_or_else(|| "The VM's screen frame was incomplete.".into())
    }
    /// Ask for the screen, all of it until a complete frame arrived; returns how long to wait.
    fn request(&mut self) -> Result<Duration, String> {
        let mut request = vec![3, u8::from(self.complete), 0, 0, 0, 0];
        request.extend_from_slice(&self.width.to_be_bytes());
        request.extend_from_slice(&self.height.to_be_bytes());
        self.send(&request)?;
        Ok(if self.complete { QUIET } else { self.timeout })
    }

    /// Read one server message; true if it updated the frame.
    fn message(&mut self, kind: u8) -> Result<bool, String> {
        match kind {
            0 => {
                // A resize leaves the new frame black until a full one arrives.
                self.complete = !self.update()?;
                return Ok(true);
            }
            // Colour map, bell and clipboard messages are read and ignored.
            1 => {
                let header = self.read::<5>()?;
                let colours = u16::from_be_bytes([header[3], header[4]]) as usize;
                self.read_vec(colours * 6)?;
            }
            2 => {}
            3 => {
                self.read::<3>()?;
                let length = self.u32()? as usize;
                self.read_vec(length.min(1 << 20))?;
            }
            other => return Err(format!("Unexpected VNC message {other}.")),
        }
        Ok(false)
    }

    /// Read one frame update; true if it resized the screen.
    fn update(&mut self) -> Result<bool, String> {
        let header = self.read::<3>()?;
        let mut resized = false;
        let rectangles = u16::from_be_bytes([header[1], header[2]]);
        for _ in 0..rectangles {
            let rect = self.read::<12>()?;
            let field = |i: usize| u16::from_be_bytes([rect[i], rect[i + 1]]);
            let (x, y, w, h) = (field(0), field(2), field(4), field(6));
            match i32::from_be_bytes([rect[8], rect[9], rect[10], rect[11]]) {
                RAW => {
                    if x as usize + w as usize > self.width as usize || y as usize + h as usize > self.height as usize {
                        return Err("The VM sent a screen region outside its frame.".into());
                    }
                    let data = self.read_vec(w as usize * h as usize * 4)?;
                    for row in 0..h as usize {
                        let start = ((y as usize + row) * self.width as usize + x as usize) * 4;
                        self.pixels[start..start + w as usize * 4].copy_from_slice(&data[row * w as usize * 4..(row + 1) * w as usize * 4]);
                    }
                }
                DESKTOP_SIZE => resized |= self.resize(w, h)?,
                other => return Err(format!("Unsupported VNC encoding {other}.")),
            }
        }
        Ok(resized)
    }

    /// Move the pointer with `buttons` held (bit 0 left, 1 middle, 2 right, 3/4 wheel up/down).
    pub fn pointer(&mut self, x: u16, y: u16, buttons: u8) -> Result<(), String> {
        let (x, y) = (x.min(self.width.saturating_sub(1)), y.min(self.height.saturating_sub(1)));
        let mut event = vec![5, buttons];
        event.extend_from_slice(&x.to_be_bytes());
        event.extend_from_slice(&y.to_be_bytes());
        let sent = self.send(&event);
        self.mark(sent)
    }

    pub fn key(&mut self, keysym: u32, down: bool) -> Result<(), String> {
        let mut event = vec![4, u8::from(down), 0, 0];
        event.extend_from_slice(&keysym.to_be_bytes());
        let sent = self.send(&event);
        self.mark(sent)
    }
}

#[cfg(test)]
mod tests;
