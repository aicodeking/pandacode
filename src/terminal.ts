import { paletteTerminal } from './palette';
import { call, subscribe } from './bridge';
import { web } from './web-transport';
import { WebTerminalRecovery, type TerminalFrame } from './web-terminal-recovery';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { currentTheme } from './theme';
import { textScale } from './ui-size';
import '@xterm/xterm/css/xterm.css';

export interface TerminalContext {
  projectId: string;
  sessionId?: string;
  harness?: { provider: import('./types').ProviderId; command?: string };
  runScript?: boolean;
  runRequestId?: string;
}

export interface TerminalActivity { running: boolean; processNames: string[]; uncertain: boolean }
export interface TerminalController {
  readonly exited: boolean;
  dispose(): Promise<void>;
  activity(): Promise<TerminalActivity>;
  focus(): void;
  offerCommand(command?: string): void;
}
interface TerminalPreferences {
  source?: string;
  fontFamily?: string;
  lineHeight?: number;
  cursorStyle?: 'block' | 'bar' | 'underline';
  cursorBlink?: boolean;
  theme?: import('@xterm/xterm').ITheme;
}

export async function mountTerminal(container: HTMLElement, context: TerminalContext, reportError: (error: unknown) => void): Promise<TerminalController> {
  if (context.harness && !context.sessionId) throw new Error('Select a task before opening its harness console.');
  let command = context.harness?.command;
  let commandRevision = 0;
  const validateCommand = (value?: string) => {
    if (value && (!/^\/(?:[\p{L}\p{N}_:.-]+|\?)(?:\s|$)/u.test(value) || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error('Use a single slash command without control characters.');
  };
  validateCommand(command);
  const frame = document.createElement('div');
  frame.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column;gap:8px';
  const surface = document.createElement('div');
  surface.style.cssText = 'flex:1;min-height:0;overflow:hidden';
  frame.append(surface); container.append(frame);
  let insertButton: HTMLButtonElement | undefined;
  if (context.harness) {
    const controls = document.createElement('div');
    controls.className = 'terminal-harness-controls';
    controls.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex:none';
    const hint = document.createElement('span');
    hint.textContent = context.harness.provider === 'kimi'
      ? 'Uses Kimi’s saved permissions. Review them in the console before pressing Enter.'
      : command ? 'When the console is ready, insert the command and press Enter.' : 'Native harness console. Type a command to continue.';
    hint.style.cssText = 'color:var(--muted);font-size:.78rem;flex:1';
    controls.append(hint);
    insertButton = document.createElement('button');
    insertButton.type = 'button'; insertButton.className = 'secondary-button';
    insertButton.hidden = !command;
    insertButton.textContent = command ? `Insert ${command.split(/\s/, 1)[0]}` : '';
    insertButton.setAttribute('aria-label', `Insert ${command ?? ''} in the harness console`);
    insertButton.disabled = true;
    controls.append(insertButton);
    frame.prepend(controls);
  }
  const preferences = await call<TerminalPreferences>('get_terminal_preferences').catch(() => ({} as TerminalPreferences));
  if (preferences.source) container.dataset.terminalSettings = preferences.source;
  const theme = () => ({ ...terminalTheme(), ...paletteTerminal(), ...preferences.theme });
  const terminal = new Terminal({ fontFamily: preferences.fontFamily ? `${JSON.stringify(preferences.fontFamily)}, monospace` : '"SF Mono", "Cascadia Code", Menlo, monospace', fontSize: 12 * textScale(), lineHeight: preferences.lineHeight ?? 1.5, cursorStyle: preferences.cursorStyle ?? 'block', cursorBlink: preferences.cursorBlink ?? true, scrollback: 1500, minimumContrastRatio: 4.5, theme: theme() });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(surface);
  if (surface.clientWidth && surface.clientHeight) fit.fit();
  let terminalId = '', exited = false, hasOutput = false, disposed = false, inserted = false;
  let inputBlocked = Boolean(web), writeBlocked = false, recoveringOutput = Boolean(web), outputFailed = false;
  const inputNotice = document.createElement('div'); inputNotice.hidden = true; inputNotice.setAttribute('role', 'alert');
  inputNotice.style.cssText = 'display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.78rem';
  const inputMessage = document.createElement('span');
  const resumeInput = document.createElement('button'); resumeInput.type = 'button'; resumeInput.className = 'secondary-button'; resumeInput.textContent = 'Resume input';
  inputNotice.append(inputMessage, resumeInput); frame.prepend(inputNotice);
  const syncInputState = () => {
    inputBlocked = writeBlocked || recoveringOutput || outputFailed;
    if (web) terminal.options.disableStdin = inputBlocked || exited;
    inputNotice.hidden = !web || !inputBlocked;
    inputMessage.textContent = outputFailed ? 'Terminal output could not be recovered. Close and reopen the terminal.'
      : recoveringOutput ? 'Reconnecting terminal output…'
      : 'Terminal input delivery is uncertain. Check the remote output before resuming; previous input will not be sent again.';
    resumeInput.hidden = !writeBlocked || recoveringOutput || outputFailed;
    resumeInput.disabled = recoveringOutput || outputFailed;
    if (insertButton) insertButton.disabled = inputBlocked || !hasOutput || exited || inserted;
  };
  const blockInput = (error: unknown) => {
    if (disposed) return;
    reportError(error);
    if (web) { writeBlocked = true; syncInputState(); }
  };
  resumeInput.addEventListener('click', () => {
    if (!web || disposed || !terminalId || recoveringOutput || outputFailed) return;
    try { web.resetTerminalInput(terminalId); writeBlocked = false; syncInputState(); terminal.focus(); }
    catch (error) { reportError(error); }
  });
  const showOutput = (data: string, exit: boolean, replace = false) => {
    if (disposed) return;
    // Queue RIS before the complete stream so pending xterm writes cannot land
    // after a synchronous reset and duplicate the recovered terminal contents.
    terminal.write(replace ? `\x1bc${data}` : data);
    hasOutput = replace ? data.length > 0 : hasOutput || data.length > 0;
    if (exit && (!exited || replace)) {
      const alreadyExited = exited; exited = true;
      terminal.write('\r\n\x1b[90mProcess exited. Close and reopen the terminal to start again.\x1b[0m\r\n');
      if (!alreadyExited) window.dispatchEvent(new Event('pandacode:terminal-exit'));
    }
    syncInputState();
  };
  // Native startup output stays per PTY; web startup comes from its owned snapshot.
  const early = new Map<string, { terminalId: string; data: string; exit: boolean }>();
  const webRecovery = web ? new WebTerminalRecovery(
    (data, exit) => showOutput(data, exit, true),
    (data, exit) => showOutput(data, exit),
    error => { if (!disposed) { outputFailed = true; recoveringOutput = false; syncInputState(); reportError(error); } },
    () => { recoveringOutput = false; syncInputState(); },
    () => { recoveringOutput = true; syncInputState(); },
  ) : null;
  syncInputState();
  const handle = (event: TerminalFrame) => {
    if (!terminalId && !web) {
      const previous = early.get(event.terminalId);
      early.set(event.terminalId, { terminalId: event.terminalId, data: ((previous?.data ?? '') + event.data).slice(-65536), exit: Boolean(previous?.exit || event.exit) });
      // Bound each native PTY's output independently and retain its exit marker
      // when its buffer rolls. Other PTYs never evict this terminal's startup.
      return;
    }
    if (event.terminalId !== terminalId || disposed) return;
    if (webRecovery?.consume(event)) return;
    showOutput(event.data, Boolean(event.exit));
  };
  let unlisten: () => void;
  try {
    unlisten = await subscribe('terminal-event', handle);
  } catch (error) { terminal.dispose(); frame.remove(); throw error; }
  try {
    const { harness, runScript, runRequestId, ...workspace } = context;
    terminalId = await call<string>(runScript ? 'start_run_script_terminal' : harness ? 'start_harness_terminal' : 'start_terminal', { ...workspace, ...(runRequestId ? { requestId: runRequestId } : {}), cols: terminal.cols, rows: terminal.rows });
  } catch (error) { unlisten(); terminal.dispose(); frame.remove(); throw error; }
  if (webRecovery) { webRecovery.begin(terminalId); try { await webRecovery.start(terminalId); } catch { /* visible recovery state requires reopening */ } }
  const pending = early.get(terminalId); early.clear(); if (pending) handle(pending);
  if (insertButton) insertButton.addEventListener('click', () => {
    if (exited || disposed || inputBlocked || !hasOutput || !command) return;
    const revision = commandRevision, text = command;
    insertButton!.disabled = true; inserted = true;
    // Paste into the visible TUI composer only. Never send Enter automatically:
    // authentication, workspace trust or onboarding may still be on screen.
    void call('write_terminal', { terminalId, data: `\x1b[200~${text}\x1b[201~` }).then(() => {
      if (!disposed && revision === commandRevision) { insertButton!.textContent = 'Inserted · press Enter'; focus(); }
    }).catch(error => {
      if (!disposed && revision === commandRevision) { inserted = false; insertButton!.disabled = exited || !hasOutput; }
      blockInput(error);
    });
  });
  const refreshTheme = () => { terminal.options.theme = theme(); };
  refreshTheme();
  window.addEventListener('pandacode-theme-change', refreshTheme);
  window.addEventListener('pandacode-palette-change', refreshTheme);
  const runtimeReset = () => webRecovery?.pause();
  const runtimeRestored = () => { if (webRecovery && terminalId) void webRecovery.start(terminalId).catch(() => {}); };
  window.addEventListener('pandacode-web-runtime-reset', runtimeReset); window.addEventListener('pandacode-web-runtime-restored', runtimeRestored);
  const input = terminal.onData(data => { if (!exited && !disposed && !inputBlocked) void call('write_terminal', { terminalId, data }).catch(blockInput); });
  let resizeFrame = 0;
  const resize = () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { if (disposed || !surface.clientWidth || !surface.clientHeight) return; fit.fit(); if (!exited) void call('resize_terminal', { terminalId, cols: terminal.cols, rows: terminal.rows }).catch(reportError); }); };
  const refreshSize = () => { terminal.options.fontSize = 12 * textScale(); resize(); };
  refreshSize();
  window.addEventListener('pandacode-ui-scale-change', refreshSize);
  const observer = new ResizeObserver(resize);
  observer.observe(surface);
  const focus = () => { if (!disposed && surface.clientWidth && surface.clientHeight) { resize(); terminal.focus(); } };
  focus();
  return { get exited() { return exited; }, focus, offerCommand: value => {
    validateCommand(value);
    if (!insertButton || !value) return;
    ++commandRevision; command = value; inserted = false; insertButton.hidden = false;
    insertButton.textContent = `Insert ${value.split(/\s/, 1)[0]}`;
    insertButton.setAttribute('aria-label', `Insert ${value} in the harness console`);
    insertButton.disabled = inputBlocked || exited || disposed || !hasOutput;
  }, activity: () => exited || disposed ? Promise.resolve({ running: false, processNames: [], uncertain: false }) : call<TerminalActivity>('get_terminal_activity', { terminalId }), dispose: async () => {
    if (disposed) return; disposed = true;
    window.removeEventListener('pandacode-web-runtime-reset', runtimeReset); window.removeEventListener('pandacode-web-runtime-restored', runtimeRestored); webRecovery?.dispose(); window.removeEventListener('pandacode-theme-change', refreshTheme); window.removeEventListener('pandacode-palette-change', refreshTheme); window.removeEventListener('pandacode-ui-scale-change', refreshSize); observer.disconnect(); cancelAnimationFrame(resizeFrame); input.dispose(); unlisten(); terminal.dispose(); frame.remove(); await call('close_terminal', { terminalId });
  } };
}

function terminalTheme() {
  return currentTheme() === 'dark'
    ? { background: '#191a18', foreground: '#efefeb', cursor: '#ffd43b', cursorAccent: '#191a18', selectionBackground: '#ffd43b40', black: '#32342f', red: '#f28b82', green: '#96ce9a', yellow: '#e8ca70', blue: '#8eb5f2', magenta: '#cda1dc', cyan: '#88cbd1', white: '#d5d6ce', brightBlack: '#96998f', brightRed: '#ffaba3', brightGreen: '#b0e4b3', brightYellow: '#ffe39b', brightBlue: '#accbff', brightMagenta: '#e4bceF', brightCyan: '#a6e6ec', brightWhite: '#f6f6f1' }
    : { background: '#ffffff', foreground: '#242423', cursor: '#8b6c00', cursorAccent: '#ffffff', selectionBackground: '#ffdf7080', black: '#242423', red: '#b03535', green: '#237345', yellow: '#806400', blue: '#305fa2', magenta: '#864788', cyan: '#256e78', white: '#777770', brightBlack: '#656560', brightRed: '#c43b3b', brightGreen: '#27814e', brightYellow: '#907000', brightBlue: '#376db9', brightMagenta: '#98519a', brightCyan: '#297d88', brightWhite: '#999990' };
}
