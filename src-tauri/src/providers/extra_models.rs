//! Read-only OpenCode metadata. Whitelist fields: its verbose output may also
//! contain user headers/options, which must never cross into the webview.
use super::{effort_info, model_text, valid_model_id, ModelInfo, ProcessGroup, MODEL_CATALOG_LIMIT};
use serde_json::Value;
use std::{collections::HashSet, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const LIMIT: usize = 16 * 1024 * 1024;
fn parse(bytes: &[u8]) -> Result<Vec<ModelInfo>, String> {
    if bytes.len() > LIMIT {
        return Err("OpenCode model metadata exceeded its limit".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid OpenCode model catalog")?;
    let mut remaining = text.trim();
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::new();
    let mut count = 0;
    while !remaining.is_empty() && count < MODEL_CATALOG_LIMIT {
        count += 1;
        let (id, rest) = remaining
            .split_once('\n')
            .ok_or("Invalid OpenCode model catalog")?;
        let id = id.trim();
        if !valid_model_id(id) || !id.contains('/') {
            return Err("Invalid OpenCode model catalog".into());
        }
        let mut stream = serde_json::Deserializer::from_str(rest.trim_start()).into_iter::<Value>();
        let entry = stream
            .next()
            .ok_or("Invalid OpenCode model catalog")?
            .map_err(|_| "Invalid OpenCode model catalog")?;
        remaining = rest.trim_start()[stream.byte_offset()..].trim_start();
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let mut efforts: Vec<_> = entry["variants"]
            .as_object()
            .into_iter()
            .flat_map(|variants| variants.keys())
            .filter(|id| super::validate_reasoning_effort("opencode", Some(id)).is_ok())
            .take(20)
            .map(|id| effort_info(id, None))
            .collect();
        // Variant keys arrive sorted by name; the slider reads least to most.
        let rank = |id: &str| ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"].iter().position(|known| *known == id).unwrap_or(usize::MAX);
        efforts.sort_by_key(|effort| rank(&effort.id));
        models.push(ModelInfo {
            id: id.into(),
            name: model_text(entry["name"].as_str(), id, 160),
            description: id.into(),
            reasoning_efforts: efforts,
            default_reasoning_effort: None,
            context_window: entry["limit"]["context"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 1_000_000_000),
        });
    }
    if !remaining.is_empty() {
        return Err("OpenCode returned too many models".into());
    }
    Ok(models)
}

/// Current OpenCode rejects `--verbose` and prints one model ID per line.
fn parse_plain(bytes: &[u8]) -> Result<Vec<ModelInfo>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid OpenCode model catalog")?;
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::new();
    for id in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if !valid_model_id(id) || !id.contains('/') {
            return Err("Invalid OpenCode model catalog".into());
        }
        if models.len() > MODEL_CATALOG_LIMIT {
            return Err("OpenCode returned too many models".into());
        }
        if seen.insert(id) {
            models.push(ModelInfo {
                id: id.into(),
                name: id.into(),
                description: id.into(),
                reasoning_efforts: Vec::new(),
                default_reasoning_effort: None,
                context_window: None,
            });
        }
    }
    Ok(models)
}

pub(super) async fn opencode(path: &Path) -> Result<Vec<ModelInfo>, String> {
    match discover(path, &["models", "--verbose"], parse).await {
        Ok(models) => Ok(models),
        // A hung CLI would hang again; only a rejected flag or new output format falls back.
        Err(error) if error.contains("timed out") => Err(error),
        Err(_) => discover(path, &["models"], parse_plain).await,
    }
}

async fn discover(
    path: &Path,
    args: &[&str],
    parse: fn(&[u8]) -> Result<Vec<ModelInfo>, String>,
) -> Result<Vec<ModelInfo>, String> {
    let mut command = super::provider_command("opencode", path)?;
    command
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start OpenCode model discovery")?;
    let group = ProcessGroup::register(child.id());
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        child
            .stdout
            .take()
            .ok_or("OpenCode model output unavailable")?
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Could not read OpenCode model metadata")?;
        if bytes.len() > LIMIT {
            return Err("OpenCode model metadata exceeded its limit".into());
        }
        if !child
            .wait()
            .await
            .map_err(|_| "OpenCode discovery failed")?
            .success()
        {
            return Err(
                "OpenCode could not load models. Check its provider login and configuration."
                    .into(),
            );
        }
        parse(&bytes)
    })
    .await
    .unwrap_or_else(|_| Err("OpenCode model discovery timed out".into()));
    bytes.fill(0);
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supports_the_current_catalog_size() {
        let catalog: String = (0..2012)
            .map(|index| format!("vendor/model-{index}\n{{\"name\":\"Model {index}\"}}\n"))
            .collect();
        let models = parse(catalog.as_bytes()).unwrap();
        assert_eq!(models.len(), 2013);
        assert_eq!(models.last().unwrap().id, "vendor/model-2011");
    }
    #[test]
    fn enforces_bounded_catalogs_including_duplicate_entries() {
        let catalog = "vendor/model\n{}\n".repeat(MODEL_CATALOG_LIMIT + 1);
        assert_eq!(
            parse(catalog.as_bytes()).unwrap_err(),
            "OpenCode returned too many models"
        );
        assert_eq!(
            parse(&vec![b' '; LIMIT + 1]).unwrap_err(),
            "OpenCode model metadata exceeded its limit"
        );
    }
    #[test]
    fn plain_catalogs_list_ids_without_metadata() {
        let parsed = parse_plain(b"opencode/beam-free\nvendor/model:free\n\nopencode/beam-free\n").unwrap();
        let ids: Vec<_> = parsed.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["default", "opencode/beam-free", "vendor/model:free"]);
        assert_eq!(parsed[2].context_window, None);
        assert_eq!(parse_plain(b"vendor/model\nSECRET\n").unwrap_err(), "Invalid OpenCode model catalog");
        let many: String = (0..=MODEL_CATALOG_LIMIT).map(|index| format!("vendor/m{index}\n")).collect();
        assert_eq!(parse_plain(many.as_bytes()).unwrap_err(), "OpenCode returned too many models");
    }
    #[tokio::test]
    #[ignore = "Reads the installed OpenCode model catalog"]
    async fn installed_opencode_catalog_smoke() {
        let (first, second) = tokio::join!(
            super::super::list_model_catalog("opencode"),
            super::super::list_model_catalog("opencode"),
        );
        let models = first.unwrap();
        assert_eq!(models, second.unwrap());
        assert_eq!(models[0].id, "default");
        assert!(models.len() > 1);
        println!(
            "OpenCode returned {} sanitized model entries",
            models.len() - 1
        );
    }
    #[test]
    fn projects_names_efforts_and_limits_without_configuration_secrets() {
        let parsed = parse(b"vendor/id\n{\"name\":\"Actual model\",\"headers\":{\"Authorization\":\"SECRET\"},\"limit\":{\"context\":200000},\"variants\":{\"low\":{},\"high\":{}}}\nvendor/other\n{\"name\":\"Other model\"}\n").unwrap();
        assert_eq!(parsed[1].id, "vendor/id");
        assert_eq!(parsed[1].name, "Actual model");
        assert_eq!(parsed[1].context_window, Some(200000));
        assert_eq!(parsed[1].reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["low", "high"]);
        assert!(!serde_json::to_string(&parsed).unwrap().contains("SECRET"));
        assert_eq!(parsed[2].name, "Other model");
    }
    /// Recorded from `opencode models --verbose` 1.19.0 (trimmed).
    #[test]
    fn recorded_variants_become_ordered_efforts() {
        let parsed = parse(br#"opencode/deepseek-v4.1-flash-free
{"id":"deepseek-v4.1-flash-free","providerID":"opencode","name":"DeepSeek V4.1 Flash Free","limit":{"context":200000,"output":32000},"variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}
openrouter/z-ai/glm-5.2
{"id":"z-ai/glm-5.2","providerID":"openrouter","name":"GLM 5.2","variants":{"none":{},"high":{},"xhigh":{}}}
"#).unwrap();
        let ids = |index: usize| parsed[index].reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids(1), ["low", "high", "max"]);
        assert_eq!(ids(2), ["none", "high", "xhigh"]);
    }
    #[test]
    fn malformed_catalog_errors_do_not_echo_input() {
        assert!(!parse(b"SECRET").unwrap_err().contains("SECRET"));
    }
}
