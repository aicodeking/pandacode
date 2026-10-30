/** Reuses bounded image loads across transcript redraws. Paths are resolved natively from saved tool records. */
const cache = new Map<string, Promise<string>>();
export function hydrateToolImages(root: ParentNode, sessionId: string, load: (toolId: string) => Promise<string>): void {
  root.querySelectorAll<HTMLImageElement>('img[data-tool-image]').forEach(img => {
    if (img.dataset.loading) return;
    img.dataset.loading = 'true';
    const id = img.dataset.toolImage!, key = `${sessionId}:${id}`;
    let request = cache.get(key);
    if (!request) {
      request = load(id);
      cache.set(key, request);
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
      void request.catch(() => { if (cache.get(key) === request) cache.delete(key); });
    }
    const status = img.parentElement!.querySelector<HTMLElement>('.tool-image-status')!;
    void request.then(url => {
      if (!img.isConnected) return;
      img.onload = () => { status.hidden = true; img.hidden = false; };
      img.onerror = () => { status.textContent = 'Image unavailable. Click to retry.'; };
      img.src = url;
    }).catch(error => { if (img.isConnected) status.textContent = `Could not load image. ${String(error)}`; });
  });
}
