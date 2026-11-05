# Settings

Settings is a full page with eight sections in the left column, opening on Recommended. A section with several pages shows them in a segmented control at the top of the content. Preferences save automatically. Every page can also be opened from the command palette: search its name, such as "providers" or "skills".

| Section | Pages |
| --- | --- |
| Recommended | Recommended |
| General | General |
| Appearance | Appearance |
| Agents | Harnesses, Providers, Agent teams, Model routing |
| Schedules | Schedules |
| Tools | Add-ons, Skills & rules |
| Connections | Cloud sandboxes, Remote access, GitHub |
| About | About |

**Recommended** is the page Settings opens on: the settings worth having, each saying whether it is set and opening the page that owns it. It changes nothing itself. Installing an agent, automatic updates, agent telemetry and model routing count toward its `N of N set` line; project checks, Connect and GitHub sit apart under When you need them, since they fit some work, not everyone's, and project checks run with your credentials. A status it cannot read shows nothing.

**General** holds text size, compact conversations, expanded tool activity, the quick launcher, the running agents widget (off until you turn it on) and your projects.

**Appearance** holds the theme, the Wallpapers switch (off by default: the thread shows a live sky), colors and imported VS Code themes, and wallpaper customization: separate live visibility and blur controls, the scene sets, and a fixed favorite.

**Agents → Harnesses** contains the default agent and model, agent updates, and compact installation status rows. Expand a harness to see its version and executable path. Refresh checks installations without resetting the selected tab, default agent control, or expanded details. Its Advanced fold holds harness privacy and OpenCode models.

**Agents → Harnesses → Project checks after turns** runs each task's checkout through its own fast check once a turn ends cleanly: the npm `test` script when package.json declares one, otherwise `cargo check` for a Rust checkout, with a two-minute limit. These are the project's own test or check commands, run with your own environment, so they can do anything running them in a terminal would. Tasks in plan mode or read-only are skipped, and a result that arrives after the task started running again, gained queued messages, had you send a message, or had the setting turned off is dropped. A check that cannot start (say, npm is missing) or finish in time is skipped, not reported as a failure, and nothing runs when the project declares no check. When the check fails and the setting is on, one fix-it message with the bounded failure output joins the task's message queue — visible and editable like any queued message — and the idle task starts on it. A repair turn's own failure waits for the user instead of looping; sending a message yourself restarts the repair budget. Teams, bot conversations and tasks with queued messages are not checked. The setting is off by default and kept per window.

**General → Quick launcher** enables the global overlay and changes its shortcut. The default is Command + Shift + Space on macOS (Control + Shift + Space elsewhere). Record a key combination or type one, then Save. PandaCode must remain running; clicking another app hides the overlay without stopping agents. Escape returns from a conversation to the active list, then hides the overlay on the next press. The lightweight overlay shows only currently active agents: running tasks, agents waiting for approval, coordinating architects, their workers, and provider subagents. Selecting an entry opens its streaming conversation inside the overlay, including worker and subagent responses. The back arrow returns to the list. Only the explicit **Open in app** button brings the full workspace forward; a conversation remains readable if its agent finishes while you are viewing it. Completed, idle, and stopped runs disappear automatically. The model button beside the project opens the same searchable harness/model picker as the workspace, with provider logos and discovered model names. An explicit overlay selection persists across restarts and workspace task changes. Until one is chosen, new work follows the workspace’s last harness/model/effort; permissions and project context continue to follow the workspace. Saved team workers are preserved, while an explicit overlay selection sets the architect for the new task only. Its project selector can change the launch project. Shortcut conflicts leave the previous binding intact.

**Agents → Providers** configures GLM Coding Plan and an optional executable location for each agent harness (GLM and MiMo use Claude Code's). Each provider is a card that opens to its settings. GLM requires Claude Code plus a Z.ai Coding Plan key; the saved key lives in PandaCode's 0600 `secrets.json` on macOS, the Secret Service on Linux and Credential Manager on Windows; you can also set `ZAI_API_KEY` in the application environment. OpenCode uses its own CLI login. Antigravity uses Google's official ACP server, or the `agy` CLI's `agy acp` server when the standalone server is not installed, and its sign-in. See [provider details](providers.md).

The **Claude Code** card reports inherited credential sources and checks the saved
Claude login. **Prefer saved Claude login** removes inherited API credentials and
provider routing overrides only from new Claude processes started by PandaCode.
Choose **Use current environment** to restore the default. Claude settings and
organization policies can still affect authentication; see
[Claude login details](providers.md#claude-login-and-environment-credentials).

**Agents → Agent teams** holds named teams and the classic Team setup switch. **Agents → Model routing** holds [Panda Router](model-routing.md) and the models teams may use.

**Schedules** lists every thread's [wake-ups and timed messages](schedules.md). **Tools → Add-ons** holds tools and integrations, Jev, and the [capabilities and cache](capabilities.md) fold. **Tools → Skills & rules** is the [skills library](skills-library.md). **Connections** holds [cloud sandboxes](cloud-agents.md), [remote access](remote-access.md) and GitHub. **About** holds the version, updates, resource usage and support details.

Section tabs move with the up and down arrows and page tabs with left and right; both support Home and End. The layout uses rem-based dimensions and stacks controls in narrow windows, including at 140–160% text size. System colors and reduced-motion preferences apply throughout.

The Settings module and styles load when opened, and each page mounts the first time it is shown, so Model routing and other pages make no calls until then. A closed fold mounts what it holds on its first opening. General uses local state immediately; harness discovery starts only when Harnesses is opened or refreshed. A delayed discovery response cannot replace a different dialog or discard wallpaper edits. Closing or replacing a settings view removes its event handlers and contents.
