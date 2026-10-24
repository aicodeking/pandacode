export type ProviderId = 'claude' | 'codex' | 'kimi' | 'opencode' | 'glm' | 'antigravity' | 'grok' | 'mimo' | 'pi' | 'deepseek' | 'commandcode' | 'cline' | 'kilo' | 'omp' | 'github-copilot' | 'muse';
export type Mode = 'ask' | 'auto' | 'plan' | 'full';
export type TaskStage = 'pending' | 'in_progress' | 'review' | 'completed';
export interface Project { id: string; name: string; path: string; }
export interface ContextUsage { usedTokens: number; contextWindow: number | null; }
export interface TaskLink { kind: 'issue' | 'pull'; number: number; url: string; title: string; state: string; checkedAt: number; }
export interface Session { pinned?: boolean; sidebarOrder?: number | null; /** Opened from New task; not listed until its first prompt. */ draft?: boolean; /** A usage limit hit by the last run: when, when it resets (null if unknown), and whether to continue then. */ limitedAt?: number | null; limitedUntil?: number | null; resumeAtReset?: boolean; goalState?: import('./command-center').GoalState | null; codexSettings?: { collaborationMode?: { mode: string }; serviceTier?: string | null } | null; id: string; projectId: string; worktreePath: string | null; worktreeBranch?: string | null; title: string; provider: ProviderId; model: string; mode: Mode; status: string; createdAt: number; updatedAt: number; lastResponseAt: number | null; lastPromptAt?: number | null; archived: boolean; resumeId: string | null; reasoningEffort?: string | null; contextUsage?: ContextUsage | null; taskStage?: TaskStage; taskDescription?: string; completedAt?: number | null; issue?: TaskLink | null; pullRequest?: TaskLink | null; /** Set when the task runs on another computer (PandaCode Connect). */ remoteDevice?: { id: string; name: string } | null; /** Set when the task's agent runs on a cloud machine (docs/cloud-agents.md). */ cloud?: { provider: string; label: string; machine: string | null; stage: 'creating' | 'installing' | 'credentials' | 'uploading' | 'ready' | 'running' | 'reconnecting' | 'syncing' | 'stopped' | 'error'; detail: string | null } | null; }
export interface BranchList { current: string; branches: string[]; defaultBranch: string; }
export interface WorktreeStatus { exists: boolean; branch: string; changes: number; clean: boolean; hasUpstream: boolean; ahead: number; merged: boolean; }
export interface WorktreeMerge { branch: string; target: string; commits: number; switchedFrom: string | null; }
export interface WorktreeRemoval { removed: boolean; branch: string; branchDeleted: boolean; note: string; }
export interface GithubRepository { nameWithOwner: string; defaultBranch: string; url: string; }
export interface GithubStatus { installed: boolean; version: string; authenticated: boolean; login: string | null; repo: GithubRepository | null; error: string | null; }
export interface GithubItem { kind: 'issue' | 'pull'; number: number; title: string; state: string; url: string; author: string; }
export interface GithubIssue { number: number; title: string; body: string; state: string; url: string; labels: string[]; assignees: string[]; updatedAt: string; }
export interface GithubReference { kind: 'issue' | 'pull'; number: number; title: string; state: string; url: string; author: string; body: string; labels: string[]; truncated: boolean; }
export interface TurnChangeFile { path: string; oldPath?: string | null; status: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number | null; deletions: number | null; binary?: boolean; truncated?: boolean; }
export interface TurnChanges { attributed?: boolean; id: string; files: TurnChangeFile[]; additions: number; deletions: number; truncated: boolean; concurrent: boolean; error?: string | null; }
export interface TurnChangeDiff { path: string; oldPath?: string | null; patch: string; binary: boolean; truncated: boolean; error?: string | null; }
export interface Message { coordinationKind?: 'worker_update' | 'worker_review' | 'continue' | 'worker_failed'; id: number; sessionId: string; role: string; content: string; createdAt: number; turnDurationMs?: number | null; authorProvider?: ProviderId; turnChanges?: TurnChanges | null; }
export interface MessagePage { messages: Message[]; hasOlder: boolean; }
export interface ReasoningEffort { id: string; name: string; description: string; }
export interface ProviderModel { id: string; name: string; description: string; reasoningEfforts?: ReasoningEffort[]; defaultReasoningEffort?: string | null; contextWindow?: number | null; }
export interface Provider { id: ProviderId; name: string; installed: boolean; path: string | null; version: string; models: ProviderModel[]; }
export interface GitFile { path: string; index: string; working: string; }
export interface GitStatus { branch: string; files: GitFile[]; isRepo: boolean; }
export interface FileEntry { name: string; path: string; isDir: boolean; }
export interface ToolActivity { id: string; name: string; status: 'running' | 'completed' | 'failed'; input: string; output: string; }
export interface SubagentActivity { id: string; parentId: string | null; name: string; prompt: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'; response: string; tools: ToolActivity[]; startedAt: number; updatedAt: number; }
export interface AgentQuestion { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean; }
export type AgentInputRequest = { kind: 'questions'; questions: AgentQuestion[] } | { kind: 'form'; message: string; schema: unknown } | { kind: 'url'; message: string; url: string };
export type AgentInputResponse = { answers: Record<string, string[]> } | { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> | null };
export interface AgentEvent { sessionId: string; kind: 'limited' | 'turn_changes' | 'task_settings' | 'goal_ready' | 'goal_input' | 'goal' | 'turn_start' | 'turn_complete' | 'commands_changed' | 'message_start' | 'text' | 'tool' | 'subagent' | 'status' | 'approval' | 'approval_cancelled' | 'input_request' | 'input_cancelled' | 'error' | 'done' | 'session' | 'usage' | 'steer'; text: string; requestId?: string; data?: unknown; tool?: ToolActivity; }
export interface TerminalEvent { terminalId: string; data: string; exit?: boolean; }
export interface Metrics { coreRssBytes: number; activeAgents: number; activeTerminals: number; databaseBytes: number; }
export interface LocalServer { port: number; process: string; url: string; }
export interface BrowserBounds { x: number; y: number; width: number; height: number; }
export interface BrowserStatus { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; picking: boolean; }
export interface BrowserElement { url: string; title: string; selector: string; tag: string; text: string; html: string; bounds: BrowserBounds; }
export interface BrowserScreenshot { id: string; name: string; path: string; mimeType: string; url: string; title: string; width: number; height: number; dataUrl: string; }
export type BrowserAttachment = ({ kind: 'element'; id: string } & BrowserElement) | ({ kind: 'screenshot' } & BrowserScreenshot);
