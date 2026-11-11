// Demo answers for the `terminal` feature group (src/connect/api/terminal.ts): a pretend shell
// per demo computer that echoes keys, edits its line and answers a few commands with coloured
// output, so the phone terminal has something real to poll. See ./index.ts.
import { DEMO_FILES } from './files.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

export interface DemoTerminal {
  id: string;
  title: string;
  cwd: string;
  sessionId?: string;
  kind: 'shell' | 'script';
  output: string;
  line: string;
  running: boolean;
  exitCode?: number;
  /** A partial escape sequence the phone sent (arrows), ignored once complete. */
  escape: string;
}

const terminals = new Map<string, DemoTerminal[]>();
let counter = 0;

const PROMPT = '\x1b[1;32mdemo\x1b[0m:\x1b[1;34m~/{folder}\x1b[0m$ ';
const prompt = (t: DemoTerminal) => PROMPT.replace('{folder}', t.cwd.split('/').pop() ?? '');

const listOf = (deviceId: string) => terminals.get(deviceId) ?? [];
const find = (deviceId: string, id: unknown) => {
  const terminal = listOf(deviceId).find(t => t.id === id);
  if (!terminal) throw new Error('Terminal is closed.');
  return terminal;
};
const update = (deviceId: string, id: string, change: (t: DemoTerminal) => DemoTerminal) =>
  terminals.set(deviceId, listOf(deviceId).map(t => (t.id === id ? change(t) : t)));

const TEST_RUN = [
  '\x1b[2m> node --test\x1b[0m',
  '\x1b[32m✔\x1b[0m uploads a file \x1b[2m(3.1ms)\x1b[0m',
  '\x1b[32m✔\x1b[0m retries with backoff \x1b[2m(12.4ms)\x1b[0m',
  '\x1b[1;32m2 passing\x1b[0m',
].join('\r\n');

/** What the pretend shell prints for one command line, or null to exit. */
export function demoCommand(line: string, cwd: string): string | null {
  const [command = '', ...args] = line.trim().split(/\s+/);
  const files = Object.keys(DEMO_FILES).map(p => p.split('/')[0]).filter((p, i, all) => !p.startsWith('.') && all.indexOf(p) === i);
  switch (command) {
    case '': return '';
    case 'exit': return null;
    case 'pwd': return cwd;
    case 'echo': return args.join(' ');
    case 'clear': return '\x1b[H\x1b[2J';
    case 'ls': return files.map(f => (DEMO_FILES[f] === undefined ? `\x1b[1;34m${f}\x1b[0m` : f)).join('  ');
    case 'git': return args[0] === 'status'
      ? 'On branch \x1b[1mmain\x1b[0m\r\nChanges not staged for commit:\r\n\t\x1b[31mmodified:   src/upload.ts\x1b[0m'
      : 'usage: git status';
    case 'npm': return args[0] === 'test' ? TEST_RUN : 'usage: npm test';
    case 'help': return 'Try ls, pwd, echo, git status, npm test, clear or exit.';
    default: return `${command}: command not found`;
  }
}

/** The shell after the user's keys `data`: what it echoes and whether it exited. */
export function demoKeys(t: DemoTerminal, data: string): DemoTerminal {
  let { line, output, escape } = t;
  for (const key of data) {
    if (escape) {
      escape += key;
      if (escape.length > 2 && /[@-~]/.test(key)) escape = '';
      continue;
    }
    if (key === '\x1b') { escape = key; continue; }
    if (key === '\r' || key === '\n') {
      const result = demoCommand(line, t.cwd);
      if (result === null) return { ...t, line: '', escape: '', output: `${output}\r\nexit\r\n`, running: false, exitCode: 0 };
      output += `\r\n${result ? `${result}\r\n` : ''}${prompt(t)}`;
      line = '';
    } else if (key === '\x03') {
      output += `^C\r\n${prompt(t)}`;
      line = '';
    } else if (key === '\x04') {
      if (!line) return { ...t, line: '', escape: '', output: `${output}exit\r\n`, running: false, exitCode: 0 };
    } else if (key === '\x7f' || key === '\b') {
      if (line) { line = line.slice(0, -1); output += '\b \b'; }
    } else if (key === '\t') {
      output += '\x07';
    } else if (key >= ' ') {
      line += key;
      output += key;
    }
  }
  return { ...t, line, output, escape };
}

const projectRoot = (ctx: DemoContext, params: { projectId?: string; sessionId?: string }) => {
  const list = ctx.state.tasks[ctx.deviceId];
  const id = params.sessionId ? list?.tasks.find(t => t.sessionId === params.sessionId)?.projectId : params.projectId;
  if (!id) throw new Error('Choose a project or a task.');
  return `/Users/demo/${list?.projects.find(p => p.id === id)?.name ?? id}`;
};

const info = ({ id, title, cwd, sessionId, kind, running, exitCode }: DemoTerminal) => ({ id, title, cwd, sessionId, kind, running, exitCode });

export const handlers: DemoHandlers = {
  'terminal.list': ({ deviceId }) => ({ terminals: listOf(deviceId).map(info).reverse() }),
  'terminal.open': (ctx, p) => {
    const cwd = projectRoot(ctx, p);
    counter += 1;
    const terminal: DemoTerminal = { id: `demo-terminal-${counter}`, title: 'zsh', cwd, sessionId: p.sessionId || undefined, kind: 'shell', output: '', line: '', running: true, escape: '' };
    const welcome = `\x1b[2mPandaCode demo shell. Type help.\x1b[0m\r\n${prompt(terminal)}`;
    terminals.set(ctx.deviceId, [...listOf(ctx.deviceId), { ...terminal, output: welcome }]);
    return { terminalId: terminal.id };
  },
  'terminal.read': ({ deviceId }, p) => {
    const t = find(deviceId, p.terminalId);
    const after = Math.max(0, Math.min(Number(p.after) || 0, t.output.length));
    const exited = !t.running;
    return { data: t.output.slice(after), next: t.output.length, dropped: 0, exited, exitCode: exited ? t.exitCode : undefined };
  },
  'terminal.write': ({ deviceId }, p) => {
    const t = find(deviceId, p.terminalId);
    if (!t.running) throw new Error('Terminal is closed.');
    update(deviceId, t.id, current => demoKeys(current, String(p.data ?? '')));
    return {};
  },
  'terminal.resize': ({ deviceId }, p) => { find(deviceId, p.terminalId); return {}; },
  'terminal.close': ({ deviceId }, p) => {
    terminals.set(deviceId, listOf(deviceId).filter(t => t.id !== p.terminalId));
    return {};
  },
};
