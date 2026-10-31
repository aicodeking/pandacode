/* Images for the visual-progress PiP. Thumbnails (progress_thumb, ≤320 px) feed the pill
 * and filmstrips and load as they scroll into view; full media (progress_media) is fetched
 * only for the stage, compare and lightbox, and at most FULL_LIMIT are kept. Everything is
 * a data: URL drawn with <img>: the app CSP allows no blob: images. */

type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Sized = { id: string; width?: number; height?: number };

const IMAGE = /^data:image\/(png|jpe?g|webp|gif|svg\+xml)[;,]/i, FULL_LIMIT = 6;
const clampAspect = (value: number): number => Number.isFinite(value) && value > 0 ? Math.min(4, Math.max(0.3, value)) : 1.6;

export function createMedia(call: Call, session: () => string) {
  let thumbs = new Map<string, Promise<string>>(), full = new Map<string, Promise<string>>(), aspects = new Map<string, number>();
  const image = (command: string, id: string): Promise<string> => call<string>(command, { sessionId: session(), id }).then(url => {
    if (typeof url !== 'string' || !IMAGE.test(url)) throw new Error('This snapshot is not an image.');
    return url;
  });
  const media = {
    /** Full-size media, least recently used dropped first. */
    full(id: string): Promise<string> {
      let entry = full.get(id);
      if (entry) full.delete(id);
      else { entry = image('progress_media', id); entry.catch(() => full.delete(id)); }
      full.set(id, entry);
      while (full.size > FULL_LIMIT) full.delete(full.keys().next().value!);
      return entry;
    },
    thumb(id: string): Promise<string> {
      let entry = thumbs.get(id);
      if (!entry) {
        entry = image('progress_thumb', id).catch(() => media.full(id));
        entry.catch(() => thumbs.delete(id));
        thumbs.set(id, entry);
      }
      return entry;
    },
    /** Width / height from the snapshot, or measured from its media when it has none. */
    async aspect(snap: Sized, url: string): Promise<number> {
      if (snap.width && snap.height) return clampAspect(snap.width / snap.height);
      const known = aspects.get(snap.id);
      if (known) return known;
      const img = new Image(); img.src = url; await img.decode();
      const value = clampAspect(img.naturalWidth / (img.naturalHeight || 1));
      aspects.set(snap.id, value);
      return value;
    },
    reset(): void { thumbs = new Map(); full = new Map(); aspects = new Map(); },
  };
  return media;
}
export type Media = ReturnType<typeof createMedia>;

/** Fill each `img[data-thumb]` inside `scroller` once it comes near the visible area. */
export function lazyThumbs(scroller: Element, load: (id: string) => Promise<string>): IntersectionObserver {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      observer.unobserve(img);
      load(img.dataset.thumb!).then(url => { img.src = url; }, () => img.classList.add('is-broken'));
    }
  }, { root: scroller, rootMargin: '0px 160px' });
  for (const img of scroller.querySelectorAll('img[data-thumb]:not([src])')) observer.observe(img);
  return observer;
}
