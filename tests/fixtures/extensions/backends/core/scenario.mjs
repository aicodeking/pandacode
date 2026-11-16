// Shared, transport-free scenario interpreter; no tool input is ever executed.
export function parseScenario(prompt) {
  if (prompt.startsWith('#reply ')) return [{ say: prompt.slice(7) }];
  if (!prompt.startsWith('#script ')) return [{ say: `echo: ${prompt}` }];
  const steps = JSON.parse(prompt.slice(8));
  if (!Array.isArray(steps)) throw new Error('Scenario must be a list');
  const allowed = ['say', 'tool', 'question', 'listTools', 'callTool', 'echoPrompt', 'usage', 'compact', 'sleep', 'fail'];
  for (const step of steps) {
    if (!step || typeof step !== 'object' || allowed.filter(key => Object.hasOwn(step, key)).length !== 1) throw new Error('Each step needs exactly one action');
    if ('sleep' in step && (!Number.isInteger(step.sleep) || step.sleep < 0 || step.sleep > 3600000)) throw new Error('Invalid sleep');
  }
  return steps;
}
export async function runScenario(prompt, io) {
  const say = text => io.emit({ kind: 'text', text });
  for (const step of parseScenario(prompt)) {
    io.check?.();
    if ('say' in step) await say(step.say);
    else if (step.echoPrompt) await say(prompt);
    else if (step.tool) {
      await io.emit({ kind: 'tool', status: 'pending', tool: step.tool });
      const answer = step.ask ? await io.permission(step.tool) : { approved: true };
      if (!answer.approved) {
        await io.emit({ kind: 'tool', status: 'denied', tool: step.tool });
        await say(`denied: ${answer.reason ?? 'permission rejected (ACP supplied no reason)'}`);
      } else {
        const input = answer.input ?? step.tool.input;
        await io.emit({ kind: 'tool', status: 'completed', tool: { ...step.tool, input }, output: step.output ?? '' });
        await say(`ran: ${JSON.stringify(input)}`);
      }
    } else if (step.question) {
      const answer = await io.question(step.question);
      await say(`answer: ${typeof answer === 'string' ? answer : JSON.stringify(answer)}`);
    } else if (step.listTools) await say((await io.listTools()).map(tool => tool.name).join(', '));
    else if (step.callTool) {
      try {
        const tools = await io.listTools();
        if (!tools.some(tool => tool.name === step.callTool.name)) { await say('tool-missing'); continue; }
        const result = await io.callTool(step.callTool.name, step.callTool.arguments ?? {});
        await say(`tool-result: ${JSON.stringify(result)}`);
      } catch (error) { await say(`tool-error: ${error.message}`); }
    } else if (step.usage) await io.emit({ kind: 'usage', ...step.usage });
    else if (step.compact) await io.compact();
    else if ('sleep' in step) await io.sleep(step.sleep);
    else if ('fail' in step) throw new Error(step.fail);
  }
}
