// PandaCode app tools that only read state stay available in Plan mode; every other app tool is blocked.
const PLAN_APP_TOOLS = new Set([
  'pandacode_title', 'pandacode_team_directory', 'pandacode_read_team_mailbox',
  'pandacode_list_tasks', 'pandacode_read_task', 'pandacode_search_tasks', 'pandacode_list_projects',
  'pandacode_list_workers', 'pandacode_read_worker', 'pandacode_list_subagents', 'pandacode_list_queue',
  'pandacode_list_local_servers', 'pandacode_list_moodboards', 'pandacode_read_moodboard', 'pandacode_read_moodboard_image',
  'pandacode_vm_list', 'pandacode_vm_screenshot', 'pandacode_simulator_devices', 'pandacode_simulator_describe',
  'pandacode_simulator_screenshot', 'pandacode_jev_read', 'pandacode_jev_list', 'pandacode_jev_screenshot',
  'pandacode_jev_assessments', 'pandacode_bot_recall', 'pandacode_bot_list_schedules', 'pandacode_code_search',
  'pandacode_explore', 'pandacode_tool_list',
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
  pi.on('session_start', (_event, ctx) => ctx.ui.setStatus('pandacode-bridge', 'ready'));
  pi.on('tool_call', async (event, ctx) => {
    const app = names.has(event.toolName);
    if (['read', 'grep', 'find', 'ls'].includes(event.toolName) || (app && PLAN_APP_TOOLS.has(event.toolName))) return;
    if (config.mode === 'plan') return { block: true, reason: 'This tool is unavailable in Plan mode.' };
    if (app) return;
    if (config.mode === 'full') return;
    if (config.mode === 'auto' && ['edit', 'write'].includes(event.toolName)) return;
    try {
      if (await ctx.ui.confirm(`Allow ${event.toolName}?`, JSON.stringify(event.input).slice(0, 4000))) return;
    } catch {}
    return { block: true, reason: 'Declined by the user.' };
  });
}
