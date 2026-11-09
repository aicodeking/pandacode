export type TerminalSend = (terminalId: string, data: string) => Promise<unknown>;
type Item = { data: string; offset: number; bytes: number; resolve: () => void; reject: (error: unknown) => void };
type State = { items: Item[]; bytes: number; timer?: number; inflight: boolean; failed?: Error; flushWaiters: { resolve: () => void; reject: (e: unknown) => void }[] };
const BATCH_LIMIT = 32 * 1024, QUEUE_LIMIT = 128 * 1024, COALESCE_MS = 16;
const encoder = new TextEncoder();
const codePointBytes = (cp: number) => cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;

export class TerminalInputSequencer {
  private readonly states = new Map<string, State>(); private disposed = false;
  constructor(private readonly send: TerminalSend) {}
  enqueue(id: string, data: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Terminal input sequencer is disposed'));
    if (!data) return Promise.resolve(); const state = this.state(id);
    if (state.failed) return Promise.reject(new Error(`Terminal input is closed: ${state.failed.message}`));
    const bytes = encoder.encode(data).byteLength; if (state.bytes + bytes > QUEUE_LIMIT) return Promise.reject(new Error('Terminal input queue exceeds 128 KiB'));
    return new Promise((resolve, reject) => { state.items.push({ data, offset: 0, bytes, resolve, reject }); state.bytes += bytes; if (state.timer === undefined && !state.inflight) state.timer = window.setTimeout(() => { state.timer = undefined; void this.drain(id, state); }, COALESCE_MS); });
  }
  flush(id: string): Promise<void> {
    const state = this.state(id); if (state.timer !== undefined) { window.clearTimeout(state.timer); state.timer = undefined; }
    if (state.failed) return Promise.reject(state.failed); if (!state.items.length && !state.inflight) return Promise.resolve();
    const promise = new Promise<void>((resolve, reject) => state.flushWaiters.push({ resolve, reject })); if (!state.inflight) void this.drain(id, state); return promise;
  }
  reset(id: string): void { if (this.disposed) throw new Error('Terminal input sequencer is disposed'); const state = this.state(id); if (state.inflight || state.items.length) throw new Error('Cannot reset terminal input while it is busy'); state.failed = undefined; }
  interrupt(error = new Error('Terminal connection closed')): void {
    for (const state of this.states.values()) {
      if (state.timer !== undefined) window.clearTimeout(state.timer);
      state.timer = undefined; state.failed = error;
      state.items.splice(0).forEach(item => item.reject(error)); state.bytes = 0;
      state.flushWaiters.splice(0).forEach(waiter => waiter.reject(error));
    }
  }
  release(id: string): void { const state = this.states.get(id); if (!state) return; if (state.inflight || state.items.length) throw new Error('Cannot release terminal input while it is busy'); if (state.timer !== undefined) window.clearTimeout(state.timer); this.states.delete(id); }
  dispose(error = new Error('Terminal input sequencer disposed')): void {
    if (this.disposed) return; this.disposed = true;
    for (const state of this.states.values()) { if (state.timer !== undefined) window.clearTimeout(state.timer); state.timer = undefined; state.failed = error; state.items.splice(0).forEach(item => item.reject(error)); state.bytes = 0; state.flushWaiters.splice(0).forEach(waiter => waiter.reject(error)); }
  }
  private state(id: string): State { let state = this.states.get(id); if (!state) { state = { items: [], bytes: 0, inflight: false, flushWaiters: [] }; this.states.set(id, state); } return state; }
  private async drain(id: string, state: State): Promise<void> {
    if (state.inflight || state.failed || !state.items.length || this.disposed) { this.finishFlush(state); return; }
    state.inflight = true; let text = '', bytes = 0; const sent: Item[] = [];
    for (const item of state.items) {
      let offset = item.offset;
      while (offset < item.data.length) {
        const cp = item.data.codePointAt(offset)!; const width = cp > 0xffff ? 2 : 1; const size = codePointBytes(cp);
        if (bytes + size > BATCH_LIMIT) break; text += item.data.slice(offset, offset + width); offset += width; bytes += size;
      }
      if (offset === item.offset) break; item.offset = offset; sent.push(item); if (bytes === BATCH_LIMIT) break;
    }
    try {
      await this.send(id, text);
      if (this.disposed || state.failed) return;
      let remove = 0; for (const item of sent) { const remaining = encoder.encode(item.data.slice(item.offset)).byteLength; state.bytes -= item.bytes - remaining; item.bytes = remaining; if (!remaining) { remove++; item.resolve(); } else break; }
      if (remove) state.items.splice(0, remove);
    } catch (error) {
      if (!this.disposed) { const failure = error instanceof Error ? error : new Error(String(error)); state.failed = failure; state.items.splice(0).forEach(item => item.reject(failure)); state.bytes = 0; state.flushWaiters.splice(0).forEach(waiter => waiter.reject(failure)); }
    } finally { state.inflight = false; if (!this.disposed && !state.failed && state.items.length) void this.drain(id, state); else this.finishFlush(state); }
  }
  private finishFlush(state: State): void { if (state.inflight || state.items.length) return; const waiters = state.flushWaiters.splice(0); for (const waiter of waiters) state.failed ? waiter.reject(state.failed) : waiter.resolve(); }
}
