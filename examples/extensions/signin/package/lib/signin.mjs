// sample.signin: the whole logic of the sign-in provider, as one browser-safe ES module (no imports, no Node, nothing but the
// `panda` it is handed and the small `io` below). The installed service (main.cjs) and the preview spec run this same file.
//
// What it does: it signs in through the host's browser flow (`panda.auth.signIn`), keeps its own tokens in the package's own
// secrets (`panda.secrets`), refreshes them lazily with one shared in-flight request, rotates between accounts on a rate limit
// and tells the host what is true about the provider with `panda.providers.update`. The declared ACP harness never receives a
// token: the service reads the account, the models and the limits itself (ADR-0006), and no text it shows holds a token.
export const PROVIDER = 'sample.signin/cloud';
export const PAGE = 'sample.signin/settings';
export const SIGN_IN = 'sample.signin/sign-in';
export const ADD_ACCOUNT = 'sample.signin/add-account';
export const SIGN_OUT = 'sample.signin/sign-out';
export const ACCOUNTS = 'sample.signin/accounts';
export const MAX_ACCOUNTS = 4;
const SKEW_MS = 15000;
const SECRET_KEY = 'accounts';
const DEFAULTS = { identity: 'http://127.0.0.1:7431', api: 'http://127.0.0.1:7432', client: 'sample-client', wait: '30' };
const SIGNED_OUT = { readiness: { state: 'signedOut', reason: 'Sign in to use Sample cloud.' } };

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A proof key (S256) and a state value, from the platform's own random source. */
export async function pkce(crypto = globalThis.crypto) {
  const random = size => base64url(crypto.getRandomValues(new Uint8Array(size)));
  const verifier = random(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)), state: random(12) };
}

const failure = (code, message) => Object.assign(new Error(message), { code });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function run(panda, lifetime, given = {}) {
  const io = {
    fetch: given.fetch ?? ((...args) => globalThis.fetch(...args)),
    now: given.now ?? (() => Date.now()),
    sleep: given.sleep ?? wait,
    setTimeout: given.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
    clearTimeout: given.clearTimeout ?? (handle => globalThis.clearTimeout(handle)),
    pkce: given.pkce ?? (() => pkce()),
  };
  let book = { active: 0, items: [] };
  const inflight = new Map();
  let timer = null;
  let stopped = false;
  const notice = async (key, text, tone) => { try { await panda.ui.notify({ key, text, tone }); } catch { /* a notice is never worth failing a sign-in */ } };

  async function config() {
    let values = {};
    try { values = (await panda.settings.get({ page: PAGE })).values ?? {}; } catch { values = {}; }
    const pick = name => (typeof values[name] === 'string' && values[name].trim() ? values[name].trim() : DEFAULTS[name]);
    return { identity: pick('identity').replace(/\/+$/, ''), api: pick('api').replace(/\/+$/, ''), client: pick('client'), wait: Math.max(1, Math.min(900, Number(pick('wait')) || 30)) };
  }
  const active = () => book.items[book.active] ?? book.items[0];
  async function save() {
    if (!book.items.length) { await panda.secrets.delete({ key: SECRET_KEY }); return; }
    await panda.secrets.set({ key: SECRET_KEY, value: JSON.stringify(book) });
  }
  async function load() {
    try {
      const { value } = await panda.secrets.get({ key: SECRET_KEY });
      const parsed = value ? JSON.parse(value) : null;
      if (parsed && Array.isArray(parsed.items)) book = { active: Number(parsed.active) || 0, items: parsed.items.filter(item => item && item.email && item.refresh) };
    } catch { book = { active: 0, items: [] }; }
  }
  const form = fields => new URLSearchParams(fields);
  async function tokenRequest(fields) {
    const { identity } = await config();
    const response = await io.fetch(`${identity}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) });
    if (!response.ok) throw failure(response.status === 400 || response.status === 401 ? 'Revoked' : 'HostUnavailable', 'The identity server refused the request.');
    return response.json();
  }

  /** One refresh at a time per account: two tasks that need a token at the same moment share one request. */
  function refresh(account) {
    const known = inflight.get(account.email);
    if (known) return known;
    const job = (async () => {
      const { client } = await config();
      const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refresh, client_id: client });
      account.access = token.access_token;
      if (token.refresh_token) account.refresh = token.refresh_token;
      account.expires = io.now() + Number(token.expires_in || 60) * 1000;
      await save();
      return account.access;
    })().finally(() => inflight.delete(account.email));
    inflight.set(account.email, job);
    return job;
  }
  const fresh = account => (account.expires - io.now() > SKEW_MS ? Promise.resolve(account.access) : refresh(account));
  async function drop(account) {
    book.items = book.items.filter(item => item !== account);
    book.active = Math.min(book.active, Math.max(0, book.items.length - 1));
    await save();
  }

  /** A request to the model API as the active account: lazy refresh, one retry after a 401, wait or rotate on a 429. */
  async function call(path, init = {}) {
    const { api } = await config();
    const tried = new Set();
    let retried = false;
    let waits = 0;
    for (;;) {
      const account = active();
      if (!account) throw failure('SignedOut', 'Signed out.');
      let token;
      try { token = await fresh(account); } catch (error) {
        if (error.code === 'Revoked') { await drop(account); continue; }
        throw error;
      }
      const response = await io.fetch(`${api}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
      if (response.status === 401) {
        if (retried) { await drop(account); retried = false; continue; }
        retried = true; account.expires = 0; continue;
      }
      if (response.status === 429) {
        const delay = Number(response.headers.get('retry-after-ms')) || 1000;
        tried.add(account.email);
        const other = book.items.find(item => !tried.has(item.email));
        if (other) {
          book.active = book.items.indexOf(other); await save();
          await notice('rate-limit', `Rate limited on ${account.email}; switched to ${other.email}.`, 'warning');
          continue;
        }
        if (++waits > 3) throw failure('LimitExceeded', 'The API stayed rate limited.');
        await notice('rate-limit', `Rate limited, retrying in ${Math.ceil(delay / 1000)} s.`, 'warning');
        await io.sleep(delay); tried.clear(); continue;
      }
      return response;
    }
  }

  /** Reads the account, the models and the limits and publishes what is true. Never puts a credential in a field. */
  async function sync() {
    if (stopped) return;
    if (!book.items.length) { schedule(); await panda.providers.update(PROVIDER, SIGNED_OUT); await lifetime.setStatus({ text: 'signed out' }); return; }
    try {
      const models = await (await call('/v1/models')).json();
      const usage = await (await call('/v1/usage')).json();
      const account = active();
      await panda.providers.update(PROVIDER, {
        readiness: { state: 'ready', reason: `Signed in as ${account.email}.` },
        account: { label: account.email },
        models: (models.models ?? []).slice(0, 32).map(model => ({ id: String(model.id), name: String(model.name ?? model.id), efforts: [], ...(Number.isInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}) })),
        limits: { windows: (usage.windows ?? []).slice(0, 8).map(window => ({ id: String(window.id), label: String(window.label), usedPercent: Number(window.usedPercent), ...(Number.isFinite(window.resetsAt) ? { resetsAt: new Date(window.resetsAt).toISOString() } : {}) })) },
      });
      await lifetime.setStatus({ text: `signed in (${book.items.length})` });
      schedule();
    } catch (error) {
      if (error.code === 'SignedOut') {
        await panda.providers.update(PROVIDER, { readiness: { state: 'signedOut', reason: 'Sign in again to use Sample cloud.' } });
        await lifetime.setStatus({ text: 'signed out' });
        await notice('session', 'The session ended. Sign in again to use Sample cloud.', 'warning');
        return;
      }
      await panda.providers.update(PROVIDER, { readiness: { state: 'unavailable', reason: 'Sample cloud could not be reached.' } });
      await lifetime.setStatus({ text: 'unavailable' });
    }
  }
  /** Refreshes the active token a little before it expires, so a running task never meets an expired one. */
  function schedule() {
    if (timer !== null) io.clearTimeout(timer);
    timer = null;
    const account = active();
    if (!account || stopped) return;
    timer = io.setTimeout(async () => {
      timer = null;
      try { await fresh(account); await sync(); } catch (error) { if (error.code === 'Revoked') { await drop(account); } await sync(); }
    }, Math.max(1000, account.expires - io.now() - SKEW_MS));
  }

  async function signIn() {
    if (book.items.length >= MAX_ACCOUNTS) { await notice('sign-in', `At most ${MAX_ACCOUNTS} accounts.`, 'warning'); return { status: 'refused' }; }
    const { identity, client, wait: seconds } = await config();
    const { verifier, challenge, state } = await io.pkce();
    let result;
    try {
      result = await panda.auth.signIn({
        authorizeUrl: `${identity}/authorize?response_type=code&client_id=${encodeURIComponent(client)}&redirect_uri={redirect_uri}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&scope=read`,
        callback: { path: '/callback' }, timeoutMs: seconds * 1000, manual: true, title: 'Sample cloud',
      });
    } catch (error) {
      const text = error.code === 'Conflict' ? 'A sign-in is already open.' : error.code === 'PermissionDenied' ? 'Sign-in is not allowed for this package.' : 'The browser could not be opened.';
      await notice('sign-in', text, 'warning');
      return { status: 'failed' };
    }
    if (result.status === 'cancelled') { await notice('sign-in', 'Sign-in cancelled.'); return { status: 'cancelled' }; }
    if (result.status === 'timeout') { await notice('sign-in', 'Sign-in timed out.', 'warning'); return { status: 'timeout' }; }
    const callback = new URL(result.url);
    const denied = callback.searchParams.get('error');
    if (denied) { await notice('sign-in', `Sign-in refused: ${denied}.`, 'warning'); return { status: 'refused' }; }
    if (callback.searchParams.get('state') !== state) { await notice('sign-in', 'Sign-in refused: the state value did not match.', 'warning'); return { status: 'refused' }; }
    let token;
    try { token = await tokenRequest({ grant_type: 'authorization_code', code: callback.searchParams.get('code') || '', client_id: client, redirect_uri: result.redirectUri, code_verifier: verifier }); } catch {
      await notice('sign-in', 'Sign-in failed: the identity server refused the code.', 'warning'); return { status: 'failed' };
    }
    const who = await io.fetch(`${identity}/userinfo`, { headers: { authorization: `Bearer ${token.access_token}` } });
    const email = who.ok ? String((await who.json()).email ?? '') : '';
    if (!email) { await notice('sign-in', 'Sign-in failed: the account could not be read.', 'warning'); return { status: 'failed' }; }
    const account = { email, access: token.access_token, refresh: token.refresh_token, expires: io.now() + Number(token.expires_in || 60) * 1000 };
    const known = book.items.findIndex(item => item.email === email);
    if (known >= 0) book.items[known] = account; else book.items.push(account);
    book.active = book.items.findIndex(item => item.email === email);
    await save();
    await sync();
    await notice('sign-in', `Signed in as ${email}.`, 'success');
    return { status: 'completed', email };
  }
  async function signOut() {
    inflight.clear();
    book = { active: 0, items: [] };
    await save();
    await sync();
    await notice('sign-in', 'Signed out of Sample cloud.');
  }
  /** The account dialog: choose the active account, or remove it. */
  async function accounts() {
    if (!book.items.length) { await notice('accounts', 'No account is signed in.'); return { status: 'empty' }; }
    const answer = await panda.ui.showDialog({
      title: 'Sample cloud accounts',
      fields: [
        { id: 'account', kind: 'select', label: 'Account', required: true, options: book.items.map(item => ({ value: item.email, label: item.email })) },
        { id: 'remove', kind: 'switch', label: 'Remove this account', value: false },
      ],
      confirmLabel: 'Apply', successMessage: 'Accounts updated.',
    });
    if (answer.status !== 'confirmed') return { status: 'cancelled' };
    const picked = book.items.find(item => item.email === answer.values.account);
    if (!picked) return { status: 'unknown' };
    if (answer.values.remove === true) await drop(picked); else { book.active = book.items.indexOf(picked); await save(); }
    await sync();
    return { status: 'applied', email: picked.email };
  }

  panda.commands.register(SIGN_IN, signIn);
  panda.commands.register(ADD_ACCOUNT, signIn);
  panda.commands.register(SIGN_OUT, signOut);
  panda.commands.register(ACCOUNTS, accounts);
  lifetime.onStop(() => { stopped = true; if (timer !== null) io.clearTimeout(timer); timer = null; });
  await load();
  await sync();
  return { signIn, signOut, accounts, sync, call, accountsList: () => book.items.map(item => item.email), expireNow: () => { for (const item of book.items) item.expires = 0; } };
}
