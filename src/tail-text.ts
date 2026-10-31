/** A live stream's text: chunks are kept as they arrive and joined only when read, keeping
 * the last `cap` characters, so a long stream is not copied once per chunk. */
export class TailText {
  private parts: string[] = [];
  private size = 0;
  private text = '';
  private readonly cap: number;
  constructor(cap = 262144) { this.cap = cap; }
  append(chunk: string): void {
    if (!chunk) return;
    this.parts.push(chunk); this.size += chunk.length;
    // Unread chunks are folded once they could hold twice the visible tail.
    if (this.text.length + this.size > 2 * this.cap) this.fold();
  }
  set(value: string): void { this.parts = []; this.size = 0; this.text = value; }
  get value(): string { if (this.parts.length) this.fold(); return this.text; }
  private fold(): void {
    const text = this.text + this.parts.join('');
    this.text = text.length > this.cap ? text.slice(-this.cap) : text;
    this.parts = []; this.size = 0;
  }
}
