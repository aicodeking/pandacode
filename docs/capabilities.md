# Capability and cache alignment

This read-only inventory is designed for Settings → Tools & add-ons. It lists sanitized slash-command metadata, MCP server names and executable basenames, Claude hook event names and enabled plugin names, and names of discovered skill directories. It does not activate integrations or return hook bodies, arguments, environment values, credentials, prompt content, absolute config paths, or plugin files.

The matrix compares capabilities across installed harnesses. It marks a slash command native when the existing command catalog reports kind native; other discovered entries are marked discovered; absent entries are marked missing. Claude-family MCP config is read from the user Claude config and, when a task ID is supplied, that task's project .mcp.json. Codex MCP config is read from CODEX_HOME/config.toml or ~/.codex/config.toml. OpenCode config is read from ~/.config/opencode/opencode.json, ~/.opencode/opencode.json, and project opencode.json. Kimi config is read from ~/.kimi-code/config.toml, ~/.kimi/config.toml, and project equivalents. Skills are listed by directory name only. Skill roots share the skill manager’s resolved config homes, including XDG homes for OpenCode and Devin. Configured skill sources use `~/…` under the home directory and account labels elsewhere; absolute configured paths are never returned.

Cache alignment derives PandaCode's stable-instruction delivery from providers::takes_system_instructions. Claude, GLM, MiMo, Pi and Oh My Pi receive the fixed instructions in the appended system prompt; other harnesses receive them through message injection. Only cache read and creation counts already parsed into the local usage-ledger cache are shown, for Claude and Codex. Values are labeled observed; no estimates are produced. If matching persisted records are absent, the panel says not exposed. The inventory does not inspect cache invalidation reasons.

Native unit fixtures use explicit temporary HOME and project roots. They cover safe config parsing, secret omission, directory-only skills, task-scoped cache totals, and instruction-delivery states.

## Wiring

The following host files are outside this worker's ownership scope. Apply these exact hunks to register the commands and show the panel.

src-tauri/src/lib.rs:

    @@
     mod cloud;
    +mod capabilities;
     mod vsix_themes;

    @@
                 agent_usage::agent_usage,
                 usage_ledger::usage_ledger,
    +            capabilities::capabilities_inventory,
    +            capabilities::cache_alignment,
                 prompt_activity,

src/settings.ts:

    @@
     import './settings.css';
    +import { call } from './bridge';
    +import { mount as mountCapabilities } from './capabilities-panel';

    @@ case 'tools'
             <div class="setting-row"><div><strong>Jev · Optional add-on</strong><small>Browser tests and decision assistance. Your agents work without it.</small></div><button type="button" class="secondary-button" data-action="jev-settings">Set up Jev</button></div>
    -      </div>`;
    +      </div>
    +      <div id="capabilities-settings"></div>`;

    @@ function mountSection
         if (id === 'cloud' && options.cloud) cleanups.push(mountCloudSettings(panel.querySelector<HTMLElement>('#cloud-settings')!, options.cloud));
    +    if (id === 'tools') cleanups.push(mountCapabilities(panel.querySelector<HTMLElement>('#capabilities-settings')!, call));

src/preview.ts:

    @@
     import { invokeRemote } from './preview-remote';
    +import { previewCapabilities } from './preview-capabilities';

    @@ before the command switch
    +  if (command === 'capabilities_inventory' || command === 'cache_alignment') return previewCapabilities(command) as T;
       let result: unknown;
       switch (command) {

playwright.config.ts:

    Replace the opening line:
    -export default defineConfig({
    +const config = {

    Replace the final line, leaving the current testMatch array unchanged:
    -});
    +};
    +config.testMatch.push('**/capabilities.spec.ts');
    +export default defineConfig(config);

The preview module is sample-only. The capability Playwright spec expects the Tools & add-ons integration and becomes discoverable after the testMatch hunk is applied.

