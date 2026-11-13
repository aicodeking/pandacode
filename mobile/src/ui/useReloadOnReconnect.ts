// Screens load again when their computer comes back online (offline to online), so a page that failed
// or went stale while it was away refreshes itself. Shared by useLoad (ui/hub/common.tsx) and the
// screens with their own loads (Changes, Queue, Branches, GitHub, Schedules, Pull request, Worktree,
// Usage, Bot settings).
import { useEffect, useRef } from 'react';
import { useConnect } from '../store/index.ts';

/** Whether a load should run again: the computer just came back (offline to online). */
export const cameOnline = (was: boolean | undefined, now: boolean) => was === false && now;

/** Calls `reload` each time `device` comes back online (not on mount; the screen's own load runs then). */
export function useReloadOnReconnect(device: string, reload: () => unknown): void {
  const online = useConnect(s => s.devices.find(d => d.id === device)?.online ?? false);
  const latest = useRef(reload);
  useEffect(() => { latest.current = reload; }, [reload]);
  const wasOnline = useRef<boolean | undefined>(undefined);
  useEffect(() => { wasOnline.current = undefined; }, [device]);
  useEffect(() => {
    const was = wasOnline.current;
    wasOnline.current = online;
    if (cameOnline(was, online)) void latest.current();
  }, [online]);
}
