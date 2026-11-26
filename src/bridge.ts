import type { AgentEvent, BrowserElement, BrowserStatus, TerminalEvent } from './types';

/** Running inside the Tauri desktop window. */
export const nativeDesktop = '__TAURI_INTERNALS__' in window;
/** Served by PandaCode's built-in HTTP/WS server to a regular browser: live, same session. */
export const webMode = !nativeDesktop && typeof document !== 'undefined' && Boolean(document.querySelector('meta[name="pandacode-web"]'));
/** The Vite browser preview with sample data (neither desktop nor web server). */
export const preview = !nativeDesktop && !webMode;
/** One import, shared by every caller until it settles: boot fires dozens of IPC calls at once, and a dynamic
 * `import()` per call makes WebKit fetch the module again for each one that starts before the first resolves. A failed
 * import is forgotten, so the next call tries again instead of failing for the rest of the launch. */
function sharedImport<M>(load: () => Promise<M>): () => Promise<M> {
  let pending: Promise<M> | undefined;
  return () => pending ??= load().catch(error => { pending = undefined; throw error; });
}
const previewImport = sharedImport(() => import('./preview'));
const webImport = sharedImport(() => import('./web-bridge'));
const coreImport = sharedImport(() => import('@tauri-apps/api/core'));
const eventImport = sharedImport(() => import('@tauri-apps/api/event'));
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (preview) return (await previewImport()).invoke<T>(command, args);
  if (webMode) {
    const web = await webImport();
    // A link opens in this browser, not on the machine running PandaCode.
    if (command === 'open_external_url') { web.webOpenExternalUrl(String(args.url ?? '')); return undefined as T; }
    return web.webInvoke<T>(command, args);
  }
  return (await coreImport()).invoke<T>(command, args);
}
export async function subscribe(name: 'voice-event', callback: (event: import('./voice-types').VoiceEvent) => void): Promise<() => void>;
export async function subscribe(name: 'voice://local-model', callback: (event: import('./voice-types').VoiceLocalModelEvent) => void): Promise<() => void>;
export async function subscribe(name: 'voice://mic-test-level', callback: (event: import('./voice-types').VoiceMicLevelEvent) => void): Promise<() => void>;
export async function subscribe(name: 'voice://test-ended', callback: (event: import('./voice-types').VoiceTestEnded) => void): Promise<() => void>;
export async function subscribe(name: 'voice://transcript', callback: (event: import('./voice-types').VoiceClosedTranscript) => void): Promise<() => void>;
export async function subscribe(name: 'agent-update-progress', callback: (event: import('./agent-updates').AgentUpdateProgress) => void): Promise<() => void>;
export async function subscribe(name: 'jev-run', callback: (event: import('./jev').JevReport) => void): Promise<() => void>;
export async function subscribe(name: 'jev-frame', callback: (event: import('./jev-live').JevFrame) => void): Promise<() => void>;
export async function subscribe(name: 'jev-install', callback: (event: { status: string; message: string }) => void): Promise<() => void>;
export async function subscribe(name: 'sessions-changed', callback: () => void): Promise<() => void>;
/** A deliberate exit is committed (no payload); the page may not see pagehide. */
export async function subscribe(name: 'app-quitting', callback: () => void): Promise<() => void>;
export async function subscribe(name: 'queue-changed', callback: (event: { sessionId: string; held?: boolean; reason?: string }) => void): Promise<() => void>;
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
export async function subscribe(name: 'moodboards-changed', callback: (event: { projectId: string; boardId: string }) => void): Promise<() => void>;
export async function subscribe(name: 'web-server-changed', callback: (event: any) => void): Promise<() => void>;
export async function subscribe(name: string, callback: (event: any) => void): Promise<() => void> {
  if (preview) return (await previewImport()).listen(name, callback);
  if (webMode) return (await webImport()).webListen(name, callback);
  return (await eventImport()).listen(name, event => callback(event.payload));
}
export async function chooseFolder(title = 'Open a project in PandaCode'): Promise<string | null> {
  if (preview) return '/Users/you/Projects/new-project';
  if (webMode) return (await import('./web-bridge')).webChooseFolder(title);
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ directory: true, multiple: false, title });
  return typeof result === 'string' ? result : null;
}
/** Files to attach to a message. The preview returns a fixed sample selection. */
export async function chooseAttachments(): Promise<string[]> {
  if (preview) return (await previewImport()).samplePick('files');
  if (webMode) return (await webImport()).webChoosePaths('Attach files to your message', true);
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ multiple: true, title: 'Attach to your message', filters: [
    { name: 'Images and documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'rtf', 'doc', 'docx', 'odt', 'pages', 'key', 'numbers', 'pptx', 'xlsx', 'epub', 'log'] },
    { name: 'All files', extensions: ['*'] },
  ] });
  return Array.isArray(result) ? result : typeof result === 'string' ? [result] : [];
}
/** A VS Code extension package holding color themes. */
export async function chooseVsix(): Promise<string | null> {
  if (preview) return '/Users/you/Downloads/tokyo-night.vsix';
  if (webMode) return (await import('./web-bridge')).webChoosePath('Import a VS Code theme (.vsix)', '/path/to/theme.vsix');
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ multiple: false, title: 'Import a VS Code theme', filters: [{ name: 'VS Code extension', extensions: ['vsix'] }] });
  return typeof result === 'string' ? result : null;
}
export async function chooseAttachmentFolder(): Promise<string | null> {
  if (preview) return (await previewImport()).samplePick('folder')[0] ?? null;
  if (webMode) return (await webImport()).webChooseFolder('Attach a folder to your message');
  const result = await (await import('@tauri-apps/plugin-dialog')).open({ directory: true, multiple: false, title: 'Attach a folder to your message' });
  return typeof result === 'string' ? result : null;
}
