// Self-contained public conversation adapter; no private core imports or CLI launch.
// Frames are the shortened real-protocol shapes in builtin-provider-parity.json.
const recording = [
  { id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token', name: 'Cached' }], agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } },
  { id: 2, result: { sessionId: 'saved', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'accept-edits', name: 'Accept edits' }] } } },
  { method: 'session/update', params: { sessionId: 'saved', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } },
  { id: 44, method: 'session/request_permission', params: { sessionId: 'saved', toolCall: { toolCallId: 'tool', title: 'pwd', kind: 'execute' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } },
  { id: 3, result: { stopReason: 'end_turn' } },
];

function recordedTransport() {
  let answered = false;
  return {
    async request(request, receive) {
      if (request.method === 'initialize') return structuredClone(recording[0]);
      if (request.method === 'session/new') return structuredClone(recording[1]);
      if (request.method === 'session/resume') {
        if (request.params.sessionId !== 'saved') throw new Error('Unknown recorded session');
        return { id: 2, result: {} };
      }
      if (request.method !== 'session/prompt') throw new Error('UnsupportedCapability: recorded ACP method');
      await receive(structuredClone(recording[2]));
      await receive(structuredClone(recording[3]));
      if (!answered) throw new Error('Unanswered permission');
      return structuredClone(recording[4]);
    },
    async respond(response) {
      const outcome = response.result?.outcome;
      if (response.id !== 44 || outcome?.outcome !== 'selected' || !['allow', 'deny'].includes(outcome.optionId)) throw new Error('Invalid permission response');
      answered = true;
    },
  };
}

// The injectable transport is only a package-local conformance seam, not a PandaCode API.
async function adapt(run, core, transport = recordedTransport()) {
  if (run.model !== 'recorded' || run.effort || run.mode !== 'ask') throw new Error('UnsupportedCapability: recorded ACP configuration');
  const rpc = async (id, method, params, receive) => {
    const response = await transport.request({ jsonrpc: '2.0', id, method, params }, receive);
    if (response?.id !== id || response.error || !response.result) throw new Error(`ACP ${method} failed`);
    return response.result;
  };
  const init = await rpc(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  if (init.protocolVersion !== 1) throw new Error('UnsupportedCapability: ACP protocol version');
  if (run.resumeId && !init.agentCapabilities?.sessionCapabilities?.resume) throw new Error('UnsupportedCapability: ACP resume');
  const session = await rpc(2, run.resumeId ? 'session/resume' : 'session/new', {
    cwd: process.cwd(), mcpServers: [], ...(run.resumeId ? { sessionId: run.resumeId } : {}),
  });
  const sessionId = run.resumeId || session.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid ACP session');
  await core.emit({ kind: 'session', id: sessionId });
  const result = await rpc(3, 'session/prompt', {
    sessionId, prompt: [{ type: 'text', text: [run.instructions, run.prompt].filter(Boolean).join('\n\n') }],
  }, async frame => {
    if (frame.params?.sessionId !== sessionId) throw new Error('Foreign ACP session');
    if (frame.method === 'session/update') {
      const update = frame.params.update;
      if (update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') throw new Error('UnsupportedCapability: ACP update');
      await core.emit({ kind: 'text', text: update.content.text });
    } else if (frame.method === 'session/request_permission') {
      // Never upgrade a boolean decision into remembered/always permission.
      const options = frame.params.options;
      const allow = options?.find(option => option.kind === 'allow_once');
      const deny = options?.find(option => option.kind === 'reject_once');
      if (!allow || !deny) throw new Error('UnsupportedCapability: ACP permission options');
      await core.emit({ kind: 'approval', text: frame.params.toolCall.title });
      const input = await core.nextInput();
      if (input.kind !== 'approval' || typeof input.approved !== 'boolean') throw new Error('UnsupportedCapability: ACP live input');
      await transport.respond({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId: input.approved ? allow.optionId : deny.optionId } } });
    } else throw new Error('UnsupportedCapability: ACP request');
  });
  if (result.stopReason !== 'end_turn') throw new Error('UnsupportedCapability: ACP stop reason');
  // Core, not the adapter, emits completion and owns stop/reap/pending cleanup.
}

exports.providers = { 'sample.acp-recorded/acp': (run, core) => adapt(run, core) };
exports.adapt = adapt;
exports.recording = recording;
exports.recordedTransport = recordedTransport;
