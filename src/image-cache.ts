/** One budget for sent attachments and workspace thumbnails; visible images may exceed it. */
export class ImageCache {
  private entries = new Map<string, string | null>();
  private pending = new Map<string, Promise<string | null>>();
  private bytes = 0;
  private budget: number;
  private pinned: () => ReadonlySet<string>;
  private evicted: (key: string) => void;

  constructor(budget = 32 * 1024 * 1024, pinned: () => ReadonlySet<string> = () => new Set(), evicted: (key: string) => void = () => {}) {
    this.budget = budget;
    this.pinned = pinned;
    this.evicted = evicted;
  }

  get(key: string): string | null | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }

  load(key: string, read: () => Promise<string | null>): Promise<string | null> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const loading = Promise.resolve().then(read).then(value => {
      const image = value?.startsWith('data:image/') ? value : null;
      this.entries.set(key, image);
      // Count UTF-16 storage conservatively, including keys for missing-image entries.
      this.bytes += 2 * (key.length + (image?.length ?? 0));
      this.trim();
      return image;
    }, () => null).finally(() => { this.pending.delete(key); });
    this.pending.set(key, loading);
    return loading;
  }

  trim(): void {
    if (this.bytes <= this.budget) return;
    const pinned = this.pinned();
    for (const [key, image] of this.entries) {
      if (this.bytes <= this.budget) break;
      if (pinned.has(key)) continue;
      this.entries.delete(key);
      this.bytes -= 2 * (key.length + (image?.length ?? 0));
      this.evicted(key);
    }
  }
}
