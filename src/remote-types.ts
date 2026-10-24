/* Shapes of the PandaCode Connect commands and events (docs/remote-access.md). */
export interface RemoteStatus {
  configured: boolean; signedIn: boolean; account?: { login: string; avatarUrl?: string };
  device: { id: string; name: string; fingerprint: string }; hostEnabled: boolean; remoteFullAccess: boolean; connected: boolean;
}
export interface RemoteDevice { id: string; name: string; platform: string; fingerprint: string; host: boolean; online: boolean; lastSeen: number; current: boolean }
export interface RemoteSignIn { userCode: string; verificationUri: string; expiresIn: number }
export interface RemoteHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(name: string, callback: (event: any) => void): Promise<() => void>;
  notify(text: string): void;
  openUrl(url: string): Promise<void>;
}
/** A computer a new task can start on (`remote_targets`). */
export interface RemoteTarget { deviceId: string; name: string; platform: string; online: boolean }
/** `remote_repo_check`: how GitHub compares with this computer's checkout. `repo` is null without a GitHub remote. */
export interface RemoteRepoCheck { repo: string | null; branch: string; ahead: number; dirty: boolean; pushed: boolean }
