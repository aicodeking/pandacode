// Transport-free identity and API state. The wrapper injects S256 and randomness.
export function createCloud({ now = () => Date.now(), challenge, token = (() => { let n = 0; return () => `tok-fixture-${++n}`; })() } = {}) {
  let codes, access, refresh, mode, reply, usage, limit, serial;
  function reset() {
    codes = new Map(); access = new Map(); refresh = new Map(); serial = 0;
    mode = { authorize: 'approve', refresh: 'keep' }; reply = null; limit = { count: 0, retryAfterMs: 0 };
    usage = { windows: [{ id: '5h', label: 'Five hours', usedPercent: 37, resetsAt: now() + 18000000 }, { id: 'week', label: 'Week', usedPercent: 12, resetsAt: now() + 604800000 }] };
  }
  const result = (status, data, headers = {}) => ({ status, data, headers });
  const invalid = () => result(400, { error: 'invalid_grant' });
  const valid = headers => { const value = headers.authorization?.replace(/^Bearer /, ''); return value && (access.get(value)?.expires ?? 0) > now(); };
  function mint(refreshToken, clientId) {
    const accessToken = token();
    access.set(accessToken, { expires: now() + 60000, clientId });
    refresh.set(refreshToken, { clientId });
    return result(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: 60, token_type: 'Bearer' });
  }
  function control(path, value = {}) {
    if (path === 'reset') { reset(); return { reset: true }; }
    if (path === 'mode') {
      if (value.authorize !== undefined && !['approve', 'deny', 'bad-state', 'hang', 'page'].includes(value.authorize)) throw new Error('Unknown authorize mode');
      if (value.refresh !== undefined && !['keep', 'rotate'].includes(value.refresh)) throw new Error('Unknown refresh mode');
      mode = { ...mode, ...value }; return { ...mode };
    }
    if (path === 'expire') { for (const item of access.values()) item.expires = 0; return { expired: true }; }
    if (path === 'revoke') { refresh.clear(); access.clear(); return { revoked: true }; }
    if (path === 'rate-limit') {
      if (!Number.isInteger(value.count) || value.count < 0 || !Number.isFinite(value.retryAfterMs) || value.retryAfterMs < 0) throw new Error('Invalid rate limit');
      limit = { ...value }; return limit;
    }
    if (path === 'reply') { reply = String(value.text); return { set: true }; }
    if (path === 'usage') { if (!Array.isArray(value.windows)) throw new Error('windows must be an array'); usage = structuredClone(value); return structuredClone(usage); }
    throw new Error(`Unknown control: ${path}`);
  }
  async function request(listener, method, url, headers = {}, data = {}) {
    const path = url.pathname;
    if (listener === 'identity') {
      if (method === 'GET' && path === '/authorize') {
        const p = Object.fromEntries(url.searchParams);
        let callback;
        try { callback = new URL(p.redirect_uri); } catch { return result(400, { error: 'invalid_request' }); }
        if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.username || callback.password || p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !p.code_challenge || !p.client_id || !p.state) return result(400, { error: 'invalid_request' });
        if (mode.authorize === 'hang') return { hang: true };
        if (mode.authorize === 'page') return { status: 200, html: '<!doctype html><title>Fixture sign-in</title><p>Manual sign-in. Change authorize mode to approve, then reopen the authorization URL.</p>' };
        callback.searchParams.set('state', mode.authorize === 'bad-state' ? `${p.state}-wrong` : p.state);
        if (mode.authorize === 'deny') callback.searchParams.set('error', 'access_denied');
        else {
          const code = `code-${++serial}`;
          codes.set(code, { challenge: p.code_challenge, redirect: p.redirect_uri, clientId: p.client_id });
          callback.searchParams.set('code', code);
        }
        return result(302, {}, { location: callback.href });
      }
      if (method === 'POST' && path === '/token') {
        if (data.grant_type === 'authorization_code') {
          const record = codes.get(data.code);
          if (!record || record.redirect !== data.redirect_uri || record.clientId !== data.client_id || !data.code_verifier || await challenge(data.code_verifier) !== record.challenge) return invalid();
          if (codes.get(data.code) !== record) return invalid();
          codes.delete(data.code);
          return mint(token(), record.clientId);
        }
        if (data.grant_type === 'refresh_token') {
          const record = refresh.get(data.refresh_token);
          if (!record || record.clientId !== data.client_id) return invalid();
          let next = data.refresh_token;
          if (mode.refresh === 'rotate') { refresh.delete(next); next = token(); }
          return mint(next, record.clientId);
        }
        return result(400, { error: 'unsupported_grant_type' });
      }
      if (method === 'GET' && path === '/userinfo') return valid(headers) ? result(200, { email: 'dev@example.test' }) : result(401, { error: 'token_expired' });
    } else {
      if (!valid(headers) && !(path === '/v1/usage' && headers['x-api-key']?.startsWith('tok-'))) return result(401, { error: 'token_expired' });
      if (method === 'GET' && path === '/v1/models') return result(200, { models: [{ id: 'fixture-small', name: 'Fixture small', contextWindow: 8192 }, { id: 'fixture-large', name: 'Fixture large', contextWindow: 32768 }] });
      if (method === 'GET' && path === '/v1/usage') return result(200, structuredClone(usage));
      if (method === 'POST' && path === '/v1/chat') {
        if (limit.count > 0) { limit.count--; return result(429, { error: 'rate_limited' }, { 'retry-after-ms': String(limit.retryAfterMs) }); }
        if (!data.stream || !Array.isArray(data.messages)) return result(400, { error: 'invalid_request' });
        const text = reply ?? `echo: ${data.messages.findLast(x => x.role === 'user')?.content ?? ''}`;
        const deltas = text.match(/[\s\S]{1,8}/g) ?? [''];
        return { status: 200, events: [...deltas.map(delta => ({ delta })), { usage: { inputTokens: 12, outputTokens: Math.max(1, deltas.length), contextWindow: data.model === 'fixture-large' ? 32768 : 8192 } }, '[DONE]'] };
      }
    }
    return result(404, { error: 'not_found' });
  }
  reset();
  return { control, request };
}
