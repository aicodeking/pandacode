/** JSON-only captured admission for a bot thread's header and welcome and a shared channel's conversation controls.
 * Pausing, settings, Stop, credentials, messages and drafts stay in main.ts, bot-thread.ts and bot-shared-channels.ts;
 * a package sees opaque bot, session and channel handles only. */
import { validateContract } from './contracts.ts';
import { BOT_THREAD_CONTROLS, BOT_CHANNEL_CONTROLS, BOT_CONVERSATION_PINNED, BOT_CONVERSATION_FIXED, BOT_CONVERSATION_PROTECTED, BOT_THREAD_LOCATION, BOT_CHANNEL_LOCATION, BOT_CONVERSATION_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured control ids (`botConversationControlId`). */
export const BOT_CONVERSATION_CONTROL_IDS = ['bot-pause', 'bot-settings', 'bot-suggest', 'channel-earlier', 'channel-continue', 'channel-reassign-open', 'channel-reassign', 'channel-settings'] as const;
export type BotConversationControl = typeof BOT_CONVERSATION_CONTROL_IDS[number];
export type BotConversationView = 'none' | 'bot-thread' | 'channel';
/** `bot`, `session` and `channel` are opaque handles of the open bot thread's bot and conversation or of the open shared
 * channel; never names, message text, the draft or settings. */
export type BotConversationPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; view: BotConversationView; project: string; bot: string; session: string; channel: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean;
  controls: readonly Readonly<{ id: string; controlId: BotConversationControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type BotConversationAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; bot: string; session: string; channel: string; revision: number; control: string; controlId: BotConversationControl; resource: string; requestId: string }>;
export type BotConversationAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type BotConversationAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Pausing or resuming a bot, opening bot or channel settings, putting a suggestion in the draft and running a stopped
 * message again (Continue, Reassign) change the user's bots, draft or work: each runs its original handler only after a
 * fresh host user choice. Showing earlier messages and opening the Reassign menu only reveal what the host draws. */
export const BOT_CONVERSATION_CHOICE_CONTROLS: readonly BotConversationControl[] = ['bot-pause', 'bot-settings', 'bot-suggest', 'channel-continue', 'channel-reassign', 'channel-settings'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check of the
 * request's shape. Stop, deletion, credentials, settings and membership changes, sending and the draft are the user's. */
export const BOT_CONVERSATION_PROTECTED_CONTROLS = ['bot-stop', 'channel-stop', 'bot-delete', 'bot-credentials', 'bot-settings-save', 'channel-settings-save', 'channel-membership', 'channel-delete', 'message-send', 'draft-write'] as const;

/** One explicit entry per gap this adapter owns (`src/bot-thread.ts`, `src/bot-shared-channels.ts`,
 * `panda.projections.bot-web`), with its public locations, the operations it supports and the reason for each it does not. */
export type BotConversationRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const reasons = (location: string) => [...new Set(Object.entries({ ...BOT_CONVERSATION_PINNED, ...BOT_CONVERSATION_FIXED }).filter(([id]) => id.startsWith(`${location}/`)).map(([id, why]) => `${id.slice(location.length + 1)}: ${why}`))].join(' ');
const protectedReason = (...ids: string[]) => BOT_CONVERSATION_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
export const BOT_CONVERSATION_REGISTRY: readonly BotConversationRegistryEntry[] = Object.freeze([
  { member: 'src/bot-thread.ts', source: 'src/bot-thread.ts', locations: ['panda.bot.thread.actions', BOT_THREAD_LOCATION, BOT_CONVERSATION_PROTECTED_LOCATION], controls: BOT_THREAD_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.bot.thread.actions', selection: 'bot', reason: `Contributed actions follow the bot's header and capture the bot, its conversation and the revision; the settings button and the welcome groups hide and the header buttons reorder. Pause, settings and a suggestion run their original handler after a fresh host choice. ${reasons(BOT_THREAD_LOCATION)} ${protectedReason('bot-identity', 'pause-change', 'credentials')}` },
  { member: 'src/bot-shared-channels.ts', source: 'src/bot-shared-channels.ts', locations: ['panda.bot.channel.actions', BOT_CHANNEL_LOCATION, BOT_CONVERSATION_PROTECTED_LOCATION], controls: BOT_CHANNEL_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.bot.channel.actions', selection: 'channel', reason: `Contributed actions follow the channel's name in the header and capture the channel and the revision; Reassign hides and reorders with Continue, the settings button hides in place. Continue, Reassign and settings run their original handler after a fresh host choice. ${reasons(BOT_CHANNEL_LOCATION)} ${protectedReason('stop', 'settings-change', 'messages')}` },
  { member: 'panda.projections.bot-web', source: 'src-tauri/src/bots.rs', locations: [BOT_CONVERSATION_PROTECTED_LOCATION], controls: [], order: false, hide: false, actions: false, context: 'panda.bot.conversation.protected', selection: 'none', reason: `No order, visibility or action: the projection is text only. ${protectedReason('web-projection')}` },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'bot', 'session', 'channel', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotBotConversation(props: BotConversationPresentation): BotConversationPresentation {
  if (!validateContract('botConversationPresentation', props).ok) throw Error('Invalid bot conversation presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate bot conversation handle');
  return freeze(structuredClone(props));
}
export function createBotConversationControls(props: BotConversationPresentation, owner: string, current: () => BotConversationPresentation, authority: () => BotConversationAuthority, dispatch: (action: BotConversationAction) => void, applied = new Set<string>()) {
  const captured = snapshotBotConversation(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): BotConversationAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((BOT_CONVERSATION_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('botConversationAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as BotConversationAction, live = current();
    // Another bot, conversation or channel, a paused bot, a refreshed channel or a redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open dialog, menu or a pending host choice keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (BOT_CONVERSATION_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
