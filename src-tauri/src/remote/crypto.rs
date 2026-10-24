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

pub(crate) fn open(key: &Key, from: &str, to: &str, body: &str) -> crate::Result<Vec<u8>> {
    let bytes = STANDARD.decode(body).map_err(|_| "Unreadable frame.")?;
    if bytes.len() < NONCE + 16 {
        return Err("Unreadable frame.".into());
    }
    let (nonce, sealed) = bytes.split_at(NONCE);
    XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad: &aad(from, to) }).map_err(|_| "A frame failed to decrypt.".into())
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
}
