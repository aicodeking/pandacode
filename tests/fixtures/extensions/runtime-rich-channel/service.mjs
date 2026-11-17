// R0303 fixture: a browser-safe ES module (no imports, no Node, no globals but the `panda` it is handed) that streams
// the B1 fake daemon's issue board into every open instance of its panel, answers a panel's claim to that instance
// only, and keeps what it saw of the instances in its status line so the specs read it.
export async function service(panda, lifetime) {
  const VIEW = 'sample.rich-channel/board';
  const seen = { opened: [], visible: [], hidden: [], closed: [], messages: [], posted: [], refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify(seen) });
  const refuse = error => { seen.refused.push(String(error?.code ?? error?.message ?? error)); report(); };
  const board = async () => {
    const snapshot = await panda.daemon.request('issues.snapshot');
    return { kind: 'board', revision: snapshot.revision, issues: snapshot.issues.map(({ id, title, status, assignee }) => ({ id, title, status, assignee })) };
  };
  for (const kind of ['opened', 'visible', 'hidden', 'closed']) {
    panda.views.on(kind, instance => {
      seen[kind].push(instance.instanceId);
      report();
      // A panel that opens asks nothing: the service sends it the current board, to that instance only.
      if (kind === 'opened') void board().then(data => panda.views.post(VIEW, data, { instance: instance.instanceId })).catch(refuse);
    });
  }
  panda.views.onMessage(VIEW, async (message, from) => {
    seen.messages.push({ from: from.instanceId, kind: message?.kind ?? null });
    report();
    if (message?.kind !== 'claim') return;
    const issue = await panda.daemon.request('issues.claim', { issueId: message.issueId, actor: from.instanceId });
    const answer = await panda.views.post(VIEW, { kind: 'claimed', issueId: issue.id, by: from.instanceId }, { instance: from.instanceId }).catch(refuse);
    seen.posted.push(answer ? answer.delivered : null);
    report();
  });
  // Every change of the board goes to every live instance of the view.
  await panda.daemon.subscribe('issues', () => { void board().then(data => panda.views.post(VIEW, data)).then(answer => { seen.posted.push(answer.delivered); report(); }, refuse); });
  report();
}
