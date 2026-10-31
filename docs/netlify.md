# Netlify deploys

Netlify is a deployment target, separate from the machines used for cloud agents.

1. Create a personal access token in [Netlify user settings](https://app.netlify.com/user/applications#personal-access-tokens). Authorize the intended team if it requires SSO.
2. Open Settings / Agents / Cloud sandboxes, choose Netlify and paste the token. Optionally enter the Project ID from Netlify's Project configuration / General / Project details. PandaCode checks access to that project, or the account when no project is selected, before saving.
3. Choose Deploy / Deploy to Netlify. The agent uses the linked or connected project, publishes a draft, verifies it, then publishes production. Every CLI call uses PandaCode's existing approval flow.

The token stays in the secure store and the CLI process environment; it is not placed in prompts or command-line arguments, and output is redacted. Netlify CLI telemetry is disabled for these runs. An installed CLI is used when available; otherwise PandaCode fetches the pinned `netlify-cli@27.14.2` with npx. Node.js is required.

Supported commands cover deploys, project listing/creation/linking, environment writes and help. Login, raw API commands, local execution, hosted agent runs and project deletion are unavailable. Disconnect removes PandaCode's saved token and project choice; it does not delete a Netlify project or revoke the token.

Build locally first, then deploy the generated output directory. PandaCode always adds `--no-build` before the remaining deploy arguments and refuses build-enabling flags, so the connected token is not passed to repository build scripts. Complete any framework-specific Netlify build steps before publishing. See the [Netlify deploy reference](https://cli.netlify.com/commands/deploy/).
