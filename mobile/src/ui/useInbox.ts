// Inbox data for the inbox screen and the iPhone Duo sidebar: sections from src/store/inbox.ts
// over the store, a minute clock for relative times, and `load`, which lists every online
// computer's tasks (and with them its bots) now (client.ts also refreshes lists on presence, foreground, run ends and a timer).
// `updating`: rows drawn from the inbox cache at launch are still waiting for their live list.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { connect, NOT_SIGNED_IN } from '../connect/client.ts';
import { LOST, NOT_CONNECTED } from '../connect/rpc.ts';
import { markStartup } from '../connect/perf.ts';
import { botRows, glanceOf, inboxSections, type RunGlance } from '../store/inbox.ts';
import { useConnect, useHosts, type ConnectState } from '../store/index.ts';
import { useLocal } from '../store/local.ts';
import type { Live } from '../store/reduce.ts';

/** Connection errors are passing: the client lists again on presence. */
const TRANSIENT = new Set([NOT_SIGNED_IN, NOT_CONNECTED, LOST]);

/**
 * Only what the inbox shows from each live run (status, request counts, limit and its glance:
 * current tool, thinking, subagents), as one string, so streamed text deltas don't recompute the
 * list. lastEventAt is left out: each row's clock reads it when it ticks.
 */
function liveSignature(live: Record<string, Live>, tasks: ConnectState['tasks']): string {
  return JSON.stringify(Object.entries(live).map(([key, l]) => {
    const [host, sessionId] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    const { lastEventAt: _, ...glance } = glanceOf(l, tasks[host]?.tasks.find(t => t.sessionId === sessionId));
    return [key, l.status, l.approvals.length, l.inputs.length, l.limited ?? null, glance];
  }));
}

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
  const updating = useConnect(s => Object.entries(s.tasks).some(([id, list]) => list.cachedAt !== undefined && (!s.connected || s.devices.some(d => d.id === id && d.online))));
  const { live, glances } = useLiteLive();
  const { snoozed, pins, outbox } = useLocal(useShallow(s => ({ snoozed: s.snoozed, pins: s.pins, outbox: s.outbox })));
  const minute = useMinute();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const onlineKey = hosts.filter(h => h.online).map(h => h.id).join(',');
  const load = useCallback(async () => {
    const ids = onlineKey ? onlineKey.split(',') : [];
    const results = await Promise.all(ids.map(id => connect.listTasks(id).then(() => '', (e: Error) => e.message)));
    setErrors(Object.fromEntries(ids.map((id, i) => [id, results[i]]).filter(([, e]) => e && !TRANSIENT.has(e))));
  }, [onlineKey]);

  const inbox = useMemo(() => inboxSections({ hosts, tasks, live, glances, teams, snoozed, pins, outbox, now: minute * 60_000 + 59_999 }), [hosts, tasks, live, glances, teams, snoozed, pins, outbox, minute]);
  const bots = useMemo(() => botRows(hosts, allBots, tasks), [hosts, allBots, tasks]);
  useEffect(() => { if (Object.values(inbox).some(rows => rows.length)) markStartup('paint'); }, [inbox]);
  return { hosts, inbox, bots, minute, errors, load, updating };
}
