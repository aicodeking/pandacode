import type { AgentEvent, BrowserElement, BrowserStatus, TerminalEvent } from './types';

export const preview = !('__TAURI_INTERNALS__' in window);
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (preview) return (await import('./preview')).invoke<T>(command, args);
  return (await import('@tauri-apps/api/core')).invoke<T>(command, args);
}
export async function subscribe(name: 'agent-update-progress', callback: (event: import('./agent-updates').AgentUpdateProgress) => void): Promise<() => void>;
export async function subscribe(name: 'jev-run', callback: (event: import('./jev').JevReport) => void): Promise<() => void>;
export async function subscribe(name: 'jev-frame', callback: (event: import('./jev-live').JevFrame) => void): Promise<() => void>;
export async function subscribe(name: 'jev-install', callback: (event: { status: string; message: string }) => void): Promise<() => void>;
export async function subscribe(name: 'sessions-changed', callback: () => void): Promise<() => void>;
export async function subscribe(name: 'queue-changed', callback: (event: { sessionId: string }) => void): Promise<() => void>;
export async function subscribe(name: 'schedules-changed', callback: (event: { sessionId: string | null }) => void): Promise<() => void>;
export async function subscribe(name: 'bots-changed', callback: () => void): Promise<() => void>;
export async function subscribe(name: 'bot-shared-channel-changed', callback: (event: { channelId: string }) => void): Promise<() => void>;
export async function subscribe(name: 'bot-messages-changed', callback: (event: { sessionId?: string }) => void): Promise<() => void>;
export async function subscribe(name: 'bot-notification', callback: (event: { botId: string; text: string }) => void): Promise<() => void>;
export async function subscribe(name: 'bot-failover', callback: (event: import('./bots').FailoverAsk) => void): Promise<() => void>;
export async function subscribe(name: 'bot-model-switch', callback: (event: { botId: string; at: number; text: string; detail: Record<string, unknown> }) => void): Promise<() => void>;
export async function subscribe(name: 'bot-pairing', callback: (event: { botId: string; channelId: string; senderName: string; code: string }) => void): Promise<() => void>;
export async function subscribe(name: 'sessions-deleted', callback: (event: {sessionIds: string[]}) => void): Promise<() => void>;
export async function subscribe(name: 'provider-models-changed', callback: (event: {provider: import('./types').ProviderId}) => void): Promise<() => void>;
export async function subscribe(name: 'overlay-open-task', callback: (event: { sessionId: string; workerId?: string; workerSessionId?: string; subagentId?: string }) => void): Promise<() => void>;
export async function subscribe(name: 'architect-event', callback: (event: import('./architect-types').TeamEvent) => void): Promise<() => void>;
export async function subscribe(name: 'agent-ui-action', callback: (event: import('./agent-ui-actions').AgentUiAction) => void): Promise<() => void>;
export async function subscribe(name: 'android-setup', callback: (event: import('./simulator').AndroidSetup) => void): Promise<() => void>;
export async function subscribe(name: 'cloud-setup', callback: (event: { provider: string; label: string }) => void): Promise<() => void>;
export async function subscribe(name: 'vm-changed', callback: (event: { show?: boolean } | string[] | null) => void): Promise<() => void>;
export async function subscribe(name: 'simulator-changed', callback: (event: { udid: string; show: boolean }) => void): Promise<() => void>;
export async function subscribe(name: 'remote://status', callback: (event: import('./remote-types').RemoteStatus) => void): Promise<() => void>;
export async function subscribe(name: 'remote://presence', callback: (event: import('./remote-types').RemoteDevice[]) => void): Promise<() => void>;
export async function subscribe(name: 'agent-event', callback: (event: AgentEvent) => void): Promise<() => void>;
export async function subscribe(name: 'terminal-event', callback: (event: TerminalEvent) => void): Promise<() => void>;
export async function subscribe(name: 'browser-state', callback: (event: BrowserStatus) => void): Promise<() => void>;
export async function subscribe(name: 'browser-element', callback: (event: BrowserElement) => void): Promise<() => void>;
export async function subscribe(name: string, callback: (event: any) => void): Promise<() => void> {
  if (preview) return (await import('./preview')).listen(name, callback);
  return (await import('@tauri-apps/api/event')).listen(name, event => callback(event.payload));
}
export async function chooseFolder(title = 'Open a project in PandaCode'): Promise<string | null> {
  if (preview) return '/Users/you/Projects/new-project';
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ directory: true, multiple: false, title });
  return typeof result === 'string' ? result : null;
}
/** Files to attach to a message. The preview returns a fixed sample selection. */
export async function chooseAttachments(): Promise<string[]> {
  if (preview) return (await import('./preview')).samplePick('files');
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ multiple: true, title: 'Attach to your message', filters: [
    { name: 'Images and documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'rtf', 'doc', 'docx', 'odt', 'pages', 'key', 'numbers', 'pptx', 'xlsx', 'epub', 'log'] },
    { name: 'All files', extensions: ['*'] },
  ] });
  return Array.isArray(result) ? result : typeof result === 'string' ? [result] : [];
}
/** A VS Code extension package holding color themes. */
export async function chooseVsix(): Promise<string | null> {
  if (preview) return '/Users/you/Downloads/tokyo-night.vsix';
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ multiple: false, title: 'Import a VS Code theme', filters: [{ name: 'VS Code extension', extensions: ['vsix'] }] });
  return typeof result === 'string' ? result : null;
}
export async function chooseAttachmentFolder(): Promise<string | null> {
  if (preview) return (await import('./preview')).samplePick('folder')[0] ?? null;
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ directory: true, multiple: false, title: 'Attach a folder to your message' });
  return typeof result === 'string' ? result : null;
}
