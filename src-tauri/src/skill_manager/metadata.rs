//! Scalar decoding for manager identity; leave the import library's legacy parser alone.
pub(super) fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let (name, description, _) = parse(text);
    (name, description)
}
pub(super) fn needs_review(text: &str) -> bool {
    let (name, _, review) = parse(text);
    review || name.is_none()
}
fn parse(text: &str) -> (Option<String>, Option<String>, bool) {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return (None, None, false);
    };
    let Some(end) = rest.lines().position(|line| line == "---") else {
        return (None, None, true);
    };
    let lines: Vec<_> = rest.lines().take(end).collect();
    let (mut name, mut description, mut review) = (None, None, false);
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.starts_with(char::is_whitespace) || line.trim().is_empty() || line.starts_with('#')
        {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            review = true;
            continue;
        };
        let key = scalar(key.trim());
        if key.as_deref() == Some("name") && name.is_some() {
            review = true;
        }
        if key.as_deref() == Some("<<") || key.is_none() {
            review = true;
        }
        let value = value.trim();
        let tagged = value
            .strip_prefix("!!str")
            .filter(|s| s.starts_with(char::is_whitespace));
        let force_string = tagged.is_some();
        let value = tagged.map(str::trim_start).unwrap_or(value);
        // Consume every scalar, including unknown keys: its continuation may look like a key.
        let decoded = if value.starts_with(['|', '>']) {
            let header = value.split(" #").next().unwrap_or(value).trim_end();
            let flags = &header[1..];
            let valid = flags.len() <= 2
                && flags.chars().all(|c| matches!(c, '+' | '-' | '1'..='9'))
                && flags.chars().filter(char::is_ascii_digit).count() <= 1
                && flags.chars().filter(|c| matches!(c, '+' | '-')).count() <= 1;
            let start = i;
            while i < lines.len() && (lines[i].starts_with(' ') || lines[i].trim().is_empty()) {
                i += 1;
            }
            let indent = flags
                .chars()
                .find_map(|c| c.to_digit(10))
                .map(|n| n as usize)
                .or_else(|| {
                    lines[start..i]
                        .iter()
                        .find(|l| !l.trim().is_empty())
                        .map(|l| l.len() - l.trim_start_matches(' ').len())
                })
                .unwrap_or(0);
            if valid
                && lines[start..i]
                    .iter()
                    .all(|l| l.trim().is_empty() || l.starts_with(&" ".repeat(indent)))
            {
                Some(
                    lines[start..i]
                        .iter()
                        .map(|l| {
                            if l.trim().is_empty() {
                                ""
                            } else {
                                &l[indent..]
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
            } else {
                None
            }
        } else if value.starts_with(['"', '\'']) {
            let mut quoted = value.to_owned();
            while scalar(&quoted).is_none() && i < lines.len() {
                quoted.push('\n');
                quoted.push_str(lines[i]);
                i += 1;
            }
            scalar(&quoted)
        } else if value.is_empty() || value.starts_with(['!', '&', '*', '[', '{', '?']) {
            None
        } else if lines[i..]
            .iter()
            .find(|l| !l.trim().is_empty())
            .is_some_and(|l| l.starts_with(' '))
        {
            while i < lines.len() && (lines[i].starts_with(' ') || lines[i].trim().is_empty()) {
                i += 1;
            }
            None
        } else if !force_string
            && (matches!(value, "true" | "false" | "null" | "~") || value.parse::<f64>().is_ok())
        {
            None
        } else {
            scalar(value)
        };
        match key.as_deref() {
            Some("name") => {
                review |= decoded.is_none();
                name = decoded;
            }
            Some("description") => {
                review |= decoded.is_none();
                description = decoded;
            }
            _ => {}
        }
    }
    // Unsupported YAML may change identity through merges/aliases. Never invent a selector.
    if review {
        name = None;
    }
    (
        name.map(|v| canonical(&v)).filter(|v| !v.is_empty()),
        description.map(|v| canonical(&v)).filter(|v| !v.is_empty()),
        review,
    )
}

// Match skills@1.7.6 sanitizeMetadata after YAML decoding, including quoted trailing spaces.
fn canonical(value: &str) -> String {
    static ESCAPES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
        r"\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?(?:\x1b\\)|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x7e]|[\x80-\x9f\x00-\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]"
    ).expect("metadata escape pattern")
    });
    let clean = ESCAPES.replace_all(value, "");
    clean
        .split(['\r', '\n'])
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .into()
}

fn scalar(value: &str) -> Option<String> {
    let Some(quote @ ('\'' | '"')) = value.chars().next() else {
        let mut previous_space = true;
        for (i, c) in value.char_indices() {
            if c == '#' && previous_space {
                return Some(value[..i].trim_end().into());
            }
            previous_space = c.is_whitespace();
        }
        return Some(value.trim_end().into());
    };
    let mut chars = value[1..].chars().peekable();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c == quote {
            if quote == '\'' && chars.peek() == Some(&'\'') {
                chars.next();
                out.push('\'');
                continue;
            }
            let tail: String = chars.collect();
            return (tail.is_empty()
                || tail.starts_with(char::is_whitespace)
                    && (tail.trim().is_empty() || tail.trim_start().starts_with('#')))
            .then_some(out);
        }
        if c == '\n' {
            while out.ends_with([' ', '\t']) {
                out.pop();
            }
            while chars.peek().is_some_and(|c| matches!(c, ' ' | '\t')) {
                chars.next();
            }
            out.push('\n');
        } else if quote == '"' && c == '\\' {
            let escaped = chars.next()?;
            if escaped == '\n' {
                while chars.peek().is_some_and(|c| matches!(c, ' ' | '\t')) {
                    chars.next();
                }
                continue;
            }
            out.push(match escaped {
                '0' => '\0',
                'a' => '\u{7}',
                'b' => '\u{8}',
                't' | '\t' => '\t',
                'n' => '\n',
                'v' => '\u{b}',
                'f' => '\u{c}',
                'r' => '\r',
                'e' => '\u{1b}',
                ' ' => ' ',
                '"' => '"',
                '/' => '/',
                '\\' => '\\',
                'N' => '\u{85}',
                '_' => '\u{a0}',
                'L' => '\u{2028}',
                'P' => '\u{2029}',
                code @ ('x' | 'u' | 'U') => {
                    let digits = match code {
                        'x' => 2,
                        'u' => 4,
                        _ => 8,
                    };
                    let mut number = 0;
                    for _ in 0..digits {
                        number = number * 16 + chars.next()?.to_digit(16)?;
                    }
                    char::from_u32(number)?
                }
                _ => return None,
            });
        } else {
            out.push(c);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skill_manager_yaml_scalars_have_cli_identity() {
        for (value, expected) in [
            ("review # comment  ", "review"),
            ("review#tag  ", "review#tag"),
            ("'review # tag' # comment", "review # tag"),
            ("'it''s review'", "it's review"),
            (r#""re\u0076iew" # comment"#, "review"),
            (r#""a\"b\\c\x20\U0001F43C""#, "a\"b\\c 🐼"),
            ("' trailing '  ", "trailing"),
            ("\"tab\\tline\\n\"", "tab\tline"),
        ] {
            let text = format!("---\nname: {value}\ndescription: {value}\n---\nBody");
            let (name, description) = frontmatter(&text);
            assert_eq!(name.as_deref(), Some(expected), "{value}");
            assert_eq!(description, name);
        }
        assert_eq!(canonical("\u{1b}[31mreview\u{1b}[0m  "), "review");
        assert!(scalar(r#""bad\q""#).is_none());
        assert!(scalar("'unclosed").is_none());
    }
}

#[cfg(test)]
mod tagged_metadata_tests {
    use super::*;
    #[test]
    fn skill_manager_yaml_tags_and_quoted_keys_match_cli_identity() {
        for field in [
            "name: !!str review",
            "'name': review",
            "\"name\": !!str 'review'",
        ] {
            assert_eq!(
                frontmatter(&format!("---\n{field}\n---\n")).0.as_deref(),
                Some("review")
            );
        }
        assert_eq!(
            frontmatter("---\nname: !!str 123\n---\n").0.as_deref(),
            Some("123")
        );
        for field in [
            "name: &id review",
            "name: *id",
            "name: !custom review",
            "name: [review]",
            "name: {value: review}",
            "name: true",
            "name: 123",
            "name: review\nname: other",
            "name: review\n\n  continued",
        ] {
            assert_eq!(
                frontmatter(&format!("---\n{field}\n---\n")).0,
                None,
                "{field}"
            );
        }
    }
}

#[cfg(test)]
mod multiline_tests {
    use super::*;
    #[test]
    fn skill_manager_multiline_metadata_preserves_cli_identity() {
        for description in [
            "\"First line\n  second line\"",
            "'First line\n\n  second line'",
            "|2- # explicit indent\n  First line\n\n  second line\n",
            ">+2\n  First line\n\n  second line\n",
        ] {
            for text in [
                format!("---\nname: review\ndescription: {description}\n---\n"),
                format!("---\ndescription: {description}\nname: review\n---\n"),
                format!("---\nother: {description}\nname: review\n---\n"),
            ] {
                assert_eq!(frontmatter(&text).0.as_deref(), Some("review"), "{text}");
                assert!(!needs_review(&text), "{text}");
            }
        }
    }
    #[test]
    fn skill_manager_multiline_names_match_yaml_folding_and_sanitization() {
        for (value, expected) in [
            ("\"Friendly\n  review\"", "Friendly review"),
            ("'Friendly\n\n  review'", "Friendly review"),
            ("|2-\n  review\n\n", "review"),
            (">2+\n  Friendly\n  review\n", "Friendly review"),
            ("\"re\\\n  view\"", "review"),
        ] {
            assert_eq!(
                frontmatter(&format!("---\nname: {value}\n---\n"))
                    .0
                    .as_deref(),
                Some(expected),
                "{value}"
            );
        }
    }
}
