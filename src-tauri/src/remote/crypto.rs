//! End-to-end encryption between two devices of one account (docs/remote-access.md).
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    XChaCha20Poly1305, XNonce,
};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

const INFO: &[u8] = b"pandacode-remote v1";
const NONCE: usize = 24;

pub(crate) type Key = [u8; 32];

pub(crate) fn generate() -> StaticSecret {
    StaticSecret::random_from_rng(OsRng)
}

pub(crate) fn encode_secret(secret: &StaticSecret) -> String {
    STANDARD.encode(secret.to_bytes())
}

pub(crate) fn decode_secret(text: &str) -> Option<StaticSecret> {
    let bytes: [u8; 32] = STANDARD.decode(text.trim()).ok()?.try_into().ok()?;
    Some(StaticSecret::from(bytes))
}

pub(crate) fn public_key(secret: &StaticSecret) -> String {
    STANDARD.encode(PublicKey::from(secret).as_bytes())
}

fn decode_public(text: &str) -> Option<[u8; 32]> {
    STANDARD.decode(text.trim()).ok()?.try_into().ok()
}

/// First 16 bytes (128 bits) of SHA-256 of the raw public key, hex.
pub(crate) fn fingerprint(public: &str) -> String {
    decode_public(public).map(|raw| Sha256::digest(raw)[..16].iter().map(|b| format!("{b:02x}")).collect()).unwrap_or_default()
}

/// HKDF-SHA256 over the X25519 secret, salted with the sorted device ids.
pub(crate) fn pair_key(mine: &StaticSecret, my_id: &str, their_public: &str, their_id: &str) -> crate::Result<Key> {
    let theirs = decode_public(their_public).ok_or("That computer's key is malformed.")?;
    let shared = mine.diffie_hellman(&PublicKey::from(theirs));
    if !shared.was_contributory() {
        return Err("That computer's key is unusable.".into());
    }
    let mut ids = [my_id, their_id];
    ids.sort_unstable();
    let mut key = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(Some(ids.join("|").as_bytes()), shared.as_bytes()).expand(INFO, &mut key).map_err(|_| "Key derivation failed.")?;
    Ok(key)
}

fn aad(from: &str, to: &str) -> Vec<u8> {
    format!("{from}|{to}").into_bytes()
}

/// `base64(nonce24 || ciphertext)` with `from|to` as associated data.
pub(crate) fn seal(key: &Key, from: &str, to: &str, plaintext: &[u8]) -> crate::Result<String> {
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sealed = XChaCha20Poly1305::new(key.into()).encrypt(&nonce, Payload { msg: plaintext, aad: &aad(from, to) }).map_err(|_| "Encryption failed.")?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&sealed);
    Ok(STANDARD.encode(out))
}

/// Opens a body, inflating a [`pack`]ed plaintext.
pub(crate) fn open(key: &Key, from: &str, to: &str, body: &str) -> crate::Result<Vec<u8>> {
    open_packed(key, from, to, body).map(|(plain, _)| plain)
}

/// [`open`], and whether the plaintext came packed (only replies and events may).
pub(crate) fn open_packed(key: &Key, from: &str, to: &str, body: &str) -> crate::Result<(Vec<u8>, bool)> {
    let bytes = STANDARD.decode(body).map_err(|_| "Unreadable frame.")?;
    if bytes.len() < NONCE + 16 {
        return Err("Unreadable frame.".into());
    }
    let (nonce, sealed) = bytes.split_at(NONCE);
    let plain = XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad: &aad(from, to) }).map_err(|_| "A frame failed to decrypt.")?;
    let packed = plain.first() == Some(&PACKED);
    Ok((unpack(plain)?, packed))
}

/// Marks a packed plaintext: `z` + raw deflate. JSON plaintexts start with `{`.
const PACKED: u8 = b'z';
/// Plaintexts this small go as they are.
const PACK_OVER: usize = 1024;
/// The most a packed plaintext may inflate to (zip bombs). The largest legitimate one is a
/// `task.messages` page of `host::PACKED_PAGE_MAX` (1 MB) plus its envelope.
const MAX_UNPACKED: u64 = 2 * 1024 * 1024;

/// Deflates a plaintext over [`PACK_OVER`] bytes for a peer that accepts it (`"z": 1`),
/// when that is smaller.
pub(crate) fn pack(plain: &[u8]) -> Vec<u8> {
    use std::io::Write;
    if plain.len() <= PACK_OVER {
        return plain.to_vec();
    }
    let mut out = flate2::write::DeflateEncoder::new(vec![PACKED], flate2::Compression::new(6));
    match out.write_all(plain).and_then(|_| out.finish()) {
        Ok(packed) if packed.len() < plain.len() => packed,
        _ => plain.to_vec(),
    }
}

fn unpack(plain: Vec<u8>) -> crate::Result<Vec<u8>> {
    use std::io::Read;
    if plain.first() != Some(&PACKED) {
        return Ok(plain);
    }
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(&plain[1..]).take(MAX_UNPACKED + 1).read_to_end(&mut out).map_err(|_| "Unreadable frame.")?;
    if out.len() as u64 > MAX_UNPACKED {
        return Err("A frame was too large.".into());
    }
    Ok(out)
}

/// 32 random bytes, base64 (44 characters): route keys and handshake nonces.
pub(crate) fn random_token() -> String {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    STANDARD.encode(bytes)
}

/// Compares secrets without stopping at the first differing byte.
pub(crate) fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sides_derive_the_same_key_and_round_trip() {
        let (a, b) = (generate(), generate());
        let ab = pair_key(&a, "dev-a", &public_key(&b), "dev-b").unwrap();
        let ba = pair_key(&b, "dev-b", &public_key(&a), "dev-a").unwrap();
        assert_eq!(ab, ba);
        let body = seal(&ab, "dev-a", "dev-b", b"{\"type\":\"req\"}").unwrap();
        assert_eq!(open(&ba, "dev-a", "dev-b", &body).unwrap(), b"{\"type\":\"req\"}");
        // A third device derives a different key.
        let c = generate();
        assert_ne!(pair_key(&c, "dev-c", &public_key(&b), "dev-b").unwrap(), ab);
    }

    #[test]
    fn wrong_aad_or_tampering_fails() {
        let (a, b) = (generate(), generate());
        let key = pair_key(&a, "dev-a", &public_key(&b), "dev-b").unwrap();
        let body = seal(&key, "dev-a", "dev-b", b"hello").unwrap();
        assert!(open(&key, "dev-b", "dev-a", &body).is_err());
        assert!(open(&key, "dev-a", "dev-c", &body).is_err());
        let mut raw = STANDARD.decode(&body).unwrap();
        *raw.last_mut().unwrap() ^= 1;
        assert!(open(&key, "dev-a", "dev-b", &STANDARD.encode(raw)).is_err());
        assert!(open(&key, "dev-a", "dev-b", "short").is_err());
    }

    #[test]
    fn packed_frames_round_trip_and_small_ones_stay_plain() {
        let key = [7u8; 32];
        let big = serde_json::json!({"type": "res", "result": {"messages": vec!["the same words again and again"; 200]}}).to_string();
        let packed = pack(big.as_bytes());
        assert_eq!(packed[0], PACKED);
        assert!(packed.len() * 4 < big.len());
        assert_eq!(open(&key, "a", "b", &seal(&key, "a", "b", &packed).unwrap()).unwrap(), big.as_bytes());
        // Small frames, and plain ones from older hosts, open as before.
        assert_eq!(pack(b"{\"type\":\"res\"}"), b"{\"type\":\"res\"}");
        assert_eq!(open(&key, "a", "b", &seal(&key, "a", "b", big.as_bytes()).unwrap()).unwrap(), big.as_bytes());
    }

    #[test]
    fn a_packed_bomb_is_refused() {
        use std::io::Write;
        let mut out = flate2::write::DeflateEncoder::new(vec![PACKED], flate2::Compression::best());
        out.write_all(&vec![b' '; MAX_UNPACKED as usize + 1]).unwrap();
        let bomb = out.finish().unwrap();
        assert!(bomb.len() < 64 * 1024);
        let key = [7u8; 32];
        assert_eq!(open(&key, "a", "b", &seal(&key, "a", "b", &bomb).unwrap()).unwrap_err(), "A frame was too large.");
        assert!(open(&key, "a", "b", &seal(&key, "a", "b", b"z not deflate").unwrap()).is_err());
        // The biggest page a host sends still opens.
        let page = vec![b' '; super::super::host::PACKED_PAGE_MAX + 64 * 1024];
        assert_eq!(open_packed(&key, "a", "b", &seal(&key, "a", "b", &pack(&page)).unwrap()).unwrap(), (page, true));
    }

    /// Writes the fixture `mobile/tests/packed-frame.json` the phone's test opens.
    #[test]
    #[ignore]
    fn record_packed_fixture() {
        let key = [7u8; 32];
        let plain = serde_json::json!({"type": "res", "id": "fixture", "ok": true, "result": {"messages": (0..40).map(|i| serde_json::json!({"id": i, "role": "assistant", "text": format!("Reply {i}: the tests pass and the build is clean.")})).collect::<Vec<_>>()}}).to_string();
        let body = seal(&key, "host", "phone", &pack(plain.as_bytes())).unwrap();
        let fixture = serde_json::json!({"key": STANDARD.encode(key), "from": "host", "to": "phone", "body": body, "plain": plain});
        std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../mobile/tests/packed-frame.json"), fixture.to_string()).unwrap();
    }

    #[test]
    fn keys_encode_and_fingerprint() {
        let secret = generate();
        let restored = decode_secret(&encode_secret(&secret)).unwrap();
        assert_eq!(public_key(&restored), public_key(&secret));
        let print = fingerprint(&public_key(&secret));
        assert_eq!(print.len(), 32);
        assert!(print.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(fingerprint("nope"), "");
        assert!(pair_key(&secret, "a", &STANDARD.encode([0u8; 32]), "b").is_err());
    }

    #[test]
    fn random_tokens_are_long_and_distinct_and_compare_exactly() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 44);
        assert_ne!(a, b);
        assert!(same(&a, &a.clone()));
        assert!(!same(&a, &b) && !same(&a, &a[1..]) && !same("", "x"));
    }
}
