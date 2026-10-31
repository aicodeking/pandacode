// GitHub device-flow sign-in and the relay's HTTP API; mirrors src-tauri/src/remote/auth.rs.
import * as ExpoDevice from 'expo-device';
import { Platform } from 'react-native';
import { build, NOT_CONFIGURED } from './config.ts';
import { publicKey } from './crypto.ts';
import * as secrets from './secrets.ts';
import type { Account, Device } from './types.ts';

export const SIGNED_OUT = 'This phone was signed out of PandaCode Connect.';
const KEY_CHANGED = 'The relay has another key for this device.';
const GITHUB = 'https://github.com';
const WEEK_S = 7 * 24 * 3600;

/** A relay refusal of `token` (401); signs out only if that token is still the current one. */
export class SignedOut extends Error {
  constructor(readonly token: string) { super(SIGNED_OUT); }
}

const config = () => {
  if (!build) throw new Error(NOT_CONFIGURED);
  return build;
};

async function fetchJson(url: string, init: RequestInit, label: string): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...init, signal: init.signal ?? controller.signal });
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error(`${label} sent a response that is too large.`);
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(init.signal?.aborted ? 'Sign-in was cancelled.' : `${label} did not answer in time.`);
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`Could not reach ${label}. Check your connection.`);
  } finally {
    clearTimeout(timer);
  }
}

/** An authenticated (or, for sign-in, anonymous) relay call. 401 → SignedOut, 409 → KEY_CHANGED. */
export async function relay(method: string, path: string, token: string | null, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const reply = await fetchJson(`${config().relay}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, 'the relay');
  if (reply.status >= 200 && reply.status < 300) return reply.body;
  if (reply.status === 401 && token) throw new SignedOut(token);
  if (reply.status === 409 && !token) throw new Error(KEY_CHANGED);
  const error = typeof reply.body?.error === 'string' ? `Relay: ${reply.body.error.slice(0, 300)}` : `The relay returned HTTP ${reply.status}.`;
  throw new Error(error);
}

const github = (path: string, form: string, signal?: AbortSignal) =>
  fetchJson(`${GITHUB}${path}`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal }, 'GitHub').then(r => r.body ?? {});

const safe = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(value);

export interface SignInCode { userCode: string; verificationUri: string; expiresIn: number; deviceCode: string; interval: number; expiresAt: number }

export async function startSignIn(): Promise<SignInCode> {
  const reply = await github('/login/device/code', `client_id=${encodeURIComponent(config().clientId)}&scope=`);
  const { device_code, user_code, verification_uri } = reply;
  if (typeof user_code !== 'string' || typeof verification_uri !== 'string') {
    throw new Error(`GitHub did not start sign-in: ${reply.error_description ?? 'unexpected reply'}`);
  }
  if (!safe(device_code) || !verification_uri.startsWith('https://github.com/')) throw new Error('GitHub returned an unexpected sign-in code.');
  const expiresIn = Math.min(Number(reply.expires_in) || 900, 3600);
  const interval = Math.min(Math.max(Number(reply.interval) || 5, 1), 60);
  return { userCode: user_code, verificationUri: verification_uri, expiresIn, deviceCode: device_code, interval, expiresAt: Date.now() + expiresIn * 1000 };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Sign-in was cancelled.')); }, { once: true });
});

/** Waits for the user to approve on GitHub; the GitHub token lives only in memory. */
async function githubToken(code: SignInCode, signal?: AbortSignal): Promise<string> {
  let interval = code.interval;
  const form = `client_id=${encodeURIComponent(config().clientId)}&device_code=${code.deviceCode}&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code`;
  for (;;) {
    if (Date.now() >= code.expiresAt) throw new Error('The sign-in code expired. Start again.');
    await sleep(interval * 1000, signal);
    const reply = await github('/login/oauth/access_token', form, signal);
    if (typeof reply.access_token === 'string') return reply.access_token;
    switch (reply.error) {
      case 'authorization_pending': break;
      case 'slow_down': interval = Math.min(interval + 5, 60); break;
      case 'expired_token': throw new Error('The sign-in code expired. Start again.');
      case 'access_denied': throw new Error('Sign-in was cancelled on GitHub.');
      default: throw new Error(`GitHub sign-in failed: ${reply.error_description ?? reply.error ?? 'unexpected reply'}`);
    }
  }
}

function deviceName(): string {
  const name = (ExpoDevice.deviceName ?? ExpoDevice.modelName ?? 'Phone').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return [...(name || 'Phone')].slice(0, 64).join('');
}

/** Polls GitHub, then registers this phone with the relay. A 409 gets a new device id, once. */
export async function finishSignIn(code: SignInCode, signal?: AbortSignal): Promise<{ token: string; account: Account; deviceId: string }> {
  const secret = await secrets.getSecret(); // made before polling; a failed write fails sign-in
  const ghToken = await githubToken(code, signal);
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const register = (id: string) => relay('POST', '/v1/auth/github', null, { githubToken: ghToken, device: { id, name: deviceName(), platform, publicKey: publicKey(secret) } });
  let deviceId = await secrets.getDeviceId();
  let reply;
  try {
    reply = await register(deviceId);
  } catch (error) {
    if ((error as Error).message !== KEY_CHANGED) throw error;
    deviceId = await secrets.newDeviceId();
    reply = await register(deviceId);
  }
  const token = reply?.token, account = reply?.account;
  if (typeof token !== 'string' || token.length > 4096) throw new Error('The relay did not return a token.');
  if (!account || typeof account.login !== 'string') throw new Error('The relay returned an unreadable account.');
  const clean: Account = { id: String(account.id), login: account.login, avatarUrl: String(account.avatarUrl ?? '') };
  await secrets.setToken(token);
  await secrets.setAccount(clean);
  return { token, account: clean, deviceId };
}

export interface Claims { acct: string; dev: string; iat: number; exp: number }

export function parseToken(token: string): Claims | null {
  try {
    const part = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const c = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return typeof c.acct === 'string' && typeof c.dev === 'string' && typeof c.exp === 'number' ? c : null;
  } catch {
    return null;
  }
}

export const expired = (token: string, nowS = Date.now() / 1000) => (parseToken(token)?.exp ?? 0) <= nowS;
export const needsRefresh = (token: string, nowS = Date.now() / 1000) => (parseToken(token)?.exp ?? 0) - nowS < WEEK_S;

/** A fresh 30-day token for the same account and device, or null (left for the next check). */
export async function refreshToken(old: string): Promise<string | null> {
  const reply = await relay('POST', '/v1/token', old).catch(error => {
    if (error instanceof SignedOut) throw error;
    return null;
  });
  const fresh = reply?.token;
  if (typeof fresh !== 'string' || fresh.length > 4096) return null;
  const was = parseToken(old), now = parseToken(fresh);
  if (!was || !now || now.acct !== was.acct || now.dev !== was.dev || now.exp <= was.exp) return null;
  return fresh;
}

export const listDevices = (token: string): Promise<Device[]> => relay('GET', '/v1/devices', token).then(r => (Array.isArray(r?.devices) ? r.devices : []));
export const revokeDevice = (token: string, id: string) => relay('DELETE', `/v1/devices/${encodeURIComponent(id)}`, token);
/** Deletes the account and every device from the relay; `{ ok: true }` confirms (delete-account.ts checks). */
export const deleteAccount = (token: string): Promise<unknown> => relay('DELETE', '/v1/account', token);
