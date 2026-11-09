// An architect task's team for the Agents screens: asked once on open, kept current by the host's
// `team` live events, and asked again every POLL_MS while the team works (events can be missed
// while the phone sleeps). Watching the workers' own sessions brings their live tools.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { connect } from '../connect/client.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { teamActive, workerActive, workerNames, type Team } from '../store/team.ts';

const POLL_MS = 5000;

type Loaded = Team | null | 'outdated' | undefined;

/** team: undefined while loading, null for none, 'outdated' when the host lacks task.team.
 * error: why the last ask failed, for Retry while nothing is held. */
export function useTeamLoad(deviceId: string, sessionId: string, poll = true): { team: Loaded; error: string; retry: () => void } {
  const team = useConnect(s => s.teams[taskKey(deviceId, sessionId)]);
  const [error, setError] = useState('');
  const active = !!team && team !== 'outdated' && (teamActive(team) || team.workers.some(workerActive));
  const load = useCallback(() => connect.loadTeam(deviceId, sessionId).then(() => setError(''), (e: Error) => setError(e.message || 'Could not reach that computer.')), [deviceId, sessionId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!poll || !active) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load, poll, active]);
  const retry = useCallback(() => { setError(''); void load(); }, [load]);
  return { team, error, retry };
}

export const useTeam = (deviceId: string, sessionId: string, poll = true): Loaded => useTeamLoad(deviceId, sessionId, poll).team;

/** Keeps the team's running workers' sessions subscribed while mounted. */
export function useWatchWorkers(deviceId: string, team: Loaded) {
  const ids = team && team !== 'outdated' ? team.workers.filter(w => workerActive(w) && w.sessionId).map(w => w.sessionId).sort().join('\n') : '';
  useEffect(() => {
    const list = ids ? ids.split('\n') : [];
    if (!list.length) return;
    connect.watch(deviceId, list);
    return () => connect.unwatch(deviceId, list);
  }, [deviceId, ids]);
}

/** Worker id → name for tool sentences on this task. */
export function useNames(team: Loaded) {
  return useMemo(() => workerNames(team === 'outdated' ? null : team), [team]);
}
