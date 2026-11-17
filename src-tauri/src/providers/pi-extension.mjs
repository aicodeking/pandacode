// PandaCode app tools that only read state stay available in Plan mode; every other app tool is blocked.
const PLAN_APP_TOOLS = new Set([
  'pandacode_title', 'pandacode_team_directory', 'pandacode_read_team_mailbox',
  'pandacode_list_tasks', 'pandacode_read_task', 'pandacode_search_tasks', 'pandacode_list_projects',
  'pandacode_list_workers', 'pandacode_read_worker', 'pandacode_list_subagents', 'pandacode_list_queue',
  'pandacode_list_local_servers', 'pandacode_list_moodboards', 'pandacode_read_moodboard', 'pandacode_read_moodboard_image',
  'pandacode_vm_list', 'pandacode_vm_screenshot', 'pandacode_simulator_devices', 'pandacode_simulator_describe',
  'pandacode_simulator_screenshot', 'pandacode_jev_read', 'pandacode_jev_list', 'pandacode_jev_screenshot',
  'pandacode_jev_assessments', 'pandacode_bot_recall', 'pandacode_bot_list_schedules', 'pandacode_code_search',
]);

export default async function (pi) {
  const config = JSON.parse(process.env.PANDACODE_PI_BRIDGE);
  // The bearer token must not reach the commands Pi runs (they inherit this environment).
  delete process.env.PANDACODE_PI_BRIDGE;
  const request = async (method, params, signal) => {
    const response = await fetch(config.url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: config.authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new Error('PandaCode tools connection failed.');
    const result = await response.json();
    if (result.error) throw new Error(result.error.message);
    return result.result;
  };
  const tools = config.url ? (await request('tools/list', {})).tools : [];
  const names = new Set(tools.map(tool => tool.name));
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      // omp hides extension tools behind discovery unless they are essential; Pi ignores this.
      loadMode: 'essential',
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, args, signal) {
        const result = await request('tools/call', { name: tool.name, arguments: args }, signal);
        if (result.isError) throw new Error(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
        return result;
      },
    });
  }
  // This uses the existing Pi RPC UI subprotocol; the host consumes the reserved title.
  // No companion means precisely the existing approval bridge below.
  const companion = async (event, input, ctx) => {
    if (!config.companion) return {};
    try {
      const value = await ctx.ui.input('PandaCode companion v1', JSON.stringify({ protocol: 1, event, input }), { timeout: 65000 });
      return value ? JSON.parse(value) : {};
    } catch { return {}; }
  };
  if (config.companion) {
    pi.on('tool_result', async (event, ctx) => {
      if (names.has(event.toolName)) return;
      const answer = await companion('PostToolUse', { tool_use_id: event.toolCallId, tool_name: event.toolName, tool_input: event.input, tool_response: { content: event.content, details: event.details, isError: event.isError } }, ctx);
      // Pi consumes partial result patches, not a returned {output} wrapper.
      if (answer.output && typeof answer.output === 'object' && !Array.isArray(answer.output)) {
        const patch = {};
        for (const key of ['content', 'details', 'structuredContent', 'isError']) if (key in answer.output) patch[key] = answer.output[key];
        return patch;
      }
    });
    pi.on('before_agent_start', async (event, ctx) => {
      const answer = await companion('UserPromptSubmit', { prompt: event.prompt ?? '' }, ctx);
      if (answer.context) return { message: { customType: 'pandacode-extension-context', content: answer.context, display: false } };
    });
    pi.on('session_before_compact', async (event, ctx) => {
      const answer = await companion('PreCompact', { phase: 'before' }, ctx);
      if (answer.cancel) return { cancel: true };
      if (typeof answer.summary === 'string') return { compaction: { summary: answer.summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    });
    pi.on('session_compact', (_event, ctx) => companion('PostCompact', { phase: 'after' }, ctx));
    pi.on('agent_end', (_event, ctx) => companion('Stop', {}, ctx));
  }
  pi.on('session_start', (_event, ctx) => ctx.ui.setStatus('pandacode-bridge', 'ready'));
  pi.on('tool_call', async (event, ctx) => {
    const app = names.has(event.toolName);
    const read = ['read', 'grep', 'find', 'ls'].includes(event.toolName) || (app && PLAN_APP_TOOLS.has(event.toolName));
    // Preserve the user's Plan restriction before consulting any extension.
    if (config.mode === 'plan' && !read) return { block: true, reason: 'This tool is unavailable in Plan mode.' };
    // App tools already traverse the native host-tool chain.
    if (app) return;
    const answer = await companion('PreToolUse', { tool_use_id: event.toolCallId, tool_name: event.toolName, tool_input: event.input }, ctx);
    if (answer.block) return { block: true, reason: answer.reason };
    if (answer.input && typeof answer.input === 'object' && !Array.isArray(answer.input)) {
      for (const key of Object.keys(event.input)) delete event.input[key];
      Object.assign(event.input, answer.input);
    }
    if (!answer.ask && (answer.approved || answer.input)) return;
    if (!answer.ask && (read || config.mode === 'full' || (config.mode === 'auto' && ['edit', 'write'].includes(event.toolName)))) return;
    try {
      if (await ctx.ui.confirm(`Allow ${event.toolName}?`, JSON.stringify(event.input).slice(0, 4000))) return;
    } catch {}
    return { block: true, reason: 'Declined by the user.' };
  });
}
