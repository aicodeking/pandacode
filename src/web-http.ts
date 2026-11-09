/** Bounded same-origin JSON requests; the deadline includes streamed response bodies. */
export async function webJson(path: string, init: RequestInit = {}, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<{ response: Response; value: unknown }> {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) throw new Error('Web request must use the current origin');
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = window.setTimeout(abort, options.timeoutMs ?? 15000);
  const max = options.maxBytes ?? 131072;
  try {
    const response = await fetch(url, { ...init, credentials: 'same-origin', signal: controller.signal });
    if (response.status === 204) return { response, value: null };
    if (!response.ok) { await response.body?.cancel(); return { response, value: null }; }
    if (Number(response.headers.get('content-length') ?? 0) > max) { await response.body?.cancel(); throw new Error('Web response exceeds limit'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty web response');
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > max) { await reader.cancel(); throw new Error('Web response exceeds limit'); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { response, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch (error) { throw controller.signal.aborted ? new Error('Web request timed out or was cancelled') : error; }
  finally { window.clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}
