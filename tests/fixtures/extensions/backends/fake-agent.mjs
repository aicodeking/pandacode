// Entry point of the B5 stdio ACP fake agent for declared `launch` providers.
// It owns no protocol logic: `fake-agent/fake-agent.mjs` (the adopted B5 state machine over
// `core/scenario.mjs`) is the only implementation. Run it as `node fake-agent.mjs` on any platform:
// stdout carries ACP JSON-RPC only; the readiness line goes to stderr.
import { lifetime } from './common.mjs';
import { startAgent } from './fake-agent/fake-agent.mjs';

const agent = await startAgent({ input: process.stdin, output: process.stdout, logFile: process.env.FAKE_AGENT_LOG, pandacode: process.env.FAKE_AGENT_PANDACODE });
lifetime(agent.close, agent.done);
