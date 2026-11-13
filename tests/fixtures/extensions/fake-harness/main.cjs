// Deterministic conformance harness. No network, credentials or external commands.
exports.providers = {
  'sample.fake-harness/recorded': async (run, core) => {
    if (run.model !== 'recorded-model' || run.effort !== 'medium' || run.mode !== 'ask') throw new Error('Configuration mismatch');
    await core.emit({ kind: 'session', id: run.resumeId || 'recorded-conversation' });
    await core.emit({ kind: 'text', text: run.resumeId ? 'Resumed recorded harness. ' : 'Started recorded harness. ' });
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
