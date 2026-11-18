use super::*;

const MAX_RESPONSE: usize = 256 * 1024;
const MAX_TEXT: usize = 64 * 1024;
/// Retry resends to the profile snapshot taken at Start; Settings edits apply only to a new recording.
pub(super) const SETTINGS_FIX: &str = " Retry repeats this recording's original settings; after changing the key, model or endpoint in Settings, discard and record again.";

pub(super) async fn transcribe(
    profile: &Snapshot,
    audio: Arc<Vec<u8>>,
    mut cancel: watch::Receiver<bool>,
) -> Result<String> {
    if *cancel.borrow() {
        return Err(CANCELLED.into());
    }
    let endpoint = validate_endpoint(&profile.endpoint)?;
    if audio.len() > MAX_AUDIO_BYTES || audio.len() <= 44 {
        return Err("No valid recorded audio is available. Record again.".into());
    }
    let request = async {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .no_proxy()
            .build()
            .map_err(|_| "Could not prepare the speech provider connection.".to_owned())?;
        let part = reqwest::multipart::Part::bytes(audio.as_ref().clone())
            .file_name("dictation.wav")
            .mime_str("audio/wav")
            .map_err(|_| "Could not prepare recorded audio.".to_owned())?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", profile.model.clone());
        if let Some(language) = &profile.language {
            form = form.text("language", language.clone());
        }
        let mut request = client.post(endpoint).multipart(form);
        if let Some(key) = &profile.key {
            let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| format!("This voice profile's API key is invalid.{SETTINGS_FIX}"))?;
            value.set_sensitive(true);
            request = request.header(reqwest::header::AUTHORIZATION, value);
        }
        let mut response = request.send().await.map_err(|error| if error.is_timeout() {
            "The speech provider timed out. Retry the recording or discard it.".to_owned()
        } else { format!("Could not reach the speech provider. Check your connection, then retry.{SETTINGS_FIX}") })?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => format!("The speech provider rejected access. Check the profile's API key in Settings.{SETTINGS_FIX}"),
                404 => format!("The speech endpoint or model was not found. Check the full transcription URL and model in Settings.{SETTINGS_FIX}"),
                413 => "The speech provider rejected the recording size. Record a shorter message.".into(),
                429 => "The speech provider is rate limited or out of quota. Wait before retrying.".into(),
                300..=399 => format!("The speech endpoint redirected the request. Enter its final transcription URL in Settings.{SETTINGS_FIX}"),
                _ => format!("The speech provider could not transcribe the recording. Retry, or check the model and endpoint.{SETTINGS_FIX}"),
            });
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_RESPONSE as u64)
        {
            return Err("The speech provider returned too much data.".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read the speech provider's response.".to_owned())?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                return Err("The speech provider returned too much data.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        #[derive(serde::Deserialize)]
        struct Response {
            text: String,
        }
        let parsed: Response = serde_json::from_slice(&bytes).map_err(|_| {
            "The speech provider returned an invalid transcription response.".to_owned()
        })?;
        let text = parsed.text.trim();
        if text.len() > MAX_TEXT
            || text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Err(
                "The speech provider returned invalid or excessive transcription text.".into(),
            );
        }
        if text.is_empty() {
            return Err("No speech was recognized. Record again, or retry this recording.".into());
        }
        Ok(text.to_owned())
    };
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(CANCELLED.into()),
        result = request => result,
    }
}
