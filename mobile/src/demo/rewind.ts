// Demo answers for the `rewind` feature group (src/connect/api/rewind.ts): a rewind is the threads
// group's fork, ending before the prompt, plus the prompt's typed text for the new composer. See ./index.ts.
import type { DemoHandlers } from './index.ts';
import { handlers as threads } from './threads.ts';

const MAX_POINTS = 100;
const PREVIEW_CHARS = 200;
/** What the composer appends after the typed text (CONTEXT_BOUNDARY in src/main.ts), shortened for the demo. */
const CONTEXT_BOUNDARY = /\n\n(?=(?:File|Document|Folder|GitHub|Browser element|Main thread) context[ :(]|Attached (?:browser screenshot|image|mockup)[ :]|Bot brief:\n|Response style \(PandaCode token saver)/;

const typed = (content: string) => {
  const cut = content.search(CONTEXT_BOUNDARY);
  return cut < 0 ? content : content.slice(0, cut);
};
const preview = (text: string) => {
  const line = text.split(/\s+/).filter(Boolean).join(' ');
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
};

function task(state: Parameters<DemoHandlers[string]>[0]['state'], deviceId: string, sessionId: unknown) {
  const found = state.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);
  if (!found) throw new Error('Conversation not found.');
  return found;
}

export const handlers: DemoHandlers = {
  'rewind.points': ({ deviceId, state }, p) => {
    const found = task(state, deviceId, p?.sessionId);
    const prompts = (state.messages[`${deviceId}/${found.sessionId}`] ?? []).filter(m => m.role === 'user' && m.id > 0);
    const points = prompts.slice(-MAX_POINTS).reverse().map(m => ({ messageId: m.id, text: preview(typed(m.content)), createdAt: m.createdAt }));
    return { points, running: found.status === 'running' || found.status === 'waiting' };
  },
  'rewind.to': (ctx, p) => {
    const found = task(ctx.state, ctx.deviceId, p?.sessionId);
    if (found.status === 'running' || found.status === 'waiting') throw new Error('Stop the agent before rewinding.');
    const message = (ctx.state.messages[`${ctx.deviceId}/${found.sessionId}`] ?? []).find(m => m.id === p?.messageId);
    if (message?.role !== 'user') throw new Error('Rewind to one of your own messages.');
    const fork = threads['thread.fork'](ctx, { sessionId: found.sessionId, messageId: message.id, before: true }) as { sessionId: string; title: string };
    return { ...fork, draft: typed(message.content) };
  },
};
