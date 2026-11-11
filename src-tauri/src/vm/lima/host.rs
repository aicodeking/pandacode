//! What a Linux host needs and PandaCode cannot install: QEMU from the distribution and
//! KVM. Cheap (a few file checks), so the panel can ask with every status.
use std::{fs::OpenOptions, io::ErrorKind, path::Path};

use crate::vm::backend::HostIssue;

/// Searched ahead of the user's PATH, where other tools ship their own old `qemu-img`.
pub const SYSTEM_DIRS: [&str; 6] = ["/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local/bin", "/run/current-system/sw/bin"];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kvm {
    Ready,
    Denied,
    Missing,
}

fn kvm() -> Kvm {
    match OpenOptions::new().read(true).write(true).open("/dev/kvm") {
        Ok(_) => Kvm::Ready,
        Err(error) if error.kind() == ErrorKind::NotFound => Kvm::Missing,
        Err(_) => Kvm::Denied,
    }
}

fn has(tool: &str) -> bool {
    SYSTEM_DIRS.iter().any(|dir| Path::new(dir).join(tool).is_file())
}

/// `os-release`'s `ID` and `ID_LIKE` words.
fn families(os_release: &str) -> Vec<String> {
    os_release.lines().filter_map(|line| line.strip_prefix("ID=").or_else(|| line.strip_prefix("ID_LIKE="))).flat_map(|value| value.trim_matches('"').split_whitespace()).map(str::to_lowercase).collect()
}

/// The distribution's install command for QEMU and UEFI firmware, plus the SSH client when that is missing too.
fn install_command(os_release: &str, arch: &str, ssh: bool) -> Option<String> {
    let families = families(os_release);
    let is = |name: &str| families.iter().any(|family| family == name);
    let arm = arch == "aarch64";
    let (base, packages, client) = if is("fedora") || is("rhel") {
        ("sudo dnf install", if arm { "qemu-kvm-core qemu-img edk2-aarch64" } else { "qemu-kvm-core qemu-img edk2-ovmf" }, "openssh-clients")
    } else if is("debian") || is("ubuntu") {
        ("sudo apt install", if arm { "qemu-system-arm qemu-utils qemu-efi-aarch64" } else { "qemu-system-x86 qemu-utils ovmf" }, "openssh-client")
    } else if is("arch") {
        ("sudo pacman -S", "qemu-base edk2-ovmf", "openssh")
    } else {
        return None;
    };
    Some(format!("{base} {packages}{}", if ssh { format!(" {client}") } else { String::new() }))
}

fn describe(missing: &[String], kvm: Kvm, os_release: &str, arch: &str) -> Option<HostIssue> {
    if !missing.is_empty() {
        let ssh = missing.iter().any(|tool| tool == "ssh");
        return Some(HostIssue {
            text: format!("Local VMs need {} from your distribution.", missing.join(", ")),
            command: install_command(os_release, arch, ssh),
        });
    }
    match kvm {
        Kvm::Ready => None,
        Kvm::Denied => Some(HostIssue { text: "Local VMs need access to /dev/kvm. Add yourself to the kvm group, then log out and back in.".into(), command: Some("sudo usermod -aG kvm $USER".into()) }),
        Kvm::Missing => Some(HostIssue { text: "This computer has no /dev/kvm. Turn on hardware virtualization in its firmware settings; PandaCode does not run VMs without it.".into(), command: None }),
    }
}

/// Why local VMs cannot run here, if they cannot.
pub fn issue() -> Option<HostIssue> {
    let arch = std::env::consts::ARCH;
    let qemu = format!("qemu-system-{arch}");
    let missing: Vec<String> = [qemu.as_str(), "qemu-img", "ssh"].into_iter().filter(|tool| !has(tool)).map(str::to_string).collect();
    describe(&missing, kvm(), &std::fs::read_to_string("/etc/os-release").unwrap_or_default(), arch)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEDORA: &str = "NAME=\"Fedora Linux\"\nID=fedora\nVERSION_ID=44\n";
    const UBUNTU: &str = "ID=ubuntu\nID_LIKE=debian\n";
    const MINT: &str = "ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n";
    const ROCKY: &str = "ID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\n";
    const MANJARO: &str = "ID=manjaro\nID_LIKE=arch\n";

    #[test]
    fn suggests_each_distributions_packages() {
        let x86 = |release| install_command(release, "x86_64", false);
        assert_eq!(x86(FEDORA).unwrap(), "sudo dnf install qemu-kvm-core qemu-img edk2-ovmf");
        assert_eq!(x86(ROCKY).unwrap(), "sudo dnf install qemu-kvm-core qemu-img edk2-ovmf");
        assert_eq!(x86(UBUNTU).unwrap(), "sudo apt install qemu-system-x86 qemu-utils ovmf");
        assert_eq!(x86(MINT).unwrap(), "sudo apt install qemu-system-x86 qemu-utils ovmf");
        assert_eq!(x86(MANJARO).unwrap(), "sudo pacman -S qemu-base edk2-ovmf");
        assert_eq!(x86("ID=opensuse-tumbleweed\n"), None);
        assert_eq!(install_command(UBUNTU, "aarch64", false).unwrap(), "sudo apt install qemu-system-arm qemu-utils qemu-efi-aarch64");
        assert_eq!(install_command(FEDORA, "aarch64", false).unwrap(), "sudo dnf install qemu-kvm-core qemu-img edk2-aarch64");
        assert_eq!(install_command(UBUNTU, "x86_64", true).unwrap(), "sudo apt install qemu-system-x86 qemu-utils ovmf openssh-client");
    }
    #[test]
    fn qemu_comes_before_kvm_and_a_ready_host_has_no_issue() {
        assert_eq!(describe(&[], Kvm::Ready, FEDORA, "x86_64"), None);
        let missing = describe(&["qemu-img".into()], Kvm::Denied, FEDORA, "x86_64").unwrap();
        assert_eq!(missing.text, "Local VMs need qemu-img from your distribution.");
        assert_eq!(missing.command.as_deref(), Some("sudo dnf install qemu-kvm-core qemu-img edk2-ovmf"));
        let denied = describe(&[], Kvm::Denied, FEDORA, "x86_64").unwrap();
        assert_eq!(denied.command.as_deref(), Some("sudo usermod -aG kvm $USER"));
        let absent = describe(&[], Kvm::Missing, FEDORA, "x86_64").unwrap();
        assert!(absent.command.is_none() && absent.text.contains("/dev/kvm"));
        assert!(describe(&["ssh".into()], Kvm::Ready, "ID=void\n", "x86_64").unwrap().command.is_none());
    }
}
