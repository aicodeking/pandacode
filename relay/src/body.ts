/** Reads a request body as JSON, aborting once it passes `max` bytes (chunked bodies carry no content-length). */
export async function readJsonCapped(request: Request, max: number): Promise<{ value: unknown } | "too-large" | "invalid"> {
  const reader = request.body?.getReader();
  if (!reader) return "invalid";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return "invalid";
  }
}
