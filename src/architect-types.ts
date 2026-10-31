import type { ProviderId } from './types';

export interface WorkerProfile {
  id: string;
  name: string;
  provider: ProviderId;
  model: string;
  reasoningEffort?: string | null;
}
export interface TeamConfig {
  /** The task's own model leads and picks each worker's model (from `workers`, a roster of
   * installed models, or as the prompt asks). Configured teams name fixed worker profiles. */
  auto?: boolean;
  /** Named agent teams (Settings → Agent teams): the lead may only orchestrate `workers`. */
  rosterOnly?: boolean;
  /** The agent team's name, shown in the model picker and composer. */
  name?: string;
  workers: WorkerProfile[];
  /** Every model of every installed harness, up to 1000, round-robin across harnesses. `workers` stays the short
   * roster shown to the lead; Panda Router picks worker models from this wider list. */
  catalog?: WorkerProfile[];
  /** Zero means unlimited; positive values preserve a user-selected limit. */
  maxParallel: number;
  maxRounds: number;
  maxAssignments: number;
  workspace: 'shared';
  summaryLimit: number;
  /** Extra instructions for the lead, added to the built-in team rules. Empty means the
   * built-in rules alone. */
  leadGuidance?: string | null;
}
export type ModelSelection = Pick<WorkerProfile, 'provider' | 'model' | 'reasoningEffort'>;
export interface TeamSetup { architect: ModelSelection; config: TeamConfig }
export interface TeamProfile { id: string; name: string; setup: TeamSetup; updatedAt: number }
export interface TeamLibrary {
  enabled: boolean;
  lastSetup: TeamSetup | null;
  activeProfileId: string | null;
  profiles: TeamProfile[];
  /** Lead guidance for every team that does not set its own (Settings → Agents). */
  leadGuidance?: string | null;
}
export interface WorkerCheckpoint {
  summary: string;
  nextSteps: string;
  blocker: string | null;
  updatedAt: number;
}
export interface TeamMessage {
  id: number;
  sender: string;
  recipient: string;
  message: string;
  createdAt: number;
}
export interface TeamMessagePage {
  messages: TeamMessage[];
  nextCursor: number;
  hasMore: boolean;
}
export interface TeamWorker extends WorkerProfile {
  sessionId: string;
  profileId: string;
  /** `parked`: its run ended while its sub-workers work; it resumes with their results. */
  status: 'queued' | 'running' | 'waiting' | 'parked' | 'completed' | 'failed' | 'stopped';
  /** The direct worker that dispatched this sub-worker. */
  parentWorker?: string;
  assignment: string;
  summary: string;
  error?: string | null;
  dependsOn: string[];
  files: string[];
  /** Advisory no-edit assignment; legacy workers reserve their declared edit scope. */
  readOnly?: boolean;
  attempt: number;
  abandoned?: boolean;
  checkpoint?: WorkerCheckpoint | null;
  createdAt: number;
  updatedAt: number;
}
export interface TeamSnapshot {
  sessionId: string;
  config: TeamConfig;
  /** Selected during an architect turn; becomes effective at the next turn. */
  pendingSetup?: TeamSetup | null;
  status: 'ready' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'interrupted';
  round: number;
  revision: number;
  coordinationRevision?: number;
  reviewedCoordinationRevision?: number;
  workers: TeamWorker[];
  error?: string | null;
  summary?: string | null;
  updatedAt: number;
}
export const teamActive = (team?: TeamSnapshot | null): boolean => team?.status === 'running' || team?.status === 'waiting';

export type TeamEvent = TeamSnapshot | { sessionId: string; removed: true };
