import type { AgentEvent, Message, Provider, ProviderId, ProviderModel, Session, SubagentActivity } from './types';
/** The launcher has its own tiny bridge and never imports the workspace preview. */
export interface LaunchContext { projectId: string | null; provider: string; model: string; mode: string; reasoningEffort?: string | null }
export interface OverlayPreferences { enabled: boolean; shortcut: string; context: LaunchContext; error: string | null; modelSelection?: {provider:string;model:string;reasoningEffort?:string|null} | null }
export interface OverlayTask { id: string; sessionId: string; kind: 'task' | 'worker' | 'subagent'; title: string; projectId: string; projectName: string; provider: string; status: string; updatedAt: number; parentTitle?: string | null; parentSessionId?: string | null; workerId?: string | null; subagentId?: string | null }
export interface OverlaySnapshot { tasks: OverlayTask[]; projects: {id: string; name: string; path: string}[]; context: LaunchContext; activeCount: number; teamWorkerCount?: number }
export interface OverlayThread { messages: Message[]; hasOlder: boolean; liveText: string; status: string; provider?: ProviderId; subagent?: SubagentActivity | null; historyVersion?: number; historyUnchanged?: boolean }
export const nativeOverlay = '__TAURI_INTERNALS__' in window;
const initial: OverlayPreferences = { enabled: true, shortcut: 'CommandOrControl+Shift+Space', context: {projectId: 'preview-project', provider: 'codex', model: 'default', mode: 'full'}, error: null };
let previewPreferences = initial;
try { previewPreferences = JSON.parse(localStorage.getItem('pandacode.overlay-preview') || 'null') || initial; } catch { /* Preview storage is optional. */ }
function effectiveContext(): LaunchContext { return {...previewPreferences.context,...previewPreferences.modelSelection,mode:previewPreferences.context.mode ?? 'full'}; }
// Preview fixtures only. Native catalogs come from the installed harnesses.
const previewCatalogs: Record<ProviderId, ProviderModel[]> = {
  kilo:[{id:'kilo/anthropic/claude-sonnet-4.6',name:'Kilo Gateway/Anthropic: Claude Sonnet 4.6',description:'Sample Kilo model.'}],
  pi:[{id:'anthropic/claude-sonnet-4-5',name:'Claude Sonnet 4.5',description:'Sample Pi model.'}],
  codex:[{id:'gpt-6-astra',name:'GPT-6-Astra',description:'Sample Codex model metadata.'},{id:'gpt-5.6-sol',name:'GPT-5.6-Sol',description:'Sample Codex model metadata.'}],
  claude:[{id:'sonnet',name:'Claude Sonnet 5',description:'Sample Claude Code model metadata.',contextWindow:200000},{id:'opus',name:'Claude Opus 5',description:'Sample Claude Code model metadata.'}],
  kimi:[{id:'kimi-code/k3',name:'K3',description:'Sample configured Kimi model.'}],
  opencode:[{id:'opencode/big-pickle',name:'Big Pickle',description:'Sample OpenCode model metadata.'}],
  glm:[{id:'glm-5.3',name:'GLM-5.3',description:'Sample Z.ai model metadata.'}],
  antigravity:[],
  grok:[{id:'grok-4.7',name:'Grok 4.7',description:'Sample Grok Build model.'}],
  mimo:[{id:'mimo-v2.6-pro',name:'MiMo-V2.6-Pro',description:'Sample MiMo Token Plan model.'}],
  deepseek:[{id:'deepseek-v4-flash',name:'DeepSeek V4 Flash',description:'Sample DeepSeek model.'}],
  commandcode:[{id:'claude-sonnet-5-5',name:'Claude Sonnet 5.5',description:'Sample Command Code model.'}],
  cline:[{id:'anthropic/claude-sonnet-5.5',name:'Claude Sonnet 5.5',description:'Sample Cline model.'}],
  omp:[{id:'anthropic/claude-sonnet-4-5',name:'Claude Sonnet 4.5',description:'Sample omp model.'}],
  'github-copilot':[{id:'default',name:'Default',description:'Use the model configured in GitHub Copilot CLI.'}],
  muse:[{id:'muse-spark-1.3',name:'muse-spark-1.3',description:'Sample Muse Code model.'}],
};
const previewProviders: Provider[] = (Object.entries({codex:'Codex',claude:'Claude Code',kimi:'Kimi Code',opencode:'OpenCode',glm:'GLM Coding Plan',antigravity:'Antigravity',grok:'Grok Build',mimo:'MiMo Token Plan',pi:'Pi',deepseek:'DeepSeek',commandcode:'Command Code',cline:'Cline',kilo:'Kilo Code',omp:'Oh My Pi','github-copilot':'GitHub Copilot CLI',muse:'Muse Code'}) as [ProviderId,string][]).map(([id,name]) => ({id,name,installed:id !== 'antigravity',path:id === 'antigravity' ? null : `/sample/bin/${id === 'github-copilot' ? 'copilot' : id === 'commandcode' ? 'command-code' : id}`,version:'Sample provider',models:[]}));
const tasks: OverlayTask[] = [
  {id:'preview-active', sessionId:'preview-active', kind:'task', title:'Polish the new onboarding', projectId:'preview-project', projectName:'PandaCode', provider:'codex', status:'running', updatedAt:Date.now()},
  {id:'preview-approval', sessionId:'preview-approval', kind:'task', title:'Build a responsive gallery', projectId:'preview-project', projectName:'PandaCode', provider:'claude', status:'waiting', updatedAt:Date.now()},
  {id:'preview-worker', sessionId:'preview-worker', kind:'worker', title:'Build search indexing', parentTitle:'Polish the new onboarding', parentSessionId:'preview-active', workerId:'worker-indexing', projectId:'preview-project', projectName:'PandaCode', provider:'opencode', status:'running', updatedAt:Date.now()},
  {id:'preview-subagent', sessionId:'preview-active', kind:'subagent', subagentId:'preview-child', title:'Audit accessibility', parentTitle:'Polish the new onboarding', projectId:'preview-project', projectName:'PandaCode', provider:'codex', status:'running', updatedAt:Date.now()},
  {id:'preview-recent', sessionId:'preview-recent', kind:'task', title:'Review the API changes', projectId:'preview-project', projectName:'PandaCode', provider:'kimi', status:'idle', updatedAt:Date.now()},
];
const threads = new Map<string, OverlayThread>();
function previewThread(sessionId: string, subagentId?: string): OverlayThread {
  const key = `${sessionId}:${subagentId || ''}`;
  let thread = threads.get(key);
  if (!thread) {
    const task = tasks.find(task => task.sessionId === sessionId && (task.subagentId || '') === (subagentId || ''));
    if (!task) throw new Error('This task is no longer available.');
    const response = subagentId ? 'I’m checking keyboard navigation and contrast across the onboarding screens.' : task.kind === 'worker' ? 'I’ve built the search index. Now I’m verifying that results stay fast as the project grows.' : task.status === 'waiting' ? 'The gallery is ready. I’m waiting for approval before running the next command.' : 'I’m refining the onboarding flow, starting with the welcome screen and keyboard navigation.';
    thread = {messages:[{id:1, sessionId, role:'user', content:task.title, createdAt:Date.now()-30_000}], hasOlder:false, liveText:subagentId ? '' : response, status:task.status,
      ...(subagentId ? {subagent:{id:subagentId,parentId:null,name:task.title,prompt:'Review the onboarding for accessibility.',status:'running',response,tools:[],startedAt:Date.now()-30_000,updatedAt:Date.now()}} : {})};
    threads.set(key, thread);
  }
  return thread;
}
/** Subscribe without pulling the full workspace or its preview into the launcher. */
export async function overlayEvents(callback: (event: AgentEvent) => void): Promise<() => void> {
  if (nativeOverlay) return (await import('@tauri-apps/api/event')).listen<AgentEvent>('agent-event', event => callback(event.payload));
  const receive = (event: Event) => callback((event as CustomEvent<AgentEvent>).detail);
  window.addEventListener('pandacode-overlay-agent-event', receive);
  return () => window.removeEventListener('pandacode-overlay-agent-event', receive);
}
export async function overlayCall<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (nativeOverlay) return (await import('@tauri-apps/api/core')).invoke<T>(command, args);
  const save = () => { try { localStorage.setItem('pandacode.overlay-preview', JSON.stringify(previewPreferences)); } catch { /* Preview only. */ } };
  if (command === 'overlay_preferences') return structuredClone(previewPreferences) as T;
  if (command === 'overlay_save_preferences') {
    const shortcut = String(args.shortcut);
    if (!/^(?:(?:CommandOrControl|Command|Control|Alt|Option|Shift|Super|Meta)\+)+(?:Space|Key[A-Z]|[A-Z]|Digit\d|F\d{1,2}|Arrow(?:Up|Down|Left|Right))$/i.test(shortcut)) throw new Error('Use a shortcut such as CommandOrControl+Shift+Space.');
    previewPreferences = {...previewPreferences, enabled:Boolean(args.enabled), shortcut, error:null}; save(); return structuredClone(previewPreferences) as T;
  }
  if (command === 'overlay_sync_context') { previewPreferences.context = args.context as LaunchContext; save(); return undefined as T; }
  if (command === 'list_providers') return structuredClone(previewProviders) as T;
  if (command === 'list_provider_models') return structuredClone(args.provider === 'opencode' ? (await import('./preview-opencode')).previewOpenCodeChoices() : previewCatalogs[args.provider as ProviderId] || []) as T;
  if (command === 'overlay_select_model') {
    if (!previewProviders.some(provider => provider.id === args.provider) || typeof args.model !== 'string' || !args.model.trim() || args.model.length > 256) throw new Error('Invalid harness or model.');
    previewPreferences.modelSelection = {provider:String(args.provider),model:args.model,reasoningEffort:args.reasoningEffort as string | null ?? null};
    save(); return effectiveContext() as T;
  }
  if (command === 'overlay_recording') return undefined as T;
  if (command === 'search_files') {
    const query = String(args.query ?? '').toLocaleLowerCase();
    return ['README.md','package.json','src/main.ts','src/overlay.ts','docs/quick start.md']
      .filter(path => path.toLocaleLowerCase().includes(query))
      .slice(0, Math.max(1, Math.min(Number(args.limit) || 30, 100)))
      .map(path => ({name:path.split('/').pop()!, path, isDir:false})) as T;
  }
  if (command === 'overlay_snapshot') return { tasks, projects:[{id:'preview-project',name:'PandaCode',path:'/Projects/PandaCode'}], context:effectiveContext(), activeCount:tasks.filter(t => ['running','waiting','coordinating'].includes(t.status)).length } as T;
  if (command === 'overlay_thread') return previewThread(String(args.sessionId), args.subagentId as string | undefined) as T;
  if (command === 'get_message_content') {
    const message = previewThread(String(args.sessionId)).messages.find(message => message.id === args.messageId && ['user','assistant'].includes(message.role));
    if (!message) throw new Error('This message is no longer available.');
    return message.content as T;
  }
  if (command === 'fork_session_at_message') {
    const source = tasks.find(task => task.sessionId === args.sessionId && !task.subagentId);
    if (!source) throw new Error('This task is no longer available.');
    const history = previewThread(source.sessionId).messages;
    const boundary = history.findIndex(message => message.id === args.messageId && ['user','assistant'].includes(message.role));
    if (boundary < 0) throw new Error('Choose a saved message to fork from.');
    const id = crypto.randomUUID(), now = Date.now();
    const fork: Session = {id,projectId:source.projectId,worktreePath:null,title:`${source.title} (fork)`,provider:source.provider as ProviderId,model:'default',mode:'ask',status:'idle',createdAt:now,updatedAt:now,lastResponseAt:null,archived:false,resumeId:null,taskStage:'in_progress',taskDescription:'',completedAt:null};
    tasks.unshift({id,sessionId:id,kind:'task',title:fork.title,projectId:fork.projectId,projectName:source.projectName,provider:fork.provider,status:fork.status,updatedAt:now});
    threads.set(`${id}:`,{messages:history.slice(0,boundary+1).filter(message => !['internal','changes'].includes(message.role)).map((message,index) => ({...message,id:index+1,sessionId:id,turnChanges:null,turnDurationMs:null})),hasOlder:false,liveText:'',status:'idle'});
    return fork as T;
  }
  if (command === 'overlay_launch') {
    const id = crypto.randomUUID(), context = effectiveContext(); tasks.unshift({id,sessionId:id,kind:'task',title:String(args.prompt),projectId:'preview-project',projectName:'PandaCode',provider:context.provider,status:'running',updatedAt:Date.now()});
    window.dispatchEvent(new CustomEvent('pandacode-overlay-launched',{detail:{id,...context}})); return id as T;
  }
  if (command === 'overlay_toggle') { window.open(`${location.origin}/?view=launcher`, 'pandacode-launcher', 'width=650,height=510'); return undefined as T; }
  if (command === 'overlay_hide') { document.documentElement.dataset.overlayHidden = 'true'; return undefined as T; }
  if (command === 'overlay_open_task') { window.dispatchEvent(new CustomEvent('pandacode-overlay-open-task',{detail:args})); return undefined as T; }
  if (command === 'open_external_url') {
    const raw = String(args.url ?? '');
    const url = new URL(raw);
    if (raw.length > 8192 || !['http:', 'https:'].includes(url.protocol) || !url.host || url.username || url.password) throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    window.open(url.href, '_blank', 'noopener,noreferrer');
    return undefined as T;
  }
  throw new Error(`Unknown launcher command: ${command}`);
}
let contextTimer: number | undefined;
let latestContext: LaunchContext | null = null;
let savedContext = '';
/** Coalesce render-driven context changes; persist only actual selections. */
export function syncOverlayContext(context: LaunchContext): void {
  latestContext = context;
  clearTimeout(contextTimer);
  contextTimer = window.setTimeout(() => {
    const value = latestContext!; const serialized = JSON.stringify(value);
    if (serialized === savedContext) return;
    void overlayCall('overlay_sync_context', {context:value}).then(() => { savedContext = serialized; }).catch(error => console.warn('Launcher context could not be saved.', error));
  }, 250);
}
