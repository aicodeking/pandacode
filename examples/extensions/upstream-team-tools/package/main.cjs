// A package-declared tool and a team-capable provider that delivers it to its team role. Offline: no network,
// credential or external command. Every row the provider emits names the package, so the trace can attribute it.
const PACKAGE = 'sample.upstream-team-tools';
const TOOL = `${PACKAGE}/lookup`;
const CATALOG = { 'build-flags': 'release, locked', 'node-engine': '>=22' };

// The manifest tool: runs in the captured project folder with literal arguments, never a shell.
exports.tools = {
  [TOOL]: async (args, job) => {
    await job.progress({ phase: 'lookup', completed: 0 });
    const key = String(args[0] ?? '');
    if (!Object.hasOwn(CATALOG, key)) throw new Error(`NotFound: no catalog entry ${key}`);
    await job.progress({ phase: 'lookup', completed: 100 });
    return { source: PACKAGE, key, value: CATALOG[key] };
  },
};

exports.providers = {
  [`${PACKAGE}/team`]: async (run, core) => {
    await core.emit({ kind: 'session', id: run.resumeId || 'team-tools-conversation' });
    // Eligible team agents: only a run whose role received the team catalog may coordinate through it.
    const names = run.teamTools.map(tool => tool.name);
    if (!names.includes('pandacode_list_workers')) {
      await core.emit({ kind: 'text', text: `${PACKAGE}: no team catalog for this role, the tool was not delivered.` });
      return;
    }
    await core.teamTool('pandacode_list_workers', {});
    const row = { id: `${TOOL}#1`, name: TOOL, status: 'running', input: 'build-flags', output: '' };
    await core.emit({ kind: 'tool', tool: row });
    try {
      const result = await exports.tools[TOOL](['build-flags'], { progress: async () => null });
      await core.emit({ kind: 'tool', tool: { ...row, status: 'completed', output: JSON.stringify(result) } });
      await core.emit({ kind: 'text', text: `${PACKAGE} lookup: ${result.value}` });
    } catch (error) {
      await core.emit({ kind: 'tool', tool: { ...row, status: 'failed', output: String(error.message).slice(0, 200) } });
    }
    // A host tool outside the bridge stays refused with a stable code; it is shown, not hidden.
    try { await core.teamTool('pandacode_open_browser', {}); throw new Error('Unexpected host authority'); }
    catch (error) { if (!String(error.message).includes('UnsupportedCapability')) throw error; }
  },
};
