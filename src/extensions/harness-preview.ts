/** Synthetic E24 presentation recording, not execution/native policy evidence. */
import type { AgentEvent, Session } from '../types';
type Recording = { session: Session; requestId: string; phase: 'approval' | 'question'; content: string };
export function createHarnessPreview(emit: (event: AgentEvent) => void, finish: (id: string, content: string) => void) {
  const runs = new Map<string, Recording>();
  const send = (id: string, kind: AgentEvent['kind'], text = '', extra: Partial<AgentEvent> = {}) => emit({ sessionId: id, kind, text, ...extra });
  return {
    start(session: Session) {
      const content = session.resumeId ? 'Resumed recorded harness. ' : 'Started recorded harness. ';
      session.resumeId ||= 'recorded-conversation';
      const run: Recording = { session, requestId: crypto.randomUUID(), phase: 'approval', content }; runs.set(session.id, run);
      window.setTimeout(() => {
        if (runs.get(session.id) !== run) return;
        send(session.id, 'session', session.resumeId!); send(session.id, 'text', content);
        const tool = { id: 'recorded-read', name: 'Read', status: 'completed' as const, input: 'fixture.txt', output: 'Recorded file content' };
        send(session.id, 'tool', 'Read completed', { tool });
        send(session.id, 'approval', 'Allow the recorded operation?', { requestId: run.requestId });
      });
    },
    respond(id: string, requestId: string, approved?: boolean, response?: unknown) {
      const run = runs.get(id); if (!run || run.requestId !== requestId) throw new Error('Stale input request');
      if (run.phase === 'approval') {
        if (typeof approved !== 'boolean') throw new Error('InvalidShape');
        send(id, 'approval_cancelled', '', { requestId });
        const text = approved ? 'Approved. ' : 'Rejected. '; run.content += text; send(id, 'text', text);
        run.phase = 'question'; run.requestId = crypto.randomUUID();
        send(id, 'input_request', '', { requestId: run.requestId, data: { kind: 'questions', questions: [{ id: 'choice', header: 'Fixture', question: 'Which recorded result?', options: [{ label: 'Finish', description: 'Complete this recording' }], isOther: false, isSecret: false }] } });
      } else {
        const answers = (response as { answers?: { choice?: string[] } })?.answers;
        if (!answers || answers.choice?.[0] !== 'Finish') throw new Error('Invalid answer');
        send(id, 'input_cancelled', '', { requestId });
        run.session.contextUsage = { usedTokens: 1234, contextWindow: 32000 };
        send(id, 'usage', '', { data: { usedTokens: 1234, contextWindow: 32000 } });
        const text = 'Recorded conversation complete.'; send(id, 'text', text);
        runs.delete(id); finish(id, run.content + text);
      }
    },
    stop(id: string) { const run = runs.get(id); if (run) { send(id, run.phase === 'approval' ? 'approval_cancelled' : 'input_cancelled', '', { requestId: run.requestId }); runs.delete(id); } },
    steer(id: string, text: string) {
      const run = runs.get(id); if (!run) throw new Error('The agent is not running');
      const steerId = crypto.randomUUID(); send(id, 'steer', text, { data: { id: steerId, status: 'delivered', mode: 'live' } });
      const delta = `Steered: ${text}. `; run.content += delta; send(id, 'text', delta);
      return { steered: true, id: steerId, mode: 'live' };
    },
  };
}
