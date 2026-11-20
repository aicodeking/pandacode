//! macOS: re-sign PandaCode's own bundle with a stable, per-machine self-signed identity, so
//! keychain ACLs and privacy (TCC) grants, which pin the code signature, survive updates.
//! Release builds are ad hoc signed, which gives every version a new identity. The identity
//! lives in its own keychain (`~/Library/Keychains/pandacode-signing.keychain-db`), unlocked by a
//! random password kept 0600 in the app data dir. The certificate is untrusted, which codesign
//! accepts when the identity is named by its SHA-1, and the key's partition list lets codesign
//! use it without a prompt. A bundle signed by anyone else (Developer ID) is left alone.
//! Elsewhere every entry point is a no-op.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};

const IDENTITY: &str = "PandaCode Local Signing";

/// `.../X.app/Contents/MacOS/bin` → `.../X.app`; `None` when not running from an app bundle.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && app.extension()? == "app")
        .then(|| app.to_path_buf())
}

#[derive(Debug, PartialEq)]
enum Signer {
    /// Ad hoc or unsigned: ours to sign.
    AdHoc,
    Ours,
    Other,
}

/// Reads `codesign -dvv` output (its stderr).
fn signer(details: &str) -> Signer {
    if details.lines().any(|line| line.trim() == "Signature=adhoc") {
        return Signer::AdHoc;
    }
    match details.lines().find_map(|line| line.strip_prefix("Authority=")) {
        Some(IDENTITY) => Signer::Ours,
        Some(_) => Signer::Other,
        None => Signer::AdHoc,
    }
}

/// The SHA-1 of our identity in `security find-identity` output.
fn identity_hash(listing: &str) -> Option<String> {
    listing
        .lines()
        .filter(|line| line.contains(&format!("\"{IDENTITY}\"")))
        .find_map(|line| line.split_whitespace().nth(1))
        .filter(|hash| hash.len() == 40 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_string)
}

/// Signs the running app's bundle; does nothing outside an app bundle (development builds).
pub fn sign_running_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    match bundle_of(&exe) {
        Some(bundle) => ensure_signed(&bundle),
        None => Ok(()),
    }
}

/// `pandacode --local-sign`, run by the npx installer: sign, report, exit code.
pub fn cli() -> i32 {
    match sign_running_app() {
        Ok(()) => {
            println!("PandaCode is signed with its local identity.");
            0
        }
        Err(error) => {
            eprintln!("PandaCode local signing failed: {error}");
            1
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_signed(_bundle: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub use mac::ensure_signed;

#[cfg(target_os = "macos")]
mod mac {
    use super::{identity_hash, signer, Signer, IDENTITY};
    use std::{
        fs,
        io::Write,
        os::unix::fs::OpenOptionsExt,
        path::{Path, PathBuf},
        process::Command,
        sync::Mutex,
        time::Duration,
    };

    /// One signing at a time: the startup pass, the updater's call and the CLI never overlap.
    static LOCK: Mutex<()> = Mutex::new(());
    const QUICK: Duration = Duration::from_secs(30);
    const SIGN: Duration = Duration::from_secs(300);
    const CODESIGN: &str = "/usr/bin/codesign";
    const SECURITY: &str = "/usr/bin/security";
    const OPENSSL: &str = "/usr/bin/openssl";
    const CERTIFICATE: &str = "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n\
        [dn]\nCN=PandaCode Local Signing\n\
        [v3]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n\
        extendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n";

    struct Output {
        ok: bool,
        stdout: Vec<u8>,
        stderr: String,
    }

    fn exec(program: &str, args: &[&str], input: Option<&[u8]>, timeout: Duration) -> Result<Output, String> {
        let mut command = Command::new(program);
        command.args(args);
        let output =
            crate::workspace::run_process_with_input(command, program, 1024 * 1024, timeout, input)?;
        Ok(Output {
            ok: output.status.success(),
            stdout: output.stdout.bytes,
            stderr: String::from_utf8_lossy(&output.stderr.bytes).into_owned(),
        })
    }

    fn run(program: &str, args: &[&str], input: Option<&[u8]>, timeout: Duration) -> Result<Vec<u8>, String> {
        let output = exec(program, args, input, timeout)?;
        if output.ok {
            Ok(output.stdout)
        } else {
            let name = program.rsplit('/').next().unwrap_or(program);
            Err(format!("{name} {} failed: {}", args.first().unwrap_or(&""), output.stderr.trim()))
        }
    }

    fn utf8(path: &Path) -> Result<&str, String> {
        path.to_str().ok_or_else(|| format!("Unsupported path {}", path.display()))
    }

    pub fn ensure_signed(bundle: &Path) -> Result<(), String> {
        let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let bundle = utf8(bundle)?;
        // Unsigned code makes this fail with no Authority line, which reads as ad hoc.
        let details = exec(CODESIGN, &["-dvv", bundle], None, QUICK)?.stderr;
        if signer(&details) != Signer::AdHoc {
            return Ok(());
        }
        let (keychain, hash) = identity()?;
        run(
            CODESIGN,
            &[
                "--force",
                "--deep",
                "--preserve-metadata=identifier,entitlements,flags,runtime",
                "--sign",
                &hash,
                "--keychain",
                utf8(&keychain)?,
                bundle,
            ],
            None,
            SIGN,
        )?;
        run(CODESIGN, &["--verify", "--deep", "--strict", bundle], None, SIGN)?;
        Ok(())
    }

    fn paths() -> Result<(PathBuf, PathBuf), String> {
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?);
        Ok((
            home.join("Library/Keychains/pandacode-signing.keychain-db"),
            home.join("Library/Application Support/ai.pandacode.desktop/local-signing.password"),
        ))
    }

    /// Unlocks the signing keychain and returns it with our identity's SHA-1, creating both
    /// when missing or unusable (lost password, deleted identity).
    fn identity() -> Result<(PathBuf, String), String> {
        let (keychain, secret) = paths()?;
        if let Some(hash) = unlock_and_find(&keychain, &secret)? {
            return Ok((keychain, hash));
        }
        let _ = exec(SECURITY, &["delete-keychain", utf8(&keychain)?], None, QUICK);
        let _ = fs::remove_file(&keychain);
        create(&keychain, &secret)?;
        let hash = unlock_and_find(&keychain, &secret)?
            .ok_or("The new signing identity was not found in its keychain.")?;
        Ok((keychain, hash))
    }

    fn unlock_and_find(keychain: &Path, secret: &Path) -> Result<Option<String>, String> {
        let (Ok(password), true) = (fs::read_to_string(secret), keychain.exists()) else {
            return Ok(None);
        };
        let keychain = utf8(keychain)?;
        if !exec(SECURITY, &["unlock-keychain", "-p", password.trim(), keychain], None, QUICK)?.ok {
            return Ok(None);
        }
        let listing = exec(SECURITY, &["find-identity", "-p", "codesigning", keychain], None, QUICK)?;
        Ok(identity_hash(&String::from_utf8_lossy(&listing.stdout)))
    }

    fn create(keychain: &Path, secret: &Path) -> Result<(), String> {
        let password = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        if let Some(dir) = secret.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(secret)
            .and_then(|mut file| file.write_all(password.as_bytes()))
            .map_err(|e| format!("Could not save the signing keychain password: {e}"))?;
        let path = utf8(keychain)?;
        run(SECURITY, &["create-keychain", "-p", &password, path], None, QUICK)?;
        // No idle lock: signing may happen hours after launch.
        run(SECURITY, &["set-keychain-settings", path], None, QUICK)?;
        run(SECURITY, &["unlock-keychain", "-p", &password, path], None, QUICK)?;
        let scratch = std::env::temp_dir().join(format!("pandacode-signing-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
        let result = import(path, &password, &scratch);
        let _ = fs::remove_dir_all(&scratch);
        result
    }

    /// The private key only travels through pipes: openssl → pkcs12 → the keychain.
    fn import(keychain: &str, password: &str, scratch: &Path) -> Result<(), String> {
        let config = scratch.join("certificate.cnf");
        let certificate = scratch.join("certificate.pem");
        fs::write(&config, CERTIFICATE).map_err(|e| e.to_string())?;
        let key = run(
            OPENSSL,
            &[
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "36500",
                "-keyout", "/dev/stdout",
                "-out", utf8(&certificate)?,
                "-config", utf8(&config)?,
            ],
            None,
            QUICK,
        )?;
        let passout = format!("pass:{password}");
        let p12 = run(
            OPENSSL,
            &[
                "pkcs12", "-export", "-inkey", "/dev/stdin",
                "-in", utf8(&certificate)?,
                "-name", IDENTITY,
                "-passout", &passout,
            ],
            Some(&key),
            QUICK,
        )?;
        run(
            SECURITY,
            &["import", "/dev/stdin", "-k", keychain, "-f", "pkcs12", "-P", password, "-T", CODESIGN],
            Some(&p12),
            QUICK,
        )?;
        // Lets codesign use the key without asking.
        run(
            SECURITY,
            &["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain],
            None,
            QUICK,
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_around_the_executable() {
        assert_eq!(
            bundle_of(Path::new("/Applications/PandaCode.app/Contents/MacOS/pandacode")),
            Some(PathBuf::from("/Applications/PandaCode.app"))
        );
        assert_eq!(bundle_of(Path::new("/repo/src-tauri/target/debug/pandacode")), None);
        assert_eq!(bundle_of(Path::new("/x/Tool/Contents/MacOS/pandacode")), None);
    }

    #[test]
    fn reads_the_signer() {
        let adhoc = "Identifier=ai.pandacode.desktop\nCodeDirectory v=20500 flags=0x10002(adhoc,runtime)\nSignature=adhoc\nTeamIdentifier=not set\n";
        assert_eq!(signer(adhoc), Signer::AdHoc);
        assert_eq!(signer("X.app: code object is not signed at all\n"), Signer::AdHoc);
        assert_eq!(signer("Signature size=1688\nAuthority=PandaCode Local Signing\n"), Signer::Ours);
        let developer = "Authority=Developer ID Application: Someone (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\n";
        assert_eq!(signer(developer), Signer::Other);
    }

    #[test]
    fn reads_the_identity_hash() {
        let listing = "\nPolicy: Code Signing\n  Matching identities\n  1) 4E200BF903AB2CAAABFF2CCFE671A3853FC90C0C \"PandaCode Local Signing\" (CSSMERR_TP_NOT_TRUSTED)\n     1 identities found\n";
        assert_eq!(identity_hash(listing).as_deref(), Some("4E200BF903AB2CAAABFF2CCFE671A3853FC90C0C"));
        assert_eq!(identity_hash("  0 identities found\n"), None);
    }

    /// Creates (or reuses) the real per-machine identity and signs a scratch bundle.
    /// Run with `cargo test --manifest-path src-tauri/Cargo.toml local_signing -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn signs_a_scratch_bundle() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("pandacode-sign-test-{}", uuid::Uuid::new_v4().simple()));
        let bundle = root.join("Scratch.app");
        let macos = bundle.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::copy("/usr/bin/true", macos.join("scratch")).unwrap();
        std::fs::write(
            bundle.join("Contents/Info.plist"),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>\
             <key>CFBundleExecutable</key><string>scratch</string>\
             <key>CFBundleIdentifier</key><string>ai.pandacode.signing-test</string></dict></plist>",
        )
        .unwrap();
        let codesign = |args: &[&str]| Command::new("/usr/bin/codesign").args(args).arg(&bundle).output().unwrap();
        assert!(codesign(&["--force", "--deep", "--sign", "-", "-o", "runtime"]).status.success());
        ensure_signed(&bundle).unwrap();
        let details = String::from_utf8_lossy(&codesign(&["-dvv"]).stderr).into_owned();
        assert_eq!(signer(&details), Signer::Ours, "{details}");
        assert!(details.contains("runtime"), "hardened runtime flag kept: {details}");
        ensure_signed(&bundle).unwrap(); // Already ours: nothing to do.
        std::fs::remove_dir_all(&root).unwrap();
    }
}
