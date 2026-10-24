//! Railway machines for cloud agents (docs/cloud-agents.md), over Railway's public GraphQL
//! API (https://docs.railway.com/integrations/api) with the deploy connection's token and
//! workspace. Each machine is a project `pandacode-<name>` holding one service, a Debian
//! container whose start command sleeps, so it stays up until deleted.
//!
//! Railway can't run cloud agents: its API has no way to run a command in a service and
//! read the result. The only route is `railway ssh` (https://docs.railway.com/cli/ssh),
//! which needs the user's SSH key registered with Railway and an interactive CLI, so `exec`
//! refuses with that explanation. Listing, creating and deleting work.
use serde_json::{json, Value};
use std::time::Duration;

use super::{http, http::block, sandbox::{Info, Sandbox}, Machine};

type Result<T> = std::result::Result<T, String>;

const API: &str = "https://backboard.railway.com/graphql/v2";
const SERVICE: &str = "Railway";
const PREFIX: &str = "pandacode-";
const IMAGE: &str = "debian:bookworm-slim";
const NO_EXEC: &str = "Railway can't run cloud agents: its API has no way to run commands in a service (only `railway ssh`, which needs your SSH key registered with Railway). Pick another provider for cloud agents.";

pub struct Railway {
    api: String,
    token: String,
    workspace: Option<String>,
}

fn machine(project: &Value) -> Machine {
    let id = project["id"].as_str().unwrap_or_default();
    let name = project["name"].as_str().unwrap_or(id);
    Machine {
        id: format!("railway:{id}"),
        provider: "railway".into(),
        name: name.strip_prefix(PREFIX).unwrap_or(name).to_string(),
        state: "running".into(),
        os: "linux".into(),
        desktop: false,
        detail: format!("Railway · {IMAGE} · no command access"),
    }
}

impl Railway {
    fn connected() -> Result<Self> {
        let token = super::secret("railway_token").ok_or("Connect Railway in Settings → Cloud first.")?;
        Ok(Railway { api: API.into(), token, workspace: super::settings().railway_workspace })
    }

    async fn graphql(&self, query: &str, variables: Value) -> Result<Value> {
        let client = http::client(Duration::from_secs(60))?;
        let reply = http::send(SERVICE, client.post(&self.api).bearer_auth(&self.token).json(&json!({"query": query, "variables": variables}))).await?;
        match reply["errors"][0]["message"].as_str() {
            Some(message) => Err(format!("Railway: {}", message.chars().take(300).collect::<String>())),
            None => Ok(reply["data"].clone()),
        }
    }

    async fn list(&self) -> Result<Vec<Machine>> {
        let data = self.graphql("query($w: String) { projects(workspaceId: $w) { edges { node { id name } } } }", json!({"w": self.workspace})).await?;
        Ok(data["projects"]["edges"].as_array().into_iter().flatten().map(|e| &e["node"]).filter(|p| p["name"].as_str().is_some_and(|n| n.starts_with(PREFIX))).map(machine).collect())
    }

    async fn create(&self, name: &str) -> Result<Machine> {
        let project = self.graphql("mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id } } } } }",
            json!({"input": {"name": format!("{PREFIX}{name}"), "workspaceId": self.workspace}})).await?["projectCreate"].clone();
        let project_id = project["id"].as_str().ok_or("Railway did not report the new project.")?;
        let environment = project["environments"]["edges"][0]["node"]["id"].as_str().ok_or("Railway did not report the project's environment.")?;
        let service = self.graphql("mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }",
            json!({"input": {"projectId": project_id, "name": "sandbox", "source": {"image": IMAGE}}})).await?;
        let service = service["serviceCreate"]["id"].as_str().ok_or("Railway did not report the new service.")?;
        let ids = json!({"s": service, "e": environment, "input": {"startCommand": "sleep infinity"}});
        self.graphql("mutation($s: String!, $e: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $input) }", ids).await?;
        self.graphql("mutation($s: String!, $e: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e) }", json!({"s": service, "e": environment})).await?;
        Ok(machine(&project))
    }

    async fn power(&self, id: &str, action: &str) -> Result<()> {
        match action {
            "stop" | "delete" => self.graphql("mutation($id: String!) { projectDelete(id: $id) }", json!({"id": id})).await.map(|_| ()),
            _ => Err("Railway machines can only be deleted.".into()),
        }
    }
}

impl Sandbox for Railway {
    fn info(&self) -> Info {
        Info { persistent: false, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(Railway::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(Railway::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(Railway::power(self, native, action))
    }
    fn exec(&self, _native: &str, _command: &str, _timeout: Duration) -> Result<(Option<i32>, String)> {
        Err(NO_EXEC.into())
    }
    /// The container sleeps until deleted.
    fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
        Ok(())
    }
}

pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Railway::connected()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn railway(workspace: Option<&str>) -> (Railway, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            let query = body["query"].as_str().unwrap();
            let reply = if query.contains("projects(") {
                r#"{"data":{"projects":{"edges":[{"node":{"id":"p1","name":"pandacode-box"}},{"node":{"id":"p2","name":"my-app"}}]}}}"#
            } else if query.contains("projectCreate") {
                r#"{"data":{"projectCreate":{"id":"p3","name":"pandacode-new","environments":{"edges":[{"node":{"id":"e1"}}]}}}}"#
            } else if query.contains("serviceCreate") {
                r#"{"data":{"serviceCreate":{"id":"s1"}}}"#
            } else if query.contains("projectDelete") && body["variables"]["id"] == "gone" {
                r#"{"errors":[{"message":"Project not found"}],"data":null}"#
            } else {
                r#"{"data":{"ok":true}}"#
            };
            (200, reply)
        });
        (Railway { api: format!("{base}/graphql/v2"), token: "rw-token".into(), workspace: workspace.map(str::to_string) }, seen)
    }

    #[tokio::test]
    async fn lists_creates_and_deletes_pandacode_projects() {
        let (api, seen) = railway(Some("ws-1"));
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect::<Vec<_>>(), vec![("railway:p1", "box")]);
        assert_eq!(api.create("new").await.unwrap().id, "railway:p3");
        api.power("p3", "delete").await.unwrap();
        assert_eq!(api.power("gone", "delete").await.unwrap_err(), "Railway: Project not found");
        assert!(api.power("p3", "start").await.is_err());
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer rw-token")));
        let bodies: Vec<Value> = log.iter().map(|r| serde_json::from_str(&r.body).unwrap()).collect();
        assert_eq!(bodies[0]["variables"], json!({"w": "ws-1"}));
        assert_eq!(bodies[1]["variables"]["input"], json!({"name": "pandacode-new", "workspaceId": "ws-1"}));
        assert_eq!(bodies[2]["variables"]["input"], json!({"projectId": "p3", "name": "sandbox", "source": {"image": IMAGE}}));
        assert_eq!(bodies[3]["variables"], json!({"s": "s1", "e": "e1", "input": {"startCommand": "sleep infinity"}}));
        assert!(bodies[4]["query"].as_str().unwrap().contains("serviceInstanceDeployV2"));
    }

    #[test]
    fn exec_explains_why_railway_cannot_run_agents() {
        let (api, _) = railway(None);
        assert!(Sandbox::exec(&api, "p1", "ls", Duration::from_secs(5)).unwrap_err().contains("railway ssh"));
    }
}
