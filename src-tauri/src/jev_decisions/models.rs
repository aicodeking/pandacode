//! Decision models a user can pick in Jev settings. TypeSafe's list is built in; OpenRouter's
//! public catalog is fetched only when the dropdown opens for OpenRouter.
use serde::{Deserialize, Serialize};
use std::time::Duration;

const OPENROUTER_MODELS: &str = "https://openrouter.ai/api/v1/models";
const MAX_CATALOG: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DecisionModel {
    pub id: String,
    pub name: String,
}

pub(crate) fn typesafe() -> Vec<DecisionModel> {
    vec![DecisionModel { id: super::api::MODEL.into(), name: super::api::MODEL.into() }]
}

#[derive(Deserialize)]
struct Catalog {
    data: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    supported_parameters: Option<Vec<String>>,
}

// Keeps models that take JSON output. A catalog that never reports parameters is kept whole.
fn parse(bytes: &[u8]) -> Result<Vec<DecisionModel>, String> {
    let catalog: Catalog = serde_json::from_slice(bytes)
        .map_err(|_| "OpenRouter returned an unreadable model list.".to_string())?;
    let reports = catalog.data.iter().any(|entry| entry.supported_parameters.is_some());
    let mut models: Vec<_> = catalog
        .data
        .into_iter()
        .filter(|entry| {
            !entry.id.is_empty()
                && entry.id.len() <= 200
                && !entry.id.chars().any(char::is_control)
                && (!reports
                    || entry.supported_parameters.as_deref().is_some_and(|list| {
                        list.iter().any(|p| matches!(p.as_str(), "response_format" | "structured_outputs"))
                    }))
        })
        .map(|entry| DecisionModel {
            name: entry.name.filter(|n| !n.is_empty() && n.len() <= 200).unwrap_or_else(|| entry.id.clone()),
            id: entry.id,
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

async fn fetch(url: &str) -> Result<Vec<DecisionModel>, String> {
    let mut response = super::api::client()?
        .get(url)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|_| "Could not reach OpenRouter. Try Refresh.".to_string())?;
    if !response.status().is_success() {
        return Err("OpenRouter could not list models. Try Refresh.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "OpenRouter's model list was interrupted. Try Refresh.".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_CATALOG {
            return Err("OpenRouter's model list was too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse(&bytes)
}

pub(crate) async fn list(provider: &str) -> Result<Vec<DecisionModel>, String> {
    match provider {
        "typesafe" => Ok(typesafe()),
        "openrouter" => fetch(OPENROUTER_MODELS).await,
        _ => Err("Choose TypeSafe or OpenRouter.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

    const CATALOG: &str = r#"{"data":[
        {"id":"b/plain","name":"Plain","supported_parameters":["temperature"]},
        {"id":"z/json","name":"Zed","supported_parameters":["response_format","tools"]},
        {"id":"a/structured","supported_parameters":["structured_outputs"]}]}"#;

    #[test]
    fn keeps_json_capable_models_sorted() {
        let models = parse(CATALOG.as_bytes()).unwrap();
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a/structured", "z/json"]);
        assert_eq!(models[0].name, "a/structured");
        // Without parameter data nothing can be filtered.
        assert_eq!(parse(br#"{"data":[{"id":"x/y"}]}"#).unwrap().len(), 1);
        assert!(parse(b"nope").is_err());
        assert_eq!(typesafe()[0].id, "jev-1.13.0");
    }

    #[tokio::test]
    async fn fetches_the_catalog_from_a_mock_server_without_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/v1/models", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let n = stream.read(&mut buffer).await.unwrap();
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{CATALOG}", CATALOG.len());
            stream.write_all(head.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buffer[..n]).to_ascii_lowercase()
        });
        assert_eq!(fetch(&url).await.unwrap().len(), 2);
        assert!(!server.await.unwrap().contains("authorization"));
        assert!(list("other").await.is_err());
    }
}
