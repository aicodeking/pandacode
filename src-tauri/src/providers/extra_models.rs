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
        let efforts = entry["variants"]
            .as_object()
            .into_iter()
            .flat_map(|variants| variants.keys())
            .filter(|id| super::validate_reasoning_effort("opencode", Some(id)).is_ok())
            .take(20)
            .map(|id| effort_info(id, None))
            .collect();
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

fn parse_plain(bytes: &[u8]) -> Result<Vec<ModelInfo>, String> {
    if bytes.len() > LIMIT {
        return Err("OpenCode model metadata exceeded its limit".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid OpenCode model catalog")?;
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::new();
    let mut count = 0;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        count += 1;
        if count > MODEL_CATALOG_LIMIT {
            return Err("OpenCode returned too many models".into());
        }
        if !valid_model_id(line) || !line.contains('/') {
            return Err("Invalid OpenCode model catalog".into());
        }
        if !seen.insert(line.to_owned()) {
            continue;
        }
        models.push(ModelInfo {
            id: line.into(),
            name: line.into(),
            description: line.into(),
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
            context_window: None,
        });
    }
    Ok(models)
}

async fn discover(path: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = super::command(path)?;
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
        Ok(bytes)
    })
    .await
    .unwrap_or_else(|_| Err("OpenCode model discovery timed out".into()));
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

pub(super) async fn opencode(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Ok(mut bytes) = discover(path, &["models", "--verbose"]).await {
        let parsed = parse(&bytes);
        bytes.fill(0);
        if let Ok(models) = parsed {
            return Ok(models);
        }
    }
    let mut bytes = discover(path, &["models"]).await?;
    let models = parse_plain(&bytes);
    bytes.fill(0);
    models
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
    fn plain_catalogs_from_current_opencode_list_ids_without_metadata() {
        let parsed =
            parse_plain(b"opencode/beam-free\nvendor/model:free\n\nopencode/beam-free\n").unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[1].id, "opencode/beam-free");
        assert_eq!(parsed[1].name, "opencode/beam-free");
        assert_eq!(parsed[2].id, "vendor/model:free");
        assert_eq!(parsed[2].context_window, None);
        assert!(parsed[2].reasoning_efforts.is_empty());
    }
    #[test]
    fn plain_catalogs_validate_ids_and_bounds() {
        assert_eq!(
            parse_plain(b"opencode/beam-free\nnot-a-model\n").unwrap_err(),
            "Invalid OpenCode model catalog"
        );
        let catalog = "vendor/model\n".repeat(MODEL_CATALOG_LIMIT + 1);
        assert_eq!(
            parse_plain(catalog.as_bytes()).unwrap_err(),
            "OpenCode returned too many models"
        );
        assert_eq!(
            parse_plain(&vec![b' '; LIMIT + 1]).unwrap_err(),
            "OpenCode model metadata exceeded its limit"
        );
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
        assert_eq!(parsed[1].reasoning_efforts.len(), 2);
        assert!(!serde_json::to_string(&parsed).unwrap().contains("SECRET"));
        assert_eq!(parsed[2].name, "Other model");
    }
    #[test]
    fn malformed_catalog_errors_do_not_echo_input() {
        assert!(!parse(b"SECRET").unwrap_err().contains("SECRET"));
    }
}
