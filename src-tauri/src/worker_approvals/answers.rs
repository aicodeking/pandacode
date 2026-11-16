//! Which answer a team worker's question gets: "decide yourself" where text is accepted, the
//! option the question itself marks recommended or default, or a cancel.
use super::NO_USER_ANSWER;
use serde_json::{json, Value};

/// Each question gets "decide yourself" where text is accepted, else its option marked
/// recommended or default (all or nothing: an unmarked choice cancels the request). Any secret question cancels the whole request; forms are declined.
pub(super) fn preferred_response(data: &Value) -> Value {
    let Some(questions) = data["questions"].as_array().filter(|_| data["kind"] == "questions") else {
        return fallback_response(data);
    };
    if questions.is_empty() || questions.iter().any(|question| question["isSecret"] == true) {
        return fallback_response(data);
    }
    let answers: Option<serde_json::Map<String, Value>> = questions
        .iter()
        .map(|question| Some((question["id"].as_str()?.to_owned(), json!([choose(question)?]))))
        .collect();
    answers.map_or_else(|| fallback_response(data), |answers| json!({ "answers": answers }))
}

/// The answer for one question: free text where allowed, else the option marked recommended or
/// default. With no such option there is no answer (the question is cancelled), so a yes/no
/// with real consequences is never answered "Yes" just for coming first.
fn choose(question: &Value) -> Option<String> {
    let options = question["options"].as_array().filter(|options| !options.is_empty());
    let Some(options) = options.filter(|_| question["isOther"] != true) else {
        return Some(NO_USER_ANSWER.into());
    };
    options.iter().find(|option| is_recommended(option))?["label"].as_str().map(str::to_owned)
}

/// An option the question itself marks as the one to take: a structured flag, else a clear text
/// marker: text that starts with the word "Recommended", or ends with a whole "(recommended)" /
/// "(default)" clause. "Delete all (not recommended)" or "riskier than recommended" never is.
fn is_recommended(option: &Value) -> bool {
    if option["recommended"] == true || option["default"] == true || option["isDefault"] == true {
        return true;
    }
    option["label"].as_str().is_some_and(|label| marked_recommended(label, true))
        || option["description"].as_str().is_some_and(|description| marked_recommended(description, false))
}

/// `label`: a leading "Recommended" counts only in a label; a description such as "Recommended
/// only if you are sure" is advice, not a marker.
fn marked_recommended(text: &str, label: bool) -> bool {
    let text = text.trim().to_lowercase();
    // "Recommended: …", "Recommended for most tasks": the word itself leads (not "Unrecommended").
    if label && text.strip_prefix("recommended").is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric())) {
        return true;
    }
    // A whole parenthesised suffix, "(Recommended)" or "(default)": the marker clause is exactly
    // that word, so "(not recommended)" is no marker while "No (Recommended)" is.
    let end = text.trim_end_matches(['.', '!']).trim_end();
    end.strip_suffix(')')
        .and_then(|inside| inside.rfind('(').map(|open| inside[open + 1..].trim()))
        .is_some_and(|clause| clause == "recommended" || clause == "default")
}

/// Empty answers cancel a question; a form or link is declined.
pub(super) fn fallback_response(data: &Value) -> Value {
    if data["kind"] == "questions" {
        json!({ "answers": {} })
    } else {
        json!({ "action": "decline", "content": null })
    }
}
