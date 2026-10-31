// noble's random keys and nonces need crypto.getRandomValues, which Hermes lacks.
import { getRandomValues } from 'expo-crypto';

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { ...globalThis.crypto, getRandomValues } });
}
