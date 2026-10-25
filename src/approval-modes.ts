import type { Mode, ProviderId } from './types';
import { t } from './i18n.ts';

export interface ApprovalMode { id: Mode; label: string; description: string; icon: string; disabled?: boolean; }

const CLAUDE_FAMILY: ProviderId[] = ['claude', 'glm', 'mimo'];

/** Labels describe the native policy for each harness, not a simulated approval layer. */
export function approvalModes(provider: ProviderId, current?: Mode): ApprovalMode[] {
  // omp is a Pi fork driven through the same bridge, so it shares Pi's policy.
  const pi = provider === 'pi' || provider === 'omp' ? (provider === 'omp' ? 'omp' : 'Pi') : '';
  const standard: ApprovalMode = { id: 'ask', label: t('Standard'), icon: 'check', description: provider === 'codex'
    ? t('Work in this project. Ask you when an action needs extra permission.')
    : provider === 'github-copilot'
    ? t('Use Copilot Agent mode with Allow All off. PandaCode asks before permission requests.')
    : provider === 'grok'
    ? t('Grok asks before edits and commands, whatever its own config says.')
    : provider === 'devin'
    ? t('Devin’s Code mode: edits inside this project apply; commands it does not judge safe ask you.')
    : pi
    ? t`${pi} runs without its own approvals; PandaCode asks before edits, commands and other non-read tools.`
    : provider === 'deepseek'
    ? t('DeepSeek edits and runs commands inside this project freely; it asks you before going outside it.')
    : provider === 'cline'
    ? t('Cline acts; reads and searches run, PandaCode asks before edits, commands and other tools.')
    : provider === 'kilo'
    ? t('Kilo runs read-only tools; PandaCode asks before edits, commands and other tools.')
    : provider === 'muse'
    ? t('Muse asks before actions its rules do not allow. Its own reviewer may approve low-risk ones.')
    : provider === 'zcode'
    ? t('ZCode’s build mode: it works in this project and asks you when an action needs permission.')
    : provider === 'hermes'
    ? t('Hermes works in this project. Asks you before terminal commands or dangerous actions.')
    ? t('Use the harness’s normal rules. Ask you when approval is needed.') };
  const full: ApprovalMode = { id: 'full', label: t('Full access'), icon: 'unlock', description: provider === 'antigravity'
    ? t('Automatically approve permission requests. Server restrictions still apply.')
    : provider === 'codex'
    ? t('Skip approval prompts and sandbox limits. Allow file and network access.')
    : provider === 'grok'
    ? t('Always approve: Grok runs every tool without asking (its --always-approve).')
    : pi
    ? t`${pi} runs every tool without asking.`
    : provider === 'deepseek'
    ? t('No sandbox: DeepSeek runs every tool without asking.')
    : provider === 'cline'
    ? t('Cline acts with its auto-approve on: every tool runs without asking.')
    : provider === 'muse'
    ? t('No approvals and no sandbox: Muse runs every tool without asking.')
    : provider === 'devin'
    ? t('Devin’s Bypass Permissions mode: every tool runs without asking, unless your organization requires approval.')
    : provider === 'hermes'
    ? t('Skip approval prompts: Hermes runs every tool without asking (equivalent to its --yolo).')
    : provider === 'github-copilot'
    ? t('Use Copilot Agent mode with Allow All on. Copilot automatically approves tool, path, and URL requests.')
    : provider === 'zcode'
    ? t('Always approve: ZCode runs every tool without asking (its yolo mode).')
    ? t('Run tools without approval prompts, including outside this project.') };
  // Agent-reviewed approvals, as bots offer. Codex's own is its Approve for me (`auto`).
  const review: ApprovalMode[] = CLAUDE_FAMILY.includes(provider)
    ? [{ id: 'review', label: t('Approve for me'), icon: 'spark', description: t('Claude Code’s auto mode: its safety reviewer approves routine actions and blocks risky ones. Needs a recent Claude Code.') }]
    // A task switched here keeps its mode; show why it cannot run rather than another policy.
    : current !== 'review' ? []
    : [{ id: 'review', label: t('Approve for me'), icon: 'spark', disabled: true, description: t('This harness has no agent-reviewed approvals. Choose another mode, or use Claude Code (or Codex’s Approve for me).') }];
  if (provider === 'github-copilot') return [standard,
    { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Use Copilot Plan mode. Read, search, fetch, and think requests are allowed; other permission requests are declined.') },
    ...review, full];
  // Devin's Code mode already accepts edits, so it has no separate Accept edits choice.
  if (provider === 'devin') return [standard,
    { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Devin’s Plan mode: it investigates and writes a plan; commands ask you, and edits wait until you approve the plan.') },
    ...review, full];
  return [standard, provider === 'muse'
    ? { id: 'auto', label: t('Accept edits'), icon: 'edit', description: t('Work freely inside the sandbox. Muse asks only to leave it.') }
    : provider === 'deepseek'
    ? { id: 'auto', label: t('Accept edits'), icon: 'edit', description: t('Like Standard, and edits outside this project are approved too. Other actions still ask.') }
    : ['claude', 'glm', 'mimo', 'opencode', 'grok', 'pi', 'omp', 'commandcode', 'cline', 'kilo', 'zcode', 'hermes'].includes(provider)
    ? { id: 'auto', label: t('Accept edits'), icon: 'edit', description: t('Allow file edits automatically. Other actions may still ask you.') }
    : provider === 'kimi'
    ? { id: 'auto', label: t('Ask when needed'), icon: 'spark', description: t('Allow routine tools automatically. Ask you about sensitive actions.') }
    : provider === 'codex' ? { id: 'auto', label: t('Approve for me'), icon: 'spark', description: t('Let Codex review approval requests. Keep the workspace sandbox.') }
    : { id: 'auto', label: t('Accept edits'), icon: 'edit', description: t('Automatically approve edit requests offered by the server.') },
  ...review,
  provider === 'codex'
    ? { id: 'plan', label: t('Read only'), icon: 'plan', description: t('Inspect the project. Block writes and permission escalation.') }
    : provider === 'grok'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Read-only: Grok investigates and proposes a plan; edits and commands are declined.') }
    : pi
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t`Read-only: ${pi} may use read-only tools; everything else is declined.` }
    : provider === 'deepseek'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Read-only sandbox: DeepSeek cannot write files and proposes a plan; requests to escalate are declined.') }
    : provider === 'cline'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Cline’s Plan mode: it explores, fetches and proposes a plan; file edits are declined, commands still ask.') }
    : provider === 'kilo'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Read-only: Kilo investigates and plans; edits, commands and other state-changing tools are declined.') }
    : provider === 'muse'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Read-only: Muse cannot write files or run shell commands, and proposes a plan.') }
    : provider === 'commandcode'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Read-only: Command Code researches and plans; edits and commands are declined.') }
    : provider === 'zcode'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('ZCode’s plan mode: it investigates and proposes a plan; implementation waits for your approval.') }
    : provider === 'hermes'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Read-only: Hermes researches and proposes a plan; edits and commands are declined.') }
    : CLAUDE_FAMILY.includes(provider)
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Explore and plan: reads and web lookups run, even outside this project; edits wait for implementation and commands ask you.') }
    : provider === 'opencode'
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Explore and plan: reads and web lookups run; reading outside this project asks you; edits and commands are declined.') }
    : { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Explore and plan changes before implementation.') }, full];
}

export function approvalMode(provider: ProviderId, mode: Mode): ApprovalMode {
  const modes = approvalModes(provider, mode);
  return modes.find(item => item.id === mode) ?? modes[0];
}
