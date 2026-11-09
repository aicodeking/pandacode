import { webJson } from './web-http.ts';

export interface TerminalSnapshot { terminalId: string; baseSequence: number; nextSequence: number; data: string; exit: boolean; truncated: boolean }
export interface TerminalFrame { terminalId: string; data: string; exit?: boolean; terminalSequence?: number }
const LIMIT = 1024 * 1024, FRAME_LIMIT = 4096;
const encoder = new TextEncoder();
const validSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Restores a complete ANSI stream from its start, never an arbitrary truncated tail. */
export class WebTerminalRecovery {
  private disposed = false;
  private failed = false;
  private recovering = false;
  private generation = 0;
  private controller?: AbortController;
  private frames: TerminalFrame[] = [];
  private bytes = 0;
  private sequence = 0;
  private terminalId = '';

  constructor(
    private readonly replace: (data: string, exit: boolean) => void,
    private readonly append: (data: string, exit: boolean) => void,
    private readonly blocked: (error: unknown) => void,
    private readonly recovered: () => void,
    private readonly paused: () => void = () => {},
  ) {}

  begin(id: string): void {
    if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id) || (this.terminalId && this.terminalId !== id)) throw new Error('Invalid terminal identity');
    this.terminalId = id;
  }

  pause(): void {
    if (this.disposed || this.failed) return;
    ++this.generation; this.controller?.abort(); this.recovering = true;
    this.frames = []; this.bytes = 0; this.paused();
  }

  consume(frame: TerminalFrame): boolean {
    if (this.disposed || this.failed || !this.terminalId || frame.terminalId !== this.terminalId) return true;
    if (typeof frame.data !== 'string' || !validSeq(frame.terminalSequence) || frame.terminalSequence < 1 ||
        (frame.exit !== undefined && typeof frame.exit !== 'boolean') || encoder.encode(frame.data).length > LIMIT) {
      this.fail(new Error('Invalid terminal output. Close and reopen the terminal.')); return true;
    }
    if (this.recovering) { this.buffer(frame); return true; }
    if (frame.terminalSequence <= this.sequence) return true;
    if (frame.terminalSequence !== this.sequence + 1) {
      void this.start(this.terminalId); this.buffer(frame); return true;
    }
    try { this.sequence = frame.terminalSequence; this.append(frame.data, Boolean(frame.exit)); }
    catch (error) { this.fail(error); }
    return true;
  }

  async start(id: string): Promise<void> {
    if (this.disposed || this.failed) return;
    this.begin(id);
    const token = ++this.generation;
    this.controller?.abort(); const controller = this.controller = new AbortController();
    this.recovering = true; this.frames = []; this.bytes = 0; this.paused();
    try {
      const { response, value } = await webJson(`/api/pandacode/terminals/${encodeURIComponent(id)}/snapshot`,
        { signal: controller.signal, cache: 'no-store' }, { timeoutMs: 50000, maxBytes: 16 * 1024 * 1024 });
      if (this.disposed || this.failed || token !== this.generation) return;
      if (!response.ok) throw new Error(`Terminal output is unavailable (${response.status}). Close and reopen the terminal.`);
      const snapshot = value as TerminalSnapshot | null;
      if (!snapshot || snapshot.terminalId !== id || !validSeq(snapshot.baseSequence) || !validSeq(snapshot.nextSequence) ||
          snapshot.nextSequence < snapshot.baseSequence || typeof snapshot.data !== 'string' ||
          typeof snapshot.exit !== 'boolean' || typeof snapshot.truncated !== 'boolean' || encoder.encode(snapshot.data).length > LIMIT) {
        throw new Error('Invalid terminal snapshot. Close and reopen the terminal.');
      }
      if (snapshot.truncated) throw new Error('Terminal output exceeded the recovery limit. Close and reopen the terminal.');
      if (snapshot.nextSequence === 0 ? snapshot.baseSequence !== 0 || snapshot.data !== '' : snapshot.baseSequence !== 1) {
        throw new Error('Incomplete terminal snapshot. Close and reopen the terminal.');
      }
      this.sequence = snapshot.nextSequence;
      this.replace(snapshot.data, snapshot.exit);
      for (const frame of this.frames) {
        const next = frame.terminalSequence!;
        if (next <= this.sequence) continue;
        if (next !== this.sequence + 1) throw new Error('Terminal output sequence gap. Close and reopen the terminal.');
        this.sequence = next; this.append(frame.data, Boolean(frame.exit));
      }
      this.frames = []; this.bytes = 0; this.recovering = false; this.recovered();
    } catch (error) {
      if (!this.disposed && !this.failed && token === this.generation) this.fail(error);
    }
  }

  dispose(): void {
    this.disposed = true; ++this.generation; this.controller?.abort(); this.frames = []; this.bytes = 0;
  }

  private buffer(frame: TerminalFrame): void {
    const size = encoder.encode(frame.data).length;
    if (this.bytes + size > LIMIT || this.frames.length >= FRAME_LIMIT) {
      this.fail(new Error('Terminal output recovery buffer exceeded its limit. Close and reopen the terminal.')); return;
    }
    this.frames.push(frame); this.bytes += size;
  }

  private fail(error: unknown): void {
    if (this.failed || this.disposed) return;
    this.failed = true; this.recovering = false; ++this.generation;
    this.controller?.abort(); this.frames = []; this.bytes = 0; this.blocked(error);
  }
}
