// An architect task's team for the Agents screens: asked once on open, kept current by the host's
// `team` live events, and asked again every POLL_MS while the team works (events can be missed
// while the phone sleeps). Watching the workers' own sessions brings their live tools.
import { useEffect, useMemo } from 'react';
import { connect } from '../connect/client.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { teamActive, workerActive, workerNames, type Team } from '../store/team.ts';

const POLL_MS = 5000;

/** undefined while loading, null for none, 'outdated' when the host lacks task.team. */
export function useTeam(deviceId: string, sessionId: string, poll = true): Team | null | 'outdated' | undefined {
  const team = useConnect(s => s.teams[taskKey(deviceId, sessionId)]);
  const active = !!team && team !== 'outdated' && (teamActive(team) || team.workers.some(workerActive));
  useEffect(() => { connect.loadTeam(deviceId, sessionId).catch(() => undefined); }, [deviceId, sessionId]);
  useEffect(() => {
    if (!poll || !active) return;
    const timer = setInterval(() => connect.loadTeam(deviceId, sessionId).catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [deviceId, sessionId, poll, active]);
  return team;
}

/** Keeps the team's running workers' sessions subscribed while mounted. */
export function useWatchWorkers(deviceId: string, team: Team | null | 'outdated' | undefined) {
  const ids = team && team !== 'outdated' ? team.workers.filter(w => workerActive(w) && w.sessionId).map(w => w.sessionId).sort().join('\n') : '';
  useEffect(() => {
    const list = ids ? ids.split('\n') : [];
    if (!list.length) return;
    connect.watch(deviceId, list);
    return () => connect.unwatch(deviceId, list);
  }, [deviceId, ids]);
}

/** Worker id → name for tool sentences on this task. */
export function useNames(team: Team | null | 'outdated' | undefined) {
  return useMemo(() => workerNames(team === 'outdated' ? null : team), [team]);
}
