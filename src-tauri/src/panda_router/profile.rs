//! Taxonomy, `TaskProfile` and the profiler's input text (upstream `taxonomy.py`, `profile.py`, `text.py`).

use super::TaskContext;

pub const CATEGORIES: [&str; 13] = [
    "implementation", "bugfix", "refactor", "test_writing", "code_review", "research", "planning",
    "docs_writing", "ui_frontend", "data_analysis", "devops_infra", "math_reasoning", "chat_simple",
];
pub const SKILL_AXES: [&str; 10] = [
    "coding", "debugging", "reasoning", "math", "writing", "research", "review", "planning", "ui_frontend",
    "data_analysis",
];
pub const N_DIFFICULTY: usize = 10;
pub const N_SKILL_LEVELS: usize = 11;
pub const FLAG_NEEDS_TOOLS: usize = 0;
pub const FLAG_NEEDS_VISION: usize = 1;
pub const FLAG_AMBIGUOUS_SPEC: usize = 4;
pub const N_CHECKLIST: usize = 24;

const MAX_CHARS: usize = 6000;

/// What the matcher and the v4 success head need from a profiler.
#[derive(Clone, Debug)]
pub struct TaskProfile {
    pub category: [f64; 13],
    pub difficulty: [f64; N_DIFFICULTY],
    pub skills: [[f64; N_SKILL_LEVELS]; 10],
    pub flags: [f64; 7],
    /// Taxonomy checklist order (`schemas/taxonomy.json`).
    pub checklist: [f64; N_CHECKLIST],
    pub out_p50: f64,
}

impl TaskProfile {
    pub fn expected_skill(&self, axis: usize) -> f64 {
        self.skills[axis].iter().enumerate().map(|(lvl, p)| lvl as f64 * p).sum()
    }

    /// First maximum wins, like Python's `max(dict.items())`.
    pub fn top_category(&self) -> usize {
        let mut best = 0;
        for (i, p) in self.category.iter().enumerate() {
            if *p > self.category[best] {
                best = i;
            }
        }
        best
    }
}

/// Python's `str.split()`/`strip()` whitespace: Unicode White_Space plus the ASCII separators 0x1c-0x1f.
pub fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// Upstream `format_input`: the single source of the model's input text.
pub fn format_input(text: &str, ctx: &TaskContext) -> String {
    let mut parts = Vec::new();
    if !ctx.repo_languages.is_empty() {
        parts.push(format!("langs={}", ctx.repo_languages.join(",")));
    }
    if let Some(files) = ctx.files_in_scope {
        parts.push(format!("files_in_scope={files}"));
    }
    if ctx.requires_tools {
        parts.push("requires_tools".to_string());
    }
    let text = text.trim_matches(py_space);
    let chars = text.chars().count();
    let text = if chars > MAX_CHARS {
        let half = MAX_CHARS / 2;
        let head: String = text.chars().take(half).collect();
        let tail: String = text.chars().skip(chars - half).collect();
        format!("{head}\n[...]\n{tail}")
    } else {
        text.to_string()
    };
    let ctx = if parts.is_empty() { "none".to_string() } else { parts.join(" ") };
    format!("[ctx] {ctx}\n[task] {text}")
}
