//! Separate source-profile OpenCode generations. No installed probes or user config writes.
use std::{collections::BTreeMap, path::Path};
use serde_json::{json, Value};
use super::runtime_companion_lifetime::{self as lifetime, DirectoryResources, Evidence, InstalledApi, Manifest, Profile, Resources};
pub const V2_SOURCE: &str = "c5e741e787594e8c18fa70ab3a4705db1c927793";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Generation { V1, V2 }
pub fn profile(installed: &InstalledApi) -> Option<Profile> {
    if installed.harness != "opencode" { return None; }
    let version = installed.version.as_deref()?;
    let generation = match version { "v1.19.5" => "v1", V2_SOURCE => "v2", _ => return None };
    Some(Profile { id: format!("opencode.{generation}"), harness: "opencode".into(), versions: vec![version.into()], api: format!("opencode.plugin.{generation}"), protocol: 1, evidence: Evidence::SourceFeasible })
}
pub fn inline(generation: Generation, file_url: &str, previous: &str) -> Result<Value, &'static str> {
    let url = reqwest::Url::parse(file_url).map_err(|_| "InvalidShape")?;
    if url.scheme() != "file" || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() || url.host_str().is_some_and(|h| h != "localhost") { return Err("InvalidShape"); }
    if (generation == Generation::V2) != url.path().ends_with('/') { return Err("UnsupportedCapability"); }
    let mut config: Value = serde_json::from_str(previous).map_err(|_| "InvalidShape")?;
    if !config.is_object() { return Err("InvalidShape"); }
    if generation == Generation::V2 && config.get("plugin").is_some() { return Err("UnsupportedCapability"); }
    let key = if generation == Generation::V1 { "plugin" } else { "plugins" };
    let mut plugins = config.get(key).cloned().unwrap_or(json!([]));
    plugins.as_array_mut().ok_or("InvalidShape")?.push(if generation == Generation::V1 { json!(file_url) } else { json!({"package":file_url}) });
    config[key] = plugins; Ok(config)
}
/// Private host transport data must be supplied by an authenticated, run-bound endpoint owner.
/// This is not a permission grant and is never placed in a bundle/config/report.
pub struct Transport { pub endpoint: String, pub credential: String }
pub struct PluginResources { files: DirectoryResources, env: BTreeMap<String, String> }
impl Resources for PluginResources {
    fn environment(&self) -> BTreeMap<String, String> { self.env.clone() }
    fn close(&mut self) -> Result<(), String> { self.env.clear(); self.files.close() }
}
pub fn prepare(root: &Path, manifest: &Manifest, installed: &InstalledApi, pure: bool, previous: &str, transport: Option<&Transport>) -> Result<Box<dyn Resources>, String> {
    let profile = profile(installed).ok_or("UnsupportedCapability")?;
    if pure || manifest.profile != profile.id || lifetime::negotiate(installed, Some(&profile)).code.is_some() { return Err("UnsupportedCapability".into()); }
    let generation = if profile.id.ends_with("v1") { Generation::V1 } else { Generation::V2 };
    prepare_bundle(root, manifest, generation, "opencode", "OPENCODE_CONFIG_CONTENT", previous, transport)
}
/// Shared V1 delivery is also used by the separately negotiated Kilo adapter.
pub(super) fn prepare_bundle(root: &Path, manifest: &Manifest, generation: Generation, harness: &str, variable: &str, previous: &str, transport: Option<&Transport>) -> Result<Box<dyn Resources>, String> {
    let transport = transport.ok_or("UnsupportedCapability")?;
    let endpoint = reqwest::Url::parse(&transport.endpoint).map_err(|_| "InvalidShape")?;
    if endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1") || endpoint.path() != "/companion" || !endpoint.username().is_empty() || endpoint.password().is_some() || endpoint.query().is_some() || endpoint.fragment().is_some() || transport.credential.is_empty() || transport.credential.len() > 512 { return Err("InvalidShape".into()); }
    let entry = format!("{CORE}\n{}", if generation == Generation::V1 { V1_ENTRY } else { V2_ENTRY });
    let name = if generation == Generation::V1 { "companion.mjs" } else { "index.js" };
    let files = if generation == Generation::V1 { DirectoryResources::prepare(root, manifest, &[(name, entry.as_bytes())]) }
        else { DirectoryResources::prepare(root, manifest, &[(name, entry.as_bytes()), ("package.json", br#"{"name":"pandacode-companion","version":"1.0.0","private":true,"type":"module","main":"index.js","exports":"./index.js"}"#)]) }?;
    let mut env = files.environment();
    let descriptor = env.get("PANDACODE_COMPANION_MANIFEST").ok_or("HostUnavailable")?;
    let directory = Path::new(descriptor).parent().ok_or("HostUnavailable")?;
    let file_url = if generation == Generation::V1 { reqwest::Url::from_file_path(directory.join(name)) } else { reqwest::Url::from_directory_path(directory) }.map_err(|_| "InvalidShape")?;
    let config = inline(generation, file_url.as_str(), previous)?;
    env.insert(variable.into(), config.to_string());
    env.insert("PANDACODE_COMPANION_TRANSPORT".into(), json!({"protocol":1,"harness":harness,"lease":manifest.lease,"endpoint":transport.endpoint,"credential":transport.credential}).to_string());
    Ok(Box::new(PluginResources { files, env }))
}
/// Same forwarding core is embedded into both entry points. Errors never become approvals.
pub const CORE: &str = r#"const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
function replace(target,input){for(const key of Object.keys(target))delete target[key];for(const [key,value]of Object.entries(input))Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});}
function transport(){
 let config;try{config=JSON.parse(process.env.PANDACODE_COMPANION_TRANSPORT||'');}catch{}
 let closed=false;const pending=new Set();
 const send=async(event,input)=>{
  if(closed||!config||config.protocol!==1||!config.credential)return null;
  const abort=new AbortController();pending.add(abort);const timer=setTimeout(()=>abort.abort(),1500);
  try{
   const url=new URL(config.endpoint);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/companion'||url.username||url.password)throw 0;
   const body=JSON.stringify({protocol:1,harness:config.harness,lease:config.lease,event,input});if(Buffer.byteLength(body)>2*1024*1024)throw 0;
   const response=await fetch(url,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+config.credential,'content-type':'application/json'},body,signal:abort.signal});if(!response.ok)throw 0;
   const parts=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw 0;parts.push(chunk);}
   const answer=JSON.parse(Buffer.concat(parts).toString('utf8'));return !closed&&object(answer)?answer:null;
  }catch{return null;}finally{clearTimeout(timer);pending.delete(abort);}
 };
 return {send,close(){closed=true;config=null;for(const abort of pending)abort.abort();pending.clear();}};
}
async function before(send,input,args){const answer=await send('tool.before',{...input,tool_input:args});if(answer?.decision==='deny')throw Error(answer.reason||'Declined by an extension.');return answer?.decision==='rewrite'&&object(answer.input)?answer.input:null;}
"#;
pub const V1_ENTRY: &str = r#"export default async function(){const channel=transport();return {
 'tool.execute.before':async(input,output)=>{const args=await before(channel.send,input,output.args);if(args)replace(output.args,args);},
 'tool.execute.after':async(input,output)=>{const answer=await channel.send('tool.after',{...input,tool_response:output});if(object(answer?.output))for(const key of ['title','output','metadata'])if(Object.hasOwn(answer.output,key))output[key]=answer.output[key];},
 dispose:async()=>channel.close()
};}
"#;
pub const V2_ENTRY: &str = r#"import { Plugin } from '@opencode/plugin';
export default Plugin.define({id:'pandacode.companion',async setup(ctx){const channel=transport();
 ctx.tool.hook('execute.before',async event=>{const input=await before(channel.send,event,event.input);if(input)event.input=input;});
 ctx.tool.hook('execute.after',async event=>{const answer=await channel.send('tool.after',{...event,tool_response:event.result});if(event.status==='completed'&&object(answer?.output))event.result=answer.output;});
 ctx.permission.hook('evaluate',async event=>{if(event.effect==='deny')return;const answer=await channel.send('permission',event);if(answer?.decision==='deny'){event.effect='deny';event.message=answer.reason;}else if(answer?.decision==='approve')event.effect='allow';});
 return ()=>channel.close();
}});
"#;
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn generation_shapes_and_preserved_inline_values() {
        let v1 = inline(Generation::V1, "file:///C:/run/companion.mjs", r#"{"model":"kept","plugin":["existing"]}"#).unwrap();
        assert_eq!(v1["plugin"][0], "existing"); assert_eq!(v1["model"], "kept");
        assert!(inline(Generation::V2, "file:///C:/run/companion.mjs", "{}").is_err());
        assert_eq!(inline(Generation::V2, "file:///C:/run/companion/", "{}").unwrap()["plugins"][0]["package"], "file:///C:/run/companion/");
        assert!(profile(&InstalledApi { harness: "opencode".into(), version: Some("future".into()), apis: vec![] }).is_none());
    }
}
