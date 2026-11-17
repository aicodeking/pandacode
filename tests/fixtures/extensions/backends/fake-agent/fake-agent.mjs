import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { runScenario } from '../core/scenario.mjs';
import { body, json, lifetime, lines, listen, listener, loopback, main } from '../common.mjs';

export async function startAgent({ input, output, logFile, diagnostics = process.stderr } = {}) {
  let sessionSerial = 0, requestSerial = 1000, stopped = false, fault = null;
  const sessions = new Map(), pending = new Map(), log = [], controllers = new Set();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const write = frame => { if (!stopped) output.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`); };
  async function rpc(server, method, params, signal) {
    loopback(server.url);
    const headers = Array.isArray(server.headers) ? Object.fromEntries(server.headers.map(x => [x.name, x.value])) : server.headers ?? {};
    const response = await fetch(server.url, { method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestSerial, method, params }), signal });
    if (!response.ok) throw new Error(`Tool server HTTP ${response.status}`);
    const value = await response.json();
    if (value.error) throw new Error(value.error.message);
    if (value.result?.isError) throw new Error(value.result.content?.map(x => x.text ?? '').join('') || 'Tool failed');
    return value.result;
  }
  async function prompt(frame, session) {
    if (session.controller) throw new Error('A turn is already active');
    const controller = new AbortController(); session.controller = controller; controllers.add(controller);
    const { signal } = controller;
    let toolSerial = 0;
    const update = value => write({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: value } });
    const text = (frame.params.prompt ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    const catalog = async () => {
      const tools = [];
      for (const server of session.servers) {
        if (!server.initialized) {
          await rpc(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } }, signal);
          const headers = Array.isArray(server.headers) ? Object.fromEntries(server.headers.map(x => [x.name, x.value])) : server.headers ?? {};
          const response = await fetch(server.url, { method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal });
          if (!response.ok) throw new Error(`Tool server HTTP ${response.status}`);
          await response.body?.cancel(); server.initialized = true;
        }
        const result = await rpc(server, 'tools/list', {}, signal);
        for (const tool of result.tools ?? []) tools.push({ ...tool, server });
      }
      return tools;
    };
    // One host request (permission or structured question) that waits for its response or the turn's cancellation.
    const ask = params => new Promise((resolve, reject) => {
      const id = ++requestSerial;
      const abort = () => { pending.delete(id); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      pending.set(id, { resolve(value) { signal.removeEventListener('abort', abort); resolve(value); }, reject });
      write({ id, method: 'session/request_permission', params: { sessionId: frame.params.sessionId, ...params } });
    });
    try {
      await runScenario(text, {
        check: () => signal.throwIfAborted(),
        async emit(event) {
          if (event.kind === 'text') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } });
          else if (event.kind === 'tool') {
            if (event.status === 'pending') toolSerial++;
            update({ sessionUpdate: event.status === 'pending' ? 'tool_call' : 'tool_call_update', toolCallId: `tool-${toolSerial}`, title: event.tool.name, kind: event.tool.kind === 'shell' ? 'execute' : event.tool.kind, status: event.status === 'denied' ? 'failed' : event.status, rawInput: event.tool.input, ...(event.output === undefined ? {} : { content: [{ type: 'content', content: { type: 'text', text: event.output } }] }) });
          } else if (event.kind === 'usage') update({ sessionUpdate: 'usage_update', used: event.usedTokens, size: event.contextWindow, _meta: { fixtureUsage: event } });
        },
        permission: async tool => {
          const value = await ask({ toolCall: { toolCallId: `tool-${toolSerial}`, title: tool.name, kind: tool.kind === 'shell' ? 'execute' : tool.kind, rawInput: tool.input }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject once', kind: 'reject_once' }] });
          const outcome = value.result?.outcome;
          return { approved: outcome?.outcome === 'selected' && outcome.optionId === 'allow', reason: outcome?.reason ?? value.result?._meta?.fixture?.reason, input: value.result?._meta?.fixture?.input };
        },
        // ACP v1 has no question frame. Opt-in `transport: "acp-permission"` sends the question the way ACP harnesses
        // do in practice: a permission request whose options are the answers (`q0_opt_<n>`, plus `q0_skip`).
        question: async question => {
          if (question?.transport !== 'acp-permission') throw new Error('UnsupportedCapability: ACP v1 has no question frame');
          const labels = Array.isArray(question.options) ? question.options.map(String) : [];
          const value = await ask({ toolCall: { toolCallId: `question-${question.id ?? 'q'}`, title: String(question.question ?? 'Question'), kind: 'other' }, options: [...labels.map((name, index) => ({ optionId: `q0_opt_${index}`, name, kind: 'allow_once' })), { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' }] });
          const outcome = value.result?.outcome;
          if (outcome?.outcome !== 'selected') return { cancelled: true };
          const index = /^q0_opt_(\d+)$/.exec(outcome.optionId ?? '')?.[1];
          return index === undefined || labels[Number(index)] === undefined ? { skipped: true } : labels[Number(index)];
        },
        compact: async () => { throw new Error('UnsupportedCapability: ACP v1 has no compaction frame'); },
        listTools: catalog,
        async callTool(name, arguments_) {
          const tool = (await catalog()).find(x => x.name === name);
          if (!tool) throw new Error('tool-missing');
          return rpc(tool.server, 'tools/call', { name, arguments: arguments_ }, signal);
        },
        sleep: ms => delay(ms, undefined, { signal }),
      });
      write({ id: frame.id, result: { stopReason: signal.aborted ? 'cancelled' : 'end_turn' } });
    } catch (error) {
      if (signal.aborted) write({ id: frame.id, result: { stopReason: 'cancelled' } });
      else write({ id: frame.id, error: { code: -32000, message: error.message } });
    } finally { session.controller = null; controllers.delete(controller); }
  }
  const control = listener(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname, raw = await body(req);
    log.push({ method: req.method, path, headers: req.headers, body: raw });
    if (req.method === 'GET' && path === '/control/log') return json(res, log);
    if (req.method !== 'POST') return json(res, { error: 'NotFound' }, 404);
    if (path === '/control/shutdown') { json(res, { stopped: true }); setImmediate(close); return; }
    if (path === '/control/reset') {
      for (const controller of controllers) controller.abort();
      sessions.clear(); log.length = 0; fault = null; return json(res, { reset: true });
    }
    if (path === '/control/fault') {
      const value = raw ? JSON.parse(raw) : {};
      if (!['drop', 'stall', 'garbage', 'refuse'].includes(value.kind)) throw new Error('Unknown fault');
      fault = { kind: value.kind, until: value.ms === undefined ? Infinity : Date.now() + Number(value.ms) };
      json(res, { fault: value.kind });
      if (value.kind === 'garbage') output.write('not-json\n');
      if (value.kind === 'drop') setImmediate(close);
      return;
    }
    json(res, { error: 'NotFound' }, 404);
  });
  async function close() {
    if (stopped) return;
    stopped = true;
    for (const controller of controllers) controller.abort();
    await control.close(); resolveDone();
  }
  const url = await listen(control.server);
  lines(input, frame => {
    log.push({ transport: 'stdio', frame });
    if (logFile) appendFileSync(logFile, `${JSON.stringify(frame)}\n`);
    if (pending.has(frame.id) && !frame.method) { pending.get(frame.id).resolve(frame); pending.delete(frame.id); return; }
    // A response to a request that is no longer pending (answered, cancelled or never sent) is a late answer: it is
    // recorded and ignored, never answered and never applied.
    if (!frame.method && frame.id !== undefined && frame.id !== null && ('result' in frame || 'error' in frame)) { log.push({ transport: 'stdio', late: frame.id }); return; }
    const kind = fault && Date.now() < fault.until ? fault.kind : null;
    if (kind === 'stall') return;
    if (kind === 'refuse') { if (frame.id !== undefined) write({ id: frame.id, error: { code: -32000, message: 'Fixture refusal' } }); return; }
    const respond = result => write({ id: frame.id, result });
    try {
      const params = frame.params ?? {};
      if (frame.method === 'initialize') respond({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: {} }, agentInfo: { name: 'fixture-agent', version: '1' } });
      else if (frame.method === 'session/new') {
        const servers = structuredClone(params.mcpServers ?? []);
        for (const server of servers) { if (server.type !== 'http') throw new Error('Only HTTP tool servers are supported'); loopback(server.url); }
        const sessionId = `fixture-${++sessionSerial}`;
        sessions.set(sessionId, { servers }); respond({ sessionId });
      } else if (frame.method === 'session/prompt') {
        const session = sessions.get(params.sessionId);
        if (!session) throw new Error('Unknown session');
        void prompt(frame, session).catch(error => write({ id: frame.id, error: { code: -32000, message: error.message } }));
      } else if (frame.method === 'session/cancel') sessions.get(params.sessionId)?.controller?.abort();
      else if (frame.id !== undefined) write({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
    } catch (error) { if (frame.id !== undefined) write({ id: frame.id, error: { code: -32602, message: error.message } }); }
  }, message => write({ id: null, error: { code: -32700, message } }));
  input.once('end', close);
  diagnostics.write(`${JSON.stringify({ ready: true, control: url, transport: 'stdio-acp' })}\n`);
  return { close, done, control: url };
}
if (main(import.meta.url)) {
  const agent = await startAgent({ input: process.stdin, output: process.stdout, logFile: process.env.FAKE_AGENT_LOG });
  lifetime(agent.close, agent.done);
}
