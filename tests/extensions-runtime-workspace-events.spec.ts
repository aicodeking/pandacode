import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { KINDS, QUEUE_LIMIT, WorkspaceEvents, eventFrame, subscribable, validate } from '../src/extensions/runtime-workspace-events';

// Preview column of R0202 (ordered, scoped workspace events). These checks run the deterministic model in
// src/extensions/runtime-workspace-events.ts, which mirrors src-tauri/src/extensions/runtime_workspace_events.rs. The
// real installed process (the fixture service under the pinned runtime) is the native test
// `runtime_service_lifetime::tests::installed::workspace_events_*` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-workspace-events/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-workspace-events/main.cjs');
const ID = 'sample.workspace-events';

const turn = (kind: string, projectId: string, index: number) => ({ kind, taskId: 't1', projectId, index });
const SCRIPT = [
  { kind: 'project.opened', projectId: 'A' },
  { kind: 'task.created', taskId: 't1', projectId: 'A', harness: 'claude', startedBy: 'user' },
  { kind: 'task.shown', windowId: 'w1', taskId: 't1', projectId: 'A' },
  turn('turn.started', 'A', 1), turn('turn.finished', 'A', 1), turn('turn.failed', 'A', 2),
  { kind: 'task.idle', taskId: 't1', projectId: 'A' },
  { kind: 'task.compacted', taskId: 't1', projectId: 'A' },
  { kind: 'task.stopped', taskId: 't1', projectId: 'A', by: 'user' },
  { kind: 'task.removed', taskId: 't1', projectId: 'A' },
  { kind: 'settings.changed', page: 'main', revision: 2 },
  { kind: 'app.focus', focused: true },
  { kind: 'project.closed', projectId: 'A' },
];

/** A hub whose gate is a mutable project list, the way the grants file narrows. */
function harness(projects: string[] = ['A', 'B'], kinds: readonly string[] = [...KINDS, 'gap']) {
  const grant = { projects: new Set(projects), held: true };
  const hub = new WorkspaceEvents();
  hub.setGate((_owner, _version, project) => grant.held && (project === null || grant.projects.has(project)));
  hub.attach(ID, '1.0.0', 1);
  for (const kind of kinds) expect(hub.subscribe(ID, kind)).toBeNull();
  const drain = (owner = ID) => { const out = []; for (let envelope = hub.nextFrame(owner); envelope; envelope = hub.nextFrame(owner)) out.push(envelope); return out; };
  return { hub, grant, drain };
}

test('extensions workspace events: the fixture package declares the permission and a service, and listens to every kind', () => {
  expect(manifest.permissions).toContain('events.workspace');
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const kind of [...KINDS, 'gap']) expect(subscribable(kind), kind).toBe(true);
  expect(fixtureSource).toContain("'gap'");
  for (const kind of KINDS) expect(fixtureSource, kind).toContain(`'${kind}'`);
  // Retained refusal (Q125), for a non-security reason: a name that is not an event cannot be listened to, because
  // nothing would ever arrive on it. Subscribing without the grant stays refused (below): that is the permission.
  expect(subscribable('task.content')).toBe(false);
});

test('extensions workspace events: the thirteen events arrive in sequence with ids only', () => {
  const { hub, drain } = harness();
  expect([...new Set(SCRIPT.map(event => event.kind))].sort()).toEqual([...KINDS].sort());
  SCRIPT.forEach((event, index) => expect(hub.publish(event, null, 100 + index)).toEqual({ queued: 1, dropped: 0 }));
  const seen = drain();
  expect(seen.map(envelope => envelope.kind)).toEqual(SCRIPT.map(event => event.kind));
  expect(seen.map(envelope => envelope.sequence)).toEqual(SCRIPT.map((_, index) => index + 1));
  expect(seen[1]).toEqual({ schemaVersion: 1, kind: 'task.created', sequence: 2, at: 101, taskId: 't1', projectId: 'A', harness: 'claude', startedBy: 'user' });
  expect(eventFrame(seen[0])).toEqual({ event: seen[0] });
  expect(hub.nextFrame(ID)).toBeNull();
  // Content never travels: an event with any other field is refused whole, whatever it carries.
  for (const content of [{ ...SCRIPT[1], title: 'secret' }, { ...SCRIPT[3], text: 'hello' }, { kind: 'task.idle', taskId: 't1' }, { kind: 'gap', dropped: 1 }, { kind: 'turn.started', taskId: 't', projectId: 'p', index: -1 }]) {
    expect(validate(content), JSON.stringify(content)).toBeNull();
    expect(hub.publish(content, null, 1)).toEqual({ code: 'InvalidShape' });
  }
});

test('extensions workspace events: a project outside the grant delivers nothing, and narrowing stops what is queued', () => {
  const { hub, grant, drain } = harness(['A']);
  expect(hub.publish(turn('turn.started', 'B', 1), null, 1)).toEqual({ queued: 0, dropped: 0 });
  expect(hub.publish(turn('turn.started', 'A', 1), null, 2)).toEqual({ queued: 1, dropped: 0 });
  // A window showing nothing and the app focus belong to no project: the permission alone is enough.
  expect(hub.publish({ kind: 'task.shown', windowId: 'w', taskId: null, projectId: null }, null, 3).queued).toBe(1);
  expect(drain().map(envelope => envelope.kind)).toEqual(['turn.started', 'task.shown']);
  hub.publish(turn('turn.started', 'A', 2), null, 4);
  grant.projects.delete('A');
  expect(drain()).toEqual([]);
  // Another package's settings change is never ours.
  const other = harness(['A'], ['settings.changed']);
  other.hub.attach('sample.other', '1.0.0', 1); other.hub.subscribe('sample.other', 'settings.changed');
  other.hub.publish({ kind: 'settings.changed', page: 'p', revision: 1 }, ID, 1);
  expect(other.drain().length).toBe(1);
  expect(other.drain('sample.other')).toEqual([]);
  // No grant at all: subscribing is refused and nothing is ever queued.
  const none = harness(['A'], []);
  none.grant.held = false;
  expect(none.hub.subscribe(ID, 'turn.started')).toBe('PermissionDenied');
  expect(none.hub.subscribe(ID, 'task.content')).toBe('InvalidShape');
  expect(none.hub.subscribe('ghost', 'turn.started')).toBe('HostUnavailable');
});

test('extensions workspace events: 256 queued events overflow into one bounded gap and the consumer resynchronizes', () => {
  const { hub, drain } = harness(['A'], ['turn.started', 'gap']);
  for (let index = 0; index < QUEUE_LIMIT; index += 1) hub.publish(turn('turn.started', 'A', index), null, 100 + index);
  expect(hub.pending(ID)).toBe(QUEUE_LIMIT);
  expect(hub.publish(turn('turn.started', 'A', QUEUE_LIMIT), null, 400)).toEqual({ queued: 1, dropped: 1 });
  expect(hub.pending(ID)).toBe(QUEUE_LIMIT);
  const seen = drain();
  expect(seen).toHaveLength(QUEUE_LIMIT + 1);
  expect(seen[0]).toEqual({ schemaVersion: 1, kind: 'gap', sequence: 1, at: 400, dropped: 1 });
  expect(seen[1]).toMatchObject({ kind: 'turn.started', index: 1, sequence: 2 });
  expect(seen.at(-1)).toMatchObject({ index: QUEUE_LIMIT, sequence: QUEUE_LIMIT + 1 });
  // The consumer reads the state again, then ordinary delivery goes on from the next number.
  hub.publish(turn('turn.started', 'A', 999), null, 500);
  expect(drain()).toEqual([{ schemaVersion: 1, kind: 'turn.started', sequence: QUEUE_LIMIT + 2, at: 500, taskId: 't1', projectId: 'A', index: 999 }]);
  // A longer outage is still one gap, carrying the whole count.
  for (let index = 0; index < QUEUE_LIMIT + 40; index += 1) hub.publish(turn('turn.started', 'A', index), null, 600);
  const burst = drain();
  expect(burst.filter(envelope => envelope.kind === 'gap')).toEqual([expect.objectContaining({ dropped: 40 })]);
  expect(burst).toHaveLength(QUEUE_LIMIT + 1);
  // Without a gap listener the loss costs no envelope and no number.
  const quiet = harness(['A'], ['turn.started']);
  for (let index = 0; index < QUEUE_LIMIT + 5; index += 1) quiet.hub.publish(turn('turn.started', 'A', index), null, 1);
  const kept = quiet.drain();
  expect(kept).toHaveLength(QUEUE_LIMIT);
  expect(kept[0].sequence).toBe(1);
});

test('extensions workspace events: unsubscribe, restart and disable leave zero listeners', () => {
  const { hub, drain } = harness(['A'], ['turn.started', 'app.focus']);
  hub.publish(turn('turn.started', 'A', 1), null, 1);
  expect(hub.unsubscribe(ID, 'turn.started')).toBeNull();
  expect([hub.listeners(ID), hub.pending(ID)]).toEqual([1, 0]);
  expect(hub.publish(turn('turn.started', 'A', 2), null, 2)).toEqual({ queued: 0, dropped: 0 });
  // Restart: the new generation begins empty; the old generation ending afterwards cannot remove it.
  hub.publish({ kind: 'app.focus', focused: true }, null, 3);
  hub.attach(ID, '1.0.0', 2);
  expect([hub.listeners(ID), hub.pending(ID)]).toEqual([0, 0]);
  hub.subscribe(ID, 'app.focus');
  hub.detach(ID, 1);
  expect([hub.attached(), hub.listeners(ID)]).toEqual([1, 1]);
  // Disable, uninstall, trust loss and safe mode all end the process: nothing stays subscribed or queued.
  hub.detach(ID, 2);
  expect([hub.attached(), hub.listeners(ID), hub.pending(ID)]).toEqual([0, 0, 0]);
  expect(hub.publish({ kind: 'app.focus', focused: false }, null, 4)).toEqual({ queued: 0, dropped: 0 });
  expect(drain()).toEqual([]);
  // Safe mode runs no service, so nothing is attached and no extension work can be delivered.
  const safe = new WorkspaceEvents(); safe.setGate(() => true);
  expect(safe.publish({ kind: 'app.focus', focused: true }, null, 1)).toEqual({ queued: 0, dropped: 0 });
  expect(safe.nextFrame(ID)).toBeNull();
});
