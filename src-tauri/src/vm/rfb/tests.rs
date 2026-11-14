use super::*;
use std::{
    net::TcpListener,
    sync::mpsc,
    thread,
};

/// What the fake server saw the client send after the handshake.
#[derive(Debug, PartialEq)]
enum Seen {
    Pointer(u8, u16, u16),
    Key(u32, bool),
}

/// A minimal RFB 3.8 server: one 4×2 screen, optional VNC auth, a resize on the second
/// capture (answered in full only when asked in full), and a bell before each update.
fn serve(password: Option<&'static str>) -> (SocketAddr, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let take = |s: &mut TcpStream, n: usize| { let mut b = vec![0; n]; s.read_exact(&mut b).unwrap(); b };
        s.write_all(b"RFB 003.008\n").unwrap();
        assert_eq!(take(&mut s, 12), b"RFB 003.008\n");
        match password {
            None => { s.write_all(&[1, 1]).unwrap(); assert_eq!(take(&mut s, 1), [1]); }
            Some(password) => {
                s.write_all(&[1, 2]).unwrap();
                assert_eq!(take(&mut s, 1), [2]);
                let challenge = *b"0123456789abcdef";
                s.write_all(&challenge).unwrap();
                let ok = take(&mut s, 16) == crate::vm::vnc_auth::response(password, &challenge);
                s.write_all(&u32::from(!ok).to_be_bytes()).unwrap();
                if !ok { return; }
            }
        }
        if password.is_none() { s.write_all(&0u32.to_be_bytes()).unwrap(); }
        assert_eq!(take(&mut s, 1), [1], "shared session");
        let mut init = vec![0, 4, 0, 2];
        init.extend_from_slice(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
        init.extend_from_slice(&2u32.to_be_bytes());
        init.extend_from_slice(b"vm");
        s.write_all(&init).unwrap();
        assert_eq!(take(&mut s, 20)[0], 0, "SetPixelFormat");
        let encodings = take(&mut s, 4);
        assert_eq!(encodings[0], 2);
        take(&mut s, 4 * u16::from_be_bytes([encodings[2], encodings[3]]) as usize);
        let mut captures = 0;
        loop {
            let mut kind = [0u8; 1];
            if s.read_exact(&mut kind).is_err() { return; }
            match kind[0] {
                3 => {
                    let request = take(&mut s, 9);
                    let (incremental, size) = (request[0] == 1, (u16::from_be_bytes([request[5], request[6]]), u16::from_be_bytes([request[7], request[8]])));
                    captures += 1;
                    s.write_all(&[2]).unwrap(); // A bell to skip.
                    if captures == 1 {
                        assert!(!incremental && size == (4, 2));
                        // Two rectangles: left half red, right half blue (B, G, R, X).
                        let mut update = vec![0, 0, 0, 2];
                        for (x, colour) in [(0u16, [0, 0, 255, 0]), (2, [255, 0, 0, 0])] {
                            for value in [x, 0, 2, 2] { update.extend_from_slice(&value.to_be_bytes()); }
                            update.extend_from_slice(&0i32.to_be_bytes());
                            for _ in 0..4 { update.extend_from_slice(&colour); }
                        }
                        s.write_all(&update).unwrap();
                    } else if captures == 2 {
                        // The screen grows to 2×3, like QEMU: the new size alone, no pixels yet.
                        let mut update = vec![0, 0, 0, 1];
                        for value in [0u16, 0, 2, 3] { update.extend_from_slice(&value.to_be_bytes()); }
                        update.extend_from_slice(&(-223i32).to_be_bytes());
                        s.write_all(&update).unwrap();
                    } else if !incremental {
                        // The full frame the client asks for at the new size is green.
                        assert_eq!(size, (2, 3));
                        let mut update = vec![0, 0, 0, 1];
                        for value in [0u16, 0, 2, 3] { update.extend_from_slice(&value.to_be_bytes()); }
                        update.extend_from_slice(&0i32.to_be_bytes());
                        for _ in 0..6 { update.extend_from_slice(&[0, 255, 0, 0]); }
                        s.write_all(&update).unwrap();
                    }
                    // Otherwise nothing changed: like Virtualization.framework, send no update at all.
                }
                4 => { let b = take(&mut s, 7); tx.send(Seen::Key(u32::from_be_bytes([b[3], b[4], b[5], b[6]]), b[0] == 1)).unwrap(); }
                5 => { let b = take(&mut s, 5); tx.send(Seen::Pointer(b[0], u16::from_be_bytes([b[1], b[2]]), u16::from_be_bytes([b[3], b[4]]))).unwrap(); }
                other => panic!("unexpected client message {other}"),
            }
        }
    });
    (address, rx)
}

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn captures_raw_frames_and_follows_a_resize() {
    let (address, _) = serve(None);
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    assert_eq!(rfb.size(), (4, 2));
    let frame = rfb.capture().unwrap();
    assert_eq!(frame.get_pixel(0, 1).0, [255, 0, 0, 255]);
    assert_eq!(frame.get_pixel(3, 0).0, [0, 0, 255, 255]);
    // The resize carries no pixels: the capture asks again in full rather than return black.
    let grown = rfb.capture().unwrap();
    assert_eq!((grown.width(), grown.height()), (2, 3));
    assert!(grown.pixels().all(|p| p.0 == [0, 255, 0, 255]), "black frame");
    // An unchanged screen answers nothing; the client returns the frame it already has, quickly.
    let started = std::time::Instant::now();
    let same = rfb.capture().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    assert_eq!(same, grown);
}

#[test]
fn sends_pointer_and_key_events_clamped_to_the_screen() {
    let (address, seen) = serve(None);
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    rfb.pointer(3, 1, 1).unwrap();
    rfb.pointer(500, 500, 0).unwrap();
    rfb.key(0xff0d, true).unwrap();
    rfb.key(0xff0d, false).unwrap();
    let events: Vec<_> = (0..4).map(|_| seen.recv_timeout(WAIT).unwrap()).collect();
    assert_eq!(events, vec![Seen::Pointer(1, 3, 1), Seen::Pointer(0, 3, 1), Seen::Key(0xff0d, true), Seen::Key(0xff0d, false)]);
}

#[test]
fn authenticates_with_a_vnc_password() {
    let (address, _) = serve(Some("secret"));
    assert_eq!(Rfb::connect(address, Some("secret"), WAIT).unwrap().size(), (4, 2));
    let (address, _) = serve(Some("secret"));
    assert!(Rfb::connect(address, Some("wrong"), WAIT).err().unwrap().contains("rejected"));
    let (address, _) = serve(Some("secret"));
    assert!(Rfb::connect(address, None, WAIT).err().unwrap().contains("password"));
}

/// A 1×1 update of one colour (B, G, R, X).
fn pixel(colour: [u8; 4]) -> Vec<u8> {
    let mut update = vec![0, 0, 0, 1];
    for value in [0u16, 0, 1, 1] { update.extend_from_slice(&value.to_be_bytes()); }
    update.extend_from_slice(&0i32.to_be_bytes());
    update.extend_from_slice(&colour);
    update
}

const RED: [u8; 4] = [0, 0, 255, 0];
const GREEN: [u8; 4] = [0, 255, 0, 0];
const BLUE: [u8; 4] = [255, 0, 0, 0];

/// A `serve`-style 1×1 screen that hands each request to `answer` with its number (the
/// first, full one is 1) and its bytes after the type. A request it does not answer simply stays unanswered.
fn serve_with(answer: impl Fn(u32, &[u8], &mut TcpStream) + Send + 'static) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let take = |s: &mut TcpStream, n: usize| { let mut b = vec![0; n]; s.read_exact(&mut b).unwrap(); b };
        s.write_all(b"RFB 003.008\n").unwrap();
        take(&mut s, 12);
        s.write_all(&[1, 1]).unwrap();
        take(&mut s, 1);
        s.write_all(&0u32.to_be_bytes()).unwrap();
        take(&mut s, 1);
        let mut init = vec![0, 1, 0, 1];
        init.extend_from_slice(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
        init.extend_from_slice(&0u32.to_be_bytes());
        s.write_all(&init).unwrap();
        take(&mut s, 20);
        let encodings = take(&mut s, 4);
        take(&mut s, 4 * u16::from_be_bytes([encodings[2], encodings[3]]) as usize);
        let mut requests = 0;
        loop {
            let mut kind = [0u8; 1];
            if s.read_exact(&mut kind).is_err() { return; }
            assert_eq!(kind[0], 3);
            let request = take(&mut s, 9);
            requests += 1;
            answer(requests, &request, &mut s);
        }
    });
    address
}

const GAP: Duration = Duration::from_millis(100);

#[test]
fn a_capture_waits_past_the_late_answer_to_an_unanswered_request() {
    assert!(GAP > DRAIN && GAP * 2 < QUIET);
    let address = serve_with(|request, _, s| match request {
        1 => s.write_all(&pixel(RED)).unwrap(),
        // Request 2 goes unanswered until the screen changes, right after the second capture.
        2 => {
            let mut s = s.try_clone().unwrap();
            thread::spawn(move || { thread::sleep(QUIET + GAP); s.write_all(&pixel(GREEN)).unwrap(); });
        }
        // The answer to the request of the capture that must see the change comes a screen
        // refresh later, slower than DRAIN.
        _ => { thread::sleep(GAP); s.write_all(&pixel(BLUE)).unwrap(); }
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
    thread::sleep(GAP * 2);
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [0, 0, 255, 255], "stale frame");
}

#[test]
fn an_unchanged_screen_stays_quick_with_requests_left_unanswered() {
    let address = serve_with(|request, _, s| if request == 1 { s.write_all(&pixel(RED)).unwrap() });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    rfb.capture().unwrap();
    for _ in 0..4 {
        let started = std::time::Instant::now();
        assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert!(started.elapsed() < QUIET + GAP, "{:?}", started.elapsed());
    }
}

#[test]
fn a_server_that_merges_held_requests_still_returns() {
    // Like QEMU: however many requests are held, one change is one update.
    let address = serve_with(|request, _, s| match request {
        1 => s.write_all(&pixel(RED)).unwrap(),
        4 => s.write_all(&pixel(GREEN)).unwrap(),
        _ => {}
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    rfb.capture().unwrap();
    rfb.capture().unwrap();
    rfb.capture().unwrap();
    let started = std::time::Instant::now();
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [0, 255, 0, 255]);
    assert!(started.elapsed() < QUIET + GAP, "{:?}", started.elapsed());
    let started = std::time::Instant::now();
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [0, 255, 0, 255]);
    assert!(started.elapsed() < QUIET + GAP, "{:?}", started.elapsed());
}

#[test]
fn a_change_after_a_long_still_screen_is_quick_on_a_merging_server() {
    // The panel polls a still screen for a while, so QEMU holds many requests, then one change answers them all.
    let address = serve_with(|request, _, s| match request {
        1 => s.write_all(&pixel(RED)).unwrap(),
        22 => s.write_all(&pixel(GREEN)).unwrap(),
        _ => {}
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    rfb.capture().unwrap();
    for _ in 0..20 {
        assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
    }
    let started = std::time::Instant::now();
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [0, 255, 0, 255]);
    assert!(started.elapsed() < QUIET, "{:?}", started.elapsed());
}

#[test]
fn a_change_that_answered_held_requests_is_read_before_asking_again() {
    // Requests 2–4 are held; the screen turns green while nobody asks, and request 5 is
    // answered with blue a screen refresh later: the capture must wait for blue.
    let address = serve_with(|request, _, s| match request {
        1 => s.write_all(&pixel(RED)).unwrap(),
        4 => {
            let mut s = s.try_clone().unwrap();
            thread::spawn(move || { thread::sleep(QUIET + GAP); s.write_all(&pixel(GREEN)).unwrap(); });
        }
        5 => { thread::sleep(GAP); s.write_all(&pixel(BLUE)).unwrap(); }
        _ => {}
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    for _ in 0..4 {
        assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
    }
    thread::sleep(GAP * 2);
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [0, 0, 255, 255], "stale frame");
}

/// Against a running VM: `PANDACODE_VNC=vnc://:password@127.0.0.1:port cargo test --lib -- --ignored vm::rfb::tests::live`
#[test]
#[ignore]
fn live_capture_and_type() {
    let url = std::env::var("PANDACODE_VNC").expect("set PANDACODE_VNC");
    let (password, address) = crate::vm::parse_vnc_url(&url).unwrap();
    let mut rfb = Rfb::connect(address, password.as_deref(), WAIT).unwrap();
    let frame = rfb.capture().unwrap();
    let path = std::env::temp_dir().join("pandacode-vm-live.png");
    frame.save(&path).unwrap();
    eprintln!("{}×{} saved to {}", frame.width(), frame.height(), path.display());
    for ch in "echo pandacode".chars() {
        rfb.key(ch as u32, true).unwrap();
        rfb.key(ch as u32, false).unwrap();
    }
    std::thread::sleep(Duration::from_millis(400));
    rfb.capture().unwrap().save(std::env::temp_dir().join("pandacode-vm-live-typed.png")).unwrap();
}

/// Polls a running VM the way the panel does, then clicks and types through `screen::act`:
/// `PANDACODE_VNC=vnc://:password@127.0.0.1:port cargo test --lib -- --ignored vm::rfb::tests::live_frames`
#[test]
#[ignore]
fn live_frames_keep_coming() {
    use crate::vm::screen::{act, screenshot, Action};
    use std::time::Instant;
    let url = std::env::var("PANDACODE_VNC").expect("set PANDACODE_VNC");
    let (password, address) = crate::vm::parse_vnc_url(&url).unwrap();
    let started = Instant::now();
    let mut rfb = Rfb::connect(address, password.as_deref(), WAIT).unwrap();
    eprintln!("connected in {:?}", started.elapsed());
    let mut times = Vec::new();
    let mut failures = 0;
    for i in 0..40 {
        let started = Instant::now();
        match screenshot(&mut rfb, 70) {
            Ok(shot) => {
                let took = started.elapsed();
                if i == 0 {
                    eprintln!("first frame {:?}: {}×{} of {}×{}, {} bytes", took, shot.width, shot.height, shot.screen_width, shot.screen_height, shot.jpeg.len());
                    std::fs::write(std::env::temp_dir().join("pandacode-vm-live-first.jpg"), &shot.jpeg).unwrap();
                }
                times.push((took, shot.jpeg.len()));
            }
            Err(error) => { failures += 1; eprintln!("frame {i} failed: {error}"); }
        }
        std::thread::sleep(Duration::from_millis(220));
    }
    let mut sorted: Vec<_> = times.iter().skip(1).map(|(took, _)| *took).collect();
    sorted.sort();
    let at = |q: f64| sorted.get(((sorted.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or_default();
    let sizes: Vec<_> = times.iter().map(|(_, size)| *size).collect();
    eprintln!(
        "{} frames, {failures} failed; after the first: median {:?}, p95 {:?}, max {:?}; jpeg {}–{} bytes",
        times.len(), at(0.5), at(0.95), sorted.last().copied().unwrap_or_default(),
        sizes.iter().min().unwrap_or(&0), sizes.iter().max().unwrap_or(&0),
    );
    assert!(times.len() >= 35, "only {} of 40 frames", times.len());
    let (width, height) = { let shot = screenshot(&mut rfb, 70).unwrap(); (shot.width as f64, shot.height as f64) };
    eprintln!("{}", act(&mut rfb, &Action::Click { x: width / 2.0, y: height / 2.0, button: 1, count: 1 }).unwrap());
    eprintln!("{}", act(&mut rfb, &Action::Type { text: "echo pandacode\n".into() }).unwrap());
    std::thread::sleep(Duration::from_millis(400));
    let started = Instant::now();
    let acted = rfb.capture().unwrap();
    eprintln!("capture after typing {:?}", started.elapsed());
    acted.save(std::env::temp_dir().join("pandacode-vm-live-acted.png")).unwrap();
    // A new connection asks for the whole screen; the kept frame should already match it.
    let fresh = Rfb::connect(address, password.as_deref(), WAIT).unwrap().capture().unwrap();
    fresh.save(std::env::temp_dir().join("pandacode-vm-live-fresh.png")).unwrap();
    let mut last = acted.clone();
    for i in 0..10 {
        if last == fresh { break; }
        std::thread::sleep(Duration::from_millis(200));
        last = rfb.capture().unwrap();
        eprintln!("capture {} after typing {}", i + 1, if last == fresh { "caught up" } else { "still stale" });
    }
    assert!(last == fresh, "incremental frames never caught up: see pandacode-vm-live-fresh.png");
    assert!(acted == fresh, "the frame after typing was stale: compare pandacode-vm-live-acted.png and -fresh.png");
}

#[test]
fn a_resize_without_pixels_is_asked_for_again_in_full() {
    let address = serve_with(|request, bytes, s| {
        let size = (u16::from_be_bytes([bytes[5], bytes[6]]), u16::from_be_bytes([bytes[7], bytes[8]]));
        match request {
            1 => s.write_all(&pixel(RED)).unwrap(),
            // The screen grows to 2×1 and says only that.
            2 => {
                let mut update = vec![0, 0, 0, 1];
                for value in [0u16, 0, 2, 1] { update.extend_from_slice(&value.to_be_bytes()); }
                update.extend_from_slice(&(-223i32).to_be_bytes());
                s.write_all(&update).unwrap();
            }
            // Only a full request at the new size gets pixels, slower than DRAIN.
            _ if bytes[0] == 0 && size == (2, 1) => {
                thread::sleep(GAP);
                let mut update = vec![0, 0, 0, 1];
                for value in [0u16, 0, 2, 1] { update.extend_from_slice(&value.to_be_bytes()); }
                update.extend_from_slice(&0i32.to_be_bytes());
                for _ in 0..2 { update.extend_from_slice(&BLUE); }
                s.write_all(&update).unwrap();
            }
            _ => {}
        }
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    rfb.capture().unwrap();
    let grown = rfb.capture().unwrap();
    assert_eq!((grown.width(), grown.height()), (2, 1));
    assert!(grown.pixels().all(|p| p.0 == [0, 0, 255, 255]), "black frame");
}

#[test]
fn a_resize_that_includes_the_whole_frame_keeps_those_pixels() {
    // DesktopSize and one raw rectangle of the new frame, together. Nothing answers a
    // further request: asking again would time out and drop the pixels just received.
    let address = serve_with(|request, _, s| match request {
        1 => s.write_all(&pixel(RED)).unwrap(),
        2 => {
            let mut update = vec![0, 0, 0, 2];
            for value in [0u16, 0, 2, 1] { update.extend_from_slice(&value.to_be_bytes()); }
            update.extend_from_slice(&(-223i32).to_be_bytes());
            for value in [0u16, 0, 2, 1] { update.extend_from_slice(&value.to_be_bytes()); }
            update.extend_from_slice(&0i32.to_be_bytes());
            for _ in 0..2 { update.extend_from_slice(&BLUE); }
            s.write_all(&update).unwrap();
        }
        _ => {}
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    rfb.capture().unwrap();
    let started = std::time::Instant::now();
    let grown = rfb.capture().unwrap();
    assert!(started.elapsed() < QUIET, "{:?}", started.elapsed());
    assert_eq!((grown.width(), grown.height()), (2, 1));
    assert!(grown.pixels().all(|p| p.0 == [0, 0, 255, 255]), "the frame that arrived with the resize");
}

#[test]
fn a_buffered_resize_with_only_part_of_the_frame_is_asked_for_again() {
    assert!(GAP > DRAIN && GAP * 2 < QUIET);
    // The resize and a single pixel land while nobody is asking. That pixel is not the new
    // frame; the full request this capture then sends is.
    let address = serve_with(|request, bytes, s| {
        let size = (u16::from_be_bytes([bytes[5], bytes[6]]), u16::from_be_bytes([bytes[7], bytes[8]]));
        match request {
            1 => s.write_all(&pixel(RED)).unwrap(),
            2 => {
                let mut s = s.try_clone().unwrap();
                thread::spawn(move || {
                    thread::sleep(QUIET + GAP);
                    let mut update = vec![0, 0, 0, 1];
                    for value in [0u16, 0, 2, 1] { update.extend_from_slice(&value.to_be_bytes()); }
                    update.extend_from_slice(&(-223i32).to_be_bytes());
                    s.write_all(&update).unwrap();
                    let mut partial = vec![0, 0, 0, 1];
                    for value in [0u16, 0, 1, 1] { partial.extend_from_slice(&value.to_be_bytes()); }
                    partial.extend_from_slice(&0i32.to_be_bytes());
                    partial.extend_from_slice(&BLUE);
                    s.write_all(&partial).unwrap();
                });
            }
            _ if bytes[0] == 0 && size == (2, 1) => {
                let mut update = vec![0, 0, 0, 1];
                for value in [0u16, 0, 2, 1] { update.extend_from_slice(&value.to_be_bytes()); }
                update.extend_from_slice(&0i32.to_be_bytes());
                for _ in 0..2 { update.extend_from_slice(&GREEN); }
                s.write_all(&update).unwrap();
            }
            _ => {}
        }
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
    thread::sleep(GAP * 2);
    let grown = rfb.capture().unwrap();
    assert_eq!((grown.width(), grown.height()), (2, 1));
    assert!(grown.pixels().all(|p| p.0 == [0, 255, 0, 255]), "partial frame");
}

#[test]
fn a_capture_ends_at_its_timeout_however_fast_updates_keep_coming() {
    let address = serve_with(|request, _, s| match request {
        1 => s.write_all(&pixel(RED)).unwrap(),
        // From now on the screen changes every few milliseconds, forever.
        2 => {
            let mut s = s.try_clone().unwrap();
            thread::spawn(move || {
                let mut colours = [GREEN, BLUE].into_iter().cycle();
                while s.write_all(&pixel(colours.next().unwrap())).is_ok() {
                    thread::sleep(Duration::from_millis(5));
                }
            });
        }
        _ => {}
    });
    let timeout = Duration::from_millis(500);
    let mut rfb = Rfb::connect(address, None, timeout).unwrap();
    rfb.capture().unwrap();
    let started = std::time::Instant::now();
    let frame = rfb.capture().unwrap();
    assert!(started.elapsed() < timeout * 2, "{:?}", started.elapsed());
    assert_ne!(frame.get_pixel(0, 0).0, [255, 0, 0, 255], "the frame read so far");
}

#[test]
fn a_server_that_repeats_an_unchanged_size_keeps_the_frame() {
    // Some servers send DesktopSize at the same size with every update; that is no resize.
    let size = || {
        let mut rect = Vec::new();
        for value in [0u16, 0, 1, 1] { rect.extend_from_slice(&value.to_be_bytes()); }
        rect.extend_from_slice(&(-223i32).to_be_bytes());
        rect
    };
    let address = serve_with(move |request, _, s| {
        let mut update = vec![0, 0, 0, if request == 1 { 2 } else { 1 }];
        update.extend_from_slice(&size());
        if request == 1 {
            update.extend_from_slice(&pixel(RED)[4..]);
        }
        s.write_all(&update).unwrap();
    });
    let mut rfb = Rfb::connect(address, None, WAIT).unwrap();
    assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
    for _ in 0..3 {
        let started = std::time::Instant::now();
        assert_eq!(rfb.capture().unwrap().get_pixel(0, 0).0, [255, 0, 0, 255], "the frame was cleared");
        assert!(started.elapsed() < QUIET + GAP, "{:?}", started.elapsed());
    }
}
