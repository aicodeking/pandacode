/// Hides a relay key in an error. An empty key never redacts: `replace("")` would insert the
/// marker between every character.
pub(super) fn redact_key(error: &str, key: Option<&str>) -> String {
    match key {
        Some(key) if !key.is_empty() => error.replace(key, "[redacted]"),
        _ => error.to_string(),
    }
}

/// Hides every per-run key in an error, once, whichever return path produced it.
pub(super) fn redact_run_error(error: &str, keys: &[Option<&str>]) -> String {
    keys.iter()
        .fold(error.to_string(), |error, key| redact_key(&error, *key))
}

#[cfg(test)]
mod tests {
    use super::{redact_key, redact_run_error};

    #[test]
    fn empty_key_leaves_the_error_alone() {
        assert_eq!(redact_key("boom", Some("")), "boom");
        assert_eq!(redact_key("boom", None), "boom");
    }

    #[test]
    fn real_key_is_redacted() {
        assert_eq!(
            redact_key("bad sk-1 here", Some("sk-1")),
            "bad [redacted] here"
        );
    }

    #[test]
    fn every_key_of_a_run_is_hidden_once_and_no_keys_leave_the_error_alone() {
        let redacted = redact_run_error(
            "spawn failed: sk-a then sk-b, again sk-a",
            &[Some("sk-a"), None, Some("sk-b")],
        );
        assert_eq!(
            redacted,
            "spawn failed: [redacted] then [redacted], again [redacted]"
        );
        assert_eq!(
            redact_run_error("nothing to hide", &[None, Some("")]),
            "nothing to hide"
        );
    }
}
