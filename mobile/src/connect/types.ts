// Wire shapes from docs/remote-access.md and src-tauri/src/remote/host.rs.

export interface Account { id: string; login: string; avatarUrl: string }

/** A presence row (also `GET /v1/devices`). */
export interface Device { id: string; name: string; platform: string; publicKey: string; host: boolean; online: boolean; lastSeen: number }

export interface Project { id: string; name: string; repo: string | null }

export type TaskStatus = 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed' | 'stopped' | (string & {});

export interface TaskSummary extends HostActivity {
  sessionId: string; title: string; status: TaskStatus; projectId: string; projectName: string;
  provider: string; model: string; effort: string | null; mode: string; pinned: boolean;
  updatedAt: number; lastPromptAt: number | null; branch?: string; chat?: boolean;
  /** A bot's conversation: listed under Bots, not its project. */
  botId?: string; botName?: string;
  /** Approvals and questions waiting on the host now. */
  pending?: PendingRequest[];
  /** The newest message id, from hosts that send it (prefetch skips threads already current). */
  lastId?: number;
  /** Set on rows drawn from the inbox cache at launch: when this state was last confirmed. A live list replaces them. */
  seenAt?: number;
}

/** Newer hosts: when the run's newest event came and when it started (ms), and its subagents.
 * `team` (architect tasks only, checked by decodeTeamRun in src/store/team.ts): `{ status, activeWorkers }`. */
export interface HostActivity { lastEventAt?: number | null; runStartedAt?: number | null; subagents?: unknown; team?: unknown }

export interface TasksList { tasks: TaskSummary[]; projects: Project[] }

/** An approval or input request waiting on the host, from a subscribe reply. */
export interface PendingRequest { kind: 'approval' | 'input_request' | (string & {}); requestId: string; text: string; data?: unknown; tool?: ToolActivity }

/** Newer hosts add `seq` (the newest event number), and for a subscribe with `afterSeq` the
 * missed `events` (team updates and `run.finished` entries included) or `gap: true`. With
 * `more`, the replay continues in another subscribe from `seq`, the last one replayed
 * (docs/remote-access.md). */
export interface SubscribedTask extends HostActivity { sessionId: string; status: TaskStatus; lastId: number; title: string; pending?: PendingRequest[]; seq?: number; gap?: boolean; more?: boolean; events?: AgentEvent[] }

/** A subscribe reply; `more`: some task's replay continues in another page. */
export interface SubscribeReply { tasks: SubscribedTask[]; epoch?: string; more?: boolean; missing?: string[] }

/** `agent.events` frame data; `lagged`: the host dropped what it could not buffer, so subscribe again from `seq`. */
export interface AgentEventsFrame { events: AgentEvent[]; epoch?: string; lagged?: boolean }

/** `attachments`: newer hosts' rows (checked by parseAttachments in src/store/attachments.ts). */
export interface Message { id: number; role: string; content: string; createdAt: number; turnDurationMs: number | null; attachments?: unknown; /** The host cut this (oversized) message to fit a small page; same id, refetched whole. */ cut?: boolean }
/** `hasMore`: newer messages follow the page; `hasOlder` (newer hosts, tail/beforeId pages): older ones precede it. */
export interface MessagePage { messages: Message[]; hasMore: boolean; title: string; hasOlder?: boolean; lastId?: number | null }

export interface ReasoningEffort { id: string; name: string; description: string }
export interface ProviderModel { id: string; name: string; description: string; reasoningEfforts?: ReasoningEffort[]; defaultReasoningEffort?: string | null; contextWindow?: number | null }
export interface Provider { id: string; name: string; installed: boolean; path?: string | null; version?: string | null; models: ProviderModel[] }

export interface ToolActivity { id: string; name: string; status: 'running' | 'completed' | 'failed'; input: string; output: string }

/** The host's raw AgentEvent (src/types.ts). */
export interface AgentEvent { sessionId: string; kind: string; text: string; requestId?: string; data?: unknown; tool?: ToolActivity; seq?: number }

/** Newer hosts, architect tasks: `status` as tasks.list shows it ('running' while the team works),
 * `team` (`{ status, activeWorkers }`), and `teamSettled` on the extra run.finished sent when the team settles. */
export interface RunFinished { sessionId: string; successful: boolean; stopped: boolean; text: string; status?: TaskStatus; team?: unknown; teamSettled?: boolean; kind?: 'run.finished'; seq?: number }

/** `startId`: one per deliberate start; the host runs a repeated start with it once. */
export interface StartParams {
  repo?: string; projectId?: string; branch?: string; worktree: boolean; prompt: string;
  provider: string; model: string; mode?: string; effort?: string; startId?: string;
}

/** `task.startStatus`: how a start by `startId` stands on its host ('unknown': never seen, or forgotten after an hour or a restart). */
export interface StartStatus { state: 'running' | 'done' | 'failed' | 'unknown'; sessionId?: string; error?: string }

/** `task.cancelStart`: `cancelled: false` (with `sessionId`) when the host had already made the task. */
export interface CancelStart { cancelled: boolean; sessionId?: string }

export interface ConfigureParams { sessionId: string; provider?: string; model?: string; effort?: string | null; mode?: string }

// ---- Pull requests, changes and bots (newer hosts; older ones answer 'Unknown method.') ----

export interface PullCheck { name: string; state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral' | (string & {}); url: string }
export interface PullFile { path: string; additions: number; deletions: number }
export interface PullCommit { oid: string; headline: string; author: string; date: string }
export interface PullComment { kind: 'comment' | 'review' | (string & {}); author: string; body: string; state: string; createdAt: string }
export interface PullDetail {
  number: number; title: string; body: string; bodyTruncated: boolean; state: string; url: string; author: string;
  base: string; head: string; additions: number; deletions: number; changedFiles: number;
  createdAt: string; updatedAt: string; mergedAt: string; mergeable: string; reviewDecision: string;
  labels: string[]; checks: PullCheck[]; files: PullFile[]; commits: PullCommit[]; timeline: PullComment[]; truncated?: boolean;
}
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface ChangedFile { path: string; status: string; staged: boolean }
export interface Changes { branch: string; ahead: number; behind: number; files: ChangedFile[] }
export interface Diff { text: string; truncated: boolean }

export interface Bot { id: string; name: string; avatar: string | null; state: 'paused' | 'working' | 'ready' | (string & {}); paused: boolean; desktopSession: string | null; projectId: string }
