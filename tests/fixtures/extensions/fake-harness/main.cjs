// Deterministic conformance harness. No network, credentials or external commands.
exports.providers = {
  'sample.fake-harness/recorded': async (run, core) => {
    if (run.model !== 'recorded-model' || !['low', 'medium'].includes(run.effort) || !['ask', 'plan'].includes(run.mode)) throw new Error('Configuration mismatch');
    if (run.prompt.startsWith('Recorded overlay prompt')) {
      if (process.cwd() !== run.instructions) throw new Error('Captured overlay cwd mismatch');
      await core.emit({ kind: 'text', text: run.prompt });
    }
    await core.emit({ kind: 'session', id: run.resumeId || 'recorded-conversation' });
    await core.emit({ kind: 'text', text: run.resumeId ? 'Resumed recorded harness. ' : 'Started recorded harness. ' });
    if (run.prompt === 'Recorded team prompt') {
      if (!run.teamTools.some(tool => tool.name === 'pandacode_dispatch_workers')) throw new Error('Missing team catalog');
      const dispatch = await core.teamTool('pandacode_dispatch_workers', { assignments: [{ key: 'recorded-worker', profileId: 'recorded', name: 'Recorded worker', prompt: 'Review the fixture without changing files.', files: [], readOnly: true }] });
      const workerId = dispatch.workerIds[0];
      await core.teamTool('pandacode_list_workers', {});
      await core.teamTool('pandacode_cancel_worker', { workerId, reason: 'User requested fixture cancellation.' });
      try { await core.teamTool('pandacode_open_browser', {}); throw new Error('Unexpected host authority'); }
      catch (error) { if (!error.message.includes('UnsupportedCapability')) throw error; }
    }
    const tool = { id: 'recorded-read', name: 'Read', status: 'running', input: 'fixture.txt', output: '' };
    await core.emit({ kind: 'tool', tool });
    await core.emit({ kind: 'tool', tool: { ...tool, status: 'completed', output: 'Recorded file content' } });
    await core.emit({ kind: 'approval', text: 'Allow the recorded operation?' });
    let approval;
    do {
      approval = await core.nextInput();
      if (approval.kind === 'steer') await core.emit({ kind: 'text', text: `Steered: ${approval.text}. ` });
    } while (approval.kind !== 'approval');
    await core.emit({ kind: 'text', text: approval.approved ? 'Approved. ' : 'Rejected. ' });
    await core.emit({ kind: 'question', questions: [{ id: 'choice', header: 'Fixture', question: 'Which recorded result?', options: [{ label: 'Finish', description: 'Complete this recording' }], isOther: false, isSecret: false }] });
    let answer;
    do { answer = await core.nextInput(); } while (answer.kind !== 'question');
    await core.emit({ kind: 'usage', usedTokens: 1234, contextWindow: 32000 });
    await core.emit({ kind: 'text', text: 'Recorded conversation complete.' });
  }
};
