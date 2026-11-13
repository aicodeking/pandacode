//! The Claude service a usage check talks to: the OAuth usage endpoint,
//! behind a trait so the flow can be tested offline. Tokens never reach logs.

use crate::agent_usage::{exchange, FetchError, Reply};
use serde_json::Value;
use std::{future::Future, pin::Pin};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_LIMIT: usize = 16 * 1024;

pub(crate) fn wipe(text: &mut String) {
    std::mem::take(text).into_bytes().fill(0);
}

/// Zeroes every string in a JSON value that held tokens.
pub(crate) fn wipe_value(value: &mut Value) {
    match value {
        Value::String(text) => wipe(text),
        Value::Array(items) => items.iter_mut().for_each(wipe_value),
        Value::Object(map) => map.values_mut().for_each(wipe_value),
        _ => {}
    }
}

/// A plausible bearer token: printable ASCII, bounded. A rejected value is
/// wiped, not just dropped.
pub(crate) fn token(value: Option<String>) -> Option<String> {
    let mut value = value?;
    if !value.is_empty() && value.len() <= TOKEN_LIMIT && value.bytes().all(|b| b.is_ascii_graphic()) {
        return Some(value);
    }
    wipe(&mut value);
    None
}

/// A failed usage read, with the service's `Retry-After` when it gave one.
pub(crate) struct UsageFailure {
    pub error: FetchError,
    pub retry_after: Option<String>,
}

impl From<FetchError> for UsageFailure {
    fn from(error: FetchError) -> Self {
        Self { error, retry_after: None }
    }
}

pub(crate) type Pending<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub(crate) trait Remote: Send + Sync + 'static {
    fn usage(&self, access_token: String) -> Pending<'_, Result<Value, UsageFailure>>;
}

pub(crate) struct Http(pub reqwest::Client);

fn wiped(mut reply: Reply) -> (u16, Option<String>, Option<Value>) {
    let body = reply.body.take();
    (reply.status, reply.retry_after.take(), body)
}

impl Remote for Http {
    fn usage(&self, access_token: String) -> Pending<'_, Result<Value, UsageFailure>> {
        Box::pin(async move {
            let mut access_token = access_token;
            // Fixed first-party endpoint; redirect following is disabled.
            let request = self.0.get(USAGE_URL).bearer_auth(&access_token);
            wipe(&mut access_token);
            let request = request.header("anthropic-beta", "oauth-2025-04-20").header("Accept", "application/json");
            let (status, retry_after, body) = wiped(exchange(request).await?);
            match body {
                Some(body) if (200..300).contains(&status) => Ok(body),
                _ if (200..300).contains(&status) => Err(FetchError::Invalid.into()),
                _ => Err(UsageFailure { error: FetchError::Http(status), retry_after }),
            }
        })
    }
}
