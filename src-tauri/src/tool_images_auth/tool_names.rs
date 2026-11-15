//! Which tool names belong to tools that capture or show an image.

/// Tool-name fragments (lowercase) of built-in tools that capture or show an
/// image; their output may report the file in an image-path shape.
const IMAGE_TOOL_WORDS: [&str; 8] =
    ["screenshot", "snapshot", "capture", "view image", "viewimage", "imageview", "generate image", "reading media"];
/// Starts (lowercase) of an MCP tool's own name (after `mcp__server__`) that make
/// it an image tool. A word in the server name never counts, so
/// `mcp__capture_notes__save` is not one.
const MCP_IMAGE_VERBS: [&str; 7] = [
    "screenshot",
    "take_screenshot",
    "capture_screenshot",
    "browser_take_screenshot",
    "snapshot_image",
    "pandacode_simulator_screenshot",
    "pandacode_vm_screenshot",
];
/// Whole underscore-delimited word runs of an MCP tool's own name that make it an
/// image tool wherever they appear (`puppeteer_screenshot`, `pandacode_capture_browser`).
const MCP_IMAGE_WORDS: [&[&str]; 2] = [&["screenshot"], &["capture", "browser"]];
/// Starts (lowercase) of title-style shell records (Kimi `Running: <command>`,
/// Devin `Ran …`, ACP titles). Their command is read by the shell parser, so an
/// image word in it (`curl https://site/capture`) does not make an image tool.
const SHELL_TITLE_PREFIXES: [&str; 4] = ["running:", "ran ", "run ", "$ "];

/// `lower` is a lowercase tool name.
pub(super) fn is_image_tool(lower: &str) -> bool {
    match lower.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
        Some((_, tool)) => is_mcp_image_tool(tool),
        None => {
            !SHELL_TITLE_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
                && IMAGE_TOOL_WORDS.iter().any(|word| lower.contains(word))
        }
    }
}

/// `tool` is the MCP tool's own lowercase name, without the server.
fn is_mcp_image_tool(tool: &str) -> bool {
    let words: Vec<&str> = tool.split('_').collect();
    MCP_IMAGE_VERBS.iter().any(|verb| tool.starts_with(verb))
        || MCP_IMAGE_WORDS.iter().any(|run| words.windows(run.len()).any(|w| w == *run))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::is_image_tool;
    use crate::tool_images::path_spellings;
    use crate::tool_images_auth::records_name_path;

    /// `tests/fixtures/image-tools.json` is shared with the TS rows: each case is a
    /// completed record that must authorize exactly `image`, or no path in its output.
    #[test]
    fn tool_image_tools_match_the_shared_image_tools_fixture() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../../tests/fixtures/image-tools.json")).expect("fixture parses");
        assert!(cases.len() >= 7);
        for case in &cases {
            let name = case["toolName"].as_str().expect("toolName");
            let output = case["output"].as_str().expect("output");
            let record = serde_json::json!({"type": "tool_activity", "version": 1, "name": name, "status": "completed",
                "input": case["input"], "output": output}).to_string();
            let authorizes = |path: &str| records_name_path(std::slice::from_ref(&record), &path_spellings(path), false);
            let paths = output.split(|c: char| c.is_whitespace() || c == '"').filter(|word| word.starts_with('/'));
            let image = case["image"].as_str();
            for path in paths.filter(|path| Some(*path) != image) {
                assert!(!authorizes(path), "{name}: {path}");
            }
            if let Some(path) = image {
                assert!(authorizes(path), "{name}: {path}");
            }
        }
    }

    #[test]
    fn tool_image_names_match_the_tool_part_and_skip_shell_titles() {
        let image = [
            "mcp__pandacode__pandacode_capture_browser",
            "mcp__puppeteer__puppeteer_screenshot",
            "mcp__playwright__playwright_screenshot",
            "mcp__browserbase__browserbase_screenshot",
            "mcp__chrome-devtools__take_screenshot",
            "capture window",
            "screen capture",
            "simulator_screenshot",
        ];
        for name in image {
            assert!(is_image_tool(name), "{name}");
        }
        let other = [
            "mcp__capture_notes__save",
            "mcp__notes__recapture_page",
            "mcp__notes__save_snapshot",
            "mcp__screenshot_store__save",
            "running: curl https://site/capture",
            "ran screencapture -x /tmp/a.png",
            "run screenshot.sh",
            "$ curl https://site/snapshot",
        ];
        for name in other {
            assert!(!is_image_tool(name), "{name}");
        }
    }
}
