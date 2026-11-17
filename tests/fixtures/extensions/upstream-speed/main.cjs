// Deterministic speed-tier fixture harness. No network, credentials or external commands.
exports.providers = {
  'sample.upstream-speed/tiers': async (run, core) => {
    await core.emit({ kind: 'session', id: run.resumeId || 'speed-conversation' });
    await core.emit({ kind: 'text', text: 'Speed fixture complete.' });
  },
};
