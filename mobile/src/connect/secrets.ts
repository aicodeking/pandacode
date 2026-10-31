// Connect secrets in the OS secure store (Keychain / Android Keystore): relay token,
// X25519 private key, device id, and the account shown while signed in.
import * as SecureStore from 'expo-secure-store';
import { decodeSecret, generateSecret, uuid } from './crypto.ts';
import type { Account } from './types.ts';

const KEYS = { token: 'connect.token', key: 'connect.key', device: 'connect.device', account: 'connect.account' } as const;
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const get = (name: string) => SecureStore.getItemAsync(name, OPTIONS).catch(() => null);
export const set = (name: string, value: string) => SecureStore.setItemAsync(name, value, OPTIONS);
export const remove = (name: string) => SecureStore.deleteItemAsync(name, OPTIONS).catch(() => undefined);

/** Key pins from before trust was dropped (same GitHub account is enough); deleted at start. */
export const forgetPins = () => remove('connect.pins');

export const getToken = () => get(KEYS.token);
export const setToken = (token: string) => set(KEYS.token, token);

export async function getAccount(): Promise<Account | null> {
  try {
    const value = JSON.parse((await get(KEYS.account)) ?? 'null');
    return value && typeof value.login === 'string' ? value : null;
  } catch {
    return null;
  }
}
export const setAccount = (account: Account) => set(KEYS.account, JSON.stringify(account));

/** Signing out drops the token and account; the device id and key stay for the next sign-in. */
export const clearSession = () => Promise.all([remove(KEYS.token), remove(KEYS.account)]);

export async function getDeviceId(): Promise<string> {
  const id = await get(KEYS.device);
  return id ?? newDeviceId();
}

/** A fresh device id (also after the relay's 409: that id has another key). */
export async function newDeviceId(): Promise<string> {
  const id = uuid();
  await set(KEYS.device, id);
  return id;
}

let keyLock: Promise<Uint8Array> | null = null;

/** After account deletion: token, account, device id and key go; the next sign-in makes new ones. */
export async function wipe(): Promise<void> {
  await Promise.all(Object.values(KEYS).map(remove));
  keyLock = null;
}

/** The device's private key. Only a missing or undecodable key is ever generated, behind a lock. */
export function getSecret(): Promise<Uint8Array> {
  keyLock ??= (async () => {
    const existing = decodeSecret((await get(KEYS.key)) ?? '');
    if (existing) return existing;
    const fresh = generateSecret();
    await set(KEYS.key, fresh);
    return decodeSecret(fresh)!;
  })().catch(error => {
    keyLock = null;
    throw error;
  });
  return keyLock;
}
