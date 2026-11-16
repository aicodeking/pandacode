// Transport-free browser policy. The Node wrapper supplies fetch and the log.
export async function visit(url, { mode = 'follow', request, record, check } = {}) {
  if (!['follow', 'ignore', 'record'].includes(mode)) throw new Error('Unknown FAKE_BROWSER mode');
  check(url);
  if (mode === 'record') { await record(url); return { mode, requests: 0 }; }
  if (mode === 'ignore') return { mode, requests: 0 };
  let current = url, redirects = 0;
  for (;;) {
    check(current);
    const response = await request(current);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location) throw new Error('Redirect has no location');
      if (redirects++ >= 5) throw new Error('More than five redirects');
      current = new URL(response.location, current).href;
    } else {
      if (response.status >= 400) throw new Error(`Browser HTTP ${response.status}`);
      return { mode, requests: redirects + 1, url: current, status: response.status };
    }
  }
}
