//! How one file is checked by the safety scan: the scan budgets, the `scan-limit` finding for
//! an incomplete scan, and the streamed per-line run of the shared rules
//! (`crate::skills::scan_safety`), with secrets redacted.
use super::*;

// Separate inventory's metadata prefix limit from safety's streamed content budget.
pub(super) const FILE_SCAN_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const FOLDER_SCAN_BYTES: u64 = 32 * 1024 * 1024;
pub(super) fn incomplete(file: &str, reason: &str) -> crate::skills::Finding {
    crate::skills::Finding {
        rule: "scan-limit",
        file: redact_warning(file),
        line: 1,
        excerpt: reason.into(),
    }
}
pub(super) fn scan_file(path: &Path, name: &str, limit: u64) -> (Vec<crate::skills::Finding>, u64) {
    use std::io::BufRead;
    let Ok(file) = fs::File::open(path) else {
        return (
            vec![incomplete(name, "File could not be read; scan incomplete.")],
            0,
        );
    };
    let mut reader = std::io::BufReader::new(file.take(limit + 1));
    let mut bytes = Vec::new();
    let mut logical = String::new();
    let mut used = 0;
    let mut line = 0;
    let mut first_line = 1;
    let mut findings = Vec::new();
    loop {
        bytes.clear();
        let count = match reader.read_until(b'\n', &mut bytes) {
            Ok(count) => count,
            Err(_) => {
                findings.push(incomplete(name, "File could not be read; scan incomplete."));
                break;
            }
        };
        used += count as u64;
        if used > limit {
            findings.push(incomplete(
                name,
                "Safety scan byte limit reached; scan incomplete.",
            ));
            break;
        }
        if count == 0 && logical.is_empty() {
            break;
        }
        line += 1;
        let text = String::from_utf8_lossy(&bytes);
        let physical = text.trim_end_matches(['\r', '\n']);
        let continued = physical.bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1;
        logical.push_str(if continued {
            &physical[..physical.len() - 1]
        } else {
            physical
        });
        if continued && count != 0 {
            continue;
        }
        let mut warnings = crate::skills::scan_safety(name, &logical);
        let secret = warnings.iter().any(|f| f.rule == "secret");
        for finding in &mut warnings {
            finding.line = first_line;
            if secret {
                finding.excerpt = "[secret redacted]".into();
            }
            finding.file = redact_warning(&finding.file);
        }
        findings.extend(warnings);
        logical.clear();
        first_line = line + 1;
        if count == 0 {
            break;
        }
    }
    (findings, used)
}
