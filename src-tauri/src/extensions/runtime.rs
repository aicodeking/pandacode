//! Fail-closed support policy. Qualification code is a separate, test-only Cargo package.
//! A passing experiment must never implicitly enable executable installation.
pub(super) fn unsupported_reason() -> &'static str {
    reason_for(std::env::consts::OS)
}

fn reason_for(os: &str) -> &'static str {
    match os {
        "windows" => "Declarative-only: Windows OS sandbox, total-process memory limit and packaged runtime are not qualified.",
        "macos" => "Declarative-only: macOS isolation, resource enforcement and packaged runtime are not qualified.",
        "linux" => "Declarative-only: Linux isolation, resource enforcement and packaged runtime are not qualified.",
        _ => "Declarative-only: no executable runtime qualification exists for this target.",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_target_stays_declarative_with_a_specific_reason() {
        for os in ["windows", "macos", "linux", "unknown"] {
            let reason = super::reason_for(os);
            assert!(reason.starts_with("Declarative-only:"));
            assert!(reason.contains("not qualified") || reason.contains("no executable runtime"));
        }
    }
}
