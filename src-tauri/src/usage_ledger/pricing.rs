//! Standard pay-as-you-go API rates from LiteLLM's public model price list
//! (the list ccusage uses). A day-old copy is refreshed with a plain GET; no
//! usage data is sent. Offline, the last saved copy or the bundled snapshot is used.
//! Not telemetry: the request carries no identifier, account or usage data and
//! goes to GitHub's public raw file host, never to a PandaCode server.

use super::parse::Record;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

const PRICE_URL: &str = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const BUNDLED: &str = include_str!("prices.json");
const MAX_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const REFRESH_MS: i64 = 24 * 3600 * 1000;

/// Dollars per token. `high` rates apply once a prompt exceeds `threshold` tokens.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Price {
    input: f64,
    output: f64,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
    cache_write_1h: Option<f64>,
    threshold: Option<u64>,
    input_high: Option<f64>,
    output_high: Option<f64>,
    cache_read_high: Option<f64>,
    cache_write_high: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Source {
    Live,
    Saved,
    Bundled,
}

#[derive(Clone, Debug)]
pub(crate) struct PriceBook {
    prices: HashMap<String, Price>,
    pub source: Source,
    pub fetched_at: Option<i64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPrices {
    fetched_at: i64,
    prices: HashMap<String, Price>,
}

fn rate(entry: &Value, key: &str) -> Option<f64> {
    entry[key].as_f64().filter(|value| value.is_finite() && *value >= 0.0)
}

/// The long-context tier LiteLLM describes as `…_above_200k_tokens` or `…_above_272k_tokens`.
fn tier(entry: &Value) -> Option<(u64, String)> {
    let object = entry.as_object()?;
    object.keys().find_map(|key| {
        let rest = key.strip_prefix("input_cost_per_token_above_")?;
        let thousands = rest.strip_suffix("k_tokens")?.parse::<u64>().ok()?;
        Some((thousands * 1000, format!("_above_{thousands}k_tokens")))
    })
}

fn price(entry: &Value) -> Option<Price> {
    let high = tier(entry);
    let tiered = |key: &str| high.as_ref().and_then(|(_, suffix)| rate(entry, &format!("{key}{suffix}")));
    Some(Price {
        input: rate(entry, "input_cost_per_token")?,
        output: rate(entry, "output_cost_per_token")?,
        cache_read: rate(entry, "cache_read_input_token_cost"),
        cache_write: rate(entry, "cache_creation_input_token_cost"),
        cache_write_1h: rate(entry, "cache_creation_input_token_cost_above_1hr"),
        threshold: high.as_ref().map(|(threshold, _)| *threshold),
        input_high: tiered("input_cost_per_token"),
        output_high: tiered("output_cost_per_token"),
        cache_read_high: tiered("cache_read_input_token_cost"),
        cache_write_high: tiered("cache_creation_input_token_cost"),
    })
}

/// Collapses LiteLLM's provider-prefixed keys to one price per model name,
/// preferring the vendor's own listing over resellers (`azure/…`, `vertex_ai/…`).
pub(crate) fn parse_prices(document: &Value) -> HashMap<String, Price> {
    let Some(entries) = document.as_object() else { return HashMap::new() };
    let rank = |key: &str| match key.split_once('/') {
        None => 0,
        Some(("openai" | "anthropic", _)) => 1,
        Some(_) => 2,
    };
    let mut keys: Vec<&String> = entries.keys().collect();
    keys.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
    let mut prices = HashMap::new();
    for key in keys {
        let entry = &entries[key];
        if !matches!(entry["mode"].as_str(), None | Some("chat" | "responses")) {
            continue;
        }
        let name = key.rsplit('/').next().unwrap_or(key).to_ascii_lowercase();
        if prices.contains_key(&name) {
            continue;
        }
        if let Some(price) = price(entry) {
            prices.insert(name, price);
        }
    }
    prices
}

/// The bundled snapshot: one compact line, models and cost keys sorted, in the
/// upstream key names `parse_prices` reads. The long-context tier is written back
/// as `…_above_{n}k_tokens` so reloading the snapshot recovers it.
#[cfg(test)]
pub(crate) fn snapshot_json(prices: &HashMap<String, Price>) -> String {
    use std::collections::BTreeMap;
    let mut models = BTreeMap::new();
    for (name, price) in prices {
        let mut entry = BTreeMap::new();
        entry.insert("input_cost_per_token".to_string(), price.input);
        entry.insert("output_cost_per_token".to_string(), price.output);
        for (key, value) in [
            ("cache_read_input_token_cost", price.cache_read),
            ("cache_creation_input_token_cost", price.cache_write),
            ("cache_creation_input_token_cost_above_1hr", price.cache_write_1h),
        ] {
            if let Some(value) = value {
                entry.insert(key.to_string(), value);
            }
        }
        if let Some(threshold) = price.threshold {
            let suffix = format!("_above_{}k_tokens", threshold / 1000);
            for (key, value) in [
                ("input_cost_per_token", price.input_high),
                ("output_cost_per_token", price.output_high),
                ("cache_read_input_token_cost", price.cache_read_high),
                ("cache_creation_input_token_cost", price.cache_write_high),
            ] {
                if let Some(value) = value {
                    entry.insert(format!("{key}{suffix}"), value);
                }
            }
        }
        models.insert(name.as_str(), entry);
    }
    serde_json::to_string(&models).expect("price snapshot serializes")
}

impl PriceBook {
    #[cfg(test)]
    pub(crate) fn from_prices(prices: HashMap<String, Price>) -> Self {
        Self { prices, source: Source::Bundled, fetched_at: None }
    }

    pub(crate) fn bundled() -> Self {
        let document = serde_json::from_str(BUNDLED).unwrap_or(Value::Null);
        Self { prices: parse_prices(&document), source: Source::Bundled, fetched_at: None }
    }

    /// Finds a model by exact name, then without a `[1m]`-style suffix or a date stamp.
    /// A trailing relay/self-hosted prefix (`acme:model-x`) is stripped last, so a
    /// model id rewritten by a proxy still matches the catalog name.
    pub(crate) fn find(&self, model: &str) -> Option<&Price> {
        let try_name = |name: &str| -> Option<&Price> {
            let name = name.split('[').next().unwrap_or(name).trim();
            self.prices.get(name).or_else(|| {
                let (stem, date) = name.rsplit_once('-')?;
                (date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit())).then(|| self.prices.get(stem)).flatten()
            })
        };
        let name = model.rsplit('/').next().unwrap_or(model);
        try_name(name).or_else(|| try_name(name.rsplit(':').next().unwrap_or(name)))
    }

    /// Cost and cache savings in dollars, or `None` when the model is not listed.
    pub(crate) fn cost(&self, record: &Record) -> Option<(f64, f64)> {
        let price = self.find(&record.model)?;
        let high = price.threshold.is_some_and(|threshold| match record.class {
            0 => false,
            1 => threshold < 272_000,
            _ => true,
        });
        let pick = |base: f64, tiered: Option<f64>| if high { tiered.unwrap_or(base) } else { base };
        let input = pick(price.input, price.input_high);
        let cache_read = pick(price.cache_read.unwrap_or(price.input), price.cache_read_high);
        let cache_write = pick(price.cache_write.unwrap_or(price.input), price.cache_write_high);
        let cache_write_1h = price.cache_write_1h.unwrap_or(cache_write);
        let output = pick(price.output, price.output_high);
        let cost = record.input as f64 * input
            + record.cache_read as f64 * cache_read
            + record.cache_write as f64 * cache_write
            + record.cache_write_1h as f64 * cache_write_1h
            + record.output as f64 * output;
        Some((cost, record.cache_read as f64 * (input - cache_read).max(0.0)))
    }
}

pub(crate) fn load_saved(path: &Path) -> Option<PriceBook> {
    let saved: SavedPrices = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (!saved.prices.is_empty()).then_some(PriceBook { prices: saved.prices, source: Source::Saved, fetched_at: Some(saved.fetched_at) })
}

pub(crate) async fn download() -> Result<Value, String> {
    let client = crate::agent_usage::http_client().map_err(|_| "Price list client unavailable.".to_string())?;
    let mut response = client
        .get(PRICE_URL)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Price list returned HTTP {}.", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("Price list is unexpectedly large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// A fresh saved copy, else a new download (saved for next time), else any saved copy, else the snapshot.
pub(crate) async fn load(path: &Path, now_ms: i64) -> PriceBook {
    let saved = load_saved(path);
    if let Some(book) = saved.as_ref().filter(|book| book.fetched_at.is_some_and(|at| now_ms - at < REFRESH_MS)) {
        return book.clone();
    }
    match download().await.map(|document| parse_prices(&document)) {
        Ok(prices) if prices.len() > 50 => {
            let saved = SavedPrices { fetched_at: now_ms, prices };
            if let Ok(bytes) = serde_json::to_vec(&saved) {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let temporary = path.with_extension("tmp");
                if std::fs::write(&temporary, bytes).is_ok() {
                    let _ = std::fs::rename(&temporary, path);
                }
            }
            PriceBook { prices: saved.prices, source: Source::Live, fetched_at: Some(now_ms) }
        }
        _ => saved.unwrap_or_else(PriceBook::bundled),
    }
}
