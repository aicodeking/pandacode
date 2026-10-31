//! IPC for Settings → Cloud and the cloud machines in the VM panel.
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{ipc::Response, AppHandle, Emitter};

use super::{aws::Aws, aws_screen, cloudflare::Cloudflare, daytona::Daytona, http::block, split, Machine};
use crate::Result;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub provider: &'static str,
    pub connected: bool,
    /// Cloudflare: the sandbox Worker is deployed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandboxes: Option<bool>,
    /// Providers that can run cloud agents: whether their tasks include the
    /// harness's saved environment variables (Settings → Providers). Absent on
    /// deploy-only providers: nothing is ever sent without this being on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherit_environment: Option<bool>,
    /// Non-secret details shown in Settings, such as an API URL or account.
    pub detail: Option<String>,
}

/// Providers whose cloud agents can inherit the harness's saved environment. Deploy-only
/// providers (Railway, Netlify) cannot host agents, so the setting does not apply to them.
fn inherits_environment(providers: &std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>, provider: &str) -> Option<bool> {
    (!matches!(provider, "railway" | "netlify")).then(|| providers.get(provider).and_then(|options| options.get("inheritEnvironment").map(String::as_str)) == Some("true"))
}

pub fn connections() -> Vec<Connection> {
    let settings = super::settings();
    vec![
        Connection { provider: "daytona", connected: super::secret("daytona_key").is_some(), sandboxes: None, inherit_environment: inherits_environment(&settings.providers, "daytona"), detail: settings.daytona_organization.or(settings.daytona_api_url) },
        Connection { provider: "cloudflare", connected: super::secret("cloudflare_token").is_some() && settings.cloudflare_account.is_some(), sandboxes: Some(super::secret("cloudflare_worker_token").is_some() && settings.cloudflare_worker_url.is_some()), inherit_environment: inherits_environment(&settings.providers, "cloudflare"), detail: settings.cloudflare_account.clone() },
        Connection { provider: "aws", connected: settings.aws_region.is_some(), sandboxes: None, inherit_environment: inherits_environment(&settings.providers, "aws"), detail: settings.aws_region.map(|region| format!("{} · {region}", settings.aws_profile.unwrap_or_else(|| "default profile".into()))) },
        Connection { provider: "vercel", connected: super::secret("vercel_token").is_some(), sandboxes: None, inherit_environment: inherits_environment(&settings.providers, "vercel"), detail: settings.vercel_team },
        Connection { provider: "railway", connected: super::secret("railway_token").is_some(), sandboxes: None, inherit_environment: None, detail: settings.railway_workspace },
        Connection { provider: "netlify", connected: super::secret("netlify_token").is_some(), sandboxes: None, inherit_environment: None, detail: settings.providers.get("netlify").and_then(|options| options.get("siteId").cloned()) },
        Connection { provider: "gcloud", connected: settings.gcloud_project.is_some(), sandboxes: None, inherit_environment: inherits_environment(&settings.providers, "gcloud"), detail: settings.gcloud_project.map(|project| match settings.gcloud_region { Some(region) => format!("{project} · {region}"), None => project }) },
        Connection { provider: "docker", connected: settings.providers.contains_key("docker"), sandboxes: None, inherit_environment: inherits_environment(&settings.providers, "docker"), detail: settings.providers.get("docker").and_then(|options| options.get("detail").cloned()) },
    ]
    .into_iter()
    .chain(super::sandbox::KEYED.iter().map(|&provider| Connection { provider, connected: super::sandbox::ready(provider), sandboxes: None, inherit_environment: inherits_environment(&settings.providers, provider), detail: settings.providers.get(provider).and_then(|options| options.get("detail").cloned()) }))
    .collect()
}

/// Turn the per-cloud inheritance of the harness's saved environment on or off.
/// Off by default: nothing is sent to the cloud unless this is on for that provider.
#[tauri::command]
pub async fn cloud_set_inherit_environment(provider: String, inherit: bool) -> Result<Vec<Connection>> {
    crate::blocking(move || {
        if !super::PROVIDERS.contains(&provider.as_str()) {
            return Err("Choose an available cloud provider.".into());
        }
        if matches!(provider.as_str(), "railway" | "netlify" | "agentcore") {
            return Err("This provider cannot host cloud agents, so there is no environment to inherit.".into());
        }
        let mut settings = super::settings();
        if inherit {
            settings.providers.entry(provider.clone()).or_default().insert("inheritEnvironment".into(), "true".into());
        } else if let Some(options) = settings.providers.get_mut(&provider) {
            options.remove("inheritEnvironment");
            if options.is_empty() {
                settings.providers.remove(&provider);
            }
        }
        super::save_settings(&settings)?;
        Ok(connections())
    })
    .await
}

#[tauri::command]
pub async fn cloud_connections() -> Result<Vec<Connection>> {
    crate::blocking(|| Ok(connections())).await
}

/// Check the credentials with a real request before saving them.
#[tauri::command]
pub async fn cloud_connect(app: AppHandle, provider: String, key: String, options: Value) -> Result<Vec<Connection>> {
    crate::blocking(move || {
        let text = |name: &str| options[name].as_str().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
        match provider.as_str() {
            "daytona" => {
                let api = text("apiUrl");
                if api.as_deref().is_some_and(|url| !url.starts_with("https://")) {
                    return Err("The Daytona API URL must start with https://.".into());
                }
                let daytona = Daytona::new(api.clone(), key.trim().to_string(), text("organization"));
                block(daytona.list())?;
                super::set_secret("daytona_key", key.trim())?;
                let mut settings = super::settings();
                settings.daytona_api_url = api;
                settings.daytona_organization = text("organization");
                super::save_settings(&settings)?;
            }
            "cloudflare" => {
                let account = text("account").ok_or("Enter your Cloudflare account ID.")?;
                if !account.bytes().all(|b| b.is_ascii_hexdigit()) || account.len() != 32 {
                    return Err("A Cloudflare account ID is 32 hexadecimal characters (Workers & Pages → Account details).".into());
                }
                block(super::cloudflare::verify_token(key.trim(), &account))?;
                super::set_secret("cloudflare_token", key.trim())?;
                let mut settings = super::settings();
                settings.cloudflare_account = Some(account);
                super::save_settings(&settings)?;
            }
            "vercel" => {
                let team = text("team");
                let (project_id, team_id) = vercel_ids(text("projectId"), text("teamId"))?;
                block(verify_vercel(key.trim(), team_id.as_deref().or(team.as_deref())))?;
                super::set_secret("vercel_token", key.trim())?;
                let mut settings = super::settings();
                settings.vercel_team = team;
                set_option(&mut settings, "vercel", "projectId", project_id);
                set_option(&mut settings, "vercel", "teamId", team_id);
                super::save_settings(&settings)?;
            }
            "railway" => {
                let workspace = text("workspace");
                block(verify_railway(RAILWAY_API, key.trim(), workspace.as_deref()))?;
                super::set_secret("railway_token", key.trim())?;
                let mut settings = super::settings();
                settings.railway_workspace = workspace;
                super::save_settings(&settings)?;
            }
            "netlify" => {
                let site = netlify_site_id(text("siteId"))?;
                block(verify_netlify(NETLIFY_API, key.trim(), site.as_deref()))?;
                super::set_secret("netlify_token", key.trim())?;
                let mut settings = super::settings();
                set_option(&mut settings, "netlify", "siteId", site);
                super::save_settings(&settings)?;
            }
            // Google Cloud uses gcloud's own login; PandaCode stores only the project and region.
            "gcloud" => {
                let project = text("project").ok_or("Enter your Google Cloud project ID.")?;
                if project.len() > 100 || project.starts_with('-') || !project.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.:".contains(&b)) {
                    return Err("That does not look like a Google Cloud project ID (for example my-app-123456).".into());
                }
                let region = text("region");
                if region.as_deref().is_some_and(|r| r.len() > 32 || !r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')) {
                    return Err("That does not look like a Google Cloud region (for example us-central1).".into());
                }
                let zone = text("zone");
                if zone.as_deref().is_some_and(|z| z.len() > 40 || !z.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') || z.rsplit_once('-').is_none_or(|(_, letter)| letter.len() != 1)) {
                    return Err("That does not look like a Google Cloud zone (for example us-central1-a).".into());
                }
                super::deploy::gcloud_verify(&project, region.as_deref())?;
                let mut settings = super::settings();
                settings.gcloud_project = Some(project);
                settings.gcloud_region = region;
                set_option(&mut settings, "gcloud", "zone", zone);
                super::save_settings(&settings)?;
            }
            // AWS uses the CLI's own login; PandaCode stores only the profile and region.
            "aws" => {
                let region = text("region").ok_or("Choose an AWS region, such as us-east-1.")?;
                if !region.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') || region.len() > 32 {
                    return Err("That does not look like an AWS region (for example us-east-1).".into());
                }
                let profile = text("profile");
                if profile.as_deref().is_some_and(|p| p.len() > 128 || p.starts_with('-') || p.chars().any(char::is_whitespace)) {
                    return Err("That does not look like an AWS CLI profile name.".into());
                }
                Aws { profile: profile.clone(), region: region.clone() }.identity()?;
                let mut settings = super::settings();
                settings.aws_profile = profile;
                settings.aws_region = Some(region);
                super::save_settings(&settings)?;
            }
            // Docker uses the local (or configured remote) engine; PandaCode stores no credentials.
            "docker" => super::docker::connect(&options)?,
            other if super::sandbox::KEYED.contains(&other) => super::sandbox::connect(other, key.trim(), &options)?,
            _ => return Err("Unknown cloud provider.".into()),
        }
        let _ = app.emit("vm-changed", serde_json::json!({}));
        Ok(connections())
    })
    .await
}

/// Set or clear one saved option of a provider (`settings.providers[provider][name]`).
fn set_option(settings: &mut super::Settings, provider: &str, name: &str, value: Option<String>) {
    let options = settings.providers.entry(provider.into()).or_default();
    match value { Some(value) => { options.insert(name.into(), value); } None => { options.remove(name); } }
    if options.is_empty() { settings.providers.remove(provider); }
}

/// Vercel project (`prj_…`) and team (`team_…`) IDs. The team slug stays in `vercel_team`.
fn vercel_ids(project: Option<String>, team_id: Option<String>) -> Result<(Option<String>, Option<String>)> {
    let id = |value: &str, prefix: &str| value.len() <= 64 && value.strip_prefix(prefix).is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()));
    if project.as_deref().is_some_and(|p| !id(p, "prj_")) {
        return Err("A Vercel project ID looks like prj_… (Project → Settings → General).".into());
    }
    if team_id.as_deref().is_some_and(|t| !id(t, "team_")) {
        return Err("A Vercel team ID looks like team_… (Team → Settings → General).".into());
    }
    Ok((project, team_id))
}

async fn verify_vercel(token: &str, team: Option<&str>) -> Result<()> {
    let client = super::http::client(Duration::from_secs(30))?;
    let url = match team { Some(team) => format!("https://api.vercel.com/v2/teams/{team}"), None => "https://api.vercel.com/v2/user".into() };
    super::http::send("Vercel", client.get(url).bearer_auth(token)).await.map(|_| ())
}

const RAILWAY_API: &str = "https://backboard.railway.com/graphql/v2";
const NETLIFY_API: &str = "https://api.netlify.com/api/v1";

fn netlify_site_id(site: Option<String>) -> Result<Option<String>> {
    site.map(|id| uuid::Uuid::parse_str(&id).map(|id| id.to_string())
        .map_err(|_| "A Netlify project ID is a UUID (Project configuration / General / Project details).".into())).transpose()
}

/// Check the selected project, or the account when no project was selected.
async fn verify_netlify(api: &str, token: &str, site: Option<&str>) -> Result<()> {
    let client = super::http::client(Duration::from_secs(30))?;
    let path = site.map_or_else(|| "user".to_string(), |id| format!("sites/{id}"));
    let reply = super::http::send("Netlify", client.get(format!("{api}/{path}")).bearer_auth(token)).await?;
    if reply["id"].as_str().is_none_or(str::is_empty) {
        return Err("Netlify did not return an account or project ID.".into());
    }
    Ok(())
}

/// An account token can read `me`; a workspace token only its own workspace.
async fn verify_railway(api: &str, token: &str, workspace: Option<&str>) -> Result<()> {
    let client = super::http::client(Duration::from_secs(30))?;
    let body = match workspace {
        Some(id) => serde_json::json!({"query": "query($id: String!) { workspace(workspaceId: $id) { id } }", "variables": {"id": id}}),
        None => serde_json::json!({"query": "{ me { id } }"}),
    };
    let reply = super::http::send("Railway", client.post(api).bearer_auth(token).json(&body)).await?;
    if reply["data"]["me"]["id"].is_string() || reply["data"]["workspace"]["id"].is_string() {
        return Ok(());
    }
    // GraphQL reports a bad token or an unknown workspace with HTTP 200 and an errors list.
    Err(match (workspace, reply["errors"][0]["message"].as_str()) {
        (Some(_), Some(message)) if !message.to_ascii_lowercase().contains("not authorized") => format!("Railway: {}", message.chars().take(200).collect::<String>()),
        (None, _) => "Railway refused the token. Use an account token, or a workspace token with its workspace ID.".into(),
        _ => "Railway refused the token for that workspace. Check the token and the workspace ID.".into(),
    })
}

/// Deploy PandaCode's sandbox Worker to the connected Cloudflare account (needs Docker).
#[tauri::command]
pub async fn cloud_setup_sandboxes(app: AppHandle) -> Result<Vec<Connection>> {
    crate::blocking(move || {
        let token = super::secret("cloudflare_token").ok_or("Connect Cloudflare first.")?;
        let account = super::settings().cloudflare_account.ok_or("Connect Cloudflare first.")?;
        let progress = |label: &str| { let _ = app.emit("cloud-setup", serde_json::json!({"provider": "cloudflare", "label": label})); };
        let (url, secret) = super::cloudflare::deploy(&token, &account, &progress)?;
        progress("Checking the Worker…");
        let worker = Cloudflare::new(url.clone(), secret.clone());
        // A fresh workers.dev route can take a few seconds to answer.
        let mut ready = Err(String::new());
        for _ in 0..10 {
            ready = block(worker.health());
            if ready.is_ok() { break; }
            std::thread::sleep(Duration::from_secs(3));
        }
        ready.map_err(|e| format!("The Worker deployed but did not answer yet ({e}). Try again in a minute."))?;
        super::set_secret("cloudflare_worker_token", &secret)?;
        let mut settings = super::settings();
        settings.cloudflare_worker_url = Some(url);
        super::save_settings(&settings)?;
        let _ = app.emit("vm-changed", serde_json::json!({}));
        Ok(connections())
    })
    .await
}

#[tauri::command]
pub async fn cloud_disconnect(app: AppHandle, provider: String) -> Result<Vec<Connection>> {
    crate::blocking(move || {
        match provider.as_str() {
            "daytona" => {
                super::remove_secret("daytona_key");
                let mut settings = super::settings();
                settings.daytona_api_url = None;
                settings.daytona_organization = None;
                super::save_settings(&settings)?;
            }
            // The Worker stays in the account; Settings says how to remove it.
            "cloudflare" => {
                super::remove_secret("cloudflare_worker_token");
                super::remove_secret("cloudflare_token");
                let mut settings = super::settings();
                settings.cloudflare_worker_url = None;
                settings.cloudflare_account = None;
                settings.cloudflare_sandboxes.clear();
                super::save_settings(&settings)?;
            }
            "vercel" => {
                super::remove_secret("vercel_token");
                let mut settings = super::settings();
                settings.vercel_team = None;
                settings.providers.remove("vercel");
                super::save_settings(&settings)?;
            }
            "railway" => {
                super::remove_secret("railway_token");
                let mut settings = super::settings();
                settings.railway_workspace = None;
                super::save_settings(&settings)?;
            }
            "netlify" => {
                super::remove_secret("netlify_token");
                let mut settings = super::settings();
                settings.providers.remove("netlify");
                super::save_settings(&settings)?;
            }
            "gcloud" => {
                let mut settings = super::settings();
                settings.gcloud_project = None;
                settings.gcloud_region = None;
                settings.providers.remove("gcloud");
                super::save_settings(&settings)?;
            }
            "docker" => super::docker::disconnect()?,
            "aws" => {
                aws_screen::close(None);
                let mut settings = super::settings();
                settings.aws_profile = None;
                settings.aws_region = None;
                super::save_settings(&settings)?;
            }
            other if super::sandbox::KEYED.contains(&other) => super::sandbox::disconnect(other)?,
            _ => return Err("Unknown cloud provider.".into()),
        }
        let _ = app.emit("vm-changed", serde_json::json!({}));
        Ok(connections())
    })
    .await
}

/// The images new InstaBox machines can start from, for Settings → Cloud.
#[tauri::command]
pub async fn cloud_instabox_images() -> Result<super::instabox::Images> {
    crate::blocking(super::instabox::images).await
}

/// Choose the image (`template:<id>` or `snapshot:<id>` from `cloud_instabox_images`).
#[tauri::command]
pub async fn cloud_instabox_set_image(image: String) -> Result<super::instabox::Images> {
    crate::blocking(move || super::instabox::set_image(&image)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machines {
    pub machines: Vec<Machine>,
    /// Providers that could not be listed, with why.
    pub errors: Vec<String>,
}

/// Every connected provider's machines; one failing provider does not hide the others.
pub fn machines() -> Machines {
    let mut result = Machines { machines: Vec::new(), errors: Vec::new() };
    if let Ok(daytona) = Daytona::connected() {
        match block(daytona.list()) {
            Ok(list) => result.machines.extend(list),
            Err(error) => result.errors.push(error),
        }
    }
    if let Ok(cloudflare) = Cloudflare::connected() {
        match block(cloudflare.list(&super::settings().cloudflare_sandboxes)) {
            Ok(list) => result.machines.extend(list),
            Err(error) => result.errors.push(error),
        }
    }
    if let Ok(aws) = Aws::connected() {
        match aws.list() {
            Ok(list) => result.machines.extend(list),
            Err(error) => result.errors.push(error),
        }
        // AgentCore may not be offered in every region or account; that is not an error worth showing.
        if let Ok(list) = aws.interpreter_list() {
            result.machines.extend(list);
        }
    }
    // Google Cloud is also a deploy-only connection; list its VMs only once a cloud-agent zone is chosen.
    let gcloud_agents = super::settings().providers.get("gcloud").is_some_and(|o| o.contains_key("zone"));
    for provider in ["gcloud", "docker", "digitalocean", "vultr", "hetzner", "runpod", "e2b", "modal", "vercel", "codesandbox", "runloop", "blaxel", "tensorlake", "freestyle", "boat", "instabox"] {
        if provider == "gcloud" && !gcloud_agents { continue; }
        if let Ok(sandbox) = super::sandbox::connected(provider) {
            match sandbox.list() {
                Ok(list) => result.machines.extend(list),
                Err(error) => result.errors.push(error),
            }
        }
    }
    result
}

#[tauri::command]
pub async fn cloud_machines() -> Result<Machines> {
    crate::blocking(|| Ok(machines())).await
}

pub fn create(provider: &str, name: &str) -> Result<Machine> {
    match provider {
        "daytona" => block(Daytona::connected()?.create(name)),
        "cloudflare" => {
            let machine = block(Cloudflare::connected()?.create(name))?;
            let mut settings = super::settings();
            if !settings.cloudflare_sandboxes.iter().any(|n| n == name) {
                settings.cloudflare_sandboxes.push(name.to_string());
                super::save_settings(&settings)?;
            }
            Ok(machine)
        }
        "aws-linux" | "aws-windows" => {
            let (machine, password) = Aws::connected()?.create(&provider[4..], name)?;
            let instance = machine.id.trim_start_matches("aws:").to_string();
            super::set_secret(&aws_screen::password_key(&instance), &password)?;
            Ok(machine)
        }
        "agentcore" => Aws::connected()?.interpreter_start(name),
        other => super::sandbox::connected(other)?.create(name),
    }
}
/// An AWS desktop's OS, from its tags.
fn aws_os(aws: &Aws, instance: &str) -> Result<String> {
    let found = aws.call(&["ec2", "describe-instances", "--instance-ids", instance], Duration::from_secs(60))?;
    let item = &found["Reservations"][0]["Instances"][0];
    if item.is_null() { return Err("AWS has no such instance.".into()); }
    Ok(Aws::machine(item).os)
}
pub fn power(id: &str, action: &str) -> Result<()> {
    match split(id) {
        Some(("daytona", native)) => block(Daytona::connected()?.power(native, action)),
        Some(("cloudflare", native)) => {
            block(Cloudflare::connected()?.power(native, action))?;
            if action == "delete" {
                let mut settings = super::settings();
                settings.cloudflare_sandboxes.retain(|n| n != native);
                super::save_settings(&settings)?;
            }
            Ok(())
        }
        Some(("aws", native)) => {
            if action != "start" { aws_screen::close(Some(native)); }
            Aws::connected()?.power(native, action)?;
            if action == "delete" { super::remove_secret(&aws_screen::password_key(native)); }
            Ok(())
        }
        Some(("agentcore", native)) if matches!(action, "stop" | "delete") => Aws::connected()?.interpreter_stop(native),
        Some(("agentcore", _)) => Err("AgentCore sessions cannot be restarted; create a new one.".into()),
        Some((provider, native)) => super::sandbox::connected(provider)?.power(native, action),
        _ => Err("Unknown cloud machine.".into()),
    }
}
pub fn exec(id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
    match split(id) {
        Some(("daytona", native)) => block(Daytona::connected()?.exec(native, command, timeout)),
        Some(("cloudflare", native)) => block(Cloudflare::connected()?.exec(native, command, timeout)),
        Some(("aws", native)) => { let aws = Aws::connected()?; let windows = aws_os(&aws, native)? == "windows"; aws.exec(native, windows, command, timeout) }
        Some(("agentcore", native)) => { let aws = Aws::connected()?; let credentials = aws.credentials()?; block(aws.interpreter_exec(native, command, &credentials, None)) }
        Some((provider, native)) => super::sandbox::connected(provider)?.exec(native, command, timeout),
        _ => Err("Unknown cloud machine.".into()),
    }
}
pub fn screenshot(id: &str) -> Result<crate::vm::screen::Shot> {
    match split(id) {
        Some(("daytona", native)) => block(Daytona::connected()?.screenshot(native)),
        Some(("aws", native)) => { let aws = Aws::connected()?; let os = aws_os(&aws, native)?; aws_screen::screenshot(&aws, native, &os) }
        _ => Err("This machine has no screen.".into()),
    }
}
pub fn act(id: &str, action: &crate::vm::screen::Action) -> Result<String> {
    match split(id) {
        Some(("daytona", native)) => block(Daytona::connected()?.act(native, action)),
        Some(("aws", native)) => { let aws = Aws::connected()?; let os = aws_os(&aws, native)?; aws_screen::act(&aws, native, &os, action) }
        _ => Err("This machine has no screen.".into()),
    }
}

#[tauri::command]
pub async fn cloud_create(app: AppHandle, provider: String, name: String) -> Result<Machine> {
    crate::blocking(move || {
        let machine = create(&provider, &name)?;
        let _ = app.emit("vm-changed", serde_json::json!({}));
        Ok(machine)
    })
    .await
}
#[tauri::command]
pub async fn cloud_power(app: AppHandle, id: String, action: String) -> Result<()> {
    crate::blocking(move || {
        power(&id, &action)?;
        let _ = app.emit("vm-changed", serde_json::json!({}));
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn cloud_frame(id: String) -> Result<Response> {
    crate::blocking(move || Ok(Response::new(screenshot(&id)?.jpeg))).await
}
#[tauri::command]
pub async fn cloud_input(id: String, input: Value) -> Result<String> {
    let action = crate::vm::tools::action(&input)?;
    crate::blocking(move || act(&id, &action)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    #[test]
    fn validates_vercel_ids_and_never_stores_the_slug_as_an_id() {
        let ok = |p: Option<&str>, t: Option<&str>| vercel_ids(p.map(Into::into), t.map(Into::into));
        assert_eq!(ok(Some("prj_Ab12"), Some("team_x9")).unwrap(), (Some("prj_Ab12".into()), Some("team_x9".into())));
        assert_eq!(ok(None, None).unwrap(), (None, None));
        assert!(ok(Some("project"), None).is_err() && ok(Some("prj_"), None).is_err());
        assert!(ok(None, Some("acme")).is_err());
    }

    #[test]
    fn set_option_adds_replaces_and_clears() {
        let mut settings = super::super::Settings::default();
        set_option(&mut settings, "gcloud", "zone", Some("us-east1-b".into()));
        assert_eq!(settings.providers["gcloud"]["zone"], "us-east1-b");
        set_option(&mut settings, "gcloud", "zone", None);
        assert!(!settings.providers.contains_key("gcloud"));
    }

    #[test]
    fn validates_netlify_project_ids() {
        let id = "12345678-1234-4234-8234-123456789abc";
        assert_eq!(netlify_site_id(Some(id.into())).unwrap(), Some(id.into()));
        assert_eq!(netlify_site_id(Some(id.replace('-', ""))).unwrap(), Some(id.into()));
        assert_eq!(netlify_site_id(None).unwrap(), None);
        for bad in ["project-name", "../other", "--auth=override", "", "not/a/uuid"] {
            assert!(netlify_site_id(Some(bad.into())).is_err());
        }
    }

    #[tokio::test]
    async fn verifies_netlify_account_and_selected_project() {
        let (base, seen) = mock::serve(|request, _| match (request.authorization.as_deref(), request.path.as_str()) {
            (Some("Bearer account"), "/api/v1/user") => (200, r#"{"id":"user-1","email":"private@example.test"}"#),
            (Some("Bearer project"), "/api/v1/sites/12345678-1234-4234-8234-123456789abc") => (200, r#"{"id":"12345678-1234-4234-8234-123456789abc"}"#),
            (Some("Bearer malformed"), _) => (200, r#"{}"#),
            _ => (401, r#"{"message":"Unauthorized"}"#),
        });
        let api = format!("{base}/api/v1");
        verify_netlify(&api, "account", None).await.unwrap();
        verify_netlify(&api, "project", Some("12345678-1234-4234-8234-123456789abc")).await.unwrap();
        assert!(verify_netlify(&api, "bad", None).await.is_err());
        assert!(verify_netlify(&api, "malformed", None).await.unwrap_err().contains("did not return"));
        assert!(seen.lock().unwrap().iter().all(|request| request.method == "GET"));
    }

    #[tokio::test]
    async fn verifies_railway_account_and_workspace_tokens() {
        let (base, seen) = mock::serve(|request, _| match request.authorization.as_deref() {
            Some("Bearer account") if request.body.contains("me {") => (200, r#"{"data":{"me":{"id":"u1"}}}"#),
            Some("Bearer workspace") if request.body.contains(r#""id":"ws-1""#) => (200, r#"{"data":{"workspace":{"id":"ws-1"}}}"#),
            Some("Bearer workspace") => (200, r#"{"data":{"workspace":null},"errors":[{"message":"Workspace not found"}]}"#),
            _ => (200, r#"{"data":null,"errors":[{"message":"Not Authorized"}]}"#),
        });
        let api = format!("{base}/graphql/v2");
        verify_railway(&api, "account", None).await.unwrap();
        verify_railway(&api, "workspace", Some("ws-1")).await.unwrap();
        assert!(verify_railway(&api, "workspace", None).await.unwrap_err().contains("workspace token with its workspace ID"));
        assert_eq!(verify_railway(&api, "workspace", Some("ws-2")).await.unwrap_err(), "Railway: Workspace not found");
        assert!(verify_railway(&api, "bad", Some("ws-1")).await.unwrap_err().contains("refused the token"));
        let seen = seen.lock().unwrap();
        assert!(seen.iter().all(|r| r.method == "POST" && r.path == "/graphql/v2"));
    }
}
