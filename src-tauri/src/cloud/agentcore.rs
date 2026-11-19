//! Amazon Bedrock AgentCore Code Interpreter sessions: quick, managed Linux sandboxes for
//! commands (no desktop). Sessions start, list and stop through the AWS CLI; commands
//! use InvokeCodeInterpreter, a streaming API the CLI lacks, so PandaCode signs that one
//! request itself (SigV4) with temporary credentials the CLI exports.
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

use super::{aws::Aws, http, Machine};

pub const INTERPRETER: &str = "aws.codeinterpreter.v1";
const QUICK: Duration = Duration::from_secs(90);
const SESSION_SECONDS: &str = "3600";

pub struct Credentials {
    pub access_key: String,
    pub secret_key: String,
    pub session_token: Option<String>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// Who signs, where, and when (`amz_date` is `YYYYMMDDTHHMMSSZ`).
pub struct Signer<'a> {
    pub region: &'a str,
    pub service: &'a str,
    pub credentials: &'a Credentials,
    pub amz_date: &'a str,
}

/// The SigV4 Authorization header for one request. `headers` are lowercase name/value
/// pairs to sign, including `host`.
pub fn sign(method: &str, path: &str, headers: &[(String, String)], body: &[u8], signer: &Signer) -> String {
    let Signer { region, service, credentials, amz_date } = *signer;
    let mut headers: Vec<(String, String)> = headers.to_vec();
    headers.push(("x-amz-date".into(), amz_date.into()));
    if let Some(token) = &credentials.session_token {
        headers.push(("x-amz-security-token".into(), token.clone()));
    }
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(n, v)| format!("{n}:{}\n", v.trim())).collect();
    let signed: Vec<&str> = headers.iter().map(|(n, _)| n.as_str()).collect();
    let signed = signed.join(";");
    let canonical = format!("{method}\n{path}\n\n{canonical_headers}\n{signed}\n{}", hex(&Sha256::digest(body)));
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex(&Sha256::digest(canonical.as_bytes())));
    let key = [region, service, "aws4_request"].iter().fold(hmac(format!("AWS4{}", credentials.secret_key).as_bytes(), date), |key, part| hmac(&key, part));
    format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={}", credentials.access_key, hex(&hmac(&key, &to_sign)))
}

/// Messages of an AWS event stream as (headers, payload). CRCs are not rechecked; TLS
/// already protects the bytes.
pub type Event = (Vec<(String, String)>, Vec<u8>);
pub fn events(mut bytes: &[u8]) -> Result<Vec<Event>, String> {
    const MALFORMED: &str = "AgentCore sent a malformed event stream.";
    const UNKNOWN: &str = "AgentCore sent an unknown event header.";
    let mut out = Vec::new();
    while bytes.len() >= 16 {
        let total = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let header_length = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
        if total < 16 + header_length || total > bytes.len() {
            return Err(MALFORMED.into());
        }
        let mut cursor = &bytes[12..12 + header_length];
        let mut headers = Vec::new();
        while !cursor.is_empty() {
            let name_length = cursor[0] as usize;
            let name = String::from_utf8_lossy(cursor.get(1..1 + name_length).ok_or(MALFORMED)?).into_owned();
            let kind = *cursor.get(1 + name_length).ok_or(MALFORMED)?;
            let rest = cursor.get(2 + name_length..).ok_or(MALFORMED)?;
            // Only string headers (type 7) matter here; others are skipped by their size.
            let (value, used) = match kind {
                7 => {
                    let length = rest.get(..2).ok_or(MALFORMED)?;
                    let length = u16::from_be_bytes([length[0], length[1]]) as usize;
                    (String::from_utf8_lossy(rest.get(2..2 + length).ok_or(MALFORMED)?).into_owned(), 2 + length)
                }
                6 => {
                    let length = rest.get(..2).ok_or(MALFORMED)?;
                    let length = u16::from_be_bytes([length[0], length[1]]) as usize;
                    (String::new(), 2 + length)
                }
                0 | 1 => (String::new(), 0),
                2 => (String::new(), 1),
                3 => (String::new(), 2),
                4 => (String::new(), 4),
                5 | 8 => (String::new(), 8),
                9 => (String::new(), 16),
                _ => return Err(UNKNOWN.into()),
            };
            headers.push((name, value));
            cursor = rest.get(used..).ok_or(MALFORMED)?;
        }
        out.push((headers, bytes[12 + header_length..total - 4].to_vec()));
        bytes = &bytes[total..];
    }
    Ok(out)
}

impl Aws {
    pub fn credentials(&self) -> Result<Credentials, String> {
        let exported = self.call(&["configure", "export-credentials", "--format", "process"], QUICK)?;
        Ok(Credentials {
            access_key: exported["AccessKeyId"].as_str().ok_or("The AWS CLI exported no credentials.")?.to_string(),
            secret_key: exported["SecretAccessKey"].as_str().ok_or("The AWS CLI exported no credentials.")?.to_string(),
            session_token: exported["SessionToken"].as_str().map(str::to_string),
        })
    }
    pub fn interpreter_list(&self) -> Result<Vec<Machine>, String> {
        let found = self.call(&["bedrock-agentcore", "list-code-interpreter-sessions", "--code-interpreter-identifier", INTERPRETER, "--status", "READY"], QUICK)?;
        Ok(found["items"].as_array().into_iter().flatten().map(|s| Machine {
            id: format!("agentcore:{}", s["sessionId"].as_str().unwrap_or_default()),
            provider: "agentcore".into(),
            name: s["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("AgentCore session").to_string(),
            state: "running".into(),
            os: "linux".into(),
            desktop: false,
            detail: "AWS AgentCore code interpreter · commands only · ends after an hour".into(),
        }).collect())
    }
    pub fn interpreter_start(&self, name: &str) -> Result<Machine, String> {
        let started = self.call(&["bedrock-agentcore", "start-code-interpreter-session", "--code-interpreter-identifier", INTERPRETER, "--name", name, "--session-timeout-seconds", SESSION_SECONDS], QUICK)?;
        let id = started["sessionId"].as_str().ok_or("AgentCore did not start a session.")?;
        Ok(Machine { id: format!("agentcore:{id}"), provider: "agentcore".into(), name: name.into(), state: "running".into(), os: "linux".into(), desktop: false, detail: "AWS AgentCore code interpreter · commands only · ends after an hour".into() })
    }
    pub fn interpreter_stop(&self, session: &str) -> Result<(), String> {
        self.call(&["bedrock-agentcore", "stop-code-interpreter-session", "--code-interpreter-identifier", INTERPRETER, "--session-id", session], QUICK).map(|_| ())
    }
    /// Run a shell command in a code interpreter session.
    pub async fn interpreter_exec(&self, session: &str, command: &str, credentials: &Credentials, endpoint: Option<&str>) -> Result<(Option<i32>, String), String> {
        let host = format!("bedrock-agentcore.{}.amazonaws.com", self.region);
        let path = format!("/code-interpreters/{INTERPRETER}/tools/invoke");
        let body = serde_json::to_vec(&json!({"name": "executeCommand", "arguments": {"command": command}})).map_err(|e| e.to_string())?;
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let signed = vec![("content-type".to_string(), "application/json".to_string()), ("host".to_string(), host.clone()), ("x-amzn-code-interpreter-session-id".to_string(), session.to_string())];
        let authorization = sign("POST", &path, &signed, &body, &Signer { region: &self.region, service: "bedrock-agentcore", credentials, amz_date: &amz_date });
        let client = http::client(Duration::from_secs(600))?;
        let mut request = client.post(format!("{}{path}", endpoint.map_or_else(|| format!("https://{host}"), str::to_string)))
            .header("content-type", "application/json").header("x-amz-date", &amz_date)
            .header("x-amzn-code-interpreter-session-id", session).header("authorization", authorization).body(body);
        if let Some(token) = &credentials.session_token {
            request = request.header("x-amz-security-token", token);
        }
        let response = request.send().await.map_err(|_| "Could not reach AgentCore.".to_string())?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|_| "AgentCore's response was cut off.".to_string())?;
        if !(200..300).contains(&status) {
            return Err(http::error_message("AgentCore", status, &String::from_utf8_lossy(&bytes)));
        }
        let mut output = String::new();
        let mut code = None;
        for (headers, payload) in events(&bytes)? {
            let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
            let message: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
            if header(":message-type") == Some("exception") {
                return Err(format!("AgentCore: {}", message["message"].as_str().unwrap_or(header(":exception-type").unwrap_or("request failed"))));
            }
            let result = if message["result"].is_object() { &message["result"] } else { &message };
            let structured = &result["structuredContent"];
            if structured.is_object() {
                output.push_str(structured["stdout"].as_str().unwrap_or_default());
                if let Some(stderr) = structured["stderr"].as_str().filter(|s| !s.is_empty()) {
                    output.push_str(&format!("\n[stderr]\n{stderr}"));
                }
                code = structured["exitCode"].as_i64().map(|c| c as i32).or(code);
            } else {
                for block in result["content"].as_array().into_iter().flatten() {
                    output.push_str(block["text"].as_str().unwrap_or_default());
                }
            }
        }
        Ok((code, output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    /// AWS's published SigV4 test case `get-vanilla`.
    #[test]
    fn signs_like_the_aws_test_suite() {
        let credentials = Credentials { access_key: "AKIDEXAMPLE".into(), secret_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(), session_token: None };
        let authorization = sign("GET", "/", &[("host".into(), "example.amazonaws.com".into())], b"", &Signer { region: "us-east-1", service: "service", credentials: &credentials, amz_date: "20150830T123600Z" });
        assert_eq!(authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    }

    fn frame(headers: &[(&str, &str)], payload: &str) -> Vec<u8> {
        let mut encoded = Vec::new();
        for (name, value) in headers {
            encoded.push(name.len() as u8);
            encoded.extend_from_slice(name.as_bytes());
            encoded.push(7);
            encoded.extend_from_slice(&(value.len() as u16).to_be_bytes());
            encoded.extend_from_slice(value.as_bytes());
        }
        let total = 16 + encoded.len() + payload.len();
        let mut out = Vec::new();
        out.extend_from_slice(&(total as u32).to_be_bytes());
        out.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&encoded);
        out.extend_from_slice(payload.as_bytes());
        out.extend_from_slice(&[0; 4]);
        out
    }

    #[test]
    fn reads_event_stream_frames() {
        let mut bytes = frame(&[(":event-type", "result"), (":message-type", "event")], r#"{"x":1}"#);
        bytes.extend(frame(&[(":message-type", "exception")], r#"{"message":"no"}"#));
        let parsed = events(&bytes).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0[0], (":event-type".to_string(), "result".to_string()));
        assert_eq!(parsed[1].1, br#"{"message":"no"}"#);
        assert!(events(&bytes[..20]).is_err());
    }

    /// A frame from raw header bytes, so a header can be made to run past its own block.
    fn raw_frame(header_bytes: &[u8]) -> Vec<u8> {
        let total = 16 + header_bytes.len();
        let mut out = Vec::new();
        out.extend_from_slice(&(total as u32).to_be_bytes());
        out.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(header_bytes);
        out.extend_from_slice(&[0; 4]);
        out
    }

    #[test]
    fn a_header_that_runs_past_its_block_is_rejected_instead_of_panicking() {
        // A name longer than the block: `name_length` is 200 with four bytes to read.
        assert_eq!(events(&raw_frame(&[200, 0, 0, 0])), Err("AgentCore sent a malformed event stream.".into()));
        // A string header whose value runs past the block.
        assert_eq!(events(&raw_frame(&[0, 7, 0, 50])), Err("AgentCore sent a malformed event stream.".into()));
        // A fixed-size header with no room for its value.
        assert_eq!(events(&raw_frame(&[0, 9, 0, 0])), Err("AgentCore sent a malformed event stream.".into()));
        // The same frame, well formed: one string header with an empty name.
        assert_eq!(events(&raw_frame(&[0, 7, 0, 1, b'a'])).unwrap(), vec![(vec![(String::new(), "a".into())], Vec::new())]);
    }

    #[tokio::test]
    async fn runs_a_command_with_a_signed_request() {
        let reply = frame(&[(":event-type", "result"), (":message-type", "event")], r#"{"structuredContent":{"stdout":"hi\n","stderr":"","exitCode":0}}"#);
        let (base, seen) = mock::serve(move |_, _| (200, reply.clone()));
        let aws = Aws { profile: None, region: "us-west-2".into() };
        let credentials = Credentials { access_key: "AKID".into(), secret_key: "secret".into(), session_token: Some("token".into()) };
        assert_eq!(aws.interpreter_exec("sess-1", "echo hi", &credentials, Some(&base)).await.unwrap(), (Some(0), "hi\n".into()));
        let request = seen.lock().unwrap()[0].clone();
        assert_eq!(request.path, "/code-interpreters/aws.codeinterpreter.v1/tools/invoke");
        assert!(request.authorization.unwrap().starts_with("AWS4-HMAC-SHA256 Credential=AKID/"));
        assert!(request.headers.iter().any(|(n, v)| n == "x-amz-security-token" && v == "token"));
        assert!(request.headers.iter().any(|(n, v)| n == "x-amzn-code-interpreter-session-id" && v == "sess-1"));
        assert_eq!(serde_json::from_str::<Value>(&request.body).unwrap(), json!({"name":"executeCommand","arguments":{"command":"echo hi"}}));
    }
}
