// Inbox data for the inbox screen and the iPhone Duo sidebar: sections from src/store/inbox.ts
// over the store, a minute clock for relative times, and `load`, which lists every online
// computer's tasks (and with them its bots) now (client.ts also refreshes lists on presence, foreground, run ends and a timer).
// `updating`: rows drawn from the inbox cache at launch are still waiting for their live list.
// `loading`: too early for an empty inbox to mean anything. `problems`: load errors naming the computer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { connect, NOT_SIGNED_IN } from '../connect/client.ts';
import { LOST, NOT_CONNECTED } from '../connect/rpc.ts';
import { markStartup } from '../connect/perf.ts';
import { botRows, inboxLoading, inboxSections, listProblems, liveSignature, stillUpdating, type ListError, type RunGlance } from '../store/inbox.ts';
import { useConnect, useHosts } from '../store/index.ts';
import { useLocal } from '../store/local.ts';
import type { Live } from '../store/reduce.ts';

/** Connection errors are passing: the client lists again on presence. */
const TRANSIENT = new Set([NOT_SIGNED_IN, NOT_CONNECTED, LOST]);

/** The Needs you count for the tab badge, kept apart so the tab bar doesn't re-render with the inbox. */
export const useAttention = create<{ count: number }>(() => ({ count: 0 }));

function useLiteLive(): { live: Record<string, Live>; glances: Record<string, RunGlance> } {
  const signature = useConnect(s => liveSignature(s.live, s.tasks));
  return useMemo(() => {
    const live: Record<string, Live> = {};
    const glances: Record<string, RunGlance> = {};
    for (const [key, status, approvals, inputs, limited, glance] of JSON.parse(signature) as [string, string, number, number, Live['limited'] | null, RunGlance][]) {
      const real = useConnect.getState().live[key];
      live[key] = { status, activity: '', items: [], approvals: real?.approvals ?? Array(approvals), inputs: real?.inputs ?? Array(inputs), limited: limited ?? undefined };
      glances[key] = glance;
    }
    return { live, glances };
  }, [signature]);
}

function useMinute() {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 15_000);
    return () => clearInterval(timer);
  }, []);
  return minute;
}

export function useInbox() {
  const hosts = useHosts();
  const tasks = useConnect(s => s.tasks);
  const allBots = useConnect(s => s.bots);
  // Older hosts' rows carry no `team`: a loaded team's working workers keep its task under Running.
  const teams = useConnect(s => s.teams);
  const updating = useConnect(s => stillUpdating(s.tasks, s.devices, s.connected));
  const connected = useConnect(s => s.connected);
  const deviceCount = useConnect(s => s.devices.length);
  const { live, glances } = useLiteLive();
  const { snoozed, pins, outbox } = useLocal(useShallow(s => ({ snoozed: s.snoozed, pins: s.pins, outbox: s.outbox })));
  const minute = useMinute();
  const [errors, setErrors] = useState<Record<string, ListError>>({});

  const onlineKey = hosts.filter(h => h.online).map(h => h.id).join(',');
  const load = useCallback(async () => {
    const ids = onlineKey ? onlineKey.split(',') : [];
    const results = await Promise.all(ids.map(id => connect.listTasks(id).then(() => '', (e: Error) => e.message)));
    const at = Date.now();
    setErrors(Object.fromEntries(ids.flatMap((id, i) => (results[i] && !TRANSIENT.has(results[i]) ? [[id, { message: results[i], at }]] : []))));
  }, [onlineKey]);

  const inbox = useMemo(() => inboxSections({ hosts, tasks, live, glances, teams, snoozed, pins, outbox, now: minute * 60_000 + 59_999 }), [hosts, tasks, live, glances, teams, snoozed, pins, outbox, minute]);
  const bots = useMemo(() => botRows(hosts, allBots, tasks), [hosts, allBots, tasks]);
  useEffect(() => { if (Object.values(inbox).some(rows => rows.length)) markStartup('paint'); }, [inbox]);
  // A later list from the client's own refreshes, or the host going offline, clears an error.
  const problems = useMemo(() => listProblems(errors, hosts, tasks), [errors, hosts, tasks]);
  const loading = inboxLoading(deviceCount, hosts, tasks, errors);
  return { hosts, inbox, bots, minute, problems, load, updating, connected, loading };
}
