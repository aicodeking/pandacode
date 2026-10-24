// Inbox data for the inbox screen and the iPhone Duo sidebar: sections from src/store/inbox.ts
// over the store, a minute clock for relative times, and `load`, which lists every online
// computer's tasks now (client.ts also refreshes lists on presence, foreground, run ends and a timer).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { connect, NOT_SIGNED_IN } from '../connect/client.ts';
import { DEMO } from '../demo.ts';
import { inboxSections } from '../store/inbox.ts';
import { useConnect, useHosts } from '../store/index.ts';
import { useLocal } from '../store/local.ts';
import type { Live } from '../store/reduce.ts';

/**
 * Only what the inbox shows from each live run (status and request counts), as a string, so
 * streamed text deltas don't recompute the list.
 */
const liveSignature = (live: Record<string, Live>) =>
  Object.entries(live).map(([key, l]) => `${key}|${l.status}|${l.approvals.length}|${l.inputs.length}`).join('\n');

function useLiteLive(): Record<string, Live> {
  const signature = useConnect(s => liveSignature(s.live));
  return useMemo(() => {
    const lite: Record<string, Live> = {};
    for (const line of signature ? signature.split('\n') : []) {
      const [key, status, approvals, inputs] = line.split('|');
      const real = useConnect.getState().live[key];
      lite[key] = { status, activity: '', items: [], approvals: real?.approvals ?? Array(Number(approvals)), inputs: real?.inputs ?? Array(Number(inputs)) };
    }
    return lite;
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
  const live = useLiteLive();
  const { snoozed, pins, outbox } = useLocal(useShallow(s => ({ snoozed: s.snoozed, pins: s.pins, outbox: s.outbox })));
  const minute = useMinute();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const onlineKey = hosts.filter(h => h.online).map(h => h.id).join(',');
  const load = useCallback(async () => {
    if (DEMO) return;
    const ids = onlineKey ? onlineKey.split(',') : [];
    const results = await Promise.all(ids.map(id => connect.listTasks(id).then(() => '', (e: Error) => e.message)));
    setErrors(Object.fromEntries(ids.map((id, i) => [id, results[i]]).filter(([, e]) => e && e !== NOT_SIGNED_IN)));
  }, [onlineKey]);

  const inbox = useMemo(() => inboxSections({ hosts, tasks, live, snoozed, pins, outbox, now: minute * 60_000 + 59_999 }), [hosts, tasks, live, snoozed, pins, outbox, minute]);
  return { hosts, inbox, minute, errors, load };
}
