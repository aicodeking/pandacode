import type { Mode, ProviderId } from './types';
import { t } from './i18n.ts';

export interface ApprovalMode { id: Mode; label: string; description: string; icon: string; disabled?: boolean; }

const CLAUDE_FAMILY: ProviderId[] = ['claude', 'glm', 'mimo', 'alibaba'];

/** A mode's state tone (`--ds-tone-*`); Standard stays neutral. Harness labels differ, the risk class does not. */
export const MODE_TONES: Record<Mode, string> = { ask: '', auto: 'edit', review: 'edit', plan: 'plan', full: 'full' };
/** An icon's markup carrying a state tone, for a menu row's `leading`. */
export const toned = (svg: string, tone: string): string => tone ? svg.replace('<svg ', `<svg data-state-tone="${tone}" `) : svg;

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
    ? 'Devin’s Code mode: edits inside this project apply; commands it does not judge safe ask you.'
    : provider === 'cursor'
    ? 'Cursor’s Agent mode: edits apply; commands outside your Cursor allowlist ask you.'
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
    ? { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Explore and plan: reads and web lookups run; reading outside this project asks you; edits and commands are declined.') }
    : { id: 'plan', label: t('Plan mode'), icon: 'plan', description: t('Explore and plan changes before implementation.') }, full];
